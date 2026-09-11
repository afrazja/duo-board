import { assistantStatus, findCompare, getThreadPreferences, getMessages, postMessage, type Audience } from "@/lib/board";
import { currentAccount } from "@/lib/account";

const AUDIENCES: Audience[] = ["both", "claude", "chatgpt", "none"];
const signedOut = () => Response.json({ error: "Not signed in" }, { status: 401 });

// The page polls this every few seconds with the last seq it has, so a quiet
// board costs one small query per poll.
export async function GET(req: Request) {
  const account = await currentAccount();
  if (!account) return signedOut();
  const url = new URL(req.url);
  const thread = url.searchParams.get("thread");
  const after = Number(url.searchParams.get("after") ?? 0);
  if (!thread) return Response.json({ error: "thread is required" }, { status: 400 });
  try {
    const [messages, assistants, preferences] = await Promise.all([
      getMessages(account.owner, thread, Number.isFinite(after) ? after : 0),
      assistantStatus(account.owner),
      getThreadPreferences(account.owner, thread),
    ]);
    return Response.json({ messages, assistants, ...preferences, now: new Date().toISOString() });
  } catch (e) {
    if ((e as Error).message === "Conversation not found") return Response.json({ missing: true, messages: [] }, { status: 404 });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const account = await currentAccount();
  if (!account) return signedOut();
  try {
    const body = (await req.json()) as { thread_id?: unknown; body?: unknown; addressed_to?: unknown; reply_to?: unknown; kind?: unknown };
    if (typeof body.thread_id !== "string" || typeof body.body !== "string") {
      return Response.json({ error: "thread_id and body are required" }, { status: 400 });
    }
    const replyTo = typeof body.reply_to === "string" ? body.reply_to : null;
    // A compare request always goes to both and must name the question it is about.
    const compare = body.kind === "compare";
    if (compare && !replyTo) return Response.json({ error: "a compare request needs reply_to" }, { status: 400 });
    if (compare && replyTo) {
      // One compare per question: a repeat click returns the request already made.
      const existing = await findCompare(account.owner, body.thread_id, replyTo);
      if (existing) return Response.json({ message: existing, existing: true });
    }
    const addressedTo = compare ? "both" : AUDIENCES.includes(body.addressed_to as Audience) ? (body.addressed_to as Audience) : "both";
    const message = await postMessage({ owner: account.owner, threadId: body.thread_id, author: "user", addressedTo, body: body.body, replyTo, kind: compare ? "compare" : "message" });
    return Response.json({ message });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
