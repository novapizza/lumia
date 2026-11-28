import { isAbsolute, relative, resolve } from 'node:path'

/* Comparing paths, in one place (2026-11-27: capture-folder.ts and
   folder-history.ts each had their own, one of them without the Windows
   case rule). Node only, unit-tested. */

/** A path as a key to compare by: resolved, and lower-cased on Windows,
 *  where "C:\Shots" and "c:\shots" are the same folder. */
export const pathKey = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))

/** `p` is inside `root`; with `orSame`, also when it is `root` itself.
 *  path.relative, not startsWith: "/Users/ann2" isn't inside "/Users/ann",
 *  and on Windows the case doesn't matter. */
export function isInside(root: string, p: string, orSame = false): boolean {
  const r = relative(resolve(root), resolve(p))
  if (r === '') return orSame
  return !r.startsWith('..') && !isAbsolute(r)
}
