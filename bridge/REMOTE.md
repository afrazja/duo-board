# Step 3: website-to-helper delivery

Implemented and verified locally. The migration is not applied to the live
database and these routes are not published yet. No real account was connected
and no background helper was left running by this stage's verification.

The website saves requests in PostgreSQL. The helper makes an outbound HTTPS
request that waits up to 15 seconds for queued work, then reconnects. The endpoint
checks the queue at most every 750 ms while waiting. This is lightweight database
polling, not a ChatGPT turn, browser-session check, cron job, or model loop.
Infrastructure/database requests continue while connected; idle waiting consumes
no model calls. A future push transport can replace this without changing the
durable queue.

## Local integration setup

1. Use an isolated development Supabase database with the existing board schema,
   `permanent-removal.sql`, and `accounts.sql`. Apply `supabase/helper-queue.sql`
   there, followed by `supabase/helper-inactivity.sql` for step 4 and
   `supabase/helper-ui.sql` for step 5 (on the current board schema with task
   stops and answer modes), then `supabase/helper-cutover.sql` for Level 6.
   Apply the handoff guard before connecting a helper. If step 3 was
   already installed in a development database, reapply the updated queue file
   before applying the inactivity file. No extra environment variables or provider API keys are needed; the
   server uses its existing Supabase configuration.
2. Run the website and sign in. From that same authenticated origin, call
   `POST /api/helper` with `{"name":"My computer"}`. This creates or rotates the
   account's helper connection. The response contains a `connection` object with
   `url`, `ownerId`, `deviceId`, and `token`; the token is returned only at creation.
3. Save only the `connection` object to a private JSON file such as
   `.bridge-state/connection.json`. This directory is ignored by Git. The file
   contains a secret; keep it within the Windows account's private directory.
   Do not pass the token as a URL or command-line argument.
4. Using the local commands in [README.md](README.md), link the account ID and
   board conversation ID to a workspace. The website cannot choose a local path,
   create a mapping, or adopt a desktop-owned Codex task. Wait for the successful
   local link receipt before sending work.
5. Start the helper with the same state directory and its private configuration:

   ```powershell
   npm run bridge:start -- --remote-config .bridge-state/connection.json
   ```

6. Send a request using the account-authenticated API below. Inspect delivery
   status using `GET /api/helper/requests?thread=<conversation UUID>` and local
   helper state using `npm run bridge:control -- --status`. Use Ctrl+C to stop
   the helper after development testing.

The first successful connection pins the key to the instance ID saved in the
helper's state. A second state directory cannot take over with a copied key.
Keep that state directory across restarts. If moving to another computer or
recovering lost state, stop the old helper and rotate the key from the account.
Rotation keeps server request history and does not blindly replay acknowledged
work whose local state was lost; those requests require review.

## Account endpoints

All account endpoints verify the signed-in user through existing Supabase Auth.
They never accept a claimed owner ID. Mutations reject cross-site browser calls,
and responses are not cached. One helper connection is allowed per account.

| Endpoint | Request | Result |
| --- | --- | --- |
| `GET /api/helper` | None | Safe connection metadata and last contact; no key |
| `POST /api/helper` | `{"name":"My computer"}` | Create/rotate a helper key, returned once |
| `DELETE /api/helper` | None | Revoke the current helper key |
| `GET /api/helper/requests?thread=<UUID>` | None | Latest 100 request statuses for an owned conversation |
| `POST /api/helper/requests` | Command below | Persisted request ID/status, HTTP 202 |

Example command body (replace the UUIDs with actual owned records):

```json
{
  "id": "b125c69f-bd8c-40a2-8c92-5cfc0091b5b1",
  "thread_id": "ae49e5ee-8aba-4a97-811c-966cffcaf065",
  "action": "wake",
  "message_id": "4e3d407c-c1a5-4ed3-9e89-3df0b8ffb6cf"
}
```

Reuse `id` on retries. The same ID with changed content is rejected. The server
loads the message from its database and snapshots its text; clients cannot
submit an arbitrary prompt through this endpoint. Only an owned user's message
addressed to ChatGPT or both assistants is eligible. Assistant posts and notes
cannot trigger work. Other assistants' content remains untrusted context.

- `wake`: resume the linked conversation; optionally enqueue `message_id`.
- `message`: require `message_id` and enqueue it, without overriding manual Stop.
- `stop`: with `message_id`, stop only that question. Without it, pause the
  conversation, interrupt active work, and cancel older queued work. The chat
  card uses `stop_board_task`, which saves its stop flag and helper command together.
- `activity`: omit `message_id`; refresh the idle timer of an awake conversation.
  It never starts a model turn or resumes a manually stopped or sleeping task.
  Message insertion records this automatically after the step 4 migration;
  browser interaction controls can use this same authenticated endpoint later.

Separate command IDs referencing the same message are deduplicated locally.
Wake does not replay previously stopped messages: send a new message to continue.

## Delivery and failure behavior

`POST /api/agent/helper` accepts `receive`, `ack`, and `result`, with the helper
key only in its Authorization header. It does not accept account cookies, URL
keys, or existing assistant MCP keys as authorization. Only token hashes are
stored in PostgreSQL. The functions and tables are inaccessible to anonymous
and authenticated database roles; only the server service role calls them.

Receive returns database timestamps and is ordered; it does not consume requests.
The helper uses server-to-server timestamp differences to preserve the age of
delayed activity, independently of clock differences between server and computer.
The helper persists its local
command and delivery mapping before acknowledging. Results remain in its local
outbox until the website confirms them. Retrying after a lost acknowledgement
does not start another turn. Unknown local mappings become `attention` without
creating a task. Stop acknowledgement means the command was saved; the final
Stop result waits until affected work is terminal.

On disconnection, queued starts are held. Active work can finish and save its
result locally; uploads resume after reconnecting. A Stop queued on the server
cancels earlier undelivered work and suppresses late results from received work.
An offline helper cannot receive an immediate interrupt; it processes the saved
Stop when its connection returns.

Revocation, key rotation, an instance conflict, or an invalid protocol response
holds new work and stops the account's active helper tasks. Reconnection requires
the account's updated configuration. Once paired, startup requires the remote
configuration; omitting it cannot silently resume saved remote work offline.
Deleted request/conversation acknowledgements stop only their local conversation.

With the [step 5 migration](INTERFACE.md), new user messages enqueue automatically,
and completed results create linked Markdown replies in the same transaction as
their acknowledgement. Settings offers private pairing downloads. Wake and request
status appear beside ChatGPT, with Stop in each waiting card. Internal activity
receipts are excluded from the user-facing request history. Status contains no
keys, workspace paths, task IDs, prompts, or answers.

## Verification

```powershell
npm run test:helper-queue
npm test
```

The tests apply the real migrations to an isolated PGlite PostgreSQL database
and exercise the shared HTTP handlers and real local worker over loopback HTTP.
They cover account boundaries, database role restrictions, hashed credentials,
rotation/revocation, instance pinning, retries, lost acknowledgements, offline
delivery, unknown mappings, Stop completion, and late-result suppression.
No live credentials or model calls are used by these tests. Actual Codex start,
resume, and interrupt verification is documented in the helper README.
