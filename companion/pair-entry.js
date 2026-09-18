import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { importConnectionBundle } from "../bridge/connect.mjs";

const { values } = parseArgs({ options: {
  "pairing-file": { type: "string" },
  origin: { type: "string" },
  "state-dir": { type: "string" },
  "workspace-root": { type: "string" },
} });
const pairingFile = path.resolve(values["pairing-file"]);
const stateDirectory = path.resolve(values["state-dir"]);
const workspaceRoot = path.resolve(values["workspace-root"]);
const origin = new URL(values.origin);
if (origin.protocol !== "https:" || origin.origin !== values.origin) throw new Error("Use the secure Duo Board website origin");
let code;
try { code = (await readFile(pairingFile, "utf8")).trim(); }
finally { await unlink(pairingFile).catch(() => {}); }
if (!/^duo_pair_[A-Za-z0-9_-]{43}$/.test(code)) throw new Error("Return to Duo Board Settings and click Install or repair helper again");
const response = await fetch(`${origin.origin}/api/agent/helper/pair`, {
  method: "POST",
  redirect: "error",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code }),
  signal: AbortSignal.timeout(30_000),
});
const bundle = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(bundle.error ?? "The one-time helper connection could not be completed");
await importConnectionBundle({ bundle, workspaceRoot, directory: stateDirectory });
process.stdout.write(JSON.stringify({ ok: true }));
