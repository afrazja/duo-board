import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

type RpcResult = { data: unknown; error: { message: string; code?: string } | null };
type Dependencies = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
  requireUser: (request: Request) => Promise<{ id: string }>;
  listRemovedThreads?: (ownerId: string, threadIds: string[]) => Promise<string[]>;
  waitMs?: number;
};
const id = z.string().uuid();
const assistant = z.enum(["chatgpt", "claude"]);
const count = z.number().int().min(0).max(100000);
// Per-conversation status: the Codex task and Claude session IDs plus each assistant's lane.
const conversations = z.array(z.object({ thread_id: id, task_id: id.nullable().optional(), claude_session_id: id.nullable().optional(), mode: z.enum(["ready","sleeping","paused","attention"]), working_on: id.nullable(), queued: count, claude_working_on: id.nullable().optional(), claude_queued: count.optional(), chatgpt_attention: z.boolean().optional(), claude_attention: z.boolean().optional() }).strict()).max(200).optional();
// Which assistants the helper runs; an older helper omits it and stays ChatGPT-only.
const assistants = z.array(assistant).max(2).optional();
const requestSchema = z.object({ id, thread_id: id, action: z.enum(["wake", "message", "stop", "activity"]), message_id: id.optional(), assistant: assistant.optional() }).strict()
  .refine((r) => (r.action !== "message" || Boolean(r.message_id)) && (r.action !== "activity" || !r.message_id));
const deviceSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("receive"), instance_id: id, conversations, assistants, wait: z.boolean().optional(), workspace_cleanup: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("ack"), instance_id: id, conversations, assistants, id, rejected: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("result"), instance_id: id, conversations, assistants, id, status: z.enum(["completed", "stopped", "failed", "attention"]), result: z.string().max(1_000_000).nullable().optional(), error: z.string().max(1000).nullable().optional() }).strict(),
]);
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
const mapped: Record<string, [number, string]> = {
  HELPER_UNAUTHORIZED: [401, "Helper connection is missing or revoked"],
  HELPER_NOT_CONFIGURED: [409, "Connect the helper first"],
  HELPER_NOT_FOUND: [404, "Conversation or request not found"],
  HELPER_CONFLICT: [409, "Request ID was already used"],
  HELPER_INSTANCE_CONFLICT: [409, "This connection key belongs to another helper instance"],
  HELPER_TASK_STOPPED: [409, "This task was stopped; send a new request to continue"],
  HELPER_BAD_REQUEST: [400, "Invalid helper request"],
  HELPER_THREAD_PAUSED: [423, "Conversation paused; the saved answer will wait for Resume"],
};
async function body(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new HttpError(415, "Use application/json");
  // Limit bytes while reading, rather than trusting a client-controlled length header.
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "A JSON body is required");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 4_100_000) { await reader.cancel(); throw new HttpError(413, "Request is too large"); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "Invalid JSON body"); }
}
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, "Cross-site helper changes are not allowed");
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new HttpError(403, "Cross-site helper changes are not allowed");
}
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** Shared HTTP handlers used by Next routes and the isolated integration tests. */
export function helperHandlers({ rpc, requireUser, listRemovedThreads, waitMs = 15_000 }: Dependencies) {
  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data, error } = await rpc(name, args);
    if (error) {
      const entry = Object.entries(mapped).find(([key]) => error.message.includes(key));
      if (entry) throw new HttpError(...entry[1]);
      throw new HttpError(503, "Helper storage is unavailable. The request has not been confirmed; retry with the same ID.");
    }
    return data as Record<string, unknown>;
  }
  async function protect(fn: () => Promise<Response>) {
    try { return await fn(); }
    catch (error) {
      if ((error as Error).message === "AUTH_REQUIRED") return json({ error: "Not signed in" }, 401);
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      if (error instanceof z.ZodError) return json({ error: "Invalid helper request" }, 400);
      return json({ error: "Helper request could not be completed" }, 500);
    }
  }
  return {
    account: (request: Request) => protect(async () => {
      const user = await requireUser(request);
      if (request.method === "GET") return json(await call("helper_user", { p_owner: user.id, p_action: "status", p_args: {} }));
      sameOrigin(request);
      if (request.method === "DELETE") return json(await call("helper_user", { p_owner: user.id, p_action: "revoke", p_args: {} }));
      if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
      const { name } = z.object({ name: z.string().trim().min(1).max(80) }).strict().parse(await body(request));
      const token = `duo_helper_${randomBytes(32).toString("base64url")}`;
      const configured = await call("helper_user", { p_owner: user.id, p_action: "configure", p_args: { name, token_hash: createHash("sha256").update(token).digest("hex") } });
      return json({ connection: { url: new URL(request.url).origin, ownerId: user.id, deviceId: configured.device_id, token } }, 201);
    }),
    requests: (request: Request) => protect(async () => {
      const user = await requireUser(request);
      if (request.method === "GET") {
        const thread_id = id.parse(new URL(request.url).searchParams.get("thread"));
        return json(await call("helper_user", { p_owner: user.id, p_action: "requests", p_args: { thread_id } }));
      }
      if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
      sameOrigin(request);
      const args = requestSchema.parse(await body(request));
      return json(await call("helper_user", { p_owner: user.id, p_action: "enqueue", p_args: args }), 202);
    }),
    device: (request: Request) => protect(async () => {
      if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
      // No URL tokens, account cookies, legacy board tokens, or claimed owner IDs.
      const token = request.headers.get("authorization")?.match(/^Bearer (duo_helper_[A-Za-z0-9_-]{43})$/)?.[1];
      if (!token) throw new HttpError(401, "A helper connection key is required");
      const args = deviceSchema.parse(await body(request));
      const { action, instance_id, ...payload } = args;
      const params = { p_hash: createHash("sha256").update(token).digest("hex"), p_instance: instance_id, p_action: action, p_args: payload };
      const until = Date.now() + (action === "receive" && args.wait !== false ? waitMs : 0);
      for (;;) {
        const result = await call("helper_device", params);
        if (args.action === "receive" && args.workspace_cleanup === true) {
          // Authenticate through the existing RPC first; the request never supplies an owner.
          // Old helpers reject unknown response keys, so receipts are capability-negotiated.
          const owner = id.safeParse(result.owner_id);
          if (!owner.success || !listRemovedThreads) throw new HttpError(503, "Workspace removal status is temporarily unavailable");
          const reported = [...new Set((args.conversations ?? []).map((conversation) => conversation.thread_id))];
          try {
            const removed = reported.length ? await listRemovedThreads(owner.data, reported) : [];
            // Only explicit removal receipts can authorize cleanup, never a missing thread.
            result.removed_thread_ids = [...new Set(removed.filter((threadId) => reported.includes(threadId)))];
          } catch { throw new HttpError(503, "Workspace removal status is temporarily unavailable"); }
        }
        if (action !== "receive" || (result.requests as unknown[]).length || (result.removed_thread_ids as string[] | undefined)?.length || Date.now() >= until || request.signal.aborted) return json(result);
        await wait(Math.min(750, until - Date.now()), request.signal);
      }
    }),
  };
}
