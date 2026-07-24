// Long-running window-at-point helper for macOS.
//
// Protocol:
//   - argv[1] (optional): PID to exclude from results (Lumia's own windows).
//   - stdin:  one query per line:
//       "x y"  — point query in screen-DIP / points (top-left origin).
//       "list" — enumerate all eligible windows, front-to-back.
//   - stdout: one line per query.
//       point query: JSON object or the literal string "null".
//             { "x": <pt>, "y": <pt>, "width": <pt>, "height": <pt> }
//       list query:  JSON array of the same objects ("[]" when none).
//   - exits when stdin is closed.
//
// Permissions: reading window names requires Screen Recording, but bounds + PID
// + layer are returned without any prompt.
//
// Build: swiftc electron/helpers/window-at-point.swift -o electron/helpers/window-at-point

import Foundation
import CoreGraphics

let ownPid = Int(ProcessInfo.processInfo.processIdentifier)
let excludePid: Int = CommandLine.arguments.count >= 2
    ? (Int(CommandLine.arguments[1]) ?? -1)
    : -1

setbuf(stdout, nil)

// Shared eligibility filter: returns the window's bounds when the entry is a
// regular, visible, non-Lumia app window; nil otherwise.
func eligibleBounds(_ w: [String: Any]) -> CGRect? {
    // Layer 0 == regular app windows. Higher layers are dock/menu/popup chrome.
    guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0 else { return nil }
    if let pid = w[kCGWindowOwnerPID as String] as? Int {
        if pid == ownPid { return nil }
        if excludePid >= 0 && pid == excludePid { return nil }
    }
    if let alpha = w[kCGWindowAlpha as String] as? Double, alpha <= 0.01 { return nil }
    guard let boundsDict = w[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: boundsDict) else { return nil }
    // Skip degenerate slivers (offscreen helpers / 1px windows).
    if bounds.width < 8 || bounds.height < 8 { return nil }
    return bounds
}

func rectJson(_ bounds: CGRect) -> [String: Any] {
    return [
        "x": bounds.origin.x,
        "y": bounds.origin.y,
        "width": bounds.size.width,
        "height": bounds.size.height,
    ]
}

while let line = readLine(strippingNewline: true) {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]

    if line == "list" {
        guard let info = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
            print("[]")
            continue
        }
        // Front-to-back — the first entry is the frontmost (≈ active) window.
        let wins = info.compactMap { eligibleBounds($0) }.map { rectJson($0) }
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
    // CGWindowListCopyWindowInfo returns front-to-back z-order; first hit wins.
    for w in info {
        guard let bounds = eligibleBounds(w) else { continue }
        if !bounds.contains(pt) { continue }

        if let data = try? JSONSerialization.data(withJSONObject: rectJson(bounds)),
           let str = String(data: data, encoding: .utf8) {
            print(str)
            emitted = true
        }
        break
    }
    if !emitted { print("null") }
}
