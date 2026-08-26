import { type MouseEvent as ReactMouseEvent } from 'react'
import type { HistoryItem } from '../types'

interface HistoryListRowProps {
  item: HistoryItem
  isSelecting: boolean
  isSelected: boolean
  isSharing: boolean
  isSharingGdrive?: boolean
  gdriveReady?: boolean
  onToggleSelect: () => void
  onOpen: () => void
  onDelete: () => void
  onCopy: () => void
  onShare: () => void
  onShareGdrive?: () => void
}

export function HistoryListRow({
  item, isSelecting, isSelected, isSharing, isSharingGdrive, gdriveReady,
  onToggleSelect, onOpen, onDelete, onCopy, onShare, onShareGdrive,
}: HistoryListRowProps) {
  const date = new Date(item.timestamp).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  const isUploaded = item.uploads?.some(u => u.success)
  const hasDriveUpload = item.uploads?.some(u => u.destination === 'google-drive' && u.success)
  const size = item.size ? (item.size > 1e6 ? `${(item.size / 1e6).toFixed(1)} MB` : `${(item.size / 1e3).toFixed(0)} KB`) : ''

  const stop = (fn: () => void) => (e: ReactMouseEvent) => { e.stopPropagation(); fn() }

  const missing = item.fileMissing

  return (
    <div
      className={`group flex items-center gap-4 px-4 py-2.5 rounded-xl transition-all ${
        missing && !isSelecting ? 'opacity-50' : ''
      } ${
        missing ? 'cursor-default' : 'cursor-pointer'
      } ${
        isSelected
          ? 'bg-primary/10 border border-primary/20'
          : 'bg-white/[0.02] border border-transparent hover:bg-white/5 hover:border-white/5'
      }`}
      onClick={isSelecting ? onToggleSelect : (missing ? undefined : onOpen)}
      title={missing ? 'File no longer exists on disk' : undefined}
    >
      {/* Checkbox */}
      {isSelecting && (
        <button
          onClick={stop(onToggleSelect)}
          className={`w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 transition-all border ${
            isSelected
              ? 'bg-primary border-primary text-slate-900'
              : 'bg-white/5 border-white/10 hover:border-primary/40'
          }`}
        >
          {isSelected && <span className="material-symbols-outlined text-xs">check</span>}
        </button>
      )}

      {/* Thumbnail */}
      <div className="w-10 h-10 rounded-lg bg-slate-900 overflow-hidden flex-shrink-0 border border-white/5">
        {(item.thumbnailUrl ?? item.dataUrl) ? (
          <img src={item.thumbnailUrl ?? item.dataUrl} loading="lazy" decoding="async" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="material-symbols-outlined text-slate-700 text-sm">
              {item.type === 'recording' ? 'videocam' : 'image'}
            </span>
          </div>
        )}
      </div>

      {/* Name */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-white truncate" style={{ fontFamily: 'Manrope, sans-serif' }}>
          {item.name}
        </p>
      </div>

      {/* Type badge */}
      {item.type === 'recording' && (
        <span className="text-[8px] font-bold uppercase tracking-wider text-secondary bg-secondary/10 px-1.5 py-0.5 rounded-full flex-shrink-0">
          Video
        </span>
      )}

      {/* Missing file badge */}
      {missing && (
        <span className="text-[8px] font-bold uppercase tracking-wider text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded-full flex-shrink-0">
          Missing
        </span>
      )}

      {/* Upload status */}
      {isUploaded && (
        <span className="text-[8px] font-bold uppercase tracking-wider text-primary bg-primary/10 px-1.5 py-0.5 rounded-full flex-shrink-0">
          Synced
        </span>
      )}

      {/* Date */}
      <span className="text-[10px] text-slate-500 font-medium w-28 text-right flex-shrink-0">{date}</span>

      {/* Size */}
      <span className="text-[10px] text-slate-600 w-14 text-right flex-shrink-0">{size}</span>

      {/* Inline actions — unified for image + video. Missing rows only
          expose Delete so users prune orphans without chasing dead links. */}
      {!isSelecting && (
        <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {!missing && (
            <>
              <RowAction icon="edit" label="Edit" tint="blue" onClick={stop(onOpen)} />
              <RowAction icon="content_copy" label="Copy" tint="emerald" onClick={stop(onCopy)} />
              <RowAction icon={isSharing ? 'sync' : 'share'} label={isSharing ? 'Sharing…' : 'Share'} tint="sky" onClick={stop(onShare)} spinning={isSharing} />
              {gdriveReady && onShareGdrive && (
                <RowAction
                  icon={isSharingGdrive ? 'sync' : 'add_to_drive'}
                  label={isSharingGdrive ? 'Uploading…' : (hasDriveUpload ? 'Copy Drive link' : 'Upload to Drive & copy link')}
                  tint="amber"
                  onClick={stop(onShareGdrive)}
                  spinning={!!isSharingGdrive}
                />
              )}
            </>
          )}
          <RowAction icon="delete" label="Delete" tint="red" onClick={stop(onDelete)} />
        </div>
      )}
    </div>
  )
}

// Pre-enumerated so Tailwind's JIT picks up each class combination at build
// time — constructing class names via template strings gets purged.
const ROW_TINTS: Record<RowTint, string> = {
  blue:    'text-slate-600 hover:text-blue-400 hover:bg-blue-500/10',
  emerald: 'text-slate-600 hover:text-emerald-400 hover:bg-emerald-500/10',
  sky:     'text-slate-600 hover:text-sky-400 hover:bg-sky-500/10',
  amber:   'text-slate-600 hover:text-amber-400 hover:bg-amber-500/10',
  red:     'text-slate-600 hover:text-red-400 hover:bg-red-500/10',
}
type RowTint = 'blue' | 'emerald' | 'sky' | 'amber' | 'red'

function RowAction({ icon, label, onClick, spinning, tint }: { icon: string; label: string; onClick: (e: ReactMouseEvent) => void; spinning?: boolean; tint: RowTint }) {
  return (
    <button
      onClick={onClick}
      disabled={spinning}
      className={`p-1 rounded-md transition-all disabled:opacity-60 ${ROW_TINTS[tint]}`}
      title={label}
    >
      <span className={`material-symbols-outlined text-xs ${spinning ? 'animate-spin' : ''}`}>{icon}</span>
    </button>
  )
}
