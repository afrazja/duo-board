"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { AssistantStatus, Audience, ThreadSummary } from "@/lib/board";

import { Body } from "@/components/message-body";
import { RoundReplies } from "@/components/round-replies";
import { ControlPopover } from "@/components/control-popover";
import { RemoveConversation } from "@/components/remove-conversation";
import { AccountMenu } from "@/components/account-menu";
import { useHelper } from "@/components/helper-controls";
import { helperManages, type HelperAssistant, type HelperView } from "@/lib/helper-view";
import { groupRows, mergeMessages, roundState, type BoardMessage } from "@/components/round-model";
import { DictationResultTracker, type DictationResultLike } from "@/lib/dictation-results";

// One conversation, two columns. The person's messages span both; each
// assistant's replies land in its own column, grouped under the message they
// answer. The page polls the server every few seconds; the assistants read
// and write through the MCP server or the HTTP mirror.

const POLL_MS = 3000;
const NAME: Record<string, string> = { user: "You", claude: "Claude", chatgpt: "ChatGPT" };

type ConnectionState = "connected" | "sleeping" | "disconnected";
const CONNECTION_DOT: Record<ConnectionState, string> = {
  connected: "bg-emerald-400 shadow-[0_0_0_2px_rgba(52,211,153,0.15)]",
  sleeping: "bg-amber-400 shadow-[0_0_0_2px_rgba(251,191,36,0.15)]",
  disconnected: "bg-rose-500 shadow-[0_0_0_2px_rgba(244,63,94,0.15)]",
};

function connectionState(
  assistant: HelperAssistant,
  helper: HelperView | null,
  helperError: string,
  status: AssistantStatus | undefined,
  paused: boolean,
  now: number,
): ConnectionState {
  if (helperManages(helper, assistant)) {
    if (helperError || !helper?.connected || !helper.conversation || helper.conversation.mode === "attention") return "disconnected";
    if (paused || helper.conversation.mode === "sleeping" || helper.conversation.mode === "paused") return "sleeping";
    return "connected";
  }
  const checked = status?.last_checked_at ? Date.parse(status.last_checked_at) : NaN;
  return Number.isFinite(checked) && now - checked < 15_000 ? "connected" : "disconnected";
}

