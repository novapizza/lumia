# Logo exports

The aperture logo (`src/assets/logo.svg`) exported for use outside the app. Made by `python3 scripts/make-brand-exports.py` (Pillow + Google Chrome, like `pnpm icons`); run it again after any change to the logo instead of editing these files.

## website/

- `logo.svg`: the mark, trimmed to its circle. Transparent; the gaps and the hole show the page behind.
- `logo-64.png` to `logo-1024.png`: the same as PNG.
- `logo-tile.svg`, `logo-tile-512.png`, `logo-tile-1024.png`: the mark on the app icon's dark squircle tile (`#121020`), for places that want the app icon look.

## favicon/

```html
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
```

`site.webmanifest` icons: `icon-192.png` and `icon-512.png` (`"type": "image/png"`).

- `favicon.ico`: 16, 32 and 48 in one file, drawn with wider gaps so they stay open at tab size.
- `favicon.svg`: the mark with slightly wider gaps (browsers draw it at 16 to 32px).
- `apple-touch-icon.png`: 180, the tile filling the square (iOS rounds the corners itself).

## extension/

`icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`, in the names `extension/manifest.json` uses. The small ones have wider gaps; `icon128.png` keeps Chrome's 16px transparent margin around 96px of artwork. To ship them, copy them into `extension/`, bump the extension's version and publish it to the store. The extension draws its connection dot onto 16, 32 and 48 at runtime.
