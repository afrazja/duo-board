import { z } from "zod";
import { consumeLegacyClaim, exchangeBrowserSession, hasLegacyClaim, setAuthSession } from "@/lib/account-auth";
import { ensureUserWorkspace } from "@/lib/accounts";

export async function POST(req: Request) {
  const parsed = z.object({ access_token: z.string().min(20), refresh_token: z.string().min(20) }).safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "The sign-in link is incomplete" }, { status: 400 });
  const result = await exchangeBrowserSession(parsed.data.access_token, parsed.data.refresh_token);
  if (result.error || !result.data.session || !result.data.user) return Response.json({ error: "This sign-in link is invalid or expired" }, { status: 401 });
  const claim = await hasLegacyClaim();
  await setAuthSession(result.data.session);
  await ensureUserWorkspace(result.data.user, claim);
  if (claim) await consumeLegacyClaim();
  return Response.json({ ok: true });
}
