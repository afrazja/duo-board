// A local stand-in for the Claude Code CLI's headless interface. It honours the
// same flags the helper uses (-p, --session-id, --resume, --name, --tools,
// --allowedTools, --strict-mcp-config, --max-turns, --append-system-prompt,
// auth status --json),
// keeps "sessions" as files under DUO_FAKE_CLAUDE_HOME, and never calls a model.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const home = process.env.DUO_FAKE_CLAUDE_HOME;
if (!home) { process.stderr.write("DUO_FAKE_CLAUDE_HOME is required\n"); process.exit(2); }
mkdirSync(path.join(home, "sessions"), { recursive: true });
const args = process.argv.slice(2);
const log = (entry) => appendFileSync(path.join(home, "calls.log"), JSON.stringify({ ...entry, cwd: process.cwd(), env: Object.keys(process.env).filter((key) => /^CLAUDE/.test(key)) }) + "\n");

if (args[0] === "auth") {
  log({ command: "auth status" });
  if (process.env.DUO_FAKE_CLAUDE_LOGGED_OUT) { process.stdout.write(JSON.stringify({ loggedIn: false }) + "\n"); process.exit(0); }
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "fixture@example.invalid" }) + "\n");
  process.exit(0);
}

const flags = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (["--session-id", "--resume", "--name", "--tools", "--allowedTools", "--max-turns", "--append-system-prompt", "--output-format"].includes(arg)) { flags[arg] = args[++i]; continue; }
  if (arg.startsWith("--") || arg === "-p") { flags[arg] = true; continue; }
  flags.positional = arg;
}
if (!flags["-p"] || flags["--output-format"] !== "stream-json" || flags.positional) { process.stderr.write("Fixture expects -p --output-format stream-json with the prompt on stdin\n"); process.exit(2); }
const sessionId = flags["--session-id"] ?? flags["--resume"];
const resume = Boolean(flags["--resume"]);
const file = path.join(home, "sessions", `${sessionId}.json`);
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  log({ command: "turn", sessionId, resume, name: flags["--name"] ?? null, tools: flags["--tools"] ?? null, allowed: flags["--allowedTools"] ?? null, strictMcp: Boolean(flags["--strict-mcp-config"]), prompt });
  if (process.env.DUO_FAKE_CLAUDE_FAIL_BEFORE_INIT) { process.stderr.write(process.env.DUO_FAKE_CLAUDE_FAIL_BEFORE_INIT + "\n"); process.exit(1); }
  if (resume && !existsSync(file)) { process.stdout.write(`No conversation found with session ID: ${sessionId}\n`); process.exit(1); }
  if (!resume && existsSync(file)) { process.stderr.write(`Error: Session ID ${sessionId} is already in use.\n`); process.exit(1); }
  const session = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { turns: [], name: null };
  const persist = () => { session.name = flags["--name"] ?? session.name; writeFileSync(file, JSON.stringify(session)); };
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd(), tools: (flags["--tools"] ?? "").split(",").filter(Boolean), mcp_servers: [] }) + "\n");
  const request = prompt.match(/<user_request>\n([\s\S]*?)\n<\/user_request>/)?.[1] ?? prompt.trim();
  if (request.includes("unpersisted-hold")) { setInterval(() => {}, 1000); return; }
  session.turns.push({ prompt: request });
  persist();
  if (request.includes("hold")) { setInterval(() => {}, 1000); return; }
  if (request.includes("lost-after-init")) { process.exit(1); }
  if (request.includes("error-result")) { process.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "Something went wrong", session_id: sessionId, uuid: randomUUID() }) + "\n"); process.exit(1); }
  const earlier = session.turns.slice(0, -1).map((turn) => turn.prompt);
  const answer = request.includes("recall") ? `Recalled: ${earlier.join(" | ") || "nothing"}` : `Answer: ${request}`;
  session.turns.at(-1).answer = answer;
  persist();
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer, session_id: sessionId, num_turns: 1, uuid: randomUUID() }) + "\n");
  process.exit(0);
});
