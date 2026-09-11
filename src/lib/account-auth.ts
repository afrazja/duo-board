import { createClient, type Session, type User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { db } from "./db";
import { ACCESS_COOKIE, LEGACY_CLAIM_COOKIE, REFRESH_COOKIE } from "./auth-constants";
import { expectedSessionToken, safeEqual } from "./session";

export { ACCESS_COOKIE, LEGACY_CLAIM_COOKIE, REFRESH_COOKIE } from "./auth-constants";

function anonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase authentication is not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

export async function setAuthSession(session: Session): Promise<void> {
  const store = await cookies();
  store.set(ACCESS_COOKIE, session.access_token, { ...cookieOptions, maxAge: session.expires_in ?? 3600 });
  store.set(REFRESH_COOKIE, session.refresh_token, { ...cookieOptions, maxAge: 60 * 60 * 24 * 30 });
}

export async function clearAuthSession(): Promise<void> {
  const store = await cookies();
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
  store.delete(LEGACY_CLAIM_COOKIE);
}

export async function signUp(email: string, password: string, displayName: string, redirectTo: string) {
  return anonClient().auth.signUp({ email, password, options: { data: { display_name: displayName }, emailRedirectTo: redirectTo } });
}

export async function signIn(email: string, password: string) {
  return anonClient().auth.signInWithPassword({ email, password });
}

export async function sendRecovery(email: string, redirectTo: string) {
  return anonClient().auth.resetPasswordForEmail(email, { redirectTo });
}

export async function exchangeBrowserSession(accessToken: string, refreshToken: string) {
  const client = anonClient();
  return client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
}

export async function updatePassword(password: string) {
  const store = await cookies();
  const accessToken = store.get(ACCESS_COOKIE)?.value;
  const refreshToken = store.get(REFRESH_COOKIE)?.value;
  if (!accessToken || !refreshToken) return { data: { user: null }, error: new Error("Not signed in") };
  const client = anonClient();
  const session = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
  if (session.error) return session;
  const result = await client.auth.updateUser({ password });
  if (session.data.session) await setAuthSession(session.data.session);
  return result;
}

export async function currentUser(): Promise<User | null> {
  const store = await cookies();
  const accessToken = store.get(ACCESS_COOKIE)?.value;
  if (accessToken) {
    const { data, error } = await db().auth.getUser(accessToken);
    if (!error && data.user) return data.user;
  }

  const refreshToken = store.get(REFRESH_COOKIE)?.value;
  if (!refreshToken) return null;
  const refreshed = await anonClient().auth.refreshSession({ refresh_token: refreshToken });
  if (refreshed.error || !refreshed.data.session || !refreshed.data.user) return null;
  await setAuthSession(refreshed.data.session);
  return refreshed.data.user;
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) throw new Error("AUTH_REQUIRED");
  return user;
}

export function authErrorResponse(error: unknown): Response | null {
  return (error as Error)?.message === "AUTH_REQUIRED"
    ? Response.json({ error: "Not signed in" }, { status: 401 })
    : null;
}

export async function hasLegacyClaim(): Promise<boolean> {
  const value = (await cookies()).get(LEGACY_CLAIM_COOKIE)?.value;
  const expected = await expectedSessionToken();
  return Boolean(value && expected && safeEqual(value, expected));
}

export async function setLegacyClaim(value: string): Promise<void> {
  (await cookies()).set(LEGACY_CLAIM_COOKIE, value, { ...cookieOptions, maxAge: 60 * 60 * 24 });
}

export async function consumeLegacyClaim(): Promise<void> {
  (await cookies()).delete(LEGACY_CLAIM_COOKIE);
}
