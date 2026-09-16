import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { keyFor } from "../bridge/storage.mjs";
import { createConversationWorkspace, renameConversationWorkspace, sanitizeWorkspaceName, verifyConversationWorkspace, WORKSPACE_MARKER } from "../bridge/workspaces.mjs";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const THREAD = "33333333-3333-4333-8333-333333333333";
const CLAUDE = "44444444-4444-4444-8444-444444444444";
async function fixture(t) {
  const temporary = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(temporary, "duo-named-workspaces-"));
  const workspaceRoot = path.join(directory, "workspaces");
  await mkdir(workspaceRoot);
  const links = [];
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), temporary);
    assert.ok(path.basename(directory).startsWith("duo-named-workspaces-"));
    for (const link of links.reverse()) {
      try { await unlink(link); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const conversation = { ownerId: OWNER, conversationId: ID, title: "General", cwd: path.join(workspaceRoot, ID), threadId: THREAD, claudeSessionId: CLAUDE, claudeSessionStarted: true, mode: "paused" };
  const key = keyFor(OWNER, ID);
  const store = {
    state: { workspaceRoot, conversations: { [key]: structuredClone(conversation) }, jobs: { kept: { status: "completed" } } },
    snapshot() { return structuredClone(this.state); },
    async change(update) { const next = this.snapshot(); const result = update(next); this.state = next; return result; },
  };
  const options = (c = store.state.conversations[key]) => ({ workspaceRoot, conversation: c, conversations: store.state.conversations });
  const create = (overrides = {}) => createConversationWorkspace({ workspaceRoot, ownerId: OWNER, conversationId: ID, title: "General", conversations: store.state.conversations, ...overrides });
  const marker = async (folder, c = conversation) => writeFile(path.join(folder, WORKSPACE_MARKER), JSON.stringify({ version: 1, ownerId: c.ownerId, conversationId: c.conversationId }));
  const link = async (target, filename) => {
    assert.ok(path.resolve(target).startsWith(`${directory}${path.sep}`));
    assert.ok(path.resolve(filename).startsWith(`${directory}${path.sep}`));
    await symlink(path.resolve(target), filename, process.platform === "win32" ? "junction" : "dir");
    links.push(filename);
  };
  return { directory, workspaceRoot, conversation, key, store, options, create, marker, link };
}

test("names preserve readable Unicode and strip Windows-invalid characters", () => {
  assert.equal(sanitizeWorkspaceName("  Project / demo: <one>?*  "), "Project - demo- -one---");
  assert.equal(sanitizeWorkspaceName("گفتگوی من 🎉"), "گفتگوی من 🎉");
  assert.equal(sanitizeWorkspaceName("Cafe\u0301"), "Café");
  assert.equal(sanitizeWorkspaceName("hello. .  "), "hello");
  assert.equal(sanitizeWorkspaceName("..."), "Conversation");
  assert.equal(sanitizeWorkspaceName(""), "Conversation");
  assert.equal(sanitizeWorkspaceName(null), "Conversation");
  assert.equal(sanitizeWorkspaceName("foo\nbar"), "foo-bar");
  assert.equal(Array.from(sanitizeWorkspaceName("🎉".repeat(200))).length, 100);
});

test("Windows device names remain valid even with extensions or spaces before dots", () => {
  for (const name of ["CON", "con.txt", "CON .txt", "PRN", "AUX", "NUL", "COM1", "com9.log", "LPT1", "LPT9", "LPT¹.txt", "COM²", "CLOCK$", "CONIN$", "CONOUT$"]) assert.equal(sanitizeWorkspaceName(name), `_${name}`);
  assert.equal(sanitizeWorkspaceName("CONversation"), "CONversation");
  assert.equal(sanitizeWorkspaceName("com10"), "com10");
});

test("creates a named workspace with a matching ownership marker", async (t) => {
  const f = await fixture(t);
  const cwd = await f.create();
  assert.equal(cwd, path.join(f.workspaceRoot, "General"));
  assert.deepEqual(JSON.parse(await readFile(path.join(cwd, WORKSPACE_MARKER), "utf8")), { version: 1, ownerId: OWNER, conversationId: ID });
  assert.equal(await verifyConversationWorkspace(f.options({ ...f.conversation, cwd })), cwd);
});

test("creates a configured root when it does not exist", async (t) => {
  const f = await fixture(t);
  const workspaceRoot = path.join(f.directory, "new-root");
  const cwd = await f.create({ workspaceRoot });
  assert.equal(cwd, path.join(workspaceRoot, "General"));
  assert.ok((await lstat(cwd)).isDirectory());
});

test("duplicate titles get a stable short ID suffix without overwriting contents", async (t) => {
  const f = await fixture(t);
  const first = await f.create();
  await writeFile(path.join(first, "keep.txt"), "first conversation");
  f.store.state.conversations[f.key].cwd = first;
  const second = await f.create({ conversationId: OTHER_ID });
  assert.equal(path.basename(second), "General (22222222)");
  assert.equal(await readFile(path.join(first, "keep.txt"), "utf8"), "first conversation");
  assert.equal(await f.create({ conversationId: OTHER_ID }), second);
});

test("existing unmarked or foreign folders, including case variants, are never adopted", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.workspaceRoot, "gEnErAl"));
  await writeFile(path.join(f.workspaceRoot, "gEnErAl", "keep.txt"), "user content");
  const short = path.join(f.workspaceRoot, "General (11111111)");
  await mkdir(short);
  await f.marker(short, { ownerId: OTHER_OWNER, conversationId: ID });
  const cwd = await f.create();
  assert.equal(path.basename(cwd), "General (11111111-2)");
  assert.equal(await readFile(path.join(f.workspaceRoot, "gEnErAl", "keep.txt"), "utf8"), "user content");
});

