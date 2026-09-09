import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionIsValid } from "@/lib/session";

// Everything is behind the password except: the login page and its route,
// and the two agent surfaces (MCP and the plain HTTP mirror), which carry
// their own tokens.
const OPEN_PREFIXES = ["/login", "/api/login", "/api/mcp", "/api/agent"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (OPEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) return NextResponse.next();

  const ok = await sessionIsValid(request.cookies.get(SESSION_COOKIE)?.value);
  if (ok) return NextResponse.next();

  if (pathname.startsWith("/api/")) return Response.json({ error: "Not signed in" }, { status: 401 });
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico|icon.svg|.*\\.(?:png|jpg|svg|ico|webp)$).*)"],
};
