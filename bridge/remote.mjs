import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ASSISTANTS, keyFor } from "./storage.mjs";
import { removeConversationWorkspace } from "./workspace-cleanup.mjs";
import { removeClaudeSession } from "./claude-session-cleanup.mjs";

const uuid = z.string().uuid();
const assistant = z.enum(ASSISTANTS);
export const remoteConfigSchema = z.object({ url: z.string().url(), ownerId: uuid, deviceId: uuid, token: z.string().regex(/^duo_helper_[A-Za-z0-9_-]{43}$/) }).strict();
const timestamp = z.iso.datetime({ offset: true });
// `assistant` and `title` arrive from a board that knows about Claude sessions; an older board omits them.
const eventSchema = z.object({ id: uuid, seq: z.union([z.number(), z.string()]), thread_id: uuid, action: z.enum(["wake", "message", "stop", "pause", "activity"]), message_id: uuid.nullable(), prompt: z.string().min(1).max(100_000).nullable(), status: z.literal("pending"), created_at: timestamp, assistant: assistant.optional(), title: z.string().max(200).nullable().optional() }).strict()
  .refine((e) => (e.action === "stop" || !e.message_id || Boolean(e.prompt)) && (e.action !== "message" || Boolean(e.message_id)) && (!["pause", "activity"].includes(e.action) || !e.message_id));
