# Level 6: real Codex verification and legacy handoff

The user story is: a question saved from the board reaches the persistent helper,
runs in the conversation's own Codex task, and returns one linked reply. Stop
cancels only that question. Five idle minutes release the helper's Codex process;
Wake restores the same task and history.

## Scope

`bridge/verify-app.mjs` exercises the actual built Next UI, the real helper HTTP
handlers and SQL migrations, the persistent local service, and the installed
Codex app-server using its existing ChatGPT sign-in. It uses temporary board
accounts and an isolated PGlite PostgreSQL database. The helper uses loopback
HTTP with the production 15-second receive wait.

The fixture substitutes board authentication and message/thread API adapters;
it does not verify Supabase Auth, hosted PostgREST, Vercel networking, or the
published domain. Those require a smoke test during Level 7's reviewed rollout.
The fixture never forwards authentication or API requests to the live website.

## Verified result

The completed run passed on 2026-09-15 local time (2026-09-14 20:32 UTC):

| Boundary | Evidence |
| --- | --- |
| Browser → saved question → real Codex → reply card | Passed, including a lost acknowledgement with only one model turn |
| Card Stop → real running turn | One interrupt; Codex reported `interrupted`; no late reply was inserted |
| Pause, queued message, and Resume | No model start while paused; answer delivered after Resume |
| Offline Stop → reconnect | Stop persisted and the canceled question never started |
| Closed browser → idle sleep | 300 elapsed seconds, zero Codex calls during the interval, private child released |
| Service restart → Wake → same history | Saved task ID and remembered code retained |
| Second conversation | Different task ID; no access to the first conversation's remembered code |
| Legacy cached reply | Rejected by the database handoff guard |
| Browser runtime / cleanup | No runtime errors; both temporary tasks archived and the helper closed |

The successful run used six model turns and two private Codex connections.
Its raw report and screenshots are in
`.bridge-state/app-verification-1789417495560/`. All 104 offline tests, lint on
the changed production modules, and the production build also passed.

An earlier verifier run completed reply/Stop/continuation checks, then used the
wrong button label in paused mode. The test was corrected to accept “Queue
message” and to await the click/response together; its temporary task was
archived. That incomplete three-turn run is recorded separately under
`.bridge-state/app-verification-1789417177941/` and is not counted as a pass.

This is an opt-in test that consumes Codex usage. `npm test` remains offline and
uses no real model calls. All model prompts in the live test are synthetic,
read-only, and instruct Codex to use no tools. Temporary Codex tasks are archived
and the test helper is closed afterward.

## Reproduce

1. Build the website, then start it on `127.0.0.1:3211`.
2. Run `npm run bridge:verify-app`. If Playwright is not installed in the project,
   supply `-- --playwright-module "absolute-path-to-playwright"` using an available
   local runtime. The script prints the local board URL and a `browserFile` path.
3. Open that URL in a dedicated test browser. Verify the page has no errors and
   shows the conversation, composer, and helper status. Save that browser's CDP
   WebSocket URL in the printed file as `{"cdp":"ws://127.0.0.1:..."}`. Alternatively,
   pass `--cdp` to the script when the dedicated browser is already available.
4. Leave the test running through its real five-minute idle interval. It reports
   progress without making Codex calls during that interval. The browser tab is
   deliberately closed, then reopened for Wake.
5. Read `.bridge-state/app-verification-*/verification-result.json`. The report
   records each completed check, model-turn counts, temporary task IDs, and
   cleanup. Screenshots live beside it. Stop the Next test server afterward.

The script checks real reply delivery despite a lost acknowledgement, real
streaming interruption from the card, continuation after Stop, Queue message
while paused, Resume, offline Stop and reconnect, actual five-minute sleep,
service restart, Wake with retained history, separate histories for another
conversation, blocked cached legacy replies, and browser runtime errors.

## Legacy handoff

Apply `supabase/helper-cutover.sql` after `helper-queue.sql`,
`helper-inactivity.sql`, and `helper-ui.sql`, before connecting the helper.

- For a helper-managed account, legacy ChatGPT `read_new` returns no work and
  `helper_managed: true`, with guidance to stop the old loop. It does not advance
  delivery cursors. Claude and accounts without a helper retain their behavior.
- A database trigger rejects ChatGPT replies from the old transport, including
  cached replies. Only the helper's transactional result publisher supplies its
  internal `helper_reply_for` marker; public post handlers cannot set it.
- Ownership persists when the helper is offline, rotated, or disconnected.
  Disconnect stops access; it does not automatically resume the old reader.
- A missing cutover function supports older installations. Other routing errors
  fail closed rather than returning work to two responders.

Before production pairing, stop the legacy dispatcher/schedules and release any
active task ownership. A guard cannot interrupt work an old client already
received before handoff. Existing saved tasks and drafts are preserved; no
permanent cleanup is performed by this stage. Adopt an existing Codex task only
through the explicit local linking interface after its previous owner releases it.

On this computer, the old dispatcher automation is absent and the remaining
`Duo Board 9224fffd` schedule was verified PAUSED during Level 6. Nothing was
resumed. The new routing guard remains local until Level 7 publication.

Returning to the legacy transport is a deliberate maintenance operation: stop
the helper and its pending work, review unresolved requests and legacy cursors,
then remove the handoff guard under a reviewed rollback. Revoking a key alone
must not cause old questions to be answered again.

Protocol reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server).
