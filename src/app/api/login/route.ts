import { cookies } from "next/headers";
import { expectedSessionToken, passwordMatches, SESSION_COOKIE } from "@/lib/session";

export async function POST(req: Request) {
  let password = "";
  try {
    const body = (await req.json()) as { password?: unknown };
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }

  if (!(await passwordMatches(password))) {
    // A small delay makes guessing tedious without needing a rate limiter.
    await new Promise((r) => setTimeout(r, 400));
    return Response.json({ error: "Wrong password" }, { status: 401 });
  }

  const token = await expectedSessionToken();
  if (!token) return Response.json({ error: "BOARD_PASSWORD is not set" }, { status: 503 });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return Response.json({ ok: true });
}

export async function DELETE() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
