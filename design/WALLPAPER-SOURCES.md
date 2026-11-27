# Wallpaper sources

Design for Settings › Wallpapers' photo sources (2026-11-25). Status: built 2026-11-25; checked and adjusted by Jasper in the app 2026-11-26 (see After the build). Calls made without asking are marked *(my call)*.

## Why

Wallpapers came from Unsplash only, with an access key built into the app. Releases are built without that key (`release.yml` passes no Unsplash secret), so released builds never showed the feature. Keys users bring themselves don't work out either: Pexels has paused new API keys, and a new Unsplash key takes weeks to be approved. Jasper wants sources that work for everyone with nothing to sign up for: **Wikimedia Commons** (default) and **Wallhaven**, chosen in Settings.

## Goals

- A **source choice** in Settings › Wallpapers: Commons (default) or Wallhaven. Neither needs a key or an account.
- **One way of picking for both sources:** the same category list, one category at a time, a click shows its photos straight away. Switching source keeps the picked category.
- **More photos by scrolling:** the photo box loads another batch when you reach its end. No Refresh button.
- **A 4K filter** (Jasper, 2026-11-25): only photos at least 3840×2160. Probed on Wallhaven with anime allowed: mountains 5,359, lake 1,440, interior 646, birds 2,280.
- Each source's knowledge (how a category becomes a search, its API, its credit) in **one adapter file per source** in the main process.

## Non-goals

- Unsplash, Pexels, Pixabay. Unsplash and Pexels need keys users can't get quickly; Pixabay's normal keys only give 1280px images (checked 2026-11-25). The Unsplash code and the `MAIN_VITE_UNSPLASH_ACCESS_KEY` build variable go.
- API keys of any kind (nothing to store, nothing to protect).
- Changing how the wallpaper is applied (`setDesktopWallpaper`: download, then the OS call).
- Per-display wallpapers, scheduled rotation.

## Anti-goals

- Sources behaving differently in the UI (different lists, multi-select, Refresh for one). Jasper chose one way for all.
- Not-safe-for-work images. Wallhaven is asked for SFW only, in its General and Anime categories (anime allowed by Jasper, 2026-11-25; People stays out); it relies on community tags, a risk Jasper accepted.
- Error text naming internals (feedback rule, 2026-11-25).
- Dev builds changing the Mac's desktop: the dry run (`dryRun` in `Settings.tsx`, TEMPORARY) stays until the Wallpapers review is locked.

## Constraints

