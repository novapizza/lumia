/**
 * electron-builder `afterPack` hook — embeds the correct ffmpeg binary for the
 * arch being packaged into the app's Resources, so recordings can be remuxed
 * to a seekable WebM on every platform/arch.
 *
 * Why a hook (vs. just bundling ffmpeg-static): ffmpeg-static only downloads
 * ONE binary — the build host's arch — at install time. The release builds
 * both x64 AND arm64 per platform, so the non-host arch would otherwise ship a
 * binary that can't run. electron-builder calls afterPack once per arch, so we
 * fetch the matching ffmpeg here and drop it into that build's Resources.
 *
 * Arch matrix (ffmpeg-static release assets):
 *   - darwin: native x64 / arm64 (both exist) → exact match.
 *   - win32 : only x64 exists (no win32-arm64). Windows-on-ARM runs x64 via
 *             built-in emulation, so the x64 binary is used for both — a quick
 *             `-c copy` remux under emulation is fine.
 *
 * The binary is placed BEFORE electron-builder's code-signing step, so on
 * macOS it gets signed (and thus passes notarization) along with the bundle.
 *
 * Failure is fatal: a release that silently shipped without ffmpeg would make
 * every recording non-seekable, so we'd rather fail the build loudly.
 */
const https = require('https')
const zlib = require('zlib')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Arch } = require('electron-builder')

// ffmpeg-static publishes its binaries under this release tag; read it from the
// installed package so the version stays in lockstep with the dev dependency.
function ffmpegReleaseTag() {
  try {
    const pkg = require('ffmpeg-static/package.json')
    return pkg['ffmpeg-static']['binary-release-tag']
  } catch {
    return 'b6.1.1' // matches ffmpeg-static@5.3.0
  }
}

function fetchToFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'))
    https.get(url, { headers: { 'User-Agent': 'lumia-build' } }, (res) => {
      const { statusCode, headers } = res
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume()
        return resolve(fetchToFile(headers.location, dest, redirects + 1))
      }
      if (statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${statusCode} for ${url}`))
      }
      const gunzip = zlib.createGunzip()
      const out = fs.createWriteStream(dest)
      res.on('error', reject)
      gunzip.on('error', reject)
      out.on('error', reject)
      out.on('finish', () => out.close(() => resolve()))
      res.pipe(gunzip).pipe(out)
    }).on('error', reject)
  })
}

async function downloadWithRetry(url, dest, attempts = 3) {
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      await fetchToFile(url, dest)
      return
    } catch (err) {
      lastErr = err
      try { fs.rmSync(dest, { force: true }) } catch { /* ignore */ }
      console.warn(`[embed-ffmpeg] download attempt ${i}/${attempts} failed: ${err.message}`)
    }
  }
  throw lastErr
}

exports.default = async function embedFfmpeg(context) {
  const platform =
    context.electronPlatformName === 'darwin' ? 'darwin' :
    context.electronPlatformName === 'win32' ? 'win32' : null
  if (!platform) return // linux not targeted

  const archName = Arch[context.arch] // 'x64' | 'arm64' | 'ia32'
  // ffmpeg-static has no win32-arm64; x64 runs on Windows ARM via emulation.
  const dlArch = platform === 'win32' ? 'x64' : (archName === 'arm64' ? 'arm64' : 'x64')

  const tag = ffmpegReleaseTag()
  const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${tag}/ffmpeg-${platform}-${dlArch}.gz`

  // Cache decompressed binaries across builds (4 arch variants at most).
  const cacheDir = path.join(os.tmpdir(), 'lumia-ffmpeg-cache', tag)
  fs.mkdirSync(cacheDir, { recursive: true })
  const cached = path.join(cacheDir, `ffmpeg-${platform}-${dlArch}`)
  if (!fs.existsSync(cached) || fs.statSync(cached).size === 0) {
    console.log(`[embed-ffmpeg] fetching ${url}`)
    await downloadWithRetry(url, cached)
  }

  // Destination Resources dir inside the just-packed app.
  const exeName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const resourcesDir = platform === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
  const dest = path.join(resourcesDir, exeName)

  fs.copyFileSync(cached, dest)
  if (platform !== 'win32') fs.chmodSync(dest, 0o755)

  console.log(`[embed-ffmpeg] embedded ffmpeg (${platform}-${dlArch}) for ${archName} → ${dest}`)
}
