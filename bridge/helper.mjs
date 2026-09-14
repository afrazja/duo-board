import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { CodexClient } from "./codex-client.mjs";
import { startService } from "./service.mjs";

const { values } = parseArgs({ options: { "state-dir": { type: "string" }, "remote-config": { type: "string" }, help: { type: "boolean" } } });
if (values.help) {
  console.log("Duo Board helper\nnode bridge/helper.mjs [--state-dir <directory>] [--remote-config <private-connection.json>]\nAutomatic Windows startup: npm run bridge:startup -- -Action Install");
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const directory = path.resolve(values["state-dir"] ?? path.join(root, ".bridge-state", "helper"));
  const configuration = path.resolve(values["remote-config"] ?? path.join(directory,"connection.json"));
  let remoteConfig = null;
  try { remoteConfig = JSON.parse(await readFile(configuration,"utf8")); }
  catch (error) { if(values["remote-config"] || error.code!=="ENOENT") throw error; }
  const service = await startService({ directory, remoteConfig, workerOptions: { clientFactory: () => new CodexClient({ executable: process.env.DUO_CODEX_EXECUTABLE || "codex" }) }, onFatal: (error) => { console.error(JSON.stringify({ status: "error", message: error.message })); process.exitCode = 1; } });
  console.log(JSON.stringify({ status: "ready", directory }));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await service.close(); };
  process.on("SIGINT", () => { void stop(); });
  process.on("SIGTERM", () => { void stop(); });
  // Only the local supervisor owns this IPC channel. Close its private child cleanly.
  process.on("message", (message) => { if(message?.type==="shutdown") void stop().then(()=>{if(process.connected)process.disconnect();}); });
  process.on("disconnect", () => { void stop(); });
}
