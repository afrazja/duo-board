import { db } from "./db";
import type { Assistant } from "./agent-auth";
import { BRIEF_AUDIO_GUIDANCE, normalizeSpokenReply } from "./spoken-reply";
import { hasLinkedAnswer, withheldFrom, type RoundMessage } from "./rounds";

export type Author = "user" | Assistant;
export type Audience = "both" | Assistant | "none";
/** 'compare' asks both assistants for a short agree / challenge / changed reply about an earlier question. */
export type Kind = "message" | "compare";

export interface Message {
  seq: number;
  id: string;
  thread_id: string;
  author: Author;
  addressed_to: Audience;
  body: string;
  spoken_summary: string | null;
  reply_to: string | null;
  created_at: string;
  kind: Kind;
  blind_round: boolean;
}

export interface ThreadSummary {
  id: string;
  title: string;
  archived: boolean;
  created_at: string;
  message_count: number;
  last_message_at: string | null;
  brief_audio: boolean;
  blind_first_round: boolean;
}

export interface AssistantStatus {
  name: Assistant;
  last_seen_seq: number;
  last_checked_at: string | null;
  last_posted_at: string | null;
  /** Seq of the latest message for this assistant that it has read but not answered; null when idle. */
  working_on_seq: number | null;
}

const BASE_COLUMNS = "seq, id, thread_id, author, addressed_to, body, spoken_summary, reply_to, created_at";
const ROUND_COLUMNS = "seq, id, thread_id, author, addressed_to, reply_to, created_at";
/** How much of a thread the round rules look at. */
const ROUND_CONTEXT = 300;
const ASSISTANTS: Assistant[] = ["claude", "chatgpt"];

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? "Database error");
}

// The blind-round migration adds messages.kind, assistants.floor_seq and
// held_seqs, and the assistant_deliveries table. It is probed rather than
// assumed so the board keeps working, with the previous single-cursor
// behaviour, on a database that has not run it yet. A negative probe is
// retried after a minute so running the migration takes effect without a
// redeploy; a positive one is final for this instance.
let roundsProbe: { at: number; value: Promise<boolean> } | null = null;
function hasRounds(): Promise<boolean> {
  const stale = !roundsProbe || Date.now() - roundsProbe.at > 60_000;
  if (stale) {
    const value = (async () => {
      const { error } = await db().from("assistant_deliveries").select("seq").limit(1);
      if (error) return false;
      const { error: kindError } = await db().from("messages").select("kind").limit(1);
      if (kindError) return false;
      const { error: heldError } = await db().from("assistants").select("held_seqs").limit(1);
      return !heldError;
    })();
    roundsProbe = { at: Date.now(), value };
    void value.then((ok) => {
      if (ok && roundsProbe) roundsProbe.at = Number.POSITIVE_INFINITY;
    });
  }
  return roundsProbe!.value;
}

let answerModesProbe: { at: number; value: Promise<boolean> } | null = null;
function hasAnswerModes(): Promise<boolean> {
  if (!answerModesProbe || Date.now() - answerModesProbe.at > 60_000) {
    const value = (async () => {
      const { error } = await db().from("messages").select("blind_round").limit(1);
      return !error;
    })();
    const probe = { at: Date.now(), value };
    answerModesProbe = probe;
    void value.then((ok) => { if (ok) probe.at = Number.POSITIVE_INFINITY; });
  }
  return answerModesProbe.value;
}

async function columns(): Promise<string> {
  const base = (await hasRounds()) ? `${BASE_COLUMNS}, kind` : BASE_COLUMNS;
  return (await hasAnswerModes()) ? `${base}, blind_round` : base;
}

// Rows come back untyped because the column list is chosen at runtime.
function asMessage(row: unknown): Message {
  const r = row as Record<string, unknown>;
  return { ...(r as unknown as Message), kind: (r.kind as Kind | undefined) ?? "message", blind_round: r.blind_round !== false };
}

