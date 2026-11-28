import { execFile } from 'child_process'

export interface SnippingHijackResult {
  /** When set, the registry write failed and the caller should surface this
   *  to the user: the Snipping Tool likely keeps (or doesn't get back) the
   *  PrintScreen key. Toast-style text; the raw error goes in `detail`. */
  warning?: string
  detail?: string
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
          warning: enabled
            ? "Couldn't give the key back to the Snipping Tool"
            : "Couldn't take the key from the Snipping Tool",
          detail: err.message || undefined,
        })
      } else {
        resolve({})
      }
    })
  })
}
