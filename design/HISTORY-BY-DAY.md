# History by day

Design for splitting capture history into one file per day, with a small
stats file for totals, and a Dashboard that loads days lazily as you scroll
and drops far-away days from memory.

Status: design, not built. Written 2026-11-18, updated 2026-11-19 after review.

## Why

Today all history lives in one `history.json` (electron-store), capped at
1000 rows so the file stays around 4 MB. Every change rewrites the whole file,
and the Dashboard asks for every row on every visit (plus an `fs.access`
check per row). The goal is to read and write only the small slice that is
needed, so history can grow without a cap and the Dashboard stays fast.

## Goals

- History stored as one JSON file per local calendar day.
- `history_stat.json` holds the totals the UI needs without reading any day
  file: overall and per type, and per day.
- The Dashboard shows a few days at a time, loads the next days a little
  before you reach them, and drops days that are far out of view from memory
  (their rows are removed from renderer state, not just hidden), loading them
  again if you scroll back.
- No more 1000-row cap.

## Non-goals

- No search, no new filters, no change to what a row stores (`HistoryItem`
  stays as it is).
- No change to where capture files live (`~/Pictures/Lumia`) or to
  thumbnails (`userData/thumbnails/`).
- No SQLite or other database.
- Older builds on the same profile are not supported (decided 2026-11-19).
  After the switch, an older release or a dev build from before this change
  sees an empty history, and if it writes a fresh `history.json` the new
  build migrates that file on its next launch (day-file copy wins on the
  same id). Releases only update
  forward; dev can use its own profile with `--user-data-dir`.

## Anti-goals (fails even if it works)

- Losing or duplicating history rows in the migration.
- Scroll position jumping when days load or drop.
- Totals in the toolbar that disagree with what's on disk after a crash.
- Any code path that still reads every day file during normal Dashboard use.

## Approaches considered

Storage:

1. **One file per day + `history_stat.json`** (picked). A new capture only
   rewrites today's file and the stats file. The stats file doubles as the
   list of days that have captures.
2. One file per month + stats. Fewer files, but loading a few days still
   reads a whole month.
3. SQLite. Real queries, but a native module to rebuild per platform/arch.
   Too heavy for this.

Loading and dropping:

1. **Hand-built, per day section** (picked). Each day renders as its own
   section; a sentinel near the bottom loads more days; far-away days drop to
   a fixed-height placeholder.
2. A virtualisation library (react-virtuoso / TanStack Virtual). Adds a
   dependency and copes badly with the grid's auto-fill column count.

## On disk

Under `userData/`:

```
history/
  2026-11-18.json      { "items": HistoryItem[] }   newest first
  2026-11-17.json
  ...
history_stat.json
```

- Day key: the capture's **local** date at write time, `YYYY-MM-DD`, from
  `timestamp`. A row stays in the file it was written to.
- A day file with no items left is deleted.
- Writes are synchronous and atomic: write `<file>.tmp`, then rename over the
  target. Day file first, then the stats file.

`history_stat.json`:

```json
{
  "version": 1,
  "cleanupVersion": 1,
  "total": 94,
  "screenshot": 60,
  "recording": 34,
  "days": [
    { "day": "2026-11-18", "total": 9, "screenshot": 2, "recording": 7 },
    { "day": "2026-11-17", "total": 4, "screenshot": 4, "recording": 0 }
  ]
}
```

- `days` is sorted newest first and only lists days with at least one row.
- `cleanupVersion` moves here from `history.json` (used by
  `runStartupCleanup`).
- If the stats file is missing, unreadable, or its version is unknown, it is
  rebuilt by scanning the day files (the only time all day files are read
  outside the migration).
- Crash between the day-file write and the stats write (my call): at startup,
  list `history/` and compare each day file's modified time with the stats
  file's (one `stat` per file, no reads). Recount only the day files that are
  newer than the stats file, and any day file the stats don't list. Day
  entries whose file no longer exists are removed. Then write the stats once.

## Main process: `HistoryStore`

One instance for the whole app. `WorkflowEngine` gets the shared instance
(today it creates its own, with its own cache, which can go stale).

Replaces `getAll()` with targeted reads:

