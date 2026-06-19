import { deflateSync } from 'zlib'

// CRC-32 (IEEE 802.3 polynomial 0xEDB88320, init 0xFFFFFFFF, final xor with
// 0xFFFFFFFF). zlib.crc32 only landed in Node 22 — Electron 33 ships Node 20,
// so we hand-roll. Table is built once on first call.
let _crcTable: Uint32Array | null = null
function crcTable(): Uint32Array {
  if (_crcTable) return _crcTable
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  _crcTable = t
  return t
}
function crc32(buf: Buffer): number {
  const t = crcTable()
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// PNG iCCP chunk insertion. We hand-roll this instead of pulling in pngjs/sharp
// because the operation is tiny and the deps would bloat the main bundle.
//
// Chunk layout (per PNG spec §11.3.3.3):
//   length:        uint32 BE — length of *data* only, not type or CRC
//   type:          "iCCP" (4 bytes ASCII)
//   data:
//     profileName: ISO-8859-1, 1..79 bytes, no null inside
//     null:        0x00
//     compression: 0x00 (only "deflate" is defined)
//     profile:     zlib-deflate of the raw ICC profile bytes
//   crc:           uint32 BE — CRC32 of (type + data)
//
// Insertion point: directly after IHDR. The PNG spec allows iCCP anywhere
// before IDAT and before PLTE; "right after IHDR" is the safest slot.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && PNG_SIGNATURE.equals(buf.subarray(0, 8))
}

function buildIccpChunk(profileName: string, iccBytes: Buffer): Buffer {
  // PNG spec restricts the profile name to printable Latin-1 (32-126, 161-255)
  // and forbids leading/trailing/consecutive spaces. We sanitize aggressively
  // and clamp length to 1..79 — the readable label is cosmetic, viewers key
  // off the chunk itself.
  const cleaned = (profileName || 'ICC').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim() || 'ICC'
  const name = Buffer.from(cleaned.slice(0, 79), 'latin1')

  const compressed = deflateSync(iccBytes)
  // data = name + \0 + compressionMethod(0) + compressed
  const data = Buffer.concat([name, Buffer.from([0x00, 0x00]), compressed])

  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)

  const type = Buffer.from('iCCP', 'ascii')
  const crcInput = Buffer.concat([type, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(crcInput), 0)

  return Buffer.concat([length, type, data, crc])
}

/** Insert (or replace) an iCCP chunk in the PNG, tagging it with the given ICC
 *  profile bytes. Returns the original buffer untouched if the input isn't a
 *  valid PNG or if anything else goes wrong — never throws on the hot path. */
export function tagPngWithIcc(pngBytes: Buffer, iccBytes: Buffer, profileName = 'Display'): Buffer {
  try {
    if (!isPng(pngBytes) || iccBytes.length === 0) return pngBytes

    // PNG chunk walk: signature is 8 bytes, then chunks each [len(4)|type(4)|data(len)|crc(4)].
    // IHDR is always the first chunk (13 bytes of data → 25 bytes total including
    // length/type/crc), and per spec we can insert iCCP immediately after.
    const sigEnd = 8
    const ihdrLen = pngBytes.readUInt32BE(sigEnd)
    const ihdrType = pngBytes.subarray(sigEnd + 4, sigEnd + 8).toString('ascii')
    if (ihdrType !== 'IHDR') return pngBytes
    const ihdrEnd = sigEnd + 8 + ihdrLen + 4  // +4 for CRC

    // If an iCCP chunk already exists somewhere, strip it before inserting the
    // new one. (Electron's toPNG never writes iCCP today, so this branch is
    // mostly defensive — but it keeps the function idempotent.)
    const stripped = stripIccpChunks(pngBytes, ihdrEnd)
    const newChunk = buildIccpChunk(profileName, iccBytes)

    return Buffer.concat([
      stripped.subarray(0, ihdrEnd),
      newChunk,
      stripped.subarray(ihdrEnd),
    ])
  } catch {
    return pngBytes
  }
}

/** Extract the ICC profile bytes from a PNG's iCCP chunk, if any. Returns
 *  null when the input isn't a PNG, has no iCCP chunk, or is malformed.
 *  Used to copy an original capture's color profile onto downstream sidecar
 *  files (e.g., annotation flatten) so they inherit the same color space
 *  without having to re-query the display. */
export function getIccFromPng(pngBytes: Buffer): Buffer | null {
  try {
    if (!isPng(pngBytes)) return null
    const { inflateSync } = require('zlib')
    let i = 8  // skip signature
    while (i < pngBytes.length - 8) {
      const len = pngBytes.readUInt32BE(i)
      const type = pngBytes.subarray(i + 4, i + 8).toString('ascii')
      if (i + 12 + len > pngBytes.length) break
      if (type === 'iCCP') {
        const data = pngBytes.subarray(i + 8, i + 8 + len)
        // Find the NUL terminator separating profile name from compression
        // method + compressed data. Name is 1..79 bytes.
        let nameEnd = 0
        while (nameEnd < data.length && data[nameEnd] !== 0) nameEnd++
        if (nameEnd >= data.length - 1) return null
        // data[nameEnd+1] is the compression method (must be 0 = deflate)
        if (data[nameEnd + 1] !== 0) return null
        const compressed = data.subarray(nameEnd + 2)
        return inflateSync(compressed) as Buffer
      }
      if (type === 'IDAT' || type === 'IEND') return null
      i += 12 + len
    }
    return null
  } catch {
    return null
  }
}

function stripIccpChunks(pngBytes: Buffer, startOffset: number): Buffer {
  const parts: Buffer[] = [pngBytes.subarray(0, startOffset)]
  let i = startOffset
  while (i < pngBytes.length - 8) {
    const len = pngBytes.readUInt32BE(i)
    const type = pngBytes.subarray(i + 4, i + 8).toString('ascii')
    const totalLen = 12 + len  // length(4) + type(4) + data(len) + crc(4)
    if (i + totalLen > pngBytes.length) break  // truncated chunk → stop, copy rest as-is
    if (type !== 'iCCP') parts.push(pngBytes.subarray(i, i + totalLen))
    if (type === 'IEND') {
      parts.push(pngBytes.subarray(i + totalLen))
      return Buffer.concat(parts)
    }
    i += totalLen
  }
  if (i < pngBytes.length) parts.push(pngBytes.subarray(i))
  return Buffer.concat(parts)
}
