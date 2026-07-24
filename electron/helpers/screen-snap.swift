// Long-running fast-screenshot helper for macOS 14+.
//
// Backs Lumia's freeze-at-hotkey snapshot (electron/mac-screen-snap.ts) with
// ScreenCaptureKit's SCScreenshotManager — a one-shot capture API that is
// dramatically faster than Electron's desktopCapturer.getSources() on modern
// macOS (~50–200 ms vs 1–3 s at full display resolution). The win comes from
// doing the slow SCShareableContent enumeration once (at prewarm) and reusing
// it across captures, instead of paying it inside every getSources() call.
//
// Protocol (line-based control channel on stdin, mixed text/binary replies):
//   argv[1] (optional): PID whose windows to exclude from captures (Lumia's
//                       own — same convention as window-at-point). Excluding
//                       at the compositor level means the parent doesn't have
//                       to wait for its own windows' hide to settle before
//                       freezing.
//   stdin, one request per line:
//     "prewarm"                      — fetch + cache SCShareableContent.
//     "snap <displayID> <pxW> <pxH>" — capture one display. displayID is a
//                                      CGDirectDisplayID (Electron display.id
//                                      forwards it directly on macOS); pxW/pxH
//                                      is the desired output size in physical
//                                      pixels.
//   stdout, exactly one reply per request, in request order:
//     prewarm → "ready\n"  (or "err <reason>\n")
//     snap    → "ok <w> <h> <byteCount>\n" followed by exactly <byteCount>
//               bytes of raw tightly-packed BGRA pixels (w*h*4), or
//               "err <reason>\n".
//   Exits when stdin closes.
//
// macOS < 14 (no SCScreenshotManager): every request answers
// "err unsupported" — the Node side latches that and falls back to
// desktopCapturer permanently.
//
// Permissions: requires Screen Recording; the helper inherits the TCC grant
// from the parent app (responsible-process attribution), same as the other
// Swift helpers.
//
// Build: build/compile-mac-helpers.sh (universal arm64 + x86_64).

import Foundation
import CoreGraphics
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif

let out = FileHandle.standardOutput
let errOut = FileHandle.standardError

let excludePid: Int32 = CommandLine.arguments.count >= 2
    ? (Int32(CommandLine.arguments[1]) ?? -1)
    : -1

// All replies go through FileHandle (never stdio print) so header lines and
// binary payloads can't be reordered by C-stdio buffering.
func writeLine(_ s: String) {
    out.write(Data((s + "\n").utf8))
}

func logErr(_ s: String) {
    errOut.write(Data(("[screen-snap] " + s + "\n").utf8))
}

#if canImport(ScreenCaptureKit)
@available(macOS 14.0, *)
final class Snapper {
    static let shared = Snapper()

    // Cached across captures — SCShareableContent enumeration is the slow part
    // (~200–500 ms). SCDisplay handles stay valid until the display config
    // changes; the Node side re-sends "prewarm" on Electron display events, and
    // snap() additionally refetches once when the requested ID is missing.
    private var content: SCShareableContent?

    func fetchContent() -> SCShareableContent? {
        let sem = DispatchSemaphore(value: 0)
        var fetched: SCShareableContent?
        // onScreenWindowsOnly trims the window enumeration we never use —
        // display filters with excludingWindows: [] don't need window handles.
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { c, err in
            if let err = err { logErr("shareable-content: \(err.localizedDescription)") }
            fetched = c
            sem.signal()
        }
        sem.wait()
        if let c = fetched { content = c }
        return fetched
    }

    // Resolve the SCDisplay together with the content generation it came from,
    // so the exclusion list below is built from the same window snapshot.
    private func lookup(_ id: CGDirectDisplayID) -> (SCDisplay, SCShareableContent)? {
        if let c = content, let d = c.displays.first(where: { $0.displayID == id }) { return (d, c) }
        // Cache miss (cold start or display hotplug) — refetch once.
        if let c = fetchContent(), let d = c.displays.first(where: { $0.displayID == id }) { return (d, c) }
        return nil
    }

