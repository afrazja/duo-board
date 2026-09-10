import test from "node:test";
import assert from "node:assert/strict";
import { SpeechPlayback, chooseVoice, speechChunks, speechText } from "../src/lib/speech-playback.ts";

const voices = [
  { name: "Microsoft David", voiceURI: "david", lang: "en-US", default: true, localService: true },
  { name: "Microsoft Zira", voiceURI: "zira", lang: "en-US", default: false, localService: true },
];
const message = (id, author = "claude", body = "A short answer.", thread = "one", time = Date.now() + 1000) => ({ id, author, body, thread_id: thread, created_at: new Date(time).toISOString() });
function setup(saved) {
  const spoken = [];
  const calls = [];
  const port = { speak: (u) => spoken.push(u), cancel: () => calls.push("cancel"), pause: () => calls.push("pause"), resume: () => calls.push("resume"), getVoices: () => voices, addEventListener() {}, removeEventListener() {} };
  const player = new SpeechPlayback();
  player.connect(port, (text) => ({ text }), { getItem: () => saved ?? null, setItem() {} });
  player.setThread("one");
  const end = () => spoken.at(-1).onend();
  return { player, spoken, calls, end };
}

test("Markdown is spoken as prose and fenced code is skipped", () => {
  assert.equal(speechText("# Summary\n**Hello**, [world](https://example.com).\n```js\nalert('private code');\n```\n- Finished."), "Summary Hello, world. Code block skipped. Finished.");
  assert.equal(speechText("| Name | Value |\n| --- | --- |\n| A | 1 |"), "Name, Value. A, 1.");
  assert.equal(speechText("```some inline code```"), "Code block skipped.");
  assert.ok(!speechText("Read https://example.com/long-path").includes("https"));
});
test("Long answers are split without losing words", () => {
  const text = "A sentence worth hearing. ".repeat(100).trim();
  const chunks = speechChunks(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 260));
  assert.equal(chunks.join(" "), text);
});
test("Voice defaults distinguish assistants and honour a chosen voice", () => {
  assert.equal(chooseVoice(voices, "claude", "", "Hello").voiceURI, "zira");
  assert.equal(chooseVoice(voices, "chatgpt", "", "Hello").voiceURI, "david");
  assert.equal(chooseVoice(voices, "claude", "david", "Hello").voiceURI, "david");
  assert.equal(chooseVoice(voices, "claude", "", "سلام"), undefined);
});
test("New replies queue in arrival order; history, user messages and duplicates do not play", () => {
  const { player, spoken, end } = setup();
  player.setMode("voice-text"); end();
  player.ingest([message("old", "claude", "History", "one", 0), message("user", "user"), message("a"), message("b", "chatgpt")]);
  player.ingest([message("a"), message("b", "chatgpt")]);
  assert.equal(spoken.length, 2);
  assert.equal(spoken.at(-1).voice.voiceURI, "zira");
  assert.equal(player.getSnapshot().queued, 1);
  end();
  assert.equal(spoken.at(-1).voice.voiceURI, "david");
  end();
  assert.equal(player.getSnapshot().current, null);
});
test("Stopping cancels every chunk; late browser callbacks cannot restart the queue", () => {
  const { player, spoken, end } = setup();
  player.play(message("long", "claude", "Words and sentences. ".repeat(100)));
  const stale = spoken.at(-1);
  player.stop();
  player.play(message("new", "chatgpt"));
  stale.onend(); stale.onerror({ error: "canceled" });
  assert.equal(spoken.length, 2);
  assert.equal(player.getSnapshot().current.id, "new");
  end();
  assert.equal(player.getSnapshot().current, null);
});
test("Server time prevents an incorrect device clock from replaying history", () => {
  const { player, spoken, end } = setup();
  player.setMode("voice-text"); end();
  const serverTime = Date.now() + 86400000;
  player.ingest([message("old", "claude", "History", "one", serverTime - 60000), message("new", "chatgpt", "New reply", "one", serverTime + 1000)], new Date(serverTime).toISOString());
  assert.equal(spoken.length, 2);
  assert.equal(player.getSnapshot().current.id, "new");
});
test("Skip skips an entire long reply, including its remaining chunks", () => {
  const { player, spoken, end } = setup();
  player.setMode("voice-text"); end();
  player.ingest([message("a", "claude", "Long answer. ".repeat(100)), message("b", "chatgpt")]);
  player.skip();
  assert.equal(player.getSnapshot().current.id, "b");
  assert.ok(spoken.at(-1).text.startsWith("ChatGPT."));
});
test("Manual pause survives microphone changes; thread switches cancel old audio", () => {
  const { player, calls } = setup();
  player.play(message("a"));
  player.togglePause();
  player.setMicrophoneActive(true);
  player.setMicrophoneActive(false);
  assert.equal(player.getSnapshot().paused, true);
  player.togglePause();
  assert.equal(player.getSnapshot().paused, false);
  assert.ok(calls.includes("pause"));
  player.setThread("two");
  assert.equal(player.getSnapshot().current, null);
  player.ingest([message("wrong-thread")]);
  assert.equal(player.getSnapshot().current, null);
});
test("Skipping a paused reply keeps the next reply resumable", () => {
  const { player, end } = setup();
  player.setMode("voice-text"); end();
  player.ingest([message("a"), message("b", "chatgpt")]);
  player.togglePause();
  player.skip();
  assert.equal(player.getSnapshot().paused, true);
  assert.equal(player.getSnapshot().current.id, "b");
  player.togglePause();
  end();
  assert.equal(player.getSnapshot().current, null);
});
test("Voice settings survive reload but automatic playback needs a fresh click", () => {
  const { player } = setup(JSON.stringify({ mode: "voice-focus", rate: 1.5, claude: "zira", chatgpt: "david" }));
  assert.equal(player.getSnapshot().mode, "voice-focus");
  assert.equal(player.getSnapshot().rate, 1.5);
  assert.equal(player.getSnapshot().enabled, false);
});
test("Corrupt settings and audio failures leave text available with a useful error", () => {
  const { player, spoken } = setup("not json");
  assert.equal(player.getSnapshot().mode, "text");
  player.play(message("a"));
  spoken.at(-1).onerror({ error: "not-allowed" });
  assert.match(player.getSnapshot().error, /blocked/);
  assert.equal(player.getSnapshot().current, null);
  assert.equal(player.getSnapshot().enabled, false);
});
