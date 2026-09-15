import test from "node:test";
import assert from "node:assert/strict";
import { Backend } from "./fixtures/worker-backend.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { StateStore, prepareDirectory, keyFor } from "../bridge/storage.mjs";
import { BackgroundWorker, IDLE_TIMEOUT_MS } from "../bridge/worker.mjs";
import { startService } from "../bridge/service.mjs";
import { submitCommand } from "../bridge/control.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message = "condition", timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await pause(10); }
  assert.fail(`Timed out waiting for ${message}`);
}
async function setup(t, overrides = {}) {
  const directory = await prepareDirectory(await mkdtemp(path.join(tmpdir(), "duo-worker-test-")));
  const store = await new StateStore(directory).load();
  const backend = new Backend();
  const options = { clientFactory: () => backend.client(), retryBaseMs: 5, retryMaxMs: 20, turnTimeoutMs: 3000, ...overrides };
  const worker = new BackgroundWorker(store, options);
  const fatal = [];
  worker.on("fatal", (e) => fatal.push(e));
  await worker.start();
  t.after(async () => { await worker.close(); assert.deepEqual(fatal, []); });
  const route = { ownerId: randomUUID(), conversationId: randomUUID() };
  const command = (type, fields = {}, target = route) => ({ id: randomUUID(), type, ...target, ...fields });
  await worker.handle(command("link", { cwd: directory }));
  return { directory, store, backend, options, worker, route, command };
}
const job = (store, key) => store.snapshot().jobs[key];

test("idle helper launches no Codex process or model request", async (t) => {
  const { backend } = await setup(t);
  await pause(300);
  assert.equal(backend.clients, 0);
  assert.equal(backend.starts.length, 0);
});

test("Codex tasks use the Duo Board title and follow later conversation renames", async (t) => {
  const { worker, backend, command, route, directory } = await setup(t);
  await worker.handle(command("link", { cwd: directory, title: "First name" }));
  const taskId = await worker.ensureTask(route.ownerId, route.conversationId);
  assert.deepEqual(backend.names.at(-1), { threadId: taskId, name: "Duo Board — First name" });

  await worker.handle(command("link", { cwd: directory, title: "Renamed conversation" }));
  await worker.ensureTask(route.ownerId, route.conversationId);
  assert.deepEqual(backend.names.at(-1), { threadId: taskId, name: "Duo Board — Renamed conversation" });
  assert.equal(backend.created, 1);
});

test("card Stop interrupts only its request and later questions continue in the same task",async(t)=>{
  const {worker,store,backend,command}=await setup(t);
  const requestId=randomUUID();
  const first=await worker.handle(command("enqueue",{requestId,text:"hold targeted stop"}));
  await until(()=>job(store,first.jobKey).status==="running");
  const later=await worker.handle(command("enqueue",{requestId:randomUUID(),text:"later question"}));
  await worker.handle(command("cancel",{requestId}));
  await until(()=>job(store,later.jobKey).status==="completed");
  assert.equal(job(store,first.jobKey).status,"stopped");
  assert.equal(backend.created,1);assert.equal(backend.starts.length,2);
});

test("card Stop arriving before its message prevents a late enqueue without pausing other work",async(t)=>{
  const {worker,store,backend,command}=await setup(t);
  const requestId=randomUUID();await worker.handle(command("cancel",{requestId}));
  const late=await worker.handle(command("enqueue",{requestId,text:"never run"}));
  const next=await worker.handle(command("enqueue",{requestId:randomUUID(),text:"run this"}));
  await until(()=>job(store,next.jobKey).status==="completed");assert.equal(job(store,late.jobKey).status,"stopped");
  assert.deepEqual(backend.starts.map((r)=>r.text),["run this"]);
});

test("idle sleep occurs at five minutes without browser activity or any model call", async (t) => {
  let now = Date.now();
  const { worker, store, backend, route } = await setup(t, { now: () => now });
  const key = keyFor(route.ownerId, route.conversationId);
  now += IDLE_TIMEOUT_MS - 1; worker.pump(); await pause(20);
  assert.equal(store.snapshot().conversations[key].mode, "ready");
  now++; worker.pump();
  await until(() => store.snapshot().conversations[key].mode === "sleeping");
  now += 60 * 60_000; worker.pump(); await pause(20);
  assert.equal(backend.clients, 0);
  assert.equal(backend.starts.length, 0);
});