test("a saved mapping reserves an absent folder case-insensitively", async (t) => {
  const f = await fixture(t);
  f.store.state.conversations.other = { ownerId: OTHER_OWNER, conversationId: OTHER_ID, cwd: path.join(f.workspaceRoot, "GENERAL") };
  assert.equal(path.basename(await f.create()), "General (11111111)");
});

test("completed cleanup frees its old name while a recreated user folder remains protected", async (t) => {
  const f = await fixture(t);
  const oldPath = path.join(f.workspaceRoot, "General");
  f.store.state.conversations.other = { ownerId: OTHER_OWNER, conversationId: OTHER_ID, cwd: oldPath, removedAt: new Date().toISOString(), workspaceCleanup: { status: "complete" } };
  const cwd = await f.create();
  assert.equal(cwd, oldPath);
  assert.equal(await verifyConversationWorkspace(f.options({ ...f.conversation, cwd })), cwd);
  // The completed record does not authorize adopting a later unrelated folder.
  await unlink(path.join(cwd, WORKSPACE_MARKER));
  await writeFile(path.join(cwd, "keep.txt"), "recreated user files");
  const next = await f.create({ conversationId: THREAD });
  assert.equal(path.basename(next), "General (33333333)");
  assert.equal(await readFile(path.join(cwd, "keep.txt"), "utf8"), "recreated user files");
});

test("creation recovers only its own marked folder after a state-save interruption", async (t) => {
  const f = await fixture(t);
  const cwd = await f.create();
  await writeFile(path.join(cwd, "work.txt"), "saved work");
  assert.equal(await f.create(), cwd);
  assert.equal(await readFile(path.join(cwd, "work.txt"), "utf8"), "saved work");
});

test("verification allows legacy UUID folders and missing direct children", async (t) => {
  const f = await fixture(t);
  assert.equal(await verifyConversationWorkspace(f.options()), f.conversation.cwd);
  await mkdir(f.conversation.cwd);
  assert.equal(await verifyConversationWorkspace(f.options()), f.conversation.cwd);
  await f.marker(f.conversation.cwd, { ownerId: OTHER_OWNER, conversationId: ID });
  await assert.rejects(verifyConversationWorkspace(f.options()), /marker/);
});

test("verification refuses unmarked, foreign and malformed named folders", async (t) => {
  const f = await fixture(t);
  const cwd = path.join(f.workspaceRoot, "General");
  await mkdir(cwd);
  const options = f.options({ ...f.conversation, cwd });
  await assert.rejects(verifyConversationWorkspace(options), /marker/);
  await f.marker(cwd, { ownerId: OTHER_OWNER, conversationId: ID });
  await assert.rejects(verifyConversationWorkspace(options), /marker/);
  await writeFile(path.join(cwd, WORKSPACE_MARKER), "broken JSON");
  await assert.rejects(verifyConversationWorkspace(options), /marker/);
});

