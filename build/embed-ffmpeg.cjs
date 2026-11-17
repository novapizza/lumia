/**
 * electron-builder `afterPack` hook — embeds the MINIMAL, LGPL-only ffmpeg for
 * the arch being packaged into the app's Resources, so recordings can be
 * remuxed / trimmed losslessly on every platform/arch.
 *
 * Only the minimal builds from build/build-minimal-ffmpeg-{win,mac}.sh are
 * accepted. There is deliberately NO fallback to the ffmpeg-static download:
 * those binaries are GPLv3 builds (--enable-gpl --enable-version3 with
 * libx264 / libx265), which a closed-source app must not redistribute. A
 * release that cannot find the minimal binary fails loudly instead.
 *
 * Arch matrix:
 *   - darwin: native x64 / arm64 minimal builds (ffmpeg-darwin-<arch>).
 *   - win32 : x64 only. Windows-on-ARM runs the x64 build via emulation —
 *             a quick `-c copy` remux under emulation is fine.
 *
 * The binary is placed BEFORE electron-builder's code-signing step, so on
 * macOS it gets signed (and thus passes notarization) along with the bundle.
 */
const fs = require('fs')
const path = require('path')
const { Arch } = require('electron-builder')

// Configure flags that would make the binary non-LGPL. ffmpeg embeds its full
// configure line in the executable (it's what `ffmpeg -version` prints), so a
// byte scan catches a wrong binary without having to run it — which matters
// because the mac x64 binary is packaged on an arm64 host.
const FORBIDDEN_FLAGS = ['--enable-gpl', '--enable-nonfree', '--enable-version3']

function assertLgplOnly(binPath) {
  const bytes = fs.readFileSync(binPath)
  if (bytes.indexOf('--disable-autodetect') < 0) {
    // Not one of our minimal builds (or the configure line was stripped) —
    // can't vouch for its licence, so refuse it.
    throw new Error(`[embed-ffmpeg] ${binPath} is not a minimal Lumia ffmpeg build (no configure line found)`)
  }
  const hit = FORBIDDEN_FLAGS.find(f => bytes.indexOf(f) >= 0)
  if (hit) {
    throw new Error(`[embed-ffmpeg] ${binPath} was configured with ${hit} — only LGPL v2.1+ ffmpeg may ship with Lumia`)
  }
}

function firstExisting(candidates) {
  for (const p of candidates.filter(Boolean)) {
    try { if (fs.statSync(p).size > 0) return p } catch { /* missing */ }
  }
  return null
}

// Windows: CI sets LUMIA_FFMPEG_WIN_X64 (or downloads the ffmpeg-win artifact
// into build/minimal-ffmpeg/dist/); locally `pnpm ffmpeg:min:win` puts it there.
function resolveMinimalWinFfmpeg() {
  return firstExisting([
    process.env.LUMIA_FFMPEG_WIN_X64,
    path.join(__dirname, 'minimal-ffmpeg', 'dist', 'ffmpeg.exe'),
  ])
}

// macOS: the DMG is built per arch, so each arch needs its own binary.
// CI's release-mac builds both into build/minimal-ffmpeg/dist/; locally
// `pnpm ffmpeg:min:mac`, or LUMIA_FFMPEG_MAC_X64 / _ARM64 point at them.
function resolveMinimalMacFfmpeg(archName) {
  return firstExisting([
    process.env[`LUMIA_FFMPEG_MAC_${String(archName).toUpperCase()}`],
    path.join(__dirname, 'minimal-ffmpeg', 'dist', `ffmpeg-darwin-${archName}`),
  ])
}

exports.default = async function embedFfmpeg(context) {
  const platform =
    context.electronPlatformName === 'darwin' ? 'darwin' :
    context.electronPlatformName === 'win32' ? 'win32' : null
  if (!platform) return // linux not targeted

  const archName = Arch[context.arch] // 'x64' | 'arm64' | 'ia32'

  const exeName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const resourcesDir = platform === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
  const dest = path.join(resourcesDir, exeName)

  const minimal = platform === 'win32' ? resolveMinimalWinFfmpeg() : resolveMinimalMacFfmpeg(archName)
  if (!minimal) {
    const how = platform === 'win32'
      ? 'run `pnpm ffmpeg:min:win` (Docker) or set LUMIA_FFMPEG_WIN_X64'
      : `run \`pnpm ffmpeg:min:mac\` on macOS or set LUMIA_FFMPEG_MAC_${String(archName).toUpperCase()}`
    throw new Error(`[embed-ffmpeg] no minimal ffmpeg for ${platform}-${archName} — ${how}. ` +
      'The full ffmpeg-static binary is GPL and is never shipped.')
  }

  assertLgplOnly(minimal)
  fs.copyFileSync(minimal, dest)
  if (platform !== 'win32') fs.chmodSync(dest, 0o755)
  console.log(`[embed-ffmpeg] embedded minimal LGPL ffmpeg (${platform}-${archName}) → ${dest} (${(fs.statSync(dest).size / 1048576).toFixed(1)} MB)`)
}