const responseSchema = z.object({ device_id: uuid, owner_id: uuid, requests: z.array(eventSchema).max(50), server_now: timestamp, removed_thread_ids: z.array(uuid).max(200).optional() }).strict();
const ackSchema = z.object({ id: uuid, status: z.enum(["received", "stop_requested", "cancelled", "completed", "stopped", "failed", "attention"]) }).strict();
const resultSchema = z.object({ id: uuid, status: z.enum(["completed", "stopped", "failed", "attention"]), duplicate: z.boolean() }).strict();
const terminal = new Set(["completed", "stopped", "failed", "attention"]);
function commandId(eventId, part) {
  const h = keyFor(eventId, part);
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
class RemoteError extends Error { constructor(message, permanent = false) { super(message); this.permanent = permanent; } }

/** Outbound HTTPS only. No remote request can link a task, choose a workspace, or pick a session ID. */
export class RemoteConnection {
  constructor(worker, config, { fetchImpl = fetch, retryMs = 1000, maxRetryMs = 30_000, idleMs = 50, requestTimeoutMs = 22_000 } = {}) {
    this.worker = worker;
    this.config = remoteConfigSchema.parse(config);
    const url = new URL(this.config.url);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Use an HTTPS board origin, or localhost for development");
    this.origin = url.origin;
    Object.assign(this, { fetchImpl, retryMs, maxRetryMs, idleMs, requestTimeoutMs });
    this.closed = false;
    this.activeRequest = null;
  }
  async start() {
    this.worker.setDispatchAllowed(false);
    await this.worker.store.change((s) => {
      if (s.remote && (s.remote.ownerId !== this.config.ownerId || s.remote.deviceId !== this.config.deviceId || s.remote.origin !== this.origin)) throw new Error("This state directory is paired with another board or account");
      s.remote ??= { ownerId: this.config.ownerId, deviceId: this.config.deviceId, origin: this.origin, instanceId: randomUUID(), events: {} };
      s.remote.status = "connecting"; s.remote.error = null;
    });
    this.instanceId = this.worker.store.snapshot().remote.instanceId;
    this.done = this.loop();
  }
  async request(action, payload = {}) {
    const controller = new AbortController(); this.activeRequest = controller;
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(`${this.origin}/api/agent/helper`, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.token}` },
        body: JSON.stringify({ action, instance_id: this.instanceId, conversations: this.report(), assistants: this.worker.managed, ...(action === "receive" ? { workspace_cleanup: true } : {}), ...payload }),
      });
      if ([401, 403, 409].includes(res.status)) throw new RemoteError("Helper access was revoked, replaced, or belongs to another instance. Reconnect it from your account.", true);
      if (res.status === 404) throw Object.assign(new RemoteError("This helper request or conversation was removed", action === "receive"), { missing: action !== "receive" });
      if (res.status === 423 && action === "result") throw Object.assign(new RemoteError("This conversation is paused; its answer remains saved locally"), { paused: true });
      if ([400, 405, 413, 415, 422].includes(res.status)) throw new RemoteError("The board rejected this helper protocol. Check that both versions match before reconnecting.", true);
      if (!res.ok) throw new RemoteError(`Board connection temporarily unavailable (${res.status})`);
      let response;
      try { response = await res.json(); }
      catch { throw new RemoteError("The board returned an invalid response", true); }
      if (action !== "receive") {
        const parsed = (action === "ack" ? ackSchema : resultSchema).safeParse(response);
        if (!parsed.success || parsed.data.id !== payload.id) throw new RemoteError("Unexpected acknowledgement from the board", true);
        return parsed.data;
      }
      return response;
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      // Never put a token, response body, or fetch URL in logs/state errors.
      throw new RemoteError("Board connection interrupted; saved requests will be retried");
    } finally { clearTimeout(timeout); if (this.activeRequest === controller) this.activeRequest = null; }
  }
  /** Safe status per conversation: IDs and modes only; no paths, prompts or answers. */
  report() {
    const s = this.worker.store.state;
    // A removed conversation stays reported until both its folder and its Claude session are gone, with backoff while either is blocked.
    const due = (c) => [c.workspaceCleanup, c.claudeSessionCleanup].filter((step) => step && step.status !== "complete").every((step) => (step.nextAttemptAt ?? 0) <= Date.now());
    return Object.entries(s.conversations).filter(([,c]) => c.ownerId === this.config.ownerId && !this.cleanupComplete(c) && (!c.removedAt || due(c))).slice(0,200).map(([key,c]) => {
      const jobs = Object.values(s.jobs).filter((j) => j.conversationKey === key);
      const lane = (name) => ({ working_on: jobs.find((j) => j.assistant === name && ["starting","running","recovering"].includes(j.status))?.requestId ?? null, queued: jobs.filter((j) => j.assistant === name && j.status === "queued").length });
      const chatgpt = lane("chatgpt"), claude = lane("claude");
      return { thread_id: c.conversationId, task_id: c.threadId, claude_session_id: c.claudeSessionId ?? null, mode: c.mode, working_on: chatgpt.working_on, queued: chatgpt.queued, claude_working_on: claude.working_on, claude_queued: claude.queued, chatgpt_attention: Boolean(c.attention?.chatgpt), claude_attention: Boolean(c.attention?.claude) };
    });
  }
  async linkConversation(event) {
    const root = this.worker.store.snapshot().workspaceRoot;
    if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Reconnect the helper once so it can prepare workspaces for new conversations");
    await mkdir(root, { recursive: true });
    const trustedRoot = await realpath(root);
    const candidate = path.join(trustedRoot, event.thread_id);
    await mkdir(candidate, { recursive: true });
    const workspace = await realpath(candidate);
    if (path.relative(trustedRoot, workspace).toLowerCase() !== event.thread_id.toLowerCase()) throw new Error("The new conversation workspace is outside the helper folder");
    const route = { ownerId: this.config.ownerId, conversationId: event.thread_id };
    await this.worker.handle({ id: commandId(event.id, "link"), type: "link", cwd: workspace, ...(event.title ? { title: event.title } : {}), ...route });
    // One Codex task and one reserved Claude session, both chosen locally; the board only learns their IDs.
    await this.worker.ensureSessions(route.ownerId, route.conversationId);
  }
  async apply(event, serverNow) {
    const ckey = keyFor(this.config.ownerId, event.thread_id);
    const route = { ownerId: this.config.ownerId, conversationId: event.thread_id };
    if (this.worker.store.state.conversations[ckey]?.removedAt) return;
    const lane = event.assistant ?? "chatgpt";
    let local;
    const waitingFor = event.action === "stop" ? Object.entries(this.worker.store.snapshot().jobs)
      .filter(([, job]) => job.conversationKey === ckey && (!event.message_id || (job.requestId === event.message_id && job.assistant === lane)) && !terminal.has(job.status)).map(([key]) => key) : [];
    try {
      if (!this.worker.store.snapshot().conversations[ckey]) await this.linkConversation(event);
      else if (event.title && event.title !== this.worker.store.snapshot().conversations[ckey].title) {
        const previousTitle = this.worker.store.snapshot().conversations[ckey].title;
        await this.worker.handle({ id: commandId(event.id, "title"), type: "link", cwd: this.worker.store.snapshot().conversations[ckey].cwd, title: event.title, ...route });
        // The first server title can fill older local state without waking a
        // model connection. A real rename updates the already-created task.
        if (previousTitle) await this.worker.ensureSessions(route.ownerId, route.conversationId);
      }
      if (event.action === "activity") await this.worker.handle({ id: commandId(event.id, "activity"), type: "activity", ...route }, { activityAgeMs: Math.max(0, Date.parse(serverNow) - Date.parse(event.created_at)) });
      if (event.action === "stop") await this.worker.handle({ id: commandId(event.id, "stop"), type: event.message_id ? "cancel" : "stop", ...(event.message_id ? {requestId:event.message_id, assistant: lane} : {}), ...route });
      if (event.action === "pause") await this.worker.handle({ id: commandId(event.id, "pause"), type: "hold", ...route });
      if (event.action === "wake") {
        const repairsMissingTask = /thread not found|no rollout found for thread id/i.test(this.worker.store.snapshot().conversations[ckey].attention?.chatgpt ?? "");
        await this.worker.handle({ id: commandId(event.id, "resume"), type: "resume", ...route });
        if (repairsMissingTask) await this.worker.ensureSessions(route.ownerId, route.conversationId);
      }
      if (event.message_id && event.action !== "stop") local = await this.worker.handle({ id: commandId(event.id, "enqueue"), type: "enqueue", ...route, requestId: event.message_id, assistant: lane, text: event.prompt });
    } catch (error) {
      if (["EACCES", "EPERM", "ENOSPC", "EIO", "EROFS"].includes(error.code)) throw error;
      await this.request("ack", { id: event.id, rejected: true });
      return;
    }
    await this.worker.store.change((s) => {
      s.remote.events[event.id] ??= { threadId: event.thread_id, jobKey: local?.jobKey ?? null, action: event.action, waitingFor, reported: false };
    });
    // No acknowledgement until BOTH local command and delivery mapping are saved.
    const acknowledged = await this.request("ack", { id: event.id });
    if (["cancelled", "stop_requested"].includes(acknowledged.status)) {
      await this.worker.handle({ id: commandId(event.id, "cancel"), type: event.message_id ? "cancel" : "stop", ...(event.message_id ? {requestId:event.message_id, assistant: lane} : {}), ...route });
    }
  }
  async flush() {
    const s = this.worker.store.snapshot();
    for (const [id, event] of Object.entries(s.remote.events)) {
      if (event.reported || this.closed) continue;
      if (s.conversations[keyFor(this.config.ownerId, event.threadId)]?.removedAt) continue;
      const job = event.jobKey ? s.jobs[event.jobKey] : null;
      if ((event.jobKey && !job) || event.waitingFor?.some((key) => !s.jobs[key])) throw new RemoteError("Saved delivery refers to missing local work; review the helper state", true);
      if (job && !terminal.has(job.status)) continue;
      if (event.waitingFor?.some((key) => s.jobs[key] && !terminal.has(s.jobs[key].status))) continue;
      try { await this.request("result", { id, status: job?.status ?? (event.action === "stop" ? "stopped" : "completed"), result: job?.result ?? null, error: job?.error ? "The local task needs attention. Check the helper on your computer." : null }); }
      catch (error) {
        // Holding one conversation's answer must not block other conversations
        // or prevent the next receive from picking up Resume and Stop.
        if (error.paused) continue;
        if (!error.missing) throw error;
        await this.removed(id, event.threadId); continue;
      }
      await this.worker.store.change((next) => { next.remote.events[id].reported = true; });
    }
  }
  async removed(id, threadId) {
    if (this.worker.store.snapshot().conversations[keyFor(this.config.ownerId, threadId)]) {
      await this.worker.handle({ id: commandId(id, "removed"), type: "stop", ownerId: this.config.ownerId, conversationId: threadId });
    }
    await this.worker.store.change((s) => { if (s.remote.events[id]) s.remote.events[id].reported = true; });
  }
  /** A started Claude session is deleted with its conversation; an unstarted one has no transcript to delete. */
  claudeCleanupNeeded(c) { return this.worker.managed.includes("claude") && Boolean(c.claudeSessionId) && c.claudeSessionStarted === true; }
  cleanupComplete(c) { return c.workspaceCleanup?.status === "complete" && (!this.claudeCleanupNeeded(c) || c.claudeSessionCleanup?.status === "complete"); }
  async claudeProjectsDirectory() {
    if (this.projectsDirectory) return this.projectsDirectory;
    const client = this.worker.factories.claude();
    try { this.projectsDirectory = await client.projectsDirectory(); } finally { await client.close(); }
    return this.projectsDirectory;
  }
  /** Missing requests alone never authorize filesystem cleanup; only removal receipts do. */
  async cleanupRemoved(threadIds) {
    for (const threadId of new Set(threadIds)) {
      const ckey = keyFor(this.config.ownerId, threadId);
      const c = this.worker.store.state.conversations[ckey];
      if (!c || c.ownerId !== this.config.ownerId || this.cleanupComplete(c)) continue;
      await this.worker.store.change((s) => {
        const entry = s.conversations[ckey];
        entry.removedAt ??= new Date().toISOString();
        if (entry.workspaceCleanup?.status !== "complete") entry.workspaceCleanup = { status: "pending", nextAttemptAt: Date.now() + 1000, error: null };
        if (this.claudeCleanupNeeded(entry) && entry.claudeSessionCleanup?.status !== "complete") entry.claudeSessionCleanup = { status: "pending", nextAttemptAt: Date.now() + 1000, error: null };
      });
      await this.worker.handle({ id: commandId(threadId, "workspace-removal"), type: "stop", ownerId: this.config.ownerId, conversationId: threadId });
      // Allow active turns to finish stopping while the remote connection keeps
      // serving other conversations. Retry on the next authenticated receipt.
      if ([...this.worker.active.values()].some((run) => run.conversationKey === ckey)) continue;
      if (this.worker.store.state.conversations[ckey].workspaceCleanup?.status !== "complete") {
        try {
          const state = this.worker.store.snapshot();
          await removeConversationWorkspace({ workspaceRoot: state.workspaceRoot, conversation: state.conversations[ckey], conversations: state.conversations });
          await this.worker.store.change((s) => {
            s.conversations[ckey].workspaceCleanup = { status: "complete", completedAt: new Date().toISOString(), error: null };
            for (const event of Object.values(s.remote.events)) if (event.threadId === threadId) event.reported = true;
          });
        } catch {
          await this.worker.store.change((s) => {
            s.conversations[ckey].workspaceCleanup = { status: "blocked", nextAttemptAt: Date.now() + 30_000, error: "The removed conversation's workspace could not be safely deleted. Cleanup will retry." };
          });
        }
      }
      // The conversation's Claude Code session goes with its folder. Claude Code has no
      // command for deleting a foreground session, so its transcript is removed from the
      // projects directory the CLI reports, by this session's UUID only.
      const entry = this.worker.store.state.conversations[ckey];
      if (this.claudeCleanupNeeded(entry) && entry.claudeSessionCleanup?.status !== "complete") {
        try {
          const projectsDirectory = await this.claudeProjectsDirectory();
          await removeClaudeSession({ projectsDirectory, conversation: this.worker.store.snapshot().conversations[ckey] });
          await this.worker.store.change((s) => { s.conversations[ckey].claudeSessionCleanup = { status: "complete", completedAt: new Date().toISOString(), error: null }; });
        } catch {
          await this.worker.store.change((s) => {
            s.conversations[ckey].claudeSessionCleanup = { status: "blocked", nextAttemptAt: Date.now() + 30_000, error: "The removed conversation's Claude session could not be safely deleted. Cleanup will retry." };
          });
        }
      }
    }
  }
  async stopForLostAccess() {
    this.worker.setDispatchAllowed(false);
    for (const c of Object.values(this.worker.store.snapshot().conversations)) {
      if (c.ownerId === this.config.ownerId) await this.worker.handle({ id: randomUUID(), type: "stop", ownerId: c.ownerId, conversationId: c.conversationId });
    }
  }
  async loop() {
    let failures = 0;
    try {
      while (!this.closed) {
        try {
          const response = responseSchema.parse(await this.request("receive"));
          if (response.owner_id !== this.config.ownerId || response.device_id !== this.config.deviceId) throw new RemoteError("The board returned a different account or helper connection", true);
          this.worker.setDispatchAllowed(false);
          await this.cleanupRemoved(response.removed_thread_ids ?? []);
          // Drain the ordered batch before starting work; Stop may cancel an earlier wake.
          for (const event of response.requests) {
            if (this.closed) break;
            try { await this.apply(event, response.server_now); }
            catch (error) { if (!error.missing) throw error; await this.removed(event.id, event.thread_id); }
          }
          await this.flush();
          if (this.closed) break;
          await this.worker.store.change((s) => { s.remote.status = "connected"; s.remote.error = null; });
          failures = 0;
          this.worker.setDispatchAllowed(true);
          await this.delay(this.idleMs);
        } catch (error) {
          this.worker.setDispatchAllowed(false);
          if (this.closed) break;
          if (["EACCES", "EPERM", "ENOSPC", "EIO", "EROFS"].includes(error.code)) throw error;
          const permanent = error.permanent || error instanceof z.ZodError;
          await this.worker.store.change((s) => { s.remote.status = permanent ? "attention" : "disconnected"; s.remote.error = permanent ? "Reconnect this helper from your account before continuing." : "Connection interrupted; waiting to reconnect."; });
          if (permanent) { await this.stopForLostAccess(); break; }
          await this.delay(Math.min(this.maxRetryMs, this.retryMs * 2 ** Math.min(failures++, 6)));
        }
      }
    } catch (error) { this.worker.fatal(error); }
  }
  delay(ms) { return new Promise((resolve) => { this.wakeDelay = resolve; this.delayTimer = setTimeout(() => { this.wakeDelay = null; resolve(); }, ms); }); }
  async close() {
    this.closed = true; this.worker.setDispatchAllowed(false);
    this.activeRequest?.abort(); clearTimeout(this.delayTimer); this.wakeDelay?.();
    await this.done;
  }
}

