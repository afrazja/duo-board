export type Speaker = "claude" | "chatgpt";
export type PlaybackSpeaker = Speaker | "system";
export type VoiceMode = "text" | "voice-text" | "voice-focus";
export interface SpokenMessage {
  id: string;
  author: string;
  body: string;
  created_at: string;
  thread_id: string;
  spoken_summary?: string | null;
}

export function speechText(markdown: string): string {
  return markdown
    .replace(/```(?:[^\n`]*\n)?[\s\S]*?(?:```|$)/g, " Code block skipped. ")
    .replace(/~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, " Code block skipped. ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "")
    .replace(/^\s*\|(.+)\|\s*$/gm, (_, row: string) => `${row.split("|").map((cell) => cell.trim()).filter(Boolean).join(", ")}. `)
    .replace(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/gm, (_, heading: string) => {
      const clean = heading.replace(/[*_`]/g, "").trim();
      return /[.!?;:…]$/.test(clean) ? clean : `${clean}.`;
    })
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s*\|\s*/g, ", ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Small utterances avoid browsers stalling partway through a long answer.
export function speechChunks(text: string, size = 260): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > size) {
    const head = remaining.slice(0, size + 1);
    const sentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
    const space = head.lastIndexOf(" ");
    const end = sentenceEnd > size / 3 ? sentenceEnd + 1 : space > 0 ? space : size;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function chooseVoice(voices: SpeechSynthesisVoice[], speaker: Speaker, preferred: string, text: string, avoid?: string) {
  const saved = voices.find((v) => v.voiceURI === preferred);
  if (saved) return saved;
  const language = /[\u0600-\u06ff]/.test(text) ? "fa" : "en";
  const allMatching = voices.filter((v) => v.lang.toLowerCase().startsWith(language));
  const distinct = allMatching.filter((v) => v.voiceURI !== avoid);
  const matching = distinct.length ? distinct : allMatching;
  const names = speaker === "claude"
    ? /zira|aria|jenny|samantha|karen|moira|victoria|susan|hazel|female/i
    : /david|guy|mark|daniel|alex\b|george|james|thomas|\bmale\b/i;
  return matching.find((v) => names.test(v.name)) ?? matching.find((v) => v.default) ?? matching[0];
}

export function chooseVoicePair(voices: SpeechSynthesisVoice[], preferred: { claude: string; chatgpt: string }, text: string) {
  if (preferred.chatgpt && voices.some((v) => v.voiceURI === preferred.chatgpt) && !voices.some((v) => v.voiceURI === preferred.claude)) {
    const chatgpt = chooseVoice(voices, "chatgpt", preferred.chatgpt, text);
    return { chatgpt, claude: chooseVoice(voices, "claude", preferred.claude, text, chatgpt?.voiceURI) };
  }
  const claude = chooseVoice(voices, "claude", preferred.claude, text);
  return { claude, chatgpt: chooseVoice(voices, "chatgpt", preferred.chatgpt, text, claude?.voiceURI) };
}

export function chunkSizeForRate(rate: number) {
  return Math.max(80, Math.floor(260 * Math.min(1, rate)));
}

export function audioContent(message: SpokenMessage, brief: boolean) {
  if (!brief) return { text: speechText(message.body), kind: "full" as const };
  if (message.spoken_summary?.trim()) return { text: speechText(message.spoken_summary), kind: "brief" as const };
  const excerpt = speechChunks(speechText(message.body), 420)[0] ?? "";
  return { text: excerpt ? `Opening excerpt. ${excerpt} Select Listen to full reply for the complete answer.` : "", kind: "excerpt" as const };
}

interface Preferences {
  mode: VoiceMode;
  rate: number;
  claude: string;
  chatgpt: string;
}
export interface PlaybackSnapshot extends Preferences {
  supported: boolean;
  voices: SpeechSynthesisVoice[];
  enabled: boolean;
  current: { id: string; author: PlaybackSpeaker; kind: "full" | "brief" | "excerpt" | "system" } | null;
  queued: number;
  paused: boolean;
  microphoneActive: boolean;
  error: string;
  brief: boolean;
}
const DEFAULTS: Preferences = { mode: "text", rate: 1, claude: "", chatgpt: "" };
const PREF_KEY = "duo_voice_preferences_v1";
const NAMES = { claude: "Claude", chatgpt: "ChatGPT", system: "Duo Board" };
type SpeechPort = Pick<SpeechSynthesis, "speak" | "cancel" | "pause" | "resume" | "getVoices" | "addEventListener" | "removeEventListener">;
interface Item { id: string; author: PlaybackSpeaker; kind: "full" | "brief" | "excerpt" | "system"; chunks: string[]; index: number; voice: SpeechSynthesisVoice; rate: number }

export class SpeechPlayback {
  private snapshot: PlaybackSnapshot = { ...DEFAULTS, supported: false, voices: [], enabled: false, current: null, queued: 0, paused: false, microphoneActive: false, error: "", brief: false };
  private listeners = new Set<() => void>();
  private port: SpeechPort | null = null;
  private createUtterance: ((text: string) => SpeechSynthesisUtterance) | null = null;
  private storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  private queue: Item[] = [];
  private current: Item | null = null;
  private utterance: SpeechSynthesisUtterance | null = null;
  private generation = 0;
  private manualPause = false;
  private threadId: string | null = null;
  private startedAt = Infinity;
  private seen = new Set<string>();

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<PlaybackSnapshot> = {}) {
    this.snapshot = { ...this.snapshot, ...patch, current: this.current && { id: this.current.id, author: this.current.author, kind: this.current.kind }, queued: this.queue.length, paused: this.manualPause || this.snapshot.microphoneActive };
    this.listeners.forEach((listener) => listener());
  }
  private refreshVoices = () => this.update({ voices: this.port?.getVoices() ?? [] });

  connect(port: SpeechPort, createUtterance: (text: string) => SpeechSynthesisUtterance, storage?: Pick<Storage, "getItem" | "setItem">) {
    this.port = port;
    this.createUtterance = createUtterance;
    this.storage = storage;
    let prefs = DEFAULTS;
    try {
      const saved = JSON.parse(storage?.getItem(PREF_KEY) ?? "null");
      if (saved) prefs = {
        mode: ["text", "voice-text", "voice-focus"].includes(saved.mode) ? saved.mode : "text",
        rate: [0.75, 1, 1.25, 1.5, 2].includes(saved.rate) ? saved.rate : 1,
        claude: typeof saved.claude === "string" ? saved.claude : "",
        chatgpt: typeof saved.chatgpt === "string" ? saved.chatgpt : "",
      };
    } catch { /* Storage may be blocked; playback still works for this visit. */ }
    this.update({ ...prefs, supported: true, enabled: false, voices: port.getVoices() });
    port.addEventListener("voiceschanged", this.refreshVoices);
    return () => {
      port.removeEventListener("voiceschanged", this.refreshVoices);
      this.clear();
      this.port = null;
    };
  }
  private save(patch: Partial<Preferences>) {
    this.update(patch);
    const { mode, rate, claude, chatgpt } = this.snapshot;
    try { this.storage?.setItem(PREF_KEY, JSON.stringify({ mode, rate, claude, chatgpt })); } catch {}
  }
  setVoice(speaker: Speaker, uri: string) { this.save({ [speaker]: uri }); }
  setBrief(brief: boolean) { if (brief !== this.snapshot.brief) this.update({ brief }); }
  setRate(rate: number) { if ([0.75, 1, 1.25, 1.5, 2].includes(rate)) this.save({ rate }); }
  setMode(mode: VoiceMode) {
    this.save({ mode });
    if (mode === "text") this.stop();
    else this.enable();
  }
  enable() {
    if (!this.port || !this.snapshot.voices.length || this.snapshot.microphoneActive) return;
    this.startedAt = Date.now();
    this.update({ enabled: true, error: "" });
    // Called by a click, giving browsers the interaction needed to allow audio.
    this.clear();
    const voice = this.snapshot.voices.find((v) => v.default) ?? this.snapshot.voices[0];
    this.queue.push({ id: "system-voice-enabled", author: "system", kind: "system", voice, rate: this.snapshot.rate, chunks: ["Duo Board. Voice playback is on. New replies will play aloud."], index: 0 });
    this.run();
  }
  setThread(threadId: string | null) {
    if (this.threadId === threadId) return;
    this.clear();
    this.threadId = threadId;
    this.seen.clear();
    this.startedAt = this.snapshot.enabled ? Date.now() : Infinity;
  }
  ingest(messages: SpokenMessage[], serverNow?: string) {
    const serverTime = Date.parse(serverNow ?? "");
    const clockOffset = Number.isFinite(serverTime) ? serverTime - Date.now() : 0;
    for (const message of messages) {
      if (message.thread_id !== this.threadId || this.seen.has(message.id)) continue;
      this.seen.add(message.id);
      if (this.snapshot.enabled && Date.parse(message.created_at) >= this.startedAt + clockOffset) this.add(message);
    }
  }
  play(message: SpokenMessage, full = false) { this.clear(); this.add(message, full); }
  preview(speaker: Speaker, text = `Hello. This is ${NAMES[speaker]}'s voice.`) {
    this.play({ id: `preview-${speaker}`, author: speaker, body: text, created_at: "", thread_id: this.threadId ?? "" }, true);
  }
  private add(message: SpokenMessage, full = false) {
    if (!this.port || (message.author !== "claude" && message.author !== "chatgpt")) return;
    if (this.current?.id === message.id || this.queue.some((item) => item.id === message.id)) return;
    const { text, kind } = audioContent(message, this.snapshot.brief && !full);
    if (!text) return;
    const voice = chooseVoicePair(this.snapshot.voices, this.snapshot, text)[message.author];
    if (!voice) {
      this.update({ error: /[\u0600-\u06ff]/.test(text) ? "No Persian voice is available. Choose an installed voice in Voice settings, or read the text." : "No English voice is available. Choose a voice in Voice settings." });
      return;
    }
    this.queue.push({ id: message.id, author: message.author, kind, chunks: speechChunks(`${NAMES[message.author]}. ${text}`, chunkSizeForRate(this.snapshot.rate)), index: 0, voice, rate: this.snapshot.rate });
    this.update({ error: "" });
    this.run();
  }
  private run() {
    if (!this.port || !this.createUtterance || this.utterance || this.manualPause || this.snapshot.microphoneActive) return;
    if (!this.current) this.current = this.queue.shift() ?? null;
    this.update();
    const item = this.current;
    if (!item) return;
    const generation = this.generation;
    const utterance = this.createUtterance(item.chunks[item.index]);
    this.utterance = utterance;
    utterance.voice = item.voice;
    utterance.lang = item.voice.lang;
    utterance.rate = item.rate;
    utterance.onend = () => {
      if (generation !== this.generation) return;
      this.utterance = null;
      item.index += 1;
      if (item.index >= item.chunks.length) this.current = null;
      this.run();
    };
    utterance.onerror = (event) => {
      if (generation !== this.generation) return;
      this.clear();
      this.update({ enabled: false, error: event.error === "not-allowed" ? "Audio was blocked. Press Listen on a reply or Start listening to try again." : "Playback stopped. Try another voice or press Listen to retry. Your text is still available." });
    };
    try { this.port.speak(utterance); } catch {
      this.clear();
      this.update({ enabled: false, error: "This voice could not play. Choose another voice and try again." });
    }
  }
  private clear() {
    this.generation += 1;
    this.utterance = null;
    this.current = null;
    this.queue = [];
    this.manualPause = false;
    this.port?.cancel();
    this.port?.resume();
    this.update();
  }
  stop() { this.clear(); this.update({ enabled: false }); }
  skip() {
    this.generation += 1;
    this.utterance = null;
    this.current = this.queue.shift() ?? null;
    this.port?.cancel();
    this.port?.resume();
    this.update();
    this.run();
  }
  togglePause() {
    this.manualPause = !this.manualPause;
    this.update();
    if (this.manualPause) this.port?.pause();
    else if (!this.snapshot.microphoneActive) { this.port?.resume(); this.run(); }
  }
  setMicrophoneActive(active: boolean) {
    if (this.snapshot.microphoneActive === active) return;
    this.snapshot = { ...this.snapshot, microphoneActive: active };
    this.update();
    if (active) this.port?.pause();
    else if (!this.manualPause) { this.port?.resume(); this.run(); }
  }
}
