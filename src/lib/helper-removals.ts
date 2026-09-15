import type { SupabaseClient } from "@supabase/supabase-js";

/** Read only permanent-removal receipts for workspaces this authenticated helper reports. */
export async function listRemovedHelperThreads(database: SupabaseClient, ownerId: string, threadIds: string[]): Promise<string[]> {
  if (!threadIds.length) return [];
  const { data, error } = await database.from("thread_deletions")
    .select("thread_id").eq("owner_id", ownerId).in("thread_id", threadIds).limit(200);
  if (error) throw new Error("Workspace removal status is temporarily unavailable");
  // Assistant-session cleanup is separate. Its cleaned_at flags must neither hide these
  // receipts from an offline helper nor be updated merely because a folder was removed.
  return (data ?? []).map((receipt: { thread_id: string }) => receipt.thread_id);
}
