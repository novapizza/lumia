import { reportFileGone } from '../lib/strip-worker'
import { type MouseEvent as ReactMouseEvent } from 'react'
import type { HistoryItem } from '../types'
import { Icon } from './Icon'
import { ClipActionButton } from './ClipActionButton'
import { durationParts, formatDimensions, recordingLengthMs, KIND_ICON, fileTipText } from '../utils/captureLabels'

/** Where a clip was captured, for the list row's source column and the grid
 *  card's status bar: the kind of capture, and for window and scroll
 *  captures the app and window title (either may be missing). */
export function clipSource(item: HistoryItem) {
  const mode = item.captureMode
  const source = item.source
  return { mode, parts: [source?.app, source?.title].filter(Boolean) as string[], multiple: !!source?.multiple }
}

/** The source as text: the app and window title with a " / " between them
 *  in fg-disabled, or "Region" / "Screen" for those without one (2026-11-23:
 *  a region or screen showing a single window carries its source too). */
export function SourceText({ mode, parts, multiple }: ReturnType<typeof clipSource>) {
  // Several windows in a region / screen (2026-11-23): "Region / Multiple".
  if ((mode === 'region' || mode === 'screen') && multiple) return (
    <>{mode === 'region' ? 'Region' : 'Screen'}<span className="text-fg-disabled"> / </span>Multiple</>
  )
  if (mode === 'region' && !parts.length) return <>Region</>
  if (mode === 'screen' && !parts.length) return <>Screen</>
  return <>{parts.map((part, i) => (
    <span key={i}>{i > 0 && <span className="text-fg-disabled"> / </span>}{part}</span>
  ))}</>
}

// The source column's icon for each kind of capture lives in
// utils/captureLabels.ts (shared with the capture overlay, whose lean entry
// mustn't pull in this component).
export { KIND_ICON } from '../utils/captureLabels'

/** A status tag's pill (list rows): a 14px icon on a 20px pill. */
const TAG_ICON = 'h-5 px-1 inline-flex items-center rounded-full'

const TAG_FILL = {
  warning: 'bg-[color-mix(in_oklab,var(--color-warning-subtle),var(--color-warning-text)_var(--tag-mix))] text-warning-text',
  success: 'bg-[color-mix(in_oklab,var(--color-success-subtle),var(--color-success-text)_var(--tag-mix))] text-success-text',
}

interface HistoryListRowProps {
  item: HistoryItem
  isSelecting: boolean
  isSelected: boolean
  isUploading: boolean
  uploadReady: boolean
  /** Every place it can go has its link: Upload shows as Copy link
   *  (2026-11-23; was: any upload). */
  uploadLinked: boolean
  /** Its Upload menu is open: no tooltip on the button. */
  menuOpen?: boolean
  onToggleSelect: () => void
  onOpen: () => void
  onDelete: () => void
  onCopy: () => void
  /** Gets the Upload button, for the Upload menu's place. */
  onUpload: (el: HTMLElement) => void
  onDownload?: () => void
}

/** One clip in the Dashboard's list view (reworked 2026-11-21 to follow the
 *  grid card). A 50px row (56px until 2026-11-21; its thumbnail 36px, 7px
 *  in from top and bottom) on the toolbar layer (`bg-toolbar`: it scrolls
 *  with the clips, like the day labels and the card's status bar, so it may
 *  not look higher than the app bar), left to right:
 *  the actions (the selection circle in their place in select mode), a 4:3
 *  thumbnail, the type icon + file name, the source app + window title, the
 *  length or pixel size, the file size, the capture time and the status
 *  tags (Missing, Uploaded), each in a column of its own.
 *  Everything the grid card shows, plus what only fits in a row: the name,
 *  the source, the file size.
 *
 *  All its text is one size and weight, 11px medium Manrope (`text-[11px]
 *  font-medium` on the row, final 2026-11-23; 10px and 12px medium
 *  tried, 11px light mono before), with tabular digits
 *  so the numbers line up. The app font in place of the system mono
 *  (`font-mono`, SF Mono / Consolas, 2026-11-21; final 2026-11-23).
 *
 *  As on the card: no hover colour; no Edit (a click opens the clip, a
 *  cloud-only one after restoring it from its upload); a missing file gets
 *  a cover, a warning edge and a greyscale thumbnail; the edge, the
 *  selected outline and the focus ring are inset rings on overlays. Unlike
 *  the card, the actions are always shown (disabled when they can't run;
 *  hidden, space kept, in select mode). */
