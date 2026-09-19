import test from "node:test";
import assert from "node:assert/strict";
import {
  assistantFor, authorizationServerMetadata, parseAuthorizeRequest, pkceMatches, protectedResourceMetadata,
  redirectBack, redirectUriAllowed, safeNextPath, sha256Base64url, wwwAuthenticate,
} from "../src/lib/oauth-core.ts";

const origin = "https://board.example";
const client = { id: "duo_client_1", redirectUris: ["https://claude.ai/api/mcp/auth_callback"] };

test("metadata points the client at this deployment's endpoints", () => {
  const prm = protectedResourceMetadata(origin);
  assert.equal(prm.resource, "https://board.example/api/mcp");
  assert.deepEqual(prm.authorization_servers, [origin]);
  const as = authorizationServerMetadata(origin);
  assert.equal(as.issuer, origin);
  assert.equal(as.authorization_endpoint, "https://board.example/oauth/authorize");
  assert.equal(as.token_endpoint, "https://board.example/api/oauth/token");
  assert.equal(as.registration_endpoint, "https://board.example/api/oauth/register");
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.match(wwwAuthenticate(origin, false), /^Bearer realm="duo-board", resource_metadata="https:\/\/board\.example\/\.well-known\/oauth-protected-resource\/api\/mcp"$/);
  assert.match(wwwAuthenticate(origin, true), /error="invalid_token"/);
});

test("PKCE S256 accepts the verifier that hashes to the challenge and nothing else", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = await sha256Base64url(verifier);
  assert.equal(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.equal(await pkceMatches(challenge, verifier), true);
  assert.equal(await pkceMatches(challenge, verifier + "x"), false);
  assert.equal(await pkceMatches(challenge, "short"), false);
});

test("redirect URIs: https anywhere, http only on the local machine, no fragments", () => {
  assert.equal(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(redirectUriAllowed("http://localhost:6274/oauth/callback"), true);
  assert.equal(redirectUriAllowed("http://127.0.0.1/cb"), true);
  assert.equal(redirectUriAllowed("http://evil.example/cb"), false);
  assert.equal(redirectUriAllowed("https://claude.ai/cb#frag"), false);
  assert.equal(redirectUriAllowed("not a url"), false);
});

test("an authorization request is checked against the client before anything is redirected", async () => {
  const good = {
    response_type: "code", client_id: client.id, redirect_uri: client.redirectUris[0], state: "abc",
    code_challenge: await sha256Base64url("a".repeat(43)), code_challenge_method: "S256", scope: "board", resource: "https://board.example/api/mcp/",
  };
  const ok = parseAuthorizeRequest(good, client, origin);
  assert.equal(ok.ok, true);
  assert.equal(ok.request.resource, "https://board.example/api/mcp");
  assert.equal(ok.request.scope, "board");
  // Unknown client or foreign redirect: fatal, never a redirect.
  assert.equal(parseAuthorizeRequest(good, null, origin).fatal, true);
  assert.equal(parseAuthorizeRequest({ ...good, redirect_uri: "https://evil.example/cb" }, client, origin).fatal, true);
  // Known client, bad request: the error goes back to the client with state.
  const noPkce = parseAuthorizeRequest({ ...good, code_challenge: undefined }, client, origin);
  assert.equal(noPkce.ok, false);
  assert.equal(noPkce.fatal, false);
  assert.equal(noPkce.error, "invalid_request");
  assert.equal(noPkce.state, "abc");
  assert.equal(parseAuthorizeRequest({ ...good, code_challenge_method: "plain" }, client, origin).error, "invalid_request");
  assert.equal(parseAuthorizeRequest({ ...good, response_type: "token" }, client, origin).error, "unsupported_response_type");
  assert.equal(parseAuthorizeRequest({ ...good, resource: "https://other.example/api/mcp" }, client, origin).error, "invalid_target");
  // The one registered redirect URI is implied when the request omits it.
  assert.equal(parseAuthorizeRequest({ ...good, redirect_uri: undefined }, client, origin).ok, true);
  // No scope at all is fine; a foreign scope is not.
  assert.equal(parseAuthorizeRequest({ ...good, scope: undefined }, client, origin).ok, true);
  assert.equal(parseAuthorizeRequest({ ...good, scope: "admin" }, client, origin).error, "invalid_scope");
});

test("redirectBack keeps the client's query and adds code and state", () => {
  const url = redirectBack("https://claude.ai/cb?app=1", { code: "c", state: "s", error: null });
  assert.equal(url, "https://claude.ai/cb?app=1&code=c&state=s");
});

test("the assistant a client speaks as defaults from its name", () => {
  assert.equal(assistantFor("Claude"), "claude");
  assert.equal(assistantFor("ChatGPT"), "chatgpt");
  assert.equal(assistantFor("OpenAI connector"), "chatgpt");
  assert.equal(assistantFor(null), "claude");
});

test("the login page only follows same-site next paths", () => {
  assert.equal(safeNextPath("/oauth/authorize?client_id=x"), "/oauth/authorize?client_id=x");
  assert.equal(safeNextPath("//evil.example"), null);
  assert.equal(safeNextPath("https://evil.example"), null);
  assert.equal(safeNextPath(null), null);
});