| Method | Does |
|---|---|
| `getStats()` | Returns the stats file contents. |
| `getDays(days: string[])` | Returns the rows of those days. |
| `get(id)` | One row by id. |
| `getRecent(limit, type?)` | Newest rows across days until `limit` is reached (Editor sidebar). |
| `add(item)` | Into the day file for `item.timestamp`, updates stats. |
| `update(id, patch)` | Rewrites that row's day file. `timestamp` is never patched. |
| `delete(id)` / `deleteMany(ids)` | Rewrites the affected day files, updates stats, unlinks files as today. |
| `pruneOlderThan(days)` | Drops whole day files older than the cutoff (plus the boundary day's old rows), unlinks files as today. |
| `runStartupCleanup(v)` | As today, against day files + stats. |

Finding a row by id: ids are random UUIDs, so the day isn't in the id. Keep
an in-memory `id → day` map, filled whenever a day file is read. On a miss,
read day files newest first (from the stats list) until found. Nearly every
lookup is for a row the Dashboard or Editor just showed, so the map already
has it.

Caching: keep the parsed contents of recently used day files in memory
(builder picks the size, e.g. the last ~30 days touched). Writes update the
cache and the disk together, before any `await`, as the current code does to
avoid lost updates.

Every caller of `getAll()` moves to the method that fits:
`history:saveAnnotations`, `history:shareR2`, `history:shareGoogleDrive`,
`video:trim` / `video:clear-trim`, `WorkflowEngine` (merge uploads,
`resolveSourceForCopy`) use `get(id)`. `history:cleanupMissing` takes the ids
to check (see below).

Change notification: after any write, main sends `history:changed` with the
affected day keys to the main window, so the Dashboard can refresh just
those days and the stats. This replaces the "refetch everything on window
focus" logic.

## IPC

| Channel | Returns |
|---|---|
| `history:stats` | Stats file. |
| `history:days(days[])` | Rows for those days, each with `thumbnailUrl` resolved and `fileMissing` checked (as `history:get` does today, but only for these rows). |
| `history:recent(limit, type?)` | For the Editor's recent-captures list. |
| `history:cleanupMissing(ids[])` | Checks and removes only the given ids. |
| `history:changed` (event, main → renderer) | `{ days: string[] }` |

`history:get` is removed. Update `preload/index.ts` and `src/electron.d.ts`
as for any channel.

## Migration (first launch on the new build)

No backup of `history.json` is kept (decided 2026-11-19): the capture files
in `~/Pictures/Lumia` are the real data, the history rows only point at them.

1. If `history.json` exists: read all rows, group by local day, write them
   into the day files (merging with any rows already there), rebuild
   `history_stat.json` (carry `cleanupVersion` over), then delete
   `history.json`. Deleting it is the last step, so a finished migration
   never runs again (unless an older build writes a new `history.json`, see
   Non-goals). When a row's id is already in a day file, the day file's copy
   wins and the old row is skipped, which makes a rerun harmless.
2. If it fails partway (disk full, file locked by antivirus): stop, log the
   error, keep `history.json`, and leave the day files already written (each
   was written atomically). This launch shows what got migrated; the next
   launch reruns the migration and fills in the rest, skipping ids it already
   has. The migration runs synchronously in the `HistoryStore` constructor,
   before any IPC is registered, so nothing else writes in the middle of it.
3. The inline-thumbnail migration (`migrateInlineThumbnails`) runs on the
   old rows before they are split, so day files never carry data URLs.

## Dashboard

Data:

- On mount: `history:stats`, then load the first days.
- State is a map `day → rows` for loaded days only, plus the stats.
- Toolbar count, filter counts: from stats (`total`, `screenshot`,
  `recording`), not from loaded rows.
- With a filter on, days whose stats count for that type is 0 are skipped
  entirely (never loaded, no header).
- On `history:changed`: refetch stats; reload any affected day that is
  loaded; a new day (today, first capture) is added at the top.

Layout:

- One section per day, with a day header (see the open call below), the day's
  count from stats, and the grid or list of its rows.
- The grid keeps today's look (cards, auto-fill columns).

Loading:

- Start with the newest days until about two screen heights of content are
  loaded (builder: estimate a day's height from its stats count and the
  current column count).
- A sentinel after the last loaded day; when it comes within about one screen
  height of the viewport (IntersectionObserver with a rootMargin), load the
  next few days.
- While a day is loading, its section shows a placeholder of its estimated
  height.

Dropping (memory):

- A loaded day whose section is more than about three screen heights from
  the viewport is dropped: its rows are removed from state and the section
  becomes an empty block with the height it had when dropped (measured), so
  the scroll position doesn't move.
- When a dropped day comes back within the load distance, it loads again
  into that same block.
- A selected row's day is never dropped while selection mode is on.
- Builder tunes the distances; the numbers above are starting points.

Selection, missing files:

- The Cmd+A select-all shortcut is removed (decided 2026-11-19). Esc still
  leaves selection mode. Back 2026-11-25: Cmd+A selects all of history
  under the type filter by id (`history:allIds`), loaded or not; days aren't
  pinned while that selection stands. Delete / Backspace deletes the
  selection.
- "N missing files" counts missing rows in loaded days; the trash button
  removes those (`history:cleanupMissing(ids)`). Changed 2026-11-21: the
  count and the button cover all of history (`history:missingIds` scans
  every day), since a loaded-days count vanished when those days were
  scrolled out of memory.

## Editor

`Editor.tsx` uses `getHistory()` for its list of the 20 newest screenshots.
It moves to `history:recent(20, 'screenshot')`.

## Calls made in this design (check these)

- 1000-row cap removed; the retention setting stays as the only limit.
- `WorkflowEngine` shares the main `HistoryStore`.
- Missing-file count and cleanup cover loaded days only (reversed 2026-11-21: all of history, see above).
- `history:changed` push replaces refetch-on-focus.
- Day sections get per-day headers instead of today's
  Today / Yesterday / This Week / This Month / Earlier buckets, since the day
  is the unit that loads and drops.

## Left to the builder

- Day-file cache size and eviction.
- Exact load / drop distances and the per-day height estimate.
- Atomic-write helper details (tmp + rename) and error logging.
- How the list view (`HistoryListRow`) shares the day-section code with the
  grid.
- Updating `CLAUDE.md` (Persistence, `history.ts` row, Dashboard notes) once
  built.
