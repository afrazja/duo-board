import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AssistantStatus } from "@/lib/board";
import { helperManages, helperRequestState, type HelperView } from "@/lib/helper-view";
import { Body } from "./message-body";
import { hasBothAnswers, hasFirstAnswer, isFirstRound, openingExcerpt, type BoardMessage, type BoardRow } from "./round-model";

const NAMES = { claude: "Claude", chatgpt: "ChatGPT", user: "You" };
const TONES = { claude: "text-orange-300", chatgpt: "text-emerald-300", user: "text-indigo-300" };
const BUTTON = "rounded-lg border border-indigo-500/60 bg-indigo-500/10 px-3 py-2 text-[13px] font-medium text-indigo-200 hover:bg-indigo-500/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 disabled:cursor-wait disabled:opacity-50";

function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min${seconds % 60 ? ` ${seconds % 60} s` : ""}`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

function ReplyBubble({ message, askedAt, compact }: { message: BoardMessage; askedAt?: string; compact: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const took = askedAt ? Date.parse(message.created_at) - Date.parse(askedAt) : NaN;
  const summary = message.spoken_summary?.trim();
  const excerpt = summary || openingExcerpt(message.body);
  const collapsible = compact && (Boolean(summary) || message.body.trim().split(/\s+/).length > 110);
  return <article aria-label={`${NAMES[message.author]} reply`} className="min-w-0 rounded-xl border border-zinc-800 p-3 sm:p-4">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[12px] text-zinc-500">
      <span className="flex flex-wrap items-center gap-2">
        <span className={`font-semibold ${TONES[message.author]}`}>{NAMES[message.author]}</span>
        {Number.isFinite(took) && took >= 0 && <span title="Time from your message to this reply" className="rounded-full border border-zinc-800 px-2 py-0.5">in {duration(took)}</span>}
      </span>
      <time dateTime={message.created_at}>{new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
    </div>
    {collapsible ? <>
        {expanded ? <Body text={message.body} /> : <div dir="auto"><p className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">{summary ? "Brief answer" : "Opening excerpt"}</p><p className="text-[15px] leading-7 text-zinc-100">{excerpt || "This reply contains code or detailed formatting. Expand it to read."}</p></div>}
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="mt-3 rounded text-[13px] font-medium text-indigo-300 hover:text-indigo-200 focus-visible:outline-2 focus-visible:outline-indigo-400">{expanded ? "Show less" : "Read full answer"}</button>
      </> : <Body text={message.body} />}
  </article>;
}

function ReplyList({ messages, who, askedAt, compact }: { messages: BoardMessage[]; who: "claude" | "chatgpt"; askedAt?: string; compact: boolean }) {
  const answers = messages.filter((message) => Boolean(message.reply_to));
  const updates = messages.filter((message) => !message.reply_to);
  return <>
    {answers.map((message) => <ReplyBubble key={message.id} message={message} askedAt={askedAt} compact={compact} />)}
    {updates.length > 0 && <details className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-3">
      <summary className="cursor-pointer rounded text-[13px] text-zinc-400 focus-visible:outline-2 focus-visible:outline-indigo-400">{NAMES[who]} · Updates ({updates.length})</summary>
      <div className="mt-3 space-y-3">{updates.map((message) => <ReplyBubble key={message.id} message={message} askedAt={askedAt} compact={false} />)}</div>
    </details>}
  </>;
}

/**
 * Move the track to a card. The scroll is deliberately not smooth: a smooth
 * scrollTo is silently a no-op in some Chromium builds (an embedded WebView
 * among them), which would leave the counter and the highlighted name saying
 * one card while another is still on screen. Landing on the card matters more
 * than gliding to it, and scroll-snap already makes the jump feel deliberate.
 */
function slideTo(track: HTMLDivElement | null, index: number) {
  if (track) track.scrollLeft = index * track.clientWidth;
}

/**
 * The assistants' answers as one full-width card each, in a horizontal track
 * rather than two half-width columns: the first assistant is the first card,
 * the second assistant the card beside it. Scroll-snap does the swiping; the
 * name buttons and the arrow keys move between cards. A single card has
 * nothing to slide between, so it is rendered on its own without the chrome.
 */
function ReplySlider({ slides, label }: { slides: { who: "claude" | "chatgpt"; content: ReactNode }[]; label: string }) {
  const track = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  // After a move, read the card back off the track rather than trusting that
  // the move landed: assigning scrollLeft fires no scroll event at all in some
  // embedded browsers, so onScroll alone cannot keep the counter honest. A
  // timeout rather than an animation frame, so the read still happens while
  // the tab is in the background.
  const syncActive = () => setTimeout(() => {
    const el = track.current;
    if (el?.clientWidth) setActive(Math.round(el.scrollLeft / el.clientWidth));
  }, 0);
  if (slides.length < 2) return <div className="min-w-0 space-y-3">{slides[0]?.content}</div>;

  const show = (index: number) => {
    const next = Math.max(0, Math.min(slides.length - 1, index));
    setActive(next);
    slideTo(track.current, next);
    syncActive();
  };
  const arrows = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    show(active + (event.key === "ArrowRight" ? 1 : -1));
  };

  return <div className="min-w-0">
    <div className="mb-2 flex items-center gap-2">
      {slides.map((slide, index) => <button key={slide.who} type="button" onClick={() => show(index)} aria-label={`Show ${NAMES[slide.who]}'s answer`} aria-current={index === active}
        className={`min-h-9 rounded-lg border px-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 ${index === active ? `border-zinc-600 bg-zinc-800/70 ${TONES[slide.who]}` : "border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"}`}>{NAMES[slide.who]}</button>)}
      <span aria-hidden className="ml-auto text-[12px] tabular-nums text-zinc-500">{active + 1} / {slides.length}</span>
    </div>
    <div ref={track} tabIndex={0} role="group" aria-roledescription="carousel" aria-label={label} onKeyDown={arrows}
      onScroll={(event) => { const el = event.currentTarget; if (el.clientWidth) setActive(Math.round(el.scrollLeft / el.clientWidth)); }}
      className="flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain rounded-xl [scrollbar-width:none] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 [&::-webkit-scrollbar]:hidden">
      {slides.map((slide, index) => <div key={slide.who} role="group" aria-roledescription="slide" aria-label={`${index + 1} of ${slides.length}: ${NAMES[slide.who]}`}
        className="w-full shrink-0 snap-start space-y-3">{slide.content}</div>)}
    </div>
  </div>;
}

