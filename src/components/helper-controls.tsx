"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { helperLabel, type HelperView } from "@/lib/helper-view";

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

export function HelperControls({ helper, paused }: { helper:ReturnType<typeof useHelper>; paused:boolean }) {
  const {view,error,waking} = helper;
  const waiting = view?.requests.some((r)=>r.action==="wake"&&r.status==="pending");
  const canWake = view?.configured && !paused && (!view.connected || Boolean(view.conversation && view.conversation.mode !== "ready"));
  return <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-3 py-2 text-[12px]" aria-label="ChatGPT helper controls">
    <span className="font-medium text-emerald-300">ChatGPT</span>
    <span role="status" className="text-zinc-400">{paused?"Conversation paused":waiting?"Wake queued":helperLabel(view,error)}</span>
    {canWake && <button type="button" onClick={()=>void helper.wake()} disabled={waking||waiting} className="min-h-9 rounded-lg border border-emerald-500/50 px-3 text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-50">{waking?"Waking…":"Wake ChatGPT"}</button>}
    {view && !view.configured && !error && <span className="text-zinc-500">Connect in Account → Settings</span>}
    {view?.connected && !view.conversation && <span className="text-zinc-500">Link this conversation on your computer.</span>}
    {error && <p role="alert" className="w-full text-center text-rose-300">{error}</p>}
  </div>;
}

export function HelperSettings({ threadId }: { threadId?:string|null }) {
  const [configured,setConfigured] = useState(false);
  const [connected,setConnected] = useState(false);
  const [busy,setBusy] = useState(false);
  const [installing,setInstalling] = useState(false);
  const [error,setError] = useState("");
  useEffect(()=>{
    const controller=new AbortController();
    void fetch("/api/helper",{signal:controller.signal,cache:"no-store"}).then(async(res)=>{const data=await res.json();if(!res.ok)throw new Error(data.error??"Setup is unavailable");setConfigured(data.configured);setConnected(data.connected);}).catch((cause)=>{if(!controller.signal.aborted)setError((cause as Error).message);});
    return ()=>controller.abort();
  },[]);
  useEffect(()=>{
    if(!installing)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const check=async()=>{
      try {
        const res=await fetch("/api/helper",{signal:controller.signal,cache:"no-store"});
        const data=await res.json();
        if(res.ok&&data.connected){setConnected(true);setInstalling(false);return;}
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
        if(!copied)throw new Error("Allow clipboard access, then click Connect helper again.");
      }
      const link=document.createElement("a");link.href=data.installer_url;link.download="DuoBoardHelperSetup.exe";link.click();
      setConfigured(true);setConnected(false);setInstalling(true);
    }catch(cause){setError((cause as Error).message);}finally{setBusy(false);}
  }
  return <section className="mt-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3" aria-label="Background helper setup">
    <h3 className="text-sm font-medium text-emerald-200">ChatGPT background helper</h3>
    <p className="my-2 text-xs leading-5 text-zinc-400">Replies run on your computer and sleep after five idle minutes. Automatic startup keeps Wake and Stop available while you are signed in to Windows.</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy||!threadId} onClick={()=>void connect()} className="min-h-9 rounded-lg bg-emerald-700 px-3 text-xs font-medium text-white disabled:opacity-50">{busy?"Preparing…":"Connect helper"}</button>
    </div>
    {!threadId&&<p className="mt-2 text-xs text-zinc-400">Open a conversation before connecting the helper.</p>}
    {connected&&!installing&&<p role="status" className="mt-2 text-xs text-emerald-200">Helper connected and running.</p>}
    {configured&&!connected&&!installing&&<p className="mt-2 text-xs text-zinc-400">Connect again to update or repair the Windows helper.</p>}
    {installing&&<p role="status" className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs leading-5 text-emerald-100">Open <strong>DuoBoardHelperSetup.exe</strong> from Downloads and approve Windows once. It installs, pairs this conversation, and starts automatically.</p>}
    {error&&<p role="alert" className="mt-2 text-xs text-rose-300">{error}</p>}
  </section>;
}
