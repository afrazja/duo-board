# Duo Board background helper — steps 1 through 7

This directory contains the verified Codex connection and a persistent local
worker. The worker receives local commands, saves one Codex task link for each
owner/conversation pair, runs queued requests, and saves their final answers.
The optional [website connection](REMOTE.md) saves and delivers authenticated
wake/message/stop commands and returns results. [Five-minute inactivity sleep](INACTIVITY.md)
is implemented in the helper. [Board controls and reply delivery](INTERFACE.md)
are implemented. [Real Codex verification and legacy handoff](VERIFICATION.md)
cover Level 6. [Windows startup and publication](STARTUP.md) cover Level 7.

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
| `link` | `cwd`, optional `threadId` | Associate a local workspace and optionally an existing, released task. Without a task ID, create one on the first request. |
| `enqueue` | `requestId`, `text` | Save a request; repeated request IDs in the same conversation do not run again. |
| `stop` | None | Pause the conversation, stop active work, and cancel requests queued before Stop. |
| `cancel` | `requestId` | Stop only this question; later questions can run without Resume. |
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

Run protocol failure tests without any model calls:

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
