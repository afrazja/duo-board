export type HelperAssistant = "chatgpt" | "claude";
export type HelperMode = "ready" | "sleeping" | "paused" | "attention";
export interface HelperRequest {
  id: string; action: string; message_id: string | null;
  /** Which assistant the request belongs to; an older board omits it (ChatGPT). */
  assistant?: HelperAssistant;
  status: "pending" | "received" | "stop_requested" | "completed" | "stopped" | "failed" | "attention" | "cancelled";
  error?: string | null;
}
export interface HelperConversation {
  thread_id: string;
  /** The conversation's own Codex task. */
  task_id?: string | null;
  /** The conversation's own Claude Code session. */
  claude_session_id?: string | null;
  mode: HelperMode;
  working_on: string | null; queued: number;
  claude_working_on?: string | null; claude_queued?: number;
  chatgpt_attention?: boolean; claude_attention?: boolean;
}
export interface HelperView {
  configured: boolean; connected: boolean;
  /** Assistants the paired helper runs; absent on an older board (ChatGPT only). */
  managed_assistants?: HelperAssistant[];
  conversation: HelperConversation | null;
  requests: HelperRequest[];
}

/** Whether the helper answers for this assistant. ChatGPT always once configured; Claude only when reported. */
export function helperManages(view: HelperView | null | undefined, assistant: HelperAssistant) {
  if (!view?.configured) return false;
  return assistant === "chatgpt" ? !view.managed_assistants || view.managed_assistants.includes("chatgpt") : Boolean(view.managed_assistants?.includes("claude"));
}

function lane(conversation: HelperConversation, assistant: HelperAssistant) {
  return assistant === "claude"
    ? { working_on: conversation.claude_working_on ?? null, queued: conversation.claude_queued ?? 0, attention: Boolean(conversation.claude_attention) }
    : { working_on: conversation.working_on, queued: conversation.queued, attention: Boolean(conversation.chatgpt_attention) };
}

export function helperLabel(view: HelperView | null, error = "", assistant: HelperAssistant = "chatgpt") {
  if (error) return "Connection unavailable";
  if (!view) return "Checking connection…";
  if (!view.configured) return "Helper not connected";
  if (!helperManages(view, assistant)) return assistant === "claude" ? "Claude Code not installed on your computer" : "Not managed by the helper";
  if (!view.connected) return "Computer offline";
  if (!view.conversation) return "Conversation not linked";
  const own = lane(view.conversation, assistant);
  if (own.attention) return "Needs attention";
  if (own.working_on) return "Working";
  return { ready: "Ready", sleeping: "Sleeping", paused: "Paused", attention: "Needs attention" }[view.conversation.mode];
}

export function helperRequestState(view: HelperView | null, messageId: string, assistant: HelperAssistant = "chatgpt") {
  if (!view?.configured || !helperManages(view, assistant)) return null;
  const requests = view.requests.filter((r) => r.message_id === messageId && (r.assistant ?? "chatgpt") === assistant);
  const stop = requests.findLast((r) => r.action === "stop");
  if (stop) return ["stopped","completed"].includes(stop.status) ? "stopped" : ["failed","attention","cancelled"].includes(stop.status) ? "attention" : "stopping";
  const work = requests.findLast((r) => ["wake","message"].includes(r.action));
  if (!work) return null;
  if (work.status === "stop_requested") return "stopping";
  if (["cancelled","stopped"].includes(work.status)) return "stopped";
  if (["failed","attention"].includes(work.status)) return "attention";
  if (work.status === "completed") return "completed";
  if (!view.connected) return "offline";
  if (!view.conversation) return "unlinked";
  if (view.conversation.mode === "paused") return "paused";
  if (view.conversation.mode === "sleeping") return "sleeping";
  const own = lane(view.conversation, assistant);
  if (view.conversation.mode === "attention" || own.attention) return "attention";
  if (own.working_on === messageId) return "working";
  return "queued";
}
