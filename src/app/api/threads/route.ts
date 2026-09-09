import { createThread, listThreads } from "@/lib/board";

export async function GET() {
  try {
    return Response.json({ threads: await listThreads() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
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