/**
 * The recent messages of a thread, as the round rules need them (any order),
 * plus any message a reply in `anchors` links to that is older than the
 * recent window, followed through reply chains. Without this a late reply
 * to an old question could not be judged; with it, it is judged correctly.
 */
async function roundContext(threadId: string, anchors: { reply_to: string | null }[] = []): Promise<RoundMessage[]> {
  const roundColumns: string = (await hasAnswerModes()) ? `${ROUND_COLUMNS}, blind_round` : ROUND_COLUMNS;
  const { data, error } = await db()
    .from("messages")
    .select(roundColumns)
    .eq("thread_id", threadId)
    .order("seq", { ascending: false })
    .limit(ROUND_CONTEXT);
  if (error) fail(error);
  // Supabase cannot infer a row type from this migration-dependent selection.
  const rows = (data ?? []) as unknown as RoundMessage[];
  const have = new Set(rows.map((m) => m.id));
  let wanted = anchors.map((a) => a.reply_to).filter((id): id is string => !!id && !have.has(id));
  for (let hop = 0; hop < 4 && wanted.length; hop++) {
    const { data: parents, error: pErr } = await db().from("messages").select(roundColumns).eq("thread_id", threadId).in("id", wanted);
    if (pErr) fail(pErr);
    const found = (parents ?? []) as unknown as RoundMessage[];
    if (!found.length) break;
    for (const p of found) {
      rows.push(p);
      have.add(p.id);
    }
    // An old question's direct replies decide whether it was answered, and
    // they may be outside the window too.
    const { data: replies, error: rErr } = await db().from("messages").select(roundColumns).eq("thread_id", threadId).in("reply_to", found.map((p) => p.id));
    if (rErr) fail(rErr);
    for (const r of (replies ?? []) as unknown as RoundMessage[]) {
      if (!have.has(r.id)) {
        rows.push(r);
        have.add(r.id);
      }
    }
    wanted = found.map((p) => p.reply_to).filter((id): id is string => !!id && !have.has(id));
  }
  return rows;
}

/**
 * Update an assistant's row. The newer columns are additive; if a migration
 * has not been run yet, drop them and keep the rest of the stamp so cursors
 * and timestamps never stall on a missing column.
 */
async function stampAssistant(name: Assistant, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db().from("assistants").update(patch).eq("name", name);
  if (error && ("working_on_seq" in patch || "floor_seq" in patch || "held_seqs" in patch)) {
    const rest = { ...patch };
    delete rest.working_on_seq;
    delete rest.floor_seq;
    delete rest.held_seqs;
    await db().from("assistants").update(rest).eq("name", name);
  }
}

export async function listThreads(): Promise<ThreadSummary[]> {
  const { data, error } = await db()
    .from("thread_summaries")
    .select("*")
    .eq("archived", false)
    .order("created_at", { ascending: false });
  if (error) fail(error);
  return (data ?? []).map((t) => ({ ...t, message_count: Number(t.message_count), blind_first_round: t.blind_first_round !== false }));
}

export async function createThread(title: string): Promise<ThreadSummary> {
  const clean = title.trim().slice(0, 120);
  if (!clean) throw new Error("A thread needs a title");
  const { data, error } = await db().from("threads").insert({ title: clean }).select("*").single();
  if (error) fail(error);
  return { ...data, message_count: 0, last_message_at: null, blind_first_round: data.blind_first_round !== false };
}

export async function setThreadPreferences(threadId: string, preferences: { brief_audio?: boolean; blind_first_round?: boolean }) {
  const { data, error } = await db().from("threads").update(preferences).eq("id", threadId).select("*").single();
  if (error) fail(error);
  return { id: data.id as string, brief_audio: Boolean(data.brief_audio), blind_first_round: data.blind_first_round !== false };
}

