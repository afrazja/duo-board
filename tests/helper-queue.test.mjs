import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { database } from "./fixtures/helper-database.mjs";
import { createServer } from "node:http";

import { StateStore, prepareDirectory, keyFor } from "../bridge/storage.mjs";
import { BackgroundWorker } from "../bridge/worker.mjs";
import { RemoteConnection } from "../bridge/remote.mjs";
import { Backend } from "./fixtures/worker-backend.mjs";


const hash = (s) => createHash("sha256").update(s).digest("hex");
const origin = "https://board.test";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 6000) { const end = Date.now()+timeout; while (Date.now()<end) { if (await fn()) return; await pause(15); } assert.fail("Timed out"); }

test("helper queue security and persistence", async (t)=>{
  const f=await database(t);
  await t.test("only hashed helper keys are stored; account responses never expose them",async()=>{
    const rows=(await f.pg.query("select token_hash from helper_devices")).rows;
    assert.equal(rows[0].token_hash,hash(f.connections[0].token));
    const status=await f.http("/api/helper","GET");
    assert.equal(status.status,200); assert.equal(status.headers.get("cache-control"),"no-store");
    assert.equal(status.data.connected,false);
    assert.equal(JSON.stringify(status.data).includes("token"),false);
    assert.equal((await f.http("/api/helper","GET",null,{owner:null})).status,401);
  });
  await t.test("strict schemas reject forged owner, workspace, and cross-site controls",async()=>{
    assert.equal((await f.enqueue("message",{owner_id:f.owners[1]})).status,400);
    assert.equal((await f.enqueue("wake",{cwd:"C:\\Windows"})).status,400);
    assert.equal((await f.http("/api/helper","POST",{name:"Bad"},{extraHeaders:{Origin:"https://other.test"}})).status,403);
  });
  await t.test("one account cannot wake, stop, inspect, or acknowledge another account's requests",async()=>{
    assert.equal((await f.enqueue("wake",{thread_id:f.threads[1]})).status,404);
    assert.equal((await f.enqueue("stop",{thread_id:f.threads[1]})).status,404);
    assert.equal((await f.enqueue("activity",{thread_id:f.threads[1]})).status,404);
    assert.equal((await f.enqueue("activity",{message_id:f.messages[0]})).status,400);
    assert.equal((await f.enqueue("activity",{created_at:new Date().toISOString()})).status,400);
    assert.equal((await f.http(`/api/helper/requests?thread=${f.threads[1]}`,"GET")).status,404);
    assert.equal((await f.enqueue("message",{message_id:f.messages[1]})).status,404);
    const q=await f.enqueue(); assert.equal(q.status,202);
    assert.equal((await f.device("ack",{id:q.data.id},1)).status,404);
    assert.deepEqual((await f.device("receive",{},1)).data.requests,[]);
  });
  await t.test("assistant posts and notes cannot trigger tasks",async()=>{
    for(const [author,to] of [["claude","both"],["user","none"],["user","claude"]]) {
      const id=randomUUID(); await f.pg.query("insert into messages(id,thread_id,author,addressed_to,body) values($1,$2,$3,$4,'Not a ChatGPT request')",[id,f.threads[0],author,to]);
      assert.equal((await f.enqueue("message",{message_id:id})).status,404);
    }
  });
  await t.test("message writes record owned activity atomically; reads and health checks never do",async()=>{
    const count=async()=>(await f.pg.query("select count(*)::integer as n from helper_requests where action='activity'")).rows[0].n;
    const before=await count();
    await f.http("/api/helper","GET");
    await f.http(`/api/helper/requests?thread=${f.threads[0]}`,"GET");
    await f.device("receive"); await f.device("receive");
    assert.equal(await count(),before);
    for(const author of ["user","claude","chatgpt"]) await f.pg.query("insert into messages(thread_id,author,body) values($1,$2,'Activity only')",[f.threads[0],author]);
    assert.equal(await count(),before+3);
    const events=(await f.device("receive")).data.requests.filter((r)=>r.action==="activity");
    assert.ok(events.length>=3);
    assert.ok(events.every((r)=>r.thread_id===f.threads[0]&&r.message_id===null&&r.prompt===null&&Number.isFinite(Date.parse(r.created_at))));
    assert.equal((await f.device("receive",{},1)).data.requests.length,0);
    await f.pg.exec("begin");
    await f.pg.query("insert into messages(thread_id,author,body) values($1,'user','Rolled back')",[f.threads[0]]);
    await f.pg.exec("rollback");
    assert.equal(await count(),before+3);
    assert.equal((await f.http(`/api/helper/requests?thread=${f.threads[0]}`,"GET")).data.requests.some((r)=>r.action==="activity"),false);
  });
  await t.test("delivery retries preserve IDs and do not consume a request before acknowledgement",async()=>{
    const id=randomUUID(); assert.equal((await f.enqueue("message",{id})).status,202);
    assert.equal((await f.enqueue("message",{id})).data.duplicate,true);
    assert.equal((await f.enqueue("wake",{id})).status,409);
    const one=await f.device("receive"); const two=await f.device("receive");
    assert.deepEqual(one.data.requests,two.data.requests);
    assert.ok(one.data.requests.some((r)=>r.id===id));
    assert.equal((await f.device("ack",{id})).data.status,"received");
    assert.equal((await f.device("receive")).data.requests.some((r)=>r.id===id),false);
    assert.equal((await f.device("ack",{id})).data.status,"received");
    assert.equal((await f.device("result",{id,status:"completed",result:"Saved answer"})).data.status,"completed");
    assert.equal((await f.device("result",{id,status:"completed",result:"Saved answer"})).data.duplicate,true);
  });
  await t.test("Stop cancels undelivered work and suppresses a late completed result",async()=>{
    const active=await f.enqueue(); await f.device("ack",{id:active.data.id});
    const pending=await f.enqueue(); const stop=await f.enqueue("stop");
    const received=(await f.device("receive")).data.requests;
    assert.equal(received.some((r)=>r.id===pending.data.id),false);
    assert.ok(received.some((r)=>r.id===stop.data.id));
    assert.equal((await f.device("result",{id:active.data.id,status:"completed",result:"Late answer"})).data.status,"stopped");
    assert.equal((await f.pg.query("select result from helper_requests where id=$1",[active.data.id])).rows[0].result,null);
  });
  await t.test("anonymous and signed-in database roles cannot bypass the server endpoints",async()=>{
    for(const role of ["anon","authenticated"]) {
      await f.pg.exec(`set role ${role}`);
      try {
        await assert.rejects(f.pg.query("select * from public.helper_requests"),/permission denied/);
        await assert.rejects(f.pg.query("select * from public.helper_pairings"),/permission denied/);
        await assert.rejects(f.pg.query("select public.helper_device($1,$2,'receive','{}')",[hash(f.connections[0].token),f.instances[0]]),/permission denied/);
        await assert.rejects(f.pg.query("select public.helper_user($1,'status','{}')",[f.owners[0]]),/permission denied/);
      } finally { await f.pg.exec("reset role"); }
    }
  });
  await t.test("installer pairings have no readable token column and reject malformed encrypted values",async()=>{
    const columns=(await f.pg.query("select column_name from information_schema.columns where table_schema='public' and table_name='helper_pairings' order by column_name")).rows.map((row)=>row.column_name);
    assert.equal(columns.includes("token"),false);
    assert.ok(columns.includes("token_cipher"));
    await assert.rejects(f.pg.query("insert into helper_pairings(code_hash,owner_id,device_id,conversation_id,origin,token_cipher,token_iv,token_tag,expires_at) values($1,$2,$3,$4,'https://board.test','not valid','bad','bad',now()+interval '10 minutes')",["a".repeat(64),f.owners[0],f.connections[0].deviceId,f.threads[0]]),/check constraint/);
  });
  await t.test("a second instance, legacy token, URL token, and revoked key are rejected",async()=>{
    assert.equal((await f.http("/api/agent/helper","POST",{action:"receive",instance_id:randomUUID()},{owner:null,token:f.connections[0].token})).status,409);
    assert.equal((await f.http("/api/agent/helper","POST",{action:"receive",instance_id:f.instances[0]},{token:"duo_chatgpt_"+"x".repeat(43)})).status,401);
    assert.equal((await f.http(`/api/agent/helper?key=${f.connections[0].token}`,"POST",{action:"receive",instance_id:f.instances[0]},{owner:null})).status,401);
    await f.http("/api/helper","DELETE");
    assert.equal((await f.device("receive")).status,401);
    assert.equal((await f.device("ack",{id:randomUUID()})).status,401);
    const rotated=await f.http("/api/helper","POST",{name:"Rotated helper"});
    assert.equal(rotated.data.connection.deviceId,f.connections[0].deviceId);
    assert.notEqual(rotated.data.connection.token,f.connections[0].token);
    assert.equal((await f.device("receive")).status,401);
    assert.equal((await f.http("/api/agent/helper","POST",{action:"receive",instance_id:randomUUID()},{owner:null,token:rotated.data.connection.token})).status,200);
  });
});

