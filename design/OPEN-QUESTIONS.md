# Open questions

The one list of everything still open in Lumia: reviews left, things built but not tested, parked work, temporary code and questions waiting on a decision. One line per item, with a pointer to where the details live. Update it when an item opens or closes, not only at a doc pass; move closed items to the bottom with their date.

Started 2026-11-25 (before that, open items were spread over STYLEGUIDE › Open, the area docs, DEV-QUESTIONS.md and Claude's memory).

## Page reviews left

Every screen, modal and page Jasper hasn't reviewed yet (inventory 2026-11-25). Reviewed so far: the browser extension's popup, status toast and Region picker (2026-11-26, in previews; see Built, not tested), the Google Drive browser pages and picker page (2026-11-26), the sticker sidebar (2026-11-26), Settings › Wallpapers (2026-11-26), Dashboard, AppBar / BottomBar, Settings, both editors (with the Background panel and History panel), toasts, the capture overlay and the recording windows, the Browser picker and PrintScreen prompt (STYLEGUIDE › Dialogs).

- **Not mounted, review when they ship**: Share dialog and the editor's workflow picker (Workflow), the Dashboard's extension setup help (removed launcher, DASHBOARD-TOP-SECTION.md).
- Drawn by the OS, text only: the menu-bar / tray menu and system notifications (their text follows STYLEGUIDE › Voice).

## Temporary code

- **Dock trace logging** (2026-11-27, kept on Jasper's decision, no fix for now): `[dock-trace]` lines in main.log (`~/Library/Logs/lumia/main.log`) for everything that can move the Dock or the app's activation on macOS: `hideDock` / `showDock` with their state, `app.dock.show()` resolving, every `app.focus` steal with its reason, the app becoming active / resigning, the main window showing / hiding, `restoreFromOverlayCancel`, focus handed back and to which app, the tray's policy switch, the two helper spawns (`electron/dock-trace.ts` and its calls in `index.ts`, `tray.ts`, `capture.ts`, `annotation.ts`, `mac-screen-snap.ts`, `mac-window-pick.ts`). Remove when the cause is settled. Why: the auto-hidden Dock slid up and stayed up (Jasper, 2026-11-27, and before).
  - **When the Dock sticks again**: note the time, then read the `[dock-trace]` lines just before it in main.log. A `showDock -> app.dock.show()` line right before points at the suspect below; none points elsewhere.
  - **Found so far**: with Open Lumia on "After a capture" a finished recording hides the Dock icon (`restoreFromOverlayCancel` → `hideDock`), and the next window show brings it back through `app.dock.show()` while Lumia is active. Electron then activates the Dock itself for a moment, its workaround for a macOS bug. In three test runs the calls fired every time and the Dock became the front app for a moment, but it did not slide up. So the path exists and is not shown to be the cause; a guess is a race in which the Dock stays the active app.
  - **Fix options, for later**: (1) bring the icon back before Lumia becomes active, not in the window's `show` handler: Electron only activates the Dock when the app is already active. To check then: Lumia's menu bar shows and its menus open after the window comes back. (2) Don't hide the icon when the window is only kept away after a capture or recording; hide it only for an explicit close to the menu bar and a start at login. That changes what shows: the Dock icon stays while the window is away, and close-and-reopen still goes through `app.dock.show()`.




## Built, not tested

- **Extension release** (2026-11-27): everything reviewed in Arc (popup, live status, theme sync, full-page capture, Region picker, toolbar icon). Left: a dev pushes `ext-v1.6.0` or above (extension/PUBLISHING.md; the tag sets the store version; `manifest.json`'s baseline is 1.6.0 since 2026-11-27, because the app counts an extension older than its shipped copy as outdated and this one answers `focus` and takes `theme`). The new `storage` permission and the web-accessible fonts go through store review. The app's `kind-image` role ships with the next app release; older apps still work (the extension falls back to the app's value).

- **Google Drive connect flow** (2026-11-26): the restyled browser pages (`electron/browser-page.ts`, `resources/picker.html`) and the new toasts only seen in a standalone preview and through `localhost:42813/?error=…`. The dev build has no `.env`, so Settings hides Uploads there; needs the four `MAIN_VITE_GDRIVE_*` values to run for real.
- **Restore from cloud**: never run in the app (since 2026-11-27 the copy is streamed to disk, `electron/stream-to-file.ts`, unit-tested against a local server; Download the same). Needs an uploaded file deleted from `~/Pictures/Lumia`, then a click on it in the Dashboard (Google Drive, since the dev build has no R2 credentials).
- **Video editor: saved filmstrip and playhead drag** (2026-11-27; unit tests, both type-checks and the build pass; the strip code was run outside the app on real recordings: decode, paint, and tiles sampled across a pause; main and preload changed, so it needs a `pnpm dev` restart). Not seen in the app yet:
  - **A new recording** brings its strip along (`RecorderHost.tsx` samples a tile of the drawn frame while recording, `TileSampler` in `src/lib/filmstrip.ts`): record a few seconds with a pause in the middle, the editor opens with the strip already there, and the tiles match the picture when the playhead is dragged over them. Checked by Jasper on 2026-11-27: three recordings from 19:16 and 19:17 got their strip from the recorder (written in the second the recording was saved) and the tiles match the picture; pause / resume confirmed too.
  - **Preview and strip versions on the row** (final review, 2026-11-27): the `&v=` in their addresses is `thumbnailStamp` / `stripStamp`, put on the row when it's saved after the file was written (`electron/row-stamps.ts`, `HistoryStore`); whether a row has one is read from the row. Reading a day stats neither any more. Check in the app: an edited image's card shows the new picture (same file name, new stamp); a strip file deleted in Finder comes back when its clip is opened (`history:fileGone`, rebuilt by the editor). (A deleted thumbnail coming back, for an image and for a recording: confirmed by Jasper, 2026-11-27.) Rows from before have no stamp and use `v=0` until their file is next written.
  - **The recorder's clock** is now one helper (`RecordedClock` in `src/lib/filmstrip.ts`, unit-tested with a pause): the recording's length, the toolbar's timer and the tiles' times read it (final review, 2026-11-27). Pause and resume in a real recording confirmed by Jasper (the toolbar's timer stops, the saved length is right).
  - **A recording whose remux failed** (no length in its header) still gets a strip: the length the editor or the row knows, else a seek past the end (run outside the app on a raw MediaRecorder file). Not seen in the app.
  - **Older recordings**: built one at a time in the background by the main window (`src/lib/strip-jobs.ts` for the order, `strip-worker.ts`; `filmstrip:save`, files `thumbnails/<id>-strip.webp`, WebP at 0.2 (Jasper's pick), about 15 KB each, 0.74 MB for 44 recordings). One opened before its turn shows an empty track for up to about a second, then the whole strip in one paint; every later open has it at once.
  - **Order of the background work** (Jasper, 2026-11-27): card previews before any strip, the clips on screen first in each, picked anew before every job; a preview that turns up interrupts a strip in the works; the video editor's own strip build stops the background work until it's done. Run outside the app on the 44 recordings (15 previews in 0.9 s, all before the first strip; nothing saved while the editor built). Not seen in the app.
  - **Recordings without a card preview** get one from the same background work (2026-11-27): rows a folder scan added (`scanForNewFiles` makes previews for images only; 15 in the dev profile, 17 to 20 Nov), a failed frame grab at save, a thumbnail file that's gone. The frame grab was run outside the app on those 15 (all fine); the cards filling in after a restart is not seen yet.
  - **Playhead drag**: the playhead stays under the pointer (`onVideoTime` in `Editor.tsx` no longer takes the time of a seek that's still on its way). Also check: playback moves it, ←/→ step it, a trim-handle drag leaves it and returns the picture to it.
  - **Tiles of a still screen look alike** (bug fixed the same day: some tiles had crisp bright text, others grey, because Chromium shrank a frame 18x in one of two ways; every tile now goes down in steps of at most 2x, `halvingSteps`). Checked outside the app only; the strips made before the fix were deleted and are built again.
  - **Resizing the window** repaints the strip at every width (no 250ms wait, no stretched tiles).
  - **Windows**, and after **Restore from cloud** the strip is dropped and built again.
- **The + cursor after opening Lumia** (2026-11-27; renderer only, but the parked overlays keep their old state until the dev app restarts): a pooled capture overlay that was never opened since launch asked for the crosshair, and it showed over everything once Lumia became the active app (Jasper: opening the window on the second screen was enough). The overlay page now starts inactive (`Overlay.tsx`, `isActive`); every reveal sends it its state before it shows. To check after a restart: Open Lumia on either display shows the arrow; frame, dim and cursor are right from the first frame on both displays for a region capture, a window capture and a recording (the first one after launch is the one that changed).
- **Dashboard keeps its place** (2026-11-27; renderer only): back from the editor or Settings it used to be at the top. Now the clip that was opened (else the one nearest the middle) is back at the same height in the first frame; the days it had loaded are kept in memory meanwhile and reloaded on return (`src/lib/dashboard-place.ts`, `PlaceAnchor` in `utils/dayHistory.ts`, `DaySections.tsx`, `useDayHistory.ts`). Run outside the app with the real components on a made-up history (grid, list, slow loads, Settings, the opened clip deleted). Not seen in the app: grid and list, Settings and back, after closing the window from the editor (it keeps the place too), and after a new capture or recording opened the editor (also from its notification): Back then starts at the top, where the new clip is (`dashboardStartsAtTop`, called in `App.tsx` when main sends the window to the editor).
- **App icon** from `logo.svg` (2026-11-24): not checked in a packaged build (`pnpm build:mac` or the next CI release).
- **Windows**: the mirrored 53px app bar and everything from the 2026-11-24 capture review; from 2026-11-27: wallpaper on some screens (PowerShell, IDesktopWallpaper) and Reset, Save to (a folder on another drive, moving files), Ctrl+click to show a file in Explorer, the Ctrl-held file tooltip and hand, the scroll hotkey with a browser in front. Checked by a colleague after the PR is merged; list the checks in the PR (STYLEGUIDE › Open › Windows).

- **Code review fixes** (2026-11-27, 27 findings; type-checks, unit tests and the build pass). Still untested (Jasper, 2026-11-27: not testable by him now, except the sign-in, which waits for the release); main-process changes need a `pnpm dev` restart:
  - **Google sign-in**: now with a `state` check and PKCE (`gdrive:startAuth`). To test after the release (Jasper): it needs the four `MAIN_VITE_GDRIVE_*` values, which only a release build has. Connect Google Drive in Settings › Uploads, then choose a folder from the Connected page. If Google refuses the sign-in, the PKCE parameters are the first thing to look at.
  - **Built pages' Content-Security-Policy** (`electron.vite.config.ts`): checked in headless Chrome on the built pages (scripts, styles, fonts load, nothing refused). Not seen in a packaged app with real thumbnails, videos (`lumia-media:`), stickers and wallpaper photos (`https:`): in a packaged build (`pnpm build:mac` or the next release) open the Dashboard, a recording in the editor, the sticker sidebar and Settings › Wallpapers; anything blocked shows as a missing picture and as a "Content Security Policy" line in the log (Settings › About › Show logs).
  - **Frame step by the recording's own rate** (2026-11-27, `shared/recording.ts`, `HistoryItem.fps`): new recordings save the rate they were made at and ←/→ in the video editor step one frame of it; older ones get the rate their file's header names (60 for recordings from before 2026-11-18), else 30, filled in the background when their day is first shown. Steps follow the recorded rate, not each real frame: recordings have uneven gaps between frames, and the shipped ffmpeg can't list frame times. To see: after a `pnpm dev` restart, record something moving, then press → a few times: every press shows a new picture.
  - **First open after the update with a large history**: fingerprints are saved with one write per day (measured outside the app: 1000 rows 8.4 s before, 0.15 s now).
  - **Release CI**: the new `checks` job (tests + both type-checks) runs for the first time with the next tag.
  - **Windows**: the save folder's case rule (`C:\Shots` = `c:\shots`), deleting a part-written recording while its handle closes.

## Parked

- **Extension origin isn't pinned** (code review, 2026-11-27): the bridge takes any `chrome-extension://` / `moz-extension://` / `safari-web-extension://` origin, so another installed extension could connect and push a capture into history. Left: pinning needs the store item's id (not in the repo) and a fixed id for the unpacked copy (a `key` in `manifest.json`, which changes the id of everyone's loaded copy and must not go into the store upload), and Firefox ids are random per install. Decide with the dev who publishes it.
- **Left from the code review** (2026-11-27): `AppSettings` is still declared three times (`electron/settings.ts`, `src/electron.d.ts`, `Settings.tsx`'s own subset); `workflow.ts` still makes ids with the `uuid` package while the rest uses `crypto.randomUUID` (dropping the package means a lockfile change); the wallpaper search and the photo download keep their own request loops (they share the user agent and the timeout now). `Canvas.tsx`, `ToolBar.tsx`, the rest of Settings / Wallpapers UI, the smaller editor panels and the body of `extension/background.js` were scanned (unused code, IPC match, listener and timer clean-up, unsafe DOM), not read line by line.

- **Files added to the save folder from outside Lumia** (Jasper, 2026-11-27): show them in the Dashboard too (any image or video put there in Finder, not only Lumia-named ones), on a folder switch and while watching the folder. Today `scanForNewFiles` (`folder-history.ts`) only adds `capture-…` / `recording-…` files. Part of it: files dragged in from an earlier save folder in Finder (after "Keep there"): when the watcher sees a new file, look its fingerprint up in the earlier folders' histories (`fileKey`, `file-relink.ts`) and move that row into the current history, so it keeps its uploads, edits and trim. (Checked 2026-11-27: the first move took only files with a history row, 45 into ~/Pictures/Test Lumia; the 50 other files and 31 Lumia files without a row stayed in ~/Pictures/Lumia.)
- **Show clicks and keypresses in recordings** (Jasper, 2026-11-27): draw a mark where the mouse clicks and show the keys pressed, as options for recordings (a hidden cursor was offered and declined).

- **Video trim**: keyframes every 0.25s (measure the size first) and an exact cut via WebCodecs (VIDEO-EDITOR.md › Todo).
- **Renaming files**: after the design pass, in the review of how capturing and saving work. The list view's name column then sizes from the longest name.
- **Custom theme follow-ups** (5 small ones, `.superpowers/sdd/CUSTOM-THEMES-PLAN/progress.md`):
  - the status-colour contrast test checks one hue only;
  - the drift test misses new roles and reads only the first `html.light` block;
  - near-grey accents keep a stray hue;
  - a stale comment near Appearance;
  - the darkest dark base makes the content, background and canvas fills almost black.
- **Background panel** isn't remembered per image (resets when the editor closes).
- **Full-screen apps**: capture and recording over another app's full-screen Space not supported (STYLEGUIDE › Capture and recording).
- **Window corner radius**: set by eye for macOS 27 (21.1px); read it at runtime if other versions look off.
- **Dashboard launcher removed** (DASHBOARD-TOP-SECTION.md): the extension setup help has no other UI ("Include Lumia's own window" is Settings › General › Show Lumia window since 2026-11-27).
- **Workflow**: unreleased and unlinked, low priority until it ships; its copy and engine gaps wait (STYLEGUIDE › Open › Workflow).

## Questions for Jasper




## Questions for the devs

None open. Details and decisions in DEV-QUESTIONS.md.

## Closed

- 2026-11-27: **Capture bars line up with the menu bar**, checked by Jasper in the app: the recording toolbar's window no longer kept under the menu bar (`enableLargerThanScreen`, it sat 4px under the overlay's bar), and both bars start at the menu bar's bottom edge (`captureBarTop`, 30px on his displays, 32px where there's no menu bar on top). Left open, not decided: a macOS menu bar set to hide itself (bars stay at 32) and Windows (32).
- 2026-11-27: **Overlay cursor turned into the arrow on two displays** (was Parked since 2026-11-26, the installed 2.6.5 too): fixed by the overlay page starting inactive (`Overlay.tsx` `isActive` false). A pooled overlay never opened since launch kept its first state, "active", and with it a cursor request of its own, so with two displays the overlay of the other screen competed for the cursor. Found through a different symptom the same day (a + over everything after Open Lumia from the menu bar); Jasper then saw the two-display case fixed too: a recording started from the menu bar of the screen without Lumia's window keeps its cursor. The debug tools in `out/debug/` are no longer needed.
- 2026-11-27: **A capture or recording that fails** ("Couldn't capture image" / "Couldn't start recording" with the reason, the window back by the Open Lumia rule; code review fix): not tested, accepted by Jasper.

- 2026-11-27: **A cancelled or failed recording save** deletes its part-written file (code review fix): not tested, accepted by Jasper.

- 2026-11-27: **Copy on a recording (macOS)** with the path handed to `osascript` as an argument (code review fix): tested in the app, works (Jasper).

- 2026-11-27: **Design audit of the app and the extension against the guide**, fixed (Jasper's rules in STYLEGUIDE › Buttons and controls): delete buttons grey at rest and plain `danger-text` under the pointer (red at rest on all of them tried and dropped the same day), except three that are red at rest: Select's trash with its badge, the armed "Confirm disconnect", the trash on a selected shape; Pin is a framed button with the on-state strip and one icon; one swatch definition (1.5px ring, `gap-1.5` row, `src/lib/swatch.ts`); single-select grids `gap-3` / `gap-2` (the Background panel's Alignment isn't one: it stays a folded segmented track); a `kind-video-hover` role for the recording's Stop, the accent's own hover step; one stacking scale (dialogs 60 / 70, toasts 80, callouts 100); the grid card on `toolbar` / `content` (the last mounted use of the old fills). Shared pieces in place of hand copies: `OnStrip`, `MessageBox`, `ICON_BUTTON_FRAME` / `ICON_LINK` / `DANGER_*` / `BARE_ICON_BUTTON`. Role values have one source with tests on the copies (`tests/extension-roles.test.ts`); the default annotation red is one constant (`shared/annotation.ts`). "Countdown" became "Count down before recording"; refused-hotkey lines stay red. Seven unused classes deleted from `index.css`. STYLEGUIDE gained the rules that were missing; ICON-BUTTONS.md and COLOR-ROLES.md match the code again. Not looked at in the running app: type-check and unit tests only.

- 2026-11-27: **Third review, of the second review's fixes**, fixed: a file that's there is never Missing (only "no such file" counts as gone; a drive without file ids or a transient error made it Missing, and Clear could drop it); Windows wallpaper scripts write UTF-8 (PowerShell and `reg` used the old console code page, so a path with an ü broke Reset), the registry fallback reads through PowerShell; the folder move reserves its new names for the whole run, doesn't count a row already in the new history as moved, and takes a half-written row out before moving files back. Left: edited / trimmed copies have no creation-time guard (made later than the capture), a same-instant name clash during a move.

- 2026-11-27: **Open Lumia after capturing or recording** (Jasper's five options; replaced the Open editor dropdown and then the row per kind the same day): whether Lumia's window comes back after the overlay. When it was open before (default: open before → back whatever happened; closed before → stays away), After a capture or recording / After a capture / After a recording (only after a success of that kind, open before or not; a cancel keeps it away), Never. After a success it comes back with the editor; kept away, it counts as closed to the menu bar. Checked in the app (Jasper).

- 2026-11-27: **Sticker "Thumbsup"** stays (Jasper): renamed to "Thumbs up", a search for "thumbsup" wouldn't find it.

- 2026-11-27: **Second code review of the work since the push** (two reviewers, files / history and wallpapers / UI / extension), fixed: PowerShell unrolling a single picked screen (Windows, one screen of several failed); Windows Reset now puts each monitor's own wallpaper back (`monitors` in `wallpaperBefore`, IDesktopWallpaper GetWallpaper / SetWallpaper) instead of one picture on all; picked screens all unplugged no longer set every screen; a late countdown start can't restart a cancelled recording; the screen picker can't hang blank; a tip on a removed clip hides; the folder move never rolls files back once the new row is stored; Follow renames ignores file id 0 (exFAT) and files made long after the capture (a reused file id); stored save folders pass the suitability check again in `isAllowedPath` (a hand-edited settings file can't open the disk); Clear missing skips files whose folder is gone (an unplugged drive) and no longer deletes a missing row's edited / trimmed copy (`forgetMissing`); one folder watcher at a time; the unused `record:save` takes a file name only. Left as is: scan thumbnails on the main process (yields every 20 files), a fresh folder read per pass when something is missing, a same-second name clash during a move.

- 2026-11-27: **Delete old files** stays per save folder (Jasper): it clears the current folder's history and files; earlier folders' files are left alone. **Open editor**: no rename; it decides by whether Lumia's window was open, wherever the capture started. The overlay frame's colour follow-up was stale: the frame is in the clip type colours (`kind-image` / `kind-video`) since 2026-11-24, not `accent-text-hover`.

- 2026-11-27: **Remember every tool** (a dev: not remembering Screen was a bug): New capture / PrintScreen replay the last tool picked, Region, Window, Screen, All screens or Scroll for images, Region, Window or Screen for recordings (`isImageMode` / `isVideoMode`, `settings.ts`); Scroll replays like the scroll hotkey. Switching Image / Video in the overlay counts as picking that tool for the other kind. Checked in the app (Jasper).

- 2026-11-27: **Window resize cursor (macOS)**: the main window is a titled window with a hidden title bar now, not `frame: false`, so it gets macOS's resize margin. Checked (Jasper).

- 2026-11-27: **Open editor** dropdown checked (Jasper). "Always after captures" opened the editor after a recording because the window was open: by design, the setting only decides for the menu bar; the label could say so ("Open editor from the menu bar"), not asked yet.

- 2026-11-27: **Settings › General: Copy to clipboard, Countdown, Show Lumia window, Save to** checked in the app (Jasper), including a recording stopped after a folder switch (its file lands in the new folder: the file is written when the recording stops). Save to on another drive and Windows left (Windows item).

- 2026-11-27: **Follow renames** (`electron/file-relink.ts`): checked in the app (Jasper): renamed images, recordings and trimmed copies stay linked. Same drive only.

- 2026-11-27: **Set as wallpaper with a Wikimedia / Wallhaven photo** (`design/WALLPAPER-SOURCES.md`): run by hand on macOS (Jasper), with the screen picker and Reset.

- 2026-11-27: **Wallpaper on some screens, and Reset** (`electron/wallpapers.ts`; were Parked › Undo wallpaper change and Wallpaper per screen), checked on macOS (Jasper): after Set as wallpaper with more than one screen, the screen picker (a card per screen with a live picture of it, picked in the accent selection ring, last pick remembered); macOS sets per screen through NSWorkspace (osascript JavaScript, NSScreenNumber = Electron's display id), keeping each screen's scaling; Reset puts back the wallpaper from before Lumia's first change (`wallpaperBefore`). Left: Windows (see Windows above): some screens through IDesktopWallpaper / PowerShell with mixed scaling, and Reset (one picture for all screens). An Aerial or dynamic wallpaper may not come back on macOS.

- 2026-11-27: **"Capture" covers images only** (Jasper): the menu bar's "New Capture" is "New capture" / "New recording" by the last kind (`tray.ts`); Settings' "Capture with PrintScreen" is "Use PrintScreen" and the Windows first-launch dialog "Use PrintScreen?". No shared verb for both.

- 2026-11-27: **Scroll hotkey goes by the app in front** (Jasper): Settings › General › Capture scroll with is gone. Ctrl+Shift+5 and the menu-bar item ask each connected browser whether its window is in front (`focus` / `focus-result`, `focusedExtensionClient` in `extension-bridge.ts`, 250ms; older extensions don't answer and get the screen scroll); a browser in front captures through the extension, anything else gets the screen scroll overlay. Checked in Arc (Jasper).

- 2026-11-27: **Allow site access in Arc**: Arc's popup can't show the permission prompt ("Could not find an active window"), so the popup opens itself in a tab (`popup.html?tab`: header and the Allow message only) and asks from there; the tab closes once allowed. Checked in Arc (Jasper).

- 2026-11-27: **Checked by Jasper:** no Dashboard flash before the editor, the editor's red button closes to the menu bar, Always open editor (off / on), menu-bar actions with Stop recording, the 12pt watermark (images and recordings). Left: a code review of the uncommitted diff before committing; the watermark in a packaged build (new `resources/watermark` extraResource).

- 2026-11-27: **Watermark on images again** (Jasper), after a day off.

- 2026-11-27: **"Second app page" after a recording**: there was only one window; the editor's red button took it back to the Dashboard and kept it open. The red button now closes the window on every page (resets to the Dashboard, then hides); `surfacedFromTray` / `fromTray` (the editor-close exception) removed. Found with temporary `[win-trace]` logging, removed.

- 2026-11-27: **Region picker** redone as a path bar (`design/REGION-PICKER.md`), tried on real pages and kept: breadcrumb with "…" folds at both ends, key hints (`Out / in`, `Previous / next`), same-size parts merged, empty layers and `pointer-events: none` skipped, the parts at the level outlined at 20%, "2 of 5". A sticky level was tried and dropped. Toolbar icon checked (Jasper). Doc pass done (STYLEGUIDE › Browser extension, Callouts, Tooltips, Colour swatches; CLAUDE.md).

- 2026-11-27: **Dashboard needed Cmd+R** to show files changed outside Lumia (Missing state, missing count): Lumia watches `~/Pictures/Lumia` and sends `history:changed` without days on any change (300ms bundle), so loaded days and the count reload (`watchCaptureFolder` in `electron/index.ts`). Checked (Jasper).

- 2026-11-26: **Extension name** stays "Lumia Scroll Capture" (Jasper, after asking the dev), although it also captures the visible area and part of a page.

- 2026-11-26: **Extension status live**, checked in Arc (Jasper): Lumia drops the browsers on quit (`before-quit` in `extension-bridge.ts`; ws 8's `server.close()` left them open until the process exited); the service worker looks for Lumia every 2 s while disconnected (the 30 s alarm alone made a started Lumia wait up to 30 s; 1 s measured ~0.5% of one core); an open popup follows the connection and the theme (`lumia-status`). After changing the extension, reload it in `arc://extensions`, or Arc keeps the old code.

- 2026-11-26: **One swatch look** (Jasper: all swatches the same, always): `src/lib/swatch.ts` (`swatchClass`, `swatchFill`) used by the image toolbar, the Background panel, the recording toolbar's drawing row and Settings › Appearance; the colour inside the border, `elevated` under the edge. The selection ring's offset now matches its ground (the toolbar's callouts and the Background panel's gradient stops had the wrong one).
- 2026-11-26: **Esc in the sticker search** closes the floating sidebar at once (Jasper; already so).
- 2026-11-26: **Callouts and tooltips use an inset ring edge** (`ring-1 ring-inset`, padding from the outer edge): Upload menu, Background panel (an overlay ring over its full-width band), the image toolbar's callouts, Settings' Custom picker, tooltips, the trim bar's time bubbles, the extension's Region picker panel. `CalloutArrow` lost `inBox`. Settings' Custom picker now sits 12px from the swatch's selection ring (it was 12px from the swatch, 9px from the ring).
- 2026-11-26: **Extension popup messages**: under the header like the app's toasts under its bar (below the rows before), 10px from the popup's sides, 6px above the rows; the title on one line, the reason may wrap. "Allow site access" / "For Lumia's hotkey and tab previews" (the title was "Allow captures from Lumia", which wrapped). Shown only while Lumia is connected (the extension can't see installed apps), under the rows (at the top it read as a blocker). The rows' text in `fg` (the menu's `fg-secondary` read as disabled); the header "Lumia Scroll Capture" ("Scroll Capture" in `fg-secondary`, a try), the connection a bare check.

- 2026-11-26: **Browser extension review** done in previews: popup as a Lumia menu, the status pill as a wait toast with Stop and save, the Region picker as a callout with a framed d-pad, copy rewritten, the app's theme synced over the connection, Manrope bundled, icons from `logo.svg` (`pnpm icons`), manifest description without em dash or "screenshots".
- 2026-11-26: **Watermark off for images** (Jasper); recordings still carry it.
- 2026-11-26: **Image doesn't remember Screen** confirmed as a rule (Jasper): only Region / Window are replayed (`isRememberedMode`).
- 2026-11-26: **Google Drive browser pages** reviewed: the OAuth result pages and `picker.html` drawn as a Lumia dialog (`electron/browser-page.ts`, app theme, Manrope), copy rewritten; Drive failures in Settings are toasts (the red line printed Google's raw `access_denied`); Settings › Uploads and every Drive flow hidden / refused in builds without the four `MAIN_VITE_GDRIVE_*` values. Dialog message boxes (PrintScreen prompt, Browser picker) centre their icon like toasts. `LUMIA_SIM_GDRIVE` sim removed.
- 2026-11-26: **Settings › Appearance › Custom colour picker**: now a callout like the rest (`CalloutArrow` on the Custom swatch, 12px gap, closes on a window resize).
- 2026-11-26: **`KEEP_TOOLBAR_SHOWN`** (image toolbar auto-hide off while checking the collapse steps) removed; the toolbar fades again.
- 2026-11-26: **Sticker panel review** done: Sticker became a toggle button (not a tool) opening a sidebar that mirrors History at the left, pointer-driven sticker drag with a ghost, smaller stickers; also the toolbar's new collapse order (Size → Palette → % → ⋯ → Tools), callouts 12px off with the shared inset triangle (`CalloutArrow.tsx`), callouts and tooltips close on resize, the Layers grip, sticker thumbnails, the Background icon (IMAGE-EDITOR.md, STYLEGUIDE).

- 2026-11-26: **Wallpapers review** done (design/WALLPAPER-SOURCES.md › After the build; STYLEGUIDE › Settings). Doc pass for the wallpaper work done (CLAUDE.md, STYLEGUIDE).

- 2026-11-26: **Wallpapers dry run** removed: Set as wallpaper really sets it in dev builds too (Jasper).

- 2026-11-25: **Wallpapers icon-only categories** tried and dropped: the band keeps icon + name.

- 2026-11-25: **Wallhaven credit** when the uploader lookup fails: "Uploaded to Wallhaven" (Jasper). Coast leaves out coast guard, Landscapes leave out cities (Wallhaven).

- 2026-11-25: **Unsplash removed**: the sources are Wikimedia Commons (default) and Wallhaven, no keys (`design/WALLPAPER-SOURCES.md`).
- 2026-11-25: **Unsplash key in releases**: not added; Wikimedia Commons is the fallback source (no key, no sign-up).

- 2026-11-25: **Retention deletes uploaded captures**: the devs keep the current behaviour (DEV-QUESTIONS.md).
- 2026-11-25: **Updates wait for the user**: the devs are fine with it, no stronger prompt (DEV-QUESTIONS.md).
- 2026-11-25: **Browser picker and PrintScreen prompt** reviewed (STYLEGUIDE › Dialogs); Settings › Review for them removed.
- 2026-11-25: **Extension captures in Arc** cancelled mid-capture: fixed (`socket-peer-app.ts`).
- 2026-11-25: **Scroll hotkey** Ctrl+Shift+5 back, with Settings › General › Capture scroll with.
- Before 2026-11-25: **tertiary colour** split up (`--color-tertiary` gone, video uses `kind-video`, errors `danger`); canvas selection colours read the roles; the custom colour input replaced by `ColorPicker`; cursor fixes outside Wallpapers done.
