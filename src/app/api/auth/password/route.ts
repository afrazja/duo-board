import { z } from "zod";
import { updatePassword } from "@/lib/account-auth";

export async function POST(req: Request) {
  const parsed = z.object({ password: z.string().min(6).max(128) }).safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "Use at least 6 characters" }, { status: 400 });
  const result = await updatePassword(parsed.data.password);
  if (result.error) {
    const status = result.error.message === "Not signed in" ? 401 : 400;
    return Response.json({ error: result.error.message }, { status });
  }
  return Response.json({ ok: true });
}
