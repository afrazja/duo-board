import { currentUser } from "@/lib/account-auth";
import { getClient, issueCode, OAuthError } from "@/lib/oauth";
import { parseAuthorizeRequest, redirectBack } from "@/lib/oauth-core";
import { readParams } from "@/lib/oauth-http";
import { publicOrigin } from "@/lib/origin";

// The consent form on /oauth/authorize posts here. Behind sign-in (the proxy
// sends strangers to /login), so the account is the person in the browser.
// Yes mints a code and sends the browser back to the client with it; no
// sends access_denied. Either way the client's state comes back with it.
export async function POST(req: Request) {
  const origin = publicOrigin(req);
  const from = req.headers.get("origin");
  if (from && from !== origin) return Response.json({ error: "Cross-site consent is refused" }, { status: 403 });
  const user = await currentUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const params = await readParams(req);
  let client;
  try {
    client = params.client_id ? await getClient(params.client_id) : null;
  } catch (e) {
    return Response.json({ error: (e as OAuthError).message }, { status: 500 });
  }
  const parsed = parseAuthorizeRequest(params, client, origin);
  if (!parsed.ok) {
    if (parsed.fatal) return Response.json({ error: parsed.message }, { status: 400 });
    return Response.redirect(redirectBack(parsed.redirectUri, { error: parsed.error, error_description: parsed.message, state: parsed.state }), 303);
  }
  const { request } = parsed;
  if (params.decision !== "allow") {
    return Response.redirect(redirectBack(request.redirectUri, { error: "access_denied", error_description: "The person declined", state: request.state }), 303);
  }
  const assistant = params.assistant === "chatgpt" ? "chatgpt" : params.assistant === "claude" ? "claude" : null;
  if (!assistant) return Response.json({ error: "Choose which assistant this connection speaks as" }, { status: 400 });
  try {
    const code = await issueCode({ client: client!, owner: user.id, assistant, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge, scope: request.scope, resource: request.resource });
    return Response.redirect(redirectBack(request.redirectUri, { code, state: request.state }), 303);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
