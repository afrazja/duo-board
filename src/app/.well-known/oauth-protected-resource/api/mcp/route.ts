import { protectedResourceMetadata } from "@/lib/oauth-core";
import { metadata, preflight } from "@/lib/oauth-http";
import { publicOrigin } from "@/lib/origin";

// RFC 9728: which sign-in service protects the MCP endpoint. Served at the
// root and at the path form (/.well-known/oauth-protected-resource/api/mcp),
// since clients try either.
export async function GET(req: Request) {
  return metadata(protectedResourceMetadata(publicOrigin(req)));
}
export const OPTIONS = preflight;