test("a sleeping helper still receives authenticated activity and Wake without model checks",async(t)=>{
  const f=await database(t);
  // Deliberately different from database time: compare server timestamps to
  // server timestamps, and apply their age to the local clock.
  let now=Date.UTC(2035,0,1);
  const directory=await prepareDirectory(await mkdtemp(path.join(tmpdir(),"duo-remote-idle-")));
  const store=await new StateStore(directory).load();
  let modelCalls=0;
  const worker=new BackgroundWorker(store,{now:()=>now,dispatchAllowed:false,clientFactory:()=>{modelCalls++;throw new Error("No model expected");}});
  worker.on("fatal",()=>{}); await worker.start(); t.after(()=>worker.close());
  const route={ownerId:f.owners[0],conversationId:f.threads[0]};
  await worker.handle({id:randomUUID(),type:"link",cwd:directory,...route});
  const key=keyFor(route.ownerId,route.conversationId);
  let reads=0;
  const remote=new RemoteConnection(worker,f.connections[0],{retryMs:15,idleMs:10,fetchImpl:async(url,options)=>{
    if(JSON.parse(options.body).action==="receive") reads++;
    return f.handlers.device(new Request(url,options));
  }});
  await remote.start(); t.after(()=>remote.close());
  await until(()=>store.snapshot().remote.status==="connected");
  now+=240_000;
  await f.pg.query("insert into messages(thread_id,author,body) values($1,'claude','A participant reply')",[f.threads[0]]);
  await until(()=>store.snapshot().conversations[key].lastActivityAt>now-1000);
  const activityAt=store.snapshot().conversations[key].lastActivityAt;
  now+=60_000; worker.pump(); await pause(40);
  assert.equal(store.snapshot().conversations[key].mode,"ready");
  assert.equal(store.snapshot().conversations[key].lastActivityAt,activityAt);
  now+=240_000; worker.pump();
  await until(()=>store.snapshot().conversations[key].mode==="sleeping");
  const readsBefore=reads; await until(()=>reads>readsBefore);
  assert.equal(store.snapshot().remote.status,"connected");
  const wake=await f.enqueue("wake"); assert.equal(wake.status,202);
  await until(()=>store.snapshot().conversations[key].mode==="ready");
  assert.equal(store.snapshot().conversations[key].lastActivityAt,now);
  assert.equal(modelCalls,0);
});

