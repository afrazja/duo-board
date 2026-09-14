# Level 7: publication and Windows startup

The helper runs under the Windows account already signed in to Codex. It has
no public listener and uses its private outbound connection to the board.
Windows starts it when that account signs in; it cannot answer while the
computer is asleep, off, or signed out. Browser tabs and terminals can be closed.

## Set up this computer

1. Open a conversation, then bottom-left avatar -> Settings -> ChatGPT background
   helper. Connect and download the private connection file.
2. In the Duo Board project folder, import it and choose the local workspace:

   ```powershell
   npm run bridge:connect -- --file "C:\path\duo-helper-connection.json" --setup-only
   npm run bridge:startup -- -Action Install
   ```

The scheduled task is named `Duo Board Helper`. It runs without an administrator
account, saves no Windows password, and opens no console window. If not yet
paired it waits locally without starting Codex. A crashed child is retried after
30 seconds; Windows can restart the supervisor after a minute. Named-pipe locks
prevent multiple helpers from owning the same saved task links.

## Manage it

```powershell
npm run bridge:startup -- -Action Status
npm run bridge:startup -- -Action Stop
npm run bridge:startup -- -Action Start
npm run bridge:startup -- -Action Uninstall
```

Stop requests a clean shutdown of this supervisor's child. It does not kill
other Codex tasks. Uninstall removes only this startup task and preserves the
private connection, messages, and task links. Install/Start can resume operation.
Do not start a foreground helper at the same time as automatic operation.

To replace a connection or link another conversation, Stop first, use
`bridge:connect` with `--setup-only`, then Start. Use the same `--state-dir` for
all Node commands and `-StateDirectory` for startup commands when customizing it.

Settings never receives the computer's workspace paths or Codex login. The
private helper key and local history remain in the ignored `.bridge-state/helper`
folder. Keep this project folder in place while its startup task is installed.
If Node or Codex moves after an update, run Install again to refresh its paths.

## Release and rollback

Apply `helper-queue.sql`, `helper-inactivity.sql`, `helper-ui.sql`, then
`helper-cutover.sql` together before publishing the website. All four preserve
existing board history; no account is paired merely by applying migrations.
Check the authenticated Settings and helper routes on the deployed domain before
pairing. Pause legacy schedules first; do not resume them after pairing.

If the release must be rolled back, stop the helper and keep the handoff guard
in place until pending results and old delivery cursors have been reviewed.
Revoking a helper key deliberately does not return ownership to the old loop.
A Vercel deployment rollback alone cannot undo a database ownership handoff.

The offline suite covers dormant startup, duplicate ownership, stale Stop
requests, crash restart, and graceful shutdown of the real idle helper. Level 6
records the real five-minute idle and Codex interruption checks. Live release
verification is recorded privately under `.bridge-state/level7-*`.
