"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

const MAX_RECORDING_MS = 10 * 60 * 1000;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];

interface RecordingSession {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  promise: Promise<string>;
  resolve: (text: string) => void;
  settled: boolean;
  discard: boolean;
  abort: AbortController;
  timeout: number;
  clock: number;
}

function recorderSupported(): boolean {
  return typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

function preferredMimeType(): string {
  return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { window.clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });
}

async function whisperWav(blob: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.ceil(decoded.duration * 16_000);
    const offline = new OfflineAudioContext(1, frames, 16_000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const write = (offset: number, value: string) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)); };
    write(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); write(8, "WAVE"); write(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16_000, true);
    view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return new Blob([buffer], { type: "audio/wav" });
  } finally { await context.close(); }
}

async function requestTranscript(blob: Blob, threadId: string, signal: AbortSignal): Promise<string> {
  const wav = await whisperWav(blob);
  if (wav.size > MAX_AUDIO_BYTES) throw new Error("This recording is too large. Please split it into shorter parts.");
  const form = new FormData();
  form.append("thread_id", threadId);
  form.append("audio", wav, "dictation.wav");
  const response = await fetch("/api/transcribe", { method: "POST", body: form, signal });
  const queued = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!response.ok || !queued.id) throw new Error(queued.error ?? "Could not queue this recording for local transcription.");
  try {
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      await wait(1000, signal);
      const result = await fetch(`/api/transcribe?id=${encodeURIComponent(queued.id)}`, { signal, cache: "no-store" });
      const data = (await result.json().catch(() => ({}))) as { status?: string; text?: string; error?: string };
      if (!result.ok) throw new Error(data.error ?? "Could not read the local transcription result.");
      if (data.status === "completed") {
        if (!data.text?.trim()) throw new Error("No speech was detected in this recording.");
        return data.text.trim();
      }
      if (["failed", "attention"].includes(data.status ?? "")) throw new Error(data.error ?? "The helper could not transcribe this recording.");
      if (["stopped", "cancelled"].includes(data.status ?? "")) throw new Error("This transcription was stopped.");
    }
    throw new Error("Local transcription took too long. Please try a shorter recording.");
  } catch (cause) {
    if ((cause as Error).name === "AbortError") void fetch(`/api/transcribe?id=${encodeURIComponent(queued.id)}`, { method: "DELETE", keepalive: true });
    throw cause;
  }
}

export function useAudioDictation(onTranscript: (text: string) => void, threadId: string | null) {
  const supported = useSyncExternalStore(() => () => {}, recorderSupported, () => false);
  const [starting, setStarting] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [problem, setProblem] = useState("");
  const current = useRef<RecordingSession | null>(null);
  const generation = useRef(0);
  const transcriptHandler = useRef(onTranscript);

  useEffect(() => {
    transcriptHandler.current = onTranscript;
  }, [onTranscript]);

  const cancel = useCallback(() => {
    generation.current += 1;
    const session = current.current;
    current.current = null;
    if (session) {
      session.discard = true;
      session.abort.abort();
      window.clearTimeout(session.timeout);
      window.clearInterval(session.clock);
      session.recorder.ondataavailable = null;
      session.recorder.onstop = null;
      session.recorder.onerror = null;
      if (session.recorder.state !== "inactive") session.recorder.stop();
      session.stream.getTracks().forEach((track) => track.stop());
      if (!session.settled) {
        session.settled = true;
        session.resolve("");
      }
    }
    setStarting(false);
    setListening(false);
    setTranscribing(false);
    setElapsed(0);
  }, []);

  const stop = useCallback(async (): Promise<string> => {
    const session = current.current;
    if (!session) return "";
    if (session.recorder.state !== "inactive") session.recorder.stop();
    return session.promise;
  }, []);

  const start = useCallback(async () => {
    if (current.current || starting || transcribing) return;
    const attempt = generation.current + 1;
    generation.current = attempt;
    setStarting(true);
    setProblem("");
    setElapsed(0);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (generation.current !== attempt) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mimeType = preferredMimeType();
      const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
      let resolve!: (text: string) => void;
      const promise = new Promise<string>((done) => { resolve = done; });
      const session: RecordingSession = { recorder, stream, chunks: [], promise, resolve, settled: false, discard: false, abort: new AbortController(), timeout: 0, clock: 0 };
      current.current = session;

      const settle = (text: string) => {
        if (session.settled) return;
        session.settled = true;
        session.resolve(text);
      };
      const release = () => {
        window.clearTimeout(session.timeout);
        window.clearInterval(session.clock);
        session.stream.getTracks().forEach((track) => track.stop());
        setListening(false);
        setElapsed(0);
      };

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) session.chunks.push(event.data);
      };
      recorder.onerror = () => {
        session.discard = true;
        release();
        if (current.current === session) current.current = null;
        setTranscribing(false);
        setProblem("Recording stopped unexpectedly. Please try again.");
        settle("");
      };
      recorder.onstop = async () => {
        release();
        if (session.discard) {
          if (current.current === session) current.current = null;
          settle("");
          return;
        }
        const blob = new Blob(session.chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
        if (blob.size === 0) {
          setProblem("No audio was recorded. Check microphone access and try again.");
          if (current.current === session) current.current = null;
          settle("");
          return;
        }
        setTranscribing(true);
        try {
          if (!threadId) throw new Error("Choose a conversation before recording.");
          const text = await requestTranscript(blob, threadId, session.abort.signal);
          if (session.discard || current.current !== session) {
            settle("");
            return;
          }
          transcriptHandler.current(text);
          settle(text);
        } catch (cause) {
          if (!session.discard && (cause as Error).name !== "AbortError") setProblem((cause as Error).message);
          settle("");
        } finally {
          if (current.current === session) current.current = null;
          setTranscribing(false);
        }
      };

      recorder.start();
      const startedAt = Date.now();
      session.clock = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
      session.timeout = window.setTimeout(() => {
        setProblem("Ten-minute recording reached. Transcribing it now.");
        if (recorder.state !== "inactive") recorder.stop();
      }, MAX_RECORDING_MS);
      setStarting(false);
      setListening(true);
    } catch (cause) {
      setStarting(false);
      setListening(false);
      setProblem((cause as Error).name === "NotAllowedError"
        ? "Microphone access was blocked. Allow it in the browser's site settings."
        : "The microphone could not start. Please try again.");
    }
  }, [starting, transcribing, threadId]);

  useEffect(() => () => cancel(), [cancel]);

  return {
    supported,
    starting,
    listening,
    transcribing,
    elapsed,
    problem,
    start,
    stop,
    cancel,
    toggle: () => listening ? void stop() : void start(),
  };
}