function ConnectionDot({ assistant, state }: { assistant: HelperAssistant; state: ConnectionState }) {
  const label = state[0].toUpperCase() + state.slice(1);
  return <span aria-hidden title={`${NAME[assistant]}: ${label}`} className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${CONNECTION_DOT[state]}`} />;
}

function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Dictation uses the browser's own speech recognition (Chrome, Edge, Safari).
// There is no server side to it: the browser turns speech into text and the
// text lands in the draft like typing would.
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<DictationResultLike> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function speechCtor(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const LANG_KEY = "duo_dictation_lang";
const LANGS: [string, string][] = [
  ["", "Browser language"],
  ["en-US", "English"],
  ["fa-IR", "فارسی"],
];

// The chosen language lives in localStorage, read as an external store so the
// server render (no storage) and the browser agree without an effect.
const langListeners = new Set<() => void>();
function readLang(): string {
  try {
    return localStorage.getItem(LANG_KEY) ?? "";
  } catch {
    return "";
  }
}
function writeLang(value: string) {
  try {
    localStorage.setItem(LANG_KEY, value);
  } catch {}
  langListeners.forEach((fn) => fn());
}
function subscribeLang(fn: () => void) {
  langListeners.add(fn);
  return () => {
    langListeners.delete(fn);
  };
}

function joinText(a: string, b: string): string {
  const left = a.trimEnd();
  const right = b.trim();
  if (!right) return a;
  return left ? `${left} ${right}` : right;
}

/**
 * Press to talk, press again to stop. Final phrases are appended to the draft
 * through onFinal; the phrase still being recognised is exposed as interim so
 * the page can show it without putting it in the textarea yet.
 */
function useDictation(onFinal: (text: string) => void) {
  const supported = useSyncExternalStore(
    () => () => {},
    () => speechCtor() !== null,
    () => false
  );
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [problem, setProblem] = useState("");
  const lang = useSyncExternalStore(subscribeLang, readLang, () => "");
  const rec = useRef<Recognition | null>(null);
  const wanted = useRef(false);
  const resultTracker = useRef(new DictationResultTracker());
  const restartTimer = useRef<number | null>(null);

  const stop = useCallback(() => {
    wanted.current = false;
    if (restartTimer.current !== null) window.clearTimeout(restartTimer.current);
    restartTimer.current = null;
    rec.current?.stop();
    rec.current = null;
    resultTracker.current.reset();
    setListening(false);
    setInterim("");
  }, []);

  const start = useCallback(() => {
    const Ctor = speechCtor();
    if (!Ctor) return;
    resultTracker.current.reset();
    const begin = () => {
      if (!wanted.current) return;
      const r = new Ctor();
      r.lang = lang || navigator.language;
      r.continuous = true;
      r.interimResults = true;
      r.onresult = (e) => {
        const update = resultTracker.current.consume(e.resultIndex, e.results);
        if (update.final) onFinal(update.final);
        setInterim(update.interim);
      };
      r.onerror = (e) => {
        // Silence and network hiccups are routine; a denied microphone is not.
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          setProblem("Microphone access was blocked. Allow it in the browser's site settings.");
          wanted.current = false;
          setListening(false);
        } else if (e.error !== "no-speech" && e.error !== "aborted") {
          setProblem(`Dictation error: ${e.error}`);
        }
      };
      r.onend = () => {
        if (rec.current !== r) return;
        rec.current = null;
        setInterim("");
        if (wanted.current) {
          // Android browsers frequently end recognition after a short pause.
          // A fresh object avoids carrying the old result list into the resume.
          resultTracker.current.resume();
          restartTimer.current = window.setTimeout(() => {
            restartTimer.current = null;
            begin();
          }, 200);
          return;
        }
        setListening(false);
      };
      rec.current = r;
      try {
        r.start();
      } catch {
        rec.current = null;
        wanted.current = false;
        setListening(false);
        setProblem("Dictation could not resume. Tap the microphone to try again.");
      }
    };
    wanted.current = true;
    setProblem("");
    setListening(true);
    begin();
  }, [lang, onFinal]);

  useEffect(() => () => stop(), [stop]);

  return { supported, listening, interim, problem, lang, setLang: writeLang, stop, toggle: () => (listening ? stop() : start()) };
}

function AudienceBadge({ to }: { to: Audience }) {
  const label = to === "both" ? "to both" : to === "none" ? "note" : `to ${NAME[to]}`;
  return <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[12px] text-zinc-400">{label}</span>;
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </svg>
  );
}

export default function BoardPage() {
  const router = useRouter();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const helper = useHelper(activeId);
  const [messages, setMessages] = useState<BoardMessage[]>([]);
  const [assistants, setAssistants] = useState<AssistantStatus[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState("");
  const [audience, setAudience] = useState<Audience>("both");
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [renameError, setRenameError] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [savingAnswerMode, setSavingAnswerMode] = useState(false);
  const [answerModeError, setAnswerModeError] = useState("");
  const [savingPause, setSavingPause] = useState(false);
  const [pauseError, setPauseError] = useState("");
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [newRepliesBelow, setNewRepliesBelow] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; title: string } | null>(null);
  const removedIds = useRef(new Set<string>());
  const [comparing, setComparing] = useState<string[]>([]);
  const [stoppingTasks, setStoppingTasks] = useState<string[]>([]);
  const [compareErrors, setCompareErrors] = useState<Record<string, string>>({});
  const compareRequests = useRef(new Set<string>());
  const stopRequests = useRef(new Set<string>());
  const loaded = useRef<{ threadId: string | null; messages: BoardMessage[] }>({ threadId: null, messages: [] });
  const answerModeSaveVersion = useRef(0);
  const pauseSaveVersion = useRef(0);
  const lastSeq = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const followingLatest = useRef(true);
  const appendToDraft = useCallback((text: string) => setDraft((prev) => joinText(prev, text)), []);
  const dictation = useDictation(appendToDraft);
  const stopDictation = dictation.stop;

  const acceptMessages = useCallback((threadId: string, incoming: BoardMessage[]) => {
    if (loaded.current.threadId !== threadId) return;
    const next = mergeMessages(loaded.current.messages, incoming);
    loaded.current.messages = next;
    setMessages(next);
  }, []);

  const loadThreads = useCallback(async () => {
    try {
    const res = await fetch("/api/threads");
    if (res.status === 401) {
      router.replace("/login");
      return;
    }
    const data = (await res.json()) as { threads?: ThreadSummary[]; error?: string };
    if (!res.ok || data.error || !Array.isArray(data.threads)) throw new Error(data.error ?? "Could not load conversations. Refresh to retry.");
    let list = (data.threads ?? []).filter((thread) => !removedIds.current.has(thread.id));
    if (list.length === 0) {
      const made = await fetch("/api/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "General" }) });
      const t = (await made.json()) as { thread?: ThreadSummary; error?: string };
      if (!made.ok || !t.thread) throw new Error(t.error ?? "Could not start a new conversation. Refresh to retry.");
      list = [t.thread];
    }
    setThreads(list);
    setActiveId((cur) => list.some((thread) => thread.id === cur) ? cur : list[0]?.id ?? null);
    } catch (cause) { setError((cause as Error).message); }
  }, [router]);

  useEffect(() => {
    void loadThreads();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [loadThreads]);

  // Reset and poll when the thread changes.
  useEffect(() => {
    if (!activeId) return;
    let stopped = false;
    let polling = false;
    lastSeq.current = 0;
    loaded.current = { threadId: activeId, messages: [] };
    followingLatest.current = true;
    setAwayFromLatest(false);
    setNewRepliesBelow(false);
    setMessages([]);
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const answerVersionAtPoll = answerModeSaveVersion.current;
        const pauseVersionAtPoll = pauseSaveVersion.current;
        const res = await fetch(`/api/messages?thread=${activeId}&after=${lastSeq.current}`);
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        const data = (await res.json()) as { messages?: BoardMessage[]; assistants?: AssistantStatus[]; error?: string; missing?: boolean; now?: string; brief_audio?: boolean; blind_first_round?: boolean; paused?: boolean };
        if (stopped) return;
        if (data.missing) {
          stopped = true;
          removedIds.current.add(activeId);
          loaded.current = { threadId: null, messages: [] };
          stopDictation();
          setMessages([]);
          setDraft("");
          setActiveId(null);
          setRemoveTarget(null);
          void loadThreads();
          return;
        }
        if (data.error) {
          setError(data.error);
          return;
        }
        setError("");
        if (data.assistants) setAssistants(data.assistants);
        if (data.messages && data.messages.length) {
          acceptMessages(activeId, data.messages);
          lastSeq.current = Math.max(lastSeq.current, ...data.messages.map((message) => message.seq));
        }
        if (typeof data.blind_first_round === "boolean" && answerVersionAtPoll % 2 === 0 && answerVersionAtPoll === answerModeSaveVersion.current) {
          setThreads((prev) => prev.map((thread) => thread.id === activeId && thread.blind_first_round !== data.blind_first_round ? { ...thread, blind_first_round: data.blind_first_round! } : thread));
        }
        if (typeof data.paused === "boolean" && pauseVersionAtPoll % 2 === 0 && pauseVersionAtPoll === pauseSaveVersion.current) {
          setThreads((prev) => prev.map((thread) => thread.id === activeId && thread.paused !== data.paused ? { ...thread, paused: data.paused! } : thread));
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally { polling = false; }
    };
    void poll();
    const t = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [activeId, acceptMessages, loadThreads, stopDictation, router]);

  // Follow new messages only while the reader is already at the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (followingLatest.current) el.scrollTop = el.scrollHeight;
    else if (messages.length) setNewRepliesBelow(true);
  }, [messages.length]);

  function trackReadingPosition() {
    const el = scroller.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    followingLatest.current = nearBottom;
    setAwayFromLatest(!nearBottom);
    if (nearBottom) setNewRepliesBelow(false);
  }

  function jumpToLatest() {
    followingLatest.current = true;
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    setAwayFromLatest(false);
    setNewRepliesBelow(false);
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (answerModeSaveVersion.current % 2 !== 0) return;
    const body = draft.trim();
    if (!body || !activeId || sending) return;
    const threadId = activeId;
    stopDictation();
    setSending(true);
    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: activeId, body, addressed_to: audience }),
      });
      const data = (await res.json()) as { message?: BoardMessage; error?: string };
      if (data.message) {
        acceptMessages(threadId, [data.message]);
        // Only polling advances its cursor: a simultaneous assistant reply
        // can precede this POST response and must still be fetched.
        if (loaded.current.threadId === threadId) setDraft("");
      } else setError(data.error ?? "Could not send");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function compareAnswers(question: BoardMessage) {
    if (threads.find((thread) => thread.id === question.thread_id)?.paused || savingPause) return;
    if (compareRequests.current.has(question.id)) return;
    compareRequests.current.add(question.id);
    setComparing((current) => [...current, question.id]);
    setCompareErrors((current) => ({ ...current, [question.id]: "" }));
    try {
      const res = await fetch("/api/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: question.thread_id, kind: "compare", reply_to: question.id, addressed_to: "both", body: "Compare your answers to the linked question. Each give one short follow-up: what you agree with, what you challenge and why, and what changed your mind. If you still agree, say so; do not invent disagreement." }),
      });
      const data = await res.json() as { message?: BoardMessage; error?: string };
      if (!res.ok || !data.message) throw new Error(data.error ?? "Could not request a comparison.");
      acceptMessages(question.thread_id, [data.message]);
      void helper.refresh();
    } catch (e) {
      setCompareErrors((current) => ({ ...current, [question.id]: (e as Error).message }));
    } finally {
      compareRequests.current.delete(question.id);
      setComparing((current) => current.filter((id) => id !== question.id));
    }
  }

  // Stop one assistant's answer to one question; the other assistant and later questions continue.
  async function stopTask(question: BoardMessage, who: "claude" | "chatgpt") {
    const key = `${who}:${question.id}`;
    if (stopRequests.current.has(key)) return;
    stopRequests.current.add(key);
    setStoppingTasks((current) => [...current, key]);
    setError("");
    try {
      const res = await fetch("/api/messages", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: question.thread_id, message_id: question.id, assistant: who }),
      });
      const data = await res.json() as { message?: BoardMessage; error?: string };
      if (!res.ok || !data.message) throw new Error(data.error ?? "Could not stop this task");
      acceptMessages(question.thread_id, [data.message]);
      void helper.refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      stopRequests.current.delete(key);
      setStoppingTasks((current) => current.filter((id) => id !== key));
    }
  }

  async function createThread(e: FormEvent) {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    const res = await fetch("/api/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
    const data = (await res.json()) as { thread?: ThreadSummary; error?: string };
    if (data.thread) {
      setThreads((prev) => [data.thread!, ...prev]);
      setActiveId(data.thread.id);
      setNewTitle("");
      setCreating(false);
      setNavOpen(false);
    } else setError(data.error ?? "Could not create conversation");
  }

  function pickThread(id: string) {
    setAnswerModeError("");
    setPauseError("");
    setRenaming(false);
    setRenameError("");
    setActiveId(id);
    setNavOpen(false);
  }

  async function renameConversation(e: FormEvent) {
    e.preventDefault();
    const title = renameTitle.trim();
    if (!activeId || !title || savingTitle) return;
    const threadId = activeId;
    if (threads.find((thread) => thread.id === threadId)?.title === title) { setRenaming(false); return; }
    setSavingTitle(true);
    setRenameError("");
    try {
      const res = await fetch("/api/threads", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ thread_id: threadId, title }) });
      const data = await res.json() as { thread?: { id: string; title: string }; error?: string };
      if (!res.ok || !data.thread?.title) throw new Error(data.error ?? "Could not rename this conversation");
      setThreads((current) => current.map((thread) => thread.id === threadId ? { ...thread, title: data.thread!.title } : thread));
      setRenaming(false);
    } catch (cause) {
      if (loaded.current.threadId === threadId) setRenameError((cause as Error).message);
    } finally {
      setSavingTitle(false);
    }
  }

  const rows = groupRows(messages);
  async function changeAnswerMode(blind: boolean) {
    if (!activeId || answerModeSaveVersion.current % 2 !== 0) return;
    const threadId = activeId;
    answerModeSaveVersion.current += 1;
    setSavingAnswerMode(true);
    setAnswerModeError("");
    try {
      const res = await fetch("/api/threads", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ thread_id: threadId, blind_first_round: blind }) });
      const data = await res.json() as { thread?: { blind_first_round: boolean }; error?: string };
      if (!res.ok || typeof data.thread?.blind_first_round !== "boolean") throw new Error(data.error ?? "Could not save answer mode");
      setThreads((prev) => prev.map((thread) => thread.id === threadId ? { ...thread, blind_first_round: data.thread!.blind_first_round } : thread));
    } catch (e) { if (loaded.current.threadId === threadId) setAnswerModeError((e as Error).message); }
    finally { answerModeSaveVersion.current += 1; setSavingAnswerMode(false); }
  }

  function conversationRemoved(id: string) {
    removedIds.current.add(id);
    stopDictation();
    // Reject any in-flight response for the removed conversation immediately.
    loaded.current = { threadId: null, messages: [] };
    setMessages([]);
    setDraft("");
    setRenaming(false);
    setRenameError("");
    setActiveId(null);
    setThreads((current) => current.filter((thread) => thread.id !== id));
    setRemoveTarget(null);
    setError("");
    void loadThreads();
  }

  async function changePaused(paused: boolean) {
    if (!activeId || pauseSaveVersion.current % 2 !== 0) return;
    const threadId = activeId;
    pauseSaveVersion.current += 1;
    setSavingPause(true);
    setPauseError("");
    try {
      const res = await fetch("/api/threads", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ thread_id: threadId, paused }) });
      const data = await res.json() as { thread?: { paused: boolean }; error?: string };
      if (!res.ok || typeof data.thread?.paused !== "boolean") throw new Error(data.error ?? "Could not save conversation status");
      setThreads((prev) => prev.map((thread) => thread.id === threadId ? { ...thread, paused: data.thread!.paused } : thread));
    } catch (e) { if (loaded.current.threadId === threadId) setPauseError((e as Error).message); }
    finally { pauseSaveVersion.current += 1; setSavingPause(false); }
  }

  const active = threads.find((t) => t.id === activeId);
  const connectionStates: Record<HelperAssistant, ConnectionState> = {
    claude: connectionState("claude", helper.view, helper.error, assistants.find((item) => item.name === "claude"), Boolean(active?.paused), now),
    chatgpt: connectionState("chatgpt", helper.view, helper.error, assistants.find((item) => item.name === "chatgpt"), Boolean(active?.paused), now),
  };

  return (
    <div className="flex h-dvh overflow-hidden">
      {removeTarget && <RemoveConversation key={removeTarget.id} conversation={removeTarget} onClose={() => setRemoveTarget(null)} onRemoved={conversationRemoved} />}
      {navOpen && <button type="button" aria-label="Close conversations" onClick={() => setNavOpen(false)} className="fixed inset-0 z-10 bg-black/60 lg:hidden" />}
      <aside
        className={`fixed inset-y-0 left-0 z-20 flex w-72 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900 transition-transform lg:static lg:z-auto lg:translate-x-0 lg:bg-zinc-900/60 ${navOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <span className="text-[15px] font-semibold">Duo Board</span>
          <button type="button" onClick={() => setNavOpen(false)} className="text-zinc-500 hover:text-zinc-200 lg:hidden" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="p-2">
          {creating ? (
            <form onSubmit={createThread} className="space-y-2">
              <input
                autoFocus
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setCreating(false);
                }}
                placeholder="Name it, e.g. Website redesign"
                aria-label="Conversation name"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-[14px] outline-none focus:border-indigo-500"
              />
              <div className="flex gap-2">
                <button type="submit" disabled={!newTitle.trim()} className="flex-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
                  Create
                </button>
                <button type="button" onClick={() => setCreating(false)} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-[13px] text-zinc-400 hover:text-zinc-200">
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-700 px-3 py-2 text-[14px] text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
            >
              <span className="text-lg leading-none" aria-hidden>+</span> New conversation
            </button>
          )}
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          <p className="px-3 pb-1 pt-2 text-[11px] uppercase tracking-wide text-zinc-600">Conversations</p>
          {threads.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => pickThread(t.id)}
              className={`mb-1 block w-full rounded-lg px-3 py-2 text-left ${t.id === activeId ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/60"}`}
            >
              <span className="block truncate text-[14.5px]">{t.title}</span>
              {t.paused && <span className="text-[11px] font-medium text-amber-300">Paused · </span>}
              <span className="text-[12px] text-zinc-500">
                {t.message_count} {t.message_count === 1 ? "message" : "messages"}
                {t.last_message_at ? ` · ${ago(t.last_message_at, now)}` : ""}
              </span>
            </button>
          ))}
        </nav>
        <div className="shrink-0 border-t border-zinc-800 p-3">
          <AccountMenu threadId={activeId} />
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header aria-label="This conversation" className="relative z-20 flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900/50 px-2 py-2 sm:px-3 lg:gap-3 lg:px-5 lg:py-3">
          <button type="button" onClick={() => setNavOpen(true)} className="min-h-9 rounded-lg border border-zinc-700 px-2.5 text-zinc-300 lg:hidden" aria-label="Open conversations">☰</button>
          <div className="min-w-24 flex-1">
            {renaming && active ? <form onSubmit={renameConversation} className="flex max-w-xl items-center gap-2">
              <input autoFocus value={renameTitle} onChange={(e) => setRenameTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { setRenaming(false); setRenameError(""); } }} maxLength={120} aria-label="Conversation name" className="min-h-10 min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-[14px] outline-none focus:border-indigo-500" />
              <button type="submit" aria-label="Save conversation name" disabled={!renameTitle.trim() || savingTitle} className="min-h-10 rounded-lg bg-indigo-600 px-3 text-[13px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"><span className="sm:hidden">✓</span><span className="hidden sm:inline">{savingTitle ? "Saving…" : "Save"}</span></button>
              <button type="button" aria-label="Cancel renaming" disabled={savingTitle} onClick={() => { setRenaming(false); setRenameError(""); }} className="min-h-10 rounded-lg border border-zinc-700 px-3 text-[13px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"><span className="sm:hidden">✕</span><span className="hidden sm:inline">Cancel</span></button>
            </form> : <h1 className="truncate text-[16px] font-semibold">{active?.title ?? "…"}</h1>}
            <p className="mt-1 hidden text-[12px] text-zinc-400 lg:block"><span className={active?.paused ? "text-amber-300" : "text-emerald-300"}>{active?.paused ? "Paused" : "Active"}</span> · {active?.blind_first_round === false ? "Live" : "Separate"}</p>
          </div>
          <div role="group" aria-label="Conversation controls" className="ml-auto hidden items-center gap-2 lg:flex">
            <button type="button" disabled={!active || renaming} onClick={() => { if (active) { setRenameTitle(active.title); setRenameError(""); setRenaming(true); } }} className="min-h-10 rounded-lg border border-zinc-700 px-3 py-2 text-[13px] font-medium text-zinc-300 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 disabled:opacity-50">Rename</button>
            <button type="button" disabled={!activeId || savingPause} onClick={() => void changePaused(!active?.paused)} aria-label={active?.paused ? "Resume conversation" : "Pause conversation"} className={`min-h-10 rounded-lg border px-3 py-2 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 disabled:opacity-50 ${active?.paused ? "border-amber-400 bg-amber-400 text-zinc-950 hover:bg-amber-300" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}>
              {savingPause ? "Saving…" : active?.paused ? "Resume conversation" : "Pause conversation"}
            </button>
            <button type="button" disabled={!active} onClick={() => active && setRemoveTarget({ id: active.id, title: active.title })} className="min-h-10 rounded-lg border border-rose-500/60 px-3 py-2 text-[13px] font-medium text-rose-300 hover:border-rose-400 hover:bg-rose-500/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400 disabled:opacity-40">Remove</button>
          </div>
          <ControlPopover label="Conversation actions" trigger="⋯" closeOnAction buttonClass="min-h-9 min-w-10 px-2 text-lg lg:hidden" panelClass="space-y-2">
            <div role="group" aria-label="Conversation actions" className="space-y-2">
              <button type="button" disabled={!active || renaming} onClick={() => { if (active) { setRenameTitle(active.title); setRenameError(""); setRenaming(true); } }} className="min-h-11 w-full rounded-lg border border-zinc-700 px-3 text-left text-[14px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">Rename</button>
              <button type="button" disabled={!activeId || savingPause} onClick={() => void changePaused(!active?.paused)} className="min-h-11 w-full rounded-lg border border-zinc-700 px-3 text-left text-[14px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">{savingPause ? "Saving…" : active?.paused ? "Resume conversation" : "Pause conversation"}</button>
              <button type="button" disabled={!active} onClick={() => active && setRemoveTarget({ id: active.id, title: active.title })} className="min-h-11 w-full rounded-lg border border-rose-500/60 px-3 text-left text-[14px] text-rose-300 hover:bg-rose-500/10 disabled:opacity-40">Remove</button>
            </div>
          </ControlPopover>
          {error && <p role="alert" className="w-full text-[12px] text-rose-300">{error}</p>}
          {renameError && <p role="alert" className="w-full text-[12px] text-rose-300">{renameError}</p>}
          {pauseError && <p role="alert" className="w-full text-[12px] text-rose-300">{pauseError} Try again.</p>}
        </header>

        {active?.paused && <div role="status" className="shrink-0 border-b border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-[12px] leading-5 text-amber-200 lg:px-4 lg:py-2 lg:text-[13px]">Conversation paused. Messages wait here until you resume.</div>}

        <div className="relative min-h-0 flex-1">
          <div ref={scroller} onScroll={trackReadingPosition} aria-label="Conversation messages" className="h-full overflow-y-auto px-2 py-3 sm:px-3 lg:px-5 lg:py-4">
            {rows.length === 0 && <p className="py-16 text-center text-[15px] text-zinc-400">Start a conversation below. Choose who you want to answer.</p>}
            {rows.map((row) => (
              <section key={row.key} className="mb-4 lg:mb-7">
                {row.user && (
                  <div className="mb-3 rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 sm:p-4">
                    <div className="mb-2 flex items-center justify-between gap-2 text-[12px] text-zinc-400">
                      <span className="flex items-center gap-2"><span className="font-semibold text-indigo-300">You</span><AudienceBadge to={row.user.addressed_to} /></span>
                      <span>{clock(row.user.created_at)}</span>
                    </div>
                    <Body text={row.user.body} />
                  </div>
                )}
                <RoundReplies row={row} state={roundState(row, rows, now)} assistants={assistants} now={now} helper={helper.view} onWake={()=>void helper.wake()} waking={helper.waking} paused={active?.paused} stopping={stoppingTasks} onStop={(question, who) => void stopTask(question, who)} currentBlind={active?.blind_first_round} comparing={comparing.includes(row.key) || savingPause} compareError={compareErrors[row.key]} onCompare={(question) => void compareAnswers(question)} />
              </section>
            ))}
          </div>
          {awayFromLatest && <button type="button" onClick={jumpToLatest} className="absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-indigo-400/60 bg-indigo-950 px-4 py-2 text-[13px] font-medium text-indigo-100 shadow-lg focus-visible:outline-2 focus-visible:outline-indigo-400">{newRepliesBelow ? "New replies · Jump to latest ↓" : "Jump to latest ↓"}</button>}
        </div>

        <form aria-label="Write a message" onSubmit={send} className="shrink-0 border-t border-zinc-700 bg-zinc-900/50 p-2 sm:p-3 lg:p-4">
          <div className="mb-1.5 flex items-center gap-2 overflow-x-auto">
            <div role="group" aria-label="Message audience" className="flex shrink-0 items-center gap-2">
              <span className="hidden text-[12px] font-medium text-zinc-400 sm:inline">To</span>
              <select value={audience} onChange={(event) => setAudience(event.target.value as Audience)} aria-label="Message audience" className="min-h-9 rounded-lg border border-zinc-700 bg-zinc-950 px-2 text-[13px] text-zinc-200 outline-none focus:border-indigo-500 sm:hidden">
                <option value="both">Both</option>
                <option value="claude">Claude</option>
                <option value="chatgpt">ChatGPT</option>
                <option value="none">Note</option>
              </select>
              <div className="hidden rounded-lg border border-zinc-700 bg-zinc-950 p-0.5 sm:flex">
                {(["both", "claude", "chatgpt", "none"] as Audience[]).map((a) => {
                  const assistant = a === "claude" || a === "chatgpt" ? a : null;
                  const state = assistant ? connectionStates[assistant] : null;
                  return <button key={a} type="button" aria-label={assistant && state ? `${NAME[assistant]}, ${state}` : undefined} aria-pressed={audience === a} onClick={() => setAudience(a)} className={`flex min-h-10 items-center gap-2 rounded-md px-2.5 text-[13px] focus-visible:outline-2 focus-visible:outline-indigo-400 sm:px-3 ${audience === a ? "bg-indigo-500/20 font-medium text-indigo-200 ring-1 ring-indigo-500/50" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"}`}>
                    {assistant && state && <ConnectionDot assistant={assistant} state={state} />}
                    {a === "both" ? "Both" : a === "none" ? "Note" : NAME[a]}
                  </button>;
                })}
              </div>
              <div className="flex items-center gap-2 px-1 sm:hidden" aria-label="Assistant status">
                {(["claude", "chatgpt"] as HelperAssistant[]).map((assistant) => <span key={assistant} role="status" aria-label={`${NAME[assistant]}, ${connectionStates[assistant]}`}><ConnectionDot assistant={assistant} state={connectionStates[assistant]} /></span>)}
              </div>
            </div>
            <div role="group" aria-label="Answer delivery" className="ml-auto flex shrink-0 items-center gap-2">
              <label htmlFor="answer-mode" className="hidden text-[12px] font-medium text-zinc-400 lg:block">Answers</label>
              <select id="answer-mode" aria-label="Answer mode" title="Saved for new questions in this conversation. Existing questions keep their original mode." value={active?.blind_first_round === false ? "live" : "separate"} disabled={!activeId || savingAnswerMode || sending} onChange={(e) => void changeAnswerMode(e.target.value === "separate")} className="min-h-9 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-[13px] text-zinc-200 focus-visible:outline-indigo-400 disabled:opacity-50">
                <option value="live">Live</option>
                <option value="separate">Separate</option>
              </select>
              <ControlPopover label="Answer mode help" trigger="?" above buttonClass="min-h-9 px-2.5">
                <h2 className="mb-2 text-[14px] font-semibold">How answers arrive</h2>
                <p className="text-[13px] leading-6 text-zinc-300"><strong>Live:</strong> show answers as they arrive. Assistants can see earlier replies.</p>
                <p className="mt-2 text-[13px] leading-6 text-zinc-300"><strong>Separate:</strong> for questions to Both, each answers before seeing the other’s reply; reveal both together.</p>
                <p className="mt-3 text-[12px] text-zinc-400">Saved for new questions in this conversation. Existing questions keep their original mode.</p>
              </ControlPopover>
            </div>
          </div>
          {savingAnswerMode && <p role="status" className="mb-1 text-[12px] text-zinc-400">Saving answer mode…</p>}
          {answerModeError && <p role="alert" className="mb-1 text-[12px] text-rose-300">{answerModeError} Check the selected mode or try again.</p>}
          <div className="relative">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void send(); }}
              rows={1}
              placeholder={dictation.listening ? "Listening… speak, or keep typing" : "Write a message…"}
              aria-label="Message"
              className={`field-sizing-content block max-h-32 min-h-12 w-full resize-none rounded-xl border bg-zinc-950 py-2.5 pl-3 pr-32 text-[15px] leading-6 outline-none focus:border-indigo-500 lg:max-h-40 lg:min-h-20 lg:resize-y lg:pr-[21rem] ${dictation.listening ? "border-rose-600" : "border-zinc-700"}`}
            />
            <div role="group" aria-label="Message actions" className="absolute bottom-1.5 right-1.5 flex items-center gap-1">
              {dictation.supported && <>
                <button type="button" onClick={dictation.toggle} aria-pressed={dictation.listening} aria-label={dictation.listening ? "Stop dictation" : "Dictate"} className={`flex min-h-9 items-center gap-2 rounded-lg border px-2 text-[13px] focus-visible:outline-2 focus-visible:outline-indigo-400 lg:px-3 ${dictation.listening ? "border-rose-500 bg-rose-600/20 text-rose-300" : "border-zinc-700 text-zinc-300 hover:border-zinc-500"}`}>
                  <MicIcon /><span className="hidden lg:inline">{dictation.listening ? "Stop dictation" : "Dictate"}</span>
                </button>
                <ControlPopover label="Dictation settings" trigger="⌄" above buttonClass="min-h-9 px-2.5">
                  <label className="block text-[13px] font-medium text-zinc-200">Dictation language
                    <select value={dictation.lang} onChange={(e) => dictation.setLang(e.target.value)} disabled={dictation.listening} aria-label="Dictation language" className="mt-2 min-h-10 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-[13px] text-zinc-200 disabled:opacity-50">
                      {LANGS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                    </select>
                  </label>
                </ControlPopover>
              </>}
              <span className="mx-2 hidden text-[12px] text-zinc-500 lg:inline">Ctrl+Enter to send</span>
              <button type="submit" aria-label={sending ? "Sending message" : active?.paused ? "Queue message" : "Send message"} disabled={sending || savingAnswerMode || !draft.trim()} className="flex min-h-9 min-w-9 items-center justify-center rounded-lg bg-indigo-500 px-2 text-[14px] font-semibold text-white hover:bg-indigo-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-300 disabled:opacity-40 lg:px-5">
                <span className="lg:hidden"><SendIcon /></span><span className="hidden lg:inline">{sending ? "Sending…" : active?.paused ? "Queue message" : "Send"}</span>
              </button>
            </div>
          </div>
          {dictation.interim && <p className="mt-1 text-[14px] italic text-zinc-400">{dictation.interim}…</p>}
          {dictation.problem && <p role="alert" className="mt-1 text-[12px] text-rose-300">{dictation.problem}</p>}
        </form>
      </main>
    </div>
  );
}
