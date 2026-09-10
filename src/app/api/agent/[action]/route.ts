import { identify, unauthorized } from "@/lib/agent-auth";
import { listThreads, postMessage, readNew, readThread, rewind } from "@/lib/board";

// A plain HTTP mirror of the MCP tools, for assistants or scripts that find
// a curl easier than an MCP client. Same tokens, same functions.
//
//   GET  /api/agent/new                 -> unread messages, cursor advances
//   GET  /api/agent/threads             -> thread list
//   GET  /api/agent/thread?id=<uuid>    -> latest messages of one thread
//   POST /api/agent/post {thread_id, body, reply_to?}
//   POST /api/agent/rewind {to_seq}

type Ctx = { params: Promise<{ action: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const who = identify(req);
  if (!who) return unauthorized();
  const { action } = await ctx.params;
  try {
    if (action === "new") return Response.json({ assistant: who, ...(await readNew(who)) });
    if (action === "threads") return Response.json({ threads: await listThreads() });
    if (action === "thread") {
      const id = new URL(req.url).searchParams.get("id");
      if (!id) return Response.json({ error: "id is required" }, { status: 400 });
      return Response.json({ messages: await readThread(id) });
    }
    return Response.json({ error: "Unknown action" }, { status: 404 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: Ctx) {
  const who = identify(req);
  if (!who) return unauthorized();
  const { action } = await ctx.params;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (action === "post") {
      if (typeof body.thread_id !== "string" || typeof body.body !== "string") {
        return Response.json({ error: "thread_id and body are required" }, { status: 400 });
      }
      const message = await postMessage({
        threadId: body.thread_id,
        author: who,
        body: body.body,
        replyTo: typeof body.reply_to === "string" ? body.reply_to : null,
        spokenSummary: typeof body.spoken_summary === "string" ? body.spoken_summary : null,
      });
      return Response.json({ message });
    }
    if (action === "rewind") {
      await rewind(who, Number(body.to_seq ?? 0));
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Unknown action" }, { status: 404 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
