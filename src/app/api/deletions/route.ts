import { cookies } from "next/headers";
import { listDeletions } from "@/lib/deletions";
import { sessionIsValid, SESSION_COOKIE } from "@/lib/session";

export async function GET() {
  if (!await sessionIsValid((await cookies()).get(SESSION_COOKIE)?.value)) return Response.json({ error: "Not signed in" }, { status: 401 });
  try { return Response.json({ deletions: await listDeletions() }); }
  catch { return Response.json({ error: "Could not check session cleanup. It has not been confirmed." }, { status: 503 }); }
}