test("a new board conversation gets its own workspace and Codex task automatically",async(t)=>{
  const f=await database(t);
  const directory=await prepareDirectory(await mkdtemp(path.join(tmpdir(),"duo-auto-task-")));
  const workspaceRoot=path.join(directory,"workspaces");await mkdir(workspaceRoot);
  const store=await new StateStore(directory).load();await store.change((s)=>{s.workspaceRoot=workspaceRoot;});
  const backend=new Backend();
  const worker=new BackgroundWorker(store,{dispatchAllowed:false,clientFactory:()=>backend.client()});
  await worker.start();t.after(()=>worker.close());
  const remote=new RemoteConnection(worker,f.connections[0],{retryMs:15,idleMs:10,fetchImpl:(url,options)=>f.handlers.device(new Request(url,options))});
  await remote.start();t.after(()=>remote.close());
  await until(()=>store.snapshot().remote.status==="connected");
  const conversationId=randomUUID();
  await f.pg.query("insert into threads(id,title,owner_id) values($1,'Automatically linked',$2)",[conversationId,f.owners[0]]);
  await until(()=>Boolean(store.snapshot().conversations[keyFor(f.owners[0],conversationId)]?.threadId));
  const linked=store.snapshot().conversations[keyFor(f.owners[0],conversationId)];
  assert.equal(linked.cwd,await realpath(path.join(workspaceRoot,conversationId)));
  assert.equal(backend.created,1);
  assert.equal(backend.starts.length,0);
  await until(async()=>{
    const row=(await f.pg.query("select conversation_report from helper_devices where owner_id=$1",[f.owners[0]])).rows[0];
    return row.conversation_report.some((entry)=>entry.thread_id===conversationId&&entry.task_id===linked.threadId);
  });
});

