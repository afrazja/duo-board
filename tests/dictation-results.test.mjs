import test from "node:test";
import assert from "node:assert/strict";
import { DictationResultTracker } from "../src/lib/dictation-results.ts";

const result = (transcript, isFinal = true) => ({ 0: { transcript }, isFinal, length: 1 });

test("mobile replays of finalized result indexes are emitted only once", () => {
  const tracker = new DictationResultTracker();

  assert.deepEqual(tracker.consume(0, [result("hello")]), { final: "hello", interim: "" });
  assert.deepEqual(tracker.consume(0, [result("hello"), result("world")]), { final: "world", interim: "" });
  assert.deepEqual(tracker.consume(0, [result("hello"), result("world")]), { final: "", interim: "" });
  assert.deepEqual(tracker.consume(1, [result("hello"), result("world"), result("again")]), { final: "again", interim: "" });
});

test("a cumulative mobile transcript at new indexes emits only new words", () => {
  const tracker = new DictationResultTracker();

  assert.equal(tracker.consume(0, [result("this")]).final, "this");
  assert.equal(tracker.consume(1, [result("ignored"), result("this is")]).final, "is");
  assert.equal(tracker.consume(2, [result("ignored"), result("ignored"), result("this is only")]).final, "only");
  assert.equal(tracker.consume(3, [result("ignored"), result("ignored"), result("ignored"), result("this is only for test")]).final, "for test");
});

test("a finalized result that grows at the same index emits only its new suffix", () => {
  const tracker = new DictationResultTracker();

  assert.equal(tracker.consume(0, [result("turn on")]).final, "turn on");
  assert.equal(tracker.consume(0, [result("turn on the lights")]).final, "the lights");
});

test("automatic resume keeps overlap history while accepting fresh result indexes", () => {
  const tracker = new DictationResultTracker();

  assert.equal(tracker.consume(0, [result("I miss")]).final, "I miss");
  tracker.resume();
  assert.equal(tracker.consume(0, [result("I miss speaking")]).final, "speaking");
  tracker.resume();
  assert.equal(tracker.consume(0, [result("so much")]).final, "so much");
});

test("separate one-word results can intentionally repeat a word", () => {
  const tracker = new DictationResultTracker();

  assert.equal(tracker.consume(0, [result("very")]).final, "very");
  assert.equal(tracker.consume(1, [result("ignored"), result("very")]).final, "very");
});

test("interim text stays visible without being marked as finalized", () => {
  const tracker = new DictationResultTracker();

  assert.deepEqual(tracker.consume(0, [result("hello", false)]), { final: "", interim: "hello" });
  assert.deepEqual(tracker.consume(0, [result("hello")]), { final: "hello", interim: "" });
});

test("a new manual dictation session can repeat the same words", () => {
  const tracker = new DictationResultTracker();

  assert.equal(tracker.consume(0, [result("yes")]).final, "yes");
  tracker.reset();
  assert.equal(tracker.consume(0, [result("yes")]).final, "yes");
});
