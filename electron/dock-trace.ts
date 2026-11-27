// TEMPORARY (2026-11-27): one log line for everything that can move the
// Dock or the app's activation on macOS, to find what slides an auto-hidden
// Dock up (design/OPEN-QUESTIONS.md › Temporary code). Lines go to main.log
// with its timestamps; remove this file and its calls when the cause is
// settled.
export function dockTrace(what: string): void {
  if (process.platform === 'darwin') console.log(`[dock-trace] ${what}`)
}
