import { identify, unauthorized } from "@/lib/agent-auth";
import { listThreads, postMessage, readNew, readThread, rewind } from "@/lib/board";
import { acknowledgeDeletion, listDeletions } from "@/lib/deletions";
import { z } from "zod";

// A plain HTTP mirror of the MCP tools, for assistants or scripts that find
// a curl easier than an MCP client. Same tokens, same functions. The token
// decides both whose board and which assistant is speaking.
//
//   GET  /api/agent/new[?thread=<uuid>] -> unread messages, cursor advances (one thread only, with thread)
//   GET  /api/agent/threads             -> thread list
//   GET  /api/agent/thread?id=<uuid>    -> latest messages of one thread
//   GET  /api/agent/deletions           -> removal receipts awaiting this assistant's cleanup
//   POST /api/agent/post {thread_id, body, reply_to?, spoken_summary?}
//   POST /api/agent/rewind {to_seq, thread_id?}
//   POST /api/agent/deletion-cleanup {thread_id, status: complete|blocked}

type Ctx = { params: Promise<{ action: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const id = await identify(req);
  if (!id) return unauthorized();
  const { owner, who } = id;
  const { action } = await ctx.params;
  try {
    if (action === "deletions") return Response.json({ deletions: await listDeletions(owner, who) });
    if (action === "new") {
      const thread = new URL(req.url).searchParams.get("thread") ?? undefined;
      return Response.json({ assistant: who, ...(await readNew(owner, who, 100, thread)) });
    }
    if (action === "threads") return Response.json({ threads: await listThreads(owner) });
    if (action === "thread") {
      const threadId = new URL(req.url).searchParams.get("id");
      if (!threadId) return Response.json({ error: "id is required" }, { status: 400 });
      return Response.json({ messages: await readThread(owner, threadId, 60, who) });
    }
    return Response.json({ error: "Unknown action" }, { status: 404 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: Ctx) {
  const id = await identify(req);
  if (!id) return unauthorized();
  const { owner, who } = id;
  const { action } = await ctx.params;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (action === "deletion-cleanup") {
      const parsed = z.object({ thread_id: z.string().uuid(), status: z.enum(["complete", "blocked"]) }).safeParse(body);
      if (!parsed.success) return Response.json({ error: "thread_id and cleanup status are required" }, { status: 400 });
      return Response.json({ deletion: await acknowledgeDeletion(owner, who, parsed.data.thread_id, parsed.data.status) });
    }
    if (action === "post") {
      if (typeof body.thread_id !== "string" || typeof body.body !== "string") {
        return Response.json({ error: "thread_id and body are required" }, { status: 400 });
      }
      const message = await postMessage({
        owner,
        threadId: body.thread_id,
        author: who,
        body: body.body,
        replyTo: typeof body.reply_to === "string" ? body.reply_to : null,
        spokenSummary: typeof body.spoken_summary === "string" ? body.spoken_summary : null,
      });
      return Response.json({ message });
    }
    if (action === "rewind") {
      await rewind(owner, who, Number(body.to_seq ?? 0), typeof body.thread_id === "string" ? body.thread_id : undefined);
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Unknown action" }, { status: 404 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
