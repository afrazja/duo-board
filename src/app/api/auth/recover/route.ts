import { z } from "zod";
import { sendRecovery } from "@/lib/account-auth";

export async function POST(req: Request) {
  const parsed = z.object({ email: z.string().trim().email() }).safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "Enter a valid email" }, { status: 400 });
  const result = await sendRecovery(parsed.data.email, `${new URL(req.url).origin}/reset-password`);
  if (result.error) return Response.json({ error: "Could not send a recovery email" }, { status: 400 });
  return Response.json({ ok: true });
}
