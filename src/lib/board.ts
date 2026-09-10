import { db } from "./db";
import type { Assistant } from "./agent-auth";
import { BRIEF_AUDIO_GUIDANCE, normalizeSpokenReply } from "./spoken-reply";
import { withheldFrom, type RoundMessage } from "./rounds";

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
}

export interface ThreadSummary {
  id: string;
  title: string;
  archived: boolean;
  created_at: string;
  message_count: number;
  last_message_at: string | null;
  brief_audio: boolean;
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

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? "Database error");
}

// The blind-round migration adds messages.kind, assistants.floor_seq and the
// assistant_deliveries table. It is probed rather than assumed so the board
// keeps working, with today's single-cursor behaviour, on a database that has
// not run it yet. A negative probe is retried after a minute so running the
// migration takes effect without a redeploy.
let roundsProbe: { at: number; value: Promise<boolean> } | null = null;
function hasRounds(): Promise<boolean> {
  const stale = !roundsProbe || Date.now() - roundsProbe.at > 60_000;
  if (stale) {
    const value = (async () => {
      const { error } = await db().from("assistant_deliveries").select("seq").limit(1);
      if (error) return false;
      const { error: kindError } = await db().from("messages").select("kind").limit(1);
      return !kindError;
    })();
    roundsProbe = { at: Date.now(), value };
    // A positive probe is final for this instance.
    void value.then((ok) => {
      if (ok && roundsProbe) roundsProbe.at = Number.POSITIVE_INFINITY;
    });
  }
  return roundsProbe!.value;
}

async function columns(): Promise<string> {
  return (await hasRounds()) ? `${BASE_COLUMNS}, kind` : BASE_COLUMNS;
}

// Rows come back untyped because the column list is chosen at runtime.
function asMessage(row: unknown): Message {
  const r = row as Record<string, unknown>;
  return { ...(r as unknown as Message), kind: (r.kind as Kind | undefined) ?? "message" };
}

/**
 * Update an assistant's row. working_on_seq and floor_seq are later, additive
 * columns; if a migration has not been run yet, drop them and keep the rest of
 * the stamp so cursors and timestamps never stall on a missing column.
 */
async function stampAssistant(name: Assistant, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db().from("assistants").update(patch).eq("name", name);
  if (error && ("working_on_seq" in patch || "floor_seq" in patch)) {
    const rest = { ...patch };
    delete rest.working_on_seq;
    delete rest.floor_seq;
    await db().from("assistants").update(rest).eq("name", name);
  }
}

export async function listThreads(): Promise<ThreadSummary[]> {
  const { data, error } = await db()
    .from("thread_summaries")
    .select("id, title, archived, created_at, message_count, last_message_at, brief_audio")
    .eq("archived", false)
    .order("created_at", { ascending: false });
  if (error) fail(error);
  return (data ?? []).map((t) => ({ ...t, message_count: Number(t.message_count) }));
}

export async function createThread(title: string): Promise<ThreadSummary> {
  const clean = title.trim().slice(0, 120);
  if (!clean) throw new Error("A thread needs a title");
  const { data, error } = await db().from("threads").insert({ title: clean }).select("id, title, archived, created_at, brief_audio").single();
  if (error) fail(error);
  return { ...data, message_count: 0, last_message_at: null };
}

export async function setBriefAudio(threadId: string, briefAudio: boolean) {
  const { data, error } = await db().from("threads").update({ brief_audio: briefAudio }).eq("id", threadId).select("id, brief_audio").single();
  if (error) fail(error);
  return data as { id: string; brief_audio: boolean };
}

export async function getBriefAudio(threadId: string) {
  const { data, error } = await db().from("threads").select("brief_audio").eq("id", threadId).single();
  if (error) fail(error);
  return Boolean(data.brief_audio);
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
 * out, so read_thread cannot be used to peek around read_new.
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
  const held = withheldFrom(viewer, rows, new Map([[threadId, rows]]));
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
    .eq("reply_to", replyTo)
    .order("seq", { ascending: true })
    .limit(1);
  if (error) fail(error);
  return data?.length ? asMessage(data[0]) : null;
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
  const row: Record<string, unknown> = { thread_id: input.threadId, author: input.author, addressed_to, body, spoken_summary, reply_to: input.replyTo ?? null };
  if (input.kind && input.kind !== "message" && (await hasRounds())) row.kind = input.kind;
  const { data, error } = await db().from("messages").insert(row).select(await columns()).single();
  if (error) fail(error);
  const msg = asMessage(data);
  if (input.author !== "user") {
    // A post means the assistant is no longer "working on" the message it read.
    // The read cursor is deliberately not moved here: doing so used to skip any
    // message that arrived between the assistant's last read and its post.
    await stampAssistant(input.author, { last_posted_at: msg.created_at, working_on_seq: null });
  }
  return msg;
}

