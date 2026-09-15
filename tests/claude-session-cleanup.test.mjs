import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { projectKey, removeClaudeSession } from "../bridge/claude-session-cleanup.mjs";
import { ClaudeClient } from "../bridge/claude-client.mjs";
import { StateStore, keyFor, prepareDirectory } from "../bridge/storage.mjs";
import { BackgroundWorker } from "../bridge/worker.mjs";
import { RemoteConnection } from "../bridge/remote.mjs";
import { Backend } from "./fixtures/worker-backend.mjs";

const fixture = fileURLToPath(new URL("./fixtures/claude-cli.mjs", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 400; i++) { if (await predicate()) return; await pause(10); }
  assert.fail("Condition did not complete");
}
const exists = (file) => stat(file).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });

test("only the removed conversation's own session files leave the Claude Code projects directory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "duo-claude-projects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projects = path.join(root, "projects");
  const cwd = path.join(root, "workspaces", randomUUID());
  const conversation = { ownerId: randomUUID(), conversationId: path.basename(cwd), cwd, claudeSessionId: randomUUID(), claudeSessionStarted: true };
  const folder = path.join(projects, projectKey(path.resolve(cwd)));
  await mkdir(folder, { recursive: true });
  const own = path.join(folder, `${conversation.claudeSessionId}.jsonl`);
  const ownExtra = path.join(folder, conversation.claudeSessionId);
  const other = path.join(folder, `${randomUUID()}.jsonl`);
  const elsewhere = path.join(projects, "C--another-project", `${conversation.claudeSessionId}.jsonl`);
  await writeFile(own, "{}\n"); await mkdir(ownExtra); await writeFile(path.join(ownExtra, "tool.json"), "{}"); await writeFile(other, "{}\n");
  await mkdir(path.dirname(elsewhere)); await writeFile(elsewhere, "{}\n");
  assert.deepEqual(await removeClaudeSession({ projectsDirectory: projects, conversation }), { status: "deleted" });
  assert.equal(await exists(own), false); assert.equal(await exists(ownExtra), false);
  assert.equal(await readFile(other, "utf8"), "{}\n");
  // A same-named file under an unrelated project is not this conversation's session.
  assert.equal(await readFile(elsewhere, "utf8"), "{}\n");
  assert.deepEqual(await removeClaudeSession({ projectsDirectory: projects, conversation }), { status: "missing" });
  await rm(other);
  assert.deepEqual(await removeClaudeSession({ projectsDirectory: projects, conversation }), { status: "missing" });
  // Once the last session is gone the empty project folder goes too; a populated one stays.
  await mkdir(folder, { recursive: true }); await writeFile(own, "{}\n");
  assert.deepEqual(await removeClaudeSession({ projectsDirectory: projects, conversation }), { status: "deleted" });
  assert.equal(await exists(folder), false);
  assert.deepEqual(await removeClaudeSession({ projectsDirectory: path.join(root, "absent"), conversation }), { status: "missing" });
  assert.deepEqual(await removeClaudeSession({ projectsDirectory: projects, conversation: { ...conversation, claudeSessionId: null } }), { status: "none" });
  await assert.rejects(removeClaudeSession({ projectsDirectory: "relative/projects", conversation }), /unknown/);
  const notADirectory = path.join(root, "projects.txt");
  await writeFile(notADirectory, "not a directory");
  await assert.rejects(removeClaudeSession({ projectsDirectory: notADirectory, conversation }), /redirected/);
});

test("a project folder that ends with the conversation UUID is searched even if the key differs", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "duo-claude-projects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projects = path.join(root, "projects");
  const conversationId = randomUUID();
  const conversation = { ownerId: randomUUID(), conversationId, cwd: path.join(root, "somewhere", conversationId), claudeSessionId: randomUUID(), claudeSessionStarted: true };
  const folder = path.join(projects, `D--Other-Root-${conversationId}`);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, `${conversation.claudeSessionId}.jsonl`), "{}\n");
  await writeFile(path.join(folder, `${randomUUID()}.jsonl`), "{}\n");
  assert.deepEqual(await removeClaudeSession({ projectsDirectory: projects, conversation }), { status: "deleted" });
  assert.equal((await readdir(folder)).length, 1);
});

