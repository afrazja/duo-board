import { z } from "zod";
import { currentAccount } from "@/lib/account";
import { createToken, listTokens, revokeTokens } from "@/lib/agent-auth";

// The signed-in person's assistant tokens. GET lists them without secrets;
// POST makes a new one for an assistant (revoking the previous) and returns
// the plaintext once; DELETE revokes.
const ASSISTANT = z.object({ assistant: z.enum(["claude", "chatgpt"]) });

async function owner() {
  const account = await currentAccount();
  if (!account) return { error: Response.json({ error: "Not signed in" }, { status: 401 }) };
  if (account.mode !== "accounts" || !account.owner) return { error: Response.json({ error: "Tokens per account need Supabase Auth; this deployment uses the shared password and the two environment tokens" }, { status: 409 }) };
  return { owner: account.owner };
}

export async function GET() {
  const who = await owner();
  if ("error" in who) return who.error;
  try {
    return Response.json({ tokens: await listTokens(who.owner) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const who = await owner();
  if ("error" in who) return who.error;
  const parsed = ASSISTANT.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "assistant must be claude or chatgpt" }, { status: 400 });
  try {
    const { token, info } = await createToken(who.owner, parsed.data.assistant);
    return Response.json({ token, ...info });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const who = await owner();
  if ("error" in who) return who.error;
  const parsed = ASSISTANT.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "assistant must be claude or chatgpt" }, { status: 400 });
  try {
    await revokeTokens(who.owner, parsed.data.assistant);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
