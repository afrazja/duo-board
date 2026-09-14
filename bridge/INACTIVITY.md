# Step 4: five-minute inactivity sleep

Implemented and tested locally. Nothing in this stage deploys the website,
applies a migration to the live database, restarts an old assistant loop, or
registers Windows startup. The helper must be running to receive wake requests;
Windows startup registration remains step 7.

## Behavior

Each locally linked owner/conversation has its own persisted `lastActivityAt`
and `sleepingAt`. An awake conversation enters `sleeping` after 300,000 ms with
no activity and no answer in progress. The helper checks deadlines every 250 ms;
no browser timers or model calls are involved. A running answer is allowed to
finish, and its completion starts a fresh five-minute window. The existing
30-minute turn timeout and manual Stop still apply to work that does not finish.

| Event | Effect |
| --- | --- |
| New request accepted by the helper | Refresh the timer; wake Sleep, but preserve manual Stop/attention |
| Explicit Wake/Resume | Refresh the timer and permit queued work; do not replay stopped messages |
| Answer finishes locally | Start a new five-minute idle window |
| Message saved in that board conversation | Record passive activity; refresh an awake timer without starting a turn |
| Status read, empty queue check, repeated delivery, or model connection check | No activity |
| Mouse movement, typing an unsent draft, or merely viewing a page | Not tracked in this stage |
| Five minutes idle | Sleep, preserve the task ID/history and unstarted queued work |
| Manual Stop | Pause and cancel/interrupt work; passive activity and new messages cannot silently resume it |

Message activity includes user messages, notes, and either assistant's saved
replies. It is only a timestamp signal: an assistant's post does not become a
user instruction or a model request. Activity in one conversation cannot reset
another conversation's timer, including conversations from another account.
Passive activity never wakes an already sleeping conversation; an explicit Wake
or newly enqueued user request does. [Step 5](INTERFACE.md) now automatically
queues addressed user messages and supplies the visible Wake/status controls.
Its card Stop cancels one question without pausing later questions; the local
whole-conversation Stop described above remains available separately.

## Browser closure, offline periods, and restart

`supabase/helper-inactivity.sql` adds an after-insert message trigger. The
activity receipt and message commit together, so no open browser is needed to
record messages or replies. It records no receipts for unconnected/revoked
helpers. Reads and health checks never write activity. Apply the updated
`helper-queue.sql` first, then the inactivity migration, in a development database.
Both scripts can be reapplied without resetting saved requests.

The helper stores local deadlines atomically. Restarting it or resuming the
computer after sleep does not grant another five minutes: overdue awake
conversations sleep before queued model work can start. Old state from before
step 4 gets one initial five-minute window when first loaded; existing manual
Stop and attention states remain intact.

Activity delivered after an outage keeps its original age, calculated using
database timestamps. Retried receipt IDs do not refresh deadlines. Offline
queued work is retained when its conversation sleeps and can continue on an
explicit Wake. Uncertain previous turns still use the existing reconciliation
rules and are never blindly rerun.

## What actually stops

A sleeping conversation starts no model work and does not check its Codex task.
If every conversation is sleeping, paused, or awaiting attention and no work is
active, the helper closes **its own** private Codex child process. It preserves
all conversation-to-task links and resumes the same task for subsequent work.
An active task in another conversation prevents that shared child from closing.
A Wake that arrives while the child is closing waits for release before resuming,
so two processes do not compete for the same task.

The lightweight outbound website queue connection stays alive to receive Wake
and Stop. It still makes infrastructure requests, but makes no model calls while
waiting. Sleep does not close the whole helper, control an unrelated desktop
task, or switch any older polling automation on or off.

## Verification

`npm test` covers the five-minute boundary with an injected clock, a response
lasting longer than five minutes, separate conversation/owner timers, duplicate
and stale activity, retained deadlines after restart, manual Stop, same-task
resumption after releasing the child, and Wake racing connection shutdown.

PostgreSQL integration tests verify transactional message activity, account
isolation, read/health checks producing no activity, delayed activity with a
different local clock, and authenticated Wake reaching a sleeping helper with
zero model calls. These are accelerated local tests, not a live five-minute
session. No real account or model usage is needed for them.

The process connection and saved-task resume behavior use the established
[Codex App Server protocol](https://learn.chatgpt.com/docs/app-server), already
verified against the installed client in steps 1 and 2.
