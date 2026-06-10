// Make a MediaRecorder WebM seekable.
//
// MediaRecorder emits a "streaming" WebM: the Segment has no Cues element (the
// timestamp→byte-offset seek index) and usually no Duration in the Info
// element. The result plays from the start but the scrubber is dead — in
// Lumia's own player AND in VLC / browsers / any external player. This is a
// property of the file, not the player.
//
// ts-ebml reads the existing clusters, builds a Cues table + Duration, and
// rewrites just the metadata block at the head of the Segment. It's lossless —
// no re-encode, the audio/video bitstream is untouched — only container header
// elements are added/reordered. We run it in the main process (Node) where
// `Buffer` exists; ts-ebml's browser path would need a Buffer polyfill in the
// Vite renderer.
import { Decoder, Reader, tools } from 'ts-ebml'

/** Returns a seekable copy of the given WebM bytes (Cues + Duration injected).
 *  Throws if the input can't be parsed — callers should fall back to the
 *  original file so a remux failure never loses the recording. */
export function makeWebmSeekable(input: Buffer): Buffer {
  // ts-ebml operates on ArrayBuffer. Slice to the exact view in case the
  // Buffer is a window into a larger pool.
  const ab = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer

  const decoder = new Decoder()
  const reader = new Reader()
  reader.logging = false
  // Keep per-block durations so the computed Duration matches the real length.
  reader.drop_default_duration = false

  const elms = decoder.decode(ab)
  for (const elm of elms) reader.read(elm)
  reader.stop()

  // Fresh metadata block: SeekHead + Info(Duration) + Tracks + Cues.
  const refinedMetadata = tools.makeMetadataSeekable(reader.metadatas, reader.duration, reader.cues)
  const body = ab.slice(reader.metadataSize)

  return Buffer.concat([Buffer.from(refinedMetadata), Buffer.from(body)])
}
