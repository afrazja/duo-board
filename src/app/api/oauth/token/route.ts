import { authenticateClient, exchangeCode, OAuthError, refreshGrant, type ClientCredentials } from "@/lib/oauth";
import { oauthFailure, preflight, readParams, tokenJson } from "@/lib/oauth-http";

// RFC 6749 token endpoint: a code plus its PKCE verifier becomes an access
// token and a refresh token; a refresh token becomes a new access token.
// The client identifies itself with HTTP Basic or in the body, or by
// client_id alone if it registered as a public client.
function credentials(req: Request, params: Record<string, string>): ClientCredentials {
  const auth = req.headers.get("authorization");
  if (auth && /^Basic\s+/i.test(auth)) {
    const decoded = Buffer.from(auth.replace(/^Basic\s+/i, ""), "base64").toString("utf8");
    const at = decoded.indexOf(":");
    if (at > 0) return { id: decodeURIComponent(decoded.slice(0, at)), secret: decodeURIComponent(decoded.slice(at + 1)), via: "basic" };
  }
  if (params.client_secret) return { id: params.client_id ?? null, secret: params.client_secret, via: "body" };
  return { id: params.client_id ?? null, secret: null, via: "none" };
}

export async function POST(req: Request) {
  try {
    const params = await readParams(req);
    const client = await authenticateClient(credentials(req, params));
    switch (params.grant_type) {
      case "authorization_code": {
        if (!params.code) throw new OAuthError("invalid_request", "code is required");
        if (!params.code_verifier) throw new OAuthError("invalid_request", "code_verifier is required (PKCE)");
        return tokenJson(await exchangeCode(client, params.code, params.code_verifier, params.redirect_uri ?? null));
      }
      case "refresh_token": {
        if (!params.refresh_token) throw new OAuthError("invalid_request", "refresh_token is required");
        return tokenJson(await refreshGrant(client, params.refresh_token));
      }
      case undefined:
        throw new OAuthError("invalid_request", "grant_type is required");
      default:
        throw new OAuthError("unsupported_grant_type", `Unsupported grant_type: ${params.grant_type}`);
    }
  } catch (e) {
    return oauthFailure(e);
  }
}
export const OPTIONS = preflight;
