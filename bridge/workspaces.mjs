import { lstat, mkdir, open, readFile, readdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { isId } from "./storage.mjs";

export const WORKSPACE_MARKER = ".duo-workspace.json";
const comparable = (value) => process.platform === "win32" ? value.toLowerCase() : value;
const samePath = (a, b) => comparable(a) === comparable(b);
const foldName = (value) => value.normalize("NFC").toLowerCase();
function contains(parent, child) {
  const relative = path.relative(comparable(parent), comparable(child));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** Produce a readable name that is valid on Windows, including reserved devices. */
export function sanitizeWorkspaceName(title) {
  let name = typeof title === "string" ? title.normalize("NFC") : "";
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, "-").replace(/\s+/gu, " ").trim();
  name = Array.from(name).slice(0, 100).join("").replace(/[. ]+$/u, "");
  if (!name || name === "." || name === "..") name = "Conversation";
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|clock\$|conin\$|conout\$)$/iu.test(name.split(".")[0].trimEnd())) name = `_${name}`;
  return name;
}

function validIdentity(conversation) {
  if (!isId(conversation?.ownerId) || !isId(conversation?.conversationId)) throw new Error("The conversation has no verified workspace identity.");
}

async function verifiedRoot(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) throw new Error("The helper workspace root must be an absolute path.");
  const root = path.resolve(workspaceRoot);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(root), root)) throw new Error("The helper workspace root is redirected; its folders need review.");
  return root;
}

