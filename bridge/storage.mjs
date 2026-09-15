import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";

export const keyFor = (...parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (value) => typeof value === "string" && UUID.test(value);
/** The assistants a helper can manage. ChatGPT runs in Codex; Claude runs in Claude Code. */
export const ASSISTANTS = ["chatgpt", "claude"];
export const isAssistant = (value) => ASSISTANTS.includes(value);
// ChatGPT jobs keep their original key so saved state from the single-assistant
// helper stays valid; Claude jobs for the same board message get their own key.
export const jobKeyFor = (conversationKey, assistant, requestId) => assistant === "chatgpt" ? keyFor(conversationKey, requestId) : keyFor(conversationKey, assistant, requestId);

export async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  try {
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break; }
      catch (error) {
        if (attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
      }
    }
  } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}

export async function prepareDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(directory);
  await Promise.all(["inbox", "receipts"].map((name) => mkdir(path.join(root, name), { recursive: true, mode: 0o700 })));
  return root;
}

// Windows named pipes provide an OS-owned lock released automatically on crash.
// This socket accepts no commands; the actual inbox is local files only.
export async function acquireWorkerLock(directory) {
  const root = await realpath(directory);
  const id = keyFor(process.platform === "win32" ? root.toLowerCase() : root).slice(0, 32);
  const address = process.platform === "win32" ? `\\\\.\\pipe\\duo-board-${id}` : path.join(tmpdir(), `duo-board-${id}.sock`);
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", (error) => reject(new Error(`Another helper owns this state directory, or its local lock is unavailable (${error.code}).`)));
    server.listen(address, resolve);
  });
  return () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const validText = (value, max) => value === undefined || value === null || (typeof value === "string" && value.length <= max);

export class StateStore {
  constructor(directory) { this.file = path.join(directory, "state.json"); this.tail = Promise.resolve(); }
  async load() {
    try { this.state = JSON.parse(await readFile(this.file, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw new Error("The saved helper state cannot be read. Preserve it for recovery; it has not been reset.");
      this.state = { version: 1, conversations: {}, jobs: {}, commands: {} };
      await atomicJson(this.file, this.state);
    }
    const s = this.state;
    if (!s || s.version !== 1 || [s.conversations, s.jobs, s.commands].some((value) => !value || typeof value !== "object" || Array.isArray(value))) throw new Error("Unsupported helper state; refusing to reset saved task links.");
    if (s.workspaceRoot !== undefined && (typeof s.workspaceRoot !== "string" || !path.isAbsolute(s.workspaceRoot))) throw new Error("Invalid helper workspace root; refusing to create conversation folders.");
    for (const [key, c] of Object.entries(s.conversations)) {
      if (!isId(c.ownerId) || !isId(c.conversationId) || key !== keyFor(c.ownerId, c.conversationId) || !path.isAbsolute(c.cwd) || (c.threadId !== null && !isId(c.threadId)) || !["ready", "paused", "attention", "sleeping"].includes(c.mode) || (c.lastActivityAt !== undefined && (!Number.isFinite(c.lastActivityAt) || c.lastActivityAt < 0)) || (c.sleepingAt != null && (!Number.isFinite(c.sleepingAt) || c.sleepingAt < 0))) throw new Error("Invalid saved conversation link; recovery is required.");
      // Fields added with Claude support. Older state gets their defaults in memory only; no link is changed.
      if (c.claudeSessionId !== undefined && c.claudeSessionId !== null && !isId(c.claudeSessionId)) throw new Error("Invalid saved Claude session link; recovery is required.");
      if (c.claudeSessionStarted !== undefined && typeof c.claudeSessionStarted !== "boolean") throw new Error("Invalid saved Claude session link; recovery is required.");
      if (!validText(c.title, 200)) throw new Error("Invalid saved conversation link; recovery is required.");
      if (c.removedAt !== undefined && (typeof c.removedAt !== "string" || !Number.isFinite(Date.parse(c.removedAt)))) throw new Error("Invalid saved removal receipt; recovery is required.");
      if (c.workspaceCleanup !== undefined && (!c.removedAt || !c.workspaceCleanup || !["pending", "blocked", "complete"].includes(c.workspaceCleanup.status) || (c.workspaceCleanup.nextAttemptAt !== undefined && (!Number.isFinite(c.workspaceCleanup.nextAttemptAt) || c.workspaceCleanup.nextAttemptAt < 0)))) throw new Error("Invalid saved workspace cleanup state; recovery is required.");
      if (c.attention !== undefined && (!c.attention || typeof c.attention !== "object" || Array.isArray(c.attention) || Object.entries(c.attention).some(([name, reason]) => !isAssistant(name) || !validText(reason, 2000)))) throw new Error("Invalid saved conversation link; recovery is required.");
      c.claudeSessionId ??= null;
      c.claudeSessionStarted ??= false;
      c.title ??= null;
      c.attention = { chatgpt: null, claude: null, ...(c.attention ?? {}) };
    }
    const assigned = Object.values(s.conversations).map((c) => c.threadId).filter(Boolean);
    if (new Set(assigned).size !== assigned.length) throw new Error("A Codex task is linked to multiple conversations; refusing to mix their histories.");
    const sessions = Object.values(s.conversations).map((c) => c.claudeSessionId).filter(Boolean);
    if (new Set(sessions).size !== sessions.length) throw new Error("A Claude session is linked to multiple conversations; refusing to mix their histories.");
    for (const [key, job] of Object.entries(s.jobs)) {
      job.assistant ??= "chatgpt";
      if (!isId(job.requestId) || !isAssistant(job.assistant) || !s.conversations[job.conversationKey] || key !== jobKeyFor(job.conversationKey, job.assistant, job.requestId) || !["queued", "starting", "running", "recovering", "completed", "stopped", "failed", "attention"].includes(job.status) || typeof job.text !== "string") throw new Error("Invalid saved request; recovery is required.");
    }
    return this;
  }
  snapshot() { return structuredClone(this.state); }
  change(update) {
    const operation = this.tail.then(async () => {
      const next = structuredClone(this.state);
      const result = update(next);
      await atomicJson(this.file, next);
      this.state = next;
      return structuredClone(result);
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}
