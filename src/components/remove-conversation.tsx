"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

export function RemoveConversation({ conversation, isLast, onClose, onRemoved }: {
  conversation: { id: string; title: string };
  isLast: boolean;
  onClose: () => void;
  onRemoved: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [confirmation, setConfirmation] = useState("");
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
    if (confirmation !== conversation.title || inFlight.current) return;
    inFlight.current = true;
    setRemoving(true);
    setError("");
    try {
      const response = await fetch("/api/threads", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: conversation.id, confirm_title: confirmation }),
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

  return <dialog ref={dialog} aria-labelledby="remove-title" aria-describedby="remove-warning" onCancel={(event) => { event.preventDefault(); if (!removing) onClose(); }} className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-rose-500/40 bg-zinc-900 p-5 text-zinc-100 shadow-2xl backdrop:bg-black/75 sm:p-6">
    <h2 id="remove-title" className="text-lg font-semibold">Remove conversation permanently?</h2>
    <p className="mt-2 break-words text-[15px] text-zinc-300">{conversation.title}</p>
    <div id="remove-warning" className="my-4 space-y-3 text-[14px] leading-6 text-zinc-300">
      <p>This deletes the conversation and all its messages. Both assistants must also stop their work and permanently delete their sessions and saved conversation history.</p>
      <p>Session cleanup can take longer if an assistant is offline. The board will show cleanup as pending until each assistant confirms it.</p>
      <p className="font-semibold text-rose-200">This cannot be undone. There is no recycle bin.</p>
      {isLast && <p className="text-zinc-400">An empty, new General conversation will open afterwards.</p>}
    </div>
    <form onSubmit={remove}>
      <label htmlFor="remove-confirmation" className="block text-[13px] font-medium">Type the conversation’s exact name to confirm</label>
      <input id="remove-confirmation" autoComplete="off" spellCheck={false} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={removing} className="mt-2 min-h-11 w-full rounded-lg border border-zinc-600 bg-zinc-950 px-3 text-[15px] outline-none focus:border-rose-400 disabled:opacity-50" />
      {error && <p role="alert" className="mt-3 text-[13px] leading-5 text-rose-300">{error}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-3">
        <button ref={cancel} type="button" disabled={removing} onClick={onClose} className="min-h-11 rounded-lg border border-zinc-600 px-4 text-[14px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">Cancel</button>
        <button type="submit" disabled={removing || confirmation !== conversation.title} className="min-h-11 rounded-lg bg-rose-600 px-4 text-[14px] font-semibold text-white hover:bg-rose-500 disabled:opacity-40">{removing ? "Removing…" : "Remove permanently"}</button>
      </div>
    </form>
  </dialog>;
}
