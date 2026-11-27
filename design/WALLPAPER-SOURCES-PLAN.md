# Wallpaper Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings › Wallpapers gets photos from Wikimedia Commons (default) or Wallhaven, with no keys: one category list, one category at a time, a 4K filter, and more photos on scroll; the Unsplash path goes.

**Architecture:** Pure, Electron-free modules hold each source's search building and response mapping (`electron/wallpaper-sources/*.ts`, unit-tested with `node --test`); one networked entry (`electron/wallpaper-sources/index.ts`) runs them over Electron's `net`. The renderer section talks to it through two IPC channels and keeps its batching / cache logic in a pure, tested helper (`src/lib/wallpaper-feed.ts`).

**Tech Stack:** Electron 42 main (`net.request`), React 19 + Tailwind 4 renderer, TypeScript, `node --test` with type stripping (`pnpm test`).

**Spec:** `design/WALLPAPER-SOURCES.md`

## Global Constraints

- No commits: Jasper commits himself. Leave changes in the working tree.
- Tests import `.ts` files directly; a tested module must not import `electron` (type-only imports are fine).
- Type-check with `pnpm exec tsc --noEmit -p tsconfig.node.json` and `-p tsconfig.web.json` (ignore the existing TS2882 CSS / `logo.svg` import errors). `pnpm build` does not type-check.
- Every IPC channel changes in three places: the setup module (`electron/index.ts`), `electron/preload/index.ts`, `src/electron.d.ts`.
- User-facing text: no em dashes, no " · ", errors never name keys, env vars or "not configured". Error reasons: "Too many requests to Wallhaven. Try again in a minute." / "Too many requests to Wikimedia Commons. Try again in a minute." / "Couldn't reach Wallhaven (HTTP 503)".
- Desktop shape: ratio 1.3 to 2.4; at least 1920px wide, or at least 3840×2160 with 4K only.
- Wallhaven search: `categories=110`, `purity=100`, `ratios=landscape`, `sorting=random`, `atleast=1920x1080` or `3840x2160`; page 1 without `seed`, later pages with the `seed` page 1 returned.
- Commons search: `generator=search`, `gsrnamespace=6`, `gsrsort=random`, `gsrlimit=50`, `filew:>1919` or `filew:>3839`, `filemime:image/jpeg`; User-Agent `Lumia/1.0 (desktop screenshot app)` (also sent to Wallhaven).
- Batches: stop after 6 batches or when a source says `done`. Cache: keyed `source:categoryId:uhd|any`, at most 10 entries, 24 hours.
- Main-process edits need a `pnpm dev` restart before checking in the app (no `--watch`).
- Dev builds keep the dry run: Set as wallpaper only shows its toast (`dryRun`, TEMPORARY).
- UI follows STYLEGUIDE: `Segmented` for the source, `Toggle` for 4K, hovers colour-only, no new motion.

## Review Focus

1. **Fast clicks between categories (or source / 4K switches) while a batch loads**: the newest choice must win; an older response must never replace newer photos. Pinned by the request-token check in Task 6 (manual check step).
2. **The load-more sentinel firing again while a batch loads, after `done`, or past 6 batches**: no extra requests. Pinned by `shouldLoadMore` tests in Task 5.
3. **Random batches repeating photos** (Commons random order, Wallhaven seeds): the grid shows each photo once. Pinned by `mergeBatch` tests in Task 5.
4. **A source returns 429 mid-scroll**: the error box shows, the loaded photos stay, scrolling doesn't retry in a loop. Pinned by `shouldLoadMore` (stops on error) in Task 5.
5. **Settings from earlier builds** (`wallpaperCategories`, `wallpaperCommonsCategory`, old single-object `wallpaperGrid` with Unsplash photos): the section opens on Landscapes / Commons and ignores them. Pinned by `readCache` tests (non-map grid → null) in Task 5 and the defaults in Task 4.

---

### Task 1: Shared types, categories, shape filter, messages

**Files:**
- Create: `shared/wallpapers.ts`
- Test: `tests/wallpaper-shared.test.ts`

