import { registerClient, type RegistrationInput } from "@/lib/oauth";
import { oauthFailure, preflight, tokenJson } from "@/lib/oauth-http";

// RFC 7591 dynamic client registration. Open: a connector registers itself
// before anyone has signed in. Registration grants nothing by itself; every
// token still needs the person's consent on /oauth/authorize.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as RegistrationInput | null;
  if (!body || typeof body !== "object") return tokenJson({ error: "invalid_client_metadata", error_description: "Send the client metadata as JSON" }, 400);
  try {
    return tokenJson(await registerClient(body), 201);
  } catch (e) {
    return oauthFailure(e);
  }
}
export const OPTIONS = preflight;
