# Lumia 3.0.0 release notes (draft)

For the maintainer who cuts the release. Two parts: the changelog for the release commit's body (the GitHub release page is built from it, CLAUDE.md › Releases) and the `src/whats-new.ts` entry (Settings › Release notes), written to the rules at the top of that file. The entry is already in `src/whats-new.ts` (with one for 2.6.6, which had none); the release commit only sets its `date` to the release day.

Items still untested are left out on purpose: Restore from cloud, the new Google sign-in and the Windows-specific changes (design/OPEN-QUESTIONS.md › Built, not tested). Add them once checked.

## 1. Changelog (release commit body)

```
Release version 3.0.0

A new look for the whole app, plus a reworked Dashboard, editors,
capture and recording.

New
- New design: one colour system for light and dark, a new logo and app
  icon, Manrope and new icons everywhere.
- Custom themes: pick your own accent and light and dark bases
  (Settings > Appearance).
- Save to: choose where images and videos are saved, with one history
  per folder and an offer to move your files (Settings > General).
- Image editor: Highlighter, Layers and Edits in a History panel,
  Background for sharing, a sticker sidebar, a colour picker with an
  eyedropper, and changeable editor keys.
- Video editor: a floating trim bar with a filmstrip that shows at
  once, a playhead that follows the pointer, and frame steps at the
  video's own rate.
- Scroll capture is back on Ctrl+Shift+5 and in the capture overlay;
  with a browser in front it goes through the extension.
- Desktop wallpapers from Wikimedia Commons or Wallhaven, on all or
  chosen screens, with Reset (Settings > Wallpapers).
- Release notes in the app (Settings > Release notes).
- Delete in the editors' top bar.

Improved
- Dashboard: filters in the top bar, the source of each file, drag to
  select, Shift-click ranges, Cmd+A back for all of history, Delete key,
  and Cmd+click to show a file in Finder / Explorer.
- The Dashboard keeps your place when you come back from the editor or
  Settings.
- Files renamed or deleted in Finder / Explorer show up right away.
- Capture overlay and recording toolbar redesigned, in your theme, lined
  up with the menu bar.
- Every capture and recording tool is remembered for New capture and
  PrintScreen.
- Countdown before recording: Off, 3 or 5 seconds, and Esc cancels it.
- Drawing while recording works like the image editor, with Text and
  Redo.
- One Upload button with a menu for each destination.
- Updates download only when you choose Update; Auto-update Lumia does
  it in the background.
- New watermark: small, the same size on every capture.
- Browser extension 1.6.0: restyled, follows the app's theme, and a
  redesigned picker for part of a page.

Fixed
- The capture cursor no longer turns into an arrow on two displays.
- A crosshair no longer shows over other apps after opening Lumia.
- A failed capture or recording now says why and brings the window back.
- Cancelled or failed recordings no longer leave a part-written file.

Moved
- Captures start from the hotkeys, the menu-bar icon or PrintScreen;
  the capture tiles on the Dashboard are gone.
- Check for updates and About are in Settings > About.
```

## 2. `src/whats-new.ts` entry

Already at the top of `RELEASES` in `src/whats-new.ts`; kept here for reference. One change per point, titles led by an action word, no em dashes, notes ordered new, improved, fix (as for every release since 2026-11-27).

```ts
  {
    version: '3.0.0',
    date: 'YYYY-MM-DD',
    notes: [
      {
        title: 'Meet the new Lumia',
        points: [
          'A new look in light and dark',
          'A new logo and app icon',
          'A top bar on every screen in place of the sidebar',
          'Messages show inside the app while it is open',
        ],
      },
      {
        title: 'Make the theme your own',
        text: 'Pick an accent and a light and dark base in Settings › Appearance.',
      },
      {
        title: 'Choose where files are saved',
        points: [
          'Pick any folder in Settings › General › Save to',
          'Each folder keeps its own history',
          'Move your files over when you switch',
        ],
      },
      {
        title: 'Do more in the image editor',
        points: [
          'Highlighter',
          'Layers: reorder, hide and select shapes',
          'Edits: jump back to any step',
          'Background: put your image on a gradient or colour',
          'Stickers in a sidebar with search',
          'A colour picker with an eyedropper',
          'Change every editor key in Settings › Hotkeys',
        ],
      },
      {
        title: 'Capture scrolling pages again',
        text: 'Press Ctrl+Shift+5 or pick Scroll in the capture overlay; in a browser it goes through the extension.',
      },
      {
        title: 'Change your desktop wallpaper',
        text: 'Photos from Wikimedia Commons or Wallhaven, on all screens or the ones you pick, in Settings › Wallpapers.',
      },
      {
        kind: 'improve',
        title: 'Find files faster in the Dashboard',
        points: [
          'The Images or Videos filter is remembered',
          'See which app each file came from',
          'Drag to select, Shift-click a range',
          'Cmd+A is back and selects all of history',
          'Cmd+click to show a file in Finder or Explorer',
          'Come back to where you were after the editor or Settings',
          'Changes made in Finder or Explorer show up right away',
        ],
      },
      {
        kind: 'improve',
        title: 'Trim videos with a new trim bar',
        points: [
          'The filmstrip shows at once',
          'The playhead follows your pointer',
          'Arrow keys step one frame at the rate the video was recorded at',
        ],
      },
      {
        kind: 'improve',
        title: 'Capture and record with a cleaner overlay',
        points: [
          'One bar for Image or Video and every mode',
          'In your theme, lined up with the menu bar',
          'Every tool is remembered for New capture and PrintScreen',
          'Count down 3 or 5 seconds, or not at all; Esc cancels',
          'Draw while recording like in the image editor, with Text and Redo',
        ],
      },
      {
        kind: 'improve',
        title: 'Update when you choose',
        text: 'Update downloads, Restart installs; turn on Auto-update Lumia to do it in the background.',
      },
      {
        kind: 'improve',
        title: 'Get a smaller watermark',
        text: 'The same small size on every image and video.',
      },
      {
        kind: 'improve',
        title: 'Use the browser extension 1.6.0',
        points: [
          'Follows the theme you picked in Lumia',
          'A redesigned picker for part of a page',
        ],
      },
      {
        kind: 'fix',
        title: 'Fixed',
        points: [
          'The capture cursor no longer turns into an arrow on two displays',
          'A crosshair no longer shows over other apps after opening Lumia',
          'A failed capture or recording says why and brings the window back',
          'Cancelled recordings no longer leave a part-written file',
        ],
      },
    ],
  },
```

Notes for the maintainer:
- A 2.6.6 entry was added too (its release commit only bumped `package.json`), from that commit's body; the removal of Cmd+A is left out since 3.0 brings it back.
- `kind` left out means a new feature (sparkle icon).
- Check the date and whether the extension store update (`ext-v1.6.0`) ships the same day before keeping the extension note.
