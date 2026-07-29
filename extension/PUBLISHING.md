# Publishing the extension to the Chrome Web Store

Updates are automated (`.github/workflows/publish-extension.yml`), but a few
things must be done **by hand once**. Every submission — first upload and every
update — is **reviewed by Google** before it goes live (usually hours to a few
days; longer here because the extension requests `<all_urls>` + `scripting`).

## 1. First submission (manual, once)

1. **Build the zip** (from the repo root, Windows PowerShell):
   ```powershell
   Compress-Archive -Force -DestinationPath lumia-extension.zip -Path `
     extension/manifest.json, extension/background.js, `
     extension/popup.html, extension/popup.js, `
     extension/icon16.png, extension/icon32.png, extension/icon48.png, extension/icon128.png
   ```
   (macOS/Linux: `cd extension && zip -r ../lumia-extension.zip . -x '*.md'`)
2. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   (one-time **$5** developer registration) → **Add new item** → upload the zip.
3. Fill the **store listing**: name, detailed description, category
   (*Productivity*), at least one **1280×800** (or 640×400) screenshot, and a
   small promo tile if asked.
4. Fill **Privacy practices**: a **privacy policy URL** is required, plus a
   justification for each permission and the single-purpose description. Draft
   justifications:
   - `<all_urls>` + `tabs` — capture screenshots of the page the user chooses to
     scroll-capture (`captureVisibleTab`).
   - `scripting` — scroll the page and neutralize sticky/fixed overlays during
     the capture.
   - `alarms` — reconnect to the local Lumia app if the socket drops.
   - Data use: frames go only to the local Lumia app over `127.0.0.1`; nothing
     is sent to any server.
5. **Submit for review.** Once approved, note the **Extension ID** (shown on the
   item's page) — the automation needs it.

## 2. API credentials for the automation (once)

1. In a [Google Cloud](https://console.cloud.google.com/) project: enable the
   **Chrome Web Store API**.
2. Configure the **OAuth consent screen** and **publish it to "In production"**.
   ⚠️ If it stays in *Testing*, the refresh token expires after **7 days** and CI
   breaks.
3. Create an **OAuth client ID** of type **Desktop app** → note `client_id` +
   `client_secret`.
4. Generate a **refresh token** once (e.g. via
   [`chrome-webstore-upload-keys`](https://github.com/fregante/chrome-webstore-upload-keys):
   `npx chrome-webstore-upload-keys`).

## 3. Add GitHub repo secrets (once)

`Settings → Secrets and variables → Actions`:

| Secret | Value |
|---|---|
| `CWS_EXTENSION_ID` | the item's Extension ID from step 1 |
| `CWS_CLIENT_ID` | OAuth client id |
| `CWS_CLIENT_SECRET` | OAuth client secret |
| `CWS_REFRESH_TOKEN` | refresh token from step 2 |

## 4. Releasing an update (repeatable)

```bash
git tag ext-v1.0.1
git push origin ext-v1.0.1
```

The workflow stamps `1.0.1` into `manifest.json`, zips `extension/`, and submits
to the store. Or run **Actions → Publish extension → Run workflow** and type a
version (untick *publish* to upload a reviewable draft without going live).

- The version **must increase** every time — the tag drives it, so just bump the
  tag. `manifest.json` in the repo stays at a baseline `version` and is
  overwritten in CI only.
- While a new version is in review, the currently-published version keeps
  working for existing users.

## Notes

- Chromium browsers (Edge, Brave, Opera, Vivaldi) can all install from the
  Chrome Web Store, so one Chrome listing covers them. To also list on the
  **Edge Add-ons** / **Firefox AMO** stores later, swap the publish step for
  [`PlasmoHQ/bpp`](https://github.com/PlasmoHQ/bpp).
- For internal/enterprise rollout without the store, force-install a self-hosted
  CRX via `ExtensionInstallForcelist` policy (bypasses review, but shows a
  "managed by your organization" banner and must be set per browser).
