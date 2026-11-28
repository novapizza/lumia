import { useSyncExternalStore } from 'react'
import { RELEASES, type Release } from '../whats-new'

/* Dots that point at something new (2026-11-22):
   - Release notes: the installed version has release notes the user hasn't
     seen yet (remembered in localStorage per version). Goes 5s after a
     click on the Release notes nav item.
   - About: a newer version waits for the user, found (Update) or
     downloaded (Restart). Goes when the update is installed.
   Settings' nav items show them; the AppBar's Settings button shows a dot
   when any of them is on. */

const SEEN_KEY = 'lumia:notes-seen'

// Hold the "new release" state (2026-11-22, for the design review): the
// installed version's notes always count as unseen and the Release notes
// click doesn't clear them. Off since the review was locked in (2026-11-23);
// set true to see the new-notes dots again.
const HOLD_NEW_NOTES = false

/** A newer version, step by step with the user's consent (2026-11-22): a
 *  check finds it ('available', Update), Update downloads it
 *  ('downloading'), then it waits for Restart ('ready'). */
export interface PendingUpdate {
  phase: 'available' | 'downloading' | 'ready'
  version: string
}

interface State {
  realVersion: string
  notesSeen: string | null
  update: PendingUpdate | null
  /** The last check found nothing newer. */
  latest: boolean
}

function readSeen(): string | null {
  try { return localStorage.getItem(SEEN_KEY) } catch { return null }
}

let state: State = {
  realVersion: '',
  notesSeen: readSeen(),
  update: null,
  latest: false,
}
const listeners = new Set<() => void>()
function set(patch: Partial<State>) {
  state = { ...state, ...patch }
  listeners.forEach(f => f())
}

window.electronAPI?.getAppVersion?.().then(v => set({ realVersion: v })).catch(() => {})

function notesUnseen(s: State) {
  const v = s.realVersion
  if (!v || !RELEASES.some(r => r.version === v)) return false
  if (HOLD_NEW_NOTES) return true
  return s.notesSeen !== v
}

export interface Badges {
  installedVersion: string
  releases: Release[]
  /** The installed version's notes haven't been seen. */
  notesDot: boolean
  /** A newer version found, downloading or downloaded. */
  update: PendingUpdate | null
  /** It waits for the user (Update or Restart): About's dot. */
  updateDot: boolean
  /** The last check found nothing newer (Settings says "Latest version"). */
  latest: boolean
  /** Any Settings dot is on (the AppBar's Settings button). */
  settingsDot: boolean
}

let cached: { from: State; value: Badges } | null = null
function snapshot(): Badges {
  if (cached?.from === state) return cached.value
  const notesDot = notesUnseen(state)
  const updateDot = !!state.update && state.update.phase !== 'downloading'
  const value: Badges = {
    installedVersion: state.realVersion,
    releases: RELEASES,
    notesDot,
    update: state.update,
    updateDot,
    latest: state.latest && !state.update,
    settingsDot: notesDot || updateDot,
  }
  cached = { from: state, value }
  return value
}

export function useBadges(): Badges {
  return useSyncExternalStore(
    (f) => { listeners.add(f); return () => { listeners.delete(f) } },
    snapshot,
  )
}

/** A click on the Release notes nav item: its dot (and the Settings button's,
 *  if nothing else is new) goes 5s later (10s first), giving time to notice which
 *  release is new (Jasper, 2026-11-22). Module-level, so it fires even if
 *  Settings is left before then. */
let seenTimer: ReturnType<typeof setTimeout> | null = null
export function markNotesSeenSoon() {
  if (HOLD_NEW_NOTES || seenTimer) return
  // 5s (final 2026-11-23; was 10s).
  seenTimer = setTimeout(() => { seenTimer = null; markNotesSeen() }, 5_000)
}

export function markNotesSeen() {
  const v = state.realVersion
  if (!v || state.notesSeen === v) return
  try { localStorage.setItem(SEEN_KEY, v) } catch { /* the dot just comes back next launch */ }
  set({ notesSeen: v })
}

export function getUpdate(): PendingUpdate | null {
  return state.update
}

export function setUpdate(update: PendingUpdate | null) {
  set({ update, latest: update ? false : state.latest })
}

/** A check's answer: nothing newer (true), or unknown again (false). */
export function setLatest(latest: boolean) {
  if (state.latest !== latest) set({ latest })
}

/** The user's Update click: download the found version. */
export function downloadUpdate() {
  const u = state.update
  if (!u || u.phase !== 'available') return
  set({ update: { ...u, phase: 'downloading' } })
  window.electronAPI?.downloadUpdate?.().then(res => {
    // A failed download goes back to Update (the toast shows the error).
    if (!res?.ok && state.update?.phase === 'downloading') set({ update: { ...state.update, phase: 'available' } })
  })
}

/** The user's Restart click: install the downloaded version. */
export function installUpdate() {
  const u = state.update
  if (!u || u.phase !== 'ready') return
  window.electronAPI?.installUpdate()
}
