/**
 * electron-builder `afterPack` step — drop Chromium locale `.pak` files we
 * don't need. Chromium ships ~55 of them (~40 MB); it falls back to en-US when
 * a locale is absent, and Lumia's own UI strings live in the app bundle (not
 * these paks), so keeping only en-US is safe and trims ~40 MB of unpacked
 * weight (~8-10 MB off the installer after LZMA).
 *
 * Windows keeps the paks in a flat <appOutDir>/locales dir, which we prune here.
 * macOS stores them as .lproj inside the pre-signed Electron Framework, so it's
 * pruned via electron-builder's `electronLanguages` option instead (see the mac
 * config) — doing it by hand would break the framework's code signature. Hence
 * this hook is Windows-only. Runs before code-signing; the flat paks aren't
 * signed, so removing them here is safe.
 */
const fs = require('fs')
const path = require('path')

// Keep en-US (Chromium's fallback). Add more here if you ever ship localized
// system UI (e.g. 'vi.pak').
const KEEP = new Set(['en-US.pak'])

exports.default = async function pruneLocales(context) {
  if (context.electronPlatformName !== 'win32') return

  const localesDir = path.join(context.appOutDir, 'locales')
  let entries
  try {
    entries = fs.readdirSync(localesDir)
  } catch {
    return // no locales dir (nothing to do)
  }

  let removed = 0
  let freedBytes = 0
  for (const name of entries) {
    if (!name.endsWith('.pak') || KEEP.has(name)) continue
    const p = path.join(localesDir, name)
    try {
      freedBytes += fs.statSync(p).size
      fs.rmSync(p)
      removed++
    } catch { /* leave it if we can't remove it */ }
  }

  console.log(`[prune-locales] removed ${removed} locale pak(s) (${(freedBytes / 1048576).toFixed(1)} MB), kept ${[...KEEP].join(', ')}`)
}
