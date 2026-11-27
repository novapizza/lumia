// Long-running window-at-point helper for macOS.
//
// Protocol:
//   - argv[1] (optional): PID to exclude from results (Lumia's own windows).
//   - stdin:  one query per line:
//       "x y"  — point query in screen-DIP / points (top-left origin).
//       "list" — enumerate all eligible windows, front-to-back.
//       "mc"   — "1" while Mission Control (or App Exposé / Launchpad) is
//                 showing: a window of the Dock or WindowManager covering most
//                 of a display. Read from the live window list; macOS has no
//                 API for it. "0" otherwise.
//       "front" — bundle id of the app owning the frontmost normal window
//                 (Lumia excluded), "" when none. Read from the live window
//                 list, not NSWorkspace (whose frontmostApplication goes stale
//                 without a run loop).
//   - stdout: one line per query.
//       point query: JSON object or the literal string "null".
//             { "id": <CGWindowID>, "x": <pt>, "y": <pt>, "width": <pt>, "height": <pt> }
//       list query:  JSON array of the same objects ("[]" when none), each
//             also with "app" (owner name), "title" (window name, empty
//             without Screen Recording) — the capture source label — and
//             "layer" (0 = normal window, 3 = floating, …). Windows covered
//             completely by the ones in front are left out.
//   - exits when stdin is closed.
//
// Permissions: reading window names requires Screen Recording, but bounds + PID
// + layer are returned without any prompt.
//
// Build: swiftc electron/helpers/window-at-point.swift -o electron/helpers/window-at-point

import Foundation
import CoreGraphics
import Darwin

// No AppKit (2026-11-24): loading it (NSRunningApplication for a bundle id)
// made this helper count as an app of its own, and it took activation away
// from Lumia right after each `front` / `mc` query; macOS then showed the
// terminal that started `pnpm dev` as the active app. Bundle ids come from
// the process's executable path instead.

/// The bundle id of the app a process belongs to, from its executable's
/// path ("…/Terminal.app/Contents/MacOS/Terminal" → Terminal.app's
/// Info.plist). "" when it isn't in an app bundle.
func bundleId(pid: Int) -> String {
    var buf = [CChar](repeating: 0, count: 4096)
    guard proc_pidpath(Int32(pid), &buf, UInt32(buf.count)) > 0 else { return "" }
    let path = String(cString: buf)
    guard let r = path.range(of: ".app/") else { return "" }
    return Bundle(path: String(path[..<r.lowerBound]) + ".app")?.bundleIdentifier ?? ""
}

let ownPid = Int(ProcessInfo.processInfo.processIdentifier)
let excludePid: Int = CommandLine.arguments.count >= 2
    ? (Int(CommandLine.arguments[1]) ?? -1)
    : -1

setbuf(stdout, nil)

// Windows above the menu bar's layer (open menus, overlays, the cursor) are
// ignored. Up to it, every visible non-Lumia window counts, front-to-back:
// the first one under the point is what you see there (2026-11-24; only
// layer 0 counted before, so a floating window such as Music's mini player
// let the window behind it be picked through it).
let menuBarLayer = 24
let statusItemLayer = 25

/// The bounds and layer of a visible, non-Lumia window up to the menu bar's
/// layer; nil otherwise.
func visibleWindow(_ w: [String: Any]) -> (bounds: CGRect, layer: Int)? {
    guard let layer = w[kCGWindowLayer as String] as? Int,
          layer >= 0, layer <= statusItemLayer else { return nil }
    if let pid = w[kCGWindowOwnerPID as String] as? Int {
        if pid == ownPid { return nil }
        if excludePid >= 0 && pid == excludePid { return nil }
    }
    if let alpha = w[kCGWindowAlpha as String] as? Double, alpha <= 0.01 { return nil }
    guard let boundsDict = w[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: boundsDict) else { return nil }
    // Skip degenerate slivers (offscreen helpers / 1px windows).
    if bounds.width < 8 || bounds.height < 8 { return nil }
    return (bounds, layer)
}

/// Windows can be picked below the menu bar's layer (normal, floating,
/// panels, the Dock); the menu bar and its status items only cover.
func pickable(_ layer: Int) -> Bool { layer < menuBarLayer }

