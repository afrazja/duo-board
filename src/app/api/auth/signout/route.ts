import { cookies } from "next/headers";
import { accountsEnabled, serverSupabase } from "@/lib/account";
import { SESSION_COOKIE } from "@/lib/session";

// Sign the browser out of both kinds of session.
export async function POST() {
  if (accountsEnabled()) {
    const supabase = await serverSupabase();
    await supabase.auth.signOut();
  }
  (await cookies()).delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
