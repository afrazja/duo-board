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

function extensionFor(type: string): string {
  if (type.includes("mp4")) return "m4a";
  if (type.includes("ogg")) return "ogg";
  return "webm";
}

async function requestTranscript(blob: Blob, signal: AbortSignal): Promise<string> {
  if (blob.size > MAX_AUDIO_BYTES) throw new Error("This recording is too large. Please split it into shorter parts.");
  const form = new FormData();
  form.append("audio", blob, `dictation.${extensionFor(blob.type)}`);
  const response = await fetch("/api/transcribe", { method: "POST", body: form, signal });
  const data = (await response.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!response.ok || !data.text?.trim()) throw new Error(data.error ?? "Could not transcribe this recording.");
  return data.text.trim();
}

export function useAudioDictation(onTranscript: (text: string) => void) {
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
          const text = await requestTranscript(blob, session.abort.signal);
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
  }, [starting, transcribing]);

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
