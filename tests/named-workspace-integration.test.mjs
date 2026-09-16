import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { importConnectionBundle } from "../bridge/connect.mjs";
import { RemoteConnection } from "../bridge/remote.mjs";
import { BackgroundWorker } from "../bridge/worker.mjs";
import { StateStore, keyFor, prepareDirectory } from "../bridge/storage.mjs";
import { Backend } from "./fixtures/worker-backend.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(10);
  }
  assert.fail("Condition did not complete");
}

function assertNamed(cwd, workspaceRoot, title) {
  assert.equal(path.dirname(cwd), workspaceRoot);
  const compact = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  assert.ok(compact(path.basename(cwd)).includes(compact(title)), `Expected ${path.basename(cwd)} to contain the conversation title`);
}

async function setup(t) {
  const temporaryRoot = path.resolve(tmpdir());
  const root = await realpath(await mkdtemp(path.join(temporaryRoot, "duo-named-integration-")));
  const directory = await prepareDirectory(path.join(root, "state"));
  const workspaceRoot = path.join(root, "workspaces");
  await mkdir(workspaceRoot);
  const ownerId = randomUUID();
  const config = { ownerId, deviceId: randomUUID(), url: "https://board.test", token: `duo_helper_${"x".repeat(43)}` };
  const store = await new StateStore(directory).load();
  await store.change((s) => {
    s.workspaceRoot = workspaceRoot;
    s.remote = { ownerId, deviceId: config.deviceId, origin: config.url, instanceId: randomUUID(), events: {} };
  });
  const backend = new Backend();
  const calls = [];
  const worker = new BackgroundWorker(store, {
    dispatchAllowed: false,
    clientFactory: () => {
      const client = backend.client();
      const call = client.call.bind(client);
      client.call = (method, params) => {
        calls.push({ method, params: structuredClone(params) });
        return call(method, params);
      };
      return client;
    },
    turnTimeoutMs: 2000,
  });
  const errors = [];
  worker.on("fatal", (error) => errors.push(error));
  const remote = new RemoteConnection(worker, config, {
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.action, "ack");
      return Response.json({ id: request.id, status: "received" });
    },
  });
  t.after(async () => {
    await worker.close();
    assert.equal(path.dirname(root).toLowerCase(), (await realpath(temporaryRoot)).toLowerCase());
    assert.ok(path.basename(root).startsWith("duo-named-integration-"));
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const event = (title, conversationId = randomUUID()) => ({
    id: randomUUID(), seq: 1, thread_id: conversationId, title,
    action: "activity", message_id: null, prompt: null, status: "pending", created_at: new Date().toISOString(),
  });
  const legacy = async (title, conversationId = randomUUID()) => {
    const cwd = path.join(workspaceRoot, conversationId);
    await mkdir(cwd);
    await writeFile(path.join(cwd, "saved-work.txt"), "saved conversation work");
    const route = { ownerId, conversationId };
    await worker.handle({ id: randomUUID(), type: "link", ...route, cwd, title, claudeSessionId: randomUUID() });
    return { route, cwd, key: keyFor(ownerId, conversationId) };
  };
  return { root, directory, workspaceRoot, ownerId, config, store, worker, backend, calls, remote, event, legacy };
}

test("a newly linked board conversation gets a named workspace and a single Codex task", async (t) => {
  const f = await setup(t);
  const event = f.event("Project Alpha");
  await f.remote.linkConversation(event);
  const c = f.store.state.conversations[keyFor(f.ownerId, event.thread_id)];
  assertNamed(c.cwd, f.workspaceRoot, event.title);
  assert.ok((await stat(c.cwd)).isDirectory());
  assert.equal(f.backend.created, 1);
  assert.equal(f.backend.starts.length, 0);
  assert.equal(f.backend.names.at(-1).threadId, c.threadId);
  await f.remote.syncWorkspaceNames();
  assert.equal(f.store.state.conversations[keyFor(f.ownerId, event.thread_id)].cwd, c.cwd);
  assert.equal(f.backend.created, 1);
});

test("migration preserves UUID-folder contents and session IDs and unloads the old task path", async (t) => {
  const f = await setup(t);
  const old = await f.legacy("Existing Project");
  await f.worker.ensureSessions(old.route.ownerId, old.route.conversationId);
  await f.worker.start();
  f.worker.setDispatchAllowed(true);
  const savedRequest = await f.worker.handle({ id: randomUUID(), type: "enqueue", ...old.route, requestId: randomUUID(), text: "remember the saved answer" });
  await until(() => f.store.state.jobs[savedRequest.jobKey].status === "completed" && f.worker.active.size === 0);
  f.worker.setDispatchAllowed(false);
  const before = structuredClone(f.store.state.conversations[old.key]);
  assert.ok(f.worker.loaded.has(before.threadId));
  const turns = structuredClone(f.backend.threads.get(before.threadId).turns);
  assert.equal(turns.length, 1);
  assert.ok(turns[0].items.some((item) => item.type === "agentMessage"));

  await f.remote.syncWorkspaceNames();

  const after = f.store.state.conversations[old.key];
  assertNamed(after.cwd, f.workspaceRoot, before.title);
  assert.notEqual(after.cwd, old.cwd);
  assert.equal(await readFile(path.join(after.cwd, "saved-work.txt"), "utf8"), "saved conversation work");
  await assert.rejects(stat(old.cwd), { code: "ENOENT" });
  assert.equal(after.threadId, before.threadId);
  assert.equal(after.claudeSessionId, before.claudeSessionId);
  assert.equal(f.worker.loaded.has(before.threadId), false);
  assert.deepEqual(f.backend.threads.get(before.threadId).turns, turns);
  const reloaded = await new StateStore(f.directory).load();
  assert.equal(reloaded.state.conversations[old.key].cwd, after.cwd);

  f.worker.setDispatchAllowed(true);
  const followup = await f.worker.handle({ id: randomUUID(), type: "enqueue", ...old.route, requestId: randomUUID(), text: "continue after the folder move" });
  await until(() => f.store.state.jobs[followup.jobKey].status === "completed" && f.worker.active.size === 0);
  f.worker.setDispatchAllowed(false);
  assert.equal(f.backend.created, 1);
  assert.equal(f.backend.starts.at(-1).threadId, before.threadId);
  assert.equal(f.backend.threads.get(before.threadId).turns.length, 2);
  assert.equal(f.calls.filter((call) => call.method === "thread/resume").at(-1).params.cwd, after.cwd);
  assert.equal(f.calls.filter((call) => call.method === "turn/start").at(-1).params.cwd, after.cwd);
});

test("a board title-change event renames its folder without replacing the existing sessions", async (t) => {
  const f = await setup(t);
  const event = f.event("Original Project");
  await f.remote.linkConversation(event);
  const key = keyFor(f.ownerId, event.thread_id);
  const before = structuredClone(f.store.state.conversations[key]);
  await writeFile(path.join(before.cwd, "saved-work.txt"), "saved conversation work");
  await f.remote.apply(f.event("Renamed Project", event.thread_id), new Date().toISOString());
  await f.remote.syncWorkspaceNames();

  const after = f.store.state.conversations[key];
  assertNamed(after.cwd, f.workspaceRoot, "Renamed Project");
  assert.notEqual(after.cwd, before.cwd);
  assert.equal(await readFile(path.join(after.cwd, "saved-work.txt"), "utf8"), "saved conversation work");
  await assert.rejects(stat(before.cwd), { code: "ENOENT" });
  assert.equal(after.threadId, before.threadId);
  assert.equal(after.claudeSessionId, before.claudeSessionId);
  assert.equal(f.backend.created, 1);
});

test("migration waits for a running answer to stop before moving its working folder", async (t) => {
  const f = await setup(t);
  const old = await f.legacy("Active Project");
  await f.worker.start();
  f.worker.setDispatchAllowed(true);
  const accepted = await f.worker.handle({ id: randomUUID(), type: "enqueue", ...old.route, requestId: randomUUID(), text: "hold this answer" });
  await until(() => f.store.state.jobs[accepted.jobKey].status === "running");
  const threadId = f.store.state.conversations[old.key].threadId;
  f.worker.setDispatchAllowed(false);
  await f.remote.syncWorkspaceNames();
  assert.equal(f.store.state.conversations[old.key].cwd, old.cwd);
  assert.equal(await readFile(path.join(old.cwd, "saved-work.txt"), "utf8"), "saved conversation work");

  await f.worker.handle({ id: randomUUID(), type: "stop", ...old.route });
  await until(() => f.worker.active.size === 0);
  await f.remote.syncWorkspaceNames();
  const after = f.store.state.conversations[old.key];
  assertNamed(after.cwd, f.workspaceRoot, "Active Project");
  assert.equal(after.threadId, threadId);
  assert.equal(await readFile(path.join(after.cwd, "saved-work.txt"), "utf8"), "saved conversation work");
});

for (const status of ["starting", "running", "recovering"]) {
  test(`migration defers an uncertain ${status} job even without an active runtime`, async (t) => {
    const f = await setup(t);
    const old = await f.legacy("Uncertain Project");
    const accepted = await f.worker.handle({ id: randomUUID(), type: "enqueue", ...old.route, requestId: randomUUID(), text: "saved request" });
    await f.store.change((s) => { s.jobs[accepted.jobKey].status = status; });
    await f.remote.syncWorkspaceNames();
    assert.equal(f.store.state.conversations[old.key].cwd, old.cwd);
    assert.equal(await readFile(path.join(old.cwd, "saved-work.txt"), "utf8"), "saved conversation work");
    assert.equal(f.backend.created, 0);

    await f.store.change((s) => { s.jobs[accepted.jobKey].status = "stopped"; });
    await f.remote.syncWorkspaceNames();
    assertNamed(f.store.state.conversations[old.key].cwd, f.workspaceRoot, "Uncertain Project");
  });
}

test("removal deletes only its named folder when two conversations have the same title", async (t) => {
  const f = await setup(t);
  const first = f.event("Shared Project Title");
  const second = f.event("Shared Project Title");
  await f.remote.linkConversation(first);
  await f.remote.linkConversation(second);
  const firstKey = keyFor(f.ownerId, first.thread_id);
  const secondKey = keyFor(f.ownerId, second.thread_id);
  const firstCwd = f.store.state.conversations[firstKey].cwd;
  const secondCwd = f.store.state.conversations[secondKey].cwd;
  assert.notEqual(firstCwd, secondCwd);
  await writeFile(path.join(firstCwd, "work.txt"), "remove this conversation");
  await writeFile(path.join(secondCwd, "work.txt"), "preserve the other conversation");

  await f.remote.cleanupRemoved([first.thread_id]);

  await assert.rejects(stat(firstCwd), { code: "ENOENT" });
  assert.equal(f.store.state.conversations[firstKey].workspaceCleanup.status, "complete");
  assert.equal(await readFile(path.join(secondCwd, "work.txt"), "utf8"), "preserve the other conversation");
  assert.equal(f.store.state.conversations[secondKey].removedAt, undefined);
});

test("reconnecting with the managed workspace root reuses the existing named folder and sessions", async (t) => {
  const f = await setup(t);
  const event = f.event("Reconnect Project");
  await f.remote.linkConversation(event);
  const key = keyFor(f.ownerId, event.thread_id);
  const before = structuredClone(f.store.state.conversations[key]);
  await writeFile(path.join(before.cwd, "work.txt"), "keep my saved work");
  await f.worker.close();

  await importConnectionBundle({
    bundle: { connection: f.config, conversationId: event.thread_id },
    workspaceRoot: f.workspaceRoot,
    directory: f.directory,
  });

  const saved = await new StateStore(f.directory).load();
  const after = saved.state.conversations[key];
  assert.equal(after.cwd, before.cwd);
  assert.equal(after.threadId, before.threadId);
  assert.equal(after.claudeSessionId, before.claudeSessionId);
  assert.equal(await readFile(path.join(after.cwd, "work.txt"), "utf8"), "keep my saved work");
  assert.equal(saved.state.workspaceRoot, f.workspaceRoot);
});

test("restart settles a completed filesystem move before acknowledging new messages or dispatching saved jobs", async (t) => {
  const f = await setup(t);
  const event = f.event("Original Journal Project");
  await f.remote.linkConversation(event);
  const key = keyFor(f.ownerId, event.thread_id);
  const before = structuredClone(f.store.state.conversations[key]);
  const route = { ownerId: f.ownerId, conversationId: event.thread_id };
  const queued = await f.worker.handle({ id: randomUUID(), type: "enqueue", ...route, requestId: randomUUID(), text: "saved before the interrupted move" });
  const destination = path.join(f.workspaceRoot, "Recovered Journal Project");
  await writeFile(path.join(before.cwd, "work.txt"), "saved journal content");
  await f.store.change((s) => {
    s.conversations[key].title = "Recovered Journal Project";
    s.conversations[key].workspaceRename = { from: before.cwd, to: destination };
  });
  assert.equal(path.dirname(before.cwd), f.workspaceRoot);
  assert.equal(path.dirname(destination), f.workspaceRoot);
  await rename(before.cwd, destination); // Crash after rename, before committing the saved cwd.
  await f.worker.close();

  const store = await new StateStore(f.directory).load();
  const worker = new BackgroundWorker(store, { dispatchAllowed: false, clientFactory: () => f.backend.client(), turnTimeoutMs: 2000 });
  const acknowledged = [];
  const remote = new RemoteConnection(worker, f.config, {
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.action, "ack");
      acknowledged.push(request.id);
      return Response.json({ id: request.id, status: "received" });
    },
  });
  const message = { ...f.event("Recovered Journal Project", event.thread_id), action: "message", message_id: randomUUID(), prompt: "new message after restart" };
  try {
    await worker.start();
    worker.setDispatchAllowed(true);
    assert.equal(worker.active.size, 0);
    worker.setDispatchAllowed(false);
    await remote.apply(message, new Date().toISOString());
    assert.deepEqual(acknowledged, []);
    assert.equal(Object.keys(store.state.jobs).length, 1);
    assert.equal(store.state.jobs[queued.jobKey].status, "queued");
    assert.equal(f.backend.starts.length, 0);

    await remote.syncWorkspaceNames();
    assert.equal(store.state.conversations[key].cwd, destination);
    assert.equal(store.state.conversations[key].workspaceRename, undefined);
    assert.equal(store.state.conversations[key].threadId, before.threadId);
    assert.equal(store.state.jobs[queued.jobKey].status, "queued");
    assert.equal(await readFile(path.join(destination, "work.txt"), "utf8"), "saved journal content");

    await remote.apply(message, new Date().toISOString());
    assert.deepEqual(acknowledged, [message.id]);
    assert.equal(Object.keys(store.state.jobs).length, 2);
    worker.setDispatchAllowed(true);
    await until(() => Object.values(store.state.jobs).every((job) => job.status === "completed") && worker.active.size === 0);
    assert.equal(f.backend.created, 1);
    assert.deepEqual(f.backend.starts.map((start) => start.threadId), [before.threadId, before.threadId]);
  } finally {
    await worker.close();
  }
});