test("legacy migration preserves files, Codex links, Claude links and job history", async (t) => {
  const f = await fixture(t);
  await mkdir(f.conversation.cwd);
  await writeFile(path.join(f.conversation.cwd, "work.txt"), "keep my work");
  const result = await renameConversationWorkspace(f.store, f.key);
  assert.deepEqual(result, { cwd: path.join(f.workspaceRoot, "General"), changed: true });
  await assert.rejects(lstat(f.conversation.cwd), { code: "ENOENT" });
  assert.equal(await readFile(path.join(result.cwd, "work.txt"), "utf8"), "keep my work");
  const c = f.store.state.conversations[f.key];
  assert.equal(c.cwd, result.cwd);
  assert.equal(c.threadId, THREAD);
  assert.equal(c.claudeSessionId, CLAUDE);
  assert.equal(c.claudeSessionStarted, true);
  assert.deepEqual(f.store.state.jobs, { kept: { status: "completed" } });
  assert.equal(c.workspaceRename, undefined);
  assert.ok(Number.isFinite(Date.parse(c.workspaceMovedAt)));
  assert.deepEqual(await renameConversationWorkspace(f.store, f.key), { cwd: result.cwd, changed: false });
});

test("a title change renames a marked workspace and collision keeps both conversations", async (t) => {
  const f = await fixture(t);
  const cwd = await f.create();
  f.store.state.conversations[f.key].cwd = cwd;
  f.store.state.conversations[f.key].title = "My plans";
  await mkdir(path.join(f.workspaceRoot, "My plans"));
  const result = await renameConversationWorkspace(f.store, f.key);
  assert.equal(path.basename(result.cwd), "My plans (11111111)");
  assert.ok((await lstat(path.join(f.workspaceRoot, "My plans"))).isDirectory());
});

test("journal is durable before moving and recovers an interrupted state update", async (t) => {
  const f = await fixture(t);
  await mkdir(f.conversation.cwd);
  await writeFile(path.join(f.conversation.cwd, "work.txt"), "recover me");
  const change = f.store.change.bind(f.store);
  let changes = 0;
  f.store.change = async (update) => {
    if (++changes === 2) throw new Error("simulated power interruption before state commit");
    return change(update);
  };
  await assert.rejects(renameConversationWorkspace(f.store, f.key), /interruption/);
  const journal = f.store.state.conversations[f.key].workspaceRename;
  assert.deepEqual(journal, { from: f.conversation.cwd, to: path.join(f.workspaceRoot, "General") });
  await assert.rejects(lstat(journal.from), { code: "ENOENT" });
  assert.equal(await readFile(path.join(journal.to, "work.txt"), "utf8"), "recover me");
  f.store.change = change;
  // Even a deletion arriving during the interruption must settle the saved move.
  f.store.state.conversations[f.key].removedAt = new Date().toISOString();
  const result = await renameConversationWorkspace(f.store, f.key);
  assert.deepEqual(result, { cwd: journal.to, changed: true });
  assert.equal(f.store.state.conversations[f.key].workspaceRename, undefined);
  assert.ok(f.store.state.conversations[f.key].workspaceMovedAt);
});

test("a pre-move journal resumes from a marked source", async (t) => {
  const f = await fixture(t);
  await mkdir(f.conversation.cwd);
  await f.marker(f.conversation.cwd);
  const to = path.join(f.workspaceRoot, "General");
  f.store.state.conversations[f.key].workspaceRename = { from: f.conversation.cwd, to };
  assert.deepEqual(await renameConversationWorkspace(f.store, f.key), { cwd: to, changed: true });
});

test("journal recovery refuses both-present, both-missing and unmarked destinations", async (t) => {
  const f = await fixture(t);
  const from = f.conversation.cwd;
  const to = path.join(f.workspaceRoot, "General");
  f.store.state.conversations[f.key].workspaceRename = { from, to };
  await assert.rejects(renameConversationWorkspace(f.store, f.key), /Both.*missing/);
  await mkdir(from); await f.marker(from);
  await mkdir(to); await f.marker(to);
  await assert.rejects(renameConversationWorkspace(f.store, f.key), /Both.*exist/);
  await rm(from, { recursive: true }); // Explicitly checked fixture root child.
  await unlink(path.join(to, WORKSPACE_MARKER));
  await assert.rejects(renameConversationWorkspace(f.store, f.key), /marker/);
});

