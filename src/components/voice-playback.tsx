"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { chooseVoicePair, SpeechPlayback, type Speaker, type SpokenMessage, type VoiceMode } from "@/lib/speech-playback";
import { ControlPopover } from "./control-popover";

const NAMES = { claude: "Claude", chatgpt: "ChatGPT", system: "Duo Board" };
const CONTROL = "min-h-10 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-[13px] text-zinc-200 hover:border-zinc-500 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 disabled:cursor-not-allowed disabled:opacity-40";

export function useVoicePlayback(threadId: string | null, microphoneActive: boolean, brief: boolean) {
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
  useEffect(() => { player.setBrief(brief); }, [player, brief]);
  return { player, state };
}

export function VoiceToolbar({ playback, savingBrief, canSetBrief, onBriefChange }: { playback: ReturnType<typeof useVoicePlayback>; savingBrief: boolean; canSetBrief: boolean; onBriefChange: (brief: boolean) => void }) {
  const { player, state } = playback;
  const ready = state.supported && state.voices.length > 0;
  const pair = chooseVoicePair(state.voices, state, "Hello");
  const sameVoice = pair.claude && pair.chatgpt && pair.claude.voiceURI === pair.chatgpt.voiceURI;
  const kindLabel = state.current?.kind === "brief" ? " · brief summary" : state.current?.kind === "excerpt" ? " · opening excerpt" : "";
  const status = state.microphoneActive ? "Audio paused while your microphone is on"
    : state.current ? `${state.paused ? "Audio paused" : "Speaking"}: ${NAMES[state.current.author]}${kindLabel}${state.queued ? ` · ${state.queued} queued` : ""}`
    : state.enabled ? "Listening for new replies" : state.mode === "text" ? "Text only" : "Ready to listen";
  const briefControl = <label title="Saved for this conversation and shared with both assistants" className="flex min-h-10 items-center gap-2 whitespace-nowrap text-[13px] text-zinc-300">
    <input type="checkbox" aria-label="Brief audio" checked={state.brief} disabled={savingBrief || !canSetBrief} onChange={(e) => onBriefChange(e.target.checked)} className="h-4 w-4 accent-indigo-500" />
    {savingBrief ? "Saving…" : "Brief audio"}
  </label>;
  return <section aria-label="Read replies" className="shrink-0 border-b border-zinc-800 bg-zinc-900/40 px-3 py-2 md:px-5">
    <div data-audio-toolbar className="flex min-w-0 flex-nowrap items-center gap-2">
      <span className="hidden shrink-0 text-[12px] font-semibold text-zinc-400 lg:inline">Read replies</span>
      <select aria-label="Reply mode" value={state.mode} onChange={(e) => player.setMode(e.target.value as VoiceMode)} className={`${CONTROL} min-w-0 flex-1 sm:max-w-40 sm:flex-none`}>
        <option value="text">Text only</option>
        <option value="voice-text" disabled={!ready || state.microphoneActive}>Voice + text</option>
        <option value="voice-focus" disabled={!ready || state.microphoneActive}>Voice focus</option>
      </select>
      <div className="hidden shrink-0 border-l border-zinc-700 pl-3 sm:block">{briefControl}</div>
      <div role="group" aria-label="Audio playback" className="flex shrink-0 items-center gap-2">
        {state.mode !== "text" && !state.enabled && <button type="button" onClick={() => player.enable()} disabled={!ready || state.microphoneActive} className={CONTROL}>Start listening</button>}
        {state.current && <button type="button" onClick={() => player.togglePause()} disabled={state.microphoneActive} className={CONTROL}>{state.paused ? "Resume audio" : "Pause audio"}</button>}
        <div className="hidden items-center gap-2 xl:flex">
          {state.current && <button type="button" onClick={() => player.skip()} className={CONTROL}>Skip reply</button>}
          {(state.current || state.enabled) && <button type="button" onClick={() => player.stop()} className={CONTROL}>Stop audio</button>}
        </div>
      </div>
      <span role="status" title={status} className="sr-only min-w-0 flex-1 truncate text-[12px] text-zinc-400 xl:not-sr-only">{status}</span>
      <div className="ml-auto shrink-0">
        <ControlPopover label="Voice settings" trigger={<><span className="hidden sm:inline">Voice settings</span><span aria-hidden className="text-lg sm:hidden">•••</span></>}>
          <h2 className="mb-3 text-[14px] font-semibold text-zinc-100">Read replies</h2>
          <div className="mb-3 border-b border-zinc-700 pb-3 sm:hidden">{briefControl}</div>
          <div role="group" aria-label="More audio controls" className="mb-3 flex flex-wrap gap-2 xl:hidden">
            {state.current && <button type="button" onClick={() => player.skip()} className={CONTROL}>Skip reply</button>}
            {(state.current || state.enabled) && <button type="button" onClick={() => player.stop()} className={CONTROL}>Stop audio</button>}
          </div>
          <p className="mb-4 text-[12px] leading-5 text-zinc-300">{status}. {state.brief ? "Brief audio is on for this conversation. New answers include a spoken summary; older replies use a labelled opening excerpt." : "Audio reads the full reply."} The full text stays available.</p>
          <div className="grid min-w-0 gap-4">
            {(["claude", "chatgpt"] as const).map((speaker) => {
              const preferred = state[speaker];
              const automatic = chooseVoicePair(state.voices, { ...state, [speaker]: "" }, "Hello")[speaker];
              return <div key={speaker} className="min-w-0 space-y-2">
                <label className="block text-[12px] text-zinc-300">
                  {NAMES[speaker]}&apos;s voice
                  <select aria-label={`${NAMES[speaker]}'s voice`} disabled={!ready} value={state.voices.some((v) => v.voiceURI === preferred) ? preferred : ""} onChange={(e) => player.setVoice(speaker, e.target.value)} className={`${CONTROL} mt-1 block w-full max-w-full`}>
                    <option value="">Automatic{automatic ? ` — ${automatic.name}` : ""}</option>
                    {state.voices.map((voice, index) => <option key={`${voice.voiceURI}-${index}`} value={voice.voiceURI}>{voice.name} ({voice.lang}){voice.localService ? "" : " · online"}</option>)}
                  </select>
                </label>
                <button type="button" disabled={!ready || state.microphoneActive} onClick={() => player.preview(speaker)} className={CONTROL}>Preview {NAMES[speaker]}</button>
              </div>;
            })}
            <label className="flex items-center gap-2 text-[12px] text-zinc-300">Speed
              <select aria-label="Playback speed" value={state.rate} onChange={(e) => player.setRate(Number(e.target.value))} className={CONTROL}>
                {[0.75, 1, 1.25, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
              </select>
            </label>
            <p className="text-[12px] leading-5 text-zinc-400">Automatic selection prefers distinct voices when available. Preview to choose yours. Online voices may use your browser&apos;s speech service. Replay a reply to hear new settings.</p>
            {sameVoice && <p className="text-[12px] leading-5 text-amber-300">Both assistants currently use the same voice. Choose a different one above if available.</p>}
            {!state.supported && <p className="text-[12px] text-zinc-400">Read-aloud is unavailable in this browser. Replies remain available as text.</p>}
            {state.supported && !state.voices.length && <p className="text-[12px] text-zinc-400">Waiting for browser voices.</p>}
            {state.mode === "voice-focus" && <p className="text-[12px] text-zinc-400">Voice focus keeps replies collapsed. Select Show text on any reply to read it.</p>}
          </div>
        </ControlPopover>
      </div>
    </div>
    {state.error && <p role="alert" className="mt-2 text-[12px] text-amber-300">{state.error}</p>}
  </section>;
}

export function ListenButton({ message, playback }: { message: SpokenMessage; playback: ReturnType<typeof useVoicePlayback> }) {
  const { player, state } = playback;
  const active = state.current?.id === message.id;
  const disabled = !state.supported || !state.voices.length || state.microphoneActive;
  const buttonClass = "rounded-md border border-zinc-700 px-2 py-0.5 text-[12px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:opacity-40";
  return <span className="flex flex-wrap gap-1">
    <button type="button" onClick={() => active ? player.togglePause() : player.play(message)} disabled={disabled} aria-label={`${active ? state.paused ? "Resume" : "Pause" : state.brief ? "Listen briefly to" : "Listen to"} ${NAMES[message.author as Speaker]}'s reply`} className={buttonClass}>
      {active ? state.paused ? "Resume audio" : "Pause audio" : state.brief ? "Listen briefly" : "Listen"}
    </button>
    {state.brief && <button type="button" onClick={() => player.play(message, true)} disabled={disabled} aria-label={`Listen to full reply from ${NAMES[message.author as Speaker]}`} className={buttonClass}>Listen to full reply</button>}
  </span>;
}
