import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexClient } from "./codex-client.mjs";
import { atomicJson, keyFor, prepareDirectory } from "./storage.mjs";
import { startService } from "./service.mjs";
import { submitCommand } from "./control.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await prepareDirectory(path.join(root, ".bridge-state", `worker-verification-${Date.now()}`));
const route = { ownerId: randomUUID(), conversationId: randomUUID() };
const ckey = keyFor(route.ownerId, route.conversationId);
const report = { startedAt: new Date().toISOString(), checks: {}, passed: false };
let service;
let createdClients = 0;
let startedTurns = 0;
let latestDelta = null;
let loseAcknowledgement = false;
const executable = process.env.DUO_CODEX_EXECUTABLE || "codex";
const options = {
  directory,
  workerOptions: {
    retryBaseMs: 100,
    retryMaxMs: 500,
    turnTimeoutMs: 90_000,
    threadSettings: { baseInstructions: "You are a temporary connection verification. Follow only the synthetic text requests. Do not use any tools, access files, start agents, or contact services." },
    clientFactory: () => {
      createdClients++;
      const client = new CodexClient({ executable, cwd: directory });
      client.on("notification", (event) => { if (event.method === "item/agentMessage/delta") latestDelta = event.params; });
      const call = client.call.bind(client);
      client.call = async (method, params) => {
        const after = client.sequence;
        if (method === "turn/start") startedTurns++;
        const result = await call(method, params);
        if (method === "turn/start" && loseAcknowledgement) {
          loseAcknowledgement = false;
          await client.waitFor((e) => e.method === "turn/completed" && e.params?.turn?.id === result.turn.id, { after, timeoutMs: 90_000 });
          // The real response is persisted, but the worker never receives its ID.
          throw new Error("Synthetic lost acknowledgement after real Codex completion");
        }
        return result;
      };
      return client;
    },
  },
  onFatal: (error) => { report.serviceError = error.message; },
};
const check = (name) => { report.checks[name] = true; console.log(JSON.stringify({ check: name, passed: true })); };
async function waitFor(predicate, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (report.serviceError) throw new Error(report.serviceError);
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Worker verification timed out");
}
async function send(type, fields = {}) {
  const command = { id: randomUUID(), type, ...route, ...fields };
  const receiptFile = await submitCommand(directory, command);
  const receipt = await waitFor(async () => { try { return JSON.parse(await readFile(receiptFile, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } });
  assert.equal(receipt.ok, true, receipt.error);
  return receipt.result;
}
async function completed(jobKey) {
  const job = await waitFor(() => {
    const j = service.store.snapshot().jobs[jobKey];
    return ["completed", "failed", "stopped", "attention"].includes(j.status) && j;
  });
  assert.equal(job.status, "completed", job.error);
  return job;
}

try {
  service = await startService(options);
  assert.equal(createdClients, 0);
  check("idleStartsNoCodexProcess");
  await send("link", { cwd: directory });
  check("localInboxReceivesCommands");
  await assert.rejects(startService(options), /Another helper owns/);
  check("secondServiceRejected");
  const marker = `DUO-${randomUUID()}`;
  const firstRequest = { requestId: randomUUID(), text: `Remember the code ${marker}. Reply only with that code.` };
  const first = await send("enqueue", firstRequest);
  assert.equal((await completed(first.jobKey)).result.trim(), marker);
  report.taskId = service.store.snapshot().conversations[ckey].threadId;
  await service.worker.client.call("thread/name/set", { threadId: report.taskId, name: "Duo Board worker verification (temporary)" });
  const duplicate = await send("enqueue", firstRequest);
  assert.equal(duplicate.duplicate, true);
  assert.equal(startedTurns, 1);
  check("duplicateRequestDoesNotRunAgain");
  await service.close();
  service = await startService(options);
  const next = await send("enqueue", { requestId: randomUUID(), text: "What code did I ask you to remember? Reply only with that code." });
  assert.equal((await completed(next.jobKey)).result.trim(), marker);
  assert.equal(service.store.snapshot().conversations[ckey].threadId, report.taskId);
  check("restartPreservesTaskAndHistory");
  loseAcknowledgement = true;
  const recovered = await send("enqueue", { requestId: randomUUID(), text: "Reply exactly: DUO_RECOVERY_OK" });
  assert.equal((await completed(recovered.jobKey)).result.trim(), "DUO_RECOVERY_OK");
  assert.equal(startedTurns, 3);
  check("lostAcknowledgementRecoveredWithoutReplay");
  latestDelta = null;
  const active = await send("enqueue", { requestId: randomUUID(), text: "Write 2000 numbered lines saying Duo Board worker cancellation test. Start immediately. Do not use tools." });
  await waitFor(() => latestDelta && latestDelta.turnId === service.store.snapshot().jobs[active.jobKey].turnId);
  await send("stop");
  await waitFor(() => service.store.snapshot().jobs[active.jobKey].status === "stopped");
  check("stopInterruptsStreamingWork");
  const held = await send("enqueue", { requestId: randomUUID(), text: "Reply exactly: DUO_WORKER_WAKE_OK" });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(service.store.snapshot().jobs[held.jobKey].status, "queued");
  assert.equal(startedTurns, 4);
  check("manualStopHoldsNewWork");
  await send("resume");
  assert.equal((await completed(held.jobKey)).result.trim(), "DUO_WORKER_WAKE_OK");
  assert.equal(startedTurns, 5);
  check("explicitResumeWakesSameTask");
  report.passed = true;
} catch (error) {
  report.error = error.message; process.exitCode = 1;
  console.error(JSON.stringify({ error: error.message }));
} finally {
  if (service) { report.taskId ??= service.store.snapshot().conversations[ckey]?.threadId; await service.close(); }
  if (report.taskId) {
    const cleanup = new CodexClient({ executable, cwd: directory });
    try { await cleanup.initialize(); await cleanup.call("thread/archive", { threadId: report.taskId }); check("temporaryTaskArchived"); }
    catch (error) { report.cleanupError = error.message; report.passed = false; process.exitCode = 1; }
    finally { await cleanup.close(); }
  }
  report.createdConnections = createdClients;
  report.startedTurns = startedTurns;
  report.finishedAt = new Date().toISOString();
  await atomicJson(path.join(directory, "verification-result.json"), report);
  console.log(JSON.stringify({ passed: report.passed, report: path.join(directory, "verification-result.json") }));
}
