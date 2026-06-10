import { execFile } from 'child_process'

export interface SnippingHijackResult {
  /** When set, the registry write failed and the caller should surface this
   *  to the user — Snipping Tool will likely keep eating PrintScreen. */
  warning?: string
}

// Windows 11 controls "PrintScreen opens Snipping Tool" via a per-user DWORD
// under HKCU\Control Panel\Keyboard. Value 1 = Windows captures the key, 0 =
// the key reaches third-party hooks (us). HKCU is writable without elevation,
// so this works on standard accounts; corporate-locked profiles can still
// reject it, hence the warning return path. The registry value/path was
// added in the Snipping Tool migration; very old Win10 builds may not have
// it, but `reg add` will create it without error.
const REG_PATH = 'HKCU\\Control Panel\\Keyboard'
const REG_VALUE = 'PrintScreenKeyForSnippingEnabled'

/** Toggle Windows's PrintScreen → Snipping Tool hijack. No-op on non-Windows. */
export function setSnippingHijack(enabled: boolean): Promise<SnippingHijackResult> {
  if (process.platform !== 'win32') return Promise.resolve({})
  return new Promise(resolve => {
    execFile('reg', [
      'add', REG_PATH,
      '/v', REG_VALUE,
      '/t', 'REG_DWORD',
      '/d', enabled ? '1' : '0',
      '/f',
    ], { windowsHide: true }, (err) => {
      if (err) {
        resolve({
          warning: 'Could not update Windows registry — Snipping Tool may still capture PrintScreen. ' + (err.message || ''),
        })
      } else {
        resolve({})
      }
    })
  })
}
