import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";
import { safeEqual } from "./session";

export type Assistant = "claude" | "chatgpt";
/** The account a request acts for. null is the board that predates accounts (password mode, or rows not yet claimed). */
export type Owner = string | null;
export interface Identity {
  owner: Owner;
  who: Assistant;
}

// Each assistant of each account has its own token, so the server knows both
// whose board and which assistant is speaking, and any token can be revoked
// alone. Tokens arrive as "Authorization: Bearer <token>" or, for clients that
// cannot set headers, as "?key=<token>". Only a hash is stored. The two
// environment tokens (BOARD_TOKEN_CLAUDE, BOARD_TOKEN_CHATGPT) still work for
// the board that predates accounts; claim_legacy_board turns them into normal
// account tokens at cutover.

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenHint(token: string): string {
  return token.slice(-4);
}

function envIdentity(key: string): Identity | null {
  const pairs: [Assistant, string | undefined][] = [
    ["claude", process.env.BOARD_TOKEN_CLAUDE],
    ["chatgpt", process.env.BOARD_TOKEN_CHATGPT],
  ];
  for (const [who, token] of pairs) {
    if (token && token.length >= 16 && safeEqual(key, token)) return { owner: null, who };
  }
  return null;
}

// A token is looked up once a minute per instance, not on every read.
const cache = new Map<string, { at: number; identity: Identity | null }>();
const CACHE_MS = 60_000;

export async function identify(req: Request): Promise<Identity | null> {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const key = bearer || new URL(req.url).searchParams.get("key") || "";
  if (!key || key.length < 16) return null;
  const hash = hashToken(key);
  const hit = cache.get(hash);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.identity;

  let identity: Identity | null = null;
  const { data, error } = await db().from("assistant_tokens").select("id, owner_id, assistant").eq("token_hash", hash).is("revoked_at", null).maybeSingle();
  if (!error && data) {
    identity = { owner: data.owner_id as string, who: data.assistant as Assistant };
    void db().from("assistant_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(() => undefined, () => undefined);
  } else {
    // No row (or no table yet): the environment tokens still open the legacy board.
    identity = envIdentity(key);
  }
  cache.set(hash, { at: Date.now(), identity });
  return identity;
}

export interface TokenInfo {
  assistant: Assistant;
  hint: string;
  created_at: string;
  last_used_at: string | null;
}

export async function listTokens(owner: string): Promise<TokenInfo[]> {
  const { data, error } = await db()
    .from("assistant_tokens")
    .select("assistant, token_hint, created_at, last_used_at")
    .eq("owner_id", owner)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((t) => ({ assistant: t.assistant as Assistant, hint: t.token_hint as string, created_at: t.created_at as string, last_used_at: (t.last_used_at as string | null) ?? null }));
}

/** Make a new token for one assistant of an account. Any earlier token for that assistant is revoked. The plaintext is returned once. */
export async function createToken(owner: string, who: Assistant): Promise<{ token: string; info: TokenInfo }> {
  const token = `duo_${who}_${randomBytes(24).toString("hex")}`;
  await revokeTokens(owner, who);
  const { data, error } = await db()
    .from("assistant_tokens")
    .insert({ owner_id: owner, assistant: who, token_hash: hashToken(token), token_hint: tokenHint(token) })
    .select("assistant, token_hint, created_at, last_used_at")
    .single();
  if (error) throw new Error(error.message);
  return { token, info: { assistant: who, hint: data.token_hint, created_at: data.created_at, last_used_at: null } };
}

export async function revokeTokens(owner: string, who: Assistant): Promise<void> {
  const { error } = await db().from("assistant_tokens").update({ revoked_at: new Date().toISOString() }).eq("owner_id", owner).eq("assistant", who).is("revoked_at", null);
  if (error) throw new Error(error.message);
  cache.clear();
}

export function unauthorized(): Response {
  return Response.json(
    { error: "Unauthorized. Pass this assistant's board token as 'Authorization: Bearer <token>' or '?key=<token>'." },
    { status: 401 }
  );
}
