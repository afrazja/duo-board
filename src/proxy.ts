import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { SESSION_COOKIE, sessionIsValid } from "@/lib/session";

// Everything is behind sign-in except: the sign-in, sign-up and password
// reset pages and their routes, the account probe, and the two agent surfaces
// (MCP and the plain HTTP mirror), which carry their own tokens.
//
// With Supabase Auth configured (NEXT_PUBLIC_SUPABASE_ANON_KEY), sign-in is a
// Supabase session and its cookies are refreshed here. Without it, the board
// runs as before behind one shared password.
const OPEN_PREFIXES = ["/login", "/signup", "/reset-password", "/auth", "/api/login", "/api/auth", "/api/account", "/api/mcp", "/api/agent"];

function denied(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/")) return Response.json({ error: "Not signed in" }, { status: 401 });
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (OPEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) return NextResponse.next();

  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  if (anon && url) {
    let response = NextResponse.next({ request });
    const supabase = createServerClient(url, anon, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) response.cookies.set(name, value, options);
        },
      },
    });
    const { data: { user } } = await supabase.auth.getUser();
    return user ? response : denied(request);
  }

  const ok = await sessionIsValid(request.cookies.get(SESSION_COOKIE)?.value);
  return ok ? NextResponse.next() : denied(request);
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico|icon.svg|.*\\.(?:png|jpg|svg|ico|webp)$).*)"],
};