/// `r` minus `cut`: up to four rects.
func subtract(_ r: CGRect, _ cut: CGRect) -> [CGRect] {
    let i = r.intersection(cut)
    if i.isNull || i.isEmpty { return [r] }
    var out: [CGRect] = []
    if i.minY > r.minY { out.append(CGRect(x: r.minX, y: r.minY, width: r.width, height: i.minY - r.minY)) }
    if i.maxY < r.maxY { out.append(CGRect(x: r.minX, y: i.maxY, width: r.width, height: r.maxY - i.maxY)) }
    if i.minX > r.minX { out.append(CGRect(x: r.minX, y: i.minY, width: i.minX - r.minX, height: i.height)) }
    if i.maxX < r.maxX { out.append(CGRect(x: i.maxX, y: i.minY, width: r.maxX - i.maxX, height: i.height)) }
    return out
}

/// True when the windows in front cover `r` completely.
func covered(_ r: CGRect, by front: [CGRect]) -> Bool {
    var rest = [r]
    for f in front {
        rest = rest.flatMap { subtract($0, f) }
        if rest.isEmpty { return true }
    }
    return false
}

func rectJson(_ bounds: CGRect, _ w: [String: Any]) -> [String: Any] {
    return [
        "id": (w[kCGWindowNumber as String] as? Int) ?? 0,
        "x": bounds.origin.x,
        "y": bounds.origin.y,
        "width": bounds.size.width,
        "height": bounds.size.height,
    ]
}

var bundleCache: [Int: String] = [:]

while let line = readLine(strippingNewline: true) {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]

    if line == "mc" {
        let info = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] ?? []
        var displayCount: UInt32 = 0
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        CGGetActiveDisplayList(16, &ids, &displayCount)
        let screens = ids.prefix(Int(displayCount)).map { CGDisplayBounds($0) }
        var active = false
        for w in info {
            guard let layer = w[kCGWindowLayer as String] as? Int, layer >= 0,
                  let pid = w[kCGWindowOwnerPID as String] as? Int,
                  let boundsDict = w[kCGWindowBounds as String] as? NSDictionary,
                  let b = CGRect(dictionaryRepresentation: boundsDict) else { continue }
            let bundle = bundleCache[pid] ?? bundleId(pid: pid)
            bundleCache[pid] = bundle
            guard bundle == "com.apple.dock" || bundle == "com.apple.WindowManager" else { continue }
            if screens.contains(where: { s in
                let i = s.intersection(b)
                return !i.isNull && i.width * i.height >= 0.9 * s.width * s.height
            }) { active = true; break }
        }
        print(active ? "1" : "0")
        continue
    }

    if line == "front" {
        let info = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] ?? []
        var bundle = ""
        for w in info {
            guard let (_, layer) = visibleWindow(w), layer == 0,
                  let pid = w[kCGWindowOwnerPID as String] as? Int else { continue }
            bundle = bundleId(pid: pid)
            break
        }
        print(bundle)
        continue
    }

    if line == "list" {
        guard let info = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
            print("[]")
            continue
        }
        // Front-to-back — the first entry is the frontmost window. A window
        // the ones in front cover completely is left out: it can't be seen,
        // so it can't be picked. Each entry also names its app and window
        // (the capture's source) and its layer (0 = a normal window).
        var wins: [[String: Any]] = []
        var front: [CGRect] = []
        for w in info {
            guard let (b, layer) = visibleWindow(w) else { continue }
            if pickable(layer) && !covered(b, by: front) {
                var o = rectJson(b, w)
                o["app"] = (w[kCGWindowOwnerName as String] as? String) ?? ""
                o["title"] = (w[kCGWindowName as String] as? String) ?? ""
                o["layer"] = layer
                wins.append(o)
            }
            front.append(b)
        }
        if let data = try? JSONSerialization.data(withJSONObject: wins),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        } else {
            print("[]")
        }
        continue
    }

    let parts = line.split(separator: " ").compactMap { Double($0) }
    if parts.count < 2 {
        print("null")
        continue
    }
    let pt = CGPoint(x: parts[0], y: parts[1])

    guard let info = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
        print("null")
        continue
    }

    var emitted = false
    // CGWindowListCopyWindowInfo returns front-to-back z-order; first hit
    // wins. The menu bar answers null: nothing behind it can be picked.
    for w in info {
        guard let (bounds, layer) = visibleWindow(w) else { continue }
        if !bounds.contains(pt) { continue }
        if !pickable(layer) { break }

        if let data = try? JSONSerialization.data(withJSONObject: rectJson(bounds, w)),
           let str = String(data: data, encoding: .utf8) {
            print(str)
            emitted = true
        }
        break
    }
    if !emitted { print("null") }
}
