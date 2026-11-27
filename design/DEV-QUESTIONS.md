# Questions for the devs

Behaviour questions that came up in the design pass. Each needs a decision from the devs before the code changes. Open ones are also listed in OPEN-QUESTIONS.md.

## Retention deletes uploaded captures from history (2026-11-22)

**Decided 2026-11-25:** keep the current behaviour (the devs agree).

**Now:** Settings › General › "Delete old captures" (`historyRetentionDays`) runs `HistoryStore.pruneOlderThan` on boot, hourly and on change. It removes every row older than the cutoff and deletes its original and edited files in `~/Pictures/Lumia`. Uploaded captures are no exception. The copy on R2 / Drive stays, but its row was the app's only link to it, so the upload is lost to the user.

**Why it looks wrong:** "Clear missing files" (`history:cleanupMissing`) never removes a cloud-only row, for exactly that reason: the row holds the only link back to the upload. Retention ignores that rule.

**Option:** for uploaded captures, retention deletes the local files but keeps the row, which then shows as cloud only (Missing + Uploaded, restore on click), like a capture whose file went missing.

**Copy today** matches the current behaviour: "Deletes files in Pictures/Lumia and clears history. Uploads stay online." Change it if the behaviour changes.

## Updates now wait for the user (2026-11-22, changed in code)

**Decided 2026-11-25:** the devs are fine with it; no stronger prompt for now.

**Was:** `autoDownload = true` and `autoInstallOnAppQuit = true`. Every check (launch, every 4h, Check now) downloaded a new version, which installed on the next quit, or 30s after the window went to the tray (`scheduleAutoInstall`).

**Now (Jasper's call: checking is not consent to install):** a check only finds a version. Settings › About shows "Version 2.6.5 · Version 2.7.0 is available" with **Update** (downloads, new IPC `update:download`), then **Restart** (installs). No install on quit. The old silent path is kept as an opt-in, Settings › About › "Auto-update Lumia" (`autoUpdateWhenHidden`, default off): auto-download plus the 30s hidden-window install.

**For the devs:** users who never open Settings now stay on old versions. Should there be a stronger prompt for urgent fixes (a notification, or a minimum version)?