**Interfaces:**
- Produces (all exported from `shared/wallpapers.ts`):
  - `type WallpaperSourceId = 'commons' | 'wallhaven'`
  - `interface WallpaperPhoto { id: string; description: string | null; width: number; height: number; color: string | null; urls: { small: string; regular: string; full: string }; links: { html: string }; user: { name: string; link: string }; source: WallpaperSourceId; license?: string; origin?: string }` (`origin`: the original source link Wallhaven knows)
  - `interface WallpaperQuery { categoryId?: string; keywords?: string; uhd: boolean; page: number; cursor?: string }`
  - `interface WallpaperBatch { photos: WallpaperPhoto[]; cursor?: string; done: boolean }`
  - `const WALLPAPER_CATEGORIES: { id: string; label: string }[]` (the 15, in the spec's order: landscapes, mountains, lakes, waterfalls, coast, forests, sunsets, clouds, space, cities, architecture, interiors, flowers, birds, animals)
  - `const DEFAULT_WALLPAPER_CATEGORY = 'landscapes'`
  - `isDesktopShaped(width: number, height: number, uhd: boolean): boolean`
  - `sourceName(source: WallpaperSourceId): string` → "Wikimedia Commons" / "Wallhaven"
  - `tooManyRequests(source): string`, `couldntReach(source, status: number): string`

- [ ] **Step 1: Write the failing tests** in `tests/wallpaper-shared.test.ts`:
  - `isDesktopShaped`: `(2562,1440,false)` true; `(2000,1582,false)` false (1.26); `(7639,2118,false)` false (3.6); `(1919,1080,false)` false; `(3840,2160,true)` true; `(3000,1688,true)` false; `(3840,2100,true)` false.
  - `WALLPAPER_CATEGORIES` has 15 entries, unique ids, first `landscapes`, and contains `DEFAULT_WALLPAPER_CATEGORY`.
  - `tooManyRequests('wallhaven') === 'Too many requests to Wallhaven. Try again in a minute.'`; `couldntReach('commons', 503) === "Couldn't reach Wikimedia Commons (HTTP 503)"`.
- [ ] **Step 2: Run** `pnpm test` → the new file FAILS (module not found).
- [ ] **Step 3: Implement `shared/wallpapers.ts`.**
- [ ] **Step 4: Run** `pnpm test` → all pass.

### Task 2: Commons adapter (pure)

**Files:**
- Create: `electron/wallpaper-sources/commons.ts` (port of `electron/commons-wallpapers.ts`: `plainText`, `artistLink`, `thumbAt`, `toPhoto`, the featured-set table from `WallpapersSection.tsx`'s `COMMONS_CATEGORIES`)
- Test: `tests/wallpaper-commons.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `isDesktopShaped`, `WALLPAPER_CATEGORIES`.
- Produces:
  - `COMMONS_SEARCH: Record<string, string>` (category id → `incategory:` / `deepcat:` fragment)
  - `commonsSearchUrl(q: WallpaperQuery): string` (throws `Error('Unknown category')` for an unknown id without keywords)
  - `commonsBatch(json: unknown, uhd: boolean): WallpaperBatch` (`done` when no photos; no `cursor`)

- [ ] **Step 1: Write the failing tests:**
  - every `WALLPAPER_CATEGORIES` id has a `COMMONS_SEARCH` entry.
  - `commonsSearchUrl({ categoryId: 'landscapes', uhd: false, page: 1 })` has `gsrsearch` = `incategory:Featured_pictures_of_landscapes filew:>1919 filemime:image/jpeg`, `gsrsort=random`, `gsrlimit=50`, `iiurlwidth=500`.
  - with `uhd: true` → `filew:>3839`.
  - `{ keywords: 'cyberpunk', uhd: false, page: 1 }` → `gsrsearch` = `cyberpunk incategory:Featured_pictures_on_Wikimedia_Commons filew:>1919 filemime:image/jpeg`.
  - `commonsBatch` on a fixture with one 4302×2860 page (pageid 123, Artist `<a href="//commons.wikimedia.org/wiki/User:Simonizer">Simonizer</a>`, LicenseShortName `CC BY-SA 2.0 de`, thumburl ending `/500px-X.jpg`) and one 2000×1582 page → one photo: `id 'commons-123'`, `user.name 'Simonizer'`, `user.link 'https://commons.wikimedia.org/wiki/User:Simonizer'`, `license 'CC BY-SA 2.0 de'`, `source 'commons'`, `urls.small` ends `/500px-X.jpg`, `urls.regular` ends `/1280px-X.jpg`, `urls.full` ends `/3840px-X.jpg`; `done false`.
  - with `uhd: true`: the 4302×2860 page is kept; a fixture with only a 3000×2000 page gives no photos and `done true`.
- [ ] **Step 2: Run** `pnpm test` → FAIL.
- [ ] **Step 3: Implement** (no `electron` import).
- [ ] **Step 4: Run** `pnpm test` → pass.

### Task 3: Wallhaven adapter (pure)

**Files:**
- Create: `electron/wallpaper-sources/wallhaven.ts`
- Test: `tests/wallpaper-wallhaven.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `WALLHAVEN_TERMS: Record<string, string>` (the spec's table: landscape, mountains, lake, waterfall, coast, forest, sunset, clouds, space, cityscape, architecture, interior, flowers, birds, animals)
  - `wallhavenSearchUrl(q: WallpaperQuery): string` (base `https://wallhaven.cc/api/v1/search`; throws `Error('Unknown category')` like Commons)
  - `wallhavenBatch(json: unknown, uhd: boolean): WallpaperBatch` (`cursor` = `meta.seed`, `done` = `meta.current_page >= meta.last_page`)
  - `wallhavenCreditUrl(photo: WallpaperPhoto): string` (`https://wallhaven.cc/api/v1/w/<raw id>`)
  - `wallhavenCredit(json: unknown): Pick<WallpaperPhoto, 'user'> & { origin?: string }`

- [ ] **Step 1: Write the failing tests:**
  - every category id has a `WALLHAVEN_TERMS` entry.
  - `wallhavenSearchUrl({ categoryId: 'mountains', uhd: false, page: 1 })` → params `q=mountains`, `categories=110`, `purity=100`, `atleast=1920x1080`, `ratios=landscape`, `sorting=random`, `page=1`, no `seed`.
  - `{ categoryId: 'mountains', uhd: true, page: 2, cursor: 'onXroB' }` → `atleast=3840x2160`, `page=2`, `seed=onXroB`.
  - `wallhavenBatch` on a fixture (the probed hit `4l59g2`: 2562×1440, `path`, `thumbs`, `url`; plus a 2000×1582 hit; `meta: { current_page: 1, last_page: 715, seed: 'onXroB' }`) → one photo: `id 'wallhaven-4l59g2'`, `urls.small` = `thumbs.small`, `urls.regular` = `thumbs.large`, `urls.full` = `path`, `links.html` = `url`, `user.name ''`, `source 'wallhaven'`; `cursor 'onXroB'`, `done false`; with `current_page: 715` → `done true`.
  - `wallhavenCredit({ data: { uploader: { username: 'deleted' }, source: '' } })` → `user.name ''`, no `origin`; with `username: 'ansel'`, `source: 'https://example.com/a'` → `user.name 'ansel'`, `user.link 'https://wallhaven.cc/user/ansel'`, `origin 'https://example.com/a'`. A non-http `source` is dropped.
- [ ] **Step 2: Run** `pnpm test` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test` → pass.

### Task 4: Main process: network entry, IPC, settings, Unsplash removal

**Files:**
- Create: `electron/wallpaper-sources/index.ts`
- Delete: `electron/commons-wallpapers.ts`
- Modify: `electron/wallpapers.ts` (remove everything Unsplash: API, key, `getRandomWallpapers`, `trackWallpaperDownload`, `isUnsplashConfigured`, the `trackWallpaperDownload` call in `setDesktopWallpaper`; types → `WallpaperPhoto` from `shared/wallpapers.ts`; `isWallpaperImageUrl` allows only `upload.wikimedia.org`, `thumb.wikimedia.org`, `w.wallhaven.cc`; send the User-Agent for both sources)
- Modify: `electron/index.ts` (wallpapers IPC block), `electron/preload/index.ts`, `src/electron.d.ts`, `electron/settings.ts`, `src/types.ts` (drop `UnsplashPhoto`, re-export `WallpaperPhoto`), `.env.example` (drop the Unsplash line)

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces:
  - `fetchWallpapers(source: WallpaperSourceId, q: WallpaperQuery): Promise<WallpaperBatch>` (throws `Error` with the Task 1 messages on 429 / other HTTP errors; reuses the old `getJson` guards: 30 s timeout, 10 MB cap)
  - `creditFor(photo: WallpaperPhoto): Promise<Partial<WallpaperPhoto>>` (Commons → `{}`)
  - IPC `wallpapers:fetch` (`{ source, query }` → `{ ok: true, batch } | { ok: false, error }`), `wallpapers:credit` (`photo` → `Partial<WallpaperPhoto>`, `{}` on failure); preload `wallpapersFetch(source, query)`, `wallpapersCredit(photo)`. Remove `wallpapers:random`, `wallpapers:source`, `wallpapers:trackDownload` and their preload / d.ts entries.
  - Settings (`AppSettings` and `src/electron.d.ts`): `wallpaperSource: WallpaperSourceId` (default `'commons'`), `wallpaperCategory: string | null` (default `null`), `wallpaper4kOnly: boolean` (default `false`), `wallpaperGrid: Record<string, { photos: WallpaperPhoto[]; cursor?: string; fetchedAt: number }> | null` (default `null`); remove `wallpaperCategories`, `wallpaperCommonsCategory`. Keep `wallpaperCustomCategories`.

- [ ] **Step 1: Implement** the files above.
- [ ] **Step 2: Type-check** both configs → no new errors; `pnpm test` → pass.
- [ ] **Step 3: Check** `grep -rn "unsplash\|Unsplash\|UNSPLASH" electron src shared .env.example` → only historical comments, if any (none in code paths).

### Task 5: Renderer feed helper (pure)

**Files:**
- Create: `src/lib/wallpaper-feed.ts`
- Test: `tests/wallpaper-feed.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  - `MAX_BATCHES = 6`, `CACHE_ENTRIES = 10`, `CACHE_TTL_MS = 24 * 60 * 60 * 1000`
  - `cacheKey(source, categoryId: string, uhd: boolean): string` → `'wallhaven:mountains:uhd'` / `'commons:landscapes:any'`
  - `type Grid = Record<string, { photos: WallpaperPhoto[]; cursor?: string; fetchedAt: number }>`
  - `readCache(grid: unknown, key: string, now: number): Grid[string] | null` (null for a missing, stale or malformed grid, incl. the old single-object shape)
  - `writeCache(grid: unknown, key: string, entry: Grid[string]): Grid` (keeps the 10 newest by `fetchedAt`)
  - `mergeBatch(shown: WallpaperPhoto[], incoming: WallpaperPhoto[]): { photos: WallpaperPhoto[]; added: number }` (drops ids already shown)
  - `shouldLoadMore(s: { loading: boolean; done: boolean; batches: number; error: boolean }): boolean`

- [ ] **Step 1: Write the failing tests:**
  - `cacheKey` values above.
  - `readCache`: fresh entry returned; entry 24 h + 1 ms old → null; `{ photos: [...], pickId: 'x' }` (old shape) → null; `null` → null.
  - `writeCache`: 11 entries in → 10 out, the oldest `fetchedAt` gone; writing an existing key replaces it.
  - `mergeBatch`: shown `[a, b]`, incoming `[b, c]` → photos `[a, b, c]`, `added 1`.
  - `shouldLoadMore`: true for `{ loading: false, done: false, batches: 1, error: false }`; false when loading, when done, at `batches: 6`, and when `error` is true.
- [ ] **Step 2: Run** `pnpm test` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test` → pass.

### Task 6: WallpapersSection rewrite

**Files:**
- Modify: `src/windows/settings/WallpapersSection.tsx` (Unsplash list, favourites, Refresh, `featured()` / `featuredTree()` and `COMMONS_CATEGORIES` go; categories come from `WALLPAPER_CATEGORIES` with a local id → icon map: landscape, mountain_snow, water, waterfall, sailboat, forest, wb_twilight, foggy, telescope, location_city, architecture, church, local_florist, bird, pets)
- Modify: `src/windows/settings/Settings.tsx` only if the section's props change (they don't: `dryRun`)

**Interfaces:**
- Consumes: Task 1 (`WALLPAPER_CATEGORIES`, `DEFAULT_WALLPAPER_CATEGORY`, `WallpaperPhoto`, `sourceName`), Task 4 (`wallpapersFetch`, `wallpapersCredit`, the settings keys), Task 5 (all of it).

Behaviour (from the spec, Design › Settings › Wallpapers):
- Row "Get photos from": `Segmented` Commons | Wallhaven, descriptions "Free photos from Wikimedia Commons." / "Wallpapers uploaded to Wallhaven."; saves `wallpaperSource`, reloads the shown category.
- Row "Change wallpaper" (as built), no Refresh. Band first line: "Show 4K only" (11px semibold `fg`) with `Toggle`; saves `wallpaper4kOnly`, reloads.
- A click on a category or keyword: saves `wallpaperCategory`, loads page 1 (cache first via `readCache`). Keywords: `{ keywords }`; built-ins: `{ categoryId }`.
- Load more: a sentinel `div` at the end of the photo box, `IntersectionObserver` with the box as `root`; on intersect and `shouldLoadMore(...)` fetch the next page with the last `cursor`; `mergeBatch`; a batch adding 0 counts as `done`. Spinner row "Loading photos…" (grey 16px `progress_activity` + label) at the end while loading more; the full-height spinner only for page 1.
- Only page 1 is written to the cache (`writeCache`).
- Request token as today: a response for an older request is dropped.
- Card status bar: `user.name` for Commons; `${width}×${height}` for Wallhaven.
- Preview credit: Commons as built; Wallhaven: "On *Wallhaven*, 2562×1440" until `wallpapersCredit` returns, then "Uploaded by *name* to *Wallhaven*" + " (*original*)" when `origin` is set, then ", 2562×1440". No name when `user.name` is empty. Links open with `openExternal` (no UTM).

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Type-check** web config → no new errors; `pnpm test` → pass.
- [ ] **Step 3: Check in the app** (restart `pnpm dev`; Settings › Wallpapers): Commons loads Landscapes; switching to Wallhaven shows Landscapes from Wallhaven; 4K on reloads; scrolling the box to its end loads a second batch with the small spinner, no repeats; clicking three categories quickly ends on the last one clicked; a photo opens the preview with the right credit; Set as wallpaper only toasts (dry run). Ask Jasper before taking screenshots ([[few-screenshots]]).

### Task 7: Docs and cleanup

**Files:**
- Modify: `CLAUDE.md` (the `wallpapers.ts` row; the AppBar paragraph's "only when `MAIN_VITE_UNSPLASH_ACCESS_KEY` is set"; the env var list), `design/OPEN-QUESTIONS.md` (Built, not tested: the two Wallpapers entries become one for Commons + Wallhaven, incl. Set as wallpaper never run; Parked / Closed as fitting), `design/WALLPAPER-SOURCES.md` (Status: built), `src/components/Icon.tsx` (drop wallpaper-category mappings no longer used: `park`, `apartment`, `museum`, `travel_explore`, `travel`, `directions_walk`, `directions_car`, `nature`, `rocket_launch` only if unused elsewhere; `grep` each first)

- [ ] **Step 1: Edit** the docs; remove unused icon names after grepping each.
- [ ] **Step 2: Type-check** both configs and run `pnpm test` → clean / pass.