test("sleep releases our idle Codex process and new work resumes the same saved task", async (t) => {
  let now = Date.now();
  const { worker, store, backend, route, command } = await setup(t, { now: () => now });
  const firstCommand = command("enqueue", { requestId: randomUUID(), text: "before sleep" });
  const first = await worker.handle(firstCommand);
  await until(() => job(store, first.jobKey).status === "completed" && worker.active.size === 0);
  const key = keyFor(route.ownerId, route.conversationId);
  const taskId = store.snapshot().conversations[key].threadId;
  const oldClient = worker.client;
  now += IDLE_TIMEOUT_MS; worker.pump();
  await until(() => oldClient.closed && !worker.releasing);
  assert.equal(store.snapshot().conversations[key].mode, "sleeping");
  await worker.handle(firstCommand); // Replayed delivery cannot reset inactivity.
  await worker.handle(command("enqueue", { requestId: firstCommand.requestId, text: firstCommand.text }));
  assert.equal(store.snapshot().conversations[key].mode, "sleeping");
  assert.equal(backend.clients, 1);
  const next = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "after sleep" }));
  await until(() => job(store, next.jobKey).status === "completed");
  assert.equal(backend.created, 1);
  assert.equal(backend.clients, 2);
  assert.deepEqual(backend.starts.map((r) => r.threadId), [taskId, taskId]);
});

test("an in-progress answer finishes before its idle countdown starts", async (t) => {
  let now = Date.now();
  const { worker, store, backend, route, command } = await setup(t, { now: () => now });
  const active = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "hold long answer" }));
  await until(() => job(store, active.jobKey).status === "running");
  now += 10 * IDLE_TIMEOUT_MS; worker.pump(); await pause(20);
  const key = keyFor(route.ownerId, route.conversationId);
  assert.equal(store.snapshot().conversations[key].mode, "ready");
  assert.equal(job(store, active.jobKey).stopRequested, false);
  const taskId = store.snapshot().conversations[key].threadId;
  worker.client.complete(taskId, backend.threads.get(taskId).turns[0]);
  await until(() => job(store, active.jobKey).status === "completed" && worker.active.size === 0);
  assert.equal(store.snapshot().conversations[key].lastActivityAt, now);
  now += IDLE_TIMEOUT_MS - 1; worker.pump(); await pause(20);
  assert.equal(store.snapshot().conversations[key].mode, "ready");
  now++; worker.pump(); await until(() => store.snapshot().conversations[key].mode === "sleeping");
});

test("sleeping one conversation cannot close the connection used by another active owner", async (t) => {
  let now = Date.now();
  const { worker, store, backend, route, command, directory } = await setup(t, { now: () => now });
  const first = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "finished owner" }));
  await until(() => job(store, first.jobKey).status === "completed" && !worker.active.size);
  const other = { ownerId: randomUUID(), conversationId: randomUUID() };
  now += 240_000;
  await worker.handle(command("link", { cwd: directory }, other));
  const active = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "hold other owner" }, other));
  await until(() => job(store, active.jobKey).status === "running");
  const client = worker.client;
  now += 60_000; worker.pump();
  await until(() => store.snapshot().conversations[keyFor(route.ownerId, route.conversationId)].mode === "sleeping");
  assert.equal(client.closed, false);
  assert.equal(worker.client, client);
  assert.equal(job(store, active.jobKey).status, "running");
  assert.equal(backend.clients, 1);
  await worker.handle(command("stop", {}, other));
  await until(() => job(store, active.jobKey).status === "stopped");
});

test("a wake racing idle connection release waits, then resumes without a competing owner", async (t) => {
  let now = Date.now();
  const { worker, store, backend, command } = await setup(t, { now: () => now });
  const first = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "before release" }));
  await until(() => job(store, first.jobKey).status === "completed" && !worker.active.size);
  const client = worker.client, close = client.close.bind(client);
  let release, closing = false;
  const pending = new Promise((resolve) => { release = resolve; });
  client.close = async () => { closing = true; await pending; await close(); };
  try {
    now += IDLE_TIMEOUT_MS; worker.pump(); await until(() => closing);
    const next = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "during release" }));
    assert.equal(job(store, next.jobKey).status, "queued");
    assert.equal(backend.clients, 1);
    release();
    await until(() => job(store, next.jobKey).status === "completed");
    assert.equal(backend.created, 1);
    assert.equal(backend.clients, 2);
  } finally { release(); }
});