function Waiting({ who, question, status, now, ready = false, ended = false, paused = false, stopping = false, onStop, helper, onWake, waking }: { who: "claude" | "chatgpt"; question?: BoardMessage; status?: AssistantStatus; now: number; ready?: boolean; ended?: boolean; paused?: boolean; stopping?: boolean; onStop?: () => void; helper?:HelperView|null; onWake?:()=>void; waking?:boolean }) {
  // The helper answers for ChatGPT once paired, and for Claude when Claude Code runs beside it.
  const managed = helperManages(helper, who);
  const requestState = managed && question ? helperRequestState(helper??null,question.id,who) : null;
  const labels:Record<string,string>={stopping:"Stopping…",stopped:"Stopped",attention:"Needs attention",offline:"Waiting for your computer",unlinked:"Conversation not linked",paused:"Paused",sleeping:"Sleeping",working:"Working on an answer",queued:"Waiting for an answer",completed:"Answer received"};
  const details:Record<string,string>={stopping:"Stop is saved. The helper will confirm when work has ended.",stopped:"This request was stopped. Later questions can still continue.",attention:"Open the helper on your computer to review this request.",offline:"Your message is saved. Open the helper on your computer to continue.",unlinked:"Link this conversation in the helper on your computer.",paused:`Wake ${NAMES[who]} to allow new queued requests to continue.`,sleeping:`${NAMES[who]} is asleep after five idle minutes. Wake it to continue.`,working:`${NAMES[who]} is working on this request.`,queued:"Your request is saved and waiting to run.",completed:"The reply has been saved and will appear here shortly."};
  const working = Boolean(question && status?.working_on_seq === question.seq);
  const waited = question ? duration(now - Date.parse(question.created_at)) : "";
  const old = ended || Boolean(question && now - Date.parse(question.created_at) >= 2 * 60 * 60 * 1000);
  const stopped = Boolean(question?.stopped_for?.includes(who));
  const pendingHelper = ["queued","working","offline","sleeping","paused","unlinked"].includes(requestState??"");
  return <div className="rounded-xl border border-dashed border-zinc-700/80 bg-zinc-900/30 p-3 text-[13px] leading-6 text-zinc-400 sm:p-4">
    <div className="flex items-center justify-between gap-3">
      <p className={`font-medium ${TONES[who]}`}>{NAMES[who]} · {paused ? "Paused" : stopping || requestState==="stopping" ? "Stopping…" : stopped ? "Stopped" : ready ? "Answer ready" : requestState ? labels[requestState] : old ? "No answer received" : working ? "Working on an answer" : "Waiting for an answer"}</p>
      {managed && !paused && !stopped && !ready && (!old || pendingHelper) && onStop && <button type="button" disabled={stopping||requestState==="stopping"} onClick={onStop} aria-label={`Stop ${NAMES[who]} task`} className="min-h-9 shrink-0 rounded-lg border border-rose-500/60 px-3 text-[12px] font-medium text-rose-300 hover:border-rose-400 hover:bg-rose-500/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400 disabled:cursor-wait disabled:opacity-50">{stopping||requestState==="stopping" ? "Stopping…" : "Stop"}</button>}
    </div>
    <p>{paused ? "Resume the conversation to continue." : requestState==="stopping" ? details.stopping : stopped ? `This task will not receive a ${NAMES[who]} answer. New questions still work.` : ready ? "Held until both answers are ready." : requestState ? details[requestState] : old ? "You can ask a new question whenever you like." : `Waiting ${waited || "for a reply"}. You can keep the conversation going.`}</p>
    {!paused&&!stopped&&!ready&&["sleeping","paused"].includes(requestState??"")&&onWake&&<button type="button" disabled={waking} onClick={onWake} className={`mt-2 min-h-9 rounded-lg border px-3 disabled:opacity-50 ${who==="claude"?"border-orange-500/50 text-orange-200":"border-emerald-500/50 text-emerald-200"}`}>{waking?"Waking…":`Wake ${NAMES[who]}`}</button>}
  </div>;
}

