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

test("a finalized result that grows emits only its new suffix", () => {
  const tracker = new DictationResultTracker();

  assert.equal(tracker.consume(0, [result("turn on")]).final, "turn on");
  assert.equal(tracker.consume(0, [result("turn on the lights")]).final, "the lights");
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
