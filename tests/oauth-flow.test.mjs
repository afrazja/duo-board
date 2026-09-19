// A connector's whole sign-in against an in-memory database: registration,
// consent code, PKCE exchange, use of the token on the MCP door, refresh,
// and revocation. Needs --experimental-test-module-mocks to swap the
// Supabase client for tests/fake-db.mjs.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./fake-db.mjs";

const { db: fake, store } = makeDb();
mock.module(new URL("../src/lib/db.ts", import.meta.url).href, { namedExports: { db: () => fake } });
const oauth = await import("../src/lib/oauth.ts");
const auth = await import("../src/lib/agent-auth.ts");
const { sha256Base64url } = await import("../src/lib/oauth-core.ts");

const mcpRequest = (token) => new Request("https://board.example/api/mcp", { headers: token ? { authorization: `Bearer ${token}` } : {} });
const verifier = "q".repeat(50);

test("a confidential client signs in, uses, refreshes and loses its access", async () => {
  const reg = await oauth.registerClient({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "client_secret_post", grant_types: ["authorization_code", "refresh_token"] });
  assert.match(reg.client_id, /^duo_client_/);
  assert.equal(typeof reg.client_secret, "string");
  assert.equal(reg.client_secret_expires_at, 0);

  const client = await oauth.getClient(reg.client_id);
  await assert.rejects(oauth.authenticateClient({ id: reg.client_id, secret: null, via: "none" }), /Client authentication failed/);
  await assert.rejects(oauth.authenticateClient({ id: reg.client_id, secret: "wrong", via: "body" }), /Client authentication failed/);
  await assert.rejects(oauth.authenticateClient({ id: "duo_client_nope", secret: null, via: "none" }), /Unknown client/);
  assert.equal((await oauth.authenticateClient({ id: reg.client_id, secret: reg.client_secret, via: "body" })).id, client.id);

  const code = await oauth.issueCode({ client, owner: "owner-1", assistant: "claude", redirectUri: client.redirectUris[0], codeChallenge: await sha256Base64url(verifier), scope: "board", resource: null });
  // Wrong verifier fails and spends the code; the right one afterwards is too late.
  await assert.rejects(oauth.exchangeCode(client, code, "r".repeat(50), client.redirectUris[0]), /PKCE/);
  await assert.rejects(oauth.exchangeCode(client, code, verifier, client.redirectUris[0]), /already used/);

  const code2 = await oauth.issueCode({ client, owner: "owner-1", assistant: "claude", redirectUri: client.redirectUris[0], codeChallenge: await sha256Base64url(verifier), scope: "board", resource: null });
  await assert.rejects(oauth.exchangeCode(client, code2, verifier, "https://other.example/cb"), /redirect_uri/);
  const code3 = await oauth.issueCode({ client, owner: "owner-1", assistant: "claude", redirectUri: client.redirectUris[0], codeChallenge: await sha256Base64url(verifier), scope: "board", resource: null });
  const tokens = await oauth.exchangeCode(client, code3, verifier, client.redirectUris[0]);
  assert.equal(tokens.token_type, "Bearer");
  assert.match(tokens.access_token, /^duo_oat_/);
  assert.match(tokens.refresh_token, /^duo_ort_/);
  assert.equal(store.get("oauth_codes").length, 0);

  // The MCP door recognises the access token as this account's Claude.
  assert.deepEqual(await auth.identify(mcpRequest(tokens.access_token)), { assistant: "claude", ownerId: "owner-1" });
  assert.equal(await auth.identify(mcpRequest("duo_oat_" + "0".repeat(48))), null);

  // Refresh: new access token, same refresh token, old access token gone.
  const refreshed = await oauth.refreshGrant(client, tokens.refresh_token);
  assert.notEqual(refreshed.access_token, tokens.access_token);
  assert.equal(refreshed.refresh_token, tokens.refresh_token);
  assert.deepEqual(await auth.identify(mcpRequest(refreshed.access_token)), { assistant: "claude", ownerId: "owner-1" });
  assert.equal(await auth.identify(mcpRequest(tokens.access_token)), null);
  await assert.rejects(oauth.refreshGrant(client, "duo_ort_" + "0".repeat(48)), /Unknown or revoked/);

  // The page can see and end the connection.
  const grants = await oauth.listGrants("owner-1");
  assert.equal(grants.length, 1);
  assert.equal(grants[0].client_name, "Claude");
  assert.equal(await oauth.revokeGrant("owner-2", grants[0].id), false);
  assert.equal(await oauth.revokeGrant("owner-1", grants[0].id), true);
  assert.equal(await auth.identify(mcpRequest(refreshed.access_token)), null);
  await assert.rejects(oauth.refreshGrant(client, tokens.refresh_token), /Unknown or revoked/);
  assert.equal((await oauth.listGrants("owner-1")).length, 0);
});

test("a public client: no secret needed, another client cannot use its code", async () => {
  const reg = await oauth.registerClient({ client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], token_endpoint_auth_method: "none" });
  assert.equal(reg.client_secret, undefined);
  const client = await oauth.authenticateClient({ id: reg.client_id, secret: null, via: "none" });
  const other = await oauth.getClient((await oauth.registerClient({ redirect_uris: ["https://localhost.example/cb"], token_endpoint_auth_method: "none" })).client_id);
  const code = await oauth.issueCode({ client, owner: null, assistant: "chatgpt", redirectUri: client.redirectUris[0], codeChallenge: await sha256Base64url(verifier), scope: null, resource: null });
  await assert.rejects(oauth.exchangeCode(other, code, verifier, null), /already used/);
  const code2 = await oauth.issueCode({ client, owner: null, assistant: "chatgpt", redirectUri: client.redirectUris[0], codeChallenge: await sha256Base64url(verifier), scope: null, resource: null });
  const tokens = await oauth.exchangeCode(client, code2, verifier, null);
  assert.deepEqual(await auth.identify(mcpRequest(tokens.access_token)), { assistant: "chatgpt", ownerId: null });
  assert.equal((await oauth.listGrants(null)).length, 1);
});

test("registration refuses what the server cannot serve", async () => {
  await assert.rejects(oauth.registerClient({ redirect_uris: [] }), /at least one/);
  await assert.rejects(oauth.registerClient({ redirect_uris: ["http://evil.example/cb"] }), /invalid_redirect_uri|https/);
  await assert.rejects(oauth.registerClient({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "private_key_jwt" }), /token_endpoint_auth_method/);
  await assert.rejects(oauth.registerClient({ redirect_uris: ["https://a.example/cb"], grant_types: ["implicit"] }), /grant type/);
  await assert.rejects(oauth.registerClient({ redirect_uris: ["https://a.example/cb"], response_types: ["token"] }), /response_type/);
});

test("a board without the tables says which file to run", async () => {
  store.missing = true;
  await assert.rejects(oauth.getClient("x"), /supabase\/oauth\.sql/);
  store.missing = false;
});
