# Step 5: app controls and replies

Level 5 implements the interface. Level 6 verifies the real model flow.
See [Windows startup and publication](STARTUP.md) for Level 7 deployment and
background operation.

## What the app does

- Shows ChatGPT's Ready, Working, Sleeping, Paused, offline, and attention states.
- Offers Wake when the linked helper is sleeping or paused, or queues Wake while
  the computer is offline. Wake alone makes no model request.
- Saves each new user message addressed to ChatGPT or Both together with its
  helper request. Notes and assistant posts never start model work.
- Places Stop in the waiting reply card. It cancels only that question, blocks
  a late answer, and leaves later questions able to run. An offline Stop remains
  “Stopping…” until the helper confirms it; it cannot instantly interrupt an
  offline computer.
- Saves a completed Markdown reply under its original question. Retrying a
  result or another request ID for that same question cannot duplicate the reply.
- Keeps brief spoken summaries separate from the full written answer. Explicit
  comparison requests include the original question and latest linked answer
  from each participant, labelled as untrusted context rather than instructions.
- Keeps Pause conversation separate: queued work waits, active work may finish
  locally, and its final answer is delivered after Resume. Other conversations
  continue while one answer is held.

The board polls safe status metadata every three seconds. The helper reports
through its existing outbound queue connection (up to 15 seconds per wait).
Contact becomes offline after 45 seconds without a report. These are website
requests, not Codex-session checks or model turns. Merely viewing the page or
typing an unsent draft does not reset the five-minute timer.

## Development setup

1. In an isolated database with the current board schema, including accounts,
   task stops, and answer modes, apply the updated `supabase/helper-queue.sql`,
   then `supabase/helper-inactivity.sql`, then `supabase/helper-ui.sql`.
   These scripts are repeatable and preserve saved requests.
2. Open a conversation. Use the bottom-left avatar → Settings → Connect helper.
   Download `duo-helper-connection.json`. It contains a private key, returned
   only once; replacing it revokes the prior connection.
3. On the computer signed in to Codex, open the Duo Board repository and run:

   ```powershell
   npm run bridge:connect -- --file "C:\path\to\duo-helper-connection.json"
   ```

   Choose the local workspace when asked. The website cannot choose a local
   folder or adopt an existing desktop-owned task. Keep the helper running.
4. Send a new question. To start the same helper later, run `npm run bridge:start`.
   For a custom state directory, pass the same `--state-dir` to both commands.
5. To link another conversation, close the helper with Ctrl+C, open that
   conversation's Settings, and use the command under “Link this conversation
   on your computer.” It reuses the private key already on the computer:

   ```powershell
   npm run bridge:connect -- --conversation "conversation-UUID"
   ```

   Choose a local workspace, then send a new question. Requests rejected before
   linking are left for review rather than silently replayed. Existing links
   cannot have their workspace/task replaced by this command.

State lives in `.bridge-state/helper`. Only `connection.json` contains the helper
key; it is not added to command arguments, status responses, or `state.json`.
Both the connection download and state directory should remain private. No
incoming network port is needed for the real helper.

Before connecting production, apply Level 6's `helper-cutover.sql` after the
three helper migrations and follow the [handoff guide](VERIFICATION.md). Stop
old schedules first; the guard blocks new legacy deliveries and cached replies.
Disconnecting the helper does not automatically restore the old loop.

## Verification

`npm test` covers 104 checks, including real PostgreSQL migrations/handlers,
automatic queueing, ownership, report expiry, result retry, individual Stop,
paused outbox isolation, comparison context, brief summaries, oversized answers,
and local import/linking. These tests use isolated data and no model calls.

For a reproducible local UI check, build the site and start Next on loopback port
3211, then run `node --experimental-strip-types tests/fixtures/helper-preview.mjs`.
Open `http://127.0.0.1:3222`. This fixture serves the actual built UI with synthetic
authentication and model answers, using the real queue handlers, SQL, and helper.
It never forwards API/authentication traffic to the real website. Close both
servers after testing. The fixture's `__test` controls are not part of the app.

Local browser checks cover the waiting-card Stop, a later question receiving a
linked Markdown answer, separate conversation Sleep/Wake with no extra model
start, offline Stop and reconnect, and desktop/mobile settings. The private
connection download was verified in the dedicated local browser; its key never
appeared in page text. The browser CLI's download command canceled/timed out, so
this check used the same browser's direct automation connection instead. Actual Codex
start/resume/interrupt was verified in Levels 1–2; this stage does not claim a
new live browser-to-model verification. The subsequent [Level 6 verifier](VERIFICATION.md)
uses real Codex replies with this isolated board.
