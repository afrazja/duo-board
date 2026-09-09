// The page is guarded by one shared password (BOARD_PASSWORD). A correct
// password sets a cookie holding an HMAC derived from the password, so the
// cookie proves knowledge of the password without storing it, and changing
// the password logs every browser out. Web Crypto only, so the same code
// runs in the proxy and in route handlers.

export const SESSION_COOKIE = "duo_session";
const SESSION_LABEL = "duo-board-session-v1";

const enc = new TextEncoder();

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function expectedSessionToken(): Promise<string | null> {
  const password = process.env.BOARD_PASSWORD;
  if (!password) return null;
  return hmacHex(password, SESSION_LABEL);
}

export async function passwordMatches(candidate: string): Promise<boolean> {
  const password = process.env.BOARD_PASSWORD;
  if (!password) return false;
  // Compare digests rather than the raw strings so length leaks nothing.
  const [a, b] = await Promise.all([hmacHex(SESSION_LABEL, candidate), hmacHex(SESSION_LABEL, password)]);
  return safeEqual(a, b);
}

export async function sessionIsValid(cookieValue: string | undefined): Promise<boolean> {
  if (!cookieValue) return false;
  const expected = await expectedSessionToken();
  return !!expected && safeEqual(cookieValue, expected);
}