    func snap(displayID: CGDirectDisplayID, pxW: Int, pxH: Int) -> (w: Int, h: Int, bgra: Data)? {
        guard let (scDisplay, c) = lookup(displayID) else {
            logErr("display \(displayID) not found")
            return nil
        }
        // Exclude the parent app's own windows (main window mid-hide, tray
        // popovers) so the frozen frame never contains Lumia UI regardless of
        // hide timing. The opacity-0 overlay pool windows would be invisible
        // in the capture anyway; excluding them too is harmless.
        let excluded = excludePid >= 0
            ? c.windows.filter { $0.owningApplication?.processID == excludePid }
            : []
        let filter = SCContentFilter(display: scDisplay, excludingWindows: excluded)
        let cfg = SCStreamConfiguration()
        cfg.width = max(1, pxW)
        cfg.height = max(1, pxH)
        cfg.showsCursor = false  // match GDI/desktopCapturer: no cursor baked in
        if #available(macOS 14.2, *) {
            // Default is already true for display filters — set explicitly so a
            // future SDK default change can't silently drop the menu bar.
            filter.includeMenuBar = true
        }

        let sem = DispatchSemaphore(value: 0)
        var image: CGImage?
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { img, err in
            if let err = err { logErr("capture: \(err.localizedDescription)") }
            image = img
            sem.signal()
        }
        sem.wait()
        guard let img = image else { return nil }
        return bgraBytes(img)
    }

    // Tightly packed BGRA via a re-draw into our own context. The context uses
    // the image's own color space so CoreGraphics does no pixel conversion —
    // values stay in the display's native space, matching what desktopCapturer
    // produced before (the PNG ICC-tagging pipeline depends on that).
    private func bgraBytes(_ img: CGImage) -> (w: Int, h: Int, bgra: Data)? {
        let w = img.width, h = img.height
        guard w > 0, h > 0 else { return nil }
        let bytesPerRow = w * 4
        var data = Data(count: bytesPerRow * h)
        let ok = data.withUnsafeMutableBytes { (ptr: UnsafeMutableRawBufferPointer) -> Bool in
            guard let base = ptr.baseAddress else { return false }
            guard let ctx = CGContext(
                data: base, width: w, height: h, bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: img.colorSpace ?? CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                          | CGBitmapInfo.byteOrder32Little.rawValue
            ) else { return false }
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: CGFloat(w), height: CGFloat(h)))
            return true
        }
        return ok ? (w, h, data) : nil
    }
}
#endif

func handle(line: String) {
    let parts = line.split(separator: " ")
    guard let cmd = parts.first else {
        writeLine("err empty")
        return
    }

#if canImport(ScreenCaptureKit)
    if #available(macOS 14.0, *) {
        switch cmd {
        case "prewarm":
            writeLine(Snapper.shared.fetchContent() != nil ? "ready" : "err content")
        case "snap":
            guard parts.count >= 4,
                  let id = UInt32(parts[1]),
                  let w = Int(parts[2]),
                  let h = Int(parts[3]) else {
                writeLine("err badargs")
                return
            }
            if let shot = Snapper.shared.snap(displayID: CGDirectDisplayID(id), pxW: w, pxH: h) {
                writeLine("ok \(shot.w) \(shot.h) \(shot.bgra.count)")
                out.write(shot.bgra)
            } else {
                writeLine("err capture")
            }
        default:
            writeLine("err unknown")
        }
        return
    }
#endif
    writeLine("err unsupported")
}

// stdin loop on a background thread; the main thread stays parked in
// dispatchMain() servicing the main queue, so any ScreenCaptureKit callback
// delivered there can still run (blocking main with a semaphore would then
// deadlock).
DispatchQueue.global(qos: .userInteractive).async {
    while let line = readLine(strippingNewline: true) {
        handle(line: line)
    }
    exit(0)
}
dispatchMain()
