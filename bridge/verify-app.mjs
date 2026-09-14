import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startPreview } from "../tests/fixtures/helper-app-server.mjs";
import { CodexClient } from "./codex-client.mjs";
import { atomicJson, keyFor, prepareDirectory } from "./storage.mjs";

// Opt-in live verification. Never part of npm test: this consumes Codex usage.
// It uses the built UI, isolated PostgreSQL/account, real HTTP helper delivery,
// the persistent service, and the existing signed-in Codex app-server.
const {values}=parseArgs({options:{cdp:{type:"string"},"playwright-module":{type:"string"}}});
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const directory=await prepareDirectory(path.join(root,".bridge-state",`app-verification-${Date.now()}`));
const report={startedAt:new Date().toISOString(),checks:{},passed:false,scope:"Built local UI + isolated PostgreSQL/account + real HTTP helper + real Codex. No live website/database changes."};
let preview,browser,page,interrupted=false;
const check=(name,detail=true)=>{report.checks[name]=detail;console.log(JSON.stringify({check:name,passed:true,detail}));};
process.on("SIGINT",()=>{interrupted=true;});process.on("SIGTERM",()=>{interrupted=true;});
async function waitFor(fn,timeout=120_000,label="condition") {
  const until=Date.now()+timeout;
  while(Date.now()<until){if(interrupted)throw new Error("Verification interrupted");if(preview?.metrics.fatal)throw new Error(preview.metrics.fatal);const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,80));}
  throw new Error(`Timed out waiting for ${label}`);
}
try {
  preview=await startPreview({live:true,stateDirectory:path.join(directory,"helper")});
  const browserFile=path.join(directory,"browser.json");
  console.log(JSON.stringify({ready:true,url:preview.origin,browserFile}));
  const endpoint=values.cdp??await waitFor(async()=>{try{return JSON.parse(await readFile(browserFile,"utf8")).cdp;}catch(e){if(e.code==="ENOENT")return null;throw e;}},180_000,"dedicated browser connection");
  const require=createRequire(import.meta.url);
  const {chromium}=require(values["playwright-module"]??"playwright");
  browser=await chromium.connectOverCDP(endpoint);
  page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith(preview.origin));
  assert.ok(page,"Dedicated verification tab must already show the local board");
  const browserErrors=[];page.on("pageerror",e=>browserErrors.push(e.message));
  await page.setViewportSize({width:1280,height:900});
  await page.goto(preview.origin);
  await page.getByRole("textbox",{name:"Message",exact:true}).waitFor();
  const owner=preview.f.owners[0], ckey=keyFor(owner,preview.thread);
  const conversation=()=>preview.service.store.state.conversations[ckey];
  const job=(id)=>Object.values(preview.service.store.state.jobs).find(j=>j.requestId===id);
  const answers=async(id)=>(await preview.f.pg.query("select * from messages where author='chatgpt' and reply_to=$1",[id])).rows;
  async function send(text) {
    await page.getByRole("button",{name:"ChatGPT",exact:true}).click();
    await page.getByRole("textbox",{name:"Message",exact:true}).fill(text);
    const [result]=await Promise.all([
      page.waitForResponse(r=>r.url().endsWith("/api/messages")&&r.request().method()==="POST"),
      page.getByRole("button",{name:/^(Send|Queue message)$/}).click(),
    ]);
    assert.equal(result.status(),200);return (await result.json()).message;
  }
  async function answered(id,expected) {
    const reply=await waitFor(async()=>{const list=await answers(id);assert.ok(list.length<=1,"Duplicate answer");return list[0];},120_000,"saved Codex answer");
    assert.equal(reply.body.trim(),expected);
    await page.getByRole("article",{name:"ChatGPT reply",exact:true}).filter({hasText:expected}).last().waitFor({timeout:15000});
    return reply;
  }
  await waitFor(()=>preview.service.store.state.remote?.status==="connected");
  assert.equal(preview.metrics.starts,0);assert.equal(preview.metrics.connections,0);check("idleMakesNoCodexCalls");
  preview.loseNextAck();
  const marker=`DUO6-${randomUUID()}`;
  const first=await send(`Remember the code ${marker}. Reply only with that code, without Markdown formatting. Do not use tools.`);
  await answered(first.id,marker);
  assert.equal(preview.metrics.starts,1);assert.equal(preview.metrics.lostAcks,1);
  const taskId=conversation().threadId;
  await preview.service.worker.client.call("thread/name/set",{threadId:taskId,name:"Duo Board Level 6 verification (temporary)"});
  check("browserMessageRealCodexReplyAndLostAck",{modelTurns:1});
  await page.screenshot({path:path.join(directory,"real-reply.png")});

  const long=await send("Write 2000 numbered lines saying Duo Board cancellation verification. Start immediately and do not use tools.");
  await waitFor(()=>job(long.id)?.turnId&&preview.metrics.deltas.includes(job(long.id).turnId),120_000,"real streaming response");
  await page.getByRole("button",{name:"Stop ChatGPT task",exact:true}).click();
  await waitFor(()=>job(long.id)?.status==="stopped",30_000,"card Stop interrupt");
  assert.ok(preview.metrics.completed.some(t=>t.id===job(long.id).turnId&&t.status==="interrupted"));
  assert.equal((await answers(long.id)).length,0);check("cardStopInterruptsRealCodex");
  const afterStop=await send("What code did I ask you to remember? Reply only with the code, without Markdown formatting.");
  await answered(afterStop.id,marker);assert.equal(conversation().threadId,taskId);check("newQuestionContinuesSameTaskAfterStop");

  await page.getByRole("button",{name:"Pause conversation",exact:true}).click();
  await waitFor(()=>conversation().mode==="paused");
  const beforePause=preview.metrics.starts;
  const held=await send("Reply exactly DUO_PAUSE_OK with no formatting.");
  await new Promise(r=>setTimeout(r,1200));assert.equal(preview.metrics.starts,beforePause);
  await page.getByRole("button",{name:"Resume conversation",exact:true}).click();
  await answered(held.id,"DUO_PAUSE_OK");check("conversationPauseHoldsUntilResume");

  preview.setOnline(false);
  await waitFor(()=>preview.service.store.state.remote.status==="disconnected");
  const beforeOffline=preview.metrics.starts;
  const offline=await send("This offline request must be stopped before it runs. Reply OFFLINE_SHOULD_NOT_RUN.");
  await page.getByRole("button",{name:"Stop ChatGPT task",exact:true}).click();
  await waitFor(async()=>(await preview.f.pg.query("select stopped_for from messages where id=$1",[offline.id])).rows[0].stopped_for.includes("chatgpt"));
  preview.setOnline(true);await waitFor(()=>preview.service.store.state.remote.status==="connected");
  await waitFor(async()=>(await preview.f.pg.query("select status from helper_requests where action='stop' and message_id=$1",[offline.id])).rows[0]?.status==="stopped");
  assert.equal(preview.metrics.starts,beforeOffline);assert.equal((await answers(offline.id)).length,0);check("offlineStopSurvivesReconnectWithoutModelRun");

  const startsBeforeSleep=preview.metrics.starts;
  const idleStart=Date.now();const idleActivity=conversation().lastActivityAt;
  const methodsBeforeSleep=JSON.stringify(preview.metrics.methods);
  await page.close();page=null;
  let lastProgress=0;
  await waitFor(()=>{
    const elapsed=Date.now()-idleStart;
    if(elapsed-lastProgress>=50_000){lastProgress=elapsed;console.log(JSON.stringify({waiting:"real five-minute idle period",seconds:Math.floor(elapsed/1000)}));}
    return conversation().mode==="sleeping"&&!preview.service.worker.client&&!preview.service.worker.releasing;
  },330_000,"actual five-minute idle sleep with browser closed");
  assert.ok(Date.now()-idleActivity>=300_000);assert.equal(preview.metrics.starts,startsBeforeSleep);
  assert.equal(JSON.stringify(preview.metrics.methods),methodsBeforeSleep);
  check("realFiveMinuteSleepWithBrowserClosed",{elapsedSeconds:Math.round((Date.now()-idleActivity)/1000),modelCallsDuringIdle:0});

  await preview.restart();assert.equal(conversation().threadId,taskId);assert.equal(conversation().mode,"sleeping");
  page=await browser.contexts()[0].newPage();page.on("pageerror",e=>browserErrors.push(e.message));await page.goto(preview.origin);
  await page.getByRole("button",{name:"Wake ChatGPT",exact:true}).first().waitFor({timeout:15000});
  await page.getByRole("button",{name:"Wake ChatGPT",exact:true}).first().click();
  await waitFor(()=>conversation().mode==="ready");assert.equal(preview.metrics.starts,startsBeforeSleep);
  const afterWake=await send("What code did I ask you to remember? Reply only with the code, without Markdown formatting.");
  await answered(afterWake.id,marker);assert.equal(conversation().threadId,taskId);check("wakeAfterServiceRestartResumesSavedHistory");

  await page.getByRole("button",{name:/^Another conversation/}).click();
  await page.getByRole("heading",{name:"Another conversation",exact:true}).waitFor();
  const isolated=await send("If I gave you a code beginning DUO6- earlier in THIS conversation, repeat it. Otherwise reply exactly NO_CODE. Use no tools and no formatting.");
  await answered(isolated.id,"NO_CODE");
  const second=preview.service.store.state.conversations[keyFor(owner,preview.other)];assert.notEqual(second.threadId,taskId);check("differentConversationsKeepSeparateCodexHistory");
  const guard=(await preview.f.pg.query("select helper_chatgpt_owner($1) as managed",[owner])).rows[0].managed;assert.equal(guard,true);
  await assert.rejects(preview.f.pg.query("insert into messages(thread_id,author,body,reply_to) values($1,'chatgpt','Cached legacy answer',$2)",[preview.thread,first.id]),/managed by the background helper/);
  check("legacyCachedReplyRejected");
  assert.deepEqual(browserErrors,[]);check("browserHasNoRuntimeErrors");
  await page.screenshot({path:path.join(directory,"final-verification.png")});
  report.passed=true;
} catch(error) {report.error=error.message;process.exitCode=1;console.error(JSON.stringify({error:error.message}));}
finally {
  const taskIds=preview?Object.values(preview.service.store.state.conversations).map(c=>c.threadId).filter(Boolean):[];
  report.taskIds=taskIds;
  if(preview){report.modelTurns=preview.metrics.starts;report.connections=preview.metrics.connections;report.interrupts=preview.metrics.interrupts;await preview.close();}
  if(browser)await browser.close();
  if(taskIds.length){const client=new CodexClient({cwd:directory});try{await client.initialize();for(const threadId of taskIds)await client.call("thread/archive",{threadId});check("temporaryCodexTasksArchived",taskIds.length);}catch(error){report.cleanupError=error.message;report.passed=false;process.exitCode=1;}finally{await client.close();}}
  report.finishedAt=new Date().toISOString();await atomicJson(path.join(directory,"verification-result.json"),report);
  console.log(JSON.stringify({passed:report.passed,report:path.join(directory,"verification-result.json")}));
}
