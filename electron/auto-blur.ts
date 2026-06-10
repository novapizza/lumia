import { runOcr, dataUrlToBuffer } from './ocr'
import { detectSensitiveData } from './sensitive-detect'
import type { AutoBlurResult, AutoBlurSettings, SensitiveCategory } from './types'

const DEFAULT_SETTINGS: AutoBlurSettings = {
  enabled: true,
  autoBlurOnCapture: 'off',
  categories: {
    'email': true,
    'phone': true,
    'credit-card': true,
    'ssn': true,
    'api-key': true,
    'jwt': true,
    'private-key': true,
    'password': true,
    'bearer-token': true,
    'ip-address': true,
    'url-credentials': true
  },
  blurIntensity: 10
}

/**
 * Scan an image (data URL) for sensitive information.
 * Returns detected regions with bounding boxes — does NOT apply blur.
 */
export async function scanForSensitiveData(
  dataUrl: string,
  settings?: Partial<AutoBlurSettings>
): Promise<AutoBlurResult> {
  // Deep-merge `categories` — a plain shallow `{...DEFAULT, ...settings}` would
  // let a partial `categories` object replace the whole map and silently wipe
  // any category the caller didn't name, disabling its detection.
  const config: AutoBlurSettings = {
    ...DEFAULT_SETTINGS,
    ...settings,
    categories: { ...DEFAULT_SETTINGS.categories, ...(settings?.categories ?? {}) },
  }
  const enabledCategories = new Set(
    (Object.entries(config.categories) as [SensitiveCategory, boolean][])
      .filter(([, enabled]) => enabled)
      .map(([cat]) => cat)
  )

  const buffer = dataUrlToBuffer(dataUrl)

  // Step 1: OCR
  const ocrStart = performance.now()
  const words = await runOcr(buffer)
  const ocrTimeMs = Math.round(performance.now() - ocrStart)

  // Step 2: Regex detection
  const detectStart = performance.now()
  const regions = detectSensitiveData(words, enabledCategories)
  const detectTimeMs = Math.round(performance.now() - detectStart)

  return { regions, ocrTimeMs, detectTimeMs }
}
