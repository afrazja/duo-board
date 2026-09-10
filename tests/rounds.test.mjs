import test from "node:test";
import assert from "node:assert/strict";
import { hasAnswered, questionFor, withheldFrom, STALE_ROUND_MS } from "../src/lib/rounds.ts";

const T0 = Date.parse("2026-09-10T12:00:00Z");
let seq = 0;
const msg = (author, opts = {}) => ({
  seq: ++seq,
  id: opts.id ?? `m${seq}`,
  thread_id: opts.thread ?? "t1",
  author,
  addressed_to: opts.to ?? (author === "user" ? "both" : "none"),
  reply_to: opts.replyTo ?? null,
  created_at: new Date(opts.at ?? T0 + seq * 1000).toISOString(),
});
const byThread = (...msgs) => {
  const map = new Map();
  for (const m of msgs) map.set(m.thread_id, [...(map.get(m.thread_id) ?? []), m]);
  return map;
};

test("questionFor finds the latest person's message before a reply, in the same thread", () => {
  seq = 0;
  const q1 = msg("user", { id: "q1" });
  const q2 = msg("user", { id: "q2" });
  const other = msg("user", { id: "qx", thread: "t2" });
  const reply = msg("chatgpt");
  assert.equal(questionFor(reply, [q1, q2, other, reply])?.id, "q2");
  assert.equal(questionFor(q1, [q1, q2]), null);
});

test("ChatGPT's answer is withheld from Claude until Claude answers with reply_to", () => {
  seq = 0;
  const q = msg("user", { id: "q" });
  const gpt = msg("chatgpt", { replyTo: "q" });
  assert.deepEqual([...withheldFrom("claude", [gpt], byThread(q, gpt), T0 + 60_000)], [gpt.seq]);
  const mine = msg("claude", { replyTo: "q" });
  assert.deepEqual([...withheldFrom("claude", [gpt], byThread(q, gpt, mine), T0 + 60_000)], []);
});

test("Questions to one assistant alone never withhold", () => {
  seq = 0;
  const q = msg("user", { id: "q", to: "chatgpt" });
  const gpt = msg("chatgpt", { replyTo: "q" });
  assert.deepEqual([...withheldFrom("claude", [gpt], byThread(q, gpt), T0 + 60_000)], []);
});

test("A progress note without reply_to does not count as an answer", () => {
  seq = 0;
  const q = msg("user", { id: "q" });
  const note = msg("claude");
  const gpt = msg("chatgpt", { replyTo: "q" });
  assert.equal(hasAnswered("claude", q, [q, note, gpt], T0 + 60_000), false);
  assert.deepEqual([...withheldFrom("claude", [gpt], byThread(q, note, gpt), T0 + 60_000)], [gpt.seq]);
});

test("Answering a later question in the thread counts as having moved on", () => {
  seq = 0;
  const q1 = msg("user", { id: "q1" });
  const gpt1 = msg("chatgpt", { replyTo: "q1" });
  const q2 = msg("user", { id: "q2" });
  const mine2 = msg("claude", { replyTo: "q2" });
  assert.equal(hasAnswered("claude", q1, [q1, gpt1, q2, mine2], T0 + 60_000), true);
  assert.deepEqual([...withheldFrom("claude", [gpt1], byThread(q1, gpt1, q2, mine2), T0 + 60_000)], []);
});

test("A stale round stops withholding after the safety-valve window", () => {
  seq = 0;
  const q = msg("user", { id: "q", at: T0 });
  const gpt = msg("chatgpt", { replyTo: "q", at: T0 + 1000 });
  assert.deepEqual([...withheldFrom("claude", [gpt], byThread(q, gpt), T0 + STALE_ROUND_MS - 1)], [gpt.seq]);
  assert.deepEqual([...withheldFrom("claude", [gpt], byThread(q, gpt), T0 + STALE_ROUND_MS + 1)], []);
});

test("The person's messages and one's own posts are never withheld", () => {
  seq = 0;
  const q = msg("user", { id: "q" });
  const mine = msg("claude", { replyTo: "q" });
  const q2 = msg("user", { id: "q2" });
  assert.deepEqual([...withheldFrom("claude", [q, mine, q2], byThread(q, mine, q2), T0 + 60_000)], []);
});

test("A compare request starts a new blind round of its own", () => {
  seq = 0;
  const q = msg("user", { id: "q" });
  const gpt = msg("chatgpt", { replyTo: "q" });
  const mine = msg("claude", { replyTo: "q" });
  const compare = msg("user", { id: "c" });
  const gptCompare = msg("chatgpt", { replyTo: "c" });
  const thread = byThread(q, gpt, mine, compare, gptCompare);
  assert.deepEqual([...withheldFrom("claude", [gpt, gptCompare], thread, T0 + 60_000)], [gptCompare.seq]);
});

test("Threads are independent: a reply in one thread is judged against that thread's question", () => {
  seq = 0;
  const qA = msg("user", { id: "qA", thread: "A" });
  const qB = msg("user", { id: "qB", thread: "B" });
  const mineA = msg("claude", { replyTo: "qA", thread: "A" });
  const gptB = msg("chatgpt", { replyTo: "qB", thread: "B" });
  assert.deepEqual([...withheldFrom("claude", [gptB], byThread(qA, qB, mineA, gptB), T0 + 60_000)], [gptB.seq]);
});