test("a persisted deadline expires before queued work can start after an offline restart", async (t) => {
  let now = Date.now();
  const { worker, store, backend, route, command, directory, options } = await setup(t, { now: () => now, dispatchAllowed: false });
  const pending = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "saved while offline" }));
  await worker.close();
  now += IDLE_TIMEOUT_MS;
  const recovered = await new StateStore(directory).load();
  const restarted = new BackgroundWorker(recovered, { ...options, dispatchAllowed: true });
  await restarted.start(); t.after(() => restarted.close());
  const key = keyFor(route.ownerId, route.conversationId);
  await until(() => recovered.snapshot().conversations[key].mode === "sleeping");
  assert.equal(backend.clients, 0);
  assert.equal(job(recovered, pending.jobKey).status, "queued");
  assert.equal(recovered.snapshot().conversations[key].lastActivityAt, store.snapshot().conversations[key].lastActivityAt);
  await restarted.handle(command("resume"));
  await until(() => job(recovered, pending.jobKey).status === "completed");
  assert.equal(backend.starts.length, 1);
});

test("activity and idle wake never override a manual Stop or replay cancelled work", async (t) => {
  let now = Date.now();
  const { worker, store, backend, route, command } = await setup(t, { now: () => now, dispatchAllowed: false });
  const old = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "cancel this" }));
  await worker.handle(command("stop"));
  now += IDLE_TIMEOUT_MS;
  await worker.handle(command("activity"));
  const next = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "wait for explicit resume" }));
  worker.setDispatchAllowed(true); await pause(30);
  assert.equal(store.snapshot().conversations[keyFor(route.ownerId, route.conversationId)].mode, "paused");
  assert.equal(backend.starts.length, 0);
  await worker.handle(command("resume"));
  await until(() => job(store, next.jobKey).status === "completed");
  assert.equal(job(store, old.jobKey).status, "stopped");
  assert.deepEqual(backend.starts.map((r) => r.text), ["wait for explicit resume"]);
});

test("activity is per conversation; delayed events and repeated receipts cannot extend the deadline", async (t) => {
  let now = Date.now();
  const { worker, store, backend, route, command, directory } = await setup(t, { now: () => now });
  const other = { ownerId: randomUUID(), conversationId: randomUUID() };
  await worker.handle(command("link", { cwd: directory }, other));
  const firstKey = keyFor(route.ownerId, route.conversationId), otherKey = keyFor(other.ownerId, other.conversationId);
  const original = now;
  now += 240_000;
  const activity = command("activity");
  await worker.handle(activity);
  now += 60_000;
  await worker.handle(command("activity"), { activityAgeMs: IDLE_TIMEOUT_MS });
  await worker.handle(activity);
  await until(() => store.snapshot().conversations[otherKey].mode === "sleeping");
  assert.equal(store.snapshot().conversations[firstKey].lastActivityAt, original + 240_000);
  assert.equal(store.snapshot().conversations[firstKey].mode, "ready");
  now += 240_000; worker.pump();
  await until(() => store.snapshot().conversations[firstKey].mode === "sleeping");
  await worker.handle(command("activity"));
  assert.equal(store.snapshot().conversations[firstKey].mode, "sleeping");
  assert.equal(backend.starts.length, 0);
});

test("requests run once, in order per conversation, and reuse the saved task after restart", async (t) => {
  const { worker, store, backend, command, options, directory } = await setup(t);
  const requestId = randomUUID();
  const first = await worker.handle(command("enqueue", { requestId, text: "one" }));
  const duplicate = await worker.handle(command("enqueue", { requestId, text: "one" }));
  const second = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "two" }));
  assert.equal(duplicate.duplicate, true);
  await until(() => job(store, second.jobKey).status === "completed");
  assert.equal(job(store, first.jobKey).result, "Answer: one");
  assert.deepEqual(backend.starts.map((x) => x.text), ["one", "two"]);
  const taskId = backend.starts[0].threadId;
  await worker.close();
  const reopenedStore = await new StateStore(directory).load();
  const restarted = new BackgroundWorker(reopenedStore, options); await restarted.start(); t.after(() => restarted.close());
  await restarted.handle(command("enqueue", { requestId, text: "one" }));
  const third = await restarted.handle(command("enqueue", { requestId: randomUUID(), text: "three" }));
  await until(() => job(reopenedStore, third.jobKey).status === "completed");
  assert.equal(backend.created, 1);
  assert.deepEqual(backend.starts.map((x) => x.threadId), [taskId, taskId, taskId]);
});

