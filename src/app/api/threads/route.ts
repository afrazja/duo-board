import { createThread, listThreads, setBriefAudio } from "@/lib/board";
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
    const parsed = z.object({ thread_id: z.string().uuid(), brief_audio: z.boolean() }).safeParse(await req.json());
    if (!parsed.success) return Response.json({ error: "A valid thread_id and brief_audio boolean are required" }, { status: 400 });
    return Response.json({ thread: await setBriefAudio(parsed.data.thread_id, parsed.data.brief_audio) });
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
