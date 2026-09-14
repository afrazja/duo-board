import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { helperHandlers } from "../../src/lib/helper-api.ts";
const sql = (name) => readFile(new URL(`../../supabase/${name}`, import.meta.url), "utf8");
const origin = "https://board.test";
export async function database(t, ui = false, {waitMs=0}={}) {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key, email text);");
  for (const file of ["schema.sql", "permanent-removal.sql", "accounts.sql", "helper-queue.sql", "helper-inactivity.sql"]) await pg.exec(await sql(file));
  // Reapplying the migration must preserve data and function signatures.
  await pg.exec(await sql("helper-queue.sql"));
  await pg.exec(await sql("helper-inactivity.sql"));
  if (ui) { for (const file of ["helper-ui.sql", "helper-ui.sql"]) await pg.exec(await sql(file)); }
  const owners = [randomUUID(), randomUUID()];
  const threads = [randomUUID(), randomUUID()];
  const messages = [randomUUID(), randomUUID()];
  for (let i=0;i<2;i++) {
    await pg.query("insert into auth.users(id,email) values($1,$2)", [owners[i], `test${i}@example.invalid`]);
    await pg.query("insert into threads(id,title,owner_id) values($1,'Test',$2)", [threads[i],owners[i]]);
    await pg.query("insert into messages(id,thread_id,author,body) values($1,$2,'user',$3)", [messages[i],threads[i],`Question from owner ${i}`]);
  }
  const rpc = async (name,args) => {
    try {
      const fields = name === "helper_user" ? ["p_owner","p_action","p_args"] : ["p_hash","p_instance","p_action","p_args"];
      assert.ok(["helper_user","helper_device"].includes(name));
      const values = fields.map((field)=>field==="p_args"?JSON.stringify(args[field]):args[field]);
      const {rows}=await pg.query(`select public.${name}(${fields.map((_,i)=>`$${i+1}`).join(",")}) as result`,values);
      return {data:rows[0].result,error:null};
    } catch(error) { return {data:null,error:{message:error.message,code:error.code}}; }
  };
  const handlers = helperHandlers({ rpc, waitMs, requireUser:async (req)=>{
    // The production route supplies requireUser() backed by Supabase Auth.
    const who=req.headers.get("x-test-account"); if(!owners.includes(who)) throw new Error("AUTH_REQUIRED"); return {id:who};
  }});
  async function http(route, method, payload, {owner=owners[0], token, extraHeaders={}}={}) {
    const url=`${origin}${route}`;
    const req=new Request(url,{method,headers:{"Content-Type":"application/json",...(owner?{"x-test-account":owner}:{}),...(token?{Authorization:`Bearer ${token}`} : {}),...extraHeaders},...(payload?{body:JSON.stringify(payload)}:{})});
    const res=await (route.startsWith("/api/agent/helper")?handlers.device(req):route.startsWith("/api/helper/requests")?handlers.requests(req):handlers.account(req));
    return {status:res.status,headers:res.headers,data:await res.json()};
  }
  const first=await http("/api/helper","POST",{name:"Test helper"}); assert.equal(first.status,201);
  const second=await http("/api/helper","POST",{name:"Other helper"},{owner:owners[1]}); assert.equal(second.status,201);
  const connections=[first.data.connection,second.data.connection];
  const instances=[randomUUID(),randomUUID()];
  const device=(action,args={},i=0)=>http("/api/agent/helper","POST",{action,instance_id:instances[i],...args},{token:connections[i].token,owner:null});
  const enqueue=(action="message",extra={})=>http("/api/helper/requests","POST",{id:randomUUID(),thread_id:threads[0],action,...(action==="message"?{message_id:messages[0]}:{}),...extra});
  return {pg,owners,threads,messages,connections,instances,handlers,http,device,enqueue};
}