test("startup migrates saved folder titles even when the helper connection is revoked", async (t) => {
  const f = await setup(t);
  const old = await f.legacy("Offline Saved Project");
  await f.store.change((s) => { s.conversations[old.key].threadId = randomUUID(); });
  const before = structuredClone(f.store.state.conversations[old.key]);
  await f.worker.start();
  let requests = 0;
  const remote = new RemoteConnection(f.worker, f.config, {
    fetchImpl: async () => {
      requests++;
      return new Response(null, { status: 401 });
    },
  });
  try {
    await remote.start();
    await until(() => f.store.state.remote.status === "attention");
    await remote.done;
    const after = f.store.state.conversations[old.key];
    assertNamed(after.cwd, f.workspaceRoot, before.title);
    assert.notEqual(after.cwd, old.cwd);
    await assert.rejects(stat(old.cwd), { code: "ENOENT" });
    assert.equal(await readFile(path.join(after.cwd, "saved-work.txt"), "utf8"), "saved conversation work");
    assert.equal(after.threadId, before.threadId);
    assert.equal(after.claudeSessionId, before.claudeSessionId);
    assert.equal(f.backend.clients, 0);
    assert.equal(f.backend.created, 0);
    assert.deepEqual(f.calls, []);
    assert.equal(requests, 1);
  } finally {
    await remote.close();
  }
});

