import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

// Claude Code's supported headless interface: `claude -p` with --session-id to
// create a conversation, --resume to continue it, --name to title it, and
// stream-json output for the result. Sessions live in Claude Code's own store;
// this helper never reads or edits those files.
const MISSING_SESSION = /No conversation found with session ID/i;
const SESSION_IN_USE = /Session ID [0-9a-f-]+ is already in use/i;
const NOT_SIGNED_IN = /not logged in|not signed in|please run .*login|invalid api key|authentication/i;
// Read-only file tools plus the web: enough to research an answer without
// changing anything on the computer. DUO_CLAUDE_TOOLS (comma-separated Claude
// Code tool names) replaces the list; anything beyond these, such as Bash,
// Edit or Write, then runs unattended on this machine.
export const DEFAULT_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];

export function configuredTools(env = process.env) {
  const list = (env.DUO_CLAUDE_TOOLS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_TOOLS;
}

/** Claude Code inside the helper must not inherit the launching Claude session's identity. */
export function childEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key === "CLAUDE_CONFIG_DIR" || !/^CLAUDE/i.test(key)));
}

/** Resolve the CLI to spawn without a shell: a native claude.exe, a node script, or a PATH command. */
export function resolveClaudeCommand(executable = "claude") {
  const extension = path.extname(executable).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(extension)) return { command: process.execPath, prefix: [executable] };
  if ([".cmd", ".bat"].includes(extension)) {
    // npm's shim only forwards to the native binary beside it; spawn that binary directly.
    const native = path.join(path.dirname(executable), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    return { command: native, prefix: [] };
  }
  return { command: executable, prefix: [] };
}

