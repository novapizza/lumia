# Dashboard top section (removed 2026-11-18)

The Dashboard's top section was taken out to strip the screen down to the
AppBar (logo, theme, Settings) and the Recent area. This file records what was
there so it can be brought back or redesigned. The removed JSX is at the end,
verbatim. Its helpers are still in `src/windows/dashboard/Dashboard.tsx`
(nothing else was deleted): `MediaKindToggle`, `CAPTURE_MODES`, `VIDEO_MODES`,
`MODE_ACTION`, `KeyCombo`, `CaptureSelfToggle`, plus the state and handlers
(`mediaKind` / `selectMediaKind`, `hotkeys`, `handleCapture`,
`handleRecordVideo`, scroll launch, `extStatus`, `showExtSetup`, `captureSelf`).

## What it had, top to bottom

1. **Kind toggle** (`MediaKindToggle`, left): segmented Image / Video / Scroll.
   Picks which capture tiles show below; the choice is saved as
   `lastCaptureKind` (so the tray / hotkey "new capture" repeats it).
2. **Greeting** (right): "Good morning/afternoon/evening" (`getGreeting()`),
   with "N screenshots · N recordings" under it, or "Start your first capture
   to get going" when history is empty.
3. **Capture tiles**, one row, depending on the kind:
   - Image: Region, Window, Screen. Each tile: icon box, label, its hotkey as
     key caps (`KeyCombo`, from `hotkeys[MODE_ACTION[mode]]`). Click starts
     that capture.
   - Video: Region, Window, Screen recording, same tile design (`VIDEO_MODES`).
   - Scroll: two method cards, **Browser Extension** (exact page capture via
     the companion extension) and **Screen Scroll** ("Works with any app or
     window"). Under them a link "How to install the extension" / "Install on
     another browser or profile" that opens the **extension setup box**:
     install steps, "Add to Chrome" (gradient, only when
     `RENDERER_VITE_CHROME_WEB_STORE_URL` is set), the manual "Load unpacked"
     steps, "Open Extension Folder", and a status line (outdated warning in
     amber, "Connected · <browser>" in green, or "Waiting for the extension to
     connect…" with a pulsing dot).
4. **"Include Lumia's own window in captures"** checkbox (`CaptureSelfToggle`),
   under the image tiles: normally the app hides itself before a capture;
   this keeps it visible.

## Where the features still live

- Starting captures: global hotkeys (Ctrl+Shift+1…8), the tray menu, and the
  browser extension's toolbar popup.
- Scroll capture: Ctrl+Shift+5 (back since 2026-11-25) with the method from
  Settings › General › Capture scroll with (shown while the extension is
  connected), the capture overlay's Scroll tab, and the extension popup. The
  extension setup help is still only reachable here.
- "Include Lumia's own window" has no other UI.

## Removed JSX (verbatim)

```tsx
      <div className="px-5 pt-4 space-y-8 flex-shrink-0 app-drag">

      {/* ── Media kind toggle + Greeting ── */}
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <MediaKindToggle value={mediaKind} onChange={selectMediaKind} />
        <div className="text-right">
          <h1
            className="text-3xl font-extrabold tracking-tight text-fg"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            {getGreeting()}
          </h1>
          <p className="text-sm text-fg-tertiary mt-1.5" style={{ fontFamily: 'Manrope, sans-serif' }}>
            {recentItems.length === 0
              ? 'Start your first capture to get going'
              : `${screenshots.length} screenshot${screenshots.length !== 1 ? 's' : ''} · ${recordings.length} recording${recordings.length !== 1 ? 's' : ''}`}
          </p>
        </div>
      </header>

      {/* ── Capture Actions ── */}
      <section>
        {mediaKind === 'image' ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {CAPTURE_MODES.map(({ mode, icon, label }) => {
                const accel = hotkeys[MODE_ACTION[mode]]
                const keys = accel ? parseShortcut(accel) : []
                return (
                  <button
                    key={mode}
                    onClick={() => handleCapture(mode)}
                    className="group w-44 flex items-center gap-3 px-3 py-3 rounded-xl
                               bg-control border border-line-subtle shadow-lift
                               hover:bg-control-hover hover:border-line
                               active:scale-[0.98] transition-all duration-200 "
                  >
                    <div className="w-9 h-9 rounded-lg bg-fill flex items-center justify-center flex-shrink-0
                                    group-hover:bg-fill-hover transition-colors duration-200">
                      <Icon name={icon} className="text-fg-secondary group-hover:text-fg transition-colors text-[20px]" />
                    </div>
                    <div className="text-left min-w-0">
                      <span
                        className="block text-xs font-semibold text-fg group-hover:text-fg transition-colors truncate"
                        style={{ fontFamily: 'Manrope, sans-serif' }}
                      >
                        {label}
                      </span>
                      {keys.length > 0 && <KeyCombo keys={keys} />}
                    </div>
                  </button>
                )
              })}
            </div>

            <CaptureSelfToggle checked={captureSelf} onChange={handleCaptureSelfChange} />
          </div>
        ) : mediaKind === 'video' ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {VIDEO_MODES.map(({ mode, icon, label }) => {
                const hotkey = hotkeys[VIDEO_MODE_ACTION[mode]]
                return (
                  <button
                    key={mode}
                    onClick={() => handleVideo(mode)}
                    className="group w-44 flex items-center gap-3 px-3 py-3 rounded-xl
                               bg-control border border-line-subtle shadow-lift
                               hover:bg-control-hover hover:border-line
                               active:scale-[0.98] transition-all duration-200 "
                  >
                    <div className="w-9 h-9 rounded-lg bg-fill flex items-center justify-center flex-shrink-0
                                    group-hover:bg-fill-hover transition-colors duration-200">
                      <Icon name={icon} className="text-fg-secondary group-hover:text-fg transition-colors text-[20px]" />
                    </div>
                    <div className="text-left min-w-0">
                      <span
                        className="block text-xs font-semibold text-fg group-hover:text-fg transition-colors truncate"
                        style={{ fontFamily: 'Manrope, sans-serif' }}
                      >
                        {label}
                      </span>
                      {hotkey && <KeyCombo keys={parseShortcut(hotkey)} />}
                    </div>
                  </button>
                )
              })}
            </div>
            <CaptureSelfToggle checked={captureSelf} onChange={handleCaptureSelfChange} />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {/* Browser Extension — exact DOM offsets, no stitch guessing */}
              <button
                onClick={() => handleScroll('extension')}
                className="group w-64 flex items-center gap-3 px-3 py-3 rounded-xl
                           bg-control border border-line-subtle shadow-lift
                           hover:bg-control-hover hover:border-line
                           active:scale-[0.98] transition-all duration-200 "
              >
                <div className="w-9 h-9 rounded-lg bg-fill flex items-center justify-center flex-shrink-0
                                group-hover:bg-fill-hover transition-colors duration-200">
                  <Icon name="extension" className="text-fg-secondary group-hover:text-fg transition-colors text-[20px]" />
                </div>
                <div className="text-left min-w-0 flex-1">
                  <span
                    className="block text-xs font-semibold text-fg group-hover:text-fg transition-colors truncate"
                    style={{ fontFamily: 'Manrope, sans-serif' }}
                  >
                    Browser Extension
                  </span>
                  <span className="flex items-center gap-1.5 mt-1">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${extStatus.connected ? (extStatus.outdated?.length ? 'bg-warning-text' : 'bg-success-text') : 'bg-line-strong'}`} />
                    <span className={`text-[10px] font-medium truncate ${extStatus.connected ? (extStatus.outdated?.length ? 'text-warning-text' : 'text-success-text') : 'text-fg-tertiary'}`}>
                      {extStatus.connected
                        ? extStatus.outdated?.length
                          ? 'Connected · extension update available'
                          : `Connected · ${extStatus.browsers.length > 1
                              ? `${extStatus.browsers.length} browsers`
                              : extStatus.browsers[0] ?? 'browser'}`
                        : 'Not connected — click to set up'}
                    </span>
                  </span>
                </div>
              </button>

              {/* Classic screen scroll — synthetic wheel + stitch, any app */}
              <button
                onClick={() => handleScroll('screen')}
                className="group w-64 flex items-center gap-3 px-3 py-3 rounded-xl
                           bg-control border border-line-subtle shadow-lift
                           hover:bg-control-hover hover:border-line
                           active:scale-[0.98] transition-all duration-200 "
              >
                <div className="w-9 h-9 rounded-lg bg-fill flex items-center justify-center flex-shrink-0
                                group-hover:bg-fill-hover transition-colors duration-200">
                  <Icon name="swipe_down" className="text-fg-secondary group-hover:text-fg transition-colors text-[20px]" />
                </div>
                <div className="text-left min-w-0 flex-1">
                  <span
                    className="block text-xs font-semibold text-fg group-hover:text-fg transition-colors truncate"
                    style={{ fontFamily: 'Manrope, sans-serif' }}
                  >
                    Screen Scroll
                  </span>
                  <span className="block text-[10px] font-medium text-fg-tertiary mt-1 truncate">
                    Works with any app or window
                  </span>
                </div>
              </button>
            </div>

            {/* Always-available entry to the install guide — so you can add the
                 extension to another browser or profile even when one is
                 already connected. */}
            <button
              onClick={() => setShowExtSetup(v => !v)}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium text-fg-tertiary hover:text-fg transition-colors"
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              <Icon name={showExtSetup ? 'expand_less' : 'add'} className="text-[14px]" />
              {extStatus.connected ? 'Install on another browser or profile' : 'How to install the extension'}
            </button>

            {showExtSetup && (
              <div className="max-w-xl p-4 rounded-xl bg-control border border-line-subtle shadow-lift space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold text-fg" style={{ fontFamily: 'Manrope, sans-serif' }}>
                    Install the browser extension
                  </p>
                  <button onClick={() => setShowExtSetup(false)} className="text-fg-tertiary hover:text-fg transition-colors">
                    <Icon name="close" className="text-[14px]" />
                  </button>
                </div>
                <p className="text-[11px] text-fg-secondary leading-relaxed">
                  Capture scrolling screenshots straight from your browser. Install it in each browser or
                  profile you want to use — Lumia connects automatically and the dot turns green.
                  To start captures from <span className="text-fg-secondary">this app</span> (instead of the
                  extension's own menu), click the extension icon once and press{' '}
                  <span className="text-fg-secondary">"Allow captures from the app"</span>.
                </p>

                {/* Primary: one-click Chrome Web Store install (Chromium browsers) */}
                {CHROME_WEB_STORE_URL ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => window.electronAPI?.openExternal?.(CHROME_WEB_STORE_URL)}
                        className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-bold primary-gradient text-on-accent hover:opacity-90 active:scale-[0.98] transition-all"
                        style={{ fontFamily: 'Manrope, sans-serif' }}
                      >
                        <Icon name="extension" className="text-[14px]" />
                        Add to Chrome
                      </button>
                      <button
                        onClick={async () => {
                          await window.electronAPI?.writeClipboardText?.(CHROME_WEB_STORE_URL)
                          setStoreUrlCopied(true)
                          setTimeout(() => setStoreUrlCopied(false), 1600)
                        }}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-fill border border-line text-fg hover:bg-fill-hover active:scale-[0.98] transition-all"
                        style={{ fontFamily: 'Manrope, sans-serif' }}
                      >
                        <Icon name={storeUrlCopied ? 'check' : 'content_copy'} className="text-[14px]" />
                        {storeUrlCopied ? 'Copied' : 'Copy link'}
                      </button>
                    </div>
                    <p className="text-[10px] text-fg-tertiary">
                      Opens in your default browser — if that isn't Chrome, copy the link and paste it into the
                      browser you want. Works in Edge, Brave, Opera, and other Chromium browsers.
                    </p>
                  </div>
                ) : (
                  <p className="text-[10px] text-fg-tertiary italic">A one-click Chrome Web Store install is on the way. For now, load it manually:</p>
                )}

                {/* Secondary: manual load-unpacked, collapsed once the store link exists */}
                <details open={!CHROME_WEB_STORE_URL} className="group">
                  <summary className="select-none text-[11px] font-semibold text-fg-secondary hover:text-fg transition-colors">
                    Install manually (developer mode)
                  </summary>
                  <ol className="mt-2 text-[11px] text-fg-secondary space-y-1 list-decimal list-inside">
                    <li>Open the extension folder below.</li>
                    <li>Go to <span className="text-fg-secondary font-mono">chrome://extensions</span> and enable <span className="text-fg-secondary">Developer mode</span>.</li>
                    <li>Click <span className="text-fg-secondary">Load unpacked</span> and select the folder.</li>
                    <li>Keep Lumia running — the status dot turns green within a few seconds.</li>
                  </ol>
                  <button
                    onClick={() => window.electronAPI?.openScrollExtensionFolder?.()}
                    className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-fill text-fg-secondary hover:text-fg hover:bg-fill-hover border border-line-subtle transition-all"
                    style={{ fontFamily: 'Manrope, sans-serif' }}
                  >
                    <Icon name="folder_open" className="text-[14px]" />
                    Open Extension Folder
                  </button>
                </details>

                {/* Live connection status */}
                {extStatus.connected && !!extStatus.outdated?.length && (
                  <div className="flex items-start gap-1.5 pt-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-warning-text flex-shrink-0 mt-1" />
                    <span className="text-[10px] text-warning-text leading-relaxed">
                      The extension in {extStatus.outdated.join(', ')} is older than the copy this app ships
                      {extStatus.bundledVersion ? ` (v${extStatus.bundledVersion})` : ''} — captures still work, but
                      without the latest fixes. Update it from the Web Store, or for a manually loaded extension
                      press Reload on <span className="font-mono text-warning-text">chrome://extensions</span>.
                    </span>
                  </div>
                )}
                {extStatus.connected ? (
                  <div className="flex items-center gap-1.5 pt-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-success-text flex-shrink-0" />
                    <span className="text-[10px] text-success-text">
                      Connected{extStatus.browsers.length
                        ? ` · ${extStatus.browsers.length > 1 ? `${extStatus.browsers.length} browsers` : extStatus.browsers[0]}`
                        : ''} — install it in another browser or profile above to add it there too.
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 pt-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-line-strong animate-pulse flex-shrink-0" />
                    <span className="text-[10px] text-fg-tertiary">Waiting for the extension to connect…</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      </div>

```

## Loading that went with it (2026-11-27)

The launcher's state (`hotkeys`, `mediaKind`, `captureSelf`, `scrollMethod`, `extStatus`, `showExtSetup`, `storeUrlCopied`), its handlers and its helper components are still in `Dashboard.tsx`. What filled that state when the Dashboard opened was taken out, since nothing read it and the extension listener re-rendered the whole Dashboard on every status change. To bring the launcher back, put this into the Dashboard's mount effect again, and its two `removeAllListeners` lines into the cleanup:

```tsx
window.electronAPI?.getHotkeys().then(h => { if (h) setHotkeys(h) })
window.electronAPI?.getSettings().then(s => {
  // Scroll is never remembered as the active kind, so only Image / Video.
  if (s?.lastCaptureKind === 'video' || s?.lastCaptureKind === 'image') setMediaKind(s.lastCaptureKind)
  setCaptureSelf(!!s?.captureSelfWindow)
})
// Extension status for the Scroll tab: first pull, then live.
window.electronAPI?.getScrollExtensionStatus?.().then(st => { if (st) setExtStatus(st) })
window.electronAPI?.onScrollExtensionStatus?.(st => setExtStatus(st))
// cleanup:
window.electronAPI?.removeAllListeners('scroll-extension:status')
```

Also removed the same day, not needed for the launcher: listeners for `capture:ready` and `recorder:open` (main never sends either; captures reach the editor through `navigate`), and the unused `loadedItems`.
