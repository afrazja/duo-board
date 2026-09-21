import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { CodexClient } from "./codex-client.mjs";
import { ClaudeClient, findClaudeExecutable } from "./claude-client.mjs";
import { startService } from "./service.mjs";
import { LocalTranscriber } from "./transcribe.mjs";

/** Codex is required; Claude Code is managed when its CLI is installed for this account. */
export async function clientFactories(env = process.env) {
  const claude = await findClaudeExecutable(env);
  return {
    clientFactory: () => new CodexClient({ executable: env.DUO_CODEX_EXECUTABLE || "codex" }),
    clientFactories: claude ? { claude: () => new ClaudeClient({ executable: claude, env }) } : {},
  };
}

const { values } = parseArgs({ options: { "state-dir": { type: "string" }, "remote-config": { type: "string" }, help: { type: "boolean" } } });
if (values.help) {
  console.log("Duo Board helper\nnode bridge/helper.mjs [--state-dir <directory>] [--remote-config <private-connection.json>]\nSet DUO_CLAUDE_EXECUTABLE to choose the Claude Code CLI; otherwise it is found on PATH.\nAutomatic Windows startup: npm run bridge:startup -- -Action Install");
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const directory = path.resolve(values["state-dir"] ?? path.join(root, ".bridge-state", "helper"));
  const configuration = path.resolve(values["remote-config"] ?? path.join(directory,"connection.json"));
  let remoteConfig = null;
  try { remoteConfig = JSON.parse(await readFile(configuration,"utf8")); }
  catch (error) { if(values["remote-config"] || error.code!=="ENOENT") throw error; }
  const workerOptions = await clientFactories();
  const transcriber = process.env.DUO_WHISPER_EXECUTABLE && process.env.DUO_WHISPER_MODEL
    ? new LocalTranscriber({ executable: process.env.DUO_WHISPER_EXECUTABLE, model: process.env.DUO_WHISPER_MODEL, directory: path.join(directory, "transcription") }) : null;
  const service = await startService({ directory, remoteConfig, workerOptions, remoteOptions: { transcriber }, onFatal: (error) => { console.error(JSON.stringify({ status: "error", message: error.message })); process.exitCode = 1; } });
  console.log(JSON.stringify({ status: "ready", directory, assistants: service.worker.managed }));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await service.close(); };
  process.on("SIGINT", () => { void stop(); });
  process.on("SIGTERM", () => { void stop(); });
  // Only the local supervisor owns this IPC channel. Close its private child cleanly.
  process.on("message", (message) => { if(message?.type==="shutdown") void stop().then(()=>{if(process.connected)process.disconnect();}); });
  process.on("disconnect", () => { void stop(); });
}
