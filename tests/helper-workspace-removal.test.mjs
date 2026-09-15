import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { StateStore, keyFor, prepareDirectory } from "../bridge/storage.mjs";
import { BackgroundWorker } from "../bridge/worker.mjs";
import { RemoteConnection } from "../bridge/remote.mjs";
import { Backend } from "./fixtures/worker-backend.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (await predicate()) return; await pause(10); }
  assert.fail("Condition did not complete");
}
async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), "duo-removal-flow-"));
  const directory = await prepareDirectory(path.join(root, "state"));
  const workspaceRoot = path.join(root, "workspaces");
  await mkdir(workspaceRoot);
  const store = await new StateStore(directory).load();
  await store.change((s) => { s.workspaceRoot = workspaceRoot; s.remote = { events: {} }; });
  const backend = new Backend();
  const worker = new BackgroundWorker(store, { clientFactory: () => backend.client(), turnTimeoutMs: 1000 });
  await worker.start();
  t.after(async () => { await worker.close(); assert.equal(path.dirname(root), path.resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  const ownerId = randomUUID();
  const route = { ownerId, conversationId: randomUUID() };
  const cwd = path.join(workspaceRoot, route.conversationId);
  await mkdir(cwd); await writeFile(path.join(cwd, "file.txt"), "conversation file");
  await worker.handle({ id: randomUUID(), type: "link", ...route, cwd });
  const config = { ownerId, deviceId: randomUUID(), url: "https://example.test", token: `duo_helper_${"x".repeat(43)}` };
  const remote = new RemoteConnection(worker, config);
  return { root, store, worker, backend, remote, route, cwd, directory, key: keyFor(ownerId, route.conversationId) };
}

test("an explicit removal cleans its folder once and prevents later wake or provisioning", async (t) => {
  const f = await setup(t);
  await f.remote.cleanupRemoved([f.route.conversationId]);
  await assert.rejects(stat(f.cwd), { code: "ENOENT" });
  assert.equal(f.store.state.conversations[f.key].workspaceCleanup.status, "complete");
  assert.deepEqual(f.remote.report(), []);
  await assert.rejects(f.worker.handle({ id: randomUUID(), type: "resume", ...f.route }), /removed/);
  await assert.rejects(f.worker.ensureSessions(f.route.ownerId, f.route.conversationId), /removed/);
  await mkdir(f.cwd); // A later user-created folder must never be deleted by a replayed receipt.
  await writeFile(path.join(f.cwd, "later.txt"), "keep");
  await f.remote.cleanupRemoved([f.route.conversationId]);
  assert.equal(await readFile(path.join(f.cwd, "later.txt"), "utf8"), "keep");
  const restored = await new StateStore(f.directory).load();
  assert.equal(restored.state.conversations[f.key].workspaceCleanup.status, "complete");
  assert.equal(f.backend.created, 0);
});

test("a missing request does not authorize folder deletion", async (t) => {
  const f = await setup(t);
  await f.remote.removed(randomUUID(), f.route.conversationId);
  assert.equal(await readFile(path.join(f.cwd, "file.txt"), "utf8"), "conversation file");
  assert.equal(f.store.state.conversations[f.key].removedAt, undefined);
});

test("cleanup waits for an active answer to stop before deleting its workspace", async (t) => {
  const f = await setup(t);
  const accepted = await f.worker.handle({ id: randomUUID(), type: "enqueue", ...f.route, requestId: randomUUID(), text: "hold this answer" });
  await until(() => f.store.state.jobs[accepted.jobKey].status === "running");
  await f.remote.cleanupRemoved([f.route.conversationId]);
  assert.ok((await stat(f.cwd)).isDirectory());
  assert.equal(f.store.state.conversations[f.key].workspaceCleanup.status, "pending");
  await until(() => f.worker.active.size === 0);
  assert.equal(f.store.state.jobs[accepted.jobKey].status, "stopped");
  await f.remote.cleanupRemoved([f.route.conversationId]);
  await assert.rejects(stat(f.cwd), { code: "ENOENT" });
});

test("an unsafe mapping blocks only that folder and retries without recreating sessions", async (t) => {
  const f = await setup(t);
  const outside = path.join(f.root, "manual-project");
  await mkdir(outside); await writeFile(path.join(outside, "keep.txt"), "keep");
  await f.store.change((s) => { s.conversations[f.key].cwd = outside; });
  await f.remote.cleanupRemoved([f.route.conversationId]);
  assert.equal(f.store.state.conversations[f.key].workspaceCleanup.status, "blocked");
  assert.deepEqual(f.remote.report(), []); // Backoff prevents tight polling on a blocked receipt.
  assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "keep");
  await f.store.change((s) => { s.conversations[f.key].cwd = f.cwd; });
  await f.remote.cleanupRemoved([f.route.conversationId]);
  assert.equal(f.store.state.conversations[f.key].workspaceCleanup.status, "complete");
  assert.equal(f.backend.created, 0);
});

test("cleanup cannot touch another account's mapped conversation", async (t) => {
  const f = await setup(t);
  f.remote.config.ownerId = randomUUID();
  await f.remote.cleanupRemoved([f.route.conversationId, randomUUID()]);
  assert.equal(await readFile(path.join(f.cwd, "file.txt"), "utf8"), "conversation file");
  assert.equal(f.store.state.conversations[f.key].workspaceCleanup, undefined);
});
