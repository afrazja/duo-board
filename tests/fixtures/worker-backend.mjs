import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { CodexClient } from "../../bridge/codex-client.mjs";
export class Backend {
  constructor() { this.threads = new Map(); this.starts = []; this.names = []; this.sectionMoves = []; this.clients = 0; this.created = 0; this.materializations = 0; this.maxParallel = 0; this.busy = new Set(); this.failConnections = 0; this.conflict = false; }
  client() { this.clients++; return new FakeClient(this); }
}
class FakeClient extends EventEmitter {
  constructor(backend) { super(); this.backend = backend; this.recent = []; this.sequence = 0; this.closed = false; this.owned = new Set(); this.timers = new Set(); }
  async initialize() { if (this.backend.failConnections-- > 0) throw new Error("Temporary connection failure"); }
  waitFor(...args) { return CodexClient.prototype.waitFor.call(this, ...args); }
  notify(method, params) { const e = { method, params, sequence: ++this.sequence }; this.recent.push(e); this.emit("notification", e); }
  complete(threadId, turn, status = "completed") {
    turn.status = status;
    this.backend.busy.delete(threadId);
    if (status === "completed") turn.items.push({ type: "agentMessage", id: randomUUID(), phase: "final_answer", text: this.backend.answerText?.(turn.items[0].content[0].text) ?? `Answer: ${turn.items[0].content[0].text}` });
    this.notify("turn/completed", { threadId, turn: structuredClone(turn) });
  }
  async call(method, params) {
    if (this.closed) throw new Error("Codex connection closed");
    const b = this.backend;
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "thread/start") {
      const thread = { id: randomUUID(), turns: [], preview: "", ephemeral: params.ephemeral ?? false }; b.created++; b.threads.set(thread.id, thread); this.owned.add(thread.id); return { thread: structuredClone(thread) };
    }
    if (method === "thread/resume") {
      if (b.conflict) throw new Error("Thread already has an active writer");
      if (!b.threads.has(params.threadId)) throw new Error("Thread not found");
      this.owned.add(params.threadId);
      return { thread: structuredClone(b.threads.get(params.threadId)) };
    }
    if (method === "thread/name/set") {
      const thread = b.threads.get(params.threadId);
      if (!thread) throw new Error("Thread not found");
      thread.name = params.name;
      b.names.push({ threadId: params.threadId, name: params.name });
      return {};
    }
    if (method === "thread/read") return { thread: structuredClone(b.threads.get(params.threadId)) };
    if (method === "thread/list") return { data: [...b.threads.values()].filter((thread) => thread.section?.id === params.sectionId).map((thread) => structuredClone(thread)) };
    if (method === "thread/section/move") {
      const thread = b.threads.get(params.threadId);
      thread.section = { id: params.sectionId, name: "Duo Board" };
      b.sectionMoves.push(structuredClone(params));
      return {};
    }
    if (method === "turn/start") {
      assert.equal(b.busy.has(params.threadId), false, "Overlapping turns in the same conversation");
      const text = params.input[0].text;
      if (text === "lost-before-start") throw new Error("Transport closed before a response was received");
      const turn = { id: randomUUID(), status: "inProgress", items: [{ type: "userMessage", clientId: params.clientUserMessageId, content: params.input }] };
      const thread = b.threads.get(params.threadId);
      thread.turns.push(turn); thread.preview ||= text;
      if (text === "Connected to Duo Board. No work is requested.") b.materializations++;
      else b.starts.push({ threadId: params.threadId, text });
      b.busy.add(params.threadId); b.maxParallel = Math.max(b.maxParallel, b.busy.size);
      if (text === "lost-after-start") { this.complete(params.threadId, turn); throw new Error("Connection lost after the server accepted the request"); }
      if (text === "needs-approval") setTimeout(() => this.emit("unsupportedRequest", { method: "item/commandExecution/requestApproval", threadId: params.threadId, turnId: turn.id }), 5);
      if (!text.startsWith("hold") && !text.includes("<user_request>\nhold") && text !== "needs-approval") {
        const timer = setTimeout(() => { if (turn.status === "inProgress") this.complete(params.threadId, turn); }, 45);
        this.timers.add(timer);
      }
      return { turn: structuredClone(turn) };
    }
    if (method === "turn/interrupt") {
      const turn = b.threads.get(params.threadId).turns.find((t) => t.id === params.turnId);
      if (turn?.status === "inProgress") this.complete(params.threadId, turn, "interrupted");
      return {};
    }
    if (method === "thread/revert") {
      const thread = b.threads.get(params.threadId);
      const index = thread.turns.findIndex((turn) => turn.id === params.beforeTurnId);
      if (index < 0) throw new Error("Turn not found");
      thread.turns.splice(index);
      return { thread: structuredClone(thread) };
    }
    throw new Error(`Unexpected method ${method}`);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    for (const id of this.owned) for (const turn of this.backend.threads.get(id).turns) if (turn.status === "inProgress") { turn.status = "interrupted"; this.backend.busy.delete(id); }
    this.emit("disconnected", new Error("Codex connection closed"));
  }
}
