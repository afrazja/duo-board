import { createThread, listThreads, setThreadPreferences } from "@/lib/board";
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
