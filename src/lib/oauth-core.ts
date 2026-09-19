// The pure parts of the board's OAuth server: URL and metadata shapes,
// PKCE, redirect URI rules, and how a consent request is read. Nothing here
// touches the database, so the same code runs in tests.

import type { Assistant } from "./agent-auth";

export const SCOPE = "board";
export const MCP_PATH = "/api/mcp";
export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/api/oauth/token";
export const REGISTER_PATH = "/api/oauth/register";
export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource" + MCP_PATH;

/** Strip a trailing slash so origins and resources compare exactly. */
export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: origin + MCP_PATH,
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Duo Board",
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: origin + AUTHORIZE_PATH,
    token_endpoint: origin + TOKEN_PATH,
    registration_endpoint: origin + REGISTER_PATH,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
  };
}

/** The header that tells an MCP client where to find the sign-in service. */
export function wwwAuthenticate(origin: string, tokenPresented: boolean): string {
  const parts = [`realm="duo-board"`, `resource_metadata="${origin + RESOURCE_METADATA_PATH}"`];
  if (tokenPresented) parts.push(`error="invalid_token"`, `error_description="The token is missing, expired or revoked"`);
  return `Bearer ${parts.join(", ")}`;
}

export const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/** A redirect URI a client may register: https anywhere, or http on the local machine. */
export function redirectUriAllowed(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  return false;
}

/** Redirect URIs are compared exactly, as the spec asks. */
export function redirectUriRegistered(registered: readonly string[], uri: string): boolean {
  return registered.includes(uri);
}

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Base64url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return base64url(new Uint8Array(digest));
}

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

/** PKCE S256: the verifier the client kept must hash to the challenge it sent first. */
export async function pkceMatches(challenge: string, verifier: string): Promise<boolean> {
  if (!VERIFIER.test(verifier)) return false;
  return (await sha256Base64url(verifier)) === challenge;
}

/** Which assistant a connecting client most likely is, from the name it registered with. */
export function assistantFor(clientName: string | null | undefined): Assistant {
  return /chatgpt|openai/i.test(clientName ?? "") ? "chatgpt" : "claude";
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string | null;
  resource: string | null;
}

export type AuthorizeParse =
  | { ok: true; request: AuthorizeRequest }
  /** The client or its redirect URI could not be trusted: show the error, never redirect. */
  | { ok: false; fatal: true; message: string }
  /** The client is known: send the error back to it. */
  | { ok: false; fatal: false; error: string; message: string; redirectUri: string; state: string | null };

type Params = Record<string, string | string[] | undefined>;
const one = (p: Params, key: string): string | null => {
  const v = p[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.length > 0 ? s : null;
};

/** Read an authorization request against the client it names, following RFC 6749 section 4.1.2.1. */
export function parseAuthorizeRequest(params: Params, client: { id: string; redirectUris: readonly string[] } | null, origin: string): AuthorizeParse {
  const clientId = one(params, "client_id");
  if (!clientId) return { ok: false, fatal: true, message: "The request names no client_id." };
  if (!client || client.id !== clientId) return { ok: false, fatal: true, message: "This client is not registered with the board. Remove the connector and add it again." };
  const redirectUri = one(params, "redirect_uri") ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : null);
  if (!redirectUri || !redirectUriRegistered(client.redirectUris, redirectUri)) {
    return { ok: false, fatal: true, message: "The redirect address is not one this client registered." };
  }
  const state = one(params, "state");
  const back = (error: string, message: string): AuthorizeParse => ({ ok: false, fatal: false, error, message, redirectUri, state });
  if (one(params, "response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
  const codeChallenge = one(params, "code_challenge");
  if (!codeChallenge) return back("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256.");
  const method = one(params, "code_challenge_method") ?? "plain";
  if (method !== "S256") return back("invalid_request", "Only code_challenge_method=S256 is supported.");
  const scope = one(params, "scope");
  if (scope && scope.split(/\s+/).some((s) => s !== SCOPE)) return back("invalid_scope", `The only scope is "${SCOPE}".`);
  const resource = one(params, "resource");
  if (resource && trimSlash(resource) !== origin + MCP_PATH) return back("invalid_target", `This server only issues tokens for ${origin + MCP_PATH}.`);
  return { ok: true, request: { clientId, redirectUri, state, codeChallenge, scope: scope ? SCOPE : null, resource: resource ? trimSlash(resource) : null } };
}

/** Where to send the browser after consent: the client's redirect URI with code or error, and state echoed. */
export function redirectBack(redirectUri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  return url.toString();
}

/** A same-site path the login page may send the browser back to. */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  return next;
}
