"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { AssistantStatus, Audience, ThreadSummary } from "@/lib/board";
import { useVoicePlayback, VoiceToolbar } from "@/components/voice-playback";

import { Body } from "@/components/message-body";
import { RoundReplies } from "@/components/round-replies";
import { ControlPopover } from "@/components/control-popover";
import { RemoveConversation } from "@/components/remove-conversation";
import { AccountMenu } from "@/components/account-menu";
import { groupRows, mergeMessages, playableMessages, roundState, type BoardMessage } from "@/components/round-model";

// One conversation, two columns. The person's messages span both; each
// assistant's replies land in its own column, grouped under the message they
// answer. The page polls the server every few seconds; the assistants read
// and write through the MCP server or the HTTP mirror.

const POLL_MS = 3000;
const NAME: Record<string, string> = { user: "You", claude: "Claude", chatgpt: "ChatGPT" };

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
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
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

  const stop = useCallback(() => {
    wanted.current = false;
    rec.current?.stop();
    rec.current = null;
    setListening(false);
    setInterim("");
  }, []);

  const start = useCallback(() => {
    const Ctor = speechCtor();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = lang || navigator.language;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let pending = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) onFinal(res[0].transcript);
        else pending += res[0].transcript;
      }
      setInterim(pending);
    };
    r.onerror = (e) => {
      // Silence and network hiccups are routine; a denied microphone is not.
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setProblem("Microphone access was blocked. Allow it in the browser's site settings.");
        wanted.current = false;
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        setProblem(`Dictation error: ${e.error}`);
      }
    };
    r.onend = () => {
      // Browsers end a session after a pause; keep going until the person stops it.
      if (wanted.current) {
        try {
          r.start();
          return;
        } catch {}
      }
      rec.current = null;
      setListening(false);
      setInterim("");
    };
    rec.current = r;
    wanted.current = true;
    setProblem("");
    setListening(true);
    r.start();
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

