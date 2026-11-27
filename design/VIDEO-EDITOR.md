# Video editor design pass

Status: built and locked in (2026-11-23). Keyframes and the exact cut are a todo (below). The sections below record the
design as approved on 2026-11-22; **As built** (next) says where it ended up after the day's tries, and wins where they
differ. The image editor: `IMAGE-EDITOR.md`.

## As built (2026-11-23)

- **App bar:** the gear becomes the Back arrow to the Dashboard (the editor is a pop-over over the Dashboard; an X,
  a Back after the logo and a round X over the video were tried). The slot holds Copy · Save · Delete · Upload as icon buttons (Delete since 2026-11-27);
  Upload follows the Dashboard's rule with the Upload menu (R2 / Google Drive per destination).
- **Video:** starts muted; click plays / pauses; no native controls.
- **Trim bar floats over the video** (`absolute left-(--mx) right-(--mx) bottom-(--my)`: 10px from the sides, 20px from the bottom, the image toolbar's
  `EDGE_X` / `EDGE_Y`; `rounded-lg`, `bg-toolbar`, inset `line`
  edge, `p-2.5`) and **fades out** (300ms) after 3s without pointer moves or when playback starts; back on a move or
  pause; never while the pointer or keyboard focus is on it.
- **Layout:** play/pause and mute stacked on the left; Trim (accent, `cut`) and Reset (`restart_alt`, RotateCcw,
  as in Settings) stacked on the right; the filmstrip between (60px tall, rounded 6px, square on a side whose handle
  is within 12px of the end; an outset `ring-line-subtle` edge; no frame dividers). No row under it: the keyframe note
  and the shortcut hints went (the keys are in Settings › Hotkeys › Video editor, changeable since 2026-11-24:
  Play or pause Space, Set trim start D, Set trim end F, Step back / forward a frame ← / →, Step back / forward ten
  frames ⇧← / ⇧→; the steps were two rows, one per distance, until then; definitions in `src/lib/editor-keys.ts`).
- **Filmstrip marks:** outside the trim washed 70% black in dark / 70% white in light; a thin red (`danger`) 2px
  playhead under the purple frame; the purple frame and handles plain (shadows tried and dropped); the landing bracket
  on hover outside the selection.
- **Time bubbles** (tooltip style with a 6px triangle, QuickTime-like): the start time over a dragged start handle,
  the end time over the end handle, the landing time over the bracket, the playhead time while playing or scrubbing;
  the selection's length in the middle while a handle is dragged. 7px from their handle (they overlap the bar by 3px).
- **Dragging a handle shows its frame in the video;** the video returns to the playhead on release (and plays again
  if it was playing).

## Filmstrip and playhead (2026-11-27)

- **The strip is there when the bar is.** Each recording has a saved strip (`thumbnails/<id>-strip.webp`): 20 tiles
  of 214×120 in one row, WebP at quality 0.2 (Jasper compared 0.6 / 0.4 / 0.2 by eye; at this size 0.2 is fine),
  about 15 KB a recording. The bar paints it in one go before its first frame; no tile-by-tile sweep. It used to
  decode up to 40 frames one after another on every open (about 0.3 s at 4K, left to right).
- **Who makes it:** the recorder, while recording, so a new recording's strip exists before the editor opens. Older
  recordings get one in the background, whatever is on screen first (Jasper: on the Dashboard the card previews of
  the clips in view, in the editor the open clip's strip). A clip opened before its turn gets it on the spot: an
  empty track, then the whole strip at once.
- **Tiles look alike:** each tile is brought down in steps of at most 2x. One big draw gave some tiles crisp bright
  text and others grey, by how Chromium held the frame; the averaged look is the one that can be had every time.
- **Always the original recording:** a trim doesn't change the strip.
- **Dragging the playhead** follows the pointer: the video's own time no longer overwrites it while a seek is on its
  way (it pulled the playhead back behind the pointer, up to 47px).
- **Frame step:** one frame of the rate that recording was made at (`HistoryItem.fps`; 30 now, about 60 before
  2026-11-18).


## Intent

The video editor (`/editor` with a recording) should look and behave like
the Dashboard and Settings: the same app bar, layers, buttons, type scale,
hover and copy rules (`design/STYLEGUIDE.md`). Two behaviour fixes ride
along: scrubbing that keeps showing frames, and a tighter trim cut.

## Decisions (Jasper, 2026-11-22)

- **App bar:** the editor shows the shared AppBar (logo, theme, Settings)
  and puts its own controls in the slot, like the Dashboard's filters. The
  editor's own top bar goes, and so does the bare 40px strip on Windows (two
  bars stacked today).
- **Own player controls:** no native `<video controls>`; play / pause and
  mute live in the trim bar, a click on the video plays or pauses.
