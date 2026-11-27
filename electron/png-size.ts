// A PNG's pixel size from its first 24 bytes (signature + IHDR). Node fs
// only, no Electron (unit-tested).
import { open } from 'fs/promises'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function pngSizeFromHeader(b: Buffer): { width: number; height: number } | undefined {
  if (b.length < 24) return undefined
  if (SIGNATURE.some((v, i) => b[i] !== v)) return undefined
  if (b.toString('ascii', 12, 16) !== 'IHDR') return undefined
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

/** Reads only the header, so it's cheap enough to run on every row read. */
export async function readPngSize(file: string): Promise<{ width: number; height: number } | undefined> {
  const fh = await open(file, 'r')
  try {
    const b = Buffer.alloc(24)
    const { bytesRead } = await fh.read(b, 0, 24, 0)
    return pngSizeFromHeader(b.subarray(0, bytesRead))
  } finally {
    await fh.close()
  }
}
