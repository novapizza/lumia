import { app, nativeImage } from 'electron'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import type { OcrWord } from './types'

// ── macOS: Apple Vision via compiled Swift binary ────────────────

function getVisionBinaryPath(): string {
  // In dev: electron/helpers/ocr-vision
  // In production: resources/ocr-vision
  const devPath = resolve(__dirname, '..', 'electron', 'helpers', 'ocr-vision')
  if (existsSync(devPath)) return devPath

  const prodPath = join(process.resourcesPath ?? app.getAppPath(), 'ocr-vision')
  if (existsSync(prodPath)) return prodPath

  // Try relative to __dirname (built output)
  const builtPath = resolve(__dirname, '..', '..', 'electron', 'helpers', 'ocr-vision')
  if (existsSync(builtPath)) return builtPath

  throw new Error('ocr-vision binary not found')
}

async function ocrMacOS(imageBuffer: Buffer): Promise<OcrWord[]> {
  const tmpPath = join(tmpdir(), `lumia-ocr-${randomUUID()}.png`)
  writeFileSync(tmpPath, imageBuffer)

  try {
    const binaryPath = getVisionBinaryPath()
    const img = nativeImage.createFromBuffer(imageBuffer)
    const { width, height } = img.getSize()

    const output = await new Promise<string>((resolve, reject) => {
      // maxBuffer bumped from Node's 1 MB default: a dense 4K screenshot's
      // JSON stdout (one entry per recognised word) can easily exceed 1 MB
      // and would otherwise abort with ERR_CHILD_PROCESS_STDIO_MAXBUFFER.
      execFile(binaryPath, [tmpPath], { timeout: 30000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message))
        else resolve(stdout)
      })
    })

    const results: Array<{ text: string; x: number; y: number; width: number; height: number; confidence: number }> = JSON.parse(output)

    return results.map(item => ({
      text: item.text,
      bbox: {
        // Vision framework uses bottom-left origin with normalized 0-1 coords
        x: Math.round(item.x * width),
        y: Math.round((1 - item.y - item.height) * height),
        width: Math.round(item.width * width),
        height: Math.round(item.height * height)
      },
      confidence: item.confidence
    }))
  } finally {
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
  }
}

// ── Windows: WinRT OCR ──────────────────────────────────────────

// Thrown when the native OCR backend can't be loaded at all (module/binary
// missing). Distinct from a per-image runtime failure: a load-time error
// means native OCR is permanently unavailable for this process, whereas a
// runtime error should only fall back for the one call that failed.
class NativeOcrUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NativeOcrUnavailableError'
  }
}

// `node-windows-ocr` is an OPTIONAL, UNBUNDLED dependency — it is not in
// package.json and won't be present in most installs (it's marked `external`
// in the main rollup config, so the build never tries to bundle it). Load it
// through this helper so a missing module is reported once as a load-time
// unavailability (NativeOcrUnavailableError) rather than crashing the OCR
// path; the caller then latches native OCR off and uses the Tesseract.js
// fallback. Typed loosely on purpose — the module ships no types and isn't
// installed, so we describe only the `recognize` shape we actually use.
interface WindowsOcrModule {
  recognize(path: string): Promise<{
    lines?: Array<{
      words: Array<{
        text: string
        rect: { x: number; y: number; width: number; height: number }
        confidence?: number
      }>
    }>
  }>
}
let _winOcrModule: WindowsOcrModule | null = null
async function loadWindowsOcr(): Promise<WindowsOcrModule> {
  if (_winOcrModule) return _winOcrModule
  try {
    _winOcrModule = (await import('node-windows-ocr')) as unknown as WindowsOcrModule
    return _winOcrModule
  } catch (err) {
    throw new NativeOcrUnavailableError(
      `node-windows-ocr unavailable (optional dependency not installed): ${(err as Error)?.message ?? err}`
    )
  }
}

async function ocrWindows(imageBuffer: Buffer): Promise<OcrWord[]> {
  const { recognize } = await loadWindowsOcr()

  const tmpPath = join(tmpdir(), `lumia-ocr-${randomUUID()}.png`)
  writeFileSync(tmpPath, imageBuffer)

  try {
    const result = await recognize(tmpPath)
    const img = nativeImage.createFromBuffer(imageBuffer)
    const { width, height } = img.getSize()

    const words: OcrWord[] = []
    if (result.lines) {
      for (const line of result.lines) {
        for (const word of line.words) {
          words.push({
            text: word.text,
            bbox: {
              x: Math.round(word.rect.x * width),
              y: Math.round(word.rect.y * height),
              width: Math.round(word.rect.width * width),
              height: Math.round(word.rect.height * height)
            },
            confidence: word.confidence ?? 1
          })
        }
      }
    }
    return words
  } finally {
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
  }
}

// ── Tesseract.js fallback ───────────────────────────────────────

// `eng.traineddata` is shipped locally so the fallback works OFFLINE — without
// langPath/cachePath set, tesseract.js fetches the ~12 MB model from a CDN and
// fails when there's no network. In production the file is copied to
// process.resourcesPath via electron-builder's extraResources; in dev it sits
// at the repo root next to package.json.
//   - langPath:  dir that CONTAINS eng.traineddata (loaded from disk, not CDN)
//   - cachePath: writable dir for tesseract's runtime cache
//   - gzip:false: the shipped eng.traineddata is a raw (un-gzipped) model
function getTraineddataDir(): string {
  // Dev: repo root is two levels up from the built out/main dir.
  return app.isPackaged ? process.resourcesPath : resolve(__dirname, '..', '..')
}

