import { safeEqual } from "./session";

export type Assistant = "claude" | "chatgpt";

// Each assistant has its own token (BOARD_TOKEN_CLAUDE, BOARD_TOKEN_CHATGPT),
// so the server knows who is speaking and either token can be revoked alone.
// Tokens arrive as "Authorization: Bearer <token>" or, for clients that cannot
// set headers, as "?key=<token>". These tokens can do nothing but read and
// write this board.
export function identify(req: Request): Assistant | null {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const key = bearer || new URL(req.url).searchParams.get("key") || "";
  if (!key) return null;
  const pairs: [Assistant, string | undefined][] = [
    ["claude", process.env.BOARD_TOKEN_CLAUDE],
    ["chatgpt", process.env.BOARD_TOKEN_CHATGPT],
  ];
  for (const [who, token] of pairs) {
    if (token && token.length >= 16 && safeEqual(key, token)) return who;
  }
  return null;
}

export function unauthorized(): Response {
  return Response.json(
    { error: "Unauthorized. Pass this assistant's board token as 'Authorization: Bearer <token>' or '?key=<token>'." },
    { status: 401 }
  );
}
