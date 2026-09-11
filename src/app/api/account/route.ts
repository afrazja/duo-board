import { z } from "zod";
import { accountSummary, ensureUserWorkspace, renameAccount, rotateAgentToken } from "@/lib/accounts";
import { authErrorResponse, requireUser } from "@/lib/account-auth";

export async function GET() {
  try {
    const user = await requireUser();
    await ensureUserWorkspace(user, false);
    return Response.json({ account: await accountSummary(user) });
  } catch (error) {
    return authErrorResponse(error) ?? Response.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await requireUser();
    const parsed = z.object({ display_name: z.string().trim().min(1).max(80) }).safeParse(await req.json());
    if (!parsed.success) return Response.json({ error: "Enter a name" }, { status: 400 });
    await renameAccount(user.id, parsed.data.display_name);
    return Response.json({ account: await accountSummary(user) });
  } catch (error) {
    return authErrorResponse(error) ?? Response.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const parsed = z.object({ assistant: z.enum(["chatgpt", "claude"]) }).safeParse(await req.json());
    if (!parsed.success) return Response.json({ error: "Choose Codex or Claude Code" }, { status: 400 });
    const token = await rotateAgentToken(user.id, parsed.data.assistant);
    const origin = new URL(req.url).origin;
    const command = parsed.data.assistant === "chatgpt"
      ? `codex mcp add duo-board --url "${origin}/api/mcp?key=${token}"`
      : `claude mcp add --transport http duo-board "${origin}/api/mcp" --header "Authorization: Bearer ${token}"`;
    return Response.json({ assistant: parsed.data.assistant, token, command, account: await accountSummary(user) });
  } catch (error) {
    return authErrorResponse(error) ?? Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
