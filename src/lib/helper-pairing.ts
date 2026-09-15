import { randomBytes } from "node:crypto";
import { db } from "./db";
import { hashHelperSecret as hash, openHelperToken, sealHelperToken, type SealedHelperToken } from "./helper-pairing-crypto";

const CODE_PREFIX = "duo_pair_";
const CODE_PATTERN = /^duo_pair_[A-Za-z0-9_-]{43}$/;
const TOKEN_PATTERN = /^duo_helper_[A-Za-z0-9_-]{43}$/;
const PAIRING_LIFETIME_MS = 10 * 60_000;

export async function createHelperPairing(ownerId: string, conversationId: string, origin: string) {
  const cleanOrigin = new URL(origin);
  if (cleanOrigin.protocol !== "https:" || cleanOrigin.origin !== origin) throw new Error("Helper pairing requires the secure website origin");
  const thread = await db().from("threads").select("id").eq("id", conversationId).eq("owner_id", ownerId).eq("archived", false).maybeSingle();
  if (thread.error || !thread.data) throw new Error("Conversation not found");

  const token = `duo_helper_${randomBytes(32).toString("base64url")}`;
  const code = `${CODE_PREFIX}${randomBytes(32).toString("base64url")}`;
  const configured = await db().rpc("helper_user", { p_owner: ownerId, p_action: "configure", p_args: { name: "My computer", token_hash: hash(token) } });
  if (configured.error) throw new Error("Could not prepare the helper connection");
  const deviceId = (configured.data as { device_id?: string } | null)?.device_id;
  if (!deviceId) throw new Error("Could not prepare the helper connection");

  const sealed = sealHelperToken(token, code);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PAIRING_LIFETIME_MS).toISOString();
  await db().from("helper_pairings").delete().eq("owner_id", ownerId);
  await db().from("helper_pairings").delete().lt("expires_at", now.toISOString());
  const saved = await db().from("helper_pairings").insert({ code_hash: hash(code), owner_id: ownerId, device_id: deviceId, conversation_id: conversationId, origin, ...sealed, expires_at: expiresAt });
  if (saved.error) {
    await db().rpc("helper_user", { p_owner: ownerId, p_action: "revoke", p_args: {} });
    throw new Error("Could not create the one-time installer connection");
  }
  return { code, expiresAt };
}

export async function consumeHelperPairing(code: string) {
  if (!CODE_PATTERN.test(code)) return null;
  const result = await db().from("helper_pairings").delete().eq("code_hash", hash(code)).gt("expires_at", new Date().toISOString())
    .select("owner_id,device_id,conversation_id,origin,token_cipher,token_iv,token_tag").maybeSingle();
  const pairing = result.data as { owner_id: string; device_id: string; conversation_id: string; origin: string; token_cipher: string; token_iv: string; token_tag: string } | null;
  if (result.error || !pairing) return null;
  let token: string;
  try {
    token = openHelperToken(pairing as SealedHelperToken, code);
  } catch {
    return null;
  }
  if (!TOKEN_PATTERN.test(token)) return null;
  const current = await db().from("helper_devices").select("id,token_hash,revoked_at").eq("id", pairing.device_id).eq("owner_id", pairing.owner_id).maybeSingle();
  if (current.error || !current.data || current.data.revoked_at || current.data.token_hash !== hash(token)) return null;
  return {
    connection: { url: pairing.origin, ownerId: pairing.owner_id, deviceId: pairing.device_id, token },
    conversationId: pairing.conversation_id,
  };
}
