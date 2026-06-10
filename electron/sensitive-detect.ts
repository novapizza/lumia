import { randomUUID } from 'crypto'
import type { OcrWord, SensitiveCategory, SensitiveRegion } from './types'

// ── Regex patterns per category ─────────────────────────────────

interface PatternDef {
  category: SensitiveCategory
  pattern: RegExp
  validate?: (match: string) => boolean
}

const PATTERNS: PatternDef[] = [
  {
    category: 'email',
    pattern: /[a-zA-Z0-9._%+\-]+\s*@\s*[a-zA-Z0-9\-]+(?:\s*\.\s*[a-zA-Z0-9\-]+)+/g
  },
  // US phone: (xxx) xxx-xxxx, +1 xxx-xxx-xxxx. Word boundaries + a required
  // separator/paren in the bare 10-digit form keep this from matching inside
  // long digit runs (timestamps, IDs, hashes), which the old all-separators-
  // optional pattern did.
  {
    category: 'phone',
    pattern: /(?:\+?1[-.\s])?(?:\(\d{3}\)[-.\s]?|\d{3}[-.\s])\d{3}[-.\s]?\d{4}\b/g
  },
  // Vietnamese phone: 0xxx xxx xxx, +84 xxx xxx xxx
  {
    category: 'phone',
    pattern: /(?:\+84[-.\s]?|0)\d{2,3}[-.\s]?\d{3}[-.\s]?\d{3}\b/g
  },
  // General international: +xx xxx xxxx xxxx, +xxx xxxxxxxxx (7-14 digits after country code)
  {
    category: 'phone',
    pattern: /\+\d{1,3}[-.\s]?\d{1,4}[-.\s]?\d{2,4}[-.\s]?\d{2,4}(?:[-.\s]?\d{1,4})?\b/g
  },
  {
    category: 'credit-card',
    pattern: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    validate: luhnCheck
  },
  {
    category: 'ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g
  },
  // AWS access keys
  {
    category: 'api-key',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g
  },
  // GitHub tokens
  {
    category: 'api-key',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}\b/g
  },
  // Google API keys
  {
    category: 'api-key',
    pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/g
  },
  // Stripe keys
  {
    category: 'api-key',
    pattern: /\b[sr]k_(?:live|test)_[0-9a-zA-Z]{24,}\b/g
  },
  // Slack tokens
  {
    category: 'api-key',
    pattern: /\bxox[boaprs]-[0-9a-zA-Z\-]{10,}\b/g
  },
  // OpenAI-style keys: sk-xxx, sk_xxx
  {
    category: 'api-key',
    pattern: /\bsk[-_][A-Za-z0-9\-_]{8,}\b/g
  },
  // AWS secret access keys (40-char base64)
  {
    category: 'api-key',
    pattern: /(?:aws[_-]?secret[_-]?access[_-]?key|secret[_-]?access[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}\b/gi
  },
  // Generic key=value secrets (lowered minimum from 16 to 8)
  {
    category: 'api-key',
    pattern: /(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|secret[_-]?key|private[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9\-_.~+/=]{8,}/gi
  },
  // .env style secrets: SECRET=xxx, TOKEN=xxx, KEY=xxx (standalone env var names)
  {
    category: 'api-key',
    pattern: /(?:^|[\s;])(?:[A-Z_]*(?:SECRET|TOKEN|KEY|CREDENTIAL|PASSWORD))\s*=\s*['"]?[A-Za-z0-9\-_.~+/=]{8,}/gm
  },
  // IBAN international bank account numbers
  {
    category: 'credit-card',
    pattern: /\b[A-Z]{2}\d{2}[-\s]?[A-Z0-9]{4}[-\s]?(?:[A-Z0-9]{4}[-\s]?){2,7}[A-Z0-9]{1,4}\b/g
  },
  {
    category: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
  },
  {
    category: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g
  },
  {
    category: 'password',
    pattern: /(?:password|passwd|pwd|pass)\s*[:=]\s*['"]?\S{4,}/gi
  },
  {
    category: 'bearer-token',
    pattern: /[Bb]earer\s+[A-Za-z0-9\-._~+/]+=*/g
  },
  {
    category: 'ip-address',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\s*\.\s*){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g
  },
  {
    category: 'url-credentials',
    pattern: /\bhttps?:\/\/[^:\s]+:[^@\s]+@[^\s]+/g
  },
  // Database / service connection strings: postgres://, mysql://, mongodb+srv://, redis://, amqp://, etc.
  {
    category: 'url-credentials',
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql|mariadb|cockroachdb|sqlite):\/\/[^:\s]+:[^@\s]+@[^\s"']+/g
  }
]

// ── Luhn checksum for credit card validation ────────────────────

function luhnCheck(value: string): boolean {
  const digits = value.replace(/[-\s]/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let alternate = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10)
    if (alternate) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alternate = !alternate
  }
  return sum % 10 === 0
}

// ── Span-to-bbox mapping ────────────────────────────────────────

interface WordSpan {
  wordIndex: number
  charStart: number
  charEnd: number
}

/**
 * Decide whether two consecutive OCR words are halves of a single token that
 * the engine split mid-line, rather than two genuinely separate words. OCR
 * routinely chops a long opaque token (JWT, API key) at an internal visual
 * gap into two "words" sitting on the same baseline almost touching. The
 * long-token patterns use `\b...\b` with no whitespace tolerance, so a token
 * split this way would never match — the headline auto-blur false negative.
 *
 * Heuristic (intentionally conservative to avoid gluing real prose, where
 * word spaces are wide):
 *   - same line: vertical ranges overlap by most of the smaller height, and
 *   - horizontally adjacent: the gap between them is a small fraction of the
 *     line height (a real inter-word space is far wider than a token's
 *     internal split).
 * When both hold we concatenate the two words with NO separator so the strict
 * pattern sees the reassembled token; otherwise we fall back to a space.
 * resolveBbox keys off per-word char ranges, so omitting the separator keeps
 * the offset→bbox mapping correct (the spans simply become contiguous).
 */
function isSplitToken(a: OcrWord, b: OcrWord): boolean {
  const ab = a.bbox, bb = b.bbox
  if (ab.height <= 0 || bb.height <= 0) return false
  // Same line: vertical overlap covers most of the shorter word's height.
  const overlapTop = Math.max(ab.y, bb.y)
  const overlapBottom = Math.min(ab.y + ab.height, bb.y + bb.height)
  const vOverlap = overlapBottom - overlapTop
  if (vOverlap < 0.6 * Math.min(ab.height, bb.height)) return false
  // b must follow a horizontally (reading order). Allow a tiny negative gap
  // for bboxes that slightly overlap.
  const gap = bb.x - (ab.x + ab.width)
  if (gap < -0.25 * ab.height) return false
  // Glue only when the gap is far narrower than a real word space (~half the
  // line height). A genuine space leaves a much wider gap.
  return gap <= 0.35 * Math.min(ab.height, bb.height)
}

/**
 * Join OCR words into a single string while maintaining a mapping from
 * character positions back to word indices + bboxes. Words are space-separated
 * by default, EXCEPT consecutive halves of an engine-split token (see
 * isSplitToken) which are concatenated with no separator so reassembled tokens
 * match the strict long-token patterns.
 */
function buildTextWithMapping(words: OcrWord[]): { text: string; spans: WordSpan[] } {
  const spans: WordSpan[] = []
  let text = ''

  for (let i = 0; i < words.length; i++) {
    const charStart = text.length
    text += words[i].text
    const charEnd = text.length
    spans.push({ wordIndex: i, charStart, charEnd })
    // Separator before the NEXT word: none if it's a split-token continuation
    // on the same line, otherwise a space.
    if (i < words.length - 1) {
      text += isSplitToken(words[i], words[i + 1]) ? '' : ' '
    }
  }

  return { text, spans }
}

/**
 * Given a match range [matchStart, matchEnd] in the joined text,
 * find all overlapping word spans and merge their bboxes.
 */
function resolveBbox(
  matchStart: number,
  matchEnd: number,
  spans: WordSpan[],
  words: OcrWord[]
): { x: number; y: number; width: number; height: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

  for (const span of spans) {
    // Check overlap: span [charStart, charEnd) overlaps [matchStart, matchEnd)
    if (span.charEnd > matchStart && span.charStart < matchEnd) {
      const bbox = words[span.wordIndex].bbox
      const wordLen = span.charEnd - span.charStart

      if (wordLen > 0 && (matchStart > span.charStart || matchEnd < span.charEnd)) {
        // Partial overlap — estimate sub-word bbox using character ratio
        const charWidth = bbox.width / wordLen
        const clipStart = Math.max(0, matchStart - span.charStart)
        const clipEnd   = Math.min(wordLen, matchEnd - span.charStart)
        const subX      = bbox.x + clipStart * charWidth
        const subW      = (clipEnd - clipStart) * charWidth

        minX = Math.min(minX, subX)
        minY = Math.min(minY, bbox.y)
        maxX = Math.max(maxX, subX + subW)
        maxY = Math.max(maxY, bbox.y + bbox.height)
      } else {
        // Full overlap — use entire word bbox
        minX = Math.min(minX, bbox.x)
        minY = Math.min(minY, bbox.y)
        maxX = Math.max(maxX, bbox.x + bbox.width)
        maxY = Math.max(maxY, bbox.y + bbox.height)
      }
    }
  }

  // Add padding around the detected region
  const pad = 4
  return {
    x: Math.max(0, minX - pad),
    y: Math.max(0, minY - pad),
    width: (maxX - minX) + pad * 2,
    height: (maxY - minY) + pad * 2
  }
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect sensitive data in OCR output using regex patterns.
 * Returns regions with bounding boxes for auto-blur.
 */
export function detectSensitiveData(
  words: OcrWord[],
  enabledCategories?: Set<SensitiveCategory>
): SensitiveRegion[] {
  if (words.length === 0) return []

  const { text, spans } = buildTextWithMapping(words)
  const regions: SensitiveRegion[] = []

  for (const def of PATTERNS) {
    if (enabledCategories && !enabledCategories.has(def.category)) continue

    // Reset regex lastIndex for global patterns
    const regex = new RegExp(def.pattern.source, def.pattern.flags)
    let match: RegExpExecArray | null

    while ((match = regex.exec(text)) !== null) {
      const matchText = match[0]

      // Run optional validation (e.g., Luhn for credit cards)
      if (def.validate && !def.validate(matchText)) continue

      const bbox = resolveBbox(match.index, match.index + matchText.length, spans, words)

      // Skip invalid bboxes (no overlapping words found)
      if (bbox.width <= 0 || bbox.height <= 0) continue

      regions.push({
        id: randomUUID(),
        category: def.category,
        text: matchText,
        bbox
      })
    }
  }

  // Deduplicate overlapping regions (same category, similar bbox)
  return deduplicateRegions(regions)
}

// Two genuinely-distinct occurrences of the same secret (e.g. an email shown
// twice on the same screen) yield non-overlapping bboxes — both must survive
// dedup. The threshold only catches the same instance picked up by multiple
// patterns (e.g. an AWS key matching both the AWS-specific and the generic
// `api_key=...` patterns), where the smaller bbox is contained inside the
// larger one and the min-area ratio approaches 1.
const DEDUP_OVERLAP_THRESHOLD = 0.85

function deduplicateRegions(regions: SensitiveRegion[]): SensitiveRegion[] {
  const result: SensitiveRegion[] = []

  for (const region of regions) {
    const isDuplicate = result.some(existing =>
      existing.category === region.category &&
      bboxOverlap(existing.bbox, region.bbox) > DEDUP_OVERLAP_THRESHOLD
    )
    if (!isDuplicate) result.push(region)
  }

  return result
}

function bboxOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): number {
  const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  const overlapArea = overlapX * overlapY
  const minArea = Math.min(a.width * a.height, b.width * b.height)
  return minArea > 0 ? overlapArea / minArea : 0
}
