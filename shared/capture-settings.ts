/* Setting values main checks and Settings offers, in one place (2026-11-27:
   electron/settings.ts and Settings.tsx each listed them). */

/** When Lumia's window comes back after the capture overlay (Settings ›
 *  General › Open Lumia, Jasper 2026-11-27; it decides the window, not only
 *  the editor):
 *  - 'open' (default, the behaviour before): if the window was open before,
 *    whatever happened (the editor after a success, its page after a cancel
 *    or a failure); closed before, it stays away;
 *  - 'success': after a successful capture or recording, open before or not;
 *  - 'captures' / 'recordings': the same, for that kind only;
 *  - 'never': it stays away.
 *  After a success it comes back with the editor. Kept away, it counts as
 *  closed to the menu bar (system notification, focus to the app before). */
export type OpenLumiaWhen = 'open' | 'success' | 'captures' | 'recordings' | 'never'
/** In the order Settings lists them. */
export const OPEN_LUMIA_WHEN: readonly OpenLumiaWhen[] = ['open', 'success', 'captures', 'recordings', 'never']
/** Seconds the recording toolbar can count down from (0: off). */
export const RECORD_COUNTDOWNS: readonly number[] = [0, 3, 5]
