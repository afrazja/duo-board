import { db } from "./db";
import type { Assistant } from "./agent-auth";

/** Receipts contain identifiers and cleanup state only, never conversation content. */
export interface DeletionReceipt {
  thread_id: string; deleted_at: string;
  claude_cleaned_at: string | null; chatgpt_cleaned_at: string | null;
  claude_blocked: boolean; chatgpt_blocked: boolean;
}

export async function listDeletions(ownerId: string | null, who?: Assistant): Promise<DeletionReceipt[]> {
  let query = db().from("thread_deletions").select("*");
  query = ownerId ? query.eq("owner_id", ownerId) : query.is("owner_id", null);
  if (who) query = query.is(`${who}_cleaned_at`, null);
  const { data, error } = await query.order("deleted_at", { ascending: Boolean(who) }).limit(200);
  if (error) throw new Error("Removal status is temporarily unavailable");
  return (data ?? []) as DeletionReceipt[];
}

export async function acknowledgeDeletion(ownerId: string | null, who: Assistant, threadId: string, status: "complete" | "blocked"): Promise<DeletionReceipt> {
  const patch = status === "complete" ? { [`${who}_cleaned_at`]: new Date().toISOString(), [`${who}_blocked`]: false } : { [`${who}_blocked`]: true };
  let update = db().from("thread_deletions").update(patch).eq("thread_id", threadId).is(`${who}_cleaned_at`, null);
  update = ownerId ? update.eq("owner_id", ownerId) : update.is("owner_id", null);
  const { error } = await update;
  if (error) throw new Error("Could not record session cleanup");
  let receipt = db().from("thread_deletions").select("*").eq("thread_id", threadId);
  receipt = ownerId ? receipt.eq("owner_id", ownerId) : receipt.is("owner_id", null);
  const result = await receipt.single();
  if (result.error) throw new Error("No removal receipt exists for this conversation");
  return result.data as DeletionReceipt;
}
