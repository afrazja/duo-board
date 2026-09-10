import test from "node:test";
import assert from "node:assert/strict";
import { SpeechPlayback, chooseVoice, chooseVoicePair, chunkSizeForRate, audioContent, speechChunks, speechText } from "../src/lib/speech-playback.ts";
import { normalizeSpokenReply } from "../src/lib/spoken-reply.ts";

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
  assert.equal(speechText("# Summary\n**Hello**, [world](https://example.com).\n```js\nalert('private code');\n```\n- Finished."), "Summary. Hello, world. Code block skipped. Finished.");
  assert.equal(speechText("| Name | Value |\n| --- | --- |\n| A | 1 |"), "Name, Value. A, 1.");
  assert.equal(speechText("```some inline code```"), "Code block skipped.");
  assert.ok(!speechText("Read https://example.com/long-path").includes("https"));
});
test("Unknown automatic voices stay distinct without overriding explicit choices", () => {
  const unknown = voices.map((voice, index) => ({ ...voice, name: `Voice ${index}` }));
  const automatic = chooseVoicePair(unknown, { claude: "", chatgpt: "" }, "Hello");
  assert.notEqual(automatic.claude.voiceURI, automatic.chatgpt.voiceURI);
  const explicit = chooseVoicePair(unknown, { claude: "david", chatgpt: "david" }, "Hello");
  assert.equal(explicit.claude.voiceURI, "david");
  assert.equal(explicit.chatgpt.voiceURI, "david");
  const oneExplicit = chooseVoicePair(unknown, { claude: "", chatgpt: "david" }, "Hello");
  assert.equal(oneExplicit.chatgpt.voiceURI, "david");
  assert.notEqual(oneExplicit.claude.voiceURI, "david");
  const single = chooseVoicePair([unknown[0]], { claude: "", chatgpt: "" }, "Hello");
  assert.equal(single.claude.voiceURI, single.chatgpt.voiceURI);
});
test("Slow playback shortens chunks, and fast playback keeps the conservative cap", () => {
  assert.equal(chunkSizeForRate(0.75), 195);
  assert.equal(chunkSizeForRate(1), 260);
  assert.equal(chunkSizeForRate(2), 260);
  const { player, spoken } = setup();
  player.setRate(0.75);
  player.play(message("slow", "claude", "A long answer. ".repeat(100)));
  assert.ok(spoken.at(-1).text.length <= 195);
});
test("Headings have a pause without doubling existing punctuation", () => {
  assert.equal(speechText("## **Summary**\nHello.\n### Why?\nBecause."), "Summary. Hello. Why? Because.");
});
test("Activation is labelled as a system announcement", () => {
  const { player, spoken } = setup();
  player.setMode("voice-text");
  assert.equal(player.getSnapshot().current.author, "system");
  assert.ok(spoken[0].text.startsWith("Duo Board."));
  assert.ok(!spoken[0].text.includes("ChatGPT"));
});
test("Brief playback uses the supplied summary and full playback retains every detail", () => {
  const { player, spoken } = setup();
  const reply = { ...message("brief", "claude", "Full answer with a detailed explanation."), spoken_summary: "The short answer." };
  player.setBrief(true);
  player.play(reply);
  assert.equal(player.getSnapshot().current.kind, "brief");
  assert.match(spoken.at(-1).text, /The short answer/);
  assert.ok(!spoken.at(-1).text.includes("detailed explanation"));
  player.play(reply, true);
  assert.equal(player.getSnapshot().current.kind, "full");
  assert.match(spoken.at(-1).text, /detailed explanation/);
  const fallback = audioContent(message("old", "chatgpt", "Old answer. ".repeat(200)), true);
  assert.equal(fallback.kind, "excerpt");
  assert.ok(fallback.text.startsWith("Opening excerpt."));
  assert.ok(fallback.text.length < 550);
});
test("Older MCP clients can supply a summary prefix without losing the full answer", () => {
  assert.deepEqual(normalizeSpokenReply("<spoken_summary>Short version.</spoken_summary>\n\n# Full answer\nAll details."), { body: "# Full answer\nAll details.", spoken_summary: "Short version." });
  assert.deepEqual(normalizeSpokenReply("Full answer", "Short version"), { body: "Full answer", spoken_summary: "Short version" });
  assert.deepEqual(normalizeSpokenReply("Full answer"), { body: "Full answer", spoken_summary: null });
  assert.throws(() => normalizeSpokenReply("Answer", "a".repeat(1201)), /1200/);
  assert.throws(() => normalizeSpokenReply("", "Short"), /full written answer/);
  assert.throws(() => normalizeSpokenReply("<spoken_summary>Only a summary</spoken_summary>"), /full written answer/);
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
