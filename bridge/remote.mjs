import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { ASSISTANTS, keyFor } from "./storage.mjs";
import { removeConversationWorkspace } from "./workspace-cleanup.mjs";
import { createConversationWorkspace, renameConversationWorkspace } from "./workspaces.mjs";

const uuid = z.string().uuid();
const assistant = z.enum(ASSISTANTS);
export const remoteConfigSchema = z.object({ url: z.string().url(), ownerId: uuid, deviceId: uuid, token: z.string().regex(/^duo_helper_[A-Za-z0-9_-]{43}$/) }).strict();
const timestamp = z.iso.datetime({ offset: true });
// `assistant` and `title` arrive from a board that knows about Claude sessions; an older board omits them.
const eventSchema = z.object({ id: uuid, seq: z.union([z.number(), z.string()]), thread_id: uuid, action: z.enum(["wake", "message", "stop", "pause", "activity", "transcribe"]), message_id: uuid.nullable(), prompt: z.string().min(1).max(100_000).nullable(), status: z.literal("pending"), created_at: timestamp, assistant: assistant.optional(), title: z.string().max(200).nullable().optional(), audio_url: z.string().url().optional(), audio_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), audio_bytes: z.number().int().min(44).max(20 * 1024 * 1024).nullable().optional() }).strict()
  .refine((e) => (e.action === "stop" || !e.message_id || Boolean(e.prompt)) && (e.action !== "message" || Boolean(e.message_id)) && (!["pause", "activity", "transcribe"].includes(e.action) || !e.message_id) && (e.action !== "transcribe" || Boolean(e.audio_url && e.audio_sha256 && e.audio_bytes)));
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
  constructor(worker, config, { fetchImpl = fetch, retryMs = 1000, maxRetryMs = 30_000, idleMs = 50, requestTimeoutMs = 22_000, transcriber = null } = {}) {
    this.worker = worker;
    this.config = remoteConfigSchema.parse(config);
    const url = new URL(this.config.url);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Use an HTTPS board origin, or localhost for development");
    this.origin = url.origin;
    Object.assign(this, { fetchImpl, retryMs, maxRetryMs, idleMs, requestTimeoutMs });
    this.closed = false;
    this.activeRequest = null;
    this.transcriber = transcriber;
    this.transcriptionReady = false;
    this.transcriptions = new Map();
  }
  async start() {
    this.worker.setDispatchAllowed(false);
    this.transcriptionReady = Boolean(this.transcriber && await this.transcriber.ready());
    await this.worker.store.change((s) => {
      if (s.remote && (s.remote.ownerId !== this.config.ownerId || s.remote.deviceId !== this.config.deviceId || s.remote.origin !== this.origin)) throw new Error("This state directory is paired with another board or account");
      s.remote ??= { ownerId: this.config.ownerId, deviceId: this.config.deviceId, origin: this.origin, instanceId: randomUUID(), events: {} };
      s.remote.status = "connecting"; s.remote.error = null;
    });
    this.instanceId = this.worker.store.snapshot().remote.instanceId;
    // Saved folder titles are local state and can be migrated even while the
    // board connection is offline or waiting to be reconnected.
    await this.syncWorkspaceNames();
    this.namingTimer = setInterval(() => {
      if (!this.closed && ["attention", "disconnected"].includes(this.worker.store.state.remote.status)) {
        void this.syncWorkspaceNames().catch((error) => this.worker.fatal(error));
      }
    }, 30_000);
    this.done = this.loop();
  }
  async request(action, payload = {}) {
    const controller = new AbortController(); this.activeRequest = controller;
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(`${this.origin}/api/agent/helper`, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.token}` },
        body: JSON.stringify({ action, instance_id: this.instanceId, conversations: this.report(), assistants: this.worker.managed, capabilities: this.transcriptionReady ? ["local_transcription"] : [], ...(action === "receive" ? { workspace_cleanup: true } : {}), ...payload }),
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
    return Object.entries(s.conversations).filter(([,c]) => c.ownerId === this.config.ownerId && c.workspaceCleanup?.status !== "complete" && (!c.removedAt || (c.workspaceCleanup?.nextAttemptAt ?? 0) <= Date.now())).slice(0,200).map(([key,c]) => {
      const jobs = Object.values(s.jobs).filter((j) => j.conversationKey === key);
      const lane = (name) => ({ working_on: jobs.find((j) => j.assistant === name && ["starting","running","recovering"].includes(j.status))?.requestId ?? null, queued: jobs.filter((j) => j.assistant === name && j.status === "queued").length });
      const chatgpt = lane("chatgpt"), claude = lane("claude");
      return { thread_id: c.conversationId, task_id: c.threadId, claude_session_id: c.claudeSessionId ?? null, mode: c.mode, working_on: chatgpt.working_on, queued: chatgpt.queued, claude_working_on: claude.working_on, claude_queued: claude.queued, chatgpt_attention: Boolean(c.attention?.chatgpt), claude_attention: Boolean(c.attention?.claude) };
    });
  }
  async linkConversation(event) {
    const root = this.worker.store.snapshot().workspaceRoot;
    if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Reconnect the helper once so it can prepare workspaces for new conversations");
    const workspace = await createConversationWorkspace({ workspaceRoot: root, ownerId: this.config.ownerId, conversationId: event.thread_id, title: event.title, conversations: this.worker.store.snapshot().conversations });
    const route = { ownerId: this.config.ownerId, conversationId: event.thread_id };
    await this.worker.handle({ id: commandId(event.id, "link"), type: "link", cwd: workspace, ...(event.title ? { title: event.title } : {}), ...route });
    // One Codex task and one reserved Claude session, both chosen locally; the board only learns their IDs.
    await this.worker.ensureSessions(route.ownerId, route.conversationId);
  }
  async syncWorkspaceNames() {
    if (this.naming) return this.naming;
    this.naming = this.updateWorkspaceNames();
    try { return await this.naming; }
    finally { this.naming = null; }
  }
  async updateWorkspaceNames() {
    const state = this.worker.store.snapshot();
    if (!state.workspaceRoot) return;
    for (const [key, c] of Object.entries(state.conversations)) {
      if (c.ownerId !== this.config.ownerId || c.removedAt || c.creating || (c.workspaceNameRetryAt ?? 0) > Date.now()) continue;
      if ([...this.worker.active.values()].some((run) => run.conversationKey === key) || Object.values(state.jobs).some((job) => job.conversationKey === key && ["starting", "running", "recovering"].includes(job.status))) continue;
      try {
        const result = await renameConversationWorkspace(this.worker.store, key);
        if (result.changed && c.threadId) this.worker.loaded.delete(c.threadId);
        if (c.workspaceNameError || c.workspaceNameRetryAt) await this.worker.store.change((s) => { delete s.conversations[key].workspaceNameError; delete s.conversations[key].workspaceNameRetryAt; });
      } catch (error) {
        if (["ENOSPC", "EIO", "EROFS"].includes(error.code)) throw error;
        await this.worker.store.change((s) => {
          s.conversations[key].workspaceNameError = ["EBUSY", "EPERM", "EACCES"].includes(error.code)
            ? "Windows is keeping this folder in use or restricting access. The helper will retry its rename."
            : "The conversation folder could not be renamed yet. The helper will retry.";
          s.conversations[key].workspaceNameRetryAt = Date.now() + 30_000;
        });
      }
    }
  }
  async apply(event, serverNow) {
    const ckey = keyFor(this.config.ownerId, event.thread_id);
    const route = { ownerId: this.config.ownerId, conversationId: event.thread_id };
    if (this.worker.store.state.conversations[ckey]?.removedAt) return;
    if (event.action === "transcribe") { this.startTranscription(event); return; }
    // A persisted move may need recovery after a restart. Leave this event
    // unacknowledged until its verified local folder is ready again.
    if (this.worker.store.state.conversations[ckey]?.workspaceRename) return;
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
  startTranscription(event) {
    if (this.worker.store.snapshot().remote.events[event.id] || this.transcriptions.has(event.id)) return;
    if (!this.transcriptionReady) return;
    const controller = new AbortController();
    const task = (async () => {
      try {
        const result = await this.transcriber.transcribe({ id: event.id, audioUrl: event.audio_url, audioBytes: event.audio_bytes, audioSha256: event.audio_sha256, signal: controller.signal });
        await this.worker.store.change((s) => { s.remote.events[event.id] = { threadId: event.thread_id, jobKey: null, action: "transcribe", status: "completed", result, error: null, waitingFor: [], reported: false }; });
      } catch {
        if (controller.signal.aborted) return;
        await this.worker.store.change((s) => { s.remote.events[event.id] = { threadId: event.thread_id, jobKey: null, action: "transcribe", status: "failed", result: null, error: "Local Whisper could not transcribe this recording. Run Repair Duo Board Helper, then try again.", waitingFor: [], reported: false }; });
      } finally { this.transcriptions.delete(event.id); }
    })();
    this.transcriptions.set(event.id, { controller, task });
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
      try { await this.request("result", { id, status: job?.status ?? event.status ?? (event.action === "stop" ? "stopped" : "completed"), result: job?.result ?? event.result ?? null, error: event.error ?? (job?.error ? "The local task needs attention. Check the helper on your computer." : null) }); }
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
  /** Missing requests alone never authorize filesystem cleanup; only removal receipts do. */
  async cleanupRemoved(threadIds) {
    for (const threadId of new Set(threadIds)) {
      const ckey = keyFor(this.config.ownerId, threadId);
      const c = this.worker.store.state.conversations[ckey];
      if (!c || c.ownerId !== this.config.ownerId || c.workspaceCleanup?.status === "complete") continue;
      await this.worker.store.change((s) => {
        const entry = s.conversations[ckey];
        entry.removedAt ??= new Date().toISOString();
        entry.workspaceCleanup = { status: "pending", nextAttemptAt: Date.now() + 1000, error: null };
      });
      await this.worker.handle({ id: commandId(threadId, "workspace-removal"), type: "stop", ownerId: this.config.ownerId, conversationId: threadId });
      // Allow active turns to finish stopping while the remote connection keeps
      // serving other conversations. Retry on the next authenticated receipt.
      if ([...this.worker.active.values()].some((run) => run.conversationKey === ckey)) continue;
      try {
        // A crash may have moved the folder before its saved path was committed.
        // Settle that journal before deciding which folder to remove.
        if (this.worker.store.state.conversations[ckey].workspaceRename) await renameConversationWorkspace(this.worker.store, ckey);
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
          await this.syncWorkspaceNames();
          // Drain the ordered batch before starting work; Stop may cancel an earlier wake.
          for (const event of response.requests) {
            if (this.closed) break;
            try { await this.apply(event, response.server_now); }
            catch (error) { if (!error.missing) throw error; await this.removed(event.id, event.thread_id); }
          }
          await this.syncWorkspaceNames();
          await this.flush();
          if (this.closed) break;
          await this.worker.store.change((s) => { s.remote.status = "connected"; s.remote.error = null; });
          failures = 0;
          this.worker.setDispatchAllowed(true);
          // A transcription stays unacknowledged until its durable result is
          // ready. Keep servicing the board without hot-looping its signed URL.
          await this.delay(this.transcriptions.size ? 5_000 : this.idleMs);
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
    clearInterval(this.namingTimer);
    this.activeRequest?.abort(); clearTimeout(this.delayTimer); this.wakeDelay?.();
    for (const item of this.transcriptions.values()) item.controller.abort();
    await this.done;
    await this.naming;
    await Promise.allSettled([...this.transcriptions.values()].map((item) => item.task));
  }
}

