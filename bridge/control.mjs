import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { atomicJson, isId, keyFor, prepareDirectory } from "./storage.mjs";

/** Local transport only; website authentication and request delivery are step 3. */
export async function submitCommand(directory, command) {
  if (!isId(command?.id)) throw new Error("A stable command UUID is required");
  const root = await prepareDirectory(directory);
  const name = `${keyFor(command.id)}.json`;
  // Write atomically so a filesystem event can never expose a partial request.
  await atomicJson(path.join(root, "inbox", name), command);
  return path.join(root, "receipts", name);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { "state-dir": { type: "string" }, file: { type: "string" }, status: { type: "boolean" }, help: { type: "boolean" } } });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const directory = path.resolve(values["state-dir"] ?? path.join(root, ".bridge-state", "helper"));
  if (values.help || (!values.file && !values.status)) console.log("node bridge/control.mjs --file <command.json> [--state-dir <directory>]\nnode bridge/control.mjs --status [--state-dir <directory>]");
  else if (values.status) {
    const saved = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"));
    const service = JSON.parse(await readFile(path.join(directory, "service.json"), "utf8"));
    let processAlive = false;
    if (service.status === "ready") { try { process.kill(service.pid, 0); processAlive = true; } catch {} }
    console.log(JSON.stringify({ service: processAlive ? "running" : "offline", conversations: Object.values(saved.conversations).map(({ ownerId, conversationId, threadId, claudeSessionId, mode, attention, error, lastActivityAt, sleepingAt }) => ({ ownerId, conversationId, threadId, claudeSessionId: claudeSessionId ?? null, mode, attention: attention ?? null, error, lastActivityAt, sleepingAt })), jobs: Object.values(saved.jobs).map(({ requestId, conversationKey, assistant, status, error }) => ({ requestId, conversationKey, assistant: assistant ?? "chatgpt", status, error })) }, null, 2));
  } else {
    const command = JSON.parse(await readFile(path.resolve(values.file), "utf8"));
    console.log(JSON.stringify({ queuedLocally: true, receipt: await submitCommand(directory, command) }));
  }
}
