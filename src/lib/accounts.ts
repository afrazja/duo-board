import type { User } from "@supabase/supabase-js";
import { db } from "./db";
import type { Assistant } from "./agent-auth";
import { makeAgentToken, tokenHash } from "./tokens";

export interface AccountSummary {
  id: string;
  email: string;
  display_name: string;
  connections: { assistant: Assistant; configured: boolean; token_last_four: string | null; created_at: string | null }[];
}

function defaultName(user: User): string {
  const fromMeta = typeof user.user_metadata?.display_name === "string" ? user.user_metadata.display_name.trim() : "";
  return (fromMeta || user.email?.split("@")[0] || "You").slice(0, 80);
}

async function seedLegacyTokens(ownerId: string): Promise<void> {
  const pairs: [Assistant, string | undefined][] = [
    ["claude", process.env.BOARD_TOKEN_CLAUDE],
    ["chatgpt", process.env.BOARD_TOKEN_CHATGPT],
  ];
  for (const [assistant, token] of pairs) {
    if (!token || token.length < 16) continue;
    await db().from("agent_tokens").upsert({
      owner_id: ownerId,
      assistant,
      token_hash: await tokenHash(token),
      token_last_four: token.slice(-4),
      created_at: new Date().toISOString(),
    }, { onConflict: "owner_id,assistant" });
  }
}

export async function ensureUserWorkspace(user: User, claimLegacy: boolean): Promise<void> {
  const email = user.email ?? "unknown@example.invalid";
  const displayName = defaultName(user);
  const profile = await db().from("board_profiles").upsert({ id: user.id, email, display_name: displayName, updated_at: new Date().toISOString() }, { onConflict: "id", ignoreDuplicates: true });
  if (profile.error) throw new Error(`Account setup failed: ${profile.error.message}`);

  if (claimLegacy) {
    const claimed = await db().rpc("claim_legacy_board", { p_owner_id: user.id });
    if (claimed.error) throw new Error(`Could not move the existing board into this account: ${claimed.error.message}`);
    await seedLegacyTokens(user.id);
  }

  const assistantRows = await db().from("assistants").upsert([
    { owner_id: user.id, name: "claude" },
    { owner_id: user.id, name: "chatgpt" },
  ], { onConflict: "owner_id,name", ignoreDuplicates: true });
  if (assistantRows.error) throw new Error(`Could not prepare assistant connections: ${assistantRows.error.message}`);

  const existing = await db().from("threads").select("id", { count: "exact", head: true }).eq("owner_id", user.id);
  if (existing.error) throw new Error(`Could not check account conversations: ${existing.error.message}`);
  if ((existing.count ?? 0) === 0) {
    const created = await db().from("threads").insert({ owner_id: user.id, title: "General" });
    if (created.error) throw new Error(`Could not create the first conversation: ${created.error.message}`);
  }
}

export async function accountSummary(user: User): Promise<AccountSummary> {
  const [profile, tokens] = await Promise.all([
    db().from("board_profiles").select("display_name,email").eq("id", user.id).single(),
    db().from("agent_tokens").select("assistant,token_last_four,created_at").eq("owner_id", user.id),
  ]);
  if (profile.error || tokens.error) throw new Error("Could not load account settings");
  const rows = tokens.data ?? [];
  return {
    id: user.id,
    email: profile.data.email,
    display_name: profile.data.display_name,
    connections: (["chatgpt", "claude"] as Assistant[]).map((assistant) => {
      const row = rows.find((item) => item.assistant === assistant);
      return { assistant, configured: Boolean(row), token_last_four: row?.token_last_four ?? null, created_at: row?.created_at ?? null };
    }),
  };
}

export async function renameAccount(userId: string, displayName: string): Promise<void> {
  const result = await db().from("board_profiles").update({ display_name: displayName.trim().slice(0, 80), updated_at: new Date().toISOString() }).eq("id", userId);
  if (result.error) throw new Error("Could not update your name");
}

export async function rotateAgentToken(ownerId: string, assistant: Assistant): Promise<string> {
  const token = makeAgentToken(assistant);
  const result = await db().from("agent_tokens").upsert({
    owner_id: ownerId,
    assistant,
    token_hash: await tokenHash(token),
    token_last_four: token.slice(-4),
    created_at: new Date().toISOString(),
  }, { onConflict: "owner_id,assistant" });
  if (result.error) throw new Error("Could not create the assistant connection");
  return token;
}
