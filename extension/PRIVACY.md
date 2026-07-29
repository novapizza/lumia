# Privacy Policy — Lumia Scroll Capture (browser extension)

_Last updated: 2026-07-28_

Lumia Scroll Capture is a companion browser extension for the Lumia desktop
application. This policy explains what the extension does with your data.

## Summary

The extension does **not** collect, store, or transmit your data to the
developer, to any server, or to any third party. Everything happens on your own
computer.

## What the extension accesses

To take a full-page scrolling screenshot, the extension:

- Reads the visible pixels of the tab you choose to capture
  (`chrome.tabs.captureVisibleTab`).
- Injects a script into that tab to measure and scroll the page during the
  capture.
- Reads the active tab's title and URL only to label the capture and re-focus
  the correct tab.

It acts **only on the specific tab you explicitly start a capture on**, and only
while that capture is running.

## Where your data goes

Captured images and their scroll offsets are sent **only to the Lumia desktop
application running on the same computer**, over a local connection
(`ws://127.0.0.1`). The data never leaves your device through this extension.

The extension does not use analytics, advertising, tracking, cookies, or any
remote server. It contains no remotely hosted code.

## Data retention

The extension itself stores nothing persistent about your browsing. Any saved
screenshots are handled by the Lumia desktop app on your machine, under your
control.

## Permissions

- **Host access to all sites (`<all_urls>`)** and **`tabs`** — so you can capture
  any page you choose, and so screenshots go to the correct tab.
- **`scripting`** — to scroll the page and hide sticky/fixed elements during a
  capture; the script is removed when the capture ends.
- **`alarms`** — to reconnect to the local Lumia app if the connection drops.

## Children's privacy

The extension is a productivity tool and is not directed to children, and it
collects no personal data from anyone.

## Changes

If this policy changes, the "Last updated" date above will change.

## Contact

Questions: **[FILL: support email, e.g. support@lumia.asia]**
