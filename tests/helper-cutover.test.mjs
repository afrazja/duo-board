import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { database } from "./fixtures/helper-database.mjs";
import { helperOwnsChatGPT } from "../src/lib/helper-routing.ts";

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