test("website-to-helper transport retains delivery across disconnection and ack loss",async(t)=>{
  const f=await database(t);
  const directory=await prepareDirectory(await mkdtemp(path.join(tmpdir(),"duo-remote-test-")));
  const store=await new StateStore(directory).load();
  let modelStarts=0;
  // Keep tasks queued while exercising the real worker's command persistence.
  const worker=new BackgroundWorker(store,{dispatchAllowed:false,clientFactory:()=>{modelStarts++; throw new Error("Test model is offline");},retryBaseMs:2000});
  worker.on("fatal",()=>{}); await worker.start();
  t.after(()=>worker.close());
  const ckey=keyFor(f.owners[0],f.threads[0]);
  await worker.handle({id:randomUUID(),type:"link",ownerId:f.owners[0],conversationId:f.threads[0],cwd:directory});
  await worker.handle({id:randomUUID(),type:"stop",ownerId:f.owners[0],conversationId:f.threads[0]});
  const queued=await f.enqueue(); assert.equal(queued.status,202);
  // Real loopback HTTP, using the same handler as the Next route. Only the
  // database transport and account fixture are substituted; SQL is unchanged.
  const server=createServer(async(req,res)=>{
    try {
      const chunks=[]; for await(const chunk of req) chunks.push(chunk);
      const input=new Request(`http://127.0.0.1${req.url}`,{method:req.method,headers:req.headers,body:Buffer.concat(chunks)});
      const output=await f.handlers.device(input);
      res.writeHead(output.status,Object.fromEntries(output.headers)); res.end(Buffer.from(await output.arrayBuffer()));
    } catch {res.writeHead(500);res.end();}
  });
  await new Promise((resolve)=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise((resolve)=>{server.closeAllConnections();server.close(resolve);}));
  const connection={...f.connections[0],url:`http://127.0.0.1:${server.address().port}`};
  let online=false; let lostAck=true;
  const fetchImpl=async(url,options)=>{
    if(!online) throw new Error("Offline");
    const result=await fetch(url,options);
    if(JSON.parse(options.body).action==="ack"&&lostAck) {lostAck=false;throw new Error("Response lost after server committed ack");}
    return result;
  };
  const remote=new RemoteConnection(worker,connection,{fetchImpl,retryMs:15,maxRetryMs:30,idleMs:15});
  await remote.start(); t.after(()=>remote.close());
  await until(()=>store.snapshot().remote.status==="disconnected");
  assert.equal(Object.keys(store.snapshot().jobs).length,0);
  online=true;
  await until(()=>store.snapshot().remote.status==="connected"&&Object.keys(store.snapshot().jobs).length===1);
  assert.equal(modelStarts,0); // A message never silently resumes a manual Stop.
  assert.equal(store.snapshot().conversations[ckey].mode,"paused");
  const jobKey=Object.keys(store.snapshot().jobs)[0];
  await store.change((s)=>{s.jobs[jobKey].status="completed";s.jobs[jobKey].result="Persisted local response";});
  await until(async()=> (await f.pg.query("select status from helper_requests where id=$1",[queued.data.id])).rows[0].status==="completed");
  assert.equal((await f.pg.query("select result from helper_requests where id=$1",[queued.data.id])).rows[0].result,"Persisted local response");
  assert.equal(Object.keys(store.snapshot().jobs).length,1);
  const unlinked=randomUUID();
  await f.pg.query("insert into threads(id,title,owner_id) values($1,'Unlinked',$2)",[unlinked,f.owners[0]]);
  const rejected=await f.enqueue("wake",{thread_id:unlinked});
  await until(async()=> (await f.pg.query("select status from helper_requests where id=$1",[rejected.data.id])).rows[0].status==="attention");
  assert.equal(store.snapshot().conversations[keyFor(f.owners[0],unlinked)],undefined);
  assert.equal(Object.keys(store.snapshot().jobs).length,1);
  // Receipt means Stop was saved; completed Stop waits for active work to finish.
  const active=await worker.handle({id:randomUUID(),type:"enqueue",ownerId:f.owners[0],conversationId:f.threads[0],requestId:randomUUID(),text:"Synthetic active work"});
  await store.change((s)=>{s.jobs[active.jobKey].status="running";});
  const stopped=await f.enqueue("stop");
  await until(()=>Boolean(store.snapshot().remote.events[stopped.data.id]));
  await pause(80);
  assert.equal((await f.pg.query("select status from helper_requests where id=$1",[stopped.data.id])).rows[0].status,"received");
  assert.equal(store.snapshot().jobs[active.jobKey].stopRequested,true);
  await store.change((s)=>{s.jobs[active.jobKey].status="stopped";});
  await until(async()=> (await f.pg.query("select status from helper_requests where id=$1",[stopped.data.id])).rows[0].status==="stopped");
  await f.http("/api/helper","DELETE");
  await until(()=>store.snapshot().remote.status==="attention");
  assert.equal(worker.dispatchAllowed,false);
  assert.equal(store.snapshot().conversations[ckey].mode,"paused");
  assert.equal(JSON.stringify(store.snapshot()).includes(f.connections[0].token),false);
});

