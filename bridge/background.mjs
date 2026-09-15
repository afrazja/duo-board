import { fork } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { acquireWorkerLock, atomicJson, prepareDirectory } from "./storage.mjs";

const moduleDirectory=path.dirname(fileURLToPath(import.meta.url));

/** A per-user supervisor. No listener, browser session, or model calls while unpaired. */
export async function startBackground({directory, executable, claudeExecutable, intervalMs=1000, retryMs=30_000, helperFile=path.join(moduleDirectory,"helper.mjs")}) {
  const control=await prepareDirectory(path.join(directory,"startup"));
  const release=await acquireWorkerLock(control);
  const instance=randomUUID();
  let child=null, closing=null, timer, nextStart=0, checking=false;
  const metadata={pid:process.pid,instance,startedAt:new Date().toISOString()};
  async function report(status,extra={}){await atomicJson(path.join(control,"status.json"),{...metadata,status,...extra});}
  let finish;
  const done=new Promise((resolve)=>{finish=resolve;});
  async function close(){
    if(closing)return closing;
    closing=(async()=>{
      clearInterval(timer);
      if(child){const current=child;await new Promise(resolve=>{current.once("close",resolve);if(current.connected)current.send({type:"shutdown"},()=>{});});}
      await report("stopped");await release();finish();
    })();
    return closing;
  }
  async function tick(){
    if(checking||closing)return;checking=true;
    try {
      let stop;try{stop=JSON.parse((await readFile(path.join(control,"stop.json"),"utf8")).replace(/^\uFEFF/,""));}catch(e){if(e.code!=="ENOENT")throw e;}
      if(stop?.instance===instance){void close();return;}
      if(child||Date.now()<nextStart)return;
      try{await stat(path.join(directory,"connection.json"));}catch(e){if(e.code!=="ENOENT")throw e;await report("waiting_for_connection");return;}
      const current=fork(helperFile,["--state-dir",directory],{windowsHide:true,stdio:["ignore","ignore","ignore","ipc"],env:{...process.env,...(executable?{DUO_CODEX_EXECUTABLE:executable}:{}),...(claudeExecutable?{DUO_CLAUDE_EXECUTABLE:claudeExecutable}:{})}});
      child=current;
      current.once("error",()=>{nextStart=Date.now()+retryMs;});
      current.once("close",()=>{if(child===current)child=null;nextStart=Date.now()+retryMs;if(!closing)void report("retrying").catch(()=>{});});
      await report("running",{childPid:current.pid});
    }finally{checking=false;}
  }
  try{await tick();timer=setInterval(()=>void tick().catch(()=>{void close();}),intervalMs);}catch(e){await close();throw e;}
  return {close,done,instance};
}

if(!process.env.DUO_COMPANION_ENTRY&&process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{"state-dir":{type:"string"},codex:{type:"string"},claude:{type:"string"}}});
  const directory=path.resolve(values["state-dir"]??path.join(moduleDirectory,"..",".bridge-state","helper"));
  const background=await startBackground({directory,executable:values.codex,claudeExecutable:values.claude});
  process.on("SIGINT",()=>void background.close());process.on("SIGTERM",()=>void background.close());
  await background.done;
}
