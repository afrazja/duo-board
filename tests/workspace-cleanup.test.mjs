import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeConversationWorkspace } from "../bridge/workspace-cleanup.mjs";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const OTHER_CONVERSATION = "22222222-2222-4222-8222-222222222222";

async function fixture(t) {
  const temporaryRoot = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, "duo-workspace-cleanup-"));
  const links = [];
  t.after(async () => {
    // Every fixture and link destination is within this freshly allocated temp folder.
    // Remove junctions explicitly before recursively cleaning the fixture on Windows.
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    assert.ok(path.basename(directory).startsWith("duo-workspace-cleanup-"));
    for (const link of links.reverse()) {
      try { await unlink(link); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const workspaceRoot = path.join(directory, "workspaces");
  await mkdir(workspaceRoot);
  const conversation = { ownerId: OWNER, conversationId: CONVERSATION, cwd: path.join(workspaceRoot, CONVERSATION) };
  const options = { workspaceRoot, conversation, conversations: { [`${OWNER}:${CONVERSATION}`]: { ...conversation } } };
  const file = async (folder, name = "keep.txt") => {
    await mkdir(folder, { recursive: true });
    const filename = path.join(folder, name);
    await writeFile(filename, "preserved content");
    return filename;
  };
  const linkDirectory = async (target, link) => {
    assert.ok(path.relative(directory, target) && !path.relative(directory, target).startsWith(".."));
    assert.ok(path.relative(directory, link) && !path.relative(directory, link).startsWith(".."));
    await symlink(path.resolve(target), link, process.platform === "win32" ? "junction" : "dir");
    links.push(link);
  };
  return { directory, workspaceRoot, conversation, options, file, linkDirectory };
}

async function assertPreserved(filename) {
  assert.equal(await readFile(filename, "utf8"), "preserved content");
}

test("removes an existing nonempty conversation folder without requiring a new marker", async (t) => {
  const f = await fixture(t);
  await f.file(f.conversation.cwd);
  await f.file(path.join(f.conversation.cwd, "nested"));
  const sibling = await f.file(path.join(f.workspaceRoot, OTHER_CONVERSATION));

  assert.deepEqual(await removeConversationWorkspace(f.options), { status: "deleted" });
  await assert.rejects(lstat(f.conversation.cwd), { code: "ENOENT" });
  await assertPreserved(sibling);
  assert.ok((await lstat(f.workspaceRoot)).isDirectory());
});

test("missing conversation folder is idempotent", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await removeConversationWorkspace(f.options), { status: "missing" });
  await f.file(f.conversation.cwd);
  assert.deepEqual(await removeConversationWorkspace(f.options), { status: "deleted" });
  assert.deepEqual(await removeConversationWorkspace(f.options), { status: "missing" });
});

for (const target of ["outside", "root", "different-conversation"]) {
  test(`refuses a saved folder pointing to ${target}`, async (t) => {
    const f = await fixture(t);
    const cwd = target === "outside" ? path.join(f.directory, "outside")
      : target === "root" ? f.workspaceRoot : path.join(f.workspaceRoot, OTHER_CONVERSATION);
    const sentinel = await f.file(cwd);
    await assert.rejects(removeConversationWorkspace({ ...f.options, conversation: { ...f.conversation, cwd } }));
    await assertPreserved(sentinel);
  });
}

test("refuses a non-UUID folder even when its saved path matches", async (t) => {
  const f = await fixture(t);
  const conversation = { ...f.conversation, conversationId: "not-a-conversation-uuid", cwd: path.join(f.workspaceRoot, "not-a-conversation-uuid") };
  const sentinel = await f.file(conversation.cwd);
  await assert.rejects(removeConversationWorkspace({ ...f.options, conversation }));
  await assertPreserved(sentinel);
});

test("refuses traversal in the conversation ID", async (t) => {
  const f = await fixture(t);
  const sentinel = await f.file(path.join(f.directory, "outside"));
  const conversation = { ...f.conversation, conversationId: "../outside", cwd: path.dirname(sentinel) };
  await assert.rejects(removeConversationWorkspace({ ...f.options, conversation }));
  await assertPreserved(sentinel);
});

test("refuses an invalid saved path even if that folder is missing", async (t) => {
  const f = await fixture(t);
  const cwd = path.join(f.directory, "missing-outside-folder");
  await assert.rejects(removeConversationWorkspace({ ...f.options, conversation: { ...f.conversation, cwd } }));
});

test("refuses a workspace root which is a symlink or junction", async (t) => {
  const f = await fixture(t);
  const sentinel = await f.file(f.conversation.cwd);
  const workspaceRoot = path.join(f.directory, "root-link");
  await f.linkDirectory(f.workspaceRoot, workspaceRoot);
  const conversation = { ...f.conversation, cwd: path.join(workspaceRoot, CONVERSATION) };
  await assert.rejects(removeConversationWorkspace({ ...f.options, workspaceRoot, conversation }));
  await assertPreserved(sentinel);
});

test("refuses a workspace root reached through a symlink or junction ancestor", async (t) => {
  const f = await fixture(t);
  const actualParent = path.join(f.directory, "actual-parent");
  const actualRoot = path.join(actualParent, "workspaces");
  const sentinel = await f.file(path.join(actualRoot, CONVERSATION));
  const linkedParent = path.join(f.directory, "linked-parent");
  await f.linkDirectory(actualParent, linkedParent);
  const workspaceRoot = path.join(linkedParent, "workspaces");
  const conversation = { ...f.conversation, cwd: path.join(workspaceRoot, CONVERSATION) };
  await assert.rejects(removeConversationWorkspace({ ...f.options, workspaceRoot, conversation }));
  await assertPreserved(sentinel);
});

test("refuses a conversation folder which is a symlink or junction", async (t) => {
  const f = await fixture(t);
  const external = path.join(f.directory, "external");
  const sentinel = await f.file(external);
  await f.linkDirectory(external, f.conversation.cwd);
  await assert.rejects(removeConversationWorkspace(f.options));
  await assertPreserved(sentinel);
});

test("unlinks a nested directory link without removing its external target", async (t) => {
  const f = await fixture(t);
  await f.file(f.conversation.cwd);
  const external = path.join(f.directory, "external");
  const sentinel = await f.file(external);
  await f.linkDirectory(external, path.join(f.conversation.cwd, "linked-directory"));

  assert.deepEqual(await removeConversationWorkspace(f.options), { status: "deleted" });
  await assert.rejects(lstat(f.conversation.cwd), { code: "ENOENT" });
  await assertPreserved(sentinel);
});

for (const overlap of ["shared", "descendant", "ancestor", "different-owner"]) {
  test(`refuses deletion when another mapped conversation has a ${overlap} folder`, async (t) => {
    const f = await fixture(t);
    const sentinel = await f.file(f.conversation.cwd);
    const other = {
      ownerId: overlap === "different-owner" ? OTHER_OWNER : OWNER,
      conversationId: overlap === "different-owner" ? CONVERSATION : OTHER_CONVERSATION,
      cwd: overlap === "descendant" ? path.join(f.conversation.cwd, "nested")
        : overlap === "ancestor" ? f.workspaceRoot : f.conversation.cwd,
    };
    const otherSentinel = await f.file(other.cwd, "other.txt");
    const conversations = { ...f.options.conversations, [`${other.ownerId}:${other.conversationId}`]: other };
    await assert.rejects(removeConversationWorkspace({ ...f.options, conversations }));
    await assertPreserved(sentinel);
    await assertPreserved(otherSentinel);
  });
}

test("preserves a nested junction used as another conversation's saved folder", async (t) => {
  const f = await fixture(t);
  const sentinel = await f.file(f.conversation.cwd);
  const external = path.join(f.directory, "external");
  const externalSentinel = await f.file(external);
  const linkedFolder = path.join(f.conversation.cwd, "other-conversation-link");
  await f.linkDirectory(external, linkedFolder);
  const other = { ownerId: OWNER, conversationId: OTHER_CONVERSATION, cwd: linkedFolder };
  const conversations = { ...f.options.conversations, [`${OWNER}:${OTHER_CONVERSATION}`]: other };

  await assert.rejects(removeConversationWorkspace({ ...f.options, conversations }));
  await assertPreserved(sentinel);
  await assertPreserved(externalSentinel);
  assert.ok((await lstat(linkedFolder)).isSymbolicLink());
  await assertPreserved(path.join(linkedFolder, "keep.txt"));
});

test("preserves another conversation's folder reached through an outside junction", async (t) => {
  const f = await fixture(t);
  const nestedFolder = path.join(f.conversation.cwd, "nested");
  const sentinel = await f.file(nestedFolder);
  const linkedFolder = path.join(f.directory, "other-conversation-link");
  await f.linkDirectory(nestedFolder, linkedFolder);
  const other = { ownerId: OWNER, conversationId: OTHER_CONVERSATION, cwd: linkedFolder };
  const conversations = { ...f.options.conversations, [`${OWNER}:${OTHER_CONVERSATION}`]: other };

  await assert.rejects(removeConversationWorkspace({ ...f.options, conversations }));
  await assertPreserved(sentinel);
  await assertPreserved(path.join(linkedFolder, "keep.txt"));
});

test("a sibling with a similar path prefix does not count as overlap", async (t) => {
  const f = await fixture(t);
  await f.file(f.conversation.cwd);
  const other = { ownerId: OWNER, conversationId: OTHER_CONVERSATION, cwd: `${f.conversation.cwd}-separate` };
  const sentinel = await f.file(other.cwd);
  const conversations = { ...f.options.conversations, [`OWNER:${OTHER_CONVERSATION}`]: other };
  assert.deepEqual(await removeConversationWorkspace({ ...f.options, conversations }), { status: "deleted" });
  await assertPreserved(sentinel);
});
