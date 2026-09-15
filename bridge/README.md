# Duo Board background helper — steps 1 through 7

This directory contains the verified Codex connection and a persistent local
worker. The worker receives local commands, saves one Codex task link for each
owner/conversation pair, runs queued requests, and saves their final answers.
The optional [website connection](REMOTE.md) saves and delivers authenticated
wake/message/stop commands and returns results. [Five-minute inactivity sleep](INACTIVITY.md)
is implemented in the helper. [Board controls and reply delivery](INTERFACE.md)
are implemented. [Real Codex verification and legacy handoff](VERIFICATION.md)
cover Level 6. [Windows startup and publication](STARTUP.md) cover Level 7.

## Claude sessions

The helper runs Claude through the Claude Code CLI, beside Codex, when the CLI
is installed for the signed-in Windows account (the installer and `bridge:startup`
look on `PATH`, under npm's global folder and under `~/.local/bin`; the
`DUO_CLAUDE_EXECUTABLE` variable overrides that). Claude Desktop has no supported
interface for another program to create or continue its sessions, so it is not
used; Claude Code's headless mode is the documented way to do both:

- A new conversation reserves a session ID locally, saved in `state.json` next to
  the Codex task ID. Nothing runs in Claude Code until the first Claude-addressed
  message. That first turn is `claude -p --session-id <id> --name "Duo Board — <title>"`,
  every later turn is `claude -p --resume <id>`, always from the conversation's
  workspace folder. Session content lives only in Claude Code's own store; the
  helper never reads or edits those files, and it keeps no transcript of its own.
- Each turn is a private child process with read-only tools (`Read`, `Glob`,
  `Grep`), no MCP servers (`--strict-mcp-config`), the prompt on stdin, and the
  board's guidance as an appended system prompt. Stop ends that process; a
  session interrupted mid-answer stays resumable, and one interrupted before
  Claude Code saved anything is created again under the same reserved ID.
- Uncertain outcomes (the helper stopped while a turn was running, or the CLI
  exited after starting without reporting a result) are held for review, like
  Codex; Claude Code exposes no supported way to read a session's turns back, so
  they are never re-sent. A Claude problem holds only the Claude lane of that
  conversation; ChatGPT keeps answering, and Wake clears both lanes.
- `claude auth status --json` is checked before the first turn after each idle
  release. A signed-out CLI marks the Claude lane for attention.
- The helper reports which assistants it runs on every board call. The board
  creates Claude requests, routes Claude's legacy reads to `helper_managed`, and
  blocks legacy Claude posts only while the paired helper reports Claude.
- When a conversation is removed on the board, its Claude session goes with its
  workspace folder. Claude Code has no command for deleting a foreground
  session, so the helper removes the transcript named by that session's UUID
  (and a same-named folder, if any) from the projects directory that
  `claude auth status --json` reports, inside the project folder derived from
  the conversation's workspace. Other sessions and projects are never touched;
  a session that never started has nothing to delete. The removal is recorded
  in `state.json` as `claudeSessionCleanup`, retried with backoff when blocked,
  and only ever triggered by the board's explicit removal receipt.

Local commands accept `assistant` on `enqueue` and `cancel` (`chatgpt` when
omitted), and `link` accepts `claudeSessionId` for an existing released session
and `title` for the session name. A Claude session, like a Codex task, can be
linked to one conversation only; saved state naming one twice fails closed.

## Run the local helper

Under your signed-in Windows account, from this repository:

```powershell
npm run bridge:start
```

The state directory defaults to `.bridge-state/helper`. Override it with
`npm run bridge:start -- --state-dir C:\path\to\helper-state`.
Use Ctrl+C to shut down cleanly. While idle the helper starts no Codex process
and makes no model requests. Five minutes after a conversation becomes idle it
sleeps. When all conversations are sleeping, paused, or need attention and no
work is active, the helper releases its private Codex process. New work or an
explicit Resume can wake an idle conversation and reuse its saved task.

The local inbox is watched for new files, with a two-second filesystem scan to
recover missed notifications. This scan does not check Duo Board, any browser
session, or the model. A Windows named-pipe lock prevents two helpers from
owning the same state directory and is released by Windows after a crash.

## Local commands (development interface)

Save a command as JSON and submit it with:

```powershell
npm run bridge:control -- --file C:\path\to\command.json
npm run bridge:control -- --status
```

Use the same `--state-dir` for helper and control commands. The command prints
the receipt path. A receipt with `ok: true` means the command is saved, not that
the AI has finished. Final responses and request status are in `state.json`.
Status output excludes request/response text. `service.json` is diagnostic
metadata; it is not a remote health or authentication endpoint.

Every command has `id`, `type`, `ownerId`, and `conversationId`. IDs are UUIDs.
Keep the same command ID on delivery retries. Reusing it with different content
is rejected. The local files are a trusted development interface. Website
authentication and secure delivery use a separate helper key; see [step 3](REMOTE.md).

