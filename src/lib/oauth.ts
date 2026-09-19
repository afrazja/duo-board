import { randomBytes } from "node:crypto";
import { db } from "./db";
import type { Assistant } from "./agent-auth";
import { AUTH_METHODS, pkceMatches, redirectUriAllowed, SCOPE, type AuthMethod } from "./oauth-core";
import { safeEqual } from "./session";
import { tokenHash } from "./tokens";

// The board as an OAuth authorization server, so the claude.ai and ChatGPT
// connectors can sign in instead of carrying a token in the URL. A connector
// registers itself (RFC 7591), sends the person to the consent page, and
// trades the code it gets for an access token bound to this account and one
// assistant. Only hashes of codes and tokens are stored. Tables are in
// supabase/oauth.sql.

type Owner = string | null;

export const CODE_TTL_MS = 10 * 60_000;
export const ACCESS_TTL_S = 8 * 3600;
export const REFRESH_TTL_S = 30 * 24 * 3600;

export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface Client {
  id: string;
  name: string | null;
  redirectUris: string[];
  authMethod: AuthMethod;
  secretHash: string | null;
}

const rowToClient = (r: Record<string, unknown>): Client => ({
  id: r.id as string,
  name: (r.name as string | null) ?? null,
  redirectUris: (r.redirect_uris as string[]) ?? [],
  authMethod: r.auth_method as AuthMethod,
  secretHash: (r.secret_hash as string | null) ?? null,
});

function missingTables(message: string): never {
  throw new OAuthError("server_error", /oauth_(clients|codes|grants)|schema cache/i.test(message) ? `The OAuth tables are missing: run supabase/oauth.sql (${message})` : message, 500);
}

export async function getClient(id: string): Promise<Client | null> {
  const { data, error } = await db().from("oauth_clients").select("id, name, redirect_uris, auth_method, secret_hash").eq("id", id).maybeSingle();
  if (error) missingTables(error.message);
  return data ? rowToClient(data) : null;
}

export interface RegistrationInput {
  client_name?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
}

/** Dynamic client registration: any client may register, but only for the flows this server runs. */
export async function registerClient(input: RegistrationInput, issuedAt = Date.now()) {
  const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (uris.length === 0) throw new OAuthError("invalid_redirect_uri", "redirect_uris must list at least one https URL");
  const bad = uris.find((u) => !redirectUriAllowed(u));
  if (bad) throw new OAuthError("invalid_redirect_uri", `Redirect URIs must be https (or http on localhost): ${bad}`);
  const method = input.token_endpoint_auth_method === undefined ? "client_secret_basic" : input.token_endpoint_auth_method;
  if (!AUTH_METHODS.includes(method as AuthMethod)) throw new OAuthError("invalid_client_metadata", `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}`);
  const grants = Array.isArray(input.grant_types) ? input.grant_types : ["authorization_code"];
  const unknownGrant = grants.find((g) => g !== "authorization_code" && g !== "refresh_token");
  if (unknownGrant) throw new OAuthError("invalid_client_metadata", `Unsupported grant type: ${String(unknownGrant)}`);
  const responses = Array.isArray(input.response_types) ? input.response_types : ["code"];
  if (responses.some((r) => r !== "code")) throw new OAuthError("invalid_client_metadata", "Only response_type code is supported");
  const name = typeof input.client_name === "string" ? input.client_name.slice(0, 200) : null;

  const id = `duo_client_${randomBytes(12).toString("hex")}`;
  const secret = method === "none" ? null : randomBytes(32).toString("hex");
  const { error } = await db().from("oauth_clients").insert({
    id,
    name,
    redirect_uris: uris,
    auth_method: method,
    secret_hash: secret ? await tokenHash(secret) : null,
  });
  if (error) missingTables(error.message);
  return {
    client_id: id,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(issuedAt / 1000),
    client_name: name ?? undefined,
    redirect_uris: uris,
    token_endpoint_auth_method: method,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: SCOPE,
  };
}

export interface ConsentInput {
  client: Client;
  owner: Owner;
  assistant: Assistant;
  redirectUri: string;
  codeChallenge: string;
  scope: string | null;
  resource: string | null;
}

/** The person said yes: mint a one-time code for the client to trade in. */
export async function issueCode(input: ConsentInput): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  const { error } = await db().from("oauth_codes").insert({
    code_hash: await tokenHash(code),
    client_id: input.client.id,
    owner_id: input.owner,
    assistant: input.assistant,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    scope: input.scope,
    resource: input.resource,
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  });
  if (error) missingTables(error.message);
  return code;
}

export interface ClientCredentials {
  id: string | null;
  secret: string | null;
  /** Where the secret came from, to check it matches how the client registered. */
  via: "basic" | "body" | "none";
}

