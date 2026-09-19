import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/auth-constants";

// Everything is behind sign-in except: the sign-in pages and their routes,
// the two agent surfaces (MCP and the plain HTTP mirror), which carry their
// own tokens, and the OAuth service's public parts (metadata, registration,
// tokens). The consent page and its form stay behind sign-in: that is the
// point of them.
const OPEN_PREFIXES = ["/login", "/signup", "/forgot-password", "/reset-password", "/api/auth", "/api/mcp", "/api/agent", "/.well-known", "/api/oauth/register", "/api/oauth/token"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (OPEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) return NextResponse.next();

  // Route handlers perform the secure user lookup. Proxy only avoids showing
  // private pages when no account session is present at all.
  if (request.cookies.has(ACCESS_COOKIE) || request.cookies.has(REFRESH_COOKIE)) return NextResponse.next();

  if (pathname.startsWith("/api/")) return Response.json({ error: "Not signed in" }, { status: 401 });
  const url = request.nextUrl.clone();
  const { search } = request.nextUrl;
  url.pathname = "/login";
  // The consent page carries the connector's request in its query, so sign-in
  // returns there with it intact. Other pages start over at the board.
  url.search = pathname.startsWith("/oauth/") ? `?next=${encodeURIComponent(pathname + search)}` : "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico|icon.svg|.*\\.(?:png|jpg|svg|ico|webp)$).*)"],
};
