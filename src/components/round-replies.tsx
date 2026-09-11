import { useState } from "react";
import type { AssistantStatus } from "@/lib/board";
import { Body } from "./message-body";
import { ListenButton, type useVoicePlayback } from "./voice-playback";
import { hasBothAnswers, hasFirstAnswer, isFirstRound, isStopped, openingExcerpt, type BoardMessage, type BoardRow } from "./round-model";

const NAMES = { claude: "Claude", chatgpt: "ChatGPT", user: "You" };
const TONES = { claude: "text-orange-300", chatgpt: "text-emerald-300", user: "text-indigo-300" };
const BUTTON = "rounded-lg border border-indigo-500/60 bg-indigo-500/10 px-3 py-2 text-[13px] font-medium text-indigo-200 hover:bg-indigo-500/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 disabled:cursor-wait disabled:opacity-50";
const STOP_BUTTON = "min-h-10 shrink-0 rounded-lg border border-rose-500/60 px-3 py-2 text-[13px] font-medium text-rose-300 hover:border-rose-400 hover:bg-rose-500/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400 disabled:cursor-wait disabled:opacity-50";
/** Whose waiting card offers Stop. The server accepts either assistant; the person asked for Claude's. */
const STOPPABLE: ReadonlySet<"claude" | "chatgpt"> = new Set(["claude"]);
type Playback = ReturnType<typeof useVoicePlayback>;
type StopControl = { onStop: () => void; busy: boolean; error?: string };

function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min${seconds % 60 ? ` ${seconds % 60} s` : ""}`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

function ReplyBubble({ message, askedAt, playback, compact }: { message: BoardMessage; askedAt?: string; playback: Playback; compact: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const took = askedAt ? Date.parse(message.created_at) - Date.parse(askedAt) : NaN;
  const summary = message.spoken_summary?.trim();
  const excerpt = summary || openingExcerpt(message.body);
  const collapsible = compact && (Boolean(summary) || message.body.trim().split(/\s+/).length > 110);
  return <article aria-label={`${NAMES[message.author]} reply`} className={`min-w-0 rounded-xl border p-4 ${playback.state.current?.id === message.id ? "border-indigo-500/70" : "border-zinc-800"}`}>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[12px] text-zinc-500">
      <span className="flex flex-wrap items-center gap-2">
        <span className={`font-semibold ${TONES[message.author]}`}>{NAMES[message.author]}</span>
        {Number.isFinite(took) && took >= 0 && <span title="Time from your message to this reply" className="rounded-full border border-zinc-800 px-2 py-0.5">in {duration(took)}</span>}
      </span>
      <span className="flex flex-wrap items-center gap-2"><ListenButton message={message} playback={playback} /><time dateTime={message.created_at}>{new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></span>
    </div>
    {playback.state.mode === "voice-focus" ? <details><summary className="cursor-pointer text-[13px] text-zinc-400">Show text</summary><div className="mt-3"><Body text={message.body} /></div></details>
      : collapsible ? <>
        {expanded ? <Body text={message.body} /> : <div dir="auto"><p className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">{summary ? "Brief answer" : "Opening excerpt"}</p><p className="text-[15px] leading-7 text-zinc-100">{excerpt || "This reply contains code or detailed formatting. Expand it to read."}</p></div>}
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="mt-3 rounded text-[13px] font-medium text-indigo-300 hover:text-indigo-200 focus-visible:outline-2 focus-visible:outline-indigo-400">{expanded ? "Show less" : "Read full answer"}</button>
      </> : <Body text={message.body} />}
  </article>;
}

function ReplyList({ messages, who, askedAt, playback, compact }: { messages: BoardMessage[]; who: "claude" | "chatgpt"; askedAt?: string; playback: Playback; compact: boolean }) {
  const answers = messages.filter((message) => Boolean(message.reply_to));
  const updates = messages.filter((message) => !message.reply_to);
  return <>
    {answers.map((message) => <ReplyBubble key={message.id} message={message} askedAt={askedAt} playback={playback} compact={compact} />)}
    {updates.length > 0 && <details className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-3">
      <summary className="cursor-pointer rounded text-[13px] text-zinc-400 focus-visible:outline-2 focus-visible:outline-indigo-400">{NAMES[who]} · Updates ({updates.length})</summary>
      <div className="mt-3 space-y-3">{updates.map((message) => <ReplyBubble key={message.id} message={message} askedAt={askedAt} playback={playback} compact={false} />)}</div>
    </details>}
  </>;
}

function Waiting({ who, question, status, now, ready = false, ended = false, paused = false, stopped = false, stop }: { who: "claude" | "chatgpt"; question?: BoardMessage; status?: AssistantStatus; now: number; ready?: boolean; ended?: boolean; paused?: boolean; stopped?: boolean; stop?: StopControl }) {
  const working = Boolean(question && status?.working_on_seq === question.seq);
  const waited = question ? duration(now - Date.parse(question.created_at)) : "";
  const old = ended || Boolean(question && now - Date.parse(question.created_at) >= 2 * 60 * 60 * 1000);
  // Offered until an answer is in: once one is posted, even if still held, there is nothing left to stop.
  const canStop = !stopped && !ready;
  return <div className="rounded-xl border border-dashed border-zinc-700/80 bg-zinc-900/30 p-4 text-[13px] leading-6 text-zinc-400">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className={`font-medium ${TONES[who]}`}>{NAMES[who]} · {stopped ? "Stopped" : paused ? "Paused" : ready ? "Answer ready" : old ? "No answer received" : working ? "Working on an answer" : "Waiting for an answer"}</p>
        <p>{stopped ? `You stopped this answer, so ${NAMES[who]} won't post one. Ask again whenever you like.` : paused ? "Resume the conversation to continue." : ready ? "Held until both answers are ready." : old ? "You can ask a new question whenever you like." : `Waiting ${waited || "for a reply"}. You can keep the conversation going.`}</p>
      </div>
      {canStop && stop && <button type="button" onClick={stop.onStop} disabled={stop.busy} aria-label={`Stop ${NAMES[who]}'s answer to this message`} title={`${NAMES[who]} drops this and no answer to it will be posted`} className={STOP_BUTTON}>{stop.busy ? "Stopping…" : "Stop"}</button>}
    </div>
    {stop?.error && !stopped && <p role="alert" className="mt-2 text-[13px] text-rose-300">{stop.error}</p>}
  </div>;
}