/** Look the client up and check its secret the way it said it would present one. */
export async function authenticateClient(creds: ClientCredentials): Promise<Client> {
  if (!creds.id) throw new OAuthError("invalid_client", "client_id is required", 401);
  const client = await getClient(creds.id);
  if (!client) throw new OAuthError("invalid_client", "Unknown client", 401);
  if (client.authMethod === "none") return client;
  if (!creds.secret || !client.secretHash || !safeEqual(await tokenHash(creds.secret), client.secretHash)) {
    throw new OAuthError("invalid_client", "Client authentication failed", 401);
  }
  return client;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function mintTokens(): { access: string; refresh: string } {
  return { access: `duo_oat_${randomBytes(24).toString("hex")}`, refresh: `duo_ort_${randomBytes(24).toString("hex")}` };
}

/** authorization_code grant: verify PKCE, spend the code, and start a grant. */
export async function exchangeCode(client: Client, code: string, verifier: string, redirectUri: string | null): Promise<TokenResponse> {
  const codeHash = await tokenHash(code);
  const { data, error } = await db().from("oauth_codes").select("client_id, owner_id, assistant, redirect_uri, code_challenge, scope, expires_at").eq("code_hash", codeHash).maybeSingle();
  if (error) missingTables(error.message);
  // A code is single use whatever happens next.
  if (data) await db().from("oauth_codes").delete().eq("code_hash", codeHash);
  if (!data || data.client_id !== client.id) throw new OAuthError("invalid_grant", "Unknown or already used code");
  if (Date.parse(data.expires_at as string) < Date.now()) throw new OAuthError("invalid_grant", "The code expired; sign in again");
  if (redirectUri !== null && redirectUri !== data.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request");
  if (!(await pkceMatches(data.code_challenge as string, verifier))) throw new OAuthError("invalid_grant", "PKCE verification failed");

  const { access, refresh } = mintTokens();
  const now = Date.now();
  const { error: insert } = await db().from("oauth_grants").insert({
    client_id: client.id,
    client_name: client.name,
    owner_id: data.owner_id,
    assistant: data.assistant,
    scope: (data.scope as string | null) ?? SCOPE,
    access_hash: await tokenHash(access),
    access_expires_at: new Date(now + ACCESS_TTL_S * 1000).toISOString(),
    refresh_hash: await tokenHash(refresh),
    refresh_expires_at: new Date(now + REFRESH_TTL_S * 1000).toISOString(),
  });
  if (insert) missingTables(insert.message);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE };
}

/** refresh_token grant: a new access token on the same grant; the refresh token stays, so a retried refresh still works. */
export async function refreshGrant(client: Client, refreshToken: string): Promise<TokenResponse> {
  const { data, error } = await db().from("oauth_grants").select("id, client_id, refresh_expires_at, revoked_at").eq("refresh_hash", await tokenHash(refreshToken)).maybeSingle();
  if (error) missingTables(error.message);
  if (!data || data.client_id !== client.id || data.revoked_at) throw new OAuthError("invalid_grant", "Unknown or revoked refresh token");
  if (Date.parse(data.refresh_expires_at as string) < Date.now()) throw new OAuthError("invalid_grant", "The refresh token expired; sign in again");
  const { access } = mintTokens();
  const now = Date.now();
  const { error: update } = await db().from("oauth_grants").update({
    access_hash: await tokenHash(access),
    access_expires_at: new Date(now + ACCESS_TTL_S * 1000).toISOString(),
    refresh_expires_at: new Date(now + REFRESH_TTL_S * 1000).toISOString(),
  }).eq("id", data.id);
  if (update) missingTables(update.message);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refreshToken, scope: SCOPE };
}

export interface GrantInfo {
  id: string;
  assistant: Assistant;
  client_name: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** The connectors signed in to one board, for the page. */
export async function listGrants(owner: Owner): Promise<GrantInfo[]> {
  let q = db().from("oauth_grants").select("id, assistant, client_name, created_at, last_used_at").is("revoked_at", null).gt("refresh_expires_at", new Date().toISOString()).order("created_at", { ascending: false });
  q = owner === null ? q.is("owner_id", null) : q.eq("owner_id", owner);
  const { data, error } = await q;
  if (error) missingTables(error.message);
  return (data ?? []).map((g) => ({ id: g.id as string, assistant: g.assistant as Assistant, client_name: (g.client_name as string | null) ?? null, created_at: g.created_at as string, last_used_at: (g.last_used_at as string | null) ?? null }));
}

/** Sign one connector out; its tokens stop working at once. */
export async function revokeGrant(owner: Owner, id: string): Promise<boolean> {
  let q = db().from("oauth_grants").update({ revoked_at: new Date().toISOString() }).eq("id", id).is("revoked_at", null);
  q = owner === null ? q.is("owner_id", null) : q.eq("owner_id", owner);
  const { data, error } = await q.select("id");
  if (error) missingTables(error.message);
  return (data?.length ?? 0) > 0;
}
