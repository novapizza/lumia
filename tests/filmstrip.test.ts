import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STRIP_TILES, STRIP_TILE_W, STRIP_TILE_H,
  slotCount, tileForSlot, tileTimesMs, coverCrop, tilesInStrip, halvingSteps, TileSampler, RecordedClock,
} from '../src/lib/filmstrip.ts'

test('a tile is the track tile at 2x, 16:9', () => {
  assert.equal(STRIP_TILE_H, 120)
  assert.equal(STRIP_TILE_W, 214) // 60px track * 16 / 9 = 106.67px, at 2x
})

test('slotCount: one slot per 16:9 tile of the track, capped at the stored tiles', () => {
  assert.equal(slotCount(1102, 60), 11) // the default 1250px window
  assert.equal(slotCount(1772, 60), 17) // a 1920px window
  assert.equal(slotCount(106, 60), 1)
  assert.equal(slotCount(107, 60), 2)
  assert.equal(slotCount(0, 60), 1)
  assert.equal(slotCount(5000, 60), STRIP_TILES)
  assert.equal(slotCount(5000, 60, 8), 8)
})

test('tileForSlot: the stored tile whose stretch of time holds the slot\'s middle', () => {
  // as many slots as tiles: one to one
  for (let i = 0; i < 20; i++) assert.equal(tileForSlot(i, 20, 20), i)
  // 10 slots over 20 tiles: middles at 5%, 15%, … land in tiles 1, 3, …
  assert.deepEqual(Array.from({ length: 10 }, (_, i) => tileForSlot(i, 10, 20)), [1, 3, 5, 7, 9, 11, 13, 15, 17, 19])
  // one slot: the middle of the clip
  assert.equal(tileForSlot(0, 1, 20), 10)
  // never outside the strip
  assert.equal(tileForSlot(99, 10, 20), 19)
  assert.equal(tileForSlot(-3, 10, 20), 0)
  assert.equal(tileForSlot(0, 5, 1), 0)
})

test('tileForSlot: slots run left to right and never go back in time', () => {
  for (const slots of [1, 7, 11, 17, 20]) {
    let last = -1
    for (let s = 0; s < slots; s++) {
      const t = tileForSlot(s, slots, 20)
      assert.ok(t >= last, `${slots} slots: slot ${s} went back`)
      last = t
    }
  }
})

test('tileTimesMs: the middle of each tile\'s stretch', () => {
  assert.deepEqual(tileTimesMs(10000, 4), [1250, 3750, 6250, 8750])
  assert.equal(tileTimesMs(91108).length, STRIP_TILES)
  assert.deepEqual(tileTimesMs(0, 2), [0, 0])
})

test('coverCrop: fills the target, cut evenly from the long side', () => {
  // 16:9 into 16:9: everything
  assert.deepEqual(coverCrop(3840, 2160, 1920, 1080), { sx: 0, sy: 0, sw: 3840, sh: 2160 })
  // portrait into a 16:9 tile: full width, a middle band
  const p = coverCrop(924, 1280, 214, 120)
  assert.equal(p.sx, 0)
  assert.equal(p.sw, 924)
  assert.ok(Math.abs(p.sh - 924 * 120 / 214) < 1e-9)
  assert.ok(Math.abs(p.sy - (1280 - p.sh) / 2) < 1e-9)
  // wide into a narrow slot: full height, sides cut
  const w = coverCrop(214, 120, 97, 60)
  assert.equal(w.sy, 0)
  assert.equal(w.sh, 120)
  assert.ok(Math.abs(w.sw - 194) < 1e-9)
  assert.ok(Math.abs(w.sx - 10) < 1e-9)
})

test('halvingSteps: down to the tile in steps of at most 2x', () => {
  // a 4K frame: four halvings, then the last bit
  assert.deepEqual(halvingSteps(3840, 2160, 214, 120), [
    { w: 1920, h: 1080 }, { w: 960, h: 540 }, { w: 480, h: 270 }, { w: 240, h: 135 }, { w: 214, h: 120 },
  ])
  // every step shrinks by 2x or less, whatever the source
  for (const [w, h] of [[3840, 2160], [2808, 1579.5], [924, 518.2], [1598, 898.9], [300, 168], [214, 120], [100, 56]]) {
    const steps = halvingSteps(w, h, 214, 120)
    assert.deepEqual(steps[steps.length - 1], { w: 214, h: 120 })
    let pw = w, ph = h
    for (const st of steps) {
      // (a rounded-up pixel can leave the last step a hair over)
      assert.ok(pw / st.w <= 2.02 && ph / st.h <= 2.02, `${w}x${h}: ${pw}x${ph} -> ${st.w}x${st.h}`)
      pw = st.w; ph = st.h
    }
  }
  // already tile-sized or smaller: one draw
  assert.deepEqual(halvingSteps(214, 120, 214, 120), [{ w: 214, h: 120 }])
  assert.deepEqual(halvingSteps(100, 56, 214, 120), [{ w: 214, h: 120 }])
})

