"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { helperLabel, helperManages, type HelperAssistant, type HelperView } from "@/lib/helper-view";

const NAMES: Record<HelperAssistant, string> = { chatgpt: "ChatGPT", claude: "Claude" };
const TONES: Record<HelperAssistant, string> = { chatgpt: "text-emerald-300", claude: "text-orange-300" };
const BUTTONS: Record<HelperAssistant, string> = { chatgpt: "border-emerald-500/50 text-emerald-200 hover:bg-emerald-500/10", claude: "border-orange-500/50 text-orange-200 hover:bg-orange-500/10" };

export function useHelper(threadId: string | null) {
  const [snapshot, setSnapshot] = useState<{ threadId: string; view: HelperView } | null>(null);
  const [problem, setProblem] = useState<{ threadId: string; text: string } | null>(null);
  const [wakeProblem, setWakeProblem] = useState<{ threadId: string; text: string } | null>(null);
  const [waking, setWaking] = useState<string | null>(null);
  const active = useRef(threadId);
  useEffect(()=>{active.current=threadId;return ()=>{active.current=null;};},[threadId]);
  const retryId = useRef<{ threadId: string; id: string } | null>(null);
  const pollVersion = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!threadId) return;
    const version = ++pollVersion.current;
    try {
      const res = await fetch(`/api/helper/requests?thread=${threadId}`, { cache: "no-store", signal });
      const data = await res.json() as HelperView & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not reach the helper");
      if (active.current !== threadId || signal?.aborted || version !== pollVersion.current) return;
      setSnapshot({threadId,view:data}); setProblem(null);
    } catch (cause) {
      if (!signal?.aborted && active.current === threadId && version === pollVersion.current) setProblem({threadId,text:(cause as Error).message});
    }
  }, [threadId]);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(controller.signal); if (!controller.signal.aborted) timer = setTimeout(poll,3000); };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);
  async function wake() {
    if (!threadId || waking) return;
    if (retryId.current?.threadId !== threadId) retryId.current = { threadId, id: crypto.randomUUID() };
    setWaking(threadId); setWakeProblem(null);
    try {
      const res = await fetch("/api/helper/requests", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({id:retryId.current.id,thread_id:threadId,action:"wake"}) });
      const data = await res.json() as {error?:string};
      if (!res.ok) throw new Error(data.error ?? "Wake was not confirmed. Try again.");
      retryId.current = null;
      await refresh();
    } catch(cause) { if(active.current===threadId) setWakeProblem({threadId,text:(cause as Error).message}); }
    finally { setWaking(null); }
  }
  return { view:snapshot?.threadId===threadId?snapshot.view:null, error:wakeProblem?.threadId===threadId?wakeProblem.text:problem?.threadId===threadId?problem.text:"", waking:waking===threadId && threadId!==null, wake, refresh };
}