async function infoOrMissing(target) {
  try { return await lstat(target); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function directChild(root, target) {
  return !samePath(root, target) && samePath(path.dirname(target), root);
}

async function checkOverlap(target, conversation, conversations) {
  for (const other of Object.values(conversations ?? {})) {
    if (other.ownerId === conversation.ownerId && other.conversationId === conversation.conversationId) continue;
    if (other.workspaceCleanup?.status === "complete") continue;
    for (const savedPath of [other.cwd, other.workspaceRename?.from, other.workspaceRename?.to]) {
      if (typeof savedPath !== "string" || !path.isAbsolute(savedPath)) continue;
      const otherPath = path.resolve(savedPath);
      const paths = [otherPath];
      try { paths.push(await realpath(otherPath)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (paths.some((candidate) => contains(target, candidate) || contains(candidate, target))) throw new Error("Another conversation shares this workspace; its folders need review.");
    }
  }
}

async function matchingMarker(target, conversation) {
  const marker = path.join(target, WORKSPACE_MARKER);
  const info = await infoOrMissing(marker);
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("The workspace ownership marker is redirected or invalid.");
  let saved;
  try { saved = JSON.parse(await readFile(marker, "utf8")); }
  catch { throw new Error("The workspace ownership marker cannot be verified."); }
  return saved?.version === 1 && saved.ownerId === conversation.ownerId && saved.conversationId === conversation.conversationId;
}

async function requireDirectory(target) {
  const info = await infoOrMissing(target);
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(target), target)) throw new Error("The conversation workspace is redirected or replaced; its folders need review.");
  return true;
}

/** Verify a saved workspace without changing it. Missing direct children are safe to report as missing. */
export async function verifyConversationWorkspace({ workspaceRoot, conversation, conversations }) {
  validIdentity(conversation);
  if (typeof conversation.cwd !== "string" || !path.isAbsolute(conversation.cwd)) throw new Error("The conversation has no verified helper workspace.");
  const root = await verifiedRoot(workspaceRoot);
  const target = path.resolve(conversation.cwd);
  if (!directChild(root, target)) throw new Error("Workspace changes are limited to a conversation folder directly inside the helper workspace root.");
  await checkOverlap(target, conversation, conversations);
  if (!await requireDirectory(target)) return target;
  const legacy = samePath(target, path.join(root, conversation.conversationId.toLowerCase()));
  if (!legacy && !await matchingMarker(target, conversation)) throw new Error("The folder does not have this conversation's workspace ownership marker.");
  // A present marker must agree even on a legacy UUID directory.
  if (legacy && await infoOrMissing(path.join(target, WORKSPACE_MARKER)) && !await matchingMarker(target, conversation)) throw new Error("The workspace ownership marker belongs to another conversation.");
  return target;
}

async function writeMarker(target, conversation) {
  const marker = path.join(target, WORKSPACE_MARKER);
  let handle;
  try { handle = await open(marker, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!await matchingMarker(target, conversation)) throw new Error("The workspace ownership marker belongs to another conversation.");
    return;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ version: 1, ownerId: conversation.ownerId, conversationId: conversation.conversationId }, null, 2)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
}

async function candidateWorkspace(root, conversation, conversations, { current, create } = {}) {
  const base = sanitizeWorkspaceName(conversation.title);
  const suffix = conversation.conversationId.toLowerCase().slice(0, 8);
  for (let attempt = 0; attempt < 1000; attempt++) {
    const name = attempt === 0 ? base : `${base} (${suffix}${attempt === 1 ? "" : `-${attempt}`})`;
    const target = path.join(root, name);
    const names = await readdir(root);
    const existingName = names.find((entry) => foldName(entry) === foldName(name));
    if (existingName) {
      const existing = path.join(root, existingName);
      if (current && samePath(existing, current)) return existing;
      // Creation can recover its own orphaned folder after a crash before state was saved.
      if (create) {
        try {
          if (await requireDirectory(existing) && await matchingMarker(existing, conversation)) {
            await checkOverlap(existing, conversation, conversations);
            return existing;
          }
        } catch { /* An occupied or unsafe folder is a collision, never something to adopt. */ }
      }
      continue;
    }
    try { await checkOverlap(target, conversation, conversations); }
    catch { continue; }
    // Saved paths reserve case-insensitive names even when the directory is currently absent.
    if (Object.values(conversations ?? {}).some((other) => other.workspaceCleanup?.status !== "complete" && (other.ownerId !== conversation.ownerId || other.conversationId !== conversation.conversationId) && [other.cwd, other.workspaceRename?.to].some((value) => typeof value === "string" && path.isAbsolute(value) && foldName(path.resolve(value)) === foldName(target)))) continue;
    if (!create) return target;
    try { await mkdir(target, { mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST") continue; throw error; }
    await writeMarker(target, conversation);
    return target;
  }
  throw new Error("A unique conversation workspace name could not be allocated.");
}

/** Create one named folder, never adopting an unmarked folder with the same title. */
export async function createConversationWorkspace({ workspaceRoot, ownerId, conversationId, title, conversations }) {
  const conversation = { ownerId, conversationId, title };
  validIdentity(conversation);
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) throw new Error("The helper workspace root must be an absolute path.");
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const root = await verifiedRoot(workspaceRoot);
  return candidateWorkspace(root, conversation, conversations, { create: true });
}

async function finishRename(store, conversationKey, conversation, from, to) {
  const snapshot = store.snapshot();
  const root = await verifiedRoot(snapshot.workspaceRoot);
  if (typeof from !== "string" || !path.isAbsolute(from) || typeof to !== "string" || !path.isAbsolute(to) || !directChild(root, path.resolve(from)) || !directChild(root, path.resolve(to)) || samePath(from, to)) throw new Error("The saved workspace rename is outside the helper workspace root or invalid.");
  if (!samePath(path.resolve(conversation.cwd), path.resolve(from))) throw new Error("The saved workspace rename no longer matches this conversation.");
  const sourceExists = await requireDirectory(from);
  const targetExists = await requireDirectory(to);
  if (sourceExists && targetExists) throw new Error("Both workspace rename folders exist; automatic recovery cannot choose between them.");
  if (!sourceExists && !targetExists) throw new Error("Both workspace rename folders are missing; automatic recovery needs review.");
  if (sourceExists) {
    await verifyConversationWorkspace({ workspaceRoot: root, conversation: { ...conversation, cwd: from }, conversations: snapshot.conversations });
    // Even legacy migrations write the identity before their journal, so recovery requires it.
    if (!await matchingMarker(from, conversation)) throw new Error("The workspace rename source has no matching ownership marker.");
    await checkOverlap(to, conversation, snapshot.conversations);
    const collision = (await readdir(root)).find((entry) => foldName(entry) === foldName(path.basename(to)));
    if (collision) throw new Error("The workspace rename destination is occupied.");
    // Both absolute paths have been verified as direct children of this unredirected root.
    await rename(from, to);
  }
  await verifyConversationWorkspace({ workspaceRoot: root, conversation: { ...conversation, cwd: to }, conversations: snapshot.conversations });
  if (!await matchingMarker(to, conversation)) throw new Error("The workspace rename destination has no matching ownership marker.");
  await store.change((s) => {
    const current = s.conversations[conversationKey];
    if (!current || current.workspaceRename?.from !== from || current.workspaceRename?.to !== to || current.cwd !== conversation.cwd) throw new Error("The conversation changed during its workspace rename.");
    current.cwd = to;
    current.workspaceMovedAt = new Date().toISOString();
    delete current.workspaceRename;
    delete current.workspaceNameError;
    delete current.workspaceNameRetryAt;
  });
  return { cwd: to, changed: true };
}

/** Rename only an idle helper-owned folder. The caller must pause dispatch and exclude active jobs. */
export async function renameConversationWorkspace(store, conversationKey) {
  const snapshot = store.snapshot();
  const conversation = snapshot.conversations[conversationKey];
  if (!conversation) throw new Error("The conversation workspace link does not exist.");
  validIdentity(conversation);
  if (conversation.workspaceRename) return finishRename(store, conversationKey, conversation, conversation.workspaceRename.from, conversation.workspaceRename.to);
  const unchanged = { cwd: conversation.cwd, changed: false };
  if (conversation.removedAt || typeof conversation.title !== "string" || !conversation.title.trim()) return unchanged;
  const root = await verifiedRoot(snapshot.workspaceRoot);
  if (typeof conversation.cwd !== "string" || !path.isAbsolute(conversation.cwd) || !directChild(root, path.resolve(conversation.cwd))) return unchanged;
  // Custom folders without the ownership marker are deliberately left in place.
  const from = path.resolve(conversation.cwd);
  if (!await requireDirectory(from)) return unchanged;
  const legacy = samePath(from, path.join(root, conversation.conversationId.toLowerCase()));
  if (!legacy && !await matchingMarker(from, conversation)) return unchanged;
  await verifyConversationWorkspace({ workspaceRoot: root, conversation, conversations: snapshot.conversations });
  const to = await candidateWorkspace(root, conversation, snapshot.conversations, { current: from });
  await writeMarker(from, conversation);
  if (samePath(from, to)) return unchanged;
  await store.change((s) => {
    const current = s.conversations[conversationKey];
    if (!current || current.cwd !== conversation.cwd || current.workspaceRename || current.removedAt || current.title !== conversation.title) throw new Error("The conversation changed before its workspace rename.");
    current.workspaceRename = { from, to };
  });
  return finishRename(store, conversationKey, conversation, from, to);
}
