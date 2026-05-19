#!/usr/bin/env swift
// Fetch the ICC profile bytes of a macOS display and write them to a file.
//
// Usage: get-display-icc <displayId> <outPath>
//   <displayId>  CGDirectDisplayID as printed by NSScreen.deviceDescription
//                ["NSScreenNumber"] — Electron's screen.getAllDisplays()
//                returns the same numeric ID on macOS (it forwards
//                CGDirectDisplayID directly).
//   <outPath>    File to write raw ICC bytes to. Caller reads back with fs.
//
// Exit codes:
//   0  ICC written (size in bytes printed to stdout)
//   1  bad args
//   2  display not found
//   3  display has no ICC profile attached (rare; default gAMA-only fallback)
//   4  write failed

import Foundation
import CoreGraphics

guard CommandLine.arguments.count >= 3 else {
    fputs("Usage: get-display-icc <displayId> <outPath>\n", stderr)
    exit(1)
}

guard let displayIdU32 = UInt32(CommandLine.arguments[1]) else {
    fputs("Bad displayId: \(CommandLine.arguments[1])\n", stderr)
    exit(1)
}
let outPath = CommandLine.arguments[2]
let displayId = CGDirectDisplayID(displayIdU32)

// CGDisplayCopyColorSpace returns the display's current color space, including
// the ICC profile attached by ColorSync. Wide-gamut displays (P3 MacBooks,
// HDR Pro Display XDR) report their native space here.
let colorSpace = CGDisplayCopyColorSpace(displayId)

// Sanity check: if the display ID was invalid we'd still get a non-nil generic
// sRGB back. Compare against the active display list to flag mismatch.
var activeCount: UInt32 = 0
CGGetActiveDisplayList(0, nil, &activeCount)
if activeCount > 0 {
    var active = [CGDirectDisplayID](repeating: 0, count: Int(activeCount))
    CGGetActiveDisplayList(activeCount, &active, &activeCount)
    if !active.contains(displayId) {
        fputs("Display \(displayId) not in active list\n", stderr)
        exit(2)
    }
}

guard let iccData = colorSpace.copyICCData() as Data? else {
    fputs("No ICC data for display \(displayId)\n", stderr)
    exit(3)
}

do {
    try iccData.write(to: URL(fileURLWithPath: outPath))
    // Print byte count for verification; caller mostly cares about exit code + file
    print(iccData.count)
} catch {
    fputs("Write failed: \(error)\n", stderr)
    exit(4)
}
