"use client";

import { useEffect, useState } from "react";
import type { DeletionReceipt } from "@/lib/deletions";

export function RemovalStatus({ recentId, onDismiss }: { recentId: string | null; onDismiss: () => void }) {
  const [receipts, setReceipts] = useState<DeletionReceipt[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const check = async () => {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch("/api/deletions", { signal: controller.signal });
        const data = await response.json() as { deletions?: DeletionReceipt[] };
        if (!response.ok || !Array.isArray(data.deletions)) throw new Error("Status unavailable");
        if (!controller.signal.aborted) { setReceipts(data.deletions); setError(false); }
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { busy = false; }
    };
    void check();
    const interval = setInterval(check, 5000);
    return () => { clearInterval(interval); controller.abort(); };
  }, [recentId]);
  const pending = receipts.filter((receipt) => !receipt.claude_cleaned_at || !receipt.chatgpt_cleaned_at);
  const recent = receipts.find((receipt) => receipt.thread_id === recentId);
  if (!pending.length && !recentId) return null;
  const complete = recent && recent.claude_cleaned_at && recent.chatgpt_cleaned_at;
  return <div role="status" aria-live="polite" className="shrink-0 border-b border-zinc-700 bg-zinc-900 px-4 py-2 text-[13px] leading-5 text-zinc-300">
    <div className="flex items-start justify-between gap-3">
      <p>{error ? "Session cleanup could not be checked. Completion is not confirmed." : pending.length ? `${pending.length} removed conversation${pending.length === 1 ? "" : "s"}: assistant session cleanup is pending.` : complete ? "Conversation and both assistant sessions permanently removed." : "Conversation removed permanently. Checking assistant session cleanup…"}</p>
      {!pending.length && <button type="button" aria-label="Dismiss removal status" onClick={onDismiss} className="rounded px-2 text-zinc-400 hover:text-white">✕</button>}
    </div>
    {pending.length > 0 && <details className="mt-1">
      <summary className="cursor-pointer text-indigo-300">Cleanup details</summary>
      <ul className="mt-2 max-h-32 space-y-2 overflow-y-auto">{pending.map((receipt) => <li key={receipt.thread_id}>
        <span className="text-zinc-500">Removed {new Date(receipt.deleted_at).toLocaleString()} · </span>
        {(["claude", "chatgpt"] as const).map((who, index) => <span key={who} className={receipt[`${who}_blocked`] ? "text-amber-300" : ""}>{index ? " · " : ""}{who === "claude" ? "Claude" : "ChatGPT"}: {receipt[`${who}_cleaned_at`] ? "deleted" : receipt[`${who}_blocked`] ? "cleanup needs attention" : "pending"}</span>)}
      </li>)}</ul>
    </details>}
  </div>;
}