test("helper rejects incorrect acknowledgements and scopes removed conversations",async(t)=>{
  const directory=await prepareDirectory(await mkdtemp(path.join(tmpdir(),"duo-remote-protocol-")));
  const store=await new StateStore(directory).load();
  const worker=new BackgroundWorker(store,{dispatchAllowed:false});
  t.after(()=>worker.close());
  const ownerId=randomUUID(),threadId=randomUUID(),otherThread=randomUUID();
  for(const conversationId of [threadId,otherThread]) await worker.handle({id:randomUUID(),type:"link",ownerId,conversationId,cwd:directory});
  const config={url:origin,ownerId,deviceId:randomUUID(),token:"duo_helper_"+"x".repeat(43)};
  let reply=()=>Response.json({id:randomUUID(),status:"received"});
  const remote=new RemoteConnection(worker,config,{fetchImpl:async()=>reply()});
  remote.instanceId=randomUUID();
  await store.change((s)=>{s.remote={events:{}};});
  await assert.rejects(remote.request("ack",{id:randomUUID()}),(error)=>error.permanent===true);
  reply=()=>new Response("Malformed",{status:200});
  await assert.rejects(remote.request("receive"),(error)=>error.permanent===true);
  reply=()=>Response.json({error:"Incompatible version"},{status:400});
  await assert.rejects(remote.request("receive"),(error)=>error.permanent===true);
  await remote.removed(randomUUID(),randomUUID()); // Removed before it was linked.
  await remote.removed(randomUUID(),threadId);
  assert.equal(store.snapshot().conversations[keyFor(ownerId,threadId)].mode,"paused");
  assert.equal(store.snapshot().conversations[keyFor(ownerId,otherThread)].mode,"ready");
  assert.throws(()=>new RemoteConnection(worker,{...config,url:"http://example.com"}),/HTTPS/);
});
