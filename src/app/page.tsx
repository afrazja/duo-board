"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { AssistantStatus, Audience, ThreadSummary } from "@/lib/board";
import { useVoicePlayback, VoiceToolbar } from "@/components/voice-playback";

import { Body } from "@/components/message-body";
import { RoundReplies } from "@/components/round-replies";
import { groupRows, mergeMessages, playableMessages, type BoardRow, type BoardMessage } from "@/components/round-model";

// One conversation, two columns. The person's messages span both; each
// assistant's replies land in its own column, grouped under the message they
// answer. The page polls the server every few seconds; the assistants read
// and write through the MCP server or the HTTP mirror.

const POLL_MS = 3000;
const NAME: Record<string, string> = { user: "You", claude: "Claude", chatgpt: "ChatGPT" };
const NAME_TONE: Record<string, string> = { claude: "text-orange-300", chatgpt: "text-emerald-300" };

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

// A duration in words: "48 s", "4 min 12 s", "1 h 05 min".
function spell(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m} min ${r} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
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

  return { supported, listening, interim, problem, lang, setLang: writeLang, toggle: () => (listening ? stop() : start()) };
}

// Average time from the person's message to each assistant's first reply,
// over the rows on screen. Null until an assistant has replied to something.
function replyStats(rows: BoardRow[]): Record<"claude" | "chatgpt", number | null> {
  const out: Record<"claude" | "chatgpt", number | null> = { claude: null, chatgpt: null };
  for (const who of ["claude", "chatgpt"] as const) {
    const deltas = rows
      .filter((r) => r.user && r[who].length)
      .map((r) => Date.parse(r[who][0].created_at) - Date.parse(r.user!.created_at))
      .filter((d) => d >= 0);
    if (deltas.length) out[who] = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  }
  return out;
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

function StatusChip({ a, now }: { a: AssistantStatus | undefined; now: number }) {
  const checkedAgo = a?.last_checked_at ? (now - Date.parse(a.last_checked_at)) / 1000 : Infinity;
  const dot = checkedAgo < 180 ? "bg-emerald-400" : checkedAgo < 1800 ? "bg-amber-400" : "bg-zinc-600";
  return (
    <span className="flex items-center gap-2 text-[12px] text-zinc-400">
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
      checked {ago(a?.last_checked_at, now)} · answered {ago(a?.last_posted_at, now)}
    </span>
  );
}

export default function BoardPage() {
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
  const [comparing, setComparing] = useState<string[]>([]);
  const [compareErrors, setCompareErrors] = useState<Record<string, string>>({});
  const compareRequests = useRef(new Set<string>());
  const loaded = useRef<{ threadId: string | null; messages: BoardMessage[] }>({ threadId: null, messages: [] });
  const briefSaveVersion = useRef(0);
  const lastSeq = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const appendToDraft = useCallback((text: string) => setDraft((prev) => joinText(prev, text)), []);
  const dictation = useDictation(appendToDraft);
  const briefAudio = threads.find((thread) => thread.id === activeId)?.brief_audio ?? false;
  const playback = useVoicePlayback(activeId, dictation.listening, briefAudio);
  const speechPlayer = playback.player;

  const acceptMessages = useCallback((threadId: string, incoming: BoardMessage[], serverNow?: string) => {
    if (loaded.current.threadId !== threadId) return;
    const next = mergeMessages(loaded.current.messages, incoming);
    loaded.current.messages = next;
    // Unrevealed text never enters the audio queue. Previously held answers
    // become eligible together when the second assistant's answer arrives.
    speechPlayer.ingest(playableMessages(groupRows(next)), serverNow);
    setMessages(next);
  }, [speechPlayer]);

  const loadThreads = useCallback(async () => {
    const res = await fetch("/api/threads");
    if (res.status === 401) {
      location.href = "/login";
      return;
    }
    const data = (await res.json()) as { threads?: ThreadSummary[]; error?: string };
    if (data.error) {
      setError(data.error);
      return;
    }
    let list = data.threads ?? [];
    if (list.length === 0) {
      const made = await fetch("/api/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "General" }) });
      const t = (await made.json()) as { thread?: ThreadSummary };
      if (t.thread) list = [t.thread];
    }
    setThreads(list);
    setActiveId((cur) => cur ?? list[0]?.id ?? null);
  }, []);

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
    setMessages([]);
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const versionAtPoll = briefSaveVersion.current;
        const res = await fetch(`/api/messages?thread=${activeId}&after=${lastSeq.current}`);
        if (res.status === 401) {
          location.href = "/login";
          return;
        }
        const data = (await res.json()) as { messages?: BoardMessage[]; assistants?: AssistantStatus[]; error?: string; now?: string; brief_audio?: boolean };
        if (stopped) return;
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
  }, [activeId, speechPlayer, acceptMessages]);

  // Follow the conversation unless the reader has scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
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
  const active = threads.find((t) => t.id === activeId);
  const status = (name: "claude" | "chatgpt") => assistants.find((a) => a.name === name);
  const stats = replyStats(rows);

  return (
    <div className="flex h-screen">
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
              <span className="text-[12px] text-zinc-500">
                {t.message_count} {t.message_count === 1 ? "message" : "messages"}
                {t.last_message_at ? ` · ${ago(t.last_message_at, now)}` : ""}
              </span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-zinc-800 px-4 py-3 md:px-5">
          <button type="button" onClick={() => setNavOpen(true)} className="rounded-md border border-zinc-700 px-2 py-1 text-[13px] text-zinc-300 md:hidden" aria-label="Open conversations">
            ☰
          </button>
          <h1 className="text-[15px] font-semibold">{active?.title ?? "…"}</h1>
          <div className="flex flex-wrap gap-x-5">
            {(["claude", "chatgpt"] as const).map((who) => (
              <span key={who} className="flex items-center gap-2 text-[12px]">
                <span className={`font-medium ${NAME_TONE[who]}`}>{NAME[who]}</span>
                <StatusChip a={status(who)} now={now} />
                {stats[who] != null && (
                  <span className="text-zinc-500" title="Average time from your message to this assistant's first reply, in this conversation">
                    · avg reply {spell(stats[who]!)}
                  </span>
                )}
              </span>
            ))}
          </div>
          {error && <span className="text-[12px] text-rose-400">{error}</span>}
        </header>

        <VoiceToolbar playback={playback} savingBrief={savingBrief} canSetBrief={Boolean(activeId)} onBriefChange={(brief) => void changeBriefAudio(brief)} />

        <div className="hidden grid-cols-2 border-b border-zinc-800 text-center text-[12px] uppercase tracking-wide text-zinc-500 lg:grid">
          <div className="py-1.5">Claude</div>
          <div className="border-l border-zinc-800 py-1.5">ChatGPT</div>
        </div>

        <div ref={scroller} className="flex-1 overflow-y-auto px-5 py-4">
          {rows.length === 0 && <p className="py-20 text-center text-[15px] text-zinc-500">Nothing here yet. Write below and address one or both.</p>}
          {rows.map((row) => (
            <section key={row.key} className="mb-8">
              {row.user && (
                <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
                  <div className="mb-2 flex items-center justify-between text-[12px] text-zinc-500">
                    <span className="flex items-center gap-2"><span className="font-semibold text-indigo-300">You</span><AudienceBadge to={row.user.addressed_to} /></span>
                    <span>{clock(row.user.created_at)}</span>
                  </div>
                  <Body text={row.user.body} />
                </div>
              )}
              <RoundReplies row={row} assistants={assistants} now={now} playback={playback} comparing={comparing.includes(row.key)} compareError={compareErrors[row.key]} onCompare={(question) => void compareAnswers(question)} />
            </section>
          ))}
        </div>

        <form onSubmit={send} className="border-t border-zinc-800 p-4">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void send();
            }}
            rows={3}
            placeholder={dictation.listening ? "Listening… speak, or keep typing" : "Write to the board… (Ctrl+Enter to send)"}
            aria-label="Message"
            className={`mb-2 w-full resize-y rounded-lg border bg-zinc-950 px-3 py-2 text-[15px] leading-6 outline-none focus:border-indigo-500 ${dictation.listening ? "border-rose-700" : "border-zinc-700"}`}
          />
          {dictation.interim && <p className="mb-2 px-1 text-[14px] italic text-zinc-500">{dictation.interim}…</p>}
          {dictation.problem && <p className="mb-2 px-1 text-[12px] text-rose-400">{dictation.problem}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-zinc-500">To:</span>
            {(["both", "claude", "chatgpt", "none"] as Audience[]).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setAudience(a)}
                className={`rounded-full border px-3 py-1 text-[13px] ${audience === a ? "border-indigo-500 bg-indigo-600/20 text-indigo-200" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}
              >
                {a === "both" ? "Both" : a === "none" ? "Note only" : NAME[a]}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              {dictation.supported && (
                <>
                  <select
                    value={dictation.lang}
                    onChange={(e) => dictation.setLang(e.target.value)}
                    disabled={dictation.listening}
                    aria-label="Dictation language"
                    title="Dictation language"
                    className="rounded-md border border-zinc-800 bg-zinc-950 px-1.5 py-1 text-[12px] text-zinc-500 outline-none hover:text-zinc-300 disabled:opacity-50"
                  >
                    {LANGS.map(([code, label]) => (
                      <option key={code} value={code}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={dictation.toggle}
                    aria-pressed={dictation.listening}
                    aria-label={dictation.listening ? "Stop dictation" : "Dictate"}
                    title={dictation.listening ? "Stop dictation" : "Dictate"}
                    className={`flex h-9 w-9 items-center justify-center rounded-lg border ${dictation.listening ? "animate-pulse border-rose-500 bg-rose-600/20 text-rose-300" : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-100"}`}
                  >
                    <MicIcon />
                  </button>
                </>
              )}
              <button
                type="submit"
                disabled={sending || !draft.trim()}
                className="h-9 rounded-lg bg-indigo-600 px-4 text-[14px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </form>
      </main>
    </div>
  );
}
