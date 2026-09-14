import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { remoteConfigSchema, RemoteConnection } from "./remote.mjs";
import { acquireWorkerLock, atomicJson, prepareDirectory, StateStore } from "./storage.mjs";
import { BackgroundWorker } from "./worker.mjs";
import { startService } from "./service.mjs";

/** Import the private download locally; the website never chooses a workspace. */
export async function importConnection({ file, conversationId, workspace, directory }) {
  if (file && conversationId) throw new Error("Choose a connection file or a conversation ID, not both");
  const source = file ?? path.join(directory,"connection.json");
  if ((await stat(source)).size > 16_000) throw new Error("Connection file is too large");
  const content = JSON.parse(await readFile(source,"utf8"));
  const bundle = z.object({ connection:remoteConfigSchema, conversationId:z.string().uuid() }).strict().parse(file ? content : {connection:content,conversationId});
  const root = await prepareDirectory(directory);
  const release = await acquireWorkerLock(root);
  try {
    const store = await new StateStore(root).load();
    const worker = new BackgroundWorker(store,{dispatchAllowed:false});
    const connection = new RemoteConnection(worker,bundle.connection);
    const previous = store.state.remote;
    if (previous && (previous.ownerId!==bundle.connection.ownerId || previous.deviceId!==bundle.connection.deviceId || previous.origin!==connection.origin)) throw new Error("This helper belongs to another account or website. Use a separate state directory.");
    await worker.handle({ id:randomUUID(),type:"link",ownerId:bundle.connection.ownerId,conversationId:bundle.conversationId,cwd:workspace });
    await atomicJson(path.join(root,"connection.json"),bundle.connection);
    return {directory:root,remoteConfig:bundle.connection};
  } finally {await release();}
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {values}=parseArgs({options:{file:{type:"string"},conversation:{type:"string"},workspace:{type:"string"},"state-dir":{type:"string"},"setup-only":{type:"boolean"},help:{type:"boolean"}}});
  if(values.help || (!values.file&&!values.conversation)) console.log('npm run bridge:connect -- (--file "path-to-downloaded-file" | --conversation "conversation-UUID") [--workspace "workspace-folder"] [--state-dir "private-state-folder"]');
  else {
    let workspace=values.workspace;
    if(!workspace) {
      if(!process.stdin.isTTY) throw new Error("Choose a local workspace with --workspace");
      const input=createInterface({input:process.stdin,output:process.stdout});
      try { workspace=await input.question("Workspace folder for this conversation: "); } finally {input.close();}
    }
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
    const setup=await importConnection({file:values.file?path.resolve(values.file):undefined,conversationId:values.conversation,workspace,directory:path.resolve(values["state-dir"]??path.join(root,".bridge-state","helper"))});
    if(values["setup-only"]){console.log("Connection saved. Start automatic operation with: npm run bridge:startup -- -Action Install");process.exit(0);}
    const service=await startService({...setup,onFatal:()=>{console.error("The helper needs attention. Check its local state before restarting.");process.exitCode=1;}});
    console.log("Helper connected. Keep this window running for replies, Wake, and Stop. Press Ctrl+C to close it. Next time: npm run bridge:start");
    process.on("SIGINT",()=>void service.close());process.on("SIGTERM",()=>void service.close());
  }
}