export function HistoryListRow({
  item, isSelecting, isSelected, isUploading, uploadReady, uploadLinked, menuOpen,
  onToggleSelect, onOpen, onDelete, onCopy, onUpload, onDownload,
}: HistoryListRowProps) {
  // fileGone: the local file isn't on disk (nothing that needs it can run).
  // An uploaded clip without its file is cloud only: it shows Missing and
  // Uploaded but no cover or warning edge (its upload is safe), Download
  // takes Copy's place and Upload copies its link (2026-11-21). A missing
  // file that was never uploaded disables everything but Delete.
  const realUploaded = !!item.uploads?.some(u => u.success)
  const fileGone = !!item.fileMissing
  const cloudOnly = fileGone && realUploaded
  const showMissing = fileGone && !realUploaded
  const isUploaded = realUploaded
  const showUploaded = isUploaded && !showMissing
  const thumb = item.thumbnailUrl ?? item.dataUrl

  // Length or pixel size, then the date and time (24-hour clock; see below). The
  // units sit 1px after their numbers, like the card.
  // A missing file shows neither (2026-11-27): an image's size is read from
  // the file, so it was already gone; a recording's length is saved in its
  // row and stayed.
  const lengthMs = item.type === 'recording' && !item.fileMissing ? recordingLengthMs(item) : undefined
  const measure = item.type === 'recording'
    ? (lengthMs != null ? durationParts(lengthMs).map((p, i) => <span key={i}>{i > 0 && ' '}{p.value}<span className="ml-px">{p.unit}</span></span>) : null)
    : formatDimensions(item)
  // Date and time (2026-11-22; the time alone before, the day being in the
  // day label above): YYYY-MM-DD HH:MM, fixed width in the mono font, the
  // order the file names use ("22 Nov 2026 10:31" tried).
  const when = new Date(item.timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  const timeText = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`
  // File size of the file the row stands for (edited / trimmed copy, else
  // the original; read by the main process), number and unit 1px apart.
  const bytes = item.size
  const fileSize = bytes == null ? null
    : bytes >= 1e6 ? <>{(bytes / 1e6).toFixed(1)}<span className="ml-px">MB</span></>
    : <>{Math.max(1, Math.round(bytes / 1e3))}<span className="ml-px">KB</span></>
  // Where it was captured: an icon for the kind of capture (window, region,
  // screen, scrolled page), then for window and scroll captures the app, a
  // " / " (in fg-disabled, two steps quieter) and the window title (either part may be missing; a
  // symbol, not "·" or "—", which window titles use themselves), for
  // region and screen captures, which have no single source, the kind's
  // name. Clips from before 2026-11-21 have no kind: no icon, and the
  // source if they have one.
  const src = clipSource(item)
  const kindIcon = src.mode ? KIND_ICON[src.mode] : null
  const sourceContent = <SourceText {...src} />

  const stop = (fn: () => void) => (e: ReactMouseEvent) => { e.stopPropagation(); fn() }

  return (
    <div
      // isolate: the row's own z layers (10 to 30) stack inside the row, so
      // they never paint over the sticky day labels (z-30) as it scrolls by.
      // 10px from the row's edge to its 32px buttons all round (final
      // 2026-11-23), like the AppBar's and the floating bars' padding
      // (h-[52px] px-2.5; was h-[50px] px-2, 9px and 8px).
      className={`group relative isolate h-[52px] px-2.5 flex items-center gap-6 rounded-lg bg-toolbar text-[11px] font-medium tabular-nums outline-none ${showMissing ? '' : 'hover-overlay hover-overlay-inset'}`}
      tabIndex={0}
      data-clip
      data-id={item.id}
      onClick={isSelecting ? onToggleSelect : ((fileGone && !cloudOnly) || showMissing ? undefined : onOpen)}
      onKeyDown={e => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
        e.preventDefault()
        if (isSelecting) onToggleSelect()
        else if ((!fileGone || cloudOnly) && !showMissing) onOpen()
      }}
      // The file's name with its extension (2026-11-27), as on the card.
      data-tip={fileTipText(item)}
      data-tip-follow
      data-tip-key
    >
      {/* Actions and thumbnail as one group, 10px apart (gap-2.5): the same
          as the row's edge to the first button (px-2.5), counting button
          boxes, not icons. */}
      <div className="shrink-0 flex items-center gap-2.5">
        {/* Actions column, first in the row (2026-11-21; was after the name,
            where it crowded the type and kind icons), as bare buttons (no
            fill or edge): Copy, Upload (one button for R2 / Drive, when
            either is set up), Delete. Every row has the same buttons in the
            same places, so the column holds its structure: one that can't
            run is shown disabled, not hidden (2026-11-21; the card hides
            them). A missing file: Copy and Upload disabled. A
            cloud-only clip (uploaded, file gone): Download in Copy's place
            (saves the uploaded copy); Upload turns into Copy link once the
            clip is uploaded, which needs no file. In select mode
            the selection circle takes the column instead (the card's:
            bg-elevated with an accent edge, filled when picked, centred);
            the buttons stay, invisible, so nothing in the row moves. */}
        {/* Only Delete and the selection circle sit above a missing
            file's cover (z-10); the disabled Copy and Upload go under it
            with the rest of the row (2026-11-21; the whole column was
            above it). */}
        <div className="relative shrink-0 flex items-center">
          <div className={`flex items-center ${isSelecting ? 'invisible' : ''}`}>
            {cloudOnly
              ? <ClipActionButton bare icon="download" label="Download" onClick={stop(() => onDownload?.())} unavailable={!onDownload} />
              : <ClipActionButton bare icon="content_copy" label="Copy" onClick={stop(onCopy)} unavailable={fileGone || showMissing} />}
            {/* Upload: the Drive icon until the clip is uploaded, then a
                link icon that copies its link (works without the file). */}
            {uploadReady && (
              <ClipActionButton
                bare
                icon={isUploading ? 'sync' : uploadLinked ? 'link' : 'add_to_drive'}
                label={isUploading ? 'Uploading…' : uploadLinked ? 'Copy link' : 'Upload'}
                onClick={e => { e.stopPropagation(); onUpload(e.currentTarget as HTMLElement) }}
                noTip={menuOpen}
                spinning={isUploading}
                unavailable={showMissing}
              />
            )}
            <span className="relative z-10"><ClipActionButton bare danger icon="delete" label="Delete" onClick={stop(onDelete)} /></span>
          </div>
          {isSelecting && (
            <div className="absolute inset-0 z-10 flex items-center justify-center">
              <button
                onClick={stop(onToggleSelect)}
                aria-label={isSelected ? 'Deselect' : 'Select'}
                className={`w-5 h-5 rounded-full flex items-center justify-center border border-accent ${
                  isSelected ? 'bg-accent text-on-accent' : 'bg-elevated'
                }`}
              >
                {isSelected && <Icon name="check" className="text-[14px]" />}
              </button>
            </div>
          )}
        </div>

        {/* Thumbnail on a content-fill well (one step under the row; shows
            while it loads, behind a window capture's transparent corners,
            and with an icon when there's no preview), 4:3 like the card's
            picture, 40px tall, 8px from the row's top and bottom (the row's
            8px corner may not be rounder than that). Its
            own ring-line edge (on an overlay) so a white capture still shows
            its edge. */}
        <div className="relative h-9 aspect-[4/3] shrink-0">
        <div className="w-full h-full rounded-sm overflow-hidden bg-content">
          {thumb ? (
            // A missing file's thumbnail in greyscale, under its cover (2026-11-21).
            <img
              src={thumb}
              loading="lazy"
              decoding="async"
              // A preview deleted outside Lumia: main checks and has it made again.
              onError={item.thumbnailUrl ? () => { void reportFileGone(item.id, 'thumbnail') } : undefined}
              className={`w-full h-full object-cover select-none ${showMissing ? 'grayscale' : ''}`}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Icon name={item.type === 'recording' ? 'videocam' : 'image'} className="text-fg-tertiary text-[16px]" />
            </div>
          )}
        </div>
          <div className="absolute inset-0 rounded-sm ring-1 ring-inset ring-line pointer-events-none" />
        </div>
      </div>

      {/* Columns (2026-11-21): every part has a column of its own, the
          same width on every row so they line up down the list, 16px apart
          (the row's gap-4); only the type icon shares the name's column.
          Left: actions, thumbnail, name, source (the flexible one); right:
          tags, length / size, file size, time. One line per row. */}

      {/* Name column: the type icon in its kind colour, 6px to the name
          (gap-1 + mr-0.5, as in the card's status bar). Exactly as wide as
          the longest file name Lumia writes, shown without its extension
          (2026-11-22): recording-YYYY-MM-DD-HH-MM-SS (29 characters; 34
          with .webm before). The width comes from that pattern itself, an
          invisible template under the name (digits as 0, all one width with
          tabular-nums), so it follows the font and size; 29ch fitted only
          the mono font (2026-11-22). It narrows only when the row is short
          of room. 16px after the thumbnail (-ml-2 on the row's gap-6,
          2026-11-22), as far as the Delete icon is before it (8px inside
          its 32px button + the gap-2). */}
      <div className="-ml-2 min-w-0 flex items-center gap-1">
        {item.type === 'recording' ? (
          <span data-tip="Video" aria-label="Video" className="flex shrink-0 mr-0.5 text-kind-video">
            <Icon name="smart_display" className="text-[14px]" />
          </span>
        ) : (
          <span data-tip="Image" aria-label="Image" className="flex shrink-0 mr-0.5 text-kind-image">
            <Icon name="image" className="text-[14px]" />
          </span>
        )}
        {/* Name without its extension (2026-11-22): the type icon before it
            already says image or video. */}
        <span className="relative min-w-0 overflow-hidden">
          <span aria-hidden className="invisible whitespace-nowrap">recording-0000-00-00-00-00-00</span>
          <span className="absolute inset-0 text-fg truncate">{item.name.replace(/\.[^./\\]+$/, '')}</span>
        </span>
      </div>

      {/* Source column, after the name: where the clip was captured,
          in fg like all the row's text: the kind's 14px icon in fg-secondary (window, region, screen: all
          20x18 like Lucide's Monitor; ScrollText for a scrolled page; 6px to the text), then for a window (or
          scrolled page) "App / Window title";
          a region: "Region"; a screen: "Screen"; empty for clips from
          before 2026-11-21. The flexible column: it takes the row's spare width
          and ends in an ellipsis when the title is longer. */}
      {/* source, size, file size and time in fg-secondary, only the name stays text-fg (all were text-fg). */}
      <span className="flex-1 min-w-0 flex items-center gap-1.5 text-fg-secondary">
        {kindIcon && <Icon name={kindIcon} className="text-[14px] shrink-0 text-fg-tertiary" />}
        <span className="min-w-0 truncate">{sourceContent}</span>
      </span>

      {/* Tags column: Missing and Uploaded (an uploaded clip whose file is
          gone shows both), on pale pills in their text colour, the fill
          mixed toward that text colour (--tag-mix in index.css: 12% in
          light mode, 20% in dark), so it's a step darker in light mode and
          a step lighter in dark. Missing: warning-subtle / warning-text
          (a missing, never-uploaded clip also gets the row's cover);
          Uploaded: success-subtle / success-text. Both stay in select mode
          (2026-11-21), as on the card. Pills centred in the column. Before the length /
          size again (2026-11-22; last in the row, after the time, from
          2026-11-21). Icons on the pills, not words
          (2026-11-21), each named by its tooltip. Missing: FileXCorner (the missing-files button's icon); Uploaded:
          RadioNarrow (the card's upload mark). 14px icon on a 20px pill
          (h-5 px-1), the same fills. The column is exactly the widest
          set: 2 pills x 22px + 1 gap x 4px = 48px (w-12). No Edited /
          Trimmed tag (dropped 2026-11-21: not important). Left out on a
          row without tags (2026-11-22, as on the card), so the source runs
          on until the row gap before the length / size. As wide as its pills
          (2026-11-22; a fixed, centred w-12 before), so the source also runs
          on until the row gap before them. */}
      {(showMissing || cloudOnly || showUploaded) && <div className="shrink-0 flex items-center gap-1">
        {(showMissing || cloudOnly) && <span data-tip="Missing" aria-label="Missing" className={`${TAG_ICON} ${TAG_FILL.warning}`}><Icon name="file_x_corner" className="text-[14px]" /></span>}
        {showUploaded && <span data-tip="Uploaded" aria-label="Uploaded" className={`${TAG_ICON} ${TAG_FILL.success}`}><Icon name="radio" className="text-[14px]" /></span>}
      </div>}

      {/* Length or pixel size, file size, time: one column each,
          right-aligned and tabular. The length / size has no fixed width
          (2026-11-21): everything to its right is fixed (file size,
          the fixed-width date and time), so its right edge lines up on
          every row anyway, and a short value ("9s") leaves its spare room
          to the source column, which then runs on until 16px before it.
          The file size column is as wide as its longest value, 000.0MB,
          from an invisible template (2026-11-22; a fixed w-11 before,
          which fitted 12.3MB at the old size), so it follows the font. */}
      {/* At least as wide as its usual widest values, from invisible
          templates in the same grid cell (2026-11-27: it was as wide as its
          value, so the tags before it moved with every row's length or size).
          Taller full-page captures (five digits) still widen it. */}
      <span className="shrink-0 grid justify-items-end tabular-nums text-fg-secondary whitespace-nowrap">
        <span aria-hidden className="invisible col-start-1 row-start-1">0000×0000</span>
        <span aria-hidden className="invisible col-start-1 row-start-1">00<span className="ml-px">m</span> 00<span className="ml-px">s</span></span>
        <span className="col-start-1 row-start-1">{measure}</span>
      </span>
      <span className="shrink-0 relative text-right tabular-nums text-fg-secondary whitespace-nowrap">
        <span aria-hidden className="invisible">000.0<span className="ml-px">MB</span></span>
        <span className="absolute inset-y-0 right-0">{fileSize}</span>
      </span>
      <span className="shrink-0 tabular-nums text-fg-secondary whitespace-nowrap">{timeText}</span>


      {/* A missing file (2026-11-21; on top of the Missing tag): the whole
          row is covered by its own fill at 40% (dark in dark mode, light in
          light mode), so everything reads as switched off, then a
          warning-subtle wash at 35% on top (2026-11-21; 60% / 25% before),
          and the edge is warning-line (index.css: solid, #421e00 dark,
          #e4c9b5 light, as strong as the other rows' ring-line). Both
          layers stop 1px inside the row (inset-px, radius 7px), inside the
          1px edge, so they never reach it. The actions column sits above
          the cover
          (z-10), so Delete stays at full strength, and so does the selection circle
          in its place in select mode, where the cover, edge and tag stay
          (2026-11-21: they used to hide, so missing clips couldn't be told
          apart while picking them to delete). */}
      {showMissing && <>
        <div className="absolute inset-px rounded-[7px] bg-toolbar/40 pointer-events-none" />
        <div className="absolute inset-px rounded-[7px] bg-warning-subtle/35 pointer-events-none" />
      </>}

      {/* Edge, selected outline and focus ring: inset rings on overlays, as
          on the card. (Joining a day's rows into one block with shared
          edges was tried 2026-11-21 and dropped: the space between rows
          reads better.) */}
      {/* the row gets the hover-overlay
          layer (see the row's className; not on a missing row, whose click
          does nothing outside select mode). An edge step to line-strong was
          tried, alone (too subtle) and with the overlay (not needed). */}
      <div className={`absolute inset-0 z-30 rounded-lg ring-1 ring-inset pointer-events-none ${showMissing ? 'ring-warning-line' : 'ring-line'}`} />
      {isSelected && <div className="absolute inset-0 z-30 rounded-lg ring-(length:--selection-ring) ring-inset ring-accent pointer-events-none" />}
      <div className="absolute inset-0 z-30 hidden group-focus-visible:block rounded-lg ring-2 ring-inset ring-focus pointer-events-none" />
    </div>
  )
}