test("different owners with the same board conversation ID get separate task histories", async (t) => {
  const { worker, store, backend, route, command, directory } = await setup(t);
  const other = { ...route, ownerId: randomUUID() };
  await worker.handle(command("link", { cwd: directory }, other));
  const first = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "first owner" }));
  const second = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "other owner" }, other));
  await until(() => [first, second].every((r) => job(store, r.jobKey).status === "completed"));
  assert.equal(backend.created, 2);
  assert.notEqual(backend.starts[0].threadId, backend.starts[1].threadId);
});

test("task provisioning creates one saved Codex task without starting a model turn", async (t) => {
  const { worker, store, backend, route } = await setup(t);
  const first = await worker.ensureTask(route.ownerId, route.conversationId);
  const second = await worker.ensureTask(route.ownerId, route.conversationId);
  assert.equal(first, second);
  assert.equal(store.snapshot().conversations[keyFor(route.ownerId, route.conversationId)].threadId, first);
  assert.equal(backend.created, 1);
  assert.equal(backend.starts.length, 0);
});

test("a temporary connection failure reconnects and runs queued work only once", async (t) => {
  const { worker, store, backend, command } = await setup(t);
  backend.failConnections = 1;
  const queued = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "after reconnect" }));
  await until(() => job(store, queued.jobKey).status === "completed");
  assert.equal(backend.clients, 2);
  assert.equal(backend.starts.length, 1);
});

test("a lost start response is recovered from persisted client ID without repeating the turn", async (t) => {
  const { worker, store, backend, command } = await setup(t);
  const queued = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "lost-after-start" }));
  await until(() => job(store, queued.jobKey).status === "completed");
  assert.equal(backend.clients, 2);
  assert.equal(backend.starts.length, 1);
  assert.equal(job(store, queued.jobKey).result, "Answer: lost-after-start");
});

test("an uncertain request absent from history requires attention and is never blindly replayed", async (t) => {
  const { worker, store, backend, command } = await setup(t);
  const queued = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "lost-before-start" }));
  await until(() => job(store, queued.jobKey).status === "attention");
  await pause(300);
  assert.equal(backend.clients, 2);
  assert.equal(backend.starts.length, 0);
  assert.match(job(store, queued.jobKey).error, /not been sent again/);
});

test("Stop interrupts active work, cancels old queued work, and holds new work until explicit Resume", async (t) => {
  const { worker, store, backend, command } = await setup(t);
  const active = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "hold active" }));
  await until(() => job(store, active.jobKey).status === "running");
  const queued = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "cancel queued" }));
  await worker.handle(command("stop"));
  await until(() => job(store, active.jobKey).status === "stopped");
  assert.equal(job(store, queued.jobKey).status, "stopped");
  const later = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "after resume" }));
  await pause(300); assert.equal(job(store, later.jobKey).status, "queued");
  const resume = command("resume");
  await worker.handle(resume);
  await until(() => job(store, later.jobKey).status === "completed");
  await worker.handle(command("stop"));
  await worker.handle(resume); // Redelivered old Resume must not undo the newer Stop.
  assert.equal(Object.values(store.snapshot().conversations)[0].mode, "paused");
  assert.deepEqual(backend.starts.map((x) => x.text), ["hold active", "after resume"]);
});

test("a task owned elsewhere is not replaced or taken over", async (t) => {
  const { worker, store, backend, command, route } = await setup(t);
  const threadId = randomUUID(); backend.threads.set(threadId, { id: threadId, turns: [] }); backend.conflict = true;
  await store.change((s) => { s.conversations[keyFor(route.ownerId, route.conversationId)].threadId = threadId; });
  const queued = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "conflict" }));
  await until(() => job(store, queued.jobKey).status === "attention");
  assert.equal(backend.created, 0); assert.equal(backend.starts.length, 0);
});

