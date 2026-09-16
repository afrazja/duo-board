import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { helperHandlers } from "../src/lib/helper-api.ts";
import { listRemovedHelperThreads } from "../src/lib/helper-removals.ts";
import { database } from "./fixtures/helper-database.mjs";
import { RemoteConnection } from "../bridge/remote.mjs";
import { StateStore, keyFor } from "../bridge/storage.mjs";
import { BackgroundWorker } from "../bridge/worker.mjs";

const report = (thread_id) => ({ thread_id, mode: "sleeping", working_on: null, queued: 0 });

test("helper receives only explicit, owner-scoped removals of its reported conversations", async (t) => {
  const f = await database(t);
  const absent = randomUUID(), unreported = randomUUID(), archived = randomUUID();
  await f.pg.query("insert into threads(id,title,owner_id,archived) values($1,'Unreported',$3,false),($2,'Archived',$3,true)", [unreported, archived, f.owners[0]]);
  // A vanished conversation, an archived conversation, and a failed Remove are not permission to remove files.
  const declined = await f.pg.query("select remove_board_conversation($1,'Wrong title',$2) as result", [f.threads[0], f.owners[0]]);
  assert.equal(declined.rows[0].result.deleted, false);
  const payload = { workspace_cleanup: true, conversations: [f.threads[0], f.threads[1], absent, archived].map(report) };
  const before = await f.device("receive", payload);
  assert.equal(before.status, 200);
  assert.deepEqual(before.data.removed_thread_ids, []);

  for (const [threadId, title, ownerId] of [[f.threads[0], "Test", f.owners[0]], [f.threads[1], "Test", f.owners[1]], [unreported, "Unreported", f.owners[0]]]) {
    await f.pg.query("select remove_board_conversation($1,$2,$3)", [threadId, title, ownerId]);
  }
  // Existing assistant cleanup flags do not consume the helper's independent folder-removal receipt.
  await f.pg.query("update thread_deletions set chatgpt_cleaned_at=now(),claude_cleaned_at=now() where thread_id=$1", [f.threads[0]]);
  for (let retry = 0; retry < 2; retry++) {
    const result = await f.device("receive", payload);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.removed_thread_ids, [f.threads[0]]);
  }
  assert.deepEqual((await f.device("receive", { workspace_cleanup: true, conversations: [] })).data.removed_thread_ids, []);
  assert.deepEqual((await f.device("receive", { workspace_cleanup: true })).data.removed_thread_ids, []);
  for (const workspace_cleanup of [undefined, false]) {
    const legacy = await f.device("receive", { conversations: payload.conversations, ...(workspace_cleanup === undefined ? {} : { workspace_cleanup }) });
    assert.equal(legacy.status, 200);
    assert.deepEqual(Object.keys(legacy.data).sort(), ["device_id", "owner_id", "requests", "server_now"]);
  }

  await t.test("authentication succeeds before the receipt reader can run", async () => {
    let calls = 0;
    const handlers = helperHandlers({ rpc: f.rpc, requireUser: async () => { throw new Error("AUTH_REQUIRED"); }, waitMs: 0,
      listRemovedThreads: async () => { calls++; return []; } });
    async function receive(token, instance = f.instances[0]) {
      return handlers.device(new Request("https://board.test/api/agent/helper", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "receive", instance_id: instance, ...payload }) }));
    }
    assert.equal((await receive(`duo_helper_${"x".repeat(43)}`)).status, 401);
    assert.equal((await receive(f.connections[0].token, randomUUID())).status, 409);
    assert.equal(calls, 0);
    await f.http("/api/helper", "DELETE");
    assert.equal((await receive(f.connections[0].token)).status, 401);
    assert.equal(calls, 0);
  });
});