export async function getThreadPreferences(threadId: string) {
  const { data, error } = await db().from("threads").select("*").eq("id", threadId).single();
  if (error) fail(error);
  return { brief_audio: Boolean(data.brief_audio), blind_first_round: data.blind_first_round !== false };
}

export async function getMessages(threadId: string, afterSeq = 0, limit = 300): Promise<Message[]> {
  const { data, error } = await db()
    .from("messages")
    .select(await columns())
    .eq("thread_id", threadId)
    .gt("seq", afterSeq)
    .order("seq", { ascending: true })
    .limit(limit);
  if (error) fail(error);
  return (data ?? []).map((row) => asMessage(row));
}

/**
 * The latest messages of a thread, oldest first, without moving any cursor.
 * When an assistant is the viewer, the blind round applies here too: the
 * other assistant's answer to a question the viewer has not answered is left
 * out, so read_thread cannot be used to peek around read_new. The check uses
 * the whole recent thread, not just the rows requested, so a small limit
 * cannot leak an answer whose question falls outside it.
 */
export async function readThread(threadId: string, limit = 60, viewer?: Assistant): Promise<Message[]> {
  const { data, error } = await db()
    .from("messages")
    .select(await columns())
    .eq("thread_id", threadId)
    .order("seq", { ascending: false })
    .limit(limit);
  if (error) fail(error);
  const rows = (data ?? []).map((row) => asMessage(row)).reverse();
  if (!viewer || !(await hasRounds())) return rows;
  const held = withheldFrom(viewer, rows, new Map([[threadId, await roundContext(threadId, rows)]]));
  return rows.filter((m) => !held.has(m.seq));
}

/** The existing compare request for a question in a thread, if one was already made. */
export async function findCompare(threadId: string, replyTo: string): Promise<Message | null> {
  if (!(await hasRounds())) return null;
  const { data, error } = await db()
    .from("messages")
    .select(await columns())
    .eq("thread_id", threadId)
    .eq("kind", "compare")
    .eq("author", "user")
    .eq("reply_to", replyTo)
    .order("seq", { ascending: true })
    .limit(1);
  if (error) fail(error);
  return data?.length ? asMessage(data[0]) : null;
}

/** A compare request must name a both-addressed question in its thread that both assistants have answered. */
async function validateCompareTarget(threadId: string, questionId: string): Promise<void> {
  const thread = await roundContext(threadId, [{ reply_to: questionId }]);
  const q = thread.find((m) => m.id === questionId);
  if (!q || q.author !== "user" || q.addressed_to !== "both") {
    throw new Error("A compare request needs a recent question in this thread that was addressed to both");
  }
  // A real linked answer from each side: a round released by the moved-on or
  // timeout valve has nothing to compare.
  for (const who of ASSISTANTS) {
    if (!hasLinkedAnswer(who, q, thread)) throw new Error(`Compare waits until both have answered; ${who} has not yet`);
  }
}

export async function postMessage(input: {
  threadId: string;
  author: Author;
  addressedTo?: Audience;
  body: string;
  replyTo?: string | null;
  spokenSummary?: string | null;
  kind?: Kind;
}): Promise<Message> {
  const { body, spoken_summary } = input.author === "user"
    ? { body: input.body.trim(), spoken_summary: null }
    : normalizeSpokenReply(input.body, input.spokenSummary);
  if (!body) throw new Error("Empty message");
  const addressed_to: Audience = input.addressedTo ?? (input.author === "user" ? "both" : "none");
  const compare = input.kind === "compare" && (await hasRounds());
  if (compare) {
    if (!input.replyTo) throw new Error("A compare request needs reply_to");
    await validateCompareTarget(input.threadId, input.replyTo);
  }
  const row: Record<string, unknown> = { thread_id: input.threadId, author: input.author, addressed_to, body, spoken_summary, reply_to: input.replyTo ?? null };
  if (compare) row.kind = "compare";
  const { data, error } = await db().from("messages").insert(row).select(await columns()).single();
  if (error) {
    // Two compare clicks at once: the unique index rejects the second; return the first.
    if (compare && input.replyTo && (error as { code?: string }).code === "23505") {
      const existing = await findCompare(input.threadId, input.replyTo);
      if (existing) return existing;
    }
    fail(error);
  }
  const msg = asMessage(data);
  if (input.author !== "user") {
    // A post means the assistant is no longer "working on" the message it read.
    // The read cursor is deliberately not moved here: doing so used to skip any
    // message that arrived between the assistant's last read and its post.
    await stampAssistant(input.author, { last_posted_at: msg.created_at, working_on_seq: null });
  }
  return msg;
}