test("reconnecting settles a completed filesystem move before resolving the saved folder", async (t) => {
  const f = await setup(t);
  const event = f.event("Before Reconnect Move");
  await f.remote.linkConversation(event);
  const key = keyFor(f.ownerId, event.thread_id);
  const before = structuredClone(f.store.state.conversations[key]);
  const queued = await f.worker.handle({ id: randomUUID(), type: "enqueue", ownerId: f.ownerId, conversationId: event.thread_id, requestId: randomUUID(), text: "preserve pending work while reconnecting" });
  const destination = path.join(f.workspaceRoot, "After Reconnect Move");
  await writeFile(path.join(before.cwd, "work.txt"), "saved reconnect content");
  await f.store.change((s) => {
    s.conversations[key].title = "After Reconnect Move";
    s.conversations[key].workspaceRename = { from: before.cwd, to: destination };
  });
  assert.equal(path.dirname(before.cwd), f.workspaceRoot);
  assert.equal(path.dirname(destination), f.workspaceRoot);
  await rename(before.cwd, destination);
  await f.worker.close();

  await importConnectionBundle({
    bundle: { connection: f.config, conversationId: event.thread_id },
    workspaceRoot: f.workspaceRoot,
    directory: f.directory,
  });

  const saved = await new StateStore(f.directory).load();
  const after = saved.state.conversations[key];
  assert.equal(after.cwd, destination);
  assert.equal(after.workspaceRename, undefined);
  assert.equal(after.threadId, before.threadId);
  assert.equal(after.claudeSessionId, before.claudeSessionId);
  assert.equal(saved.state.jobs[queued.jobKey].status, "queued");
  assert.equal(await readFile(path.join(destination, "work.txt"), "utf8"), "saved reconnect content");
  await assert.rejects(stat(before.cwd), { code: "ENOENT" });
  assert.equal(f.backend.created, 1);
  assert.equal(f.backend.starts.length, 0);
});
