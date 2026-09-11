import { cookies } from "next/headers";
import { z } from "zod";
import { consumeLegacyClaim, hasLegacyClaim, setAuthSession, setLegacyClaim, signUp } from "@/lib/account-auth";
import { ensureUserWorkspace } from "@/lib/accounts";
import { expectedSessionToken, passwordMatches, SESSION_COOKIE, sessionIsValid } from "@/lib/session";

export async function POST(req: Request) {
  try {
    const parsed = z.object({
      name: z.string().trim().min(1).max(80),
      email: z.string().trim().email().max(320),
      password: z.string().min(8).max(128),
      board_password: z.string().max(256).optional(),
    }).safeParse(await req.json());
    if (!parsed.success) return Response.json({ error: "Enter your name, a valid email and a password of at least 8 characters" }, { status: 400 });

    const store = await cookies();
    const oldSession = await sessionIsValid(store.get(SESSION_COOKIE)?.value);
    const suppliedPassword = parsed.data.board_password ? await passwordMatches(parsed.data.board_password) : false;
    const canClaim = oldSession || suppliedPassword || await hasLegacyClaim();
    if (canClaim) {
      const proof = await expectedSessionToken();
      if (proof) await setLegacyClaim(proof);
    }

    const origin = new URL(req.url).origin;
    const result = await signUp(parsed.data.email, parsed.data.password, parsed.data.name, `${origin}/login?confirmed=1`);
    if (result.error) return Response.json({ error: result.error.message }, { status: 400 });
    if (result.data.session && result.data.user) {
      await setAuthSession(result.data.session);
      await ensureUserWorkspace(result.data.user, canClaim);
      if (canClaim) await consumeLegacyClaim();
    }
    return Response.json({ ok: true, verification_required: !result.data.session });
  } catch (error) {
    return Response.json({ error: (error as Error).message || "Could not create the account" }, { status: 500 });
  }
}
