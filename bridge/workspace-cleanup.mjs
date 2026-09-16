import { lstat, rm } from "node:fs/promises";
import { verifyConversationWorkspace } from "./workspaces.mjs";

/** Delete only the locally verified workspace of an explicitly removed conversation. */
export async function removeConversationWorkspace(options) {
  const target = await verifyConversationWorkspace(options);
  try { await lstat(target); }
  catch (error) { if (error.code === "ENOENT") return { status: "missing" }; throw error; }
  // Both legacy UUID and named directories are verified before this recursive removal.
  // Nested links are unlinked themselves; their external destinations are preserved.
  await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  return { status: "deleted" };
}
