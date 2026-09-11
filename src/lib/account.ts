import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { db } from "./db";
import { hashToken, tokenHint, type Owner } from "./agent-auth";
import { ensureAssistantRows } from "./board";
import { sessionIsValid, SESSION_COOKIE } from "./session";

// Who is using the page. With Supabase Auth configured (NEXT_PUBLIC_SUPABASE_ANON_KEY
// set), each signed-in person owns their own board. Without it, the board runs
// as before: one shared password, one board, owner null.

export type AccountMode = "accounts" | "password";
export interface Account {
  owner: Owner;
  email: string | null;
  mode: AccountMode;
}

export function supabaseUrl(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
}

export function accountsEnabled(): boolean {
  return !!supabaseUrl() && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
}

export async function serverSupabase() {
  const store = await cookies();
  return createServerClient(supabaseUrl(), process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const c of list) store.set(c.name, c.value, c.options);
        } catch {
          // Called from a Server Component: the proxy refreshes cookies instead.
        }
      },
    },
  });
}

export async function currentAccount(): Promise<Account | null> {
  if (!accountsEnabled()) {
    const store = await cookies();
    return (await sessionIsValid(store.get(SESSION_COOKIE)?.value)) ? { owner: null, email: null, mode: "password" } : null;
  }
  const supabase = await serverSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  await ensureAccount(user.id, user.email ?? null);
  return { owner: user.id, email: user.email ?? null, mode: "accounts" };
}

// First contact with an account in this instance: claim the pre-account board
// for its owner if this is them, then make sure the two assistant rows exist.
const ensured = new Map<string, Promise<void>>();
export function ensureAccount(owner: string, email: string | null): Promise<void> {
  let p = ensured.get(owner);
  if (!p) {
    p = (async () => {
      await claimLegacyIfOwner(owner, email);
      await ensureAssistantRows(owner);
    })().catch((e) => {
      ensured.delete(owner);
      throw e;
    });
    ensured.set(owner, p);
  }
  return p;
}

async function claimLegacyIfOwner(owner: string, email: string | null): Promise<void> {
  const target = process.env.BOARD_OWNER_EMAIL?.trim().toLowerCase();
  if (!target || !email || email.trim().toLowerCase() !== target) return;
  const { data: legacy, error: probe } = await db().from("threads").select("id").is("owner_id", null).limit(1);
  if (probe) throw new Error(`Accounts need supabase/accounts.sql: ${probe.message}`);
  const { data: legacyAssistants } = await db().from("assistants").select("name").is("owner_id", null).limit(1);
  if (!legacy?.length && !legacyAssistants?.length) return;
  const tokens: { assistant: string; token_hash: string; token_hint: string }[] = [];
  for (const [assistant, token] of [["claude", process.env.BOARD_TOKEN_CLAUDE], ["chatgpt", process.env.BOARD_TOKEN_CHATGPT]] as const) {
    if (token && token.length >= 16) tokens.push({ assistant, token_hash: hashToken(token), token_hint: tokenHint(token) });
  }
  const { error } = await db().rpc("claim_legacy_board", { p_owner: owner, p_tokens: tokens });
  if (error) throw new Error(`Could not claim the existing board: ${error.message}`);
}
