import { db } from "./db";
import type { Assistant, Owner } from "./agent-auth";
import { BRIEF_AUDIO_GUIDANCE, normalizeSpokenReply } from "./spoken-reply";
import { hasLinkedAnswer, nextFloor, withheldFrom, type RoundMessage } from "./rounds";

export type { Owner } from "./agent-auth";
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
  /** While true, assistants' reads of this conversation deliver nothing and their loops skip it; nothing is lost. */
  paused: boolean;
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

// Migrations are probed rather than assumed so the board keeps working on a
// database that has not run one yet. A negative probe is retried after a
// minute so running the migration takes effect without a redeploy; a positive
// one is final for this instance.
function probe(check: () => Promise<boolean>): () => Promise<boolean> {
  let state: { at: number; value: Promise<boolean> } | null = null;
  return () => {
    if (!state || Date.now() - state.at > 60_000) {
      const value = check();
      const s = { at: Date.now(), value };
      state = s;
      void value.then((ok) => { if (ok) s.at = Number.POSITIVE_INFINITY; });
    }
    return state.value;
  };
}

// Blind rounds: messages.kind, assistants.floor_seq and held_seqs, assistant_deliveries.
const hasRounds = probe(async () => {
  const { error } = await db().from("assistant_deliveries").select("seq").limit(1);
  if (error) return false;
  const { error: kindError } = await db().from("messages").select("kind").limit(1);
  if (kindError) return false;
  const { error: heldError } = await db().from("assistants").select("held_seqs").limit(1);
  return !heldError;
});

const hasAnswerModes = probe(async () => {
  const { error } = await db().from("messages").select("blind_round").limit(1);
  return !error;
});

/** Accounts: owner_id on threads and assistants (supabase/accounts.sql). */
export const accountsReady = probe(async () => {
  const { error } = await db().from("threads").select("owner_id").limit(1);
  if (error) return false;
  const { error: aErr } = await db().from("assistants").select("owner_id").limit(1);
  return !aErr;
});

type Filterable<Q> = { eq(column: string, value: unknown): Q; is(column: string, value: null): Q };
/** Restrict a query to one account's rows. null is the board from before accounts. */
export function byOwner<Q extends Filterable<Q>>(query: Q, owner: Owner, column = "owner_id"): Q {
  return owner === null ? query.is(column, null) : query.eq(column, owner);
}

/**
 * byOwner when the migration has run; otherwise the query is left alone (there
 * is only one board). Wrapped in an object because a query builder is itself
 * awaitable: returning it from an async function would run it.
 */
