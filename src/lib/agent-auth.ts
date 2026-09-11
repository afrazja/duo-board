import { safeEqual } from "./session";
import { db } from "./db";
import { tokenHash } from "./tokens";

export type Assistant = "claude" | "chatgpt";
export type AgentIdentity = { assistant: Assistant; ownerId: string | null };

// Each assistant has its own token (BOARD_TOKEN_CLAUDE, BOARD_TOKEN_CHATGPT),
// so the server knows who is speaking and either token can be revoked alone.
// Tokens arrive as "Authorization: Bearer <token>" or, for clients that cannot
// set headers, as "?key=<token>". These tokens can do nothing but read and
// write this board.
export async function identify(req: Request): Promise<AgentIdentity | null> {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const key = bearer || new URL(req.url).searchParams.get("key") || "";
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

export function unauthorized(): Response {
  return Response.json(
    { error: "Unauthorized. Pass this assistant's board token as 'Authorization: Bearer <token>' or '?key=<token>'." },
    { status: 401 }
  );
}