- Electron main does all network calls; the renderer goes through the preload bridge (three places per IPC channel).
- Design rules: STYLEGUIDE (Settings rows, `Segmented` for every single select, `BUTTON`, Hover, Voice). The category band reuses the Background panel's fold (`components/CaretDivider.tsx` + the 0fr ↔ 1fr grid), already built.
- **Commons:** anonymous, rate limited (a burst of about 10 quick calls got HTTP 429 in testing). Wikimedia asks for an identifying User-Agent (the app's name only, as built).
- **Wallhaven** (probed 2026-11-25, no key): `GET https://wallhaven.cc/api/v1/search` with `q`, `categories=110` (General + Anime, no People), `purity=100` (SFW only), `atleast=1920x1080` (or `3840x2160` with 4K only), `ratios=landscape`, `sorting=random`; returns 24 per page and a `seed`; passing `seed` + `page` continues the same random order. Each hit has `path` (full image, `w.wallhaven.cc`), `thumbs.large` / `thumbs.small` (`th.wallhaven.cc`), `dimension_x/y`, `url` (its page), `source` (often empty). `ratios=landscape` let a 1.26 ratio through, so the adapter filters shape itself. The uploader is only in `GET /api/v1/w/:id` (one more call per photo; the probe's was "deleted"). Wallhaven documents a limit of 45 requests a minute (unverified).
- **Rights:** Commons photos carry free licences and the credit names author and licence. Wallhaven's are user uploads without a licence, often other people's work; Jasper accepted that (2026-11-25). Credit names Wallhaven and links the image's page, and its original source when Wallhaven knows it.

## Approaches

Considered, before Unsplash and Pexels dropped out:

- **A. One adapter per source in the main process (picked).** `electron/wallpaper-sources/{commons,wallhaven}.ts`, one interface, each with its own category table. The renderer sends the source and a category id or keywords. Trade-off: more files, but a source's knowledge in one place, and another source later is one file.
- B. Each category in the renderer carries every source's search; main only makes HTTP calls. Source knowledge split across processes.
- C. Plain keywords for every source. Commons gets sloppy full-text matches (a map for "mountains", a duck for "lake").

Jasper picked A. It still fits with two sources.

## Design

### Settings › Wallpapers, top to bottom

One `Group`:

1. **Row "Get photos from"**: a `Segmented` with **Wikimedia** | **Wallhaven** ("Commons" alone was unclear, Jasper 2026-11-25) *(my call: two options make it a single select, which the style guide draws as Segmented, not a dropdown)*. Description per source: Commons "Free photos from Wikimedia Commons."; Wallhaven "Wallpapers uploaded to Wallhaven." *(my call)*
2. **Row "Change desktop wallpaper"** (as built), description "Photos from Landscapes. Click one to preview it.", the **Filter** button on the right. No Refresh. Left of Filter, a 192px **search field** (placeholder "Search", search icon, × to clear): Enter searches the current source with the words as typed; the description reads "Results for *words*."; no category is marked meanwhile; a category click, × or Esc ends the search; switching source runs it on the other source. Not saved, and nothing searches per keystroke (Wikimedia's rate limit).
3. **The category band** under it (as built): the ^ under Filter, `content` fill, 200ms fold. The 15 categories ("Show 4K only" moved out to a row of its own under "Get photos from", description "Only photos at least 3840×2160.", Jasper 2026-11-25), the shown one in accent;  Turning 4K on or off reloads the shown category. (A search field replaced "your own keywords" and "Add keywords", Jasper 2026-11-26: see row 2.)
   - The toggle works for **both sources** *(my call, following "one way for all")*: Commons gets `filew:>3839` instead of `>1919` and the adapter checks the height (at least 2160). Commons' featured pictures are mostly large, so most categories keep enough; a category that comes back empty shows "No photos found".
4. **The photo box** (as built: 3 columns, max 320px tall, scrolls on its own). When its end comes into view, the next batch loads (`IntersectionObserver` on a sentinel at the end), with a small spinner row ("Loading photos…") at the end while it loads. Error: the error-toast-style box above the photos (as built), the last photos kept.

Switching source shows the same category from the other source straight away; Anime falls back to Landscapes on Wikimedia, which has no anime.

### Categories

One list for both sources (the 15 reviewed on 2026-11-25). Landscapes is the default. The renderer holds only ids, labels and icons; each adapter maps ids to its own search:

| Category | Commons (featured-picture sets, as built) | Wallhaven `q` |
|---|---|---|
| Landscapes | landscapes | `landscape -city` |
| Mountains | mountains | `mountains` |
| Lakes | lakes, bodies of water | `lake` |
| Waterfalls | waterfalls, watercourses | `waterfall` |
| Coast | beaches, coasts, islands, lighthouses | `coast -"coast guard"` |
| Forests | forests, trees | `forest` |
| Sunsets | sunsets, sunrises, twilights | `sunset` |
| Clouds | clouds, fog | `clouds` |
| Space | astronomy (with subcategories) | `space` |
| Cities | cityscapes, skylines | `cityscape` |
| Architecture | buildings, architecture, bridges, castles | `architecture` |
| Interiors | ceilings, building interiors | `interior` |
| Flowers | flowers | `flowers` |
| Birds | birds in flight | `birds` |
| Animals | mammals (with subcategories) | `animals` |
| Anime (Wallhaven only, Jasper 2026-11-25) | not offered | Wallhaven's Anime section, `categories=010`, no word |
| Abstract (Wallhaven only, Jasper 2026-11-26) | not offered | `abstract` |
| Dark (Wallhaven only, Jasper 2026-11-26) | not offered | `dark` |
| Minimal (Wallhaven only, Jasper 2026-11-26) | not offered | `minimalism` |
| Gradients (Wallhaven only, Jasper 2026-11-26) | not offered | `gradient` |
| 3D (Wallhaven only, Jasper 2026-11-26) | not offered | `3D` |
| Fantasy (Wallhaven only, Jasper 2026-11-26) | not offered | `fantasy art` |
| Sci-Fi (Wallhaven only, Jasper 2026-11-26) | not offered | `science fiction` |
| Games (Wallhaven only, Jasper 2026-11-26) | not offered | `video games` |
| Cars (Wallhaven only, Jasper 2026-11-26) | not offered | `car` |

A search goes to either source as typed (Commons: searched among all featured pictures). The Wallhaven words are a starting point; Wallhaven's tags are single words, and `q` also takes `+tag` / `-tag`, so the builder may tune them by looking at results (e.g. `-anime`).

### Adapters (main process)

`electron/wallpaper-sources/` with one file per source and an `index.ts` that picks one:

```ts
type SourceId = 'commons' | 'wallhaven'
interface WallpaperQuery { categoryId?: string; keywords?: string; uhd: boolean; page: number; cursor?: string }  // uhd: 4K only
interface WallpaperBatch { photos: WallpaperPhoto[]; cursor?: string; done: boolean }
interface WallpaperSource {
  id: SourceId
  fetch(q: WallpaperQuery): Promise<WallpaperBatch>
  credit?(photo: WallpaperPhoto): Promise<Partial<WallpaperPhoto>>  // extra credit details, fetched when the preview opens
}
```

- Every adapter returns desktop-shaped photos (ratio 1.3 to 2.4, at least 1920px wide, or 3840×2160 with `uhd`) in one shape. Rename `UnsplashPhoto` to `WallpaperPhoto` (both copies: `electron/wallpapers.ts` and `src/types.ts`), keeping `source` and `license`; drop the Unsplash-only fields (`blurHash`, `links.downloadLocation`) *(my call)*.
- **Commons:** move `electron/commons-wallpapers.ts` in; its category table moves there from `WallpapersSection.tsx`. Random order (`gsrsort=random`), so every page is a new random batch; the renderer drops ids already shown. `done` when a batch adds nothing new.
- **Wallhaven:** `GET /api/v1/search` with the parameters above. Page 1 returns a `seed`; the adapter hands it back as `cursor`, and later pages send `seed` + `page`. `done` at `last_page`. Image links: `thumbs.small` for the cards, `thumbs.large` for the preview, `path` for the wallpaper. Sends the same "Lumia" User-Agent.
- **Credit** for Wallhaven: `credit()` calls `/api/v1/w/:id` when the preview opens, for the uploader's name and `source` *(my call: one call per preview, not per card, which would be 24 extra calls per batch)*.
- Image hosts allowed for the wallpaper download (`isWallpaperImageUrl`): Wikimedia's (as built) and `w.wallhaven.cc`; drop Unsplash's.
- Errors: 429 → "Too many requests to Wallhaven. Try again in a minute." (Commons' as built); other failures → "Couldn't reach Wallhaven" with the HTTP status in the reason line.

### Loading more

- The renderer asks for page 1 on a category click (or a source switch), then the next page as the sentinel comes into view, one request at a time.
- No cap (Jasper, 2026-11-25; a 6-batch cap, left over from Unsplash's 50 requests an hour, was dropped): loading stops only when the adapter says `done` or a request fails. At the end a Caption-rank line says "That's all for Mountains."
- The cache keeps the first batch per source + category in memory for one visit to Settings (10 entries, 24 hours); leaving Settings drops it (Jasper, 2026-11-25; it was saved in `settings.json` as `wallpaperGrid`, which is now only cleared).

### IPC

- `wallpapers:fetch({ source, categoryId | keywords, uhd, page, cursor })` → `{ ok: true, photos, cursor, done } | { ok: false, error }`.
- `wallpapers:credit(photo)` → extra credit fields (Wallhaven only; Commons returns nothing).
- `wallpapers:setAsWallpaper` stays.
- `wallpapers:random`, `wallpapers:source`, `wallpapers:trackDownload` go.

### Settings data

- `wallpaperSource: 'commons' | 'wallhaven'`, default `'commons'`.
- `wallpaperCategory: string | null`: the shown category id (built-in or custom), default Landscapes. Replaces `wallpaperCommonsCategory` (added 2026-11-25, never released) and the old `wallpaperCategories` favourites (dropped; the feature never shipped).
- `wallpaper4kOnly: boolean`, default `false`.
- `wallpaperCustomCategories` goes (2026-11-26: the search field replaced saved keywords).
- `wallpaperGrid`: becomes `{ ["source:categoryId:uhd"]: { photos, cursor, fetchedAt } }`.

### Credit line (the preview dialog)

- Commons (as built): "Photo by *Author* on *Wikimedia Commons* (CC BY-SA 4.0), 4302×2860".
- Wallhaven: "Uploaded by *name* to *Wallhaven*, 2562×1440"; the name links to the uploader's Wallhaven page; when the image has a `source`, add "(*original*)" linked to it *(my call on the wording; Voice rules apply)*. While `credit()` loads, show "On *Wallhaven*, 2562×1440". A deleted uploader, or a failed lookup, shows no name: "Uploaded to *Wallhaven*" (Jasper, 2026-11-25).
- The card's status bar: the Commons author; for Wallhaven, the resolution (no extra call per card) *(my call)*.

## Decided by Jasper

- Commons the default; Wallhaven as the other source; no keys (2026-11-25). Wallhaven's rights and content risks accepted.
- Approach A (adapters in main).
- One way for all sources: one list, one category at a time.
- Load more on scroll, no Refresh.
- Unsplash, Pexels, Pixabay out.
- A 4K filter; Wallhaven includes anime (2026-11-25).

## Left to the builder

- Tuning the Wallhaven words per category by looking at results; whether `sorting=random` or `toplist` (with a time range) gives better-looking batches.
- The sentinel's threshold and the spinner row (the dialogs' wait: grey 16px spinner + label).
- Removing the Unsplash code paths, the env variable from `.env.example` and CLAUDE.md, and the unused category icon mappings in `Icon.tsx`.

## After the build (2026-11-25 / 26, Jasper in the app)

- **Wallhaven:** credit "Uploaded to Wallhaven" when the uploader lookup fails; Coast searches `coast -"coast guard"`, Landscapes `landscape -city`; 10 Wallhaven-only categories (Abstract, Dark, Minimal, Gradients, 3D, Fantasy, Sci-Fi, Anime (its own section, `categories=010`), Games, Cars). Switching to Wikimedia from one of them goes back to Landscapes.
- **Labels:** the source switch reads Wikimedia | Wallhaven; the row "Change desktop wallpaper"; "Show 4K only" is a row of its own.
- **Search** replaced "your own keywords": a 32px button that slides open to a 192px field; Enter searches the current source, a ↵ keycap shows while the words aren't searched yet, Esc / × / a category click end it. Not saved.
- **Loading:** no batch cap (it was a leftover from Unsplash's limits); the end of a category says "That's all for Mountains."; the first batch per source + category is cached in memory for the visit only (`wallpaperGrid` in settings.json is now only cleared).
- **Preview:** sized from the photo's ratio (no bars), at most 480px high and fitting a 900×600 window (the credit row is measured); the card's thumbnail first, then the sharp image (Wallhaven's full file, Wikimedia's 1920px); Wallhaven cards use the 432px 16:9 thumbnail.
- **Set as wallpaper** really sets it in dev builds too (the dry run is gone; Claude never clicks it).
- **Icons:** Landscapes is a custom snowy mountain with a pine at its left (`MountainTree`); Mountains the plain mountain; Anime swords; the band keeps icon + name (icon-only tried and dropped).
- **Parked:** wallpaper per screen; undo wallpaper change (OPEN-QUESTIONS).