/** Find an installed Claude Code CLI for this Windows account, or null when it is absent. */
export async function findClaudeExecutable(env = process.env) {
  const candidates = [];
  if (env.DUO_CLAUDE_EXECUTABLE) candidates.push(env.DUO_CLAUDE_EXECUTABLE);
  const names = process.platform === "win32" ? ["claude.exe"] : ["claude"];
  for (const directory of (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) for (const name of names) candidates.push(path.join(directory, name));
  if (env.APPDATA) candidates.push(path.join(env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
  const home = env.USERPROFILE ?? env.HOME;
  if (home) candidates.push(path.join(home, ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude"));
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch {}
  }
  return null;
}

class ClaudeRun extends EventEmitter {
  constructor(client, { cwd, sessionId, resume, name, prompt, systemPrompt }) {
    super();
    this.id = randomUUID();
    this.sessionId = sessionId;
    this.resume = resume;
    this.initSeen = false;
    this.killed = false;
    this.result = null;
    this.output = "";
    const args = [...client.prefix, "-p", "--output-format", "stream-json", "--verbose", resume ? "--resume" : "--session-id", sessionId, "--strict-mcp-config", "--tools", client.tools.join(","), "--allowedTools", client.tools.join(","), "--max-turns", String(client.maxTurns)];
    if (name) args.push("--name", name);
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    this.child = spawn(client.command, args, { cwd, env: client.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (data) => { this.output = (this.output + data.toString()).slice(-4000); });
    this.child.stdin.on("error", () => {});
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.output = (this.output + line + "\n").slice(-4000); return; }
      if (!message || typeof message !== "object") return;
      if (message.type === "system" && message.subtype === "init") {
        if (message.session_id && message.session_id.toLowerCase() !== sessionId.toLowerCase()) this.mismatch = message.session_id;
        this.initSeen = true;
        this.emit("init", message);
      } else if (message.type === "result") {
        this.result = message;
      }
    });
    const spawnError = new Promise((resolve) => this.child.once("error", resolve));
    this.done = new Promise((resolve) => {
      this.child.once("close", (code, signal) => resolve(this.outcome(code, signal, null)));
      spawnError.then((error) => resolve(this.outcome(null, null, error)));
    });
    // The prompt travels on stdin, never in the command line or a file.
    this.child.stdin.end(prompt);
  }
  outcome(code, signal, spawnError) {
    const text = this.output;
    if (spawnError) return { status: "failed", text: null, error: `Claude Code could not start: ${spawnError.message}`, initSeen: false, permanent: ["ENOENT", "EACCES", "EPERM"].includes(spawnError.code), uncertain: false };
    if (this.mismatch) return { status: "failed", text: null, error: "Claude Code opened a different session", initSeen: true, permanent: true, uncertain: false };
    if (this.result) {
      const failed = this.result.is_error === true || this.result.subtype !== "success";
      return { status: failed ? "failed" : "completed", text: failed ? null : String(this.result.result ?? ""), error: failed ? `Claude Code did not complete the request (${this.result.subtype ?? "error"})` : null, initSeen: true, permanent: false, uncertain: false, turnId: this.result.uuid ?? null };
    }
    if (this.killed) return { status: "interrupted", text: null, error: null, initSeen: this.initSeen, permanent: false, uncertain: false };
    const missing = MISSING_SESSION.test(text), inUse = SESSION_IN_USE.test(text);
    return {
      status: "failed", text: null, initSeen: this.initSeen, missing, inUse,
      error: missing ? "The saved Claude session does not exist yet" : inUse ? "The Claude session already exists" : `Claude Code exited (${signal ?? code}) without a result${text.trim() ? `: ${text.trim().split(/\r?\n/).pop().slice(0, 300)}` : ""}`,
      permanent: !this.initSeen && NOT_SIGNED_IN.test(text),
      // After init the model may already have received the request; never resend it blindly.
      uncertain: this.initSeen,
    };
  }
  interrupt() {
    if (this.killed) return;
    this.killed = true;
    this.child.kill();
  }
}

/** A private per-turn Claude Code process. Closing it never touches Claude Desktop or other sessions. */
export class ClaudeClient extends EventEmitter {
  constructor({ executable = "claude", prefixArgs = null, env = process.env, timeoutMs = 30_000, tools = configuredTools(env), maxTurns = 10 } = {}) {
    super();
    const resolved = resolveClaudeCommand(executable);
    this.command = prefixArgs ? executable : resolved.command;
    this.prefix = prefixArgs ?? resolved.prefix;
    this.env = childEnvironment(env);
    Object.assign(this, { timeoutMs, tools, maxTurns });
    this.closed = false;
    this.runs = new Set();
  }

  exec(args) {
    return new Promise((resolve) => {
      const child = spawn(this.command, [...this.prefix, ...args], { env: this.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-4000); });
      const timer = setTimeout(() => child.kill(), this.timeoutMs);
      child.once("error", (error) => { clearTimeout(timer); resolve({ error, stdout, stderr }); });
      child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  }

  /** Confirms the CLI runs and is signed in. Makes no model request. */
  async initialize() {
    if (this.closed) throw new Error("Claude Code connection is closed");
    const { error, code, stdout, stderr } = await this.exec(["auth", "status", "--json"]);
    if (error) throw Object.assign(new Error(`Claude Code could not start: ${error.message}`), { permanent: ["ENOENT", "EACCES", "EPERM"].includes(error.code) });
    let status = null;
    try { status = JSON.parse(stdout.slice(stdout.indexOf("{"))); } catch {}
    if (!status || typeof status !== "object") throw new Error(`Claude Code did not report its sign-in status (${code}): ${stderr.trim().slice(0, 200)}`);
    if (status.loggedIn !== true) throw Object.assign(new Error("Sign in to Claude Code (claude auth login) under the Windows account running the helper"), { permanent: true });
    return { loggedIn: true, authMethod: status.authMethod ?? null };
  }

  start(options) {
    if (this.closed) throw new Error("Claude Code connection is closed");
    const run = new ClaudeRun(this, options);
    this.runs.add(run);
    run.done.finally(() => this.runs.delete(run));
    return run;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const active = [...this.runs];
    for (const run of active) run.interrupt();
    await Promise.all(active.map((run) => run.done));
    this.emit("disconnected", new Error("Claude Code connection closed"));
  }
}