export interface CompareContext {
  question: Message;
  answers: Message[];
}

export interface NewForAssistant {
  messages: (Message & {
    for_you: boolean;
    thread_title: string;
    voice_mode: boolean;
    audio_preference: "brief" | "full";
    /** On a compare request: the question and both first answers, even if delivered before. */
    compare_context?: CompareContext;
  })[];
  pending_for_you: number;
  cursor: number;
  /** Replies from the other assistant held back until this assistant answers the same question. */
  held_for_you?: number;
  response_guidance?: string;
}

type Candidate = Message & { threads: { title: string; brief_audio: boolean } };
const CANDIDATE_SELECT = `${BASE_COLUMNS}, threads!inner(title, brief_audio)`;
// The migrated reader needs kind to attach the original answers to Compare.
// Keep the legacy selection separate for databases without that column.
async function roundCandidateSelect() {
  return `${await columns()}, threads!inner(title, brief_audio)`;
}

function decorate(assistant: Assistant, rows: Candidate[]) {
  return rows.map(({ threads, ...m }) => ({
    ...m,
    thread_title: threads.title,
    voice_mode: threads.brief_audio,
    audio_preference: threads.brief_audio ? ("brief" as const) : ("full" as const),
    for_you: m.author === "user" && (m.addressed_to === "both" || m.addressed_to === assistant),
  }));
}

async function stampRead(assistant: Assistant, forYou: { seq: number }[], extra: Record<string, unknown>) {
  // Reading a message addressed to this assistant marks it as being worked
  // on until the assistant posts; the page shows that instead of a blank wait.
  const stamp: Record<string, unknown> = { last_checked_at: new Date().toISOString(), ...extra };
  if (forYou.length) stamp.working_on_seq = forYou[forYou.length - 1].seq;
  await stampAssistant(assistant, stamp);
}

/**
 * Everything an assistant has not read yet, across all threads, oldest first,
 * with for_you marking what it is expected to answer. With the blind-round
 * migration, delivery is tracked per message and the other assistant's answer
 * to an open round is withheld until this assistant has answered it.
 */
export async function readNew(assistant: Assistant, limit = 100): Promise<NewForAssistant> {
  return (await hasRounds()) ? readNewRounds(assistant, limit) : readNewLegacy(assistant, limit);
}

/** Single-cursor delivery, for a database without the blind-round migration. */
async function readNewLegacy(assistant: Assistant, limit: number): Promise<NewForAssistant> {
  const { data: cur, error: curErr } = await db().from("assistants").select("last_seen_seq").eq("name", assistant).single();
  if (curErr) fail(curErr);
  const cursor = Number(cur?.last_seen_seq ?? 0);

  const { data, error } = await db()
    .from("messages")
    .select(CANDIDATE_SELECT)
    .gt("seq", cursor)
    .neq("author", assistant)
    .order("seq", { ascending: true })
    .limit(limit);
  if (error) fail(error);

  const messages = decorate(assistant, (data ?? []).map((r) => asMessage(r) as Candidate));
  const newCursor = messages.length ? messages[messages.length - 1].seq : cursor;
  const forYou = messages.filter((m) => m.for_you);
  await stampRead(assistant, forYou, { last_seen_seq: newCursor });

  return {
    messages,
    pending_for_you: forYou.length,
    cursor: newCursor,
    ...(forYou.some((m) => m.voice_mode) ? { response_guidance: BRIEF_AUDIO_GUIDANCE } : {}),
  };
}

