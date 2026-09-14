import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CodexClient } from "../bridge/codex-client.mjs";

const fixture = fileURLToPath(new URL("./fixtures/codex-server.mjs", import.meta.url));
async function connection(t, options = {}) {
  const client = new CodexClient({ executable: process.execPath, args: [fixture], timeoutMs: 3000, ...options });
  t.after(() => client.close());
  assert.deepEqual(await client.initialize(), { ready: true });
  return client;
}

test("concurrent requests receive their own responses when results arrive out of order", async (t) => {
  const client = await connection(t);
  const results = await Promise.all([
    client.call("echo", { value: "slow", delay: 35 }),
    client.call("echo", { value: "fast" }),
  ]);
  assert.deepEqual(results, ["slow", "fast"]);
  assert.equal(client.pending.size, 0);
});

test("a fragmented completion arriving before the start response is not lost", async (t) => {
  const client = await connection(t);
  const after = client.sequence;
  const started = await client.call("early-event");
  const event = await client.waitFor((e) => e.params?.turn?.id === started.turn.id, { after });
  assert.equal(event.params.turn.status, "completed");
  assert.equal(client.listenerCount("notification"), 0);
});

test("an approval with a colliding server id is rejected, never mistaken for a response", async (t) => {
  const client = await connection(t);
  const requests = [];
  client.on("unsupportedRequest", (event) => requests.push(event.method));
  assert.deepEqual(await client.call("collision"), { rejected: true });
  assert.deepEqual(requests, ["item/commandExecution/requestApproval"]);
});

test("ownership errors remain errors, with the original protocol code", async (t) => {
  const client = await connection(t);
  await assert.rejects(client.call("reject"), { code: -32000, message: "Task already has an active writer" });
});

test("unexpected process exit rejects pending calls and event waits", async (t) => {
  const client = await connection(t);
  const waiting = assert.rejects(client.waitFor(() => false), /connection closed/);
  const pending = assert.rejects(client.call("never-respond"), /connection closed/);
  const exiting = assert.rejects(client.call("exit-now"), /connection closed/);
  await Promise.all([waiting, pending, exiting]);
  assert.equal(client.pending.size, 0);
  assert.equal(client.listenerCount("notification"), 0);
  await assert.rejects(client.call("echo"), /connection is closed/);
});

test("timeouts remove request and event listeners and do not prevent future requests", async (t) => {
  const client = await connection(t);
  client.timeoutMs = 60;
  await Promise.all([
    assert.rejects(client.call("never-respond"), /request timed out/),
    assert.rejects(client.waitFor(() => false, { timeoutMs: 40 }), /Timed out waiting/),
  ]);
  assert.equal(client.pending.size, 0);
  assert.equal(client.listenerCount("notification"), 0);
  assert.equal(client.listenerCount("disconnected"), 0);
  assert.equal(await client.call("echo", { value: "still-connected" }), "still-connected");
});

test("invalid protocol output fails the connection instead of leaving callers waiting", async (t) => {
  const client = await connection(t);
  await assert.rejects(client.call("invalid-json"), /invalid protocol message/);
  assert.equal(client.closed, true);
  assert.equal(client.pending.size, 0);
});