async function setup(t, { withClaude = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "duo-claude-removal-"));
  const home = path.join(root, "claude-home");
  await mkdir(home);
  const directory = await prepareDirectory(path.join(root, "state"));
  const workspaceRoot = path.join(root, "workspaces");
  await mkdir(workspaceRoot);
  const store = await new StateStore(directory).load();
  await store.change((s) => { s.workspaceRoot = workspaceRoot; s.remote = { events: {} }; });
  const backend = new Backend();
  const claudeFactory = () => new ClaudeClient({ executable: process.execPath, prefixArgs: [fixture], env: { ...process.env, DUO_FAKE_CLAUDE_HOME: home }, timeoutMs: 5000 });
  const worker = new BackgroundWorker(store, { clientFactory: () => backend.client(), clientFactories: withClaude ? { claude: claudeFactory } : {}, turnTimeoutMs: 2000 });
  await worker.start();
  t.after(async () => { await worker.close(); await rm(root, { recursive: true, force: true }); });
  const ownerId = randomUUID();
  const route = { ownerId, conversationId: randomUUID() };
  const cwd = path.join(workspaceRoot, route.conversationId);
  await mkdir(cwd);
  await worker.handle({ id: randomUUID(), type: "link", ...route, cwd });
  const remote = new RemoteConnection(worker, { ownerId, deviceId: randomUUID(), url: "https://example.test", token: `duo_helper_${"x".repeat(43)}` });
  const key = keyFor(ownerId, route.conversationId);
  const transcript = () => path.join(home, "projects", projectKey(path.resolve(cwd)), `${store.state.conversations[key].claudeSessionId}.jsonl`);
  return { root, home, store, worker, backend, remote, route, cwd, directory, key, transcript };
}

test("removing a conversation deletes its folder and its Claude session, once, and reports nothing afterwards", async (t) => {
  const f = await setup(t);
  const job = await f.worker.handle({ id: randomUUID(), type: "enqueue", ...f.route, assistant: "claude", requestId: randomUUID(), text: "remember me" });
  await until(() => f.store.state.jobs[job.jobKey].status === "completed" && f.worker.active.size === 0);
  assert.equal(await exists(f.transcript()), true);
  const otherSession = path.join(path.dirname(f.transcript()), `${randomUUID()}.jsonl`);
  await writeFile(otherSession, "{}\n");
  await f.remote.cleanupRemoved([f.route.conversationId]);
  await assert.rejects(stat(f.cwd), { code: "ENOENT" });
  assert.equal(await exists(f.transcript()), false);
  assert.equal(await exists(otherSession), true);
  const saved = f.store.state.conversations[f.key];
  assert.equal(saved.workspaceCleanup.status, "complete"); assert.equal(saved.claudeSessionCleanup.status, "complete");
  assert.deepEqual(f.remote.report(), []);
  // A replayed receipt after Claude Code has reused the folder must not delete anything new.
  await mkdir(path.dirname(f.transcript()), { recursive: true }); await writeFile(f.transcript(), "recreated\n");
  await f.remote.cleanupRemoved([f.route.conversationId]);
  assert.equal(await readFile(f.transcript(), "utf8"), "recreated\n");
  const restored = await new StateStore(f.directory).load();
  assert.equal(restored.state.conversations[f.key].claudeSessionCleanup.status, "complete");
});

test("a conversation whose Claude session never started needs no session cleanup; without Claude Code none is attempted", async (t) => {
  const f = await setup(t);
  await f.worker.ensureSessions(f.route.ownerId, f.route.conversationId);
  await f.remote.cleanupRemoved([f.route.conversationId]);
  assert.equal(f.store.state.conversations[f.key].workspaceCleanup.status, "complete");
  assert.equal(f.store.state.conversations[f.key].claudeSessionCleanup, undefined);
  assert.deepEqual(f.remote.report(), []);
  const g = await setup(t, { withClaude: false });
  await g.remote.cleanupRemoved([g.route.conversationId]);
  assert.equal(g.store.state.conversations[g.key].claudeSessionCleanup, undefined);
  assert.deepEqual(g.remote.report(), []);
});

test("a folder already removed by an older helper still gets its Claude session cleaned after upgrade, and a blocked session cleanup retries with backoff", async (t) => {
  const f = await setup(t);
  const job = await f.worker.handle({ id: randomUUID(), type: "enqueue", ...f.route, assistant: "claude", requestId: randomUUID(), text: "before upgrade" });
  await until(() => f.store.state.jobs[job.jobKey].status === "completed" && f.worker.active.size === 0);
  // State written by the folder-only helper: removed and folder complete, nothing recorded for the session.
  await rm(f.cwd, { recursive: true, force: true });
  await f.store.change((s) => { const c = s.conversations[f.key]; c.removedAt = new Date().toISOString(); c.workspaceCleanup = { status: "complete", completedAt: c.removedAt, error: null }; });
  assert.equal(f.remote.report().length, 1); // still reported, so the board resends its removal receipt
  f.remote.projectsDirectory = f.transcript(); // a file, not a directory: cleanup must refuse and retry later
  await f.remote.cleanupRemoved([f.route.conversationId]);
  assert.equal(f.store.state.conversations[f.key].claudeSessionCleanup.status, "blocked");
  assert.equal(await exists(f.transcript()), true);
  assert.deepEqual(f.remote.report(), []);
  f.remote.projectsDirectory = null;
  await f.store.change((s) => { s.conversations[f.key].claudeSessionCleanup.nextAttemptAt = 0; });
  assert.equal(f.remote.report().length, 1);
  await f.remote.cleanupRemoved([f.route.conversationId]);
  assert.equal(f.store.state.conversations[f.key].claudeSessionCleanup.status, "complete");
  assert.equal(await exists(f.transcript()), false);
  assert.deepEqual(f.remote.report(), []);
});
