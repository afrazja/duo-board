import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type SealedHelperToken = {
  token_cipher: string;
  token_iv: string;
  token_tag: string;
};

const pairingKey = (code: string) => createHash("sha256").update(code).digest();

export const hashHelperSecret = (value: string) => createHash("sha256").update(value).digest("hex");

export function sealHelperToken(token: string, code: string): SealedHelperToken {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", pairingKey(code), iv);
  const tokenCipher = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]).toString("base64url");
  return { token_cipher: tokenCipher, token_iv: iv.toString("base64url"), token_tag: cipher.getAuthTag().toString("base64url") };
}

export function openHelperToken(pairing: SealedHelperToken, code: string) {
  const decipher = createDecipheriv("aes-256-gcm", pairingKey(code), Buffer.from(pairing.token_iv, "base64url"));
  decipher.setAuthTag(Buffer.from(pairing.token_tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(pairing.token_cipher, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