/**
 * Per-message delivery with the blind first round.
 *
 * floor_seq: everything at or below it is delivered, this assistant's own, or
 * recorded in held_seqs. held_seqs: replies held back from this assistant,
 * re-evaluated on every read, so a long-held reply never pins the floor and
 * scanning always reaches newer messages.
 */
async function readNewRounds(assistant: Assistant, limit: number): Promise<NewForAssistant> {
  const candidateSelect = await roundCandidateSelect();
  const { data: cur, error: curErr } = await db().from("assistants").select("floor_seq, last_seen_seq, held_seqs").eq("name", assistant).single();
  if (curErr) fail(curErr);
  const floor = Number(cur?.floor_seq ?? 0);
  const heldBefore = ((cur?.held_seqs ?? []) as unknown[]).map(Number);

  // New candidates above the floor, plus everything previously held.
  const { data, error } = await db()
    .from("messages")
    .select(candidateSelect)
    .gt("seq", floor)
    .neq("author", assistant)
    .order("seq", { ascending: true })
    .limit(limit + 200);
  if (error) fail(error);
  const candidates = (data ?? []).map((r) => asMessage(r) as Candidate);

  let heldRows: Candidate[] = [];
  const heldToFetch = heldBefore.filter((s) => !candidates.some((c) => c.seq === s));
  if (heldToFetch.length) {
    const { data: hd, error: hdErr } = await db().from("messages").select(candidateSelect).in("seq", heldToFetch);
    if (hdErr) fail(hdErr);
    heldRows = (hd ?? []).map((r) => asMessage(r) as Candidate);
  }

  const { data: del, error: delErr } = await db().from("assistant_deliveries").select("seq").eq("assistant", assistant).gt("seq", floor);
  if (delErr) fail(delErr);
  const delivered = new Set((del ?? []).map((d) => Number(d.seq)));

  const pool = [...candidates.filter((m) => !delivered.has(m.seq)), ...heldRows].sort((a, b) => a.seq - b.seq);

  // Round context for every thread that has a reply from the other assistant
  // or a compare request in the pool.
  const byThread = new Map<string, RoundMessage[]>();
  const threadIds = [...new Set(pool.filter((m) => m.author !== "user" || m.kind === "compare").map((m) => m.thread_id))];
  for (const threadId of threadIds) {
    byThread.set(threadId, await roundContext(threadId, pool.filter((m) => m.thread_id === threadId)));
  }
  const held = withheldFrom(assistant, pool, byThread);

  const out = pool.filter((m) => !held.has(m.seq)).slice(0, limit);
  const outSeqs = new Set(out.map((m) => m.seq));
  if (out.length) {
    const { error: insErr } = await db()
      .from("assistant_deliveries")
      .upsert(out.map((m) => ({ assistant, seq: m.seq })), { onConflict: "assistant,seq", ignoreDuplicates: true });
    if (insErr) fail(insErr);
  }

  // Held replies are remembered by seq so the floor can move past them, and a
  // previously held reply stays remembered until it is actually delivered,
  // even once eligible, in case it fell beyond this read's limit. The floor
  // stops just below the first candidate that is neither delivered, held, nor
  // in this read's output (i.e. beyond the limit).
  const heldBeforeSet = new Set(heldBefore);
  const heldNow = pool.filter((m) => !outSeqs.has(m.seq) && (held.has(m.seq) || heldBeforeSet.has(m.seq))).map((m) => m.seq);
  const beyondLimit = candidates.filter((m) => !delivered.has(m.seq) && !held.has(m.seq) && !outSeqs.has(m.seq));
  const newFloor = beyondLimit.length ? Math.min(...beyondLimit.map((m) => m.seq)) - 1 : candidates.length ? candidates[candidates.length - 1].seq : floor;

  // A compare request carries its question and both first answers, so a
  // restarted assistant can compare without re-reading the thread.
  const messages = decorate(assistant, out).map((m) => {
    if (m.kind !== "compare" || !m.reply_to) return m;
    const thread = byThread.get(m.thread_id) ?? [];
    const q = thread.find((x) => x.id === m.reply_to);
    return q ? { ...m, compare_context: { question_id: q.id, answer_ids: thread.filter((x) => x.author !== "user" && x.reply_to === q.id).map((x) => x.id) } } : m;
  });
  const withContext = await attachCompareContext(messages);

  const forYou = withContext.filter((m) => m.for_you);
  const lastSeen = Math.max(Number(cur?.last_seen_seq ?? 0), ...out.map((m) => m.seq));
  await stampRead(assistant, forYou, { floor_seq: Math.max(floor, newFloor), last_seen_seq: lastSeen, held_seqs: heldNow });

  return {
    messages: withContext,
    pending_for_you: forYou.length,
    cursor: lastSeen,
    held_for_you: held.size,
    ...(forYou.some((m) => m.voice_mode) ? { response_guidance: BRIEF_AUDIO_GUIDANCE } : {}),
  };
}

