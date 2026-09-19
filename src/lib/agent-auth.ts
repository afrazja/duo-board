import { safeEqual } from "./session";
import { db } from "./db";
import { tokenHash } from "./tokens";
import { wwwAuthenticate } from "./oauth-core";
import { publicOrigin } from "./origin";

export type Assistant = "claude" | "chatgpt";
export type AgentIdentity = { assistant: Assistant; ownerId: string | null };

// Each assistant has its own token (BOARD_TOKEN_CLAUDE, BOARD_TOKEN_CHATGPT),
// so the server knows who is speaking and either token can be revoked alone.
// Tokens arrive as "Authorization: Bearer <token>" or, for clients that cannot
// set headers, as "?key=<token>". These tokens can do nothing but read and
// write this board. Connectors that sign in through OAuth (see oauth.ts)
// hold access tokens that are looked up the same way.
function presentedToken(req: Request): string {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return bearer || new URL(req.url).searchParams.get("key") || "";
}

export async function identify(req: Request): Promise<AgentIdentity | null> {
  const key = presentedToken(req);
  if (!key) return null;
  const pairs: [Assistant, string | undefined][] = [
    ["claude", process.env.BOARD_TOKEN_CLAUDE],
    ["chatgpt", process.env.BOARD_TOKEN_CHATGPT],
  ];
  const hash = await tokenHash(key);
  const stored = await db().from("agent_tokens").select("owner_id,assistant").eq("token_hash", hash).maybeSingle();
  if (!stored.error && stored.data) {
    return { assistant: stored.data.assistant as Assistant, ownerId: stored.data.owner_id as string };
  }
  const grant = await oauthIdentity(hash);
  if (grant) return grant;

  // Legacy environment tokens keep the existing board connected until the
  // first owner claims it. Claiming stores their hashes against that account.
  for (const [who, token] of pairs) {
    if (token && token.length >= 16 && safeEqual(key, token)) {
      const mapped = await db().from("agent_tokens").select("owner_id").eq("token_hash", hash).maybeSingle();
      return { assistant: who, ownerId: mapped.data?.owner_id ?? null };
    }
  }
  return null;
}

/** An access token issued to a connector that signed in through OAuth, if it is still good. */
async function oauthIdentity(hash: string): Promise<AgentIdentity | null> {
  const { data, error } = await db().from("oauth_grants").select("id, owner_id, assistant, access_expires_at").eq("access_hash", hash).is("revoked_at", null).maybeSingle();
  if (error || !data) return null;
  if (!(Date.parse(data.access_expires_at as string) > Date.now())) return null;
  void db().from("oauth_grants").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(() => undefined, () => undefined);
  return { assistant: data.assistant as Assistant, ownerId: (data.owner_id as string | null) ?? null };
}

/**
 * 401 with the header that points OAuth-capable clients (the claude.ai and
 * ChatGPT connectors) at the board's sign-in service; token holders read the body.
 */
export function unauthorized(req?: Request): Response {
  const headers: Record<string, string> = {};
  if (req) headers["WWW-Authenticate"] = wwwAuthenticate(publicOrigin(req), presentedToken(req).length > 0);
  return Response.json(
    { error: "Unauthorized. Pass this assistant's board token as 'Authorization: Bearer <token>' or '?key=<token>', or connect through OAuth." },
    { status: 401, headers }
  );
}
