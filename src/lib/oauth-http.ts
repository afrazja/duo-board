import { OAuthError } from "./oauth";

// Small helpers shared by the OAuth routes: open CORS (MCP clients that run in
// a browser read the metadata cross-origin), no caching of secrets, and the
// RFC 6749 error shape.

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export function metadata(body: unknown): Response {
  return Response.json(body, { headers: { ...CORS, "Cache-Control": "public, max-age=3600" } });
}

export function tokenJson(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...CORS, "Cache-Control": "no-store", Pragma: "no-cache", ...extra } });
}

export function oauthFailure(e: unknown): Response {
  if (e instanceof OAuthError) {
    const extra: Record<string, string> = e.status === 401 ? { "WWW-Authenticate": 'Basic realm="duo-board"' } : {};
    return tokenJson({ error: e.code, error_description: e.message }, e.status, extra);
  }
  return tokenJson({ error: "server_error", error_description: (e as Error).message }, 500);
}

/** A form-encoded or JSON body as one flat record of strings. */
export async function readParams(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("content-type") ?? "";
  const out: Record<string, string> = {};
  if (type.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
    return out;
  }
  const text = await req.text().catch(() => "");
  for (const [k, v] of new URLSearchParams(text)) out[k] = v;
  return out;
}