export function RoundReplies({ row, state, assistants, now, comparing, compareError, onCompare, onStop, stopping = [], paused = false, currentBlind = true, helper, onWake, waking }: {
  row: BoardRow; assistants: AssistantStatus[]; now: number;
  state: { held: boolean; paired: boolean };
  comparing: boolean; compareError?: string; onCompare: (question: BoardMessage) => void;
  onStop?: (question: BoardMessage, who: "claude" | "chatgpt") => void;
  stopping?: string[];
  paused?: boolean;
  currentBlind?: boolean;
  helper?:HelperView|null; onWake?:()=>void; waking?:boolean;
}) {
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
      <ReplySlider label="Comparison answers" slides={(["claude", "chatgpt"] as const).map((who) => ({
        who,
        content: compare[who].length
          ? <ReplyList messages={compare[who]} who={who} askedAt={compare.request.created_at} compact={false} />
          : <Waiting helper={helper} onWake={onWake} waking={waking} who={who} question={compare.request} now={now} paused={paused} stopping={stopping.includes(`${who}:${compare.request.id}`)} onStop={onStop ? () => onStop(compare.request, who) : undefined} status={assistants.find((a) => a.name === who)} />,
      }))} />
    </section>}
    <ReplySlider label="Assistant answers" slides={(["claude", "chatgpt"] as const).flatMap((who) => {
      const question = row.user;
      const expected = Boolean(question && (question.addressed_to === "both" || question.addressed_to === who));
      const waiting = expected && (!revealed || (blind ? !hasFirstAnswer(row, who) : !row[who].length));
      // An assistant the person never addressed, with nothing to show, is not
      // a card: an empty slide would be a blank swipe with nothing in it.
      if (!waiting && !(revealed && row[who].length)) return [];
      return [{
        who,
        content: <>
          {revealed && <ReplyList messages={row[who]} who={who} askedAt={row.user?.created_at} compact={blind} />}
          {waiting && question && <Waiting helper={helper} onWake={onWake} waking={waking} who={who} question={question} now={now} paused={paused} stopping={stopping.includes(`${who}:${question.id}`)} onStop={onStop ? () => onStop(question, who) : undefined} ended={blind && !live && revealed && !state.paired} ready={!revealed && hasFirstAnswer(row, who)} status={assistants.find((a) => a.name === who)} />}
        </>,
      }];
    })} />
  </div>;
}
