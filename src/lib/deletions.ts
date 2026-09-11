import { db } from "./db";
import type { Assistant, Owner } from "./agent-auth";
import { accountsReady, byOwner } from "./board";

/** Receipts contain identifiers and cleanup state only, never conversation content. */
export interface DeletionReceipt {
  thread_id: string; deleted_at: string;
  claude_cleaned_at: string | null; chatgpt_cleaned_at: string | null;
  claude_blocked: boolean; chatgpt_blocked: boolean;
}

export async function listDeletions(owner: Owner, who?: Assistant): Promise<DeletionReceipt[]> {
  let query = db().from("thread_deletions").select("*");
  if (await accountsReady()) query = byOwner(query, owner);
  if (who) query = query.is(`${who}_cleaned_at`, null);
  const { data, error } = await query.order("deleted_at", { ascending: Boolean(who) }).limit(200);
  if (error) throw new Error("Removal status is temporarily unavailable");
  return (data ?? []) as DeletionReceipt[];
}

export async function acknowledgeDeletion(owner: Owner, who: Assistant, threadId: string, status: "complete" | "blocked"): Promise<DeletionReceipt> {
  const scoped = await accountsReady();
  const patch = status === "complete" ? { [`${who}_cleaned_at`]: new Date().toISOString(), [`${who}_blocked`]: false } : { [`${who}_blocked`]: true };
  let update = db().from("thread_deletions").update(patch).eq("thread_id", threadId).is(`${who}_cleaned_at`, null);
  if (scoped) update = byOwner(update, owner);
  const { error } = await update;
  if (error) throw new Error("Could not record session cleanup");
  let read = db().from("thread_deletions").select("*").eq("thread_id", threadId);
  if (scoped) read = byOwner(read, owner);
  const result = await read.maybeSingle();
  if (result.error || !result.data) throw new Error("No removal receipt exists for this conversation");
  return result.data as DeletionReceipt;
}
