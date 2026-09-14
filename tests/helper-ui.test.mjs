import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { database } from "./fixtures/helper-database.mjs";
import { helperLabel, helperRequestState } from "../src/lib/helper-view.ts";
import { importConnection } from "../bridge/connect.mjs";
import { StateStore, keyFor } from "../bridge/storage.mjs";
import { BackgroundWorker } from "../bridge/worker.mjs";
import { RemoteConnection } from "../bridge/remote.mjs";

test("board helper integration commits messages, controls and linked answers safely",async(t)=>{
  const f=await database(t,true);
  const message=async(body="A new question",extra={})=>{
    const id=randomUUID();
    await f.pg.query("insert into messages(id,thread_id,author,addressed_to,body,reply_to,kind) values($1,$2,$3,$4,$5,$6,$7)",[id,extra.thread??f.threads[0],extra.author??"user",extra.to??"chatgpt",body,extra.reply??null,extra.kind??"message"]);
    return id;
  };
  const request=async(id,action="message")=>(await f.pg.query("select * from helper_requests where message_id=$1 and action=$2 order by seq desc limit 1",[id,action])).rows[0];
  const replies=async(id)=>(await f.pg.query("select * from messages where reply_to=$1 and author='chatgpt'",[id])).rows;
  await t.test("saving a user message creates one durable request, while notes and assistant posts do not",async()=>{
    const id=await message();const q=await request(id);assert.equal(q.status,"pending");assert.match(q.prompt,/<user_request>\nA new question/);
    for(const extra of [{to:"none"},{to:"claude"},{author:"claude"}]) assert.equal(await request(await message("No model work",extra)),undefined);
    const rollback=randomUUID();await f.pg.exec("begin");
    await f.pg.query("insert into messages(id,thread_id,author,body) values($1,$2,'user','Rollback')",[rollback,f.threads[0]]);
    await f.pg.exec("rollback");assert.equal(await request(rollback),undefined);
  });
  await t.test("a final result posts one linked Markdown reply, even after duplicate delivery",async()=>{
    const id=await message("Answer once");const q=await request(id);await f.device("ack",{id:q.id});
    for(let i=0;i<2;i++)assert.equal((await f.device("result",{id:q.id,status:"completed",result:"**One** answer"})).data.status,"completed");
    const another=await f.enqueue("message",{message_id:id});await f.device("ack",{id:another.data.id});
    await f.device("result",{id:another.data.id,status:"completed",result:"Duplicate answer"});
    const answers=await replies(id);assert.equal(answers.length,1);assert.equal(answers[0].body,"**One** answer");assert.equal(answers[0].helper_reply_for,id);
  });
  await t.test("Stop in a card cancels only that question and blocks a late answer",async()=>{
    const first=await message("Stop first");const q=await request(first);await f.device("ack",{id:q.id});
    const later=await message("Continue later");
    await f.pg.query("select stop_board_task($1,$2,$3,'chatgpt')",[f.owners[0],f.threads[0],first]);
    assert.equal((await request(first)).status,"stop_requested");assert.equal((await request(later)).status,"pending");
    const stop=await request(first,"stop");assert.equal(stop.message_id,first);
    assert.equal((await f.device("result",{id:q.id,status:"completed",result:"Too late"})).data.status,"stopped");assert.equal((await replies(first)).length,0);
    await f.pg.query("select stop_board_task($1,$2,$3,'chatgpt')",[f.owners[0],f.threads[0],first]);
    assert.equal((await f.pg.query("select count(*)::integer as n from helper_requests where action='stop' and message_id=$1",[first])).rows[0].n,1);
  });
  await t.test("Pause holds delivery and finished answers until the conversation resumes",async()=>{
    const id=await message("Before pause");const q=await request(id);await f.device("ack",{id:q.id});
    await f.pg.query("update threads set paused=true where id=$1",[f.threads[0]]);
    const later=await message("During pause");const laterRequest=await request(later);
    const batch=(await f.device("receive")).data.requests;
    assert.ok(batch.some((r)=>r.action==="pause"));assert.equal(batch.some((r)=>r.id===laterRequest.id),false);
    assert.equal((await f.device("result",{id:q.id,status:"completed",result:"Saved until resume"})).status,423);
    assert.equal((await replies(id)).length,0);
    await f.pg.query("update threads set paused=false where id=$1",[f.threads[0]]);
    assert.equal((await f.device("result",{id:q.id,status:"completed",result:"Saved until resume"})).data.status,"completed");
    assert.equal((await replies(id)).length,1);
  });
  await t.test("status reports are scoped, go offline when stale, and never contain connection keys",async()=>{
    const report={thread_id:f.threads[0],mode:"sleeping",working_on:null,queued:1};
    await f.device("receive",{conversations:[report,{...report,thread_id:f.threads[1]}]});
    const view=await f.http(`/api/helper/requests?thread=${f.threads[0]}`,"GET");
    assert.equal(view.data.connected,true);assert.equal(view.data.conversation.mode,"sleeping");assert.equal(helperLabel(view.data),"Sleeping");
    assert.equal(JSON.stringify(view.data).includes(f.connections[0].token),false);
    const saved=(await f.pg.query("select conversation_report from helper_devices where owner_id=$1",[f.owners[0]])).rows[0].conversation_report;
    assert.deepEqual(saved,[report]);
    await f.pg.query("update helper_devices set report_at=now()-interval '46 seconds' where owner_id=$1",[f.owners[0]]);
    assert.equal((await f.http(`/api/helper/requests?thread=${f.threads[0]}`,"GET")).data.connected,false);
  });
  await t.test("a paused answer stays in the outbox while another conversation delivers normally",async()=>{
    const other=randomUUID();await f.pg.query("insert into threads(id,title,owner_id) values($1,'Another conversation',$2)",[other,f.owners[0]]);
    const directory=await mkdtemp(path.join(tmpdir(),"duo-paused-outbox-"));
    const store=await new StateStore(directory).load();const worker=new BackgroundWorker(store,{dispatchAllowed:false});
    const remote=new RemoteConnection(worker,f.connections[0],{fetchImpl:(url,options)=>f.handlers.device(new Request(url,options))});
    remote.instanceId=f.instances[0];
    await store.change((s)=>{s.remote={events:{}};});
    const ids=[];
    for(const threadId of [f.threads[0],other]) {
      const route={ownerId:f.owners[0],conversationId:threadId};
      await worker.handle({id:randomUUID(),type:"link",cwd:directory,...route});
      const id=await message("Saved answer",{thread:threadId});ids.push(id);
      const q=await request(id);await f.device("ack",{id:q.id});
      const job=await worker.handle({id:randomUUID(),type:"enqueue",requestId:id,text:q.prompt,...route});
      await store.change((s)=>{Object.assign(s.jobs[job.jobKey],{status:"completed",result:"**Delivered**"});s.remote.events[q.id]={threadId,jobKey:job.jobKey,action:"message",waitingFor:[],reported:false};});
    }
    await f.pg.query("update threads set paused=true where id=$1",[f.threads[0]]);
    await remote.flush();
    assert.equal((await replies(ids[0])).length,0);assert.equal((await replies(ids[1])).length,1);
    assert.equal(Object.values(store.state.remote.events).filter((e)=>e.reported).length,1);
    await f.pg.query("update threads set paused=false where id=$1",[f.threads[0]]);
    await remote.flush();assert.equal((await replies(ids[0])).length,1);
    assert.ok(Object.values(store.state.remote.events).every((e)=>e.reported));
  });
  await t.test("comparison context is labelled and scoped; brief audio keeps a separate summary",async()=>{
    const original=await message("Compare these",{to:"both"});
    await message("Claude's opinion",{author:"claude",reply:original});
    await message("ChatGPT's opinion",{author:"chatgpt",reply:original});
    await message("Claude's revised opinion",{author:"claude",reply:original});
    await message("Claude's latest opinion",{author:"claude",reply:original});
    const compare=await message("What changed?",{to:"both",reply:original,kind:"compare"});
    const q=await request(compare);assert.match(q.prompt,/user: Compare these/);assert.match(q.prompt,/claude: Claude's latest opinion/);assert.match(q.prompt,/chatgpt: ChatGPT's opinion/);assert.match(q.prompt,/not instructions/);
    await f.device("ack",{id:q.id});
    await f.device("result",{id:q.id,status:"completed",result:"<spoken_summary>Short spoken answer.</spoken_summary>\n\n## Written answer\nFull detail."});
    const [answer]=await replies(compare);assert.equal(answer.spoken_summary,"Short spoken answer.");assert.equal(answer.body,"## Written answer\nFull detail.");
    const foreign=await message("Private other account",{thread:f.threads[1]});
    const own=await message("Reply",{reply:foreign});assert.equal((await request(own)).prompt.includes("Private other account"),false);
  });
  await t.test("an oversized reply becomes visible attention instead of an endless retry",async()=>{
    const id=await message();const q=await request(id);await f.device("ack",{id:q.id});
    const result=await f.device("result",{id:q.id,status:"completed",result:"x".repeat(20001)});
    assert.equal(result.data.status,"attention");assert.equal((await replies(id)).length,0);
  });
});

