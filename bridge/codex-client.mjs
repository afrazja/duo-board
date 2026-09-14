import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

/** A private stdio connection. Closing it never terminates the desktop app. */
export class CodexClient extends EventEmitter {
  constructor({ executable = "codex", args = ["app-server", "--stdio"], cwd = process.cwd(), env = process.env, timeoutMs = 30_000 } = {}) {
    super();
    this.nextId = 0;
    this.sequence = 0;
    this.pending = new Map();
    this.recent = [];
    this.timeoutMs = timeoutMs;
    this.closed = false;
    this.stderr = "";
    this.child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (data) => { this.stderr = (this.stderr + data.toString()).slice(-4000); });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.disconnect(new Error("Codex returned an invalid protocol message")); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        this.disconnect(new Error("Codex returned an invalid protocol message"));
        return;
      }
      this.receive(message);
    });
    this.child.on("error", (error) => this.disconnect(error));
    this.child.stdin.on("error", (error) => this.disconnect(error));
    this.exited = new Promise((resolve) => {
      this.child.once("close", (code) => {
        this.disconnect(new Error(`Codex connection closed (${code ?? "signal"})`));
        resolve();
      });
    });
  }

  receive(message) {
    // Server requests have both an id and method; their ids can overlap ours.
    if (message.method) {
      if (message.id !== undefined) {
        this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "This helper does not yet support interactive approvals or tool requests." } }) + "\n");
        this.emit("unsupportedRequest", { method: message.method, threadId: message.params?.threadId, turnId: message.params?.turnId });
        return;
      }
      const event = { ...message, sequence: ++this.sequence };
      this.recent.push(event);
      if (this.recent.length > 128) this.recent.shift();
      this.emit("notification", event);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    } else pending.resolve(message.result);
  }

  call(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("Codex connection is closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  async initialize() {
    const result = await this.call("initialize", { clientInfo: { name: "duo_board_helper", title: "Duo Board helper", version: "0.1.0" } });
    this.child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    return result;
  }

  waitFor(predicate, { after = this.sequence, timeoutMs = 60_000 } = {}) {
    const found = this.recent.find((event) => event.sequence > after && predicate(event));
    if (found) return Promise.resolve(found);
    if (this.closed) return Promise.reject(new Error("Codex connection is closed"));
    return new Promise((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer);
        this.off("notification", onEvent);
        this.off("disconnected", onClose);
      };
      const onEvent = (event) => {
        if (event.sequence > after && predicate(event)) { clean(); resolve(event); }
      };
      const onClose = (error) => { clean(); reject(error); };
      const timer = setTimeout(() => { clean(); reject(new Error("Timed out waiting for a Codex event")); }, timeoutMs);
      this.on("notification", onEvent);
      this.on("disconnected", onClose);
    });
  }

  disconnect(error) {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    this.emit("disconnected", error);
  }

  async close() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 5000);
    try { await this.exited; }
    finally { clearTimeout(timer); this.lines.close(); }
  }
}
