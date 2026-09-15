import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { isId } from "./storage.mjs";

const comparable = (value) => process.platform === "win32" ? value.toLowerCase() : value;
const samePath = (a, b) => comparable(a) === comparable(b);
function contains(parent, child) {
  const relative = path.relative(comparable(parent), comparable(child));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** Delete only the UUID workspace mapped locally to an explicitly removed conversation. */
export async function removeConversationWorkspace({ workspaceRoot, conversation, conversations }) {
  if (!isId(conversation?.ownerId) || !isId(conversation?.conversationId) ||
      typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot) ||
      typeof conversation.cwd !== "string" || !path.isAbsolute(conversation.cwd)) {
    throw new Error("The removed conversation has no verified helper workspace.");
  }
  const root = path.resolve(workspaceRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(await realpath(root), root)) {
    throw new Error("The helper workspace root is redirected; cleanup needs review.");
  }
  const target = path.resolve(conversation.cwd);
  const expected = path.join(root, conversation.conversationId.toLowerCase());
  if (!samePath(target, expected) || samePath(target, root) || !contains(root, target)) {
    throw new Error("Cleanup is limited to this conversation's UUID folder inside the helper workspace root.");
  }
  for (const other of Object.values(conversations ?? {})) {
    if (other.ownerId === conversation.ownerId && other.conversationId === conversation.conversationId) continue;
    if (typeof other.cwd !== "string" || !path.isAbsolute(other.cwd)) continue;
    const otherPath = path.resolve(other.cwd);
    // Preserve both the saved access path (which may contain a nested junction)
    // and its destination. Removing either can break another conversation.
    const otherPaths = [otherPath];
    try { otherPaths.push(await realpath(otherPath)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (otherPaths.some((candidate) => contains(target, candidate) || contains(candidate, target))) {
      throw new Error("Another conversation shares this workspace; cleanup needs review.");
    }
  }
  let info;
  try { info = await lstat(target); }
  catch (error) { if (error.code === "ENOENT") return { status: "missing" }; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(target), expected)) {
    throw new Error("The conversation workspace is redirected or replaced; cleanup needs review.");
  }
  // The resolved absolute target has been checked above. Node removes nested
  // symbolic links/junctions themselves rather than following their targets.
  await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  return { status: "deleted" };
}
