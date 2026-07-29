# Chrome Web Store listing — copy to paste

Paste-ready text for the Developer Dashboard. Fields marked **[FILL]** need a
value only you have (URLs, contact). Screenshots must be produced by hand — see
the shot list at the bottom.

---

## Store listing tab

**Product name**
```
Lumia Scroll Capture
```

**Summary** (short description, ≤132 chars)
```
Full-page scrolling screenshots for the Lumia desktop app — exact-offset capture, no stitch artifacts, right in your browser.
```

**Category**
```
Productivity
```

**Language**
```
English (United States)
```

**Description** (detailed)
```
Lumia Scroll Capture takes full-page, scrolling screenshots of any web page and
sends them to the Lumia desktop app on the same computer for stitching,
annotation, and saving.

Because the extension reads the page's real scroll offsets from the DOM, the
stitched result has none of the seams, duplicated bars, or drift you get from
screen-scrape scrolling tools.

WHAT YOU CAN CAPTURE
• Visible area — just what's currently on screen (one frame).
• Full page — scroll the whole page (or an app's inner scroll pane) and stitch
  it into one tall image, keeping the header and sidebar chrome instead of
  cropping them away.
• Select area — pick any element on the page (a d-pad / arrow keys walk the DOM
  tree: parent, child, siblings) and capture exactly that box.

HOW IT WORKS
The extension scrolls the page in exact viewport steps, photographs each step,
and streams the frames with their precise offsets to the Lumia desktop app,
which composites them. A small on-page status bar shows progress and lets you
stop early and keep what's captured so far.

REQUIRES THE LUMIA DESKTOP APP
This extension is a companion to the Lumia desktop application and does nothing
on its own — install and run Lumia first. When the app is running, a green dot
appears on the extension's toolbar icon.

PRIVACY
Captured images are sent only to the Lumia app running on your own machine, over
a local (127.0.0.1) connection. Nothing is uploaded to the developer, to any
server, or to third parties. No analytics, no tracking.
```

**Official URL / Homepage URL** — **[FILL]** (e.g. `https://lumia.asia`)

**Support URL or email** — **[FILL]** (e.g. `support@lumia.asia`)

---

## Privacy tab

**Single purpose**
```
Lumia Scroll Capture takes full-page (scrolling) screenshots of the tab the user
chooses and delivers them to the Lumia desktop app running on the same computer
for stitching, annotation, and saving.
```

**Permission justifications**

`activeTab`
```
Captures started from the toolbar popup act on exactly the tab the user clicked
on: the extension calls chrome.tabs.captureVisibleTab and injects the scroll
script into that tab only, under the activeTab grant from the user's click.
```

`optional_host_permissions` (`<all_urls>`)
```
Optional, off by default. Only needed when the user starts a capture from the
Lumia DESKTOP APP instead of the popup (there is no browser gesture in that
flow, so activeTab cannot apply) and for the live tab preview shown in Lumia's
multi-browser picker. Requested with a single explicit opt-in button in the
popup ("Allow captures from the app"); every capture is still user-initiated.
```

`scripting`
```
The extension injects a content script into the active tab to measure the page,
scroll it in exact viewport steps, and temporarily neutralize sticky/fixed
elements so they don't repeat down the stitched image. The script is removed
when the capture ends.
```

`alarms`
```
Used to periodically reconnect the background service worker to the local Lumia
desktop app if the WebSocket connection to it drops.
```

**Are you using remote code?**  → **No** (all code is in the package).

**Data usage** — what the item handles / collects:
- Tick **Website content** (the extension reads the page's pixels to build the
  screenshot). In the explanation note: *"Captured images are transmitted only to
  the user's own Lumia desktop app over a local 127.0.0.1 connection; they are
  never sent to the developer, any server, or third parties."*
- Do **not** tick personally identifiable info, health, financial, authentication,
  personal communications, location, web history, or user activity — none are
  collected.

**Certifications** (tick all three):
- ☑ I do not sell or transfer user data to third parties, outside the approved use cases.
- ☑ I do not use or transfer user data for purposes unrelated to my item's single purpose.
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL** — **[FILL]**: host `extension/PRIVACY.md` (see that file) at a
public URL, e.g. GitHub Pages, or `https://lumia.asia/extension-privacy`.

---

## Distribution tab

- **Visibility**: Public (or Unlisted while testing).
- **Pricing**: Free.
- **Regions**: All.

---

## Screenshots (produce by hand — 1280×800 PNG, 1–5 images)

Suggested shots (crop/scale your desktop to 1280×800):

1. The extension popup open over a long article — three mode buttons + the green
   "Connected" dot. Caption: *"Three capture modes, one click."*
2. A full-page capture mid-scroll: the on-page status pill ("Lumia capturing
   4/11…") with the Stop & save button. Caption: *"Watch it scroll — stop
   anytime and keep what's captured."*
3. The Select-area picker highlighting an element with the d-pad visible.
   Caption: *"Pick exactly the element you want."*
4. The finished tall screenshot open in the Lumia desktop editor. Caption:
   *"Lands straight in Lumia to annotate and share."*
5. (optional) A Gmail/Docs full-page capture showing header + sidebar preserved.

**Small promo tile** (optional, 440×280): Lumia icon + "Scroll Capture".
