import { authorizationServerMetadata } from "@/lib/oauth-core";
import { metadata, preflight } from "@/lib/oauth-http";
import { publicOrigin } from "@/lib/origin";

// RFC 8414: where to register, sign in and get tokens.
export async function GET(req: Request) {
  return metadata(authorizationServerMetadata(publicOrigin(req)));
}
export const OPTIONS = preflight;
