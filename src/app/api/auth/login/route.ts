import { cookies } from "next/headers";
import { z } from "zod";
import { clearAuthSession, consumeLegacyClaim, hasLegacyClaim, setAuthSession, signIn } from "@/lib/account-auth";
import { ensureUserWorkspace } from "@/lib/accounts";
import { SESSION_COOKIE, sessionIsValid } from "@/lib/session";

export async function POST(req: Request) {
  try {
    const parsed = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(128) }).safeParse(await req.json());
    if (!parsed.success) return Response.json({ error: "Enter your email and password" }, { status: 400 });
    const result = await signIn(parsed.data.email, parsed.data.password);
    if (result.error || !result.data.session || !result.data.user) return Response.json({ error: "Email or password is incorrect" }, { status: 401 });
    const oldSession = await sessionIsValid((await cookies()).get(SESSION_COOKIE)?.value);
    const claim = oldSession || await hasLegacyClaim();
    await setAuthSession(result.data.session);
    await ensureUserWorkspace(result.data.user, claim);
    if (claim) await consumeLegacyClaim();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: (error as Error).message || "Could not sign in" }, { status: 500 });
  }
}

export async function DELETE() {
  await clearAuthSession();
  return Response.json({ ok: true });
}
