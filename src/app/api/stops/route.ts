import { z } from "zod";
import { stopQuestion } from "@/lib/board";
import { authErrorResponse, requireUser } from "@/lib/account-auth";

// Stop one assistant's work on one of the person's messages, from that
// assistant's waiting card. Afterwards the board never delivers the message
// to that assistant, tells it about the stop on its next read, and refuses
// any answer from it to that message. The other assistant carries on.
const NAMES = { claude: "Claude", chatgpt: "ChatGPT" } as const;

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const parsed = z.object({ question_id: z.string().uuid(), assistant: z.enum(["claude", "chatgpt"]).default("claude") }).safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "A valid question_id is required" }, { status: 400 });
    const { question_id, assistant } = parsed.data;
    const result = await stopQuestion(user.id, question_id, assistant);
    if (result.stopped) return Response.json({ stop: { question_id: result.question_id, assistant: result.assistant, stopped_at: result.stopped_at } });
    if (result.reason === "already_answered") return Response.json({ error: `${NAMES[assistant]} already answered this, so there is nothing to stop.` }, { status: 409 });
    if (result.reason === "not_addressed") return Response.json({ error: `This message was not addressed to ${NAMES[assistant]}.` }, { status: 400 });
    return Response.json({ error: "That message no longer exists." }, { status: 404 });
  } catch (e) {
    return authErrorResponse(e) ?? Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
