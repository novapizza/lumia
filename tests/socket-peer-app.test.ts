import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appNameFromProcessPath, peerPidFromLsof } from '../electron/socket-peer-app.ts'

test('appNameFromProcessPath names the outermost .app, not a helper inside it', () => {
  // Arc's network helper, the process that owns the extension's socket.
  assert.equal(
    appNameFromProcessPath('/Applications/Arc.app/Contents/Frameworks/ArcCore.framework/Helpers/Browser Helper (Aperitif).app/Contents/MacOS/Browser Helper (Aperitif)'),
    'Arc',
  )
  assert.equal(
    appNameFromProcessPath('/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/131.0/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper'),
    'Google Chrome',
  )
  assert.equal(appNameFromProcessPath('/Users/me/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'), 'Brave Browser')
})

test('appNameFromProcessPath gives null outside an app bundle', () => {
  assert.equal(appNameFromProcessPath('/usr/local/bin/node'), null)
  assert.equal(appNameFromProcessPath(''), null)
})

test('peerPidFromLsof picks the process that is not ours', () => {
  const out = 'p2595\ncElectron\nf72\np66709\ncBrowser Helper (Aperitif)\nf43\n'
  assert.equal(peerPidFromLsof(out, 2595), 66709)
  assert.equal(peerPidFromLsof(out, 66709), 2595)
})

test('peerPidFromLsof gives null when only our own process is listed', () => {
  assert.equal(peerPidFromLsof('p2595\ncElectron\nf72\n', 2595), null)
  assert.equal(peerPidFromLsof('', 2595), null)
})