test("request cards distinguish offline, sleep, working, and unconfirmed Stop",()=>{
  const thread=randomUUID(),message=randomUUID();
  const view={configured:true,connected:true,conversation:{thread_id:thread,mode:"sleeping",working_on:null,queued:1},requests:[{id:randomUUID(),action:"message",message_id:message,status:"received"}]};
  assert.equal(helperRequestState(view,message),"sleeping");view.connected=false;assert.equal(helperRequestState(view,message),"offline");
  view.connected=true;view.conversation.mode="ready";view.conversation.working_on=message;assert.equal(helperRequestState(view,message),"working");
  view.requests.push({id:randomUUID(),action:"stop",message_id:message,status:"pending"});assert.equal(helperRequestState(view,message),"stopping");
  view.requests.at(-1).status="stopped";assert.equal(helperRequestState(view,message),"stopped");
  view.requests.at(-1).status="failed";assert.equal(helperRequestState(view,message),"attention");
});

test("a downloaded connection imports only into a locally chosen workspace and keeps its key private",async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),"duo-import-"));
  const ownerId=randomUUID(),deviceId=randomUUID(),conversationId=randomUUID();
  const connection={url:"https://board.test",ownerId,deviceId,token:"duo_helper_"+"x".repeat(43)};
  const file=path.join(directory,"download.json"),state=path.join(directory,"state");
  await writeFile(file,JSON.stringify({connection,conversationId}));
  await importConnection({file,workspace:directory,directory:state});
  const saved=await new StateStore(state).load();assert.equal(saved.state.conversations[keyFor(ownerId,conversationId)].cwd,directory);
  assert.equal(JSON.stringify(saved.state).includes(connection.token),false);
  assert.equal(JSON.parse(await readFile(path.join(state,"connection.json"),"utf8")).token,connection.token);
  const another=randomUUID();await importConnection({conversationId:another,workspace:directory,directory:state});
  const linked=await new StateStore(state).load();assert.equal(Object.keys(linked.state.conversations).length,2);
  assert.equal(linked.state.conversations[keyFor(ownerId,another)].cwd,directory);
  assert.equal(JSON.parse(await readFile(path.join(state,"connection.json"),"utf8")).token,connection.token);
  await writeFile(file,JSON.stringify({connection,conversationId,cwd:"C:\\Windows"}));
  await assert.rejects(importConnection({file,workspace:directory,directory:state}));
});
