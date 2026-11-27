import { homedir } from 'os'
import { join, resolve, normalize, relative, parse } from 'path'
import { isInside, pathKey } from './path-rules'
import { getSettings, setSetting } from './settings'

// Where captures and recordings are saved (Settings › General › Save to,
// 2026-11-27; it was always ~/Pictures/Lumia). Files keep their full path in
// history, so changing the folder leaves earlier files where they are.

export const DEFAULT_CAPTURE_FOLDER = join(homedir(), 'Pictures', 'Lumia')

/** The folder new captures and recordings go to. */
export function captureFolder(): string {
  return getSettings().captureFolder || DEFAULT_CAPTURE_FOLDER
}

/** Make `dir` the save folder. The one before stays allowed (its files are
 *  still in history), see isAllowedPath. */
export function setCaptureFolder(dir: string): void {
  const before = captureFolder()
  const past = getSettings().pastCaptureFolders ?? []
  if (pathKey(before) !== pathKey(dir) && !past.some(p => pathKey(p) === pathKey(before))) setSetting('pastCaptureFolders', [...past, before])
  setSetting('captureFolder', pathKey(dir) === pathKey(DEFAULT_CAPTURE_FOLDER) ? '' : resolve(dir))
}

/** What a handler answers for a path isAllowedPath refuses (it shows as a
 *  toast's second line). */
export const OUTSIDE_FOLDERS = "File is outside Lumia's folders"

/** Paths the renderer may have read, written, opened or deleted: the home
 *  directory (it always was) plus every save folder used so far, which can
 *  be outside it (an external drive). */
export function isAllowedPath(p: string): boolean {
  const target = resolve(normalize(p))
  // Stored folders pass the dialog's check again, so a hand-edited settings
  // file can't open up the whole disk.
  const saved = [captureFolder(), ...(getSettings().pastCaptureFolders ?? [])].filter(d => isSuitableSaveFolder(d, homedir()))
  return [homedir(), ...saved].some(root => isInside(root, target, true))
}

/** A folder Lumia may save to: not a drive's root, not a system folder, and
 *  on macOS / Linux inside the home folder or on another drive (/Volumes,
 *  /media, /mnt). Every save folder used stays readable and deletable
 *  through isAllowedPath, so this keeps that set sane. */
export function isSuitableSaveFolder(dir: string, home: string): boolean {
  const abs = resolve(dir)
  if (parse(abs).root === abs) return false
  if (process.platform === 'win32') {
    const lower = abs.toLowerCase()
    const sys = [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]
      .filter((d): d is string => !!d).map(d => resolve(d).toLowerCase())
    return !sys.some(d => lower === d || lower.startsWith(d + '\\'))
  }
  if (abs === resolve(home)) return false
  return isInside(home, abs) || ['/Volumes', '/media', '/mnt'].some(d => isInside(d, abs) && parse(relative(d, abs)).dir !== '')
}
