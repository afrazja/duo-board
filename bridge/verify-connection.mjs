import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexClient } from "./codex-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, ".bridge-state", `connection-${Date.now()}`);
await mkdir(fixture, { recursive: true });
const report = { startedAt: new Date().toISOString(), checks: {}, taskId: null, passed: false };
const options = { cwd: fixture, executable: process.env.DUO_CODEX_EXECUTABLE || "codex" };
const settings = {
  cwd: fixture,
  approvalPolicy: "never",
  sandbox: "read-only",
  baseInstructions: "You are a disposable Duo Board connection test. Answer only the synthetic text requests. Do not use tools, access files, contact services, start agents, or perform real work.",
};
let client;
let threadId;
let activeTurnId;
const check = (name, value = true) => {
  report.checks[name] = value;
  console.log(JSON.stringify({ check: name, result: value }));
};

async function response(text) {
  const after = client.sequence;
  const events = [];
  const collect = (event) => { if (event.params?.threadId === threadId) events.push(event); };
  client.on("notification", collect);
  try {
    const { turn } = await client.call("turn/start", { threadId, input: [{ type: "text", text }] });
    activeTurnId = turn.id;
    const completed = await client.waitFor((event) => event.method === "turn/completed" && event.params?.threadId === threadId && event.params?.turn?.id === turn.id, { after, timeoutMs: 90_000 });
    activeTurnId = null;
    assert.equal(completed.params.turn.status, "completed", JSON.stringify(completed.params.turn.error));
    return events.filter((event) => event.method === "item/agentMessage/delta" && event.params.turnId === turn.id).map((event) => event.params.delta).join("");
  } finally { client.off("notification", collect); }
}

try {
  client = new CodexClient(options);
  await client.initialize();
  check("protocolConnected");
  const account = await client.call("account/read", { refreshToken: false });
  assert.ok(account.account, "Sign in with Codex under your Windows account before running this test.");
  check("signedIn", account.account.type);
  const started = await client.call("thread/start", settings);
  threadId = started.thread.id;
  report.taskId = threadId;
  await client.call("thread/name/set", { threadId, name: "Duo Board connection verification (temporary)" });
  const marker = `DUO-${randomUUID()}`;
  const first = await response(`Remember this verification code for the next message: ${marker}. Reply only with that code.`);
  assert.equal(first.trim(), marker);
  check("responseReceived");
  // A second process must not take ownership while this process owns the task.
  const contender = new CodexClient(options);
  try {
    await contender.initialize();
    try {
      await contender.call("thread/resume", { threadId, ...settings });
      check("secondOwnerRejected", false);
    } catch (error) {
      check("secondOwnerRejected", /active writer|already.*(loaded|use)|owner|lock/i.test(error.message));
      report.ownershipResponse = error.message;
    }
  } finally { await contender.close(); }
  assert.equal(report.checks.secondOwnerRejected, true, "Another process could take ownership; do not enable automatic wake until ownership is resolved.");
  await client.close();
  client = new CodexClient(options);
  await client.initialize();
  const resumed = await client.call("thread/resume", { threadId, ...settings });
  assert.equal(resumed.thread.id, threadId);
  check("sameTaskResumedAfterRestart");
  const recalled = await response("What verification code did I ask you to remember? Reply only with that code.");
  assert.equal(recalled.trim(), marker);
  check("historyRetained");
  const after = client.sequence;
  const { turn } = await client.call("turn/start", { threadId, input: [{ type: "text", text: "For a streaming cancellation test, write 2000 numbered lines, each saying 'Duo Board connection test'. Start immediately and keep writing until interrupted. Do not use tools." }] });
  activeTurnId = turn.id;
  await client.waitFor((event) => event.method === "item/agentMessage/delta" && event.params?.threadId === threadId && event.params?.turnId === turn.id, { after, timeoutMs: 90_000 });
  const stoppingAt = Date.now();
  await client.call("turn/interrupt", { threadId, turnId: turn.id });
  const stopped = await client.waitFor((event) => event.method === "turn/completed" && event.params?.threadId === threadId && event.params?.turn?.id === turn.id, { after, timeoutMs: 20_000 });
  activeTurnId = null;
  assert.equal(stopped.params.turn.status, "interrupted");
  check("activeResponseInterrupted");
  report.interruptMs = Date.now() - stoppingAt;
  const afterStop = await response("Reply exactly: DUO_WAKE_OK");
  assert.equal(afterStop.trim(), "DUO_WAKE_OK");
  check("wakeAfterStop");
  report.passed = true;
} catch (error) {
  report.error = error.message;
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
} finally {
  if (client && threadId) {
    if (activeTurnId) await client.call("turn/interrupt", { threadId, turnId: activeTurnId }).catch(() => {});
    try { await client.call("thread/archive", { threadId }); check("temporaryTaskArchived"); }
    catch (error) { report.cleanupError = error.message; process.exitCode = 1; report.passed = false; }
  }
  if (client) await client.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(fixture, "result.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ passed: report.passed, report: path.join(fixture, "result.json") }));
}