async function scopeOwner<Q extends Filterable<Q>>(query: Q, owner: Owner, column = "owner_id"): Promise<{ q: Q }> {
  if (await accountsReady()) return { q: byOwner(query, owner, column) };
  if (owner !== null) throw new Error("Accounts need supabase/accounts.sql on this database");
  return { q: query };
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

function asThread(t: Record<string, unknown>): ThreadSummary {
  return {
    id: t.id as string,
    title: t.title as string,
    archived: t.archived === true,
    created_at: t.created_at as string,
    message_count: Number(t.message_count ?? 0),
    last_message_at: (t.last_message_at as string | null) ?? null,
    brief_audio: Boolean(t.brief_audio),
    blind_first_round: t.blind_first_round !== false,
    paused: t.paused === true,
  };
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

/** One account's row for one assistant. */
async function assistantRow(owner: Owner, name: Assistant, select: string): Promise<Record<string, unknown>> {
  const { data, error } = await (await scopeOwner(db().from("assistants").select(select).eq("name", name), owner)).q.maybeSingle();
  if (error) fail(error);
  if (!data) throw new Error("This account has no assistant rows yet; open the board page once while signed in");
  return data as unknown as Record<string, unknown>;
}

/**
 * Update an assistant's row. The newer columns are additive; if a migration
 * has not been run yet, drop them and keep the rest of the stamp so cursors
 * and timestamps never stall on a missing column.
 */
async function stampAssistant(owner: Owner, name: Assistant, patch: Record<string, unknown>): Promise<void> {
  const { error } = await (await scopeOwner(db().from("assistants").update(patch).eq("name", name), owner)).q;
  if (error && ("working_on_seq" in patch || "floor_seq" in patch || "held_seqs" in patch)) {
    const rest = { ...patch };
    delete rest.working_on_seq;
    delete rest.floor_seq;
    delete rest.held_seqs;
    await (await scopeOwner(db().from("assistants").update(rest).eq("name", name), owner)).q;
  }
}

/** Make sure an account has its two assistant rows. Idempotent. */
export async function ensureAssistantRows(owner: string): Promise<void> {
  const { error } = await db()
    .from("assistants")
    .upsert(ASSISTANTS.map((name) => ({ owner_id: owner, name })), { onConflict: "owner_id,name", ignoreDuplicates: true });
  if (error) throw new Error(`Could not initialise the account's assistants: ${error.message}`);
}

export async function listThreads(owner: Owner): Promise<ThreadSummary[]> {
  const scoped = await accountsReady();
  if (!scoped && owner !== null) throw new Error("Accounts need supabase/accounts.sql on this database");
  let query = db().from("thread_summaries").select("*").eq("archived", false);
  if (scoped) query = owner === null ? query.is("owner_id", null) : query.eq("owner_id", owner);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) fail(error);
  return (data ?? []).map((t) => asThread(t as Record<string, unknown>));
}

export async function createThread(owner: Owner, title: string): Promise<ThreadSummary> {
  const clean = title.trim().slice(0, 120);
  if (!clean) throw new Error("A thread needs a title");
  const row: Record<string, unknown> = { title: clean };
  if (await accountsReady()) row.owner_id = owner;
  else if (owner !== null) throw new Error("Accounts need supabase/accounts.sql on this database");
  const { data, error } = await db().from("threads").insert(row).select("*").single();
  if (error) fail(error);
  return asThread({ ...(data as Record<string, unknown>), message_count: 0, last_message_at: null });
}

export async function setThreadPreferences(owner: Owner, threadId: string, preferences: { brief_audio?: boolean; blind_first_round?: boolean; paused?: boolean }) {
  const { data, error } = await (await scopeOwner(db().from("threads").update(preferences).eq("id", threadId), owner)).q.select("*").maybeSingle();
  if (error) fail(error);
  if (!data) throw new Error("Conversation not found");
  return { id: data.id as string, brief_audio: Boolean(data.brief_audio), blind_first_round: data.blind_first_round !== false, paused: data.paused === true };
}

export async function getThreadPreferences(owner: Owner, threadId: string) {
  const { data, error } = await (await scopeOwner(db().from("threads").select("*").eq("id", threadId), owner)).q.maybeSingle();
  if (error) fail(error);
  if (!data) throw new Error("Conversation not found");
  return { brief_audio: Boolean(data.brief_audio), blind_first_round: data.blind_first_round !== false, paused: data.paused === true };
}

/** Whether a conversation exists in this account and whether it is paused. A database without the column answers not paused. */
async function threadState(owner: Owner, threadId: string): Promise<{ exists: boolean; paused: boolean }> {
  const { data, error } = await (await scopeOwner(db().from("threads").select("*").eq("id", threadId), owner)).q.maybeSingle();
  if (error) fail(error);
  const row = data as { paused?: boolean } | null;
  return { exists: !!row, paused: row?.paused === true };
}

/** Throws unless the conversation belongs to the account. */
async function ensureThread(owner: Owner, threadId: string): Promise<{ paused: boolean }> {
  const state = await threadState(owner, threadId);
  if (!state.exists) throw new Error("Conversation not found");
  return state;
}

export type DeleteThreadResult = { deleted: true; thread_id: string } | { deleted: false; reason: "not_found" | "title_mismatch" };

/**
 * Remove a conversation for good. The thread row goes, and the database
 * cascades to its messages, their delivery records, and both assistants'
 * per-conversation places. Nothing is archived; there is nothing to restore.
 * The caller must supply the exact title, the server-side half of the
 * warning the page shows. Stale held-reply seqs on the assistant rows are
 * pruned in the same transaction. A content-free removal receipt survives
 * until each assistant confirms permanent cleanup of its local session.
 */
export async function deleteThread(owner: Owner, threadId: string, confirmTitle: string): Promise<DeleteThreadResult> {
  // The receipt and cascading delete must commit together, including after retries.
  const args: Record<string, unknown> = { p_thread_id: threadId, p_confirm_title: confirmTitle };
  if (await accountsReady()) args.p_owner = owner;
  else if (owner !== null) throw new Error("Accounts need supabase/accounts.sql on this database");
  const { data, error } = await db().rpc("remove_board_conversation", args);
  if (error) throw new Error("Could not remove this conversation. Nothing has been confirmed deleted; try again.");
  return data as DeleteThreadResult;
}

export async function getMessages(owner: Owner, threadId: string, afterSeq = 0, limit = 300): Promise<Message[]> {
  await ensureThread(owner, threadId);
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
export async function readThread(owner: Owner, threadId: string, limit = 60, viewer?: Assistant): Promise<Message[]> {
  await ensureThread(owner, threadId);
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
export async function findCompare(owner: Owner, threadId: string, replyTo: string): Promise<Message | null> {
  if (!(await hasRounds())) return null;
  await ensureThread(owner, threadId);
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
  owner: Owner;
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
  // The conversation must be this account's. The person may keep writing in a
  // paused one (delivered on resume); an assistant caught mid-reply must not.
  const state = await ensureThread(input.owner, input.threadId);
  if (input.author !== "user" && state.paused) {
    throw new Error("This conversation is paused; assistants cannot post until it is resumed");
  }
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
      const existing = await findCompare(input.owner, input.threadId, input.replyTo);
      if (existing) return existing;
    }
    fail(error);
  }
  const msg = asMessage(data);
  if (input.author !== "user") {
    // A post means the assistant is no longer "working on" the message it read.
    // The read cursor is deliberately not moved here: doing so used to skip any
    // message that arrived between the assistant's last read and its post.
    await stampAssistant(input.owner, input.author, { last_posted_at: msg.created_at, working_on_seq: null });
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
  /** Present when the read was scoped to one thread. */
  thread_id?: string;
  /** True when the scoped conversation is paused: nothing was delivered and nothing was stamped. */
  paused?: boolean;
  /** True when the scoped conversation no longer exists (removed): stop serving it. */
  missing?: boolean;
  response_guidance?: string;
}

type Candidate = Message & { threads: { title: string; brief_audio: boolean; owner_id?: string | null } };
// Candidates join their thread for the title and audio preference, and for the
// owner when the accounts migration has run.
async function threadJoin(): Promise<string> {
  return (await accountsReady()) ? "threads!inner(title, brief_audio, owner_id)" : "threads!inner(title, brief_audio)";
}
async function candidateSelect(): Promise<string> {
  return `${await columns()}, ${await threadJoin()}`;
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

async function stampRead(owner: Owner, assistant: Assistant, forYou: { seq: number }[], extra: Record<string, unknown>) {
  // Reading a message addressed to this assistant marks it as being worked
  // on until the assistant posts; the page shows that instead of a blank wait.
  const stamp: Record<string, unknown> = { last_checked_at: new Date().toISOString(), ...extra };
  if (forYou.length) stamp.working_on_seq = forYou[forYou.length - 1].seq;
  await stampAssistant(owner, assistant, stamp);
}

/**
 * Everything an assistant has not read yet, across all of the account's
 * threads, oldest first, with for_you marking what it is expected to answer.
 * With the blind-round migration, delivery is tracked per message and the
 * other assistant's answer to an open round is withheld until this assistant
 * has answered it.
 */
export async function readNew(owner: Owner, assistant: Assistant, limit = 100, threadId?: string): Promise<NewForAssistant> {
  if (await hasRounds()) return readNewRounds(owner, assistant, limit, threadId);
  if (threadId) throw new Error("Reading one thread needs the blind-round migration (supabase/blind-rounds.sql and thread-sessions.sql)");
  return readNewLegacy(owner, assistant, limit);
}

/** Single-cursor delivery, for a database without the blind-round migration. */
async function readNewLegacy(owner: Owner, assistant: Assistant, limit: number): Promise<NewForAssistant> {
  const cur = await assistantRow(owner, assistant, "last_seen_seq");
  const cursor = Number(cur.last_seen_seq ?? 0);

  const scoped = await accountsReady();
  if (!scoped && owner !== null) throw new Error("Accounts need supabase/accounts.sql on this database");
  let query = db().from("messages").select(`${BASE_COLUMNS}, ${await threadJoin()}`).gt("seq", cursor).neq("author", assistant);
  if (scoped) query = owner === null ? query.is("threads.owner_id", null) : query.eq("threads.owner_id", owner);
  const { data, error } = await query.order("seq", { ascending: true }).limit(limit);
  if (error) fail(error);

  const messages = decorate(assistant, (data ?? []).map((r) => asMessage(r) as Candidate));
  const newCursor = messages.length ? messages[messages.length - 1].seq : cursor;
  const forYou = messages.filter((m) => m.for_you);
  await stampRead(owner, assistant, forYou, { last_seen_seq: newCursor });

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
 *
 * Unscoped, both values live on the account's assistant row and cover every
 * thread of the account. Scoped to one thread, they live in
 * assistant_thread_floors, one row per assistant and thread, so a session that
 * reads only its own conversation keeps its own place. Deliveries are shared
 * either way: a message reaches exactly one reader, so run every session
 * scoped, or one unscoped, not both.
 */
async function readNewRounds(owner: Owner, assistant: Assistant, limit: number, threadId?: string): Promise<NewForAssistant> {
  const select = await candidateSelect();
  const cur = await assistantRow(owner, assistant, "floor_seq, last_seen_seq, held_seqs");
  const lastSeenGlobal = Number(cur.last_seen_seq ?? 0);
  let floor = Number(cur.floor_seq ?? 0);
  let heldBefore = ((cur.held_seqs ?? []) as unknown[]).map(Number);
  if (threadId) {
    const state = await threadState(owner, threadId);
    // Removed (or not this account's): there is nothing to serve; tell the session to stop cleanly.
    if (!state.exists) return { messages: [], pending_for_you: 0, cursor: lastSeenGlobal, held_for_you: 0, thread_id: threadId, missing: true };
    // Paused: deliver nothing and move nothing, so resuming picks up
    // everything that arrived meanwhile, in order.
    if (state.paused) return { messages: [], pending_for_you: 0, cursor: lastSeenGlobal, held_for_you: 0, thread_id: threadId, paused: true };
  }
  if (threadId) {
    const { data: tf, error: tfErr } = await db()
      .from("assistant_thread_floors")
      .select("floor_seq, held_seqs")
      .eq("assistant", assistant)
      .eq("thread_id", threadId)
      .maybeSingle();
    if (tfErr) throw new Error(`Reading one thread needs supabase/thread-sessions.sql: ${tfErr.message}`);
    if (tf) {
      floor = Number(tf.floor_seq ?? 0);
      heldBefore = ((tf.held_seqs ?? []) as unknown[]).map(Number);
    } else {
      // First scoped read of this conversation: start from the unscoped
      // place, not zero. Everything at or below the global floor was
      // delivered or held before per-message rows existed, so starting at
      // zero would replay it. Only this conversation's held replies carry over.
      const { data: mine, error: mineErr } = await db().from("messages").select("seq").eq("thread_id", threadId).in("seq", heldBefore.length ? heldBefore : [-1]);
      if (mineErr) fail(mineErr);
      heldBefore = (mine ?? []).map((m) => Number(m.seq));
    }
  }

  // New candidates above the floor, plus everything previously held. A scoped
  // read scans a wider window because its floor starts at zero and must first
  // pass rows the unscoped reader may already have delivered.
  let query = db()
    .from("messages")
    .select(select)
    .gt("seq", floor)
    .neq("author", assistant);
  // A scoped read's thread was checked against the account above.
  if (threadId) query = query.eq("thread_id", threadId);
  else {
    const scoped = await accountsReady();
    if (!scoped && owner !== null) throw new Error("Accounts need supabase/accounts.sql on this database");
    if (scoped) query = owner === null ? query.is("threads.owner_id", null) : query.eq("threads.owner_id", owner);
  }
  const { data, error } = await query.order("seq", { ascending: true }).limit(limit + (threadId ? 500 : 200));
  if (error) fail(error);
  const candidates = (data ?? []).map((r) => asMessage(r) as Candidate);

  let heldRows: Candidate[] = [];
  const heldToFetch = heldBefore.filter((s) => !candidates.some((c) => c.seq === s));
  if (heldToFetch.length) {
    const { data: hd, error: hdErr } = await db().from("messages").select(select).in("seq", heldToFetch);
    if (hdErr) fail(hdErr);
    heldRows = (hd ?? []).map((r) => asMessage(r) as Candidate);
  }

  // Deliveries are keyed by message, and a message belongs to one account, so
  // only the candidates' own seqs matter here.
  const delivered = new Set<number>();
  if (candidates.length) {
    const { data: del, error: delErr } = await db().from("assistant_deliveries").select("seq").eq("assistant", assistant).in("seq", candidates.map((c) => c.seq));
    if (delErr) fail(delErr);
    for (const d of del ?? []) delivered.add(Number(d.seq));
  }

  const pool = [...candidates.filter((m) => !delivered.has(m.seq)), ...heldRows].sort((a, b) => a.seq - b.seq);

  // Round context for every thread that has a reply from the other assistant
  // or a compare request in the pool.
  const byThread = new Map<string, RoundMessage[]>();
  const threadIds = [...new Set(pool.filter((m) => m.author !== "user" || m.kind === "compare").map((m) => m.thread_id))];
  for (const tid of threadIds) {
    byThread.set(tid, await roundContext(tid, pool.filter((m) => m.thread_id === tid)));
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
  const newFloor = nextFloor(floor, candidates, delivered, held, outSeqs);

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
  const lastSeen = Math.max(lastSeenGlobal, ...out.map((m) => m.seq));
  if (threadId) {
    const { error: tfUpErr } = await db()
      .from("assistant_thread_floors")
      .upsert(
        { assistant, thread_id: threadId, floor_seq: Math.max(floor, newFloor), held_seqs: heldNow, last_checked_at: new Date().toISOString() },
        { onConflict: "assistant,thread_id" }
      );
    if (tfUpErr) fail(tfUpErr);
    await stampRead(owner, assistant, forYou, { last_seen_seq: lastSeen });
  } else {
    await stampRead(owner, assistant, forYou, { floor_seq: Math.max(floor, newFloor), last_seen_seq: lastSeen, held_seqs: heldNow });
  }

  return {
    messages: withContext,
    pending_for_you: forYou.length,
    cursor: lastSeen,
    held_for_you: held.size,
    ...(threadId ? { thread_id: threadId } : {}),
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

export async function assistantStatus(owner: Owner): Promise<AssistantStatus[]> {
  // select("*") so a database without the newer columns still answers.
  const scoped = await accountsReady();
  if (!scoped && owner !== null) throw new Error("Accounts need supabase/accounts.sql on this database");
  let query = db().from("assistants").select("*");
  if (scoped) query = owner === null ? query.is("owner_id", null) : query.eq("owner_id", owner);
  const { data, error } = await query;
  if (error) fail(error);
  return (data ?? []).map((a) => ({
    name: a.name,
    last_seen_seq: Number(a.last_seen_seq),
    last_checked_at: a.last_checked_at ?? null,
    last_posted_at: a.last_posted_at ?? null,
    working_on_seq: a.working_on_seq == null ? null : Number(a.working_on_seq),
  })) as AssistantStatus[];
}

/**
 * Lets an assistant re-read from a given point, e.g. after a lost reply.
 * With a thread, only that thread's deliveries and place are rewound.
 */
export async function rewind(owner: Owner, assistant: Assistant, toSeq: number, threadId?: string): Promise<void> {
  const to = Math.max(0, toSeq);
  if (await hasRounds()) {
    if (threadId) {
      await ensureThread(owner, threadId);
      const { data: seqs, error: seqErr } = await db().from("messages").select("seq").eq("thread_id", threadId).gte("seq", to);
      if (seqErr) fail(seqErr);
      const list = (seqs ?? []).map((s) => Number(s.seq));
      if (list.length) {
        const { error } = await db().from("assistant_deliveries").delete().eq("assistant", assistant).in("seq", list);
        if (error) fail(error);
      }
      const { data: tf } = await db().from("assistant_thread_floors").select("floor_seq, held_seqs").eq("assistant", assistant).eq("thread_id", threadId).maybeSingle();
      const held = ((tf?.held_seqs ?? []) as unknown[]).map(Number).filter((s) => s < to);
      const { error: upErr } = await db()
        .from("assistant_thread_floors")
        .upsert({ assistant, thread_id: threadId, floor_seq: Math.min(Number(tf?.floor_seq ?? 0), Math.max(0, to - 1)), held_seqs: held }, { onConflict: "assistant,thread_id" });
      if (upErr) fail(upErr);
      return;
    }
    // Only this account's messages: deliveries are keyed by message.
    const scoped = await accountsReady();
    if (!scoped && owner !== null) throw new Error("Accounts need supabase/accounts.sql on this database");
    let seqQuery = db().from("messages").select(`seq, ${await threadJoin()}`).gte("seq", to);
    if (scoped) seqQuery = owner === null ? seqQuery.is("threads.owner_id", null) : seqQuery.eq("threads.owner_id", owner);
    const { data: seqs, error: seqErr } = await seqQuery;
    if (seqErr) fail(seqErr);
    const list = (seqs ?? []).map((s) => Number((s as unknown as { seq: unknown }).seq));
    if (list.length) {
      const { error } = await db().from("assistant_deliveries").delete().eq("assistant", assistant).in("seq", list);
      if (error) fail(error);
    }
    const cur = await assistantRow(owner, assistant, "floor_seq, held_seqs");
    const held = ((cur.held_seqs ?? []) as unknown[]).map(Number).filter((s) => s < to);
    await stampAssistant(owner, assistant, {
      last_seen_seq: to,
      floor_seq: Math.min(Number(cur.floor_seq ?? 0), Math.max(0, to - 1)),
      held_seqs: held,
    });
    return;
  }
  await stampAssistant(owner, assistant, { last_seen_seq: to });
}