type Decorated = ReturnType<typeof decorate>[number] & { compare_context?: { question_id: string; answer_ids: string[] } };

/** Replace id-only compare context with the full question and answer messages. */
async function attachCompareContext(messages: Decorated[]): Promise<NewForAssistant["messages"]> {
  const ids = [...new Set(messages.flatMap((m) => (m.compare_context ? [m.compare_context.question_id, ...m.compare_context.answer_ids] : [])))];
  const byId = new Map<string, Message>();
  if (ids.length) {
    const { data, error } = await db().from("messages").select(await columns()).in("id", ids);
    if (error) fail(error);
    for (const row of data ?? []) {
      const m = asMessage(row);
      byId.set(m.id, m);
    }
  }
  return messages.map((m) => {
    const { compare_context: ctx, ...rest } = m;
    const question = ctx && byId.get(ctx.question_id);
    if (!ctx || !question) return rest;
    const answers = ctx.answer_ids.map((id) => byId.get(id)).filter((x): x is Message => !!x).sort((a, b) => a.seq - b.seq);
    return { ...rest, compare_context: { question, answers } };
  });
}

export async function assistantStatus(): Promise<AssistantStatus[]> {
  // select("*") so a database without the newer columns still answers.
  const { data, error } = await db().from("assistants").select("*");
  if (error) fail(error);
  return (data ?? []).map((a) => ({
    name: a.name,
    last_seen_seq: Number(a.last_seen_seq),
    last_checked_at: a.last_checked_at ?? null,
    last_posted_at: a.last_posted_at ?? null,
    working_on_seq: a.working_on_seq == null ? null : Number(a.working_on_seq),
  })) as AssistantStatus[];
}

/** Lets an assistant re-read from a given point, e.g. after a lost reply. */
export async function rewind(assistant: Assistant, toSeq: number): Promise<void> {
  const to = Math.max(0, toSeq);
  if (await hasRounds()) {
    const { error } = await db().from("assistant_deliveries").delete().eq("assistant", assistant).gte("seq", to);
    if (error) fail(error);
    const { data: cur } = await db().from("assistants").select("floor_seq, held_seqs").eq("name", assistant).single();
    const held = ((cur?.held_seqs ?? []) as unknown[]).map(Number).filter((s) => s < to);
    await stampAssistant(assistant, {
      last_seen_seq: to,
      floor_seq: Math.min(Number(cur?.floor_seq ?? 0), Math.max(0, to - 1)),
      held_seqs: held,
    });
    return;
  }
  const { error } = await db().from("assistants").update({ last_seen_seq: to }).eq("name", assistant);
  if (error) fail(error);
}
