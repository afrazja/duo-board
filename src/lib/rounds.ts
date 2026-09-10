import type { Assistant } from "./agent-auth";

// The blind first round, as pure functions over message rows so the rule can
// be tested without a database.
//
// A "round" is a person's message addressed to both assistants. While an
// assistant has not answered a round, the other assistant's replies to that
// round are withheld from it, so each first answer is written without seeing
// the other's. Once it has answered, the withheld replies are delivered on
// its next read. Questions addressed to one assistant alone never withhold.

export interface RoundMessage {
  seq: number;
  id: string;
  thread_id: string;
  author: "user" | Assistant;
  addressed_to: "both" | Assistant | "none";
  reply_to: string | null;
  created_at: string;
}

/** After this long, a round stops withholding even if an answer never used reply_to. */
export const STALE_ROUND_MS = 2 * 60 * 60 * 1000;

/** The question a message answers: the latest person's message in its thread with a lower seq. */
export function questionFor(m: RoundMessage, thread: RoundMessage[]): RoundMessage | null {
  let best: RoundMessage | null = null;
  for (const q of thread) {
    if (q.author !== "user" || q.thread_id !== m.thread_id || q.seq >= m.seq) continue;
    if (!best || q.seq > best.seq) best = q;
  }
  return best;
}

/**
 * Whether `who` has answered question `q`. An answer is a post by `who` whose
 * reply_to names the question. Two safety valves stop a round withholding
 * forever: `who` answered a later question in the same thread (moved on), or
 * the question is older than STALE_ROUND_MS.
 */
export function hasAnswered(who: Assistant, q: RoundMessage, thread: RoundMessage[], now = Date.now()): boolean {
  const mine = thread.filter((x) => x.author === who && x.thread_id === q.thread_id && x.seq > q.seq);
  if (mine.some((x) => x.reply_to === q.id)) return true;
  const later = new Set(thread.filter((x) => x.author === "user" && x.thread_id === q.thread_id && x.seq > q.seq).map((x) => x.id));
  if (mine.some((x) => x.reply_to && later.has(x.reply_to))) return true;
  return now - Date.parse(q.created_at) > STALE_ROUND_MS;
}

/**
 * The seqs of the other assistant's messages that must be withheld from
 * `who`: replies to a round addressed to both that `who` has not answered.
 * `byThread` holds each thread's recent messages (any order).
 */
export function withheldFrom(
  who: Assistant,
  candidates: RoundMessage[],
  byThread: Map<string, RoundMessage[]>,
  now = Date.now()
): Set<number> {
  const held = new Set<number>();
  for (const m of candidates) {
    if (m.author === "user" || m.author === who) continue;
    const thread = byThread.get(m.thread_id) ?? [];
    const q = questionFor(m, thread);
    if (!q || q.addressed_to !== "both") continue;
    if (!hasAnswered(who, q, thread, now)) held.add(m.seq);
  }
  return held;
}
