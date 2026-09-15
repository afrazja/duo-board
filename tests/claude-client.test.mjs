import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeClient, childEnvironment, resolveClaudeCommand } from "../bridge/claude-client.mjs";

const fixture = fileURLToPath(new URL("./fixtures/claude-cli.mjs", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function setup(t, extraEnv = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "duo-claude-client-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const client = new ClaudeClient({ executable: process.execPath, prefixArgs: [fixture], env: { ...process.env, CLAUDECODE: "1", DUO_FAKE_CLAUDE_HOME: home, ...extraEnv }, timeoutMs: 5000 });
  t.after(() => client.close());
  const calls = async () => (await readFile(path.join(home, "calls.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { home, client, calls };
}

test("a session is created under the reserved ID, named, given read-only tools, and answered from stdin", async (t) => {
  const { client, calls, home } = await setup(t);
  assert.deepEqual(await client.initialize(), { loggedIn: true, authMethod: "claude.ai" });
  const sessionId = randomUUID();
  const run = client.start({ cwd: home, sessionId, resume: false, name: "Duo Board — Plans", prompt: "hello there", systemPrompt: "Be brief" });
  const outcome = await run.done;
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.text, "Answer: hello there");
  assert.equal(outcome.initSeen, true);
  const [, turn] = await calls();
  assert.equal(turn.sessionId, sessionId); assert.equal(turn.resume, false);
  assert.equal(turn.name, "Duo Board — Plans"); assert.equal(turn.tools, "Read,Glob,Grep"); assert.equal(turn.strictMcp, true);
  assert.equal(turn.prompt, "hello there");
  // The launching Claude session's identity never leaks into the helper's runs.
  assert.deepEqual(turn.env.filter((key) => key !== "CLAUDE_CONFIG_DIR"), []);
});

test("resume continues the same session with its earlier turns", async (t) => {
  const { client, home } = await setup(t);
  const sessionId = randomUUID();
  await client.start({ cwd: home, sessionId, resume: false, prompt: "first thing" }).done;
  const outcome = await client.start({ cwd: home, sessionId, resume: true, prompt: "recall please" }).done;
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.text, "Recalled: first thing");
});

test("a missing session and an existing session are both reported before any model contact", async (t) => {
  const { client, home } = await setup(t);
  const sessionId = randomUUID();
  const missing = await client.start({ cwd: home, sessionId, resume: true, prompt: "anything" }).done;
  assert.equal(missing.status, "failed"); assert.equal(missing.missing, true); assert.equal(missing.initSeen, false); assert.equal(missing.uncertain, false);
  await client.start({ cwd: home, sessionId, resume: false, prompt: "create it" }).done;
  const inUse = await client.start({ cwd: home, sessionId, resume: false, prompt: "again" }).done;
  assert.equal(inUse.status, "failed"); assert.equal(inUse.inUse, true); assert.equal(inUse.initSeen, false);
});

test("interrupt ends a running turn as interrupted and the session stays resumable", async (t) => {
  const { client, home } = await setup(t);
  const sessionId = randomUUID();
  const run = client.start({ cwd: home, sessionId, resume: false, prompt: "hold this answer" });
  await new Promise((resolve) => run.once("init", resolve));
  await pause(30);
  run.interrupt();
  const outcome = await run.done;
  assert.equal(outcome.status, "interrupted"); assert.equal(outcome.uncertain, false);
  const later = await client.start({ cwd: home, sessionId, resume: true, prompt: "recall" }).done;
  assert.equal(later.text, "Recalled: hold this answer");
});

test("an exit after init without a result is uncertain; an error result is a plain failure", async (t) => {
  const { client, home } = await setup(t);
  const lost = await client.start({ cwd: home, sessionId: randomUUID(), resume: false, prompt: "lost-after-init" }).done;
  assert.equal(lost.status, "failed"); assert.equal(lost.initSeen, true); assert.equal(lost.uncertain, true);
  const failed = await client.start({ cwd: home, sessionId: randomUUID(), resume: false, prompt: "error-result" }).done;
  assert.equal(failed.status, "failed"); assert.equal(failed.initSeen, true); assert.equal(failed.uncertain, false);
  assert.match(failed.error, /error_during_execution/);
});

test("a failure before init is retryable and a signed-out CLI is permanent", async (t) => {
  const { client, home } = await setup(t, { DUO_FAKE_CLAUDE_FAIL_BEFORE_INIT: "temporary trouble" });
  const outcome = await client.start({ cwd: home, sessionId: randomUUID(), resume: false, prompt: "x" }).done;
  assert.equal(outcome.status, "failed"); assert.equal(outcome.initSeen, false); assert.equal(outcome.uncertain, false); assert.equal(outcome.permanent, false);
  const signedOut = (await setup(t, { DUO_FAKE_CLAUDE_LOGGED_OUT: "1" })).client;
  await assert.rejects(signedOut.initialize(), (error) => error.permanent === true && /Sign in to Claude Code/.test(error.message));
});

test("closing the client interrupts its active runs only", async (t) => {
  const { client, home } = await setup(t);
  const run = client.start({ cwd: home, sessionId: randomUUID(), resume: false, prompt: "hold" });
  await new Promise((resolve) => run.once("init", resolve));
  await client.close();
  assert.equal((await run.done).status, "interrupted");
  assert.throws(() => client.start({ cwd: home, sessionId: randomUUID(), resume: false, prompt: "x" }), /closed/);
});

test("the CLI is spawned without a shell: npm shims resolve to the native binary and scripts run under node", () => {
  const shim = resolveClaudeCommand("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd");
  assert.equal(path.basename(shim.command), "claude.exe");
  assert.ok(shim.command.includes(path.join("node_modules", "@anthropic-ai", "claude-code", "bin")));
  const script = resolveClaudeCommand("/opt/claude/cli.js");
  assert.equal(script.command, process.execPath); assert.deepEqual(script.prefix, ["/opt/claude/cli.js"]);
  assert.deepEqual(resolveClaudeCommand("claude"), { command: "claude", prefix: [] });
  const env = childEnvironment({ PATH: "x", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CONFIG_DIR: "d", ANTHROPIC_API_KEY: "k" });
  assert.deepEqual(env, { PATH: "x", CLAUDE_CONFIG_DIR: "d", ANTHROPIC_API_KEY: "k" });
});
