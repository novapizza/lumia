// Popup UI for Lumia Scroll Capture. Three capture modes; each asks the
// service worker to start a capture pinned to the active tab. Also shows the
// connection status to the Lumia desktop app.

// popup.html?tab: the page opened in a tab to ask for site access (Arc).
const inTab = new URLSearchParams(location.search).has('tab')
if (inTab) document.documentElement.classList.add('tab')

const status = document.getElementById('status')
const offline = document.getElementById('offline')
const error = document.getElementById('error')
const errorWhy = document.getElementById('errorWhy')
const perm = document.getElementById('perm')
const buttons = ['viewport', 'fullpage', 'region'].map(id => document.getElementById(id))

let connected = false
function setConnected(c) {
  connected = c
  status.hidden = !c
  offline.hidden = c
  buttons.forEach(b => { b.disabled = !c })
  if (!c) error.hidden = true
  refreshPerm()
}

function showError(why) {
  errorWhy.textContent = why || ''
  errorWhy.hidden = !why
  error.hidden = false
}

// The app's theme (sent over the connection, kept by the service worker):
// its role colours replace the system light / dark defaults in the CSS.
function applyTheme(theme) {
  if (!theme || !theme.roles) return
  const root = document.documentElement.style
  for (const [k, v] of Object.entries(theme.roles)) root.setProperty(`--${k}`, v)
  root.setProperty('color-scheme', theme.mode)
  root.setProperty('--icon-line', theme.mode === 'light' ? '1.35px' : '1px')
}

chrome.runtime.sendMessage({ type: 'lumia-get-status' }, (res) => {
  applyTheme(res && res.theme)
  setConnected(!!(res && res.connected))
})

// Live while open (2026-11-26; it showed the state from when it opened):
// the service worker tells us when the connection or the theme changes
// (it looks for Lumia every 2 s while it isn't there).
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'lumia-status') return
  applyTheme(msg.theme)
  if (msg.connected !== connected) setConnected(msg.connected)
})

// Popup-started captures ride on activeTab (granted by opening this popup).
// App-started captures + live tab previews need the optional <all_urls>
// grant: offered here, only while Lumia is connected (2026-11-26). The
// extension can't see installed apps; a connection means Lumia is there,
// and without it the grant does nothing ("Lumia isn't open" shows instead).
async function refreshPerm() {
  if (!connected) { perm.hidden = true; return }
  try {
    perm.hidden = await chrome.permissions.contains({ origins: ['<all_urls>'] })
  } catch { /* leave hidden */ }
}
document.getElementById('grant').addEventListener('click', async () => {
  try {
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] })
    if (granted && inTab) { window.close(); return }
  } catch {
    // Arc (2026-11-27): its popup isn't on a browser window, so the request
    // fails with "Could not find an active window" and no prompt shows. The
    // same page in a tab can ask; the user clicks Allow there.
    if (!inTab) {
      chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab') })
      window.close()
      return
    }
  }
  refreshPerm()
})

function start(mode) {
  error.hidden = true
  chrome.runtime.sendMessage({ type: 'lumia-ui-start', mode }, (res) => {
    if (res && res.ok) {
      window.close() // capture is under way in the browser / Lumia takes over
      return
    }
    const err = res && res.error
    if (err === 'not-connected') { setConnected(false); return }
    if (err === 'cancelled') { window.close(); return }
    showError(
      err === 'restricted-page' ? "Browser pages can't be captured"
      : err === 'no-tab' || err === 'no-window' ? 'No tab to capture'
      : '',
    )
  })
}

document.getElementById('viewport').addEventListener('click', () => start('viewport'))
document.getElementById('fullpage').addEventListener('click', () => start('fullpage'))
document.getElementById('region').addEventListener('click', () => start('region'))
