import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Backend } from "./fixtures/worker-backend.mjs";
import { ClaudeClient } from "../bridge/claude-client.mjs";
import { StateStore, isId, jobKeyFor, keyFor, prepareDirectory } from "../bridge/storage.mjs";
import { BackgroundWorker, IDLE_TIMEOUT_MS, sessionName } from "../bridge/worker.mjs";

const fixture = fileURLToPath(new URL("./fixtures/claude-cli.mjs", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message = "condition", timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await pause(10); }
  assert.fail(`Timed out waiting for ${message}`);
}
const job = (store, key) => store.snapshot().jobs[key];

async function setup(t, { claudeEnv = {}, withClaude = true, ...overrides } = {}) {
  const directory = await prepareDirectory(await mkdtemp(path.join(tmpdir(), "duo-claude-worker-")));
  const home = await mkdtemp(path.join(tmpdir(), "duo-fake-claude-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await new StateStore(directory).load();
  const backend = new Backend();
  const claudeFactory = () => new ClaudeClient({ executable: process.execPath, prefixArgs: [fixture], env: { ...process.env, DUO_FAKE_CLAUDE_HOME: home, ...claudeEnv }, timeoutMs: 5000 });
  const options = { clientFactory: () => backend.client(), clientFactories: withClaude ? { claude: claudeFactory } : {}, retryBaseMs: 5, retryMaxMs: 20, turnTimeoutMs: 4000, ...overrides };
  const worker = new BackgroundWorker(store, options);
  const fatal = [];
  worker.on("fatal", (e) => fatal.push(e));
  await worker.start();
  t.after(async () => { await worker.close(); assert.deepEqual(fatal, []); });
  const route = { ownerId: randomUUID(), conversationId: randomUUID() };
  const command = (type, fields = {}, target = route) => ({ id: randomUUID(), type, ...target, ...fields });
  await worker.handle(command("link", { cwd: directory, title: "Weekend plans" }));
  const turns = async () => { try { return (await readFile(path.join(home, "calls.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.command === "turn"); } catch { return []; } };
  const conversation = (target = route) => store.snapshot().conversations[keyFor(target.ownerId, target.conversationId)];
  return { directory, home, store, backend, options, worker, route, command, turns, conversation };
}

test("a new conversation creates a visible Codex task and reserves its Claude session", async (t) => {
  const { worker, route, conversation, backend, turns } = await setup(t);
  assert.deepEqual(worker.managed, ["chatgpt", "claude"]);
  const ids = await worker.ensureSessions(route.ownerId, route.conversationId);
  assert.ok(isId(ids.claude)); assert.ok(isId(ids.chatgpt));
  assert.equal(conversation().claudeSessionId, ids.claude);
  assert.equal(conversation().claudeSessionStarted, false);
  assert.equal(conversation().threadId, ids.chatgpt);
  assert.deepEqual(await worker.ensureSessions(route.ownerId, route.conversationId), ids);
  assert.equal(backend.created, 1); assert.equal(backend.materializations, 1); assert.equal(backend.starts.length, 0);
  assert.deepEqual(await turns(), []);
});

test("a question to both assistants runs once per assistant, each in its own conversation session", async (t) => {
  const { worker, store, command, conversation, backend, turns } = await setup(t);
  const requestId = randomUUID();
  const chatgpt = await worker.handle(command("enqueue", { requestId, assistant: "chatgpt", text: "What is the plan?" }));
  const claude = await worker.handle(command("enqueue", { requestId, assistant: "claude", text: "What is the plan?" }));
  assert.notEqual(chatgpt.jobKey, claude.jobKey);
  await until(() => job(store, chatgpt.jobKey).status === "completed" && job(store, claude.jobKey).status === "completed");
  assert.equal(job(store, chatgpt.jobKey).result, "Answer: What is the plan?");
  assert.equal(job(store, claude.jobKey).result, "Answer: What is the plan?");
  const [first] = await turns();
  assert.equal(first.sessionId, conversation().claudeSessionId);
  assert.equal(first.resume, false);
  assert.equal(first.name, "Duo Board — Weekend plans");
  assert.equal(conversation().claudeSessionStarted, true);
  assert.deepEqual(backend.starts.map((s) => s.threadId), [conversation().threadId]);
  const later = await worker.handle(command("enqueue", { requestId: randomUUID(), assistant: "claude", text: "recall the plan" }));
  await until(() => job(store, later.jobKey).status === "completed");
  assert.equal(job(store, later.jobKey).result, "Recalled: What is the plan?");
  const [, second] = await turns();
  assert.equal(second.sessionId, first.sessionId); assert.equal(second.resume, true);
  assert.equal(backend.starts.length, 1);
});

test("different conversations never share a Claude session or its history", async (t) => {
  const { worker, store, command, directory, conversation, turns } = await setup(t);
  const other = { ownerId: randomUUID(), conversationId: randomUUID() };
  await worker.handle(command("link", { cwd: directory, title: "Second topic" }, other));
  const first = await worker.handle(command("enqueue", { requestId: randomUUID(), assistant: "claude", text: "secret of the first" }));
  const second = await worker.handle(command("enqueue", { requestId: randomUUID(), assistant: "claude", text: "recall" }, other));
  await until(() => [first, second].every((r) => job(store, r.jobKey).status === "completed"));
  assert.notEqual(conversation().claudeSessionId, conversation(other).claudeSessionId);
  assert.equal(job(store, second.jobKey).result, "Recalled: nothing");
  const names = new Set((await turns()).map((turn) => turn.name));
  assert.deepEqual([...names].sort(), ["Duo Board — Second topic", "Duo Board — Weekend plans"]);
});

test("a restart resumes the saved Claude session and never replays an uncertain run", async (t) => {
  const { worker, store, command, directory, options, conversation, turns, route } = await setup(t);
  const first = await worker.handle(command("enqueue", { requestId: randomUUID(), assistant: "claude", text: "before restart" }));
  await until(() => job(store, first.jobKey).status === "completed");
  const sessionId = conversation().claudeSessionId;
  // Simulate a crash mid-turn: the saved job is running, but no process serves it.
  const lost = await worker.handle(command("enqueue", { requestId: randomUUID(), assistant: "claude", text: "hold uncertain" }));
  await until(() => job(store, lost.jobKey).status === "running");
  worker.running = false; clearInterval(worker.timer);
  const runtime = [...worker.active.values()][0];
  runtime.run.child.kill(); await runtime.done;
  await store.change((s) => { s.jobs[lost.jobKey].status = "running"; s.conversations[keyFor(route.ownerId, route.conversationId)].mode = "ready"; });
  const reopened = await new StateStore(directory).load();
  const restarted = new BackgroundWorker(reopened, options); await restarted.start(); t.after(() => restarted.close());
  await until(() => job(reopened, lost.jobKey).status === "attention");
  assert.match(job(reopened, lost.jobKey).error, /not been sent again/);
  assert.equal(reopened.snapshot().conversations[keyFor(route.ownerId, route.conversationId)].attention.claude, job(reopened, lost.jobKey).error);
  assert.equal((await turns()).filter((turn) => turn.prompt === "hold uncertain").length, 1);
  await restarted.handle(command("resume"));
  const next = await restarted.handle(command("enqueue", { requestId: randomUUID(), assistant: "claude", text: "recall" }));
  await until(() => job(reopened, next.jobKey).status === "completed");
  assert.equal(job(reopened, next.jobKey).result, "Recalled: before restart | hold uncertain");
  const last = (await turns()).at(-1);
  assert.equal(last.sessionId, sessionId); assert.equal(last.resume, true);
});

test("pause holds Claude work, idle sleep starts no process, and Wake resumes the same session", async (t) => {
  let now = Date.now();
  const { worker, store, command, conversation, turns } = await setup(t, { now: () => now });
  await worker.handle(command("hold"));
  const held = await worker.handle(command("enqueue", { requestId: randomUUID(), assistant: "claude", text: "while paused" }));
  await pause(200);
  assert.equal(job(store, held.jobKey).status, "queued"); assert.deepEqual(await turns(), []);
  await worker.handle(command("resume"));
  await until(() => job(store, held.jobKey).status === "completed" && worker.active.size === 0);
  const sessionId = conversation().claudeSessionId;
  now += IDLE_TIMEOUT_MS; worker.pump();
  await until(() => conversation().mode === "sleeping" && !worker.releasing && !worker.clients.claude);
  now += 60 * 60_000; worker.pump(); await pause(100);
  assert.equal((await turns()).length, 1);
  await worker.handle(command("resume"));
  assert.equal(conversation().mode, "ready");
  const after = await worker.handle(command("enqueue", { requestId: randomUUID(), assistant: "claude", text: "recall" }));
  await until(() => job(store, after.jobKey).status === "completed");
  assert.equal(job(store, after.jobKey).result, "Recalled: while paused");
  const last = (await turns()).at(-1);
  assert.equal(last.sessionId, sessionId); assert.equal(last.resume, true);
});

test("card Stop interrupts only Claude's answer; ChatGPT and later Claude questions continue", async (t) => {
  const { worker, store, command, conversation, turns } = await setup(t);
  const requestId = randomUUID();
  const chatgpt = await worker.handle(command("enqueue", { requestId, assistant: "chatgpt", text: "shared question" }));
  const claude = await worker.handle(command("enqueue", { requestId, assistant: "claude", text: "hold shared question" }));
  await until(() => job(store, claude.jobKey).status === "running");
  await worker.handle(command("cancel", { requestId, assistant: "claude" }));
  await until(() => job(store, claude.jobKey).status === "stopped" && job(store, chatgpt.jobKey).status === "completed");
  assert.equal(conversation().mode, "ready");
  const later = await worker.handle(command("enqueue", { requestId: randomUUID(), assistant: "claude", text: "recall" }));
  await until(() => job(store, later.jobKey).status === "completed");
  assert.equal(job(store, later.jobKey).result, "Recalled: hold shared question");
  assert.equal((await turns()).at(-1).resume, true);
});

test("one Claude session cannot be connected to two conversations", async (t) => {
  const { worker, command, directory, conversation } = await setup(t);
  await worker.ensureSessions(worker.store.snapshot().conversations[Object.keys(worker.store.snapshot().conversations)[0]].ownerId, conversation().conversationId);
  const taken = conversation().claudeSessionId;
  const other = { ownerId: randomUUID(), conversationId: randomUUID() };
  await assert.rejects(worker.handle(command("link", { cwd: directory, claudeSessionId: taken }, other)), /already linked to another conversation/);
  assert.equal(conversation(other), undefined);
  await assert.rejects(worker.handle(command("link", { cwd: directory, claudeSessionId: randomUUID() })), /cannot be silently replaced/);
  // Saved state that somehow names the same Claude session twice is refused rather than repaired.
  await worker.store.change((s) => { const [key] = Object.keys(s.conversations); const copy = structuredClone(s.conversations[key]); copy.conversationId = other.conversationId; copy.ownerId = other.ownerId; copy.threadId = null; s.conversations[keyFor(other.ownerId, other.conversationId)] = copy; });
  await assert.rejects(new StateStore(directory).load(), /Claude session is linked to multiple conversations/);
});

test("a Claude problem holds only Claude's lane; ChatGPT keeps answering and Wake clears it", async (t) => {
  const { worker, store, command, conversation } = await setup(t, { claudeEnv: { DUO_FAKE_CLAUDE_LOGGED_OUT: "1" } });
  const requestId = randomUUID();
  const claude = await worker.handle(command("enqueue", { requestId, assistant: "claude", text: "needs sign-in" }));
  const chatgpt = await worker.handle(command("enqueue", { requestId, assistant: "chatgpt", text: "still fine" }));
  await until(() => job(store, claude.jobKey).status === "attention" && job(store, chatgpt.jobKey).status === "completed");
  assert.match(job(store, claude.jobKey).error, /Sign in to Claude Code/);
  assert.equal(conversation().mode, "ready");
  assert.match(conversation().attention.claude, /Sign in/); assert.equal(conversation().attention.chatgpt, null);
  const again = await worker.handle(command("enqueue", { requestId: randomUUID(), assistant: "chatgpt", text: "another" }));
  await until(() => job(store, again.jobKey).status === "completed");
  const blocked = await worker.handle(command("enqueue", { requestId: randomUUID(), assistant: "claude", text: "waits" }));
  await pause(150); assert.equal(job(store, blocked.jobKey).status, "queued");
  await worker.handle(command("resume"));
  assert.deepEqual(conversation().attention, { chatgpt: null, claude: null });
});

test("a session whose first run never persisted is created under the same reserved ID, never a new one", async (t) => {
  const { worker, store, command, conversation, turns, home } = await setup(t);
  const first = await worker.handle(command("enqueue", { requestId: randomUUID(), assistant: "claude", text: "first" }));
  await until(() => job(store, first.jobKey).status === "completed");
  const sessionId = conversation().claudeSessionId;
  // Claude Code has no record of the session (it was interrupted before it saved anything).
  await unlink(path.join(home, "sessions", `${sessionId}.json`));
  const second = await worker.handle(command("enqueue", { requestId: randomUUID(), assistant: "claude", text: "second" }));
  await until(() => job(store, second.jobKey).status === "completed");
  const attempts = (await turns()).filter((turn) => turn.prompt === "second");
  assert.deepEqual(attempts.map((turn) => [turn.sessionId, turn.resume]), [[sessionId, true], [sessionId, false]]);
  assert.equal(conversation().claudeSessionId, sessionId);
});

test("a missing Claude session after a workspace move is preserved instead of silently recreated", async (t) => {
  const { worker, store, command, conversation, turns, home, route } = await setup(t);
  const first = await worker.handle(command("enqueue", { requestId: randomUUID(), assistant: "claude", text: "saved history" }));
  await until(() => job(store, first.jobKey).status === "completed");
  const sessionId = conversation().claudeSessionId;
  await store.change((s) => { s.conversations[keyFor(route.ownerId, route.conversationId)].workspaceMovedAt = new Date().toISOString(); });
  await unlink(path.join(home, "sessions", `${sessionId}.json`));
  const later = await worker.handle(command("enqueue", { requestId: randomUUID(), assistant: "claude", text: "after rename" }));
  await until(() => job(store, later.jobKey).status === "attention");
  assert.match(job(store, later.jobKey).error, /saved session has been preserved/);
  assert.deepEqual((await turns()).filter((turn) => turn.prompt === "after rename").map((turn) => [turn.sessionId, turn.resume]), [[sessionId, true]]);
  assert.equal(conversation().claudeSessionId, sessionId);
});

test("a helper without Claude Code manages ChatGPT only and refuses Claude work instead of guessing", async (t) => {
  const { worker, command } = await setup(t, { withClaude: false });
  assert.deepEqual(worker.managed, ["chatgpt"]);
  await assert.rejects(worker.handle(command("enqueue", { requestId: randomUUID(), assistant: "claude", text: "x" })), /does not manage Claude/);
  assert.deepEqual(await worker.ensureSessions(worker.store.snapshot().conversations[Object.keys(worker.store.snapshot().conversations)[0]].ownerId, Object.values(worker.store.snapshot().conversations)[0].conversationId), { chatgpt: Object.values(worker.store.snapshot().conversations)[0].threadId });
});

test("session names are derived from the conversation title and bounded", () => {
  const id = randomUUID();
  assert.equal(sessionName("Weekend plans", id), "Duo Board — Weekend plans");
  assert.equal(sessionName("  spaced\n\tout  ", id), "Duo Board — spaced out");
  assert.equal(sessionName(null, id), `Duo Board — ${id.slice(0, 8)}`);
  assert.equal(sessionName("x".repeat(200), id).length, "Duo Board — ".length + 80);
  assert.equal(jobKeyFor("c", "chatgpt", "r"), keyFor("c", "r"));
  assert.notEqual(jobKeyFor("c", "claude", "r"), keyFor("c", "r"));
});
