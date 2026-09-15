import path from "node:path";
import { parseArgs } from "node:util";
import { startBackground } from "../bridge/background.mjs";

const { values } = parseArgs({ options: { "state-dir": { type: "string" }, codex: { type: "string" } } });
const directory = path.resolve(values["state-dir"]);
const helperFile = path.join(path.dirname(path.resolve(process.argv[1])), "helper.cjs");
const background = await startBackground({ directory, executable: values.codex, helperFile });
process.on("SIGINT", () => { void background.close(); });
process.on("SIGTERM", () => { void background.close(); });
await background.done;