test("custom folders, removed conversations and untitled conversations are not renamed", async (t) => {
  const f = await fixture(t);
  const custom = path.join(f.workspaceRoot, "Custom project");
  await mkdir(custom);
  f.store.state.conversations[f.key].cwd = custom;
  assert.deepEqual(await renameConversationWorkspace(f.store, f.key), { cwd: custom, changed: false });
  const external = path.join(f.directory, "external");
  await mkdir(external);
  f.store.state.conversations[f.key].cwd = external;
  assert.deepEqual(await renameConversationWorkspace(f.store, f.key), { cwd: external, changed: false });
  f.store.state.conversations[f.key].cwd = f.conversation.cwd;
  await mkdir(f.conversation.cwd);
  f.store.state.conversations[f.key].removedAt = new Date().toISOString();
  assert.equal((await renameConversationWorkspace(f.store, f.key)).changed, false);
  delete f.store.state.conversations[f.key].removedAt;
  f.store.state.conversations[f.key].title = " ";
  assert.equal((await renameConversationWorkspace(f.store, f.key)).changed, false);
  assert.ok((await lstat(f.conversation.cwd)).isDirectory());
});

test("verification and migration reject linked workspace roots and linked folders", async (t) => {
  const f = await fixture(t);
  const external = path.join(f.directory, "external");
  await mkdir(external);
  await f.link(external, f.conversation.cwd);
  await assert.rejects(verifyConversationWorkspace(f.options()), /redirected/);
  await assert.rejects(renameConversationWorkspace(f.store, f.key), /redirected/);
  const rootLink = path.join(f.directory, "root-link");
  await f.link(f.workspaceRoot, rootLink);
  await assert.rejects(f.create({ workspaceRoot: rootLink }), /redirected/);
});

test("verification rejects shared lexical paths and another conversation's linked path", async (t) => {
  const f = await fixture(t);
  await mkdir(f.conversation.cwd);
  const child = path.join(f.conversation.cwd, "nested");
  await mkdir(child);
  f.store.state.conversations.other = { ownerId: OTHER_OWNER, conversationId: OTHER_ID, cwd: child };
  await assert.rejects(verifyConversationWorkspace(f.options()), /shares/);
  await assert.rejects(renameConversationWorkspace(f.store, f.key), /shares/);
  const linked = path.join(f.directory, "linked");
  await f.link(child, linked);
  f.store.state.conversations.other.cwd = linked;
  await assert.rejects(verifyConversationWorkspace(f.options()), /shares/);
});

test("journal recovery rejects out-of-root and shared destinations", async (t) => {
  const f = await fixture(t);
  await mkdir(f.conversation.cwd); await f.marker(f.conversation.cwd);
  f.store.state.conversations[f.key].workspaceRename = { from: f.conversation.cwd, to: path.join(f.directory, "outside") };
  await assert.rejects(renameConversationWorkspace(f.store, f.key), /outside/);
  const to = path.join(f.workspaceRoot, "General");
  f.store.state.conversations[f.key].workspaceRename.to = to;
  f.store.state.conversations.other = { ownerId: OTHER_OWNER, conversationId: OTHER_ID, cwd: path.join(to, "nested") };
  await assert.rejects(renameConversationWorkspace(f.store, f.key), /shares/);
  assert.ok((await lstat(f.conversation.cwd)).isDirectory());
});

test("legacy folders with foreign or malformed ownership markers cannot migrate", async (t) => {
  const f = await fixture(t);
  await mkdir(f.conversation.cwd);
  await f.marker(f.conversation.cwd, { ownerId: OTHER_OWNER, conversationId: ID });
  await assert.rejects(renameConversationWorkspace(f.store, f.key), /marker/);
  await writeFile(path.join(f.conversation.cwd, WORKSPACE_MARKER), "not JSON");
  await assert.rejects(renameConversationWorkspace(f.store, f.key), /marker/);
  assert.ok((await lstat(f.conversation.cwd)).isDirectory());
});
