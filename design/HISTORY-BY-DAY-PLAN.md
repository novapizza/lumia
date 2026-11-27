# History by Day Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store capture history as one JSON file per local day plus `history_stat.json`, and make the Dashboard load days lazily and drop far-away days from memory.

**Architecture:** A pure storage module (`electron/history-days.ts`, Node `fs` only, unit-tested with `node --test`) owns day files, stats, the id→day map and the day cache. `HistoryStore` wraps it with the Electron-side parts (legacy migration, thumbnail migration, file unlinking, change events). The renderer gets three new IPC reads and a change event; a hook (`useDayHistory`) holds loaded days, and a `DaySections` component renders one section per day with an IntersectionObserver sentinel and height-preserving placeholders.

**Tech Stack:** Electron 42 main (TypeScript), React 19 renderer, Tailwind 4, `node:test` via `node --experimental-strip-types` (Node 22.14, no new dependency).

**Spec:** `design/HISTORY-BY-DAY.md`

## Global Constraints

- Work in a git worktree on branch `feat/history-by-day`, created from `master` (not from `feat/color-roles`, which holds unrelated, uncommitted design work).
- Use pnpm. No new runtime or dev dependencies.
- Day key = local date of `timestamp`, `YYYY-MM-DD`. Day files at `userData/history/<day>.json` as `{ "items": HistoryItem[] }`, newest first. Stats at `userData/history_stat.json`, shape exactly as in the spec (`version: 1`, `cleanupVersion`, `total`, `screenshot`, `recording`, `days[]` newest first, only days with rows).
- Writes are synchronous and atomic (`<file>.tmp` + `renameSync`), day file first, then stats. An emptied day file is deleted.
- No 1000-row cap. Retention setting unchanged.
- No backup of `history.json`: the migration deletes it as its last step. Same id in a day file and in `history.json` → the day file wins.
- `HistoryItem` shape unchanged; `timestamp` is never patched.
- Cmd+A select-all removed; Esc still leaves selection mode.
- Missing-file count and cleanup cover loaded days only.
- Type-check: `pnpm exec tsc --noEmit -p tsconfig.node.json` and `-p tsconfig.web.json` (on `master` the only expected web errors are the pre-existing ones; record them in Task 0 and compare).
- UI copy and docs: no em-dashes.

## Review Focus

1. **Captures either side of midnight** land in different day files and appear under the right day headers. Test in Task 1.
2. **Deleting the last capture of a day** removes the file, the stats entry and the Dashboard section without a gap. Test in Task 1 (storage); manual check in Task 6.
3. **A corrupt day file** (invalid JSON, e.g. a half-synced profile) must not be overwritten with a near-empty list or crash startup: it is renamed aside and the day is treated as empty. Test in Task 2.
4. **A write to a day that is dropped in the Dashboard** (an upload finishing for an old capture) updates the stats; the day stays dropped and shows the new data when it loads again. Manual check in Task 6.
5. **Switching filter while scrolled deep** skips days with 0 of that type, keeps the scroll stable and still loads more on scroll. Manual check in Task 6.

---

### Task 0: Worktree, branch, test script

**Files:**
- Create: worktree `../Lumia-history` (branch `feat/history-by-day` from `master`)
- Modify: `package.json` (scripts)
- Create: `design/HISTORY-BY-DAY.md`, `design/HISTORY-BY-DAY-PLAN.md` (copied from the main checkout)

