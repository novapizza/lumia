// Popup UI for Lumia Scroll Capture. Three capture modes; each asks the
// service worker to start a capture pinned to the active tab. Also shows the
// connection status to the Lumia desktop app.

const dot = document.getElementById('dot')
const statusText = document.getElementById('statusText')
const hint = document.getElementById('hint')
const buttons = ['viewport', 'fullpage', 'region'].map(id => document.getElementById(id))

function setConnected(connected) {
  dot.className = 'dot ' + (connected ? 'on' : 'off')
  statusText.textContent = connected ? 'Connected' : 'App offline'
  statusText.style.color = connected ? '#22c55e' : '#ef4444'
  buttons.forEach(b => { b.disabled = !connected })
  hint.innerHTML = connected
    ? ''
    : 'Start the Lumia desktop app, then reopen this menu. The dot turns green when connected.'
}

chrome.runtime.sendMessage({ type: 'lumia-get-status' }, (res) => {
  setConnected(!!(res && res.connected))
})

function start(mode) {
  chrome.runtime.sendMessage({ type: 'lumia-ui-start', mode }, (res) => {
    if (res && res.ok) {
      window.close() // capture is under way in the browser / Lumia takes over
      return
    }
    const err = res && res.error
    if (err === 'not-connected') { setConnected(false); return }
    if (err === 'cancelled') { window.close(); return }
    hint.textContent =
      err === 'restricted-page' ? "This page can't be captured (browser-internal page)."
      : err === 'no-tab' || err === 'no-window' ? 'No active tab to capture.'
      : 'Could not start the capture.'
  })
}

document.getElementById('viewport').addEventListener('click', () => start('viewport'))
document.getElementById('fullpage').addEventListener('click', () => start('fullpage'))
document.getElementById('region').addEventListener('click', () => start('region'))