// A fresh Tesseract worker costs a worker_threads spawn + WASM init +
// traineddata load (~hundreds of ms) — far too much to pay on every scan.
// We keep a lazily-created singleton, reuse it across calls, recreate it on
// error, and terminate it on app quit. A single in-flight init promise guards
// against concurrent createWorker races.
type TesseractWorker = Awaited<ReturnType<typeof import('tesseract.js').createWorker>>
let _tessWorker: TesseractWorker | null = null
let _tessWorkerInit: Promise<TesseractWorker> | null = null

async function getTesseractWorker(): Promise<TesseractWorker> {
  if (_tessWorker) return _tessWorker
  if (_tessWorkerInit) return _tessWorkerInit

  _tessWorkerInit = (async () => {
    const Tesseract = await import('tesseract.js')
    const worker = await Tesseract.createWorker('eng', undefined, {
      langPath: getTraineddataDir(),
      cachePath: app.getPath('userData'),
      gzip: false,
    })
    _tessWorker = worker
    return worker
  })()

  try {
    return await _tessWorkerInit
  } catch (err) {
    // Init failed — clear the cached worker so the next call retries cleanly.
    _tessWorker = null
    throw err
  } finally {
    _tessWorkerInit = null
  }
}

async function terminateTesseractWorker(): Promise<void> {
  const worker = _tessWorker
  _tessWorker = null
  if (worker) {
    try { await worker.terminate() } catch { /* ignore */ }
  }
}

// Tear the singleton worker down on quit so we don't leak the worker thread.
app.on('will-quit', () => { void terminateTesseractWorker() })

async function ocrTesseract(imageBuffer: Buffer): Promise<OcrWord[]> {
  const worker = await getTesseractWorker()

  try {
    // v7: must pass { blocks: true } as 3rd arg to get word-level bboxes
    const { data } = await worker.recognize(imageBuffer, {}, { blocks: true })
    const words: OcrWord[] = []

    // Traverse blocks → paragraphs → lines → words
    if (data.blocks) {
      for (const block of data.blocks) {
        if (!block.paragraphs) continue
        for (const para of block.paragraphs) {
          if (!para.lines) continue
          for (const line of para.lines) {
            if (!line.words) continue
            for (const w of line.words) {
              words.push({
                text: w.text,
                bbox: {
                  x: w.bbox.x0,
                  y: w.bbox.y0,
                  width: w.bbox.x1 - w.bbox.x0,
                  height: w.bbox.y1 - w.bbox.y0
                },
                confidence: w.confidence / 100
              })
            }
          }
        }
      }
    }

    return words
  } catch (err) {
    // A worker can wedge after an internal error — drop it so the next scan
    // spins up a fresh one instead of reusing the broken instance.
    await terminateTesseractWorker()
    throw err
  }
}

// ── Public API ───────────────────────────────────────────────────

let nativeAvailable: boolean | null = null

async function checkNativeOcr(): Promise<boolean> {
  if (nativeAvailable !== null) return nativeAvailable

  try {
    if (process.platform === 'darwin') {
      getVisionBinaryPath() // throws if binary not found
      nativeAvailable = true
    } else if (process.platform === 'win32') {
      // node-windows-ocr is optional/unbundled — loadWindowsOcr throws a
      // NativeOcrUnavailableError (caught below, logged once) when absent.
      await loadWindowsOcr()
      nativeAvailable = true
    } else {
      nativeAvailable = false
    }
  } catch (err) {
    // Logged once: this is the single load-time check, gated by the
    // `nativeAvailable !== null` short-circuit above, so it won't spam.
    console.warn('[OCR] Native OCR unavailable, using Tesseract.js fallback:', (err as Error)?.message ?? err)
    nativeAvailable = false
  }
  return nativeAvailable
}

/**
 * Run OCR on an image buffer (PNG). Returns words with pixel bounding boxes.
 * macOS: Apple Vision (native binary), Windows: WinRT, fallback: Tesseract.js
 */
export async function runOcr(imageBuffer: Buffer): Promise<OcrWord[]> {
  const hasNative = await checkNativeOcr()

  if (hasNative) {
    try {
      if (process.platform === 'darwin') return await ocrMacOS(imageBuffer)
      if (process.platform === 'win32') return await ocrWindows(imageBuffer)
    } catch (err) {
      // Only LOAD-TIME failures (module/binary missing) permanently disable
      // native OCR. A per-image RUNTIME failure (timeout on a huge image,
      // maxBuffer overflow, one malformed JSON line) falls back to Tesseract
      // for THIS call but keeps native OCR enabled for the next one.
      if (err instanceof NativeOcrUnavailableError) {
        console.warn('[OCR] Native OCR unavailable, switching to Tesseract.js:', err.message)
        nativeAvailable = false
      } else {
        console.warn('[OCR] Native OCR failed for this image, falling back to Tesseract.js for this call:', err)
      }
    }
  }

  return ocrTesseract(imageBuffer)
}

/**
 * Convert a data URL to a PNG Buffer for OCR processing.
 */
export function dataUrlToBuffer(dataUrl: string): Buffer {
  const img = nativeImage.createFromDataURL(dataUrl)
  return img.toPNG()
}
