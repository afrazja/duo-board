import { z } from "zod";
import { updatePassword } from "@/lib/account-auth";

export async function POST(req: Request) {
  const parsed = z.object({ password: z.string().min(8).max(128) }).safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "Use at least 8 characters" }, { status: 400 });
  const result = await updatePassword(parsed.data.password);
  if (result.error) return Response.json({ error: result.error.message }, { status: 400 });
  return Response.json({ ok: true });
}
