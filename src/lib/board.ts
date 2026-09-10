import { db } from "./db";
import type { Assistant } from "./agent-auth";
import { BRIEF_AUDIO_GUIDANCE, normalizeSpokenReply } from "./spoken-reply";

export type Author = "user" | Assistant;
export type Audience = "both" | Assistant | "none";

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
}

const MESSAGE_COLUMNS = "seq, id, thread_id, author, addressed_to, body, spoken_summary, reply_to, created_at";

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? "Database error");
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
    .select(MESSAGE_COLUMNS)
    .eq("thread_id", threadId)
    .gt("seq", afterSeq)
    .order("seq", { ascending: true })
    .limit(limit);
  if (error) fail(error);
  return (data ?? []) as Message[];
}

/** The latest messages of a thread, oldest first, without moving any cursor. */
export async function readThread(threadId: string, limit = 60): Promise<Message[]> {
  const { data, error } = await db()
    .from("messages")
    .select(MESSAGE_COLUMNS)
    .eq("thread_id", threadId)
    .order("seq", { ascending: false })
    .limit(limit);
  if (error) fail(error);
  return ((data ?? []) as Message[]).reverse();
}

export async function postMessage(input: {
  threadId: string;
  author: Author;
  addressedTo?: Audience;
  body: string;
  replyTo?: string | null;
  spokenSummary?: string | null;
}): Promise<Message> {
  const { body, spoken_summary } = input.author === "user"
    ? { body: input.body.trim(), spoken_summary: null }
    : normalizeSpokenReply(input.body, input.spokenSummary);
  if (!body) throw new Error("Empty message");
  const addressed_to: Audience = input.addressedTo ?? (input.author === "user" ? "both" : "none");
  const { data, error } = await db()
    .from("messages")
    .insert({ thread_id: input.threadId, author: input.author, addressed_to, body, spoken_summary, reply_to: input.replyTo ?? null })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error) fail(error);
  const msg = data as Message;
  if (input.author !== "user") {
    // An assistant has seen everything up to its own post.
    const { data: cur } = await db().from("assistants").select("last_seen_seq").eq("name", input.author).single();
    const seen = Math.max(Number(cur?.last_seen_seq ?? 0), msg.seq);
    await db()
      .from("assistants")
      .update({ last_posted_at: msg.created_at, last_seen_seq: seen })
      .eq("name", input.author);
  }
  return msg;
}

export interface NewForAssistant {
  messages: (Message & { for_you: boolean; thread_title: string; voice_mode: boolean; audio_preference: "brief" | "full" })[];
  pending_for_you: number;
  cursor: number;
  response_guidance?: string;
}

/**
 * Everything an assistant has not read yet, across all threads, oldest first,
 * with for_you marking what it is expected to answer. Advances the cursor and
 * stamps last_checked_at, so the page can show the assistant is alive.
 */
export async function readNew(assistant: Assistant, limit = 100): Promise<NewForAssistant> {
  const { data: cur, error: curErr } = await db().from("assistants").select("last_seen_seq").eq("name", assistant).single();
  if (curErr) fail(curErr);
  const cursor = Number(cur?.last_seen_seq ?? 0);

  const { data, error } = await db()
    .from("messages")
    .select(`${MESSAGE_COLUMNS}, threads!inner(title, brief_audio)`)
    .gt("seq", cursor)
    .neq("author", assistant)
    .order("seq", { ascending: true })
    .limit(limit);
  if (error) fail(error);

  const rows = (data ?? []) as unknown as (Message & { threads: { title: string; brief_audio: boolean } })[];
  const messages = rows.map(({ threads, ...m }) => ({
    ...m,
    thread_title: threads.title,
    voice_mode: threads.brief_audio,
    audio_preference: threads.brief_audio ? "brief" as const : "full" as const,
    for_you: m.author === "user" && (m.addressed_to === "both" || m.addressed_to === assistant),
  }));
  const newCursor = messages.length ? messages[messages.length - 1].seq : cursor;

  await db()
    .from("assistants")
    .update({ last_seen_seq: newCursor, last_checked_at: new Date().toISOString() })
    .eq("name", assistant);

  return { messages, pending_for_you: messages.filter((m) => m.for_you).length, cursor: newCursor,
    ...(messages.some((m) => m.for_you && m.voice_mode) ? { response_guidance: BRIEF_AUDIO_GUIDANCE } : {}),
  };
}

export async function assistantStatus(): Promise<AssistantStatus[]> {
  const { data, error } = await db().from("assistants").select("name, last_seen_seq, last_checked_at, last_posted_at");
  if (error) fail(error);
  return (data ?? []).map((a) => ({ ...a, last_seen_seq: Number(a.last_seen_seq) })) as AssistantStatus[];
}

/** Lets an assistant re-read from a given point, e.g. after a lost reply. */
export async function rewind(assistant: Assistant, toSeq: number): Promise<void> {
  const { error } = await db().from("assistants").update({ last_seen_seq: Math.max(0, toSeq) }).eq("name", assistant);
  if (error) fail(error);
}