test("approval requests stop the run and produce attention, never a successful final answer", async (t) => {
  const { worker, store, command } = await setup(t);
  const queued = await worker.handle(command("enqueue", { requestId: randomUUID(), text: "needs-approval" }));
  await until(() => job(store, queued.jobKey).status === "attention");
  assert.equal(job(store, queued.jobKey).result, null);
  assert.match(job(store, queued.jobKey).error, /User attention/);
});

test("command and request IDs cannot be reused to change accepted work", async (t) => {
  const { worker, command } = await setup(t);
  await worker.handle(command("stop"));
  const enqueue = command("enqueue", { requestId: randomUUID(), text: "original" });
  await worker.handle(enqueue);
  await assert.rejects(worker.handle({ ...enqueue, text: "different" }), /Command ID was reused/);
  await assert.rejects(worker.handle({ ...enqueue, id: randomUUID(), text: "different" }), /Request ID was reused/);
});

test("local service accepts an offline command and prevents a second helper instance", async (t) => {
  const directory = await prepareDirectory(await mkdtemp(path.join(tmpdir(), "duo-service-test-")));
  const backend = new Backend();
  const options = { directory, workerOptions: { clientFactory: () => backend.client() } };
  const command = { id: randomUUID(), type: "link", ownerId: randomUUID(), conversationId: randomUUID(), cwd: directory };
  const receipt = await submitCommand(directory, command);
  const service = await startService(options); t.after(() => service.close());
  await until(async () => { try { return JSON.parse(await readFile(receipt, "utf8")).ok; } catch { return false; } });
  await assert.rejects(startService(options), /Another helper owns/);
  assert.equal(backend.clients, 0);
  await service.close();
  const restarted = await startService(options); t.after(() => restarted.close());
  assert.equal(Object.keys(restarted.store.snapshot().conversations).length, 1);
});

test("corrupted state is preserved and fails closed instead of resetting task links", async () => {
  const directory = await prepareDirectory(await mkdtemp(path.join(tmpdir(), "duo-state-test-")));
  const file = path.join(directory, "state.json"); await writeFile(file, "{broken");
  await assert.rejects(new StateStore(directory).load(), /has not been reset/);
  assert.equal(await readFile(file, "utf8"), "{broken");
});

test("the OS releases the helper lock after a process crash, without starting Codex", async (t) => {
  const directory = await prepareDirectory(await mkdtemp(path.join(tmpdir(), "duo-crash-test-")));
  const helper = fileURLToPath(new URL("../bridge/helper.mjs", import.meta.url));
  const child = spawn(process.execPath, [helper, "--state-dir", directory], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => { child.kill(); await exited; });
  let output = "";
  child.stdout.on("data", (data) => { output += data.toString(); });
  await until(() => output.includes('"status":"ready"'), "helper readiness");
  const backend = new Backend();
  await assert.rejects(startService({ directory, workerOptions: { clientFactory: () => backend.client() } }), /Another helper owns/);
  child.kill("SIGKILL"); await exited;
  if (process.platform !== "win32") return; // Unix socket recovery is outside this Windows helper's scope.
  const restarted = await startService({ directory, workerOptions: { clientFactory: () => backend.client() } });
  t.after(() => restarted.close());
  assert.equal(backend.clients, 0);
});

test("shutdown closes the Codex child even when the state disk becomes unwritable", async () => {
  const directory = await prepareDirectory(await mkdtemp(path.join(tmpdir(), "duo-shutdown-test-")));
  const store = await new StateStore(directory).load();
  const backend = new Backend();
  const worker = new BackgroundWorker(store, { clientFactory: () => backend.client() });
  worker.on("fatal", () => {});
  await worker.start();
  const route = { ownerId: randomUUID(), conversationId: randomUUID() };
  await worker.handle({ id: randomUUID(), type: "link", ...route, cwd: directory });
  const queued = await worker.handle({ id: randomUUID(), type: "enqueue", ...route, requestId: randomUUID(), text: "hold during shutdown" });
  await until(() => job(store, queued.jobKey).status === "running");
  const client = worker.client;
  store.change = async () => { throw Object.assign(new Error("State disk is full"), { code: "ENOSPC" }); };
  await assert.rejects(worker.close(), /State disk is full/);
  assert.equal(client.closed, true);
  assert.equal(backend.busy.size, 0);
});
