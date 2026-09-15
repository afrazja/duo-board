import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { isId } from "./storage.mjs";

/** Claude Code keys a project folder by its working directory with every non-alphanumeric character replaced by "-". */
export const projectKey = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");

const missingOk = (error) => { if (error.code === "ENOENT") return null; throw error; };

/**
 * Remove a removed conversation's Claude Code session from the projects
 * directory the CLI reports. Claude Code has no command for deleting a
 * foreground session, so only the files named by that session's own UUID are
 * removed, inside the project folder derived from the conversation's
 * workspace (or a project folder that ends with the conversation's UUID).
 * Other sessions, other projects and anything outside that directory stay.
 */
export async function removeClaudeSession({ projectsDirectory, conversation }) {
  if (!isId(conversation?.claudeSessionId) || !isId(conversation?.conversationId)) return { status: "none" };
  if (typeof projectsDirectory !== "string" || !path.isAbsolute(projectsDirectory) || typeof conversation.cwd !== "string" || !path.isAbsolute(conversation.cwd)) {
    throw new Error("The Claude Code projects directory or the conversation workspace is unknown.");
  }
  const root = path.resolve(projectsDirectory);
  const rootInfo = await lstat(root).catch(missingOk);
  if (!rootInfo) return { status: "missing" };
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("The Claude Code projects directory is redirected; cleanup needs review.");
  const sessionId = conversation.claudeSessionId.toLowerCase();
  const conversationId = conversation.conversationId.toLowerCase();
  const candidates = new Set([projectKey(path.resolve(conversation.cwd))]);
  for (const name of await readdir(root)) if (name.toLowerCase().endsWith(conversationId)) candidates.add(name);
  let removed = 0;
  for (const name of candidates) {
    const folder = path.join(root, name);
    if (path.dirname(folder) !== root || name === "." || name === "..") continue;
    const info = await lstat(folder).catch(missingOk);
    if (!info || !info.isDirectory() || info.isSymbolicLink()) continue;
    for (const entry of await readdir(folder)) {
      const lower = entry.toLowerCase();
      if (lower !== `${sessionId}.jsonl` && lower !== sessionId) continue;
      const target = path.join(folder, entry);
      const targetInfo = await lstat(target).catch(missingOk);
      if (!targetInfo) continue;
      if (targetInfo.isSymbolicLink()) throw new Error("The Claude session file is redirected; cleanup needs review.");
      await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      removed++;
    }
    // Claude Code recreates the folder if the workspace is ever used again; an empty one is just clutter.
    if (!(await readdir(folder)).length) await rmdir(folder).catch(() => {});
  }
  return { status: removed ? "deleted" : "missing" };
}
