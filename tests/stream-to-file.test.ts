import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { saveResponseTo } from '../electron/stream-to-file.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'lumia-stream-'))

/** A local server: `/file` sends `payload` in chunks, `/slow` sends a first
 *  chunk and then nothing (until the client goes). */
function serve(payload: Buffer): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      if (req.url === '/slow') { res.writeHead(200); res.write(payload.subarray(0, 1024)); return }
      res.writeHead(200, { 'Content-Length': String(payload.length) })
      for (let i = 0; i < payload.length; i += 64 * 1024) res.write(payload.subarray(i, i + 64 * 1024))
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      const a = server.address()
      resolve({ server, url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}` })
    })
  })
}

test('saveResponseTo writes the body byte for byte and leaves no temp file', async () => {
  const payload = randomBytes(3 * 1024 * 1024 + 123)
  const { server, url } = await serve(payload)
  try {
    const dir = tmp()
    const dest = join(dir, 'recording.webm')
    const bytes = await saveResponseTo(await fetch(`${url}/file`), dest)
    assert.equal(bytes, payload.length)
    assert.ok(readFileSync(dest).equals(payload))
    assert.deepEqual(readdirSync(dir), ['recording.webm'])
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test('saveResponseTo replaces an existing file only when the download is complete', async () => {
  const payload = randomBytes(200 * 1024)
  const { server, url } = await serve(payload)
  try {
    const dir = tmp()
    const dest = join(dir, 'capture.png')
    writeFileSync(dest, 'old')
    await saveResponseTo(await fetch(`${url}/file`), dest)
    assert.ok(readFileSync(dest).equals(payload))
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test('a cancelled download rejects and leaves nothing behind', async () => {
  const { server, url } = await serve(randomBytes(64 * 1024))
  try {
    const dir = tmp()
    const dest = join(dir, 'recording.webm')
    writeFileSync(dest, 'old')
    const abort = new AbortController()
    const res = await fetch(`${url}/slow`, { signal: abort.signal })
    const saving = saveResponseTo(res, dest, abort.signal)
    setTimeout(() => abort.abort(), 50)
    await assert.rejects(saving)
    // The file that was there is untouched, and no part file is left.
    assert.equal(readFileSync(dest, 'utf8'), 'old')
    assert.deepEqual(readdirSync(dir), ['recording.webm'])
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test('a response without a body is refused', async () => {
  const dir = tmp()
  await assert.rejects(saveResponseTo({ body: null }, join(dir, 'x.png')), /Empty response/)
  assert.deepEqual(readdirSync(dir), [])
})
