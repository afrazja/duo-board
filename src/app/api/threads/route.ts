import { createThread, deleteThread, listThreads, setThreadPreferences } from "@/lib/board";
import { sessionIsValid, SESSION_COOKIE } from "@/lib/session";
import { cookies } from "next/headers";
import { z } from "zod";

export async function GET() {
  try {
    return Response.json({ threads: await listThreads() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  if (!await sessionIsValid((await cookies()).get(SESSION_COOKIE)?.value)) return Response.json({ error: "Not signed in" }, { status: 401 });
  try {
    const parsed = z.object({ thread_id: z.string().uuid(), brief_audio: z.boolean().optional(), blind_first_round: z.boolean().optional(), paused: z.boolean().optional() })
      .refine((value) => value.brief_audio !== undefined || value.blind_first_round !== undefined || value.paused !== undefined).safeParse(await req.json());
    if (!parsed.success) return Response.json({ error: "A valid thread_id and at least one boolean preference are required" }, { status: 400 });
    const { thread_id, ...preferences } = parsed.data;
    return Response.json({ thread: await setThreadPreferences(thread_id, preferences) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { title?: unknown };
    const thread = await createThread(typeof body.title === "string" ? body.title : "");
    return Response.json({ thread });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

// Remove a conversation for good: the thread, its messages, their delivery
// records and both assistants' places for it. The exact title is required as
// the server-side half of the warning the page shows. There is no undo.
export async function DELETE(req: Request) {
  if (!await sessionIsValid((await cookies()).get(SESSION_COOKIE)?.value)) return Response.json({ error: "Not signed in" }, { status: 401 });
  try {
    const parsed = z.object({ thread_id: z.string().uuid(), confirm_title: z.string().min(1).max(120) }).safeParse(await req.json());
    if (!parsed.success) return Response.json({ error: "thread_id and confirm_title are required" }, { status: 400 });
    const result = await deleteThread(parsed.data.thread_id, parsed.data.confirm_title);
    if (result.deleted) return Response.json(result);
    if (result.reason === "not_found") return Response.json({ error: "That conversation no longer exists" }, { status: 404 });
    return Response.json({ error: "The title does not match; type the conversation's exact title to remove it" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
