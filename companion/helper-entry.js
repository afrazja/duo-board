import path from "node:path";
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { CodexClient } from "../bridge/codex-client.mjs";
import { startService } from "../bridge/service.mjs";

const { values } = parseArgs({ options: { "state-dir": { type: "string" } } });
const directory = path.resolve(values["state-dir"]);
const configuration = path.join(directory, "connection.json");
const remoteConfig = JSON.parse(await readFile(configuration, "utf8"));
const service = await startService({
  directory,
  remoteConfig,
  workerOptions: { clientFactory: () => new CodexClient({ executable: process.env.DUO_CODEX_EXECUTABLE || "codex" }) },
  onFatal: () => { process.exitCode = 1; },
});
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await service.close(); };
process.on("SIGINT", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
process.on("message", (message) => { if (message?.type === "shutdown") void stop().then(() => { if (process.connected) process.disconnect(); }); });
process.on("disconnect", () => { void stop(); });
