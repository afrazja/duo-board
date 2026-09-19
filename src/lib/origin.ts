import { trimSlash } from "./oauth-core";

// The address the outside world uses for this deployment, for the OAuth
// metadata and redirects. BOARD_URL pins it; otherwise the proxy headers or
// the request URL say.
export function originFromHeaders(get: (name: string) => string | null, fallback: string): string {
  const pinned = process.env.BOARD_URL?.trim();
  if (pinned) return trimSlash(pinned);
  const host = get("x-forwarded-host")?.split(",")[0].trim() || get("host");
  if (host) {
    const proto = get("x-forwarded-proto")?.split(",")[0].trim() || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
    return `${proto}://${host}`;
  }
  return new URL(fallback).origin;
}

export function publicOrigin(req: Request): string {
  return originFromHeaders((n) => req.headers.get(n), req.url);
}