export default function BoardPage() {
  const router = useRouter();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BoardMessage[]>([]);
  const [assistants, setAssistants] = useState<AssistantStatus[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState("");
  const [audience, setAudience] = useState<Audience>("both");
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [savingBrief, setSavingBrief] = useState(false);
  const [savingAnswerMode, setSavingAnswerMode] = useState(false);
  const [answerModeError, setAnswerModeError] = useState("");
  const [savingPause, setSavingPause] = useState(false);
  const [pauseError, setPauseError] = useState("");
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [newRepliesBelow, setNewRepliesBelow] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; title: string } | null>(null);
  const removedIds = useRef(new Set<string>());
  const [comparing, setComparing] = useState<string[]>([]);
  const [compareErrors, setCompareErrors] = useState<Record<string, string>>({});
  const compareRequests = useRef(new Set<string>());
  const loaded = useRef<{ threadId: string | null; messages: BoardMessage[] }>({ threadId: null, messages: [] });
  const briefSaveVersion = useRef(0);
  const answerModeSaveVersion = useRef(0);
  const pauseSaveVersion = useRef(0);
  const lastSeq = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const followingLatest = useRef(true);
  const appendToDraft = useCallback((text: string) => setDraft((prev) => joinText(prev, text)), []);
  const dictation = useDictation(appendToDraft);
  const stopDictation = dictation.stop;
  const briefAudio = threads.find((thread) => thread.id === activeId)?.brief_audio ?? false;
  const playback = useVoicePlayback(activeId, dictation.listening, briefAudio);
  const speechPlayer = playback.player;

  const acceptMessages = useCallback((threadId: string, incoming: BoardMessage[], serverNow?: string) => {
    if (loaded.current.threadId !== threadId) return;
    const next = mergeMessages(loaded.current.messages, incoming);
    loaded.current.messages = next;
    // Unrevealed text never enters the audio queue. Previously held answers
    // become eligible together when the second assistant's answer arrives.
    speechPlayer.ingest(playableMessages(groupRows(next), serverNow ? Date.parse(serverNow) : Date.now()), serverNow);
    setMessages(next);
  }, [speechPlayer]);

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
        const versionAtPoll = briefSaveVersion.current;
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
          speechPlayer.stop();
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
        if (typeof data.brief_audio === "boolean" && versionAtPoll % 2 === 0 && versionAtPoll === briefSaveVersion.current) {
          speechPlayer.setBrief(data.brief_audio);
          setThreads((prev) => prev.map((thread) => thread.id === activeId && thread.brief_audio !== data.brief_audio ? { ...thread, brief_audio: data.brief_audio! } : thread));
        }
        if (data.messages && data.messages.length) {
          acceptMessages(activeId, data.messages, data.now);
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
  }, [activeId, speechPlayer, acceptMessages, loadThreads, stopDictation, router]);

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
    } catch (e) {
      setCompareErrors((current) => ({ ...current, [question.id]: (e as Error).message }));
    } finally {
      compareRequests.current.delete(question.id);
      setComparing((current) => current.filter((id) => id !== question.id));
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
    setActiveId(id);
    setNavOpen(false);
  }

  async function changeBriefAudio(brief: boolean) {
    if (!activeId || savingBrief) return;
    const threadId = activeId;
    briefSaveVersion.current += 1;
    setSavingBrief(true);
    try {
      const res = await fetch("/api/threads", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ thread_id: threadId, brief_audio: brief }) });
      const data = await res.json() as { thread?: { id: string; brief_audio: boolean }; error?: string };
      if (!res.ok || !data.thread) throw new Error(data.error ?? "Could not save Brief audio");
      setThreads((prev) => prev.map((thread) => thread.id === threadId ? { ...thread, brief_audio: data.thread!.brief_audio } : thread));
      setError("");
    } catch (e) { setError((e as Error).message); }
    finally { briefSaveVersion.current += 1; setSavingBrief(false); }
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
    speechPlayer.stop();
    stopDictation();
    // Reject any in-flight response for the removed conversation immediately.
    loaded.current = { threadId: null, messages: [] };
    setMessages([]);
    setDraft("");
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

  return (
    <div className="flex h-dvh overflow-hidden">
      {removeTarget && <RemoveConversation key={removeTarget.id} conversation={removeTarget} onClose={() => setRemoveTarget(null)} onRemoved={conversationRemoved} />}
      {navOpen && <button type="button" aria-label="Close conversations" onClick={() => setNavOpen(false)} className="fixed inset-0 z-10 bg-black/60 md:hidden" />}
      <aside
        className={`fixed inset-y-0 left-0 z-20 flex w-72 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900 transition-transform md:static md:z-auto md:translate-x-0 md:bg-zinc-900/60 ${navOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <span className="text-[15px] font-semibold">Duo Board</span>
          <button type="button" onClick={() => setNavOpen(false)} className="text-zinc-500 hover:text-zinc-200 md:hidden" aria-label="Close">
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
          <AccountMenu />
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header aria-label="This conversation" className="flex shrink-0 flex-wrap items-center gap-3 border-b border-zinc-800 bg-zinc-900/50 px-3 py-3 md:px-5">
          <button type="button" onClick={() => setNavOpen(true)} className="min-h-10 rounded-lg border border-zinc-700 px-3 text-zinc-300 md:hidden" aria-label="Open conversations">☰</button>
          <div className="min-w-24 flex-1">
            <h1 className="truncate text-[16px] font-semibold">{active?.title ?? "…"}</h1>
            <p className="mt-1 text-[12px] text-zinc-400"><span className={active?.paused ? "text-amber-300" : "text-emerald-300"}>{active?.paused ? "Paused" : "Active"}</span> · {active?.blind_first_round === false ? "Live" : "Separate"}{briefAudio ? " · Brief audio" : ""}</p>
          </div>
          <div role="group" aria-label="Conversation controls" className="ml-auto flex items-center gap-2">
            <button type="button" disabled={!activeId || savingPause} onClick={() => void changePaused(!active?.paused)} aria-label={active?.paused ? "Resume conversation" : "Pause conversation"} className={`min-h-10 rounded-lg border px-3 py-2 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 disabled:opacity-50 ${active?.paused ? "border-amber-400 bg-amber-400 text-zinc-950 hover:bg-amber-300" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}>
              {savingPause ? "Saving…" : active?.paused ? "Resume conversation" : "Pause conversation"}
            </button>
            <button type="button" disabled={!active} onClick={() => active && setRemoveTarget({ id: active.id, title: active.title })} className="min-h-10 rounded-lg border border-rose-500/60 px-3 py-2 text-[13px] font-medium text-rose-300 hover:border-rose-400 hover:bg-rose-500/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400 disabled:opacity-40">Remove</button>
          </div>
          {error && <p role="alert" className="w-full text-[12px] text-rose-300">{error}</p>}
          {pauseError && <p role="alert" className="w-full text-[12px] text-rose-300">{pauseError} Try again.</p>}
        </header>

        {active?.paused && <div role="status" className="shrink-0 border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-[13px] leading-5 text-amber-200">Conversation paused. Messages wait here until you resume.</div>}

        <VoiceToolbar key={activeId} playback={playback} savingBrief={savingBrief} canSetBrief={Boolean(activeId)} onBriefChange={(brief) => void changeBriefAudio(brief)} />

        <div className="hidden shrink-0 grid-cols-2 border-b border-zinc-800 text-center text-[12px] font-medium text-zinc-400 lg:grid">
          <div className="py-2 text-orange-300">Claude</div>
          <div className="border-l border-zinc-800 py-2 text-emerald-300">ChatGPT</div>
        </div>

        <div className="relative min-h-0 flex-1">
          <div ref={scroller} onScroll={trackReadingPosition} aria-label="Conversation messages" className="h-full overflow-y-auto px-3 py-4 md:px-5">
            {rows.length === 0 && <p className="py-16 text-center text-[15px] text-zinc-400">Start a conversation below. Choose who you want to answer.</p>}
            {rows.map((row) => (
              <section key={row.key} className="mb-7">
                {row.user && (
                  <div className="mb-3 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
                    <div className="mb-2 flex items-center justify-between gap-2 text-[12px] text-zinc-400">
                      <span className="flex items-center gap-2"><span className="font-semibold text-indigo-300">You</span><AudienceBadge to={row.user.addressed_to} /></span>
                      <span>{clock(row.user.created_at)}</span>
                    </div>
                    <Body text={row.user.body} />
                  </div>
                )}
                <RoundReplies row={row} state={roundState(row, rows, now)} assistants={assistants} now={now} playback={playback} paused={active?.paused} currentBlind={active?.blind_first_round} comparing={comparing.includes(row.key) || savingPause} compareError={compareErrors[row.key]} onCompare={(question) => void compareAnswers(question)} />
              </section>
            ))}
          </div>
          {awayFromLatest && <button type="button" onClick={jumpToLatest} className="absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-indigo-400/60 bg-indigo-950 px-4 py-2 text-[13px] font-medium text-indigo-100 shadow-lg focus-visible:outline-2 focus-visible:outline-indigo-400">{newRepliesBelow ? "New replies · Jump to latest ↓" : "Jump to latest ↓"}</button>}
        </div>

        <form aria-label="Write a message" onSubmit={send} className="shrink-0 border-t border-zinc-700 bg-zinc-900/50 p-3 md:p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div role="group" aria-label="Message audience" className="flex items-center gap-2">
              <span className="text-[12px] font-medium text-zinc-400">To</span>
              <div className="flex rounded-lg border border-zinc-700 bg-zinc-950 p-0.5">
                {(["both", "claude", "chatgpt", "none"] as Audience[]).map((a) => (
                  <button key={a} type="button" aria-pressed={audience === a} onClick={() => setAudience(a)} className={`min-h-10 rounded-md px-2.5 text-[13px] focus-visible:outline-2 focus-visible:outline-indigo-400 sm:px-3 ${audience === a ? "bg-indigo-500/20 font-medium text-indigo-200 ring-1 ring-indigo-500/50" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"}`}>
                    {a === "both" ? "Both" : a === "none" ? "Note" : NAME[a]}
                  </button>
                ))}
              </div>
            </div>
            <div role="group" aria-label="Answer delivery" className="ml-auto flex items-center gap-2">
              <label htmlFor="answer-mode" className="text-[12px] font-medium text-zinc-400">Answers</label>
              <select id="answer-mode" aria-label="Answer mode" title="Saved for new questions in this conversation. Existing questions keep their original mode." value={active?.blind_first_round === false ? "live" : "separate"} disabled={!activeId || savingAnswerMode || sending} onChange={(e) => void changeAnswerMode(e.target.value === "separate")} className="min-h-10 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-[13px] text-zinc-200 focus-visible:outline-indigo-400 disabled:opacity-50">
                <option value="live">Live</option>
                <option value="separate">Separate</option>
              </select>
              <ControlPopover label="Answer mode help" trigger="?" above>
                <h2 className="mb-2 text-[14px] font-semibold">How answers arrive</h2>
                <p className="text-[13px] leading-6 text-zinc-300"><strong>Live:</strong> show answers as they arrive. Assistants can see earlier replies.</p>
                <p className="mt-2 text-[13px] leading-6 text-zinc-300"><strong>Separate:</strong> for questions to Both, each answers before seeing the other’s reply; reveal both together.</p>
                <p className="mt-3 text-[12px] text-zinc-400">Saved for new questions in this conversation. Existing questions keep their original mode.</p>
              </ControlPopover>
            </div>
          </div>
          {savingAnswerMode && <p role="status" className="mb-2 text-[12px] text-zinc-400">Saving answer mode…</p>}
          {answerModeError && <p role="alert" className="mb-2 text-[12px] text-rose-300">{answerModeError} Check the selected mode or try again.</p>}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void send(); }}
            rows={2}
            placeholder={dictation.listening ? "Listening… speak, or keep typing" : "Write a message…"}
            aria-label="Message"
            className={`mb-2 block max-h-40 min-h-20 w-full resize-y rounded-xl border bg-zinc-950 px-3 py-2 text-[15px] leading-6 outline-none focus:border-indigo-500 ${dictation.listening ? "border-rose-600" : "border-zinc-700"}`}
          />
          {dictation.interim && <p className="mb-2 text-[14px] italic text-zinc-400">{dictation.interim}…</p>}
          {dictation.problem && <p role="alert" className="mb-2 text-[12px] text-rose-300">{dictation.problem}</p>}
          <div className="flex items-center justify-between gap-2">
            <div role="group" aria-label="Dictation" className="flex items-center gap-2">
              {dictation.supported && <>
                <button type="button" onClick={dictation.toggle} aria-pressed={dictation.listening} aria-label={dictation.listening ? "Stop dictation" : "Dictate"} className={`flex min-h-10 items-center gap-2 rounded-lg border px-3 text-[13px] focus-visible:outline-2 focus-visible:outline-indigo-400 ${dictation.listening ? "border-rose-500 bg-rose-600/20 text-rose-300" : "border-zinc-700 text-zinc-300 hover:border-zinc-500"}`}>
                  <MicIcon /><span>{dictation.listening ? "Stop dictation" : "Dictate"}</span>
                </button>
                <ControlPopover label="Dictation settings" trigger="⌄" above>
                  <label className="block text-[13px] font-medium text-zinc-200">Dictation language
                    <select value={dictation.lang} onChange={(e) => dictation.setLang(e.target.value)} disabled={dictation.listening} aria-label="Dictation language" className="mt-2 min-h-10 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-[13px] text-zinc-200 disabled:opacity-50">
                      {LANGS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                    </select>
                  </label>
                </ControlPopover>
              </>}
            </div>
            <div className="ml-auto flex items-center gap-3">
              <span className="hidden text-[12px] text-zinc-500 sm:inline">Ctrl+Enter to send</span>
              <button type="submit" disabled={sending || savingAnswerMode || !draft.trim()} className="min-h-11 rounded-lg bg-indigo-500 px-5 py-2 text-[14px] font-semibold text-white hover:bg-indigo-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-300 disabled:opacity-40">
                {sending ? "Sending…" : active?.paused ? "Queue message" : "Send"}
              </button>
            </div>
          </div>
        </form>
      </main>
    </div>
  );
}
