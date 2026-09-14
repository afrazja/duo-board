import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startBackground} from '../bridge/background.mjs';
import {atomicJson} from '../bridge/storage.mjs';
async function until(fn){const end=Date.now()+6000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,30));}assert.fail('Timed out');}
async function setup(t){const directory=await mkdtemp(path.join(tmpdir(),'duo-background-'));t.after(()=>rm(directory,{recursive:true,force:true}));const status=async()=>JSON.parse(await readFile(path.join(directory,'startup/status.json'),'utf8'));return {directory,status};}
test('unpaired background stays dormant, rejects duplicate owner, and ignores old stop requests',async t=>{
  const {directory,status}=await setup(t);const b=await startBackground({directory,intervalMs:20});t.after(()=>b.close());
  assert.equal((await status()).status,'waiting_for_connection');assert.equal((await status()).childPid,undefined);
  await assert.rejects(startBackground({directory}),/Another helper owns/);
  await atomicJson(path.join(directory,'startup/stop.json'),{instance:'old-instance'});
  await new Promise(r=>setTimeout(r,80));assert.equal((await status()).status,'waiting_for_connection');
  await atomicJson(path.join(directory,'startup/stop.json'),{instance:b.instance});await b.done;
  assert.equal((await status()).status,'stopped');
});
test('background retries a crashed child and gracefully stops only its replacement',async t=>{
  const {directory,status}=await setup(t);const helperFile=path.join(directory,'fake-helper.mjs');
  await writeFile(helperFile,"process.on('message',m=>{if(m.type==='shutdown')process.disconnect()});process.on('disconnect',()=>process.exit(0));");
  await atomicJson(path.join(directory,'connection.json'),{});
  const b=await startBackground({directory,helperFile,intervalMs:20,retryMs:60});t.after(()=>b.close());
  const first=(await status()).childPid;assert.ok(first);process.kill(first);
  await until(async()=>{const s=await status();return s.status==='running'&&s.childPid!==first;});
  const second=(await status()).childPid;
  await atomicJson(path.join(directory,'startup/stop.json'),{instance:b.instance});await b.done;
  assert.equal((await status()).status,'stopped');assert.throws(()=>process.kill(second,0));
});

test('supervisor cleanly closes the real idle helper and releases its lock',async t=>{
  const {directory,status}=await setup(t);
  await atomicJson(path.join(directory,'connection.json'),null);
  const b=await startBackground({directory,intervalMs:20});t.after(()=>b.close());
  await until(async()=>{try{return JSON.parse(await readFile(path.join(directory,'service.json'),'utf8')).status==='ready';}catch{return false;}});
  await atomicJson(path.join(directory,'startup/stop.json'),{instance:b.instance});await b.done;
  assert.equal((await status()).status,'stopped');
  assert.equal(JSON.parse(await readFile(path.join(directory,'service.json'),'utf8')).status,'stopped');
});
