export type HelperMode = "ready" | "sleeping" | "paused" | "attention";
export interface HelperRequest {
  id: string; action: string; message_id: string | null;
  status: "pending" | "received" | "stop_requested" | "completed" | "stopped" | "failed" | "attention" | "cancelled";
  error?: string | null;
}
export interface HelperView {
  configured: boolean; connected: boolean;
  conversation: { thread_id: string; task_id?: string | null; mode: HelperMode; working_on: string | null; queued: number } | null;
  requests: HelperRequest[];
}

export function helperLabel(view: HelperView | null, error = "") {
  if (error) return "Connection unavailable";
  if (!view) return "Checking connection…";
  if (!view.configured) return "Helper not connected";
  if (!view.connected) return "Computer offline";
  if (!view.conversation) return "Conversation not linked";
  if (view.conversation.working_on) return "Working";
  return { ready: "Ready", sleeping: "Sleeping", paused: "Paused", attention: "Needs attention" }[view.conversation.mode];
}

export function helperRequestState(view: HelperView | null, messageId: string) {
  if (!view?.configured) return null;
  const requests = view.requests.filter((r) => r.message_id === messageId);
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
  if (view.conversation.mode === "attention") return "attention";
  if (view.conversation.working_on === messageId) return "working";
  return "queued";
}