export interface NewForAssistant {
  messages: (Message & { for_you: boolean; thread_title: string; voice_mode: boolean; audio_preference: "brief" | "full" })[];
  pending_for_you: number;
  cursor: number;
  /** Replies from the other assistant held back until this assistant answers the same question. */
  held_for_you?: number;
  response_guidance?: string;
}

type Candidate = Message & { threads: { title: string; brief_audio: boolean } };

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
    .select(`${BASE_COLUMNS}, threads!inner(title, brief_audio)`)
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

const ROUND_COLUMNS = "seq, id, thread_id, author, addressed_to, reply_to, created_at";

/** Per-message delivery with the blind first round. */
async function readNewRounds(assistant: Assistant, limit: number): Promise<NewForAssistant> {
  const { data: cur, error: curErr } = await db().from("assistants").select("floor_seq, last_seen_seq").eq("name", assistant).single();
  if (curErr) fail(curErr);
  // Everything at or below the floor is delivered or the assistant's own.
  const floor = Number(cur?.floor_seq ?? 0);

  const { data, error } = await db()
    .from("messages")
    .select(`${BASE_COLUMNS}, kind, threads!inner(title, brief_audio)`)
    .gt("seq", floor)
    .neq("author", assistant)
    .order("seq", { ascending: true })
    .limit(limit + 200);
  if (error) fail(error);
  const candidates = (data ?? []).map((r) => asMessage(r) as Candidate);

  const { data: del, error: delErr } = await db().from("assistant_deliveries").select("seq").eq("assistant", assistant).gt("seq", floor);
  if (delErr) fail(delErr);
  const delivered = new Set((del ?? []).map((d) => Number(d.seq)));
  const undelivered = candidates.filter((m) => !delivered.has(m.seq));

  // Round context: recent messages of every thread that has an undelivered
  // reply from the other assistant, to find its question and whether this
  // assistant has answered it.
  const byThread = new Map<string, RoundMessage[]>();
  const threadIds = [...new Set(undelivered.filter((m) => m.author !== "user").map((m) => m.thread_id))];
  for (const threadId of threadIds) {
    const { data: ctx, error: ctxErr } = await db()
      .from("messages")
      .select(ROUND_COLUMNS)
      .eq("thread_id", threadId)
      .order("seq", { ascending: false })
      .limit(300);
    if (ctxErr) fail(ctxErr);
    byThread.set(threadId, (ctx ?? []) as RoundMessage[]);
  }
  const held = withheldFrom(assistant, undelivered, byThread);

  const out = undelivered.filter((m) => !held.has(m.seq)).slice(0, limit);
  const outSeqs = new Set(out.map((m) => m.seq));
  if (out.length) {
    const { error: insErr } = await db()
      .from("assistant_deliveries")
      .upsert(out.map((m) => ({ assistant, seq: m.seq })), { onConflict: "assistant,seq", ignoreDuplicates: true });
    if (insErr) fail(insErr);
  }

  // The floor rises to just below the first candidate that is still pending
  // (withheld, or beyond this read's limit), else past everything fetched.
  const pending = candidates.filter((m) => !delivered.has(m.seq) && !outSeqs.has(m.seq));
  const newFloor = pending.length ? Math.min(...pending.map((m) => m.seq)) - 1 : candidates.length ? candidates[candidates.length - 1].seq : floor;

  const messages = decorate(assistant, out);
  const forYou = messages.filter((m) => m.for_you);
  const lastSeen = Math.max(Number(cur?.last_seen_seq ?? 0), ...out.map((m) => m.seq));
  await stampRead(assistant, forYou, { floor_seq: Math.max(floor, newFloor), last_seen_seq: lastSeen });

  return {
    messages,
    pending_for_you: forYou.length,
    cursor: lastSeen,
    held_for_you: held.size,
    ...(forYou.some((m) => m.voice_mode) ? { response_guidance: BRIEF_AUDIO_GUIDANCE } : {}),
  };
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
    const { data: cur } = await db().from("assistants").select("floor_seq").eq("name", assistant).single();
    await stampAssistant(assistant, { last_seen_seq: to, floor_seq: Math.min(Number(cur?.floor_seq ?? 0), Math.max(0, to - 1)) });
    return;
  }
  const { error } = await db().from("assistants").update({ last_seen_seq: to }).eq("name", assistant);
  if (error) fail(error);
}