| Type | Additional fields | Effect |
| --- | --- | --- |
| `link` | `cwd`, optional `threadId`, `claudeSessionId`, `title` | Associate a local workspace and optionally an existing, released Codex task or Claude session. Without IDs, create the task and reserve the session on the first request. |
| `enqueue` | `requestId`, `text`, optional `assistant` | Save a request for one assistant; repeated request IDs for the same assistant in the same conversation do not run again. |
| `stop` | None | Pause the conversation, stop active work of both assistants, and cancel requests queued before Stop. |
| `cancel` | `requestId`, optional `assistant` | Stop only this question, for one assistant or both; later questions can run without Resume. |
| `hold` | None | Hold queued work while an active answer finishes locally. Used by Pause conversation. |
| `resume` | None | Allow new queued requests to run. Previously stopped/uncertain requests are never replayed. |
| `activity` | None | Refresh an awake conversation's idle timer; never override Sleep or manual Stop. |

Submit `link` and wait for its successful receipt before submitting work. Commands
are ordered as accepted by the single worker; an external producer must await
receipts when command order matters. The helper never opens a public HTTP listener;
the optional website connection is outbound only. Different board owners never
share a Codex task link.

Example first command (replace these IDs with actual local test IDs):

```json
{
  "id": "b125c69f-bd8c-40a2-8c92-5cfc0091b5b1",
  "type": "link",
  "ownerId": "a3138eb9-8897-4b2c-ac83-7e0f73219556",
  "conversationId": "ae49e5ee-8aba-4a97-811c-966cffcaf065",
  "cwd": "C:\\path\\to\\workspace"
}
```

The worker defaults to read-only filesystem permissions and on-request approval.
An unsupported interactive approval pauses work for user attention; it is not
automatically approved. Keep state inside your private Windows user directory:
it contains local request text and answers. Codex login credentials are not copied.
Website setup saves its separate private helper key in `connection.json`, outside
the worker's `state.json`; both files are excluded from Git.
State and deduplication receipts are currently retained without automatic pruning.

## Run the connection verification

Run from the repository under the Windows account signed in to Codex:

```powershell
npm run bridge:verify
```

This uses the installed `codex` executable and its existing ChatGPT login and
model settings. `DUO_CODEX_EXECUTABLE` can name an explicit executable path.
No API key, copied credentials, public port, or separate sign-in is required
when `codex login status` already reports a signed-in account.

The verification creates one temporary task with read-only permissions and
instructions to avoid tools. It runs synthetic model requests, so the live
verification consumes some Codex usage. It checks:

1. Initialize a private app-server connection and confirm a signed-in account.
2. Start a response and receive the streamed answer.
3. Reject a competing process attempting to resume the owned task.
4. Shut down the owner, start another process, resume the same task ID, and
   recall the verification code from the previous request.
5. Interrupt a response after streaming starts and observe `interrupted`.
6. Start another response in the same task after interruption.
7. Archive the temporary task and close the child process.

A structured result is saved under `.bridge-state/connection-*/result.json`.
That directory is excluded from Git. The report contains test results and the
temporary task ID, but no credentials or user conversation content.

## Ownership boundary

The installed Windows Codex build supports this helper-owned app-server
connection. Its shared daemon control socket was unavailable during the first
verification. A separate process cannot resume a task while another process
owns it. Therefore this proves interruption of work started by the helper,
not arbitrary interruption of the already-running desktop app.

The worker retains an owning connection for its tasks, persists its board-to-task
mapping, and marks ownership conflicts as requiring attention. It does not
create a replacement session, steal a task, or start a second polling loop.
An idle existing task can be adopted only after its current owner releases it.

## Failure handling

The client correlates responses independently of their arrival order, keeps a
bounded backlog of recent events to handle notifications arriving before a
request response, and rejects pending work on timeout or disconnection.
Unsupported server requests, including interactive approvals, return an error
and emit `unsupportedRequest`; the worker interrupts the relevant run and records
`attention`. They are never automatically approved. The board displays “Needs
attention”; review the local helper before deciding how to continue.

The worker saves start intent before sending it to Codex. If a response is lost,
it reconnects and checks saved turns using the turn ID or persisted user-message
client ID. A confirmed completed answer is recovered without running again.
An interrupted run stays stopped; an unprovable outcome requires attention.
Task-creation uncertainty is also held for review rather than creating another
task. This is conservative recovery, not a promise of exactly-once external
side effects. The worker retries temporary pre-start connection failures with
backoff and never starts two turns in the same conversation at once.

The helper closes its own Codex child when shutting down, including after a
state-write failure. Active work is interrupted; queued work survives. It does
not delete or kill existing desktop tasks. Malformed state is preserved and
startup fails rather than resetting links.

Run protocol failure tests without any model calls (a local stand-in for the
Claude Code CLI covers session creation, naming, resume, interruption, restart
recovery, pause/wake, per-lane attention and the one-session-per-conversation rule):

```powershell
npm run test:bridge
```

Run the complete worker verification using a temporary real Codex task:

```powershell
npm run bridge:verify-worker
```

This verifies the local inbox, single-process lock, duplicate suppression, same-task
history after restart, recovery from a deliberately lost acknowledgement after
a real answer, actual Stop, held work, and explicit Resume. It runs five synthetic
turns, archives the temporary task, stops the test helper, and writes
`.bridge-state/worker-verification-*/verification-result.json`.

## Remaining steps

7. Reviewed publication and Windows sign-in startup registration.

Protocol reference: https://learn.chatgpt.com/docs/app-server
