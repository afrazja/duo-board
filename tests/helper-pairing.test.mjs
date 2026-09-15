import test from "node:test";
import assert from "node:assert/strict";
import { openHelperToken, sealHelperToken } from "../src/lib/helper-pairing-crypto.ts";

const code = `duo_pair_${"c".repeat(43)}`;
const token = `duo_helper_${"t".repeat(43)}`;

test("one-time helper token encryption requires the pairing code", () => {
  const sealed = sealHelperToken(token, code);
  assert.equal(JSON.stringify(sealed).includes(token), false);
  assert.equal(openHelperToken(sealed, code), token);
  assert.throws(() => openHelperToken(sealed, `duo_pair_${"x".repeat(43)}`));
  assert.throws(() => openHelperToken({ ...sealed, token_cipher: `x${sealed.token_cipher.slice(1)}` }, code));
});
