"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

export function RemoveConversation({ conversation, onClose, onRemoved }: {
  conversation: { id: string; title: string };
  onClose: () => void;
  onRemoved: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  useEffect(() => {
    const el = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    el?.showModal();
    cancel.current?.focus();
    return () => { el?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);

  async function remove(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setRemoving(true);
    setError("");
    try {
      const response = await fetch("/api/threads", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: conversation.id, confirm_title: conversation.title }),
      });
      const data = await response.json() as { deleted?: boolean; thread_id?: string; error?: string };
      if (response.status !== 404 && (!response.ok || !data.deleted || data.thread_id !== conversation.id)) {
        throw new Error(data.error ?? "Could not remove this conversation. Try again.");
      }
      onRemoved(conversation.id);
    } catch (cause) {
      setError((cause as Error).message);
    } finally { inFlight.current = false; setRemoving(false); }
  }

  return <dialog ref={dialog} aria-labelledby="remove-title" aria-describedby="remove-warning" onCancel={(event) => { event.preventDefault(); if (!removing) onClose(); }} className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-sm overflow-y-auto rounded-2xl border border-rose-500/40 bg-zinc-900 p-5 text-zinc-100 shadow-2xl backdrop:bg-black/75 sm:p-6">
    <h2 id="remove-title" className="break-words text-lg font-semibold">Remove “{conversation.title}”?</h2>
    <p id="remove-warning" className="mt-3 text-[14px] leading-6 text-zinc-300">This is permanent and cannot be undone.</p>
    <form onSubmit={remove}>
      {error && <p role="alert" className="mt-3 text-[13px] leading-5 text-rose-300">{error}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-3">
        <button ref={cancel} type="button" disabled={removing} onClick={onClose} className="min-h-11 rounded-lg border border-zinc-600 px-4 text-[14px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">Cancel</button>
        <button type="submit" disabled={removing} className="min-h-11 rounded-lg bg-rose-600 px-4 text-[14px] font-semibold text-white hover:bg-rose-500 disabled:opacity-40">{removing ? "Removing…" : "OK"}</button>
      </div>
    </form>
  </dialog>;
}