test('tilesInStrip: from the picture\'s width', () => {
  assert.equal(tilesInStrip(STRIP_TILE_W * 20), 20)
  assert.equal(tilesInStrip(STRIP_TILE_W * 12), 12)
  assert.equal(tilesInStrip(0), 1)
})

test('TileSampler: takes a tile every 100ms at first', () => {
  const s = new TileSampler<number>()
  assert.equal(s.due(0), true)
  s.add(0, 0)
  assert.equal(s.due(50), false)
  assert.equal(s.due(100), true)
})

test('TileSampler: never holds more than twice the strip, whatever the length', () => {
  const s = new TileSampler<number>()
  // 10 minutes of frames at 30 a second
  for (let ms = 0; ms <= 600_000; ms += 33) if (s.due(ms)) s.add(ms, ms)
  assert.ok(s.size < STRIP_TILES * 2, `held ${s.size}`)
  assert.ok(s.size >= STRIP_TILES, `held only ${s.size}`)
  const picked = s.pick(600_000)
  assert.equal(picked.length, STRIP_TILES)
  // each tile is a frame from its own stretch of the recording
  const times = tileTimesMs(600_000)
  picked.forEach((ms, i) => {
    assert.ok(ms <= times[i], `tile ${i} is from after its time`)
    assert.ok(times[i] - ms < 600_000 / STRIP_TILES, `tile ${i} is ${times[i] - ms}ms old`)
  })
})

test('TileSampler: a tile shows the last frame drawn at or before its time', () => {
  const s = new TileSampler<string>()
  // a still screen: frames only at 0s and 7s of a 10s recording
  s.add(0, 'a')
  s.add(7000, 'b')
  const picked = s.pick(10_000, 4) // times 1250, 3750, 6250, 8750
  assert.deepEqual(picked, ['a', 'a', 'a', 'b'])
})

test('RecordedClock: recorded time stops in a pause', () => {
  const c = new RecordedClock()
  assert.equal(c.running, false)
  assert.equal(c.at(500), 0)
  c.start(1000)
  assert.equal(c.running, true)
  assert.equal(c.at(1400), 400)
  c.pause(3000)
  assert.equal(c.running, false)
  assert.equal(c.at(3000), 2000)
  assert.equal(c.at(9000), 2000)       // still paused
  c.resume(10_000)
  assert.equal(c.at(10_500), 2500)
  c.pause(12_000)                       // stop
  assert.equal(c.at(99_999), 4000)
})

test('RecordedClock: a second pause or resume changes nothing; start begins again', () => {
  const c = new RecordedClock()
  c.start(0)
  c.pause(1000)
  c.pause(5000)
  assert.equal(c.at(5000), 1000)
  c.resume(6000)
  c.resume(8000)
  assert.equal(c.at(9000), 4000)
  c.start(20_000)
  assert.equal(c.at(20_250), 250)
})

test('a pause leaves no gap and no tile from it: tiles line up with the file', () => {
  // Wall clock: recording 0 to 2s, paused 2 to 5s, recording 5 to 7s. The
  // file is 4s long. Frames keep arriving all the time (the screen doesn't
  // stop), each labelled with the wall time it was drawn at.
  const clock = new RecordedClock()
  const s = new TileSampler<number>()
  clock.start(0)
  for (let wall = 0; wall <= 7000; wall += 33) {
    if (wall >= 2000 && wall < 5000) { if (clock.running) clock.pause(2000) }
    else if (!clock.running) clock.resume(5000)
    // what the recorder does with every drawn frame
    if (!clock.running) continue
    const ms = clock.at(wall)
    if (s.due(ms)) s.add(ms, wall)
  }
  clock.pause(7000)
  const duration = clock.at(7000)
  assert.equal(duration, 4000)
  const times = tileTimesMs(duration)
  const picked = s.pick(duration)
  picked.forEach((wall, i) => {
    // nothing drawn during the pause got in
    assert.ok(wall < 2000 || wall >= 5000, `tile ${i} is from the pause (wall ${wall})`)
    // and each tile shows what the file shows at its time: wall time minus
    // the 3s pause for everything after it
    const fileMs = wall < 2000 ? wall : wall - 3000
    assert.ok(fileMs <= times[i] && times[i] - fileMs <= 200, `tile ${i}: file time ${times[i]}, frame from ${fileMs}`)
  })
  // tiles on both sides of the pause
  assert.ok(picked.some(w => w < 2000) && picked.some(w => w >= 5000))
})

test('TileSampler: nothing sampled gives no tiles; a short clip repeats what it has', () => {
  assert.deepEqual(new TileSampler<number>().pick(5000), [])
  const s = new TileSampler<number>()
  s.add(0, 1)
  assert.deepEqual(s.pick(300, 3), [1, 1, 1])
})
