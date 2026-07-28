# Lumia Scroll Capture — browser extension

Companion extension for the Lumia desktop app. When Lumia's Scroll capture is
set to **Browser Extension** mode, the app asks this extension to photograph
the active tab: the extension scrolls the page in exact viewport steps,
captures each step, and streams the frames (with exact scroll offsets) back to
Lumia over a localhost WebSocket. Because the offsets come from the DOM, the
stitched result has none of the guesswork artifacts of screen-scrape scrolling
capture — and it can hide sticky headers, floating footers, and paused
animations while it works.

For apps whose page doesn't scroll but a middle pane does (Gmail, Drive, Docs,
and similar), the extension captures the pane's full content **and keeps the
surrounding chrome** — the top header and the side bar are taken from the first
frame and preserved in the stitched image, instead of being cropped away. The
scroll pane is found in the page or in a **same-origin iframe** (AWS Console and
other consoles embed content in a frame).

If no scroll region can be driven — a **cross-origin** iframe, or a list that
scrolls via JS transforms with no real scrollbar — the extension captures the
single visible viewport rather than failing. For a full-length capture of those
pages, use Lumia's **Screen Scroll** method instead.

Works in Chrome, Edge, Brave, and other Chromium browsers (Chrome 116+).

## Ways to start a capture

- **Toolbar icon** — click the extension's icon to open a menu with three
  modes:
  - **Visible area** — just what's currently on screen (one frame).
  - **Full page** — scroll and stitch the whole page (or the app's inner
    scroll pane / same-origin iframe), keeping header + sidebar chrome.
  - **Select area** — hover to highlight the element under the cursor; the tip
    shows what it is and a **green** outline means it scrolls (**cyan** =
    static). A small **d-pad** (or the **↑ ↓ ← →** keys) refines the
    selection along the DOM tree — **▲/↑** out a level (parent), **▼/↓** in a
    level (child), **◀ ▶/← →** between same-level siblings — so you can land on
    a scroll pane that's covered by its children. Elements inside **same-origin
    iframes** (e.g. the AWS console content frame) can be picked too. Click (or
    Enter) captures exactly that element: scroll-stitched if it's a scroll pane,
    otherwise a single frame — with no surrounding page chrome. **Esc**,
    right-click, or switching away cancels.

  A status dot on the icon shows connectivity: green when the Lumia app is
  reachable, red when it isn't.
- **From the Lumia app / hotkey** — full-page capture. With one browser
  connected it starts immediately; with several, Lumia shows a picker with a
  live preview of each browser's active tab.

During a capture the browser window is focused and page interaction is locked
by an invisible full-screen blocker; a small status pill at the bottom shows
progress (`Lumia capturing 3/12…`) with a **Stop & save** button that ends the
scroll early — Lumia stitches the frames captured so far. Only the tiny pill
is hidden for the instant each frame is photographed (the blocker is
transparent and never flickers), so nothing extension-drawn appears in the
result.

## Install

**From the Chrome Web Store (recommended)** — once the listing is public, use the
**Add to Chrome** button on Lumia's Dashboard → Scroll → Browser Extension card
(or the store page directly). Works in Chrome, Edge, Brave, Opera, and other
Chromium browsers, and auto-updates.

**Load unpacked (developer)** — for local builds / before the store listing is live:

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder.
4. Make sure the Lumia desktop app is running — the extension connects to it
   automatically (a "Connected" dot appears on Lumia's Scroll tab within a few
   seconds).

## How it talks to Lumia

- Lumia listens on `ws://127.0.0.1:51763` (falling back to 51764/51765).
- The extension's service worker connects out to that port and identifies
  itself; Lumia rejects any connection that doesn't come from a browser
  extension origin, so web pages can't reach the bridge.
- No data ever leaves your machine — frames go straight from the browser to
  the local Lumia process.

## Permissions

| Permission | Why |
|---|---|
| `tabs` + `<all_urls>` | `captureVisibleTab` screenshots of the active tab |
| `scripting` | scroll the page and neutralize sticky/fixed overlays during capture |
| `alarms` | reconnect to Lumia if the connection drops |

Browser-internal pages (`chrome://…`, the Web Store, `about:…`) cannot be
captured — use Lumia's classic Screen scroll mode for those.