test("receipt-only delivery ends long polling and reader failure is retriable", async () => {
  const ownerId = randomUUID(), threadId = randomUUID(), unrelated = randomUUID();
  let reads = 0;
  const base = { rpc: async () => ({ data: { owner_id: ownerId, device_id: randomUUID(), requests: [], server_now: new Date().toISOString() }, error: null }),
    requireUser: async () => ({ id: ownerId }), waitMs: 10_000 };
  const request = () => new Request("https://board.test/api/agent/helper", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer duo_helper_${"x".repeat(43)}` },
    body: JSON.stringify({ action: "receive", instance_id: randomUUID(), workspace_cleanup: true, conversations: [report(threadId)] }) });
  const handlers = helperHandlers({ ...base, listRemovedThreads: async (owner, ids) => {
    reads++; assert.equal(owner, ownerId); assert.deepEqual(ids, [threadId]); return [threadId, threadId, unrelated];
  } });
  const result = await handlers.device(request());
  assert.equal(reads, 1);
  assert.deepEqual((await result.json()).removed_thread_ids, [threadId]);
  for (const listRemovedThreads of [undefined, async () => { throw new Error("database unavailable"); }]) {
    const failed = await helperHandlers({ ...base, listRemovedThreads }).device(request());
    assert.equal(failed.status, 503);
    assert.equal("removed_thread_ids" in await failed.json(), false);
  }
});

test("production receipt query scopes owner and reported IDs without consuming assistant cleanup", async () => {
  const owner = randomUUID(), id = randomUUID();
  const calls = [];
  const builder = {
    select(...args) { calls.push(["select", ...args]); return this; },
    eq(...args) { calls.push(["eq", ...args]); return this; },
    in(...args) { calls.push(["in", ...args]); return this; },
    limit(...args) { calls.push(["limit", ...args]); return Promise.resolve({ data: [{ thread_id: id }], error: null }); },
  };
  const client = { from(...args) { calls.push(["from", ...args]); return builder; } };
  assert.deepEqual(await listRemovedHelperThreads(client, owner, []), []);
  assert.equal(calls.length, 0);
  assert.deepEqual(await listRemovedHelperThreads(client, owner, [id]), [id]);
  assert.deepEqual(calls, [["from", "thread_deletions"], ["select", "thread_id"], ["eq", "owner_id", owner], ["in", "thread_id", [id]], ["limit", 200]]);
  builder.limit = async () => ({ data: null, error: { message: "unavailable" } });
  await assert.rejects(listRemovedHelperThreads(client, owner, [id]), /temporarily unavailable/);
});

test("permanent board removal reaches the running helper and deletes only its related workspace", async (t) => {
  const f = await database(t);
  const ownerId = f.owners[0], removedId = f.threads[0], keptId = randomUUID();
  await f.pg.query("insert into threads(id,title,owner_id) values($1,'Keep this conversation',$2)", [keptId, ownerId]);
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "duo-removal-flow-")));
  // Teardown has one known absolute target directly under the system temp directory.
  assert.equal(path.dirname(temporary), await realpath(tmpdir()));
  assert.ok(path.basename(temporary).startsWith("duo-removal-flow-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const stateDirectory = path.join(temporary, "state"), workspaceRoot = path.join(temporary, "workspaces");
  let removedFolder = path.join(workspaceRoot, removedId), keptFolder = path.join(workspaceRoot, keptId);
  await mkdir(stateDirectory);
  await mkdir(path.join(removedFolder, "nested"), { recursive: true });
  await mkdir(keptFolder);
  await writeFile(path.join(removedFolder, "nested", "draft.txt"), "This belongs to the removed conversation");
  await writeFile(path.join(keptFolder, "keep.txt"), "Keep my files");
  const store = await new StateStore(stateDirectory).load();
  await store.change((s) => { s.workspaceRoot = workspaceRoot; });
  let modelConnections = 0;
  const worker = new BackgroundWorker(store, { dispatchAllowed: false, clientFactory: () => {
    modelConnections++; throw new Error("This test must not start any model or real Codex task");
  } });
  for (const [conversationId, cwd, title] of [[removedId, removedFolder, "Test"], [keptId, keptFolder, "Keep this conversation"]]) {
    await worker.handle({ id: randomUUID(), type: "link", ownerId, conversationId, cwd, title });
  }
  const deliveredReceipts = [];
  const remote = new RemoteConnection(worker, f.connections[0], {
    idleMs: 10, retryMs: 10,
    fetchImpl: async (url, options) => {
      const response = await f.handlers.device(new Request(url, options));
      const result = await response.clone().json();
      deliveredReceipts.push(...(result.removed_thread_ids ?? []));
      return response;
    },
  });
  async function until(predicate) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() >= deadline) assert.fail(`Helper did not complete cleanup: ${JSON.stringify(store.state.remote)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    await worker.start();
    await remote.start();
    await until(() => store.state.remote.status === "connected");
    removedFolder = store.state.conversations[keyFor(ownerId, removedId)].cwd;
    keptFolder = store.state.conversations[keyFor(ownerId, keptId)].cwd;
    assert.equal(path.basename(removedFolder), "Test");
    assert.equal(path.basename(keptFolder), "Keep this conversation");
    assert.equal(await readFile(path.join(removedFolder, "nested", "draft.txt"), "utf8"), "This belongs to the removed conversation");
    assert.deepEqual(deliveredReceipts, []);

    // This is the same transactional database function called by the board's DELETE route.
    const removed = await f.pg.query("select remove_board_conversation($1,'Test',$2) as result", [removedId, ownerId]);
    assert.deepEqual(removed.rows[0].result, { deleted: true, thread_id: removedId });
    const conversationKey = keyFor(ownerId, removedId);
    await until(() => store.state.conversations[conversationKey].workspaceCleanup?.status === "complete");
    await remote.close();
    await assert.rejects(stat(removedFolder), { code: "ENOENT" });
    assert.equal(await readFile(path.join(keptFolder, "keep.txt"), "utf8"), "Keep my files");
    assert.ok(deliveredReceipts.includes(removedId));
    assert.equal(deliveredReceipts.includes(keptId), false);
    assert.equal(remote.report().some((entry) => entry.thread_id === removedId), false);
    assert.equal(remote.report().some((entry) => entry.thread_id === keptId), true);
    const reloaded = await new StateStore(stateDirectory).load();
    assert.equal(reloaded.state.conversations[conversationKey].workspaceCleanup.status, "complete");
    assert.equal((await f.pg.query("select count(*)::integer as n from threads where id=$1", [keptId])).rows[0].n, 1);
    const receipt = (await f.pg.query("select chatgpt_cleaned_at,claude_cleaned_at from thread_deletions where thread_id=$1", [removedId])).rows[0];
    assert.deepEqual(receipt, { chatgpt_cleaned_at: null, claude_cleaned_at: null });
    assert.equal(modelConnections, 0);
  } finally {
    await remote.close();
    await worker.close();
  }
});
