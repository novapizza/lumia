/**
 * Lightweight capture-latency tracer for field diagnosis of hotkey→overlay
 * lag. markCaptureStart() stamps t0 at the moment a capture is triggered
 * (hotkey handler / dashboard button / New Capture); trace() logs milestones
 * as offsets from that t0, so one capture reads as a single timeline:
 *
 *   [trace] t0 hotkey:RectangleRegion
 *   [trace] +1ms   main already hidden
 *   [trace] +205ms freeze done — 1 display(s), all native (204ms)
 *   [trace] +206ms overlay session start
 *   [trace] +262ms bg pushed to 1 overlay(s)
 *   [trace] +301ms reveal display=1 via=ack (gate 39ms, renderer 31ms)
 *
 * The gap between "bg pushed" and the renderer-reported paint time is the
 * IPC transfer cost of the raw BGRA frame.
 *
 * Logging only — no behavior. t0 is overwritten by each new trigger; entries
 * older than a minute are dropped so a code path that never stamps (e.g. the
 * scroll-capture dialog) can't misattribute its milestones to a long-finished
 * capture.
 */

let t0 = 0

export function markCaptureStart(source: string): void {
  t0 = Date.now()
  console.log(`[trace] t0 ${source}`)
}

export function trace(label: string): void {
  if (!t0) return
  const dt = Date.now() - t0
  if (dt > 60_000) return
  console.log(`[trace] +${dt}ms ${label}`)
}