export function RoundReplies({ row, state, assistants, now, playback, comparing, compareError, onCompare, paused = false, currentBlind = true, stopAvailable = false, stopping = [], stopErrors = {}, onStop }: {
  row: BoardRow; assistants: AssistantStatus[]; now: number; playback: Playback;
  state: { held: boolean; paired: boolean };
  comparing: boolean; compareError?: string; onCompare: (question: BoardMessage) => void;
  paused?: boolean;
  currentBlind?: boolean;
  /** False until the database has the stop table; then Stop appears on the waiting card. */
  stopAvailable?: boolean;
  /** Keys "<message id>:<assistant>" of stops being saved, and of stops that failed. */
  stopping?: string[];
  stopErrors?: Record<string, string>;
  onStop?: (question: BoardMessage, who: "claude" | "chatgpt") => void;
}) {
  const stopControl = (question: BoardMessage | undefined, who: "claude" | "chatgpt"): StopControl | undefined => {
    if (!question || !stopAvailable || !onStop || !STOPPABLE.has(who)) return undefined;
    const key = `${question.id}:${who}`;
    return { onStop: () => onStop(question, who), busy: stopping.includes(key), error: stopErrors[key] };
  };
  const blind = isFirstRound(row);
  const live = row.user?.blind_round === false;
  const revealed = !state.held;
  const compare = row.comparison;
  const compared = compare && hasBothAnswers(compare, compare.request.id);
  const differentMode = row.user && (row.user.blind_round !== false) !== currentBlind;
  return <div className="space-y-4">
    {blind && (differentMode || state.held || state.paired || compare || compareError) && <div className="flex flex-wrap items-center justify-end gap-2 text-[12px] text-zinc-400">
      {differentMode && <span className="mr-auto rounded-full border border-zinc-700 px-2.5 py-1" title="This question keeps the answer mode selected when it was sent">{live ? "Live answers" : "Separate answers"}</span>}
      {state.held && <span className="mr-auto">Answers will appear together when both are ready.</span>}
      {state.paired && !compare && <button type="button" disabled={comparing || paused} title={paused ? "Resume the conversation to compare answers" : undefined} onClick={() => row.user && onCompare(row.user)} className={BUTTON}>{comparing ? "Requesting comparison…" : "Compare answers"}</button>}
      {compare && <span className="rounded-full border border-indigo-500/30 px-2.5 py-1 text-[12px] text-indigo-300">{compared ? "Comparison complete" : "Comparison requested"}</span>}
      {compareError && <p role="alert" className="w-full text-[13px] text-rose-300">{compareError} You can try Compare answers again.</p>}
    </div>}
    {revealed && compare && <section aria-label="Answer comparison" className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-4">
      <div className="mb-3"><h3 className="text-[14px] font-semibold text-indigo-200">Compare the two takes</h3><p className="mt-1 text-[12px] leading-5 text-zinc-400">What each agrees with, challenges, and changes after reading the other. One follow-up each.</p></div>
      <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">{(["claude", "chatgpt"] as const).map((who) => <div className="min-w-0 space-y-3" key={who}>
        {compare[who].length ? <ReplyList messages={compare[who]} who={who} askedAt={compare.request.created_at} playback={playback} compact={false} /> : <Waiting who={who} question={compare.request} now={now} paused={paused} stopped={isStopped(compare.request, who)} stop={stopControl(compare.request, who)} status={assistants.find((a) => a.name === who)} />}
      </div>)}</div>
    </section>}
    <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">{(["claude", "chatgpt"] as const).map((who) => {
      const expected = row.user && (row.user.addressed_to === "both" || row.user.addressed_to === who);
      return <div key={who} className="min-w-0 space-y-3">
        {revealed && <ReplyList messages={row[who]} who={who} askedAt={row.user?.created_at} playback={playback} compact={blind} />}
        {expected && (!revealed || (blind ? !hasFirstAnswer(row, who) : !row[who].length)) && <Waiting who={who} question={row.user} now={now} paused={paused} stopped={isStopped(row.user, who)} stop={stopControl(row.user, who)} ended={blind && !live && revealed && !state.paired} ready={!revealed && hasFirstAnswer(row, who)} status={assistants.find((a) => a.name === who)} />}
      </div>;
    })}</div>
  </div>;
}