/** One assistant's helper status. Wake is per conversation, so either column can wake both lanes. */
export function HelperControls({ helper, paused, assistant = "chatgpt" }: { helper:ReturnType<typeof useHelper>; paused:boolean; assistant?:HelperAssistant }) {
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState("");
  const {view,error,waking} = helper;
  const waiting = view?.requests.some((r)=>r.action==="wake"&&r.status==="pending");
  const managed = helperManages(view, assistant);
  const canWake = managed && !paused && (!view?.connected || Boolean(view.conversation && (view.conversation.mode !== "ready" || (assistant==="claude"?view.conversation.claude_attention:view.conversation.chatgpt_attention))));
  const ownId = assistant==="claude" ? view?.conversation?.claude_session_id : view?.conversation?.task_id;
  async function copyId() {
    if (!ownId) return;
    try { await navigator.clipboard.writeText(ownId); setCopied(ownId); setCopyError(""); }
    catch { setCopyError("Could not copy the ID"); }
  }
  return <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-3 py-2 text-[12px]" aria-label={`${NAMES[assistant]} helper controls`}>
    <span className={`font-medium ${TONES[assistant]}`}>{NAMES[assistant]}</span>
    <span role="status" className="text-zinc-400">{paused?"Conversation paused":waiting?"Wake queued":helperLabel(view,error,assistant)}</span>
    {canWake && <button type="button" onClick={()=>void helper.wake()} disabled={waking||waiting} className={`min-h-9 rounded-lg border px-3 disabled:opacity-50 ${BUTTONS[assistant]}`}>{waking?"Waking…":`Wake ${NAMES[assistant]}`}</button>}
    {view && !view.configured && !error && <span className="text-zinc-500">Connect in Account → Settings</span>}
    {view?.connected && managed && !view.conversation && <span className="text-zinc-500">Preparing this conversation&apos;s {assistant==="claude"?"Claude session":"Codex task"}.</span>}
    {managed && ownId && <span className="inline-flex items-center gap-2 text-zinc-500"><span title={ownId}>{assistant==="claude"?"Claude session":"Codex task"} · {ownId.slice(0,8)}</span>{assistant==="chatgpt"&&<a href={`codex://threads/${ownId}`} target="_blank" rel="noreferrer" className="rounded border border-emerald-500/40 px-2 py-1 text-[11px] text-emerald-200 hover:bg-emerald-500/10" aria-label="Open this conversation's Codex task">Open task</a>}<button type="button" onClick={()=>void copyId()} className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800" aria-label={`Copy ${assistant==="claude"?"Claude session":"Codex task"} ID`}>{copied===ownId?"Copied":"Copy ID"}</button></span>}
    {copyError && <p role="alert" className="w-full text-center text-rose-300">{copyError}</p>}
    {error && <p role="alert" className="w-full text-center text-rose-300">{error}</p>}
  </div>;
}

export function HelperSettings({ threadId }: { threadId?:string|null }) {
  const [connected,setConnected] = useState(false);
  const [managed,setManaged] = useState<HelperAssistant[]>([]);
  const [capabilities,setCapabilities] = useState<string[]>([]);
  const [busy,setBusy] = useState(false);
  const [installing,setInstalling] = useState(false);
  const [error,setError] = useState("");
  useEffect(()=>{
    const controller=new AbortController();
    void fetch("/api/helper",{signal:controller.signal,cache:"no-store"}).then(async(res)=>{const data=await res.json();if(!res.ok)throw new Error(data.error??"Setup is unavailable");setConnected(data.connected);setManaged(data.managed_assistants??[]);setCapabilities(data.capabilities??[]);}).catch((cause)=>{if(!controller.signal.aborted)setError((cause as Error).message);});
    return ()=>controller.abort();
  },[]);
  useEffect(()=>{
    if(!installing)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const check=async()=>{
      try {
        const res=await fetch("/api/helper",{signal:controller.signal,cache:"no-store"});
        const data=await res.json();
        if(res.ok&&data.connected){setConnected(true);setManaged(data.managed_assistants??[]);setCapabilities(data.capabilities??[]);setInstalling(false);return;}
      } catch {}
      if(!controller.signal.aborted)timer=setTimeout(check,3000);
    };
    timer=setTimeout(check,1500);
    return ()=>{controller.abort();clearTimeout(timer);};
  },[installing]);
  async function connect() {
    if(busy||!threadId)return;setBusy(true);setError("");setInstalling(false);
    try {
      const res=await fetch("/api/helper/pair",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({thread_id:threadId})});
      const data=await res.json() as {pairing_code?:string;installer_url?:string;error?:string};
      if(!res.ok||!data.pairing_code||!data.installer_url)throw new Error(data.error??"Could not connect helper");
      try {
        await navigator.clipboard.writeText(data.pairing_code);
      } catch {
        const field=document.createElement("textarea");field.value=data.pairing_code;field.style.position="fixed";field.style.opacity="0";
        document.body.appendChild(field);field.select();
        const copied=document.execCommand("copy");field.remove();
        if(!copied)throw new Error("Allow clipboard access, then click Install or repair helper again.");
      }
      const link=document.createElement("a");link.href=data.installer_url;link.download="DuoBoardHelperSetup.exe";link.click();
      setConnected(false);setInstalling(true);
    }catch(cause){setError((cause as Error).message);}finally{setBusy(false);}
  }
  const claudeManaged = managed.includes("claude");
  const localVoice = capabilities.includes("local_transcription");
  return <section className="mt-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3" aria-label="Background helper setup">
    <h3 className="text-sm font-medium text-emerald-200">Background helper</h3>
    <p className="my-2 text-xs leading-5 text-zinc-400">Replies run on your computer and sleep after five idle minutes. Every Duo conversation gets its own Codex task for ChatGPT and, when Claude Code is installed, its own Claude session named after the conversation, each with separate history. Automatic startup keeps Wake and Stop available while you are signed in to Windows.</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy||!threadId} onClick={()=>void connect()} className="min-h-9 rounded-lg bg-emerald-700 px-3 text-xs font-medium text-white disabled:opacity-50">{busy?"Preparing…":connected&&!localVoice?"Update helper":"Install or repair helper"}</button>
    </div>
    {!threadId&&<p className="mt-2 text-xs text-zinc-400">Open a conversation before connecting the helper.</p>}
    {connected&&!installing&&<p role="status" className="mt-2 text-xs text-emerald-200">Helper connected and running for {claudeManaged?"ChatGPT and Claude":"ChatGPT"}.{!claudeManaged&&" Claude Code was not found on that computer, so Claude keeps its own connection."}</p>}
    {connected&&!localVoice&&!installing&&<p className="mt-2 text-xs leading-5 text-amber-200">Update the helper once to add private local voice transcription. The installer downloads Whisper and its multilingual model automatically.</p>}
    {connected&&localVoice&&!installing&&<p className="mt-2 text-xs leading-5 text-emerald-200">Private local voice transcription is ready.</p>}
    <p className="mt-2 text-xs leading-5 text-zinc-400">One installer does both: it installs the helper on a new computer, or repairs an existing installation. Download it using the button above, then open the file.</p>
    {installing&&<p role="status" className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs leading-5 text-emerald-100">Open <strong>DuoBoardHelperSetup.exe</strong> from Downloads now, before copying anything else. Wait for setup to confirm that the helper is connected and automatic startup is verified. If setup cannot finish, its message explains the next step.</p>}
    {error&&<p role="alert" className="mt-2 text-xs text-rose-300">{error}</p>}
  </section>;
}
