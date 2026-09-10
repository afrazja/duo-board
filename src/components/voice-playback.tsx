"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { chooseVoice, SpeechPlayback, type Speaker, type SpokenMessage, type VoiceMode } from "@/lib/speech-playback";

const NAMES = { claude: "Claude", chatgpt: "ChatGPT" };
const CONTROL = "rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-[13px] text-zinc-300 hover:border-zinc-500 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 disabled:cursor-not-allowed disabled:opacity-40";

export function useVoicePlayback(threadId: string | null, microphoneActive: boolean) {
  const [player] = useState(() => new SpeechPlayback());
  const state = useSyncExternalStore(player.subscribe, player.getSnapshot, player.getSnapshot);
  useEffect(() => {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return;
    let storage: Storage | undefined;
    try { storage = window.localStorage; } catch {}
    return player.connect(window.speechSynthesis, (text) => new SpeechSynthesisUtterance(text), storage);
  }, [player]);
  useEffect(() => { player.setThread(threadId); }, [player, threadId]);
  useEffect(() => { player.setMicrophoneActive(microphoneActive); }, [player, microphoneActive]);
  return { player, state };
}

export function VoiceToolbar({ playback }: { playback: ReturnType<typeof useVoicePlayback> }) {
  const { player, state } = playback;
  const ready = state.supported && state.voices.length > 0;
  const status = state.microphoneActive ? "Paused while your microphone is on"
    : state.current ? `${state.paused ? "Paused" : "Speaking"}: ${NAMES[state.current.author]}${state.queued ? ` · ${state.queued} queued` : ""}`
    : state.enabled ? "Listening for new replies" : state.mode === "text" ? "Read replies at your own pace" : "Press Start listening for new replies";
  return (
    <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/40 px-4 py-2.5 md:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-[12px] text-zinc-400">
          Replies
          <select aria-label="Reply mode" value={state.mode} onChange={(e) => player.setMode(e.target.value as VoiceMode)} className={CONTROL}>
            <option value="text">Text only</option>
            <option value="voice-text" disabled={!ready || state.microphoneActive}>Voice + text</option>
            <option value="voice-focus" disabled={!ready || state.microphoneActive}>Voice focus</option>
          </select>
        </label>
        {state.mode !== "text" && !state.enabled && <button type="button" onClick={() => player.enable()} disabled={!ready || state.microphoneActive} className={CONTROL}>Start listening</button>}
        {state.current && <>
          <button type="button" onClick={() => player.togglePause()} disabled={state.microphoneActive} className={CONTROL}>{state.paused ? "Resume" : "Pause"}</button>
          <button type="button" onClick={() => player.skip()} className={CONTROL}>Skip reply</button>
        </>}
        {(state.current || state.enabled) && <button type="button" onClick={() => player.stop()} className={CONTROL}>Stop</button>}
        <span role="status" className="text-[12px] text-zinc-400">{status}</span>
        <details className="group ml-auto min-w-0 basis-full sm:basis-auto">
          <summary className="cursor-pointer rounded-md py-1 text-[12px] text-zinc-400 hover:text-white focus-visible:outline-2 focus-visible:outline-indigo-400">Voice settings</summary>
          <div className="mt-2 grid max-w-full gap-3 rounded-lg border border-zinc-700 bg-zinc-900 p-3 sm:grid-cols-2">
            {(["claude", "chatgpt"] as const).map((speaker) => {
              const preferred = state[speaker];
              const automatic = chooseVoice(state.voices, speaker, "", "Hello");
              return <div key={speaker} className="min-w-0 space-y-2">
                <label className="block text-[12px] text-zinc-300">
                  {NAMES[speaker]}&apos;s voice
                  <select aria-label={`${NAMES[speaker]}'s voice`} disabled={!ready} value={state.voices.some((v) => v.voiceURI === preferred) ? preferred : ""} onChange={(e) => player.setVoice(speaker, e.target.value)} className={`${CONTROL} mt-1 block w-full max-w-full sm:max-w-72`}>
                    <option value="">Automatic{automatic ? ` — ${automatic.name}` : ""}</option>
                    {state.voices.map((voice, index) => <option key={`${voice.voiceURI}-${index}`} value={voice.voiceURI}>{voice.name} ({voice.lang}){voice.localService ? "" : " · online"}</option>)}
                  </select>
                </label>
                <button type="button" disabled={!ready || state.microphoneActive} onClick={() => player.preview(speaker)} className={CONTROL}>Preview {NAMES[speaker]}</button>
              </div>;
            })}
            <label className="flex items-center gap-2 text-[12px] text-zinc-300">
              Speed
              <select aria-label="Playback speed" value={state.rate} onChange={(e) => player.setRate(Number(e.target.value))} className={CONTROL}>
                {[0.75, 1, 1.25, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
              </select>
            </label>
            <p className="text-[12px] leading-5 text-zinc-400 sm:col-span-2">Automatic selection prefers a feminine voice for Claude and a masculine voice for ChatGPT when recognised voices are available. Preview and choose the voices you like. Online voices may use your browser&apos;s speech service. Replay a reply to hear new settings.</p>
          </div>
        </details>
      </div>
      {!state.supported && <p className="mt-2 text-[12px] text-zinc-400">Read-aloud is unavailable in this browser. Your messages remain available as text.</p>}
      {state.supported && !state.voices.length && <p className="mt-2 text-[12px] text-zinc-400">Waiting for browser voices. If none appear, try Chrome, Edge or Safari with a speech voice installed.</p>}
      {state.mode === "voice-focus" && <p className="mt-2 text-[12px] text-zinc-400">Voice focus keeps replies collapsed. Select Show text on any reply to read it.</p>}
      {state.error && <p role="alert" className="mt-2 text-[12px] text-amber-300">{state.error}</p>}
    </div>
  );
}

export function ListenButton({ message, playback }: { message: SpokenMessage; playback: ReturnType<typeof useVoicePlayback> }) {
  const { player, state } = playback;
  const active = state.current?.id === message.id;
  return <button type="button" onClick={() => active ? player.togglePause() : player.play(message)} disabled={!state.supported || !state.voices.length || state.microphoneActive} aria-label={`${active ? state.paused ? "Resume" : "Pause" : "Listen to"} ${NAMES[message.author as Speaker]}'s reply`} className="rounded-md border border-zinc-700 px-2 py-0.5 text-[12px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:opacity-40">
    {active ? state.paused ? "Resume" : "Pause" : "Listen"}
  </button>;
}
