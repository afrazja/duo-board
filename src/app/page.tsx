"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { AssistantStatus, Audience, Message, ThreadSummary } from "@/lib/board";

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

  return { supported, listening, interim, problem, lang, setLang: writeLang, toggle: () => (listening ? stop() : start()) };
}

// Text with ``` fences rendered as code, everything else kept as written.
function Body({ text }: { text: string }) {
  const parts = text.split(/```/);
  return (
    <div className="space-y-2">
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="overflow-x-auto rounded-md bg-black/40 p-3 text-[13.5px] leading-6">
            {p.replace(/^[a-z]*\n/, "")}
          </pre>
        ) : (
          p.trim() && (
            <p key={i} className="whitespace-pre-wrap text-[15.5px] leading-7 text-zinc-100">
              {p.trim()}
            </p>
          )
        )
      )}
    </div>
  );
}

interface Row {
  key: string;
  user?: Message;
  claude: Message[];
  chatgpt: Message[];
}

function groupRows(messages: Message[]): Row[] {
  const rows: Row[] = [];
  for (const m of messages) {
    if (m.author === "user" || rows.length === 0) rows.push({ key: m.id, user: m.author === "user" ? m : undefined, claude: [], chatgpt: [] });
    if (m.author === "claude") rows[rows.length - 1].claude.push(m);
    if (m.author === "chatgpt") rows[rows.length - 1].chatgpt.push(m);
  }
  return rows;
}

function AudienceBadge({ to }: { to: Audience }) {
  const label = to === "both" ? "to both" : to === "none" ? "note" : `to ${NAME[to]}`;
  return <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[12px] text-zinc-400">{label}</span>;
}

// Assistant replies sit on the plain page background; only the name carries
// the assistant's colour, so the text stays as readable as the rest.
const NAME_TONE: Record<string, string> = { claude: "text-orange-300", chatgpt: "text-emerald-300" };

function Bubble({ m }: { m: Message }) {
  return (
    <div className="rounded-xl border border-zinc-800 p-4">
      <div className="mb-2 flex items-center justify-between text-[12px] text-zinc-500">
        <span className={`font-semibold ${NAME_TONE[m.author] ?? "text-zinc-300"}`}>{NAME[m.author]}</span>
        <span>{clock(m.created_at)}</span>
      </div>
      <Body text={m.body} />
    </div>
  );
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
  const [messages, setMessages] = useState<Message[]>([]);
  const [assistants, setAssistants] = useState<AssistantStatus[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState("");
  const [audience, setAudience] = useState<Audience>("both");
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const lastSeq = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const appendToDraft = useCallback((text: string) => setDraft((prev) => joinText(prev, text)), []);
  const dictation = useDictation(appendToDraft);

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
    lastSeq.current = 0;
    setMessages([]);
    const poll = async () => {
      try {
        const res = await fetch(`/api/messages?thread=${activeId}&after=${lastSeq.current}`);
        if (res.status === 401) {
          location.href = "/login";
          return;
        }
        const data = (await res.json()) as { messages?: Message[]; assistants?: AssistantStatus[]; error?: string };
        if (stopped) return;
        if (data.error) {
          setError(data.error);
          return;
        }
        setError("");
        if (data.assistants) setAssistants(data.assistants);
        if (data.messages && data.messages.length) {
          lastSeq.current = data.messages[data.messages.length - 1].seq;
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => m.id));
            return [...prev, ...data.messages!.filter((m) => !seen.has(m.id))];
          });
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
    };
    void poll();
    const t = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [activeId]);

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
    setSending(true);
    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: activeId, body, addressed_to: audience }),
      });
      const data = (await res.json()) as { message?: Message; error?: string };
      if (data.message) {
        setMessages((prev) => (prev.some((m) => m.id === data.message!.id) ? prev : [...prev, data.message!]));
        lastSeq.current = Math.max(lastSeq.current, data.message.seq);
        setDraft("");
      } else setError(data.error ?? "Could not send");
    } finally {
      setSending(false);
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

  const rows = groupRows(messages);
  const active = threads.find((t) => t.id === activeId);
  const status = (name: "claude" | "chatgpt") => assistants.find((a) => a.name === name);
  const lastRow = rows[rows.length - 1];

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
            <span className="flex items-center gap-2 text-[12px]"><span className="font-medium text-orange-300">Claude</span><StatusChip a={status("claude")} now={now} /></span>
            <span className="flex items-center gap-2 text-[12px]"><span className="font-medium text-emerald-300">ChatGPT</span><StatusChip a={status("chatgpt")} now={now} /></span>
          </div>
          {error && <span className="text-[12px] text-rose-400">{error}</span>}
        </header>

        <div className="hidden grid-cols-2 border-b border-zinc-800 text-center text-[12px] uppercase tracking-wide text-zinc-500 md:grid">
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
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {(["claude", "chatgpt"] as const).map((who) => {
                  const list = row[who];
                  const expected = row.user && (row.user.addressed_to === "both" || row.user.addressed_to === who);
                  const waiting = expected && list.length === 0 && row === lastRow;
                  return (
                    <div key={who} className="min-w-0 space-y-3">
                      {list.map((m) => <Bubble key={m.id} m={m} />)}
                      {waiting && <p className="rounded-xl border border-dashed border-zinc-800 p-4 text-[13px] text-zinc-500">Waiting for {NAME[who]}…</p>}
                    </div>
                  );
                })}
              </div>
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
