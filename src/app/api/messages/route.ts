import { assistantStatus, getBriefAudio, getMessages, postMessage, type Audience } from "@/lib/board";

const AUDIENCES: Audience[] = ["both", "claude", "chatgpt", "none"];

// The page polls this every few seconds with the last seq it has, so a quiet
// board costs one small query per poll.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const thread = url.searchParams.get("thread");
  const after = Number(url.searchParams.get("after") ?? 0);
  if (!thread) return Response.json({ error: "thread is required" }, { status: 400 });
  try {
    const [messages, assistants, brief_audio] = await Promise.all([getMessages(thread, Number.isFinite(after) ? after : 0), assistantStatus(), getBriefAudio(thread)]);
    return Response.json({ messages, assistants, brief_audio, now: new Date().toISOString() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { thread_id?: unknown; body?: unknown; addressed_to?: unknown };
    const addressedTo = AUDIENCES.includes(body.addressed_to as Audience) ? (body.addressed_to as Audience) : "both";
    if (typeof body.thread_id !== "string" || typeof body.body !== "string") {
      return Response.json({ error: "thread_id and body are required" }, { status: 400 });
    }
    const message = await postMessage({ threadId: body.thread_id, author: "user", addressedTo, body: body.body });
    return Response.json({ message });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
