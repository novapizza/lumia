import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pngSizeFromHeader } from '../electron/png-size.ts'

function header(width: number, height: number): Buffer {
  const b = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

test('pngSizeFromHeader reads width and height from the IHDR chunk', () => {
  assert.deepEqual(pngSizeFromHeader(header(1920, 1080)), { width: 1920, height: 1080 })
})

test('pngSizeFromHeader rejects files that are not PNG or too short', () => {
  const jpeg = Buffer.alloc(24); jpeg[0] = 0xff; jpeg[1] = 0xd8
  assert.equal(pngSizeFromHeader(jpeg), undefined)
  assert.equal(pngSizeFromHeader(header(10, 10).subarray(0, 20)), undefined)
})