- **Keyframes every 0.25s** (`KEYFRAME_INTERVAL_MS` 1000 → 250 in
  `RecorderHost.tsx`), so a trim snaps back at most 0.25s; kept only after a
  file-size measurement (below). An exact cut (WebCodecs re-encode of the
  start) is a later project; the bundled ffmpeg has no encoders (LGPL-only,
  no external libraries).
- **Scrubbing fix:** seeks are chained (the next starts when the previous
  frame has landed, always to the newest position), so dragging shows
  frames all the way.

## Proposals Jasper didn't object to (CC's, 2026-11-22)

- **Slot, left to right:** Back (framed icon button, `arrow_back`, tooltip
  "Back") · Copy · Save · Upload (framed text buttons, Settings' `BUTTON`).
  Lumia and Google Drive become one **Upload** button, as on the list rows:
  the share workflow (R2) when set up, else Google Drive when connected,
  left out when neither is.
- **New** (new capture) leaves the editor: captures start from the
  Dashboard, the hotkeys and the tray.
- **History** (recent images panel) is hidden for videos; it returns in the
  image editor review.
- **Toasts:** the shared app toast since 2026-11-24 (STYLEGUIDE › Toasts:
  fill by kind, centred under the app bar); copy per STYLEGUIDE › Voice ›
  Toast text ("Uploaded, link copied", "Trimmed, original kept",
  "Trimmed, couldn't copy video" as a warning).

## Layout

```
[● ● ●] (logo) Lumia      [← ] [Copy] [Save] [Upload]          [☾] [⚙]
┌──────────────────────────────────────────────────────────────────────┐
│                    video, centred, on bg-content                     │
├──────────────────────────────────────────────────────────────────────┤ .edge-t
│ ▓▓▓▓[▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓|▓▓▓▓▓▓▓▓▓▓▓▓▓▓]▓▓▓▓      filmstrip, 70px  │ bg-toolbar
│ [▶][🔊] 0:03.20 / 0:17.53   [D] Start [F] End …   17.53s [↺ Reset] [Apply trim] │
└──────────────────────────────────────────────────────────────────────┘
```

- **Video area:** `bg-content` (the Dashboard's clip area), no dot pattern;
  the video centred at no more than its encoded size (as today). Click =
  play / pause; arrow cursor.
- **Trim bar:** `bg-toolbar`, `.edge-t` (inside top edge), no glass.
  - Filmstrip as today: accent handles, white playhead, dark wash outside
    the selection (raw white / black allowed: drawn over media).
  - Bottom row, `h-12 px-4`, three columns:
    - Left: play / pause (`play_arrow` / `pause`, tooltip "Play" / "Pause")
      and mute (`volume_up` / `volume_off`, "Mute" / "Unmute"; only when the
      recording has an audio track) as 32px framed icon buttons, `gap-2`;
      then the time `0:03.20 / 0:17.53` (Control rank: 12px medium
      `tabular-nums` `fg-secondary`; current `fg`).
    - Centre: shortcut hints, keycaps 10px medium on `bg-elevated` with a
      `line` edge, labels 10px `fg-tertiary`.
    - Right: selection length (`17.53s`, 12px medium `fg-tertiary`), Reset
      (framed text button with `undo`), Apply trim (accent fill like
      Settings' Connect: `bg-accent text-on-accent`, hover `accent-hover`).
      The keyframe note becomes a 10px `warning-text` line under the left
      column only when it applies.
  - Right-click menu ("Start here" / "End here"): `bg-elevated border-line
    rounded-lg`, 12px medium items, hover per the rules, no glass.
- **Disabled:** `text-fg-disabled`, no hover, never opacity. Tooltips by
  `data-tip`, one word. No transitions; the spinner stays.

## Measuring the keyframes

Record the same 30s (a scroll and a static stretch) at 1s and at 0.25s
keyframes; compare file sizes. Keep 0.25s if it adds no more than about
25%; otherwise try 0.5s. Jasper records (it needs the screen); CC reads the
sizes from `~/Pictures/Lumia`.

## Left to the builder

- Exact Tailwind classes within these rules; the hover rules decide the
  rest.
- How the image editor's zoom and History sit in the slot until its own
  review (keep them working, restyle minimally).

## Todo (Jasper, 2026-11-22: "save this as todo")

- **Keyframes every 0.25s** + the size measurement above. Not done in this
  pass; `KEYFRAME_INTERVAL_MS` stays 1000.
- **Exact trim cut** (WebCodecs re-encode of the stretch from the start
  handle to the next keyframe, stitched to the copied rest; needs a small JS
  WebM reader / writer). Later project, after the keyframes.
