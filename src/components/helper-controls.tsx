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
  const [busy,setBusy] = useState(false);
  const [file,setFile] = useState<string|null>(null);
  const [error,setError] = useState("");
  useEffect(()=>{
    const controller=new AbortController();
    void fetch("/api/helper",{signal:controller.signal,cache:"no-store"}).then(async(res)=>{const data=await res.json();if(!res.ok)throw new Error(data.error??"Setup is unavailable");setConfigured(data.configured);}).catch((cause)=>{if(!controller.signal.aborted)setError((cause as Error).message);});
    return ()=>controller.abort();
  },[]);
  async function connect() {
    if(busy||!threadId)return;setBusy(true);setError("");setFile(null);
    try {
      const res=await fetch("/api/helper",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"My computer"})});
      const data=await res.json();if(!res.ok||!data.connection)throw new Error(data.error??"Could not connect helper");
      setFile(JSON.stringify({connection:data.connection,conversationId:threadId??null},null,2));setConfigured(true);
    }catch(cause){setError((cause as Error).message);}finally{setBusy(false);}
  }
  function download() {
    if(!file)return;
    const url=URL.createObjectURL(new Blob([file],{type:"application/json"}));
    const link=document.createElement("a");link.href=url;link.download="duo-helper-connection.json";link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function disconnect() {
    if(busy)return;setBusy(true);setError("");
    try {const res=await fetch("/api/helper",{method:"DELETE"});if(!res.ok)throw new Error("Could not disconnect the helper");setConfigured(false);setFile(null);}
    catch(cause){setError((cause as Error).message);}finally{setBusy(false);}
  }
  return <section className="mt-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3" aria-label="Background helper setup">
    <h3 className="text-sm font-medium text-emerald-200">ChatGPT background helper</h3>
    <p className="my-2 text-xs leading-5 text-zinc-400">Replies run on your computer and sleep after five idle minutes. Automatic startup keeps Wake and Stop available while you are signed in to Windows.</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy||!threadId} onClick={()=>void connect()} className="min-h-9 rounded-lg border border-emerald-500/40 px-3 text-xs text-emerald-200 disabled:opacity-50">{busy?"Saving…":configured?"Replace helper connection":"Connect helper"}</button>
      {configured&&<button type="button" disabled={busy} onClick={()=>void disconnect()} className="min-h-9 rounded-lg border border-zinc-700 px-3 text-xs text-zinc-300 disabled:opacity-50">Disconnect helper</button>}
    </div>
    {!threadId&&<p className="mt-2 text-xs text-zinc-400">Open a conversation before connecting the helper.</p>}
    {configured&&threadId&&!file&&<details className="mt-3 text-xs leading-5 text-zinc-400"><summary className="cursor-pointer text-emerald-200">Link this conversation on your computer</summary><p className="mt-2">If the helper is running, close it with Ctrl+C. In the Duo Board project folder, run this command and choose your workspace. Then send a new question.</p><code className="mt-2 block break-all rounded bg-zinc-950 p-2 text-[11px]">npm run bridge:connect -- --conversation {threadId}</code></details>}
    {file&&<div className="mt-3 text-xs leading-5 text-zinc-300">
      <p>Download your private connection file, then import it using the helper on your computer. Replacing a connection disconnects the previous helper.</p>
      <button type="button" onClick={download} className="mt-2 min-h-9 rounded-lg bg-emerald-700 px-3 font-medium text-white">Download connection file</button>
      <p className="mt-2 text-zinc-400">Keep this file private. The key cannot be downloaded again after closing Settings.</p>
      <details className="mt-2"><summary className="cursor-pointer text-emerald-200">First-time setup on this computer</summary><p className="mt-2">In the Duo Board project folder, import the file and choose your workspace when asked.</p><code className="mt-2 block break-all rounded bg-zinc-950 p-2 text-[11px]">npm run bridge:connect -- --file &quot;path-to-duo-helper-connection.json&quot; --setup-only</code><p className="mt-2">Then enable automatic startup on Windows:</p><code className="mt-2 block break-all rounded bg-zinc-950 p-2 text-[11px]">npm run bridge:startup -- -Action Install</code><p className="mt-2">The helper runs in the background. You can close the terminal and browser; keep your computer awake and signed in.</p></details>
    </div>}
    {error&&<p role="alert" className="mt-2 text-xs text-rose-300">{error}</p>}
  </section>;
}
