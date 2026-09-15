import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { database } from "./fixtures/helper-database.mjs";
import { helperOwnsAssistant, helperOwnsChatGPT } from "../src/lib/helper-routing.ts";

test("helper ownership blocks legacy replies, including after disconnect, and preserves Claude",async(t)=>{
  const f=await database(t,true);
  const sql=await readFile(new URL("../supabase/helper-cutover.sql",import.meta.url),"utf8");
  await f.pg.exec(sql);await f.pg.exec(sql);
  const owned=async(owner)=>(await f.pg.query("select helper_chatgpt_owner($1) as owned",[owner])).rows[0].owned;
  assert.equal(await owned(f.owners[0]),true);assert.equal(await owned(randomUUID()),false);
  const insert=(author,thread=f.threads[0])=>f.pg.query("insert into messages(thread_id,author,body) values($1,$2,'Cached legacy answer')",[thread,author]);
  await assert.rejects(insert("chatgpt"),/managed by the background helper/);
  await insert("claude");
  const question=randomUUID();await f.pg.query("insert into messages(id,thread_id,author,body) values($1,$2,'user','A helper question')",[question,f.threads[0]]);
  const request=(await f.pg.query("select id from helper_requests where message_id=$1 and action='message'",[question])).rows[0];
  await f.device("ack",{id:request.id});assert.equal((await f.device("result",{id:request.id,status:"completed",result:"Helper answer"})).data.status,"completed");
  assert.equal((await f.pg.query("select count(*)::int as n from messages where helper_reply_for=$1",[question])).rows[0].n,1);
  await f.http("/api/helper","DELETE");assert.equal(await owned(f.owners[0]),true);
  await assert.rejects(insert("chatgpt"),/managed by the background helper/);
  const owner=randomUUID(),thread=randomUUID();await f.pg.query("insert into auth.users(id) values($1)",[owner]);await f.pg.query("insert into threads(id,title,owner_id) values($1,'Legacy account',$2)",[thread,owner]);
  await insert("chatgpt",thread);assert.equal(await owned(owner),false);
  await f.pg.exec("set role authenticated");await assert.rejects(f.pg.query("select helper_chatgpt_owner($1)",[f.owners[0]]),/permission denied/);await f.pg.exec("reset role");
});

test("Claude ownership follows what the paired helper reports; ChatGPT ownership is unchanged",async(t)=>{
  const f=await database(t,true);
  await f.pg.exec(await readFile(new URL("../supabase/helper-cutover.sql",import.meta.url),"utf8"));
  const owned=async(owner,assistant)=>(await f.pg.query("select helper_assistant_owner($1,$2) as owned",[owner,assistant])).rows[0].owned;
  const insert=(author)=>f.pg.query("insert into messages(thread_id,author,body) values($1,$2,'Cached legacy answer')",[f.threads[0],author]);
  assert.equal(await owned(f.owners[0],"chatgpt"),true);assert.equal(await owned(f.owners[0],"claude"),false);
  await insert("claude");
  await f.device("receive",{assistants:["chatgpt","claude"]});
  assert.equal(await owned(f.owners[0],"claude"),true);assert.equal(await owned(f.owners[1],"claude"),false);
  await assert.rejects(insert("claude"),/Claude is managed by the background helper/);
  await assert.rejects(insert("chatgpt"),/ChatGPT is managed by the background helper/);
  const question=randomUUID();await f.pg.query("insert into messages(id,thread_id,author,body) values($1,$2,'user','For Claude')",[question,f.threads[0]]);
  const request=(await f.pg.query("select id from helper_requests where message_id=$1 and assistant='claude'",[question])).rows[0];
  await f.device("ack",{id:request.id});assert.equal((await f.device("result",{id:request.id,status:"completed",result:"Helper Claude answer"})).data.status,"completed");
  assert.equal((await f.pg.query("select count(*)::int as n from messages where helper_reply_for=$1 and author='claude'",[question])).rows[0].n,1);
  // A helper that lost Claude Code hands Claude back to the legacy reader on its next report.
  await f.device("receive",{assistants:["chatgpt"]});
  assert.equal(await owned(f.owners[0],"claude"),false);
  await insert("claude");
  await f.pg.exec("set role authenticated");await assert.rejects(f.pg.query("select helper_assistant_owner($1,'claude')",[f.owners[0]]),/permission denied/);await f.pg.exec("reset role");
});

test("assistant routing checks each assistant and falls back to the ChatGPT-only function on an older database",async()=>{
  const owner=randomUUID();const seen=[];
  const rpc=async(name,args)=>{seen.push([name,args.p_assistant??null]);return {data:name==="helper_assistant_owner"&&args.p_assistant==="claude",error:null};};
  assert.equal(await helperOwnsAssistant(rpc,owner,"claude"),true);assert.equal(await helperOwnsAssistant(rpc,owner,"chatgpt"),false);
  assert.deepEqual(seen,[["helper_assistant_owner","claude"],["helper_assistant_owner","chatgpt"]]);
  const older=async(name)=>name==="helper_assistant_owner"?{data:null,error:{code:"42883",message:"Missing"}}:{data:true,error:null};
  assert.equal(await helperOwnsAssistant(older,owner,"chatgpt"),true);
  assert.equal(await helperOwnsAssistant(older,owner,"claude"),false);
  await assert.rejects(helperOwnsAssistant(async()=>({data:null,error:{code:"08006",message:"Connection lost"}}),owner,"claude"),/confirm the Claude responder/);
});

test("legacy reader routing fails closed on outages and tolerates only an absent migration",async()=>{
  const owner=randomUUID();let calls=0;
  const rpc=async()=>{calls++;return {data:true,error:null};};
  assert.equal(await helperOwnsChatGPT(rpc,null),false);assert.equal(calls,0);
  assert.equal(await helperOwnsChatGPT(rpc,owner),true);
  assert.equal(await helperOwnsChatGPT(async()=>({data:false,error:null}),owner),false);
  for(const code of ["42883","PGRST202"])assert.equal(await helperOwnsChatGPT(async()=>({data:null,error:{code,message:"Missing function"}}),owner),false);
  await assert.rejects(helperOwnsChatGPT(async()=>({data:null,error:{code:"08006",message:"Connection lost"}}),owner),/confirm the ChatGPT responder/);
  await assert.rejects(helperOwnsChatGPT(async()=>({data:{owned:true},error:null}),owner),/Unexpected/);
});