- [ ] **Step 1:** `git worktree add ../Lumia-history -b feat/history-by-day master`, then `cd ../Lumia-history && pnpm install`.
- [ ] **Step 2:** Copy both design files from `../Lumia/design/` into `design/` in the worktree.
- [ ] **Step 3:** Add script `"test": "node --experimental-strip-types --test \"tests/**/*.test.ts\""` to `package.json`. Tests live in `tests/` (outside both tsconfig `include`s, so `.ts` import extensions don't break `tsc`).
- [ ] **Step 4:** Run both type-checks; save the list of pre-existing errors in the task notes for later comparison.
- [ ] **Step 5:** Commit: `chore: add history-by-day design and node test script`.

### Task 1: Day storage core

**Files:**
- Create: `electron/history-days.ts`
- Test: `tests/history-days.test.ts`

**Interfaces:**
- Produces (all exported from `electron/history-days.ts`; the module imports only `node:fs`, `node:path` and `import type { HistoryItem } from './types'`, so it runs under `node --test` without Electron):
  - `dayKey(timestamp: number): string`
  - `interface DayStat { day: string; total: number; screenshot: number; recording: number }`
  - `interface HistoryStats { version: 1; cleanupVersion: number; total: number; screenshot: number; recording: number; days: DayStat[] }`
  - `writeJsonAtomic(path: string, data: unknown): void`
  - `class DayHistory { constructor(rootDir: string) }` where `rootDir` is `userData`. Methods:
    - `getStats(): HistoryStats`
    - `getDays(days: string[]): Record<string, HistoryItem[]>`
    - `get(id: string): HistoryItem | null`
    - `getRecent(limit: number, type?: HistoryItem['type']): HistoryItem[]`
    - `add(item: HistoryItem): string` (returns the day key)
    - `update(id: string, patch: Partial<HistoryItem>): { item: HistoryItem; day: string } | null`
    - `deleteMany(ids: string[]): { removed: HistoryItem[]; days: string[] }`

- [ ] **Step 1: Write the failing tests** in `tests/history-days.test.ts` (each test uses a fresh `mkdtempSync` dir; import from `'../electron/history-days.ts'`):
  - `dayKey uses local date`: `dayKey(new Date(2026, 10, 18, 23, 59).getTime()) === '2026-11-18'` and `dayKey(new Date(2026, 10, 19, 0, 1).getTime()) === '2026-11-19'`.
  - `add writes the day file and stats`: add a screenshot at 2026-11-18 10:00 → `history/2026-11-18.json` exists with 1 item; `getStats()` equals `{ version: 1, cleanupVersion: 0, total: 1, screenshot: 1, recording: 0, days: [{ day: '2026-11-18', total: 1, screenshot: 1, recording: 0 }] }`.
  - `midnight split`: rows at 23:59 and 00:01 → two day files; `getStats().days.map(d => d.day)` equals `['2026-11-19', '2026-11-18']`.
  - `day file is newest first`: add 10:00 then 09:00 then 11:00 → `getDays(['2026-11-18'])['2026-11-18'].map(i => i.timestamp)` descending.
  - `get finds a row in a day not yet read`: write via one `DayHistory`, read `get(id)` via a second instance on the same dir → returns the row.
  - `update patches and keeps the day`: `update(id, { uploads: [...] })` returns `{ day: '2026-11-18' }`; re-read from a new instance shows the patch.
  - `deleting the last row removes the day`: add one row, `deleteMany([id])` → file gone, stats `days` is `[]`, `total` 0, return value `{ removed: [row], days: ['2026-11-18'] }`.
  - `getRecent across days with type filter`: 3 screenshots on day A, 2 recordings + 1 screenshot on day B (newer) → `getRecent(2, 'screenshot')` returns B's screenshot then A's newest.
  - `no cap`: add 1100 rows over 3 days → `getStats().total === 1100`.
- [ ] **Step 2:** `pnpm test` → FAIL (module not found).
- [ ] **Step 3: Implement** `electron/history-days.ts`. Approach: stats kept in memory and written after every day write; id→day `Map` filled on every day-file read; day cache a `Map<string, HistoryItem[]>` holding the last 30 days read (simple LRU by re-insert). `get` on a miss reads day files newest first from `stats.days` until found. Mutations update cache and disk before returning (all sync).
- [ ] **Step 4:** `pnpm test` → PASS.
- [ ] **Step 5:** `pnpm exec tsc --noEmit -p tsconfig.node.json` → no new errors. Commit: `feat(history): day-file storage core`.

### Task 2: Stats recovery, corrupt files, prune, reset, legacy import

**Files:**
- Modify: `electron/history-days.ts`
- Test: `tests/history-days.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces (methods on `DayHistory`):
  - `reconcile(): void` (called by the constructor; also callable in tests)
  - `pruneOlderThan(cutoffMs: number): { removed: HistoryItem[]; days: string[] }`
  - `reset(cleanupVersion: number): HistoryItem[]` (empties all days, sets `cleanupVersion`, returns the removed rows)
  - `importLegacy(items: HistoryItem[], cleanupVersion: number): { added: number; days: string[] }`
  - `get cleanupVersion(): number`

- [ ] **Step 1: Write the failing tests:**
  - `missing stats are rebuilt`: add rows, delete `history_stat.json`, new instance → `getStats()` equals the original.
  - `stale stats are recounted`: add rows, then append a row directly to a day file with a modified time later than the stats file (use `utimesSync` to push the day file's mtime 10 s ahead) → new instance's stats count it; a day file not listed in stats is added; a listed day whose file is gone is removed.
  - `corrupt day file is set aside`: write `history/2026-11-18.json` with `{not json` → new instance does not throw, `getDays(['2026-11-18'])` gives `[]`, a file matching `2026-11-18.corrupt-*.json` exists, and the original content is preserved in it.
  - `prune drops whole old days and old rows of the boundary day`: rows on 11-10, 11-15 08:00, 11-15 20:00, 11-18; cutoff = 11-15 12:00 → removed 11-10 and 11-15 08:00; 11-15 file keeps the 20:00 row; stats updated.
  - `reset empties everything`: returns all rows, `history/` has no day files, stats total 0 and `cleanupVersion` set.
  - `importLegacy merges and the day file wins`: day file has row `a` with `name: 'new'`; import `[a with name 'old', b]` → `a.name === 'new'`, `b` present, `added === 1`. Importing the same list again → `added === 0`.
- [ ] **Step 2:** `pnpm test` → the new tests FAIL.
- [ ] **Step 3: Implement.** Reconcile per the spec: `readdirSync(history)`, compare each day file's `mtimeMs` with the stats file's; recount only newer or unlisted days; drop listed days without a file; write stats once if anything changed. Corrupt file: on `JSON.parse` failure in any day read, `renameSync` to `<day>.corrupt-<Date.now()>.json`, log with `console.error('[history] corrupt day file', …)`, treat as empty.
- [ ] **Step 4:** `pnpm test` → PASS.
- [ ] **Step 5:** Commit: `feat(history): stats recovery, prune, reset and legacy import`.

### Task 3: HistoryStore on day files, one shared instance

**Files:**
- Modify: `electron/history.ts` (rewrite on top of `DayHistory`)
- Modify: `electron/workflow.ts` (use the shared store)
- Modify: `electron/index.ts` (callers of `getAll()`; `openHistoryItemInEditor`; change events)
- Modify: `electron/video.ts` (trim / clear-trim lookups)

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces (`HistoryStore`, constructed once in `electron/index.ts` as today, exposed by the existing `getHistoryStore()`):
  - `constructor(userDataDir: string)` (pass `app.getPath('userData')`)
  - `getStats(): HistoryStats`, `getDays(days: string[]): Record<string, HistoryItem[]>`, `get(id): HistoryItem | null`, `getRecent(limit, type?)`
  - `add(item: HistoryItem): void`, `update(id, patch): HistoryItem | null`, `delete(id): Promise<boolean>`, `deleteMany(ids): Promise<number>`, `pruneOlderThan(days: number): Promise<number>`, `runStartupCleanup(targetVersion: number): Promise<number>` (same semantics and file-unlink rules as today)
  - `onChange(listener: (days: string[]) => void): void` (fired after every write with the affected day keys)

- [ ] **Step 1:** Rewrite `electron/history.ts`. Constructor order: if `userData/history.json` exists, read it with `JSON.parse(readFileSync)` (shape `{ items: HistoryItem[]; cleanupVersion?: number }`), run the existing inline-thumbnail move on those rows, `importLegacy(rows, cleanupVersion ?? 0)`, then `unlinkSync` the file; on any error log and keep `history.json` (spec, Migration step 2). Keep `unlinkItemFiles` as is. Remove the 1000 cap. Drop the `electron-store` import from this file.
- [ ] **Step 2:** `WorkflowEngine`: replace `private historyStore = new HistoryStore()` with a constructor parameter `historyStore: HistoryStore`, and in `index.ts` create the `HistoryStore` before `new WorkflowEngine(templateStore, historyStore)`. Replace `getAll().find(i => i.id === x)` with `get(x)` in `workflow.ts`, `index.ts` (`openHistoryItemInEditor`, `history:saveAnnotations`, `history:shareR2`, `history:shareGoogleDrive`) and `video.ts`.
- [ ] **Step 3:** In `index.ts`, `historyStore.onChange(days => mainWindow?.webContents.send('history:changed', { days }))` (guard destroyed window).
- [ ] **Step 4:** `pnpm exec tsc --noEmit -p tsconfig.node.json` → clean; `rg "getAll\(" electron` → no hits. `pnpm build` passes.
- [ ] **Step 5:** Commit: `refactor(history): HistoryStore on day files, shared instance`.

### Task 4: IPC for stats, days, recent and the change event

**Files:**
- Modify: `electron/index.ts`, `electron/preload/index.ts`, `src/electron.d.ts`, `src/types.ts` if `HistoryStats`/`DayStat` need a renderer copy (mirror the types; renderer can't import from `electron/`)

**Interfaces:**
- Consumes: Task 3.
- Produces (renderer, `window.electronAPI`):
  - `getHistoryStats(): Promise<HistoryStats>` → `history:stats`
  - `getHistoryDays(days: string[]): Promise<Record<string, HistoryItem[]>>` → `history:days` (each row through `resolveThumbnailUrl` and the `fs.access` missing check, as `history:get` does now)
  - `getRecentHistory(limit: number, type?: 'screenshot' | 'recording'): Promise<HistoryItem[]>` → `history:recent` (same resolving)
  - `cleanupMissingHistory(ids: string[]): Promise<number>` → `history:cleanupMissing` now checks only these ids
  - `onHistoryChanged(cb: (p: { days: string[] }) => void): () => void` (returns an unsubscribe)
- `history:get` stays until Task 7.

- [ ] **Step 1:** Add the handlers, preload methods and typings (three places, in the order CLAUDE.md gives). Extract the row-resolving code from `history:get` into one local helper used by all three reads.
- [ ] **Step 2:** Both type-checks → no new errors. `pnpm build` passes.
- [ ] **Step 3:** Commit: `feat(history): IPC for day reads, stats and change events`.

### Task 5: Renderer helpers (day labels, height estimate)

**Files:**
- Create: `src/utils/dayHistory.ts` (no imports, so `node --test` can load it)
- Test: `tests/day-history-ui.test.ts`

**Interfaces:**
- Produces:
  - `dayLabel(day: string, now: Date): string` → `'Today'`, `'Yesterday'`, weekday name (`'Monday'`) within the last 6 days, else `'Nov 12'`, with `', 2025'` when the year differs. Use `en-US` to match the rest of the UI.
  - `estimateDayHeight(count: number, columns: number, rowHeight: number, gap: number, headerHeight: number): number` = `headerHeight + rows * rowHeight + max(rows - 1, 0) * gap`, `rows = ceil(count / columns)`.

- [ ] **Step 1: Failing tests:** with `now = new Date(2026, 10, 19, 9)`: `'2026-11-19' → 'Today'`, `'2026-11-18' → 'Yesterday'`, `'2026-11-16' → 'Monday'`, `'2026-11-12' → 'Nov 12'`, `'2025-12-30' → 'Dec 30, 2025'`. `estimateDayHeight(9, 4, 150, 12, 40) === 40 + 3*150 + 2*12`; `estimateDayHeight(0, 4, 150, 12, 40) === 40`.
- [ ] **Step 2:** `pnpm test` → FAIL. **Step 3:** implement. **Step 4:** `pnpm test` → PASS.
- [ ] **Step 5:** Commit: `feat(dashboard): day label and height helpers`.

### Task 6: Dashboard loads days lazily and drops far ones

**Files:**
- Create: `src/windows/dashboard/useDayHistory.ts`
- Create: `src/components/DaySections.tsx`
- Modify: `src/windows/dashboard/Dashboard.tsx`
- Delete (if unused after this task): `src/components/DateGroupedGrid.tsx`, `src/utils/dateGroup.ts`

**Interfaces:**
- Consumes: Tasks 4–5.
- Produces:
  - `useDayHistory(filter: 'all' | 'screenshot' | 'recording')` returning `{ stats: HistoryStats | null; days: DayStat[] /* stats.days with 0-count days for the filter removed */; rows: Map<string, HistoryItem[]> /* loaded days only */; loadDays(days: string[]): void; dropDays(days: string[]): void; refresh(days?: string[]): void }`. Subscribes to `onHistoryChanged` (refetch stats; reload changed days that are loaded; leave dropped days dropped). Removes optimistic rows on local delete via `refresh`.
  - `DaySections` props: `{ days: DayStat[]; rows: Map<string, HistoryItem[]>; filter; view: 'grid' | 'list'; renderItem: (item: HistoryItem) => ReactNode; gridClassName: string; loadDays; dropDays; pinnedDays: Set<string> /* days with selected rows, never dropped */; emptyState: ReactNode }`. Each day is a `<section data-day>` with header (`dayLabel`, count from stats for the filter) and either its rows or a placeholder `<div style={{ height }}>` (measured height when dropped, `estimateDayHeight` before first load). One `IntersectionObserver` on the scroll container with `rootMargin` of one viewport height loads days entering range; days more than three viewport heights away (and not pinned) are dropped after their height is measured. Initial load: newest days until the estimate covers two viewport heights.

- [ ] **Step 1:** Build `useDayHistory` and `DaySections`.
- [ ] **Step 2:** In `Dashboard.tsx`: replace `recentItems` / `getHistory()` / refetch-on-focus with `useDayHistory(filter)`; toolbar total and filter counts from `stats`; `filtered` comes from loaded rows; missing count and `handleCleanupMissing` use loaded rows' ids; bulk delete and single delete call the existing IPC then rely on `history:changed`; remove the Cmd+A branch from the keydown handler (keep Esc); pass `pinnedDays` from `selectedIds`. Grid and list both render through `DaySections`.
- [ ] **Step 3:** Web type-check → no new errors; `pnpm build` passes.
- [ ] **Step 4: Manual check in the dev app** on a copied profile (`pnpm exec electron-vite dev -- "--user-data-dir=$HOME/Library/Application Support/lumia-dev"`, profile copied fresh from the installed one so the migration runs):
  - [ ] First launch: `history.json` gone, `history/` has day files, `history_stat.json` totals match the old row count; Dashboard shows the same captures.
  - [ ] Scroll to the bottom: older days load before they come into view; scrolling back up doesn't jump.
  - [ ] DevTools React profiler or a `console.count` in `DaySections` confirms far days' rows are dropped and reloaded.
  - [ ] Review Focus 2: delete every capture of one day → section disappears, counts update.
  - [ ] Review Focus 4: scroll far down, share an item from the top day via hotkey capture / upload → totals update, no jump.
  - [ ] Review Focus 5: scroll deep, switch to Recordings then back to All.
  - [ ] New capture via hotkey while the window is hidden → appears at the top when shown.
  - [ ] Cmd+A does nothing in selection mode; Esc exits.
- [ ] **Step 5:** Commit: `feat(dashboard): lazy day loading with far-day dropping`.

### Task 7: Remove `history:get`, Editor on `history:recent`, docs

**Files:**
- Modify: `electron/index.ts`, `electron/preload/index.ts`, `src/electron.d.ts`, `src/windows/editor/Editor.tsx`, `CLAUDE.md`

- [ ] **Step 1:** `Editor.tsx`: the recent-screenshots list uses `getRecentHistory(20, 'screenshot')` and keeps its existing `!fileMissing && thumbnail` filter.
- [ ] **Step 2:** Remove `history:get`, `getHistory` from preload and typings. `rg "getHistory\(|history:get" src electron` → no hits.
- [ ] **Step 3:** `CLAUDE.md`: Persistence section (history is `history/<day>.json` + `history_stat.json`, no cap, migration deletes `history.json`, older builds see empty history), the `history.ts` row in the module table (and a `history-days.ts` row), the Dashboard route note (lazy days, far days dropped), the Commands table (`pnpm test`), and the "no test framework" line.
- [ ] **Step 4:** Both type-checks → no new errors; `pnpm test` → PASS; `pnpm build` passes.
- [ ] **Step 5:** Commit: `chore(history): drop history:get, editor uses recent read, docs`.

### Task 8: Issue and PR

- [ ] **Step 1:** Draft the issue (Problem: one `history.json` rewritten whole on every change, 1000-row silent cap, Dashboard reads and checks every row) and the PR body (`## Summary` / `## Test plan` with the manual checklist from Task 6 and honest status), title `feat(history): store history per day and lazy-load the Dashboard`. No em-dashes. Show both drafts to Jasper before filing.
- [ ] **Step 2:** After approval: file the issue and open the PR as `happy-looter` from the fork (`GH_TOKEN=$(gh auth token --user happy-looter)`, push to remote `fork`), PR body with `Closes #N`.
