import type { ComponentType, CSSProperties, ReactNode, SVGProps } from 'react'
import { useId } from 'react'
import {
  Mountain, Swords, CornerDownLeft, Shapes, MoonStar, Box, Castle, Gamepad2, Car, Sailboat, CloudFog, Telescope, Bird, Church, Funnel,
  ListClock,
  SquarePadding,
  GripVertical,
  RotateCcwClock,
  VolumeX,
  ChevronLeft,
  Ellipsis,
  Pin,
  PinOff,
  LineSquiggle,
  AppWindow, ArrowDown, ArrowLeft, ArrowUp, ArrowUpRight, Bell, Blend, Bug, Building, Camera, Check,
  ChevronDown, ChevronRight, ChevronsDown, ChevronUp, Circle, CircleAlert, CircleArrowDown, CircleCheck, CircleCheckBig,
  CircleHelp, ClipboardPaste, Clock, Cloud, CloudDownload, CloudOff, CloudUpload, Code, Copy, Crop, Crosshair, Download,
  Droplets, Eraser, ExternalLink, Eye, EyeOff, Flower2, FolderOpen, Forward, Frown, Gauge, Globe,
  HardDriveUpload, Highlighter, History, Hourglass, Image, ImageOff, Inbox, Info, Key, Keyboard, Landmark,
  LayoutDashboard, LayoutGrid, Layers, Lightbulb, Link, List, ListChecks, LoaderCircle, Maximize, Maximize2, Menu,
  MessageSquare, Mic, MicOff, Minus, Monitor, MousePointer2, Move, Palette, Pause, PawPrint, Pencil, Pipette, ArrowLeftRight,
  PenLine, Play, Plus, Power, Puzzle, Redo2, RefreshCw, Rocket, RotateCcw, Save, Scaling, Scan,
  Scissors, Search, SearchX, Settings, Share2, SlidersHorizontal, Sparkle, Sparkles, Volume2, Square, SquareDashed, SquareFunction,
  SquarePen, Star, Sticker, Sun, SunMoon, ScrollText, Sunset, Tag, Trash2, TreePine, TrendingUp, Tv, Type, Undo2, User, Users, Video, Wrench,
  VideoOff, Wallpaper, WandSparkles, Waves, X, Zap, SquarePlay,
  FileXCorner, PlayOff,
} from 'lucide-react'

type SvgIcon = ComponentType<SVGProps<SVGSVGElement>>
const filled = (I: SvgIcon): SvgIcon => (props) => <I fill="currentColor" {...props} />

/** Custom icons on Lucide's grid (24 units, round caps / joins); line width
 *  comes from `.icon` in index.css like every other icon. */
const lucideSvg = (children: ReactNode): SvgIcon => (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>{children}</svg>
)

// Landscapes (Settings › Wallpapers, Jasper 2026-11-26): Lucide's
// MountainSnow with a TreePine at 0.62 in front of its lower left. The
// mountain is cut away behind the tree with a thick gap (a mask: the tree's
// silhouette at 1.0 around the same centre), see-through, so the gap is
// always the button's own fill: rest, hover or the purple selected one.
// The mask id is per instance (useId); fill only, since `.icon *` makes
// strokes non-scaling.
const TREE = 'm17 14 3 3.3a1 1 0 0 1-.7 1.7H4.7a1 1 0 0 1-.7-1.7L7 14h-.3a1 1 0 0 1-.7-1.7L9 9h-.2A1 1 0 0 1 8 7.3L12 3l4 4.3a1 1 0 0 1-.8 1.7H15l3 3.3a1 1 0 0 1-.7 1.7H17Z'
const MountainTree: SvgIcon = (props) => {
  const mask = useId()
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <rect width="24" height="24" fill="white" stroke="none" />
          <path d={TREE} transform="translate(-6.5 4.15) scale(1)" fill="black" stroke="none" />
        </mask>
      </defs>
      {/* The mountain 1 unit right: the tree already touches the left edge,
          so the mountain moves instead (the mask stays put, outside). */}
      <g mask={`url(#${mask})`}>
        <g transform="translate(1 0)">
          <path d="m8 3 4 8 5-5 5 15H2L8 3z" />
          <path d="M4.14 15.08c2.62-1.57 5.24-1.43 7.86.42 2.74 1.94 5.49 2 8.23.19" />
        </g>
      </g>
      <g transform="translate(-1.94 8.9) scale(0.62)">
        <path d={TREE} />
        <path d="M12 22v-3" />
      </g>
    </svg>
  )
}

// The filter's stack icons keep lucide-react 0.468's drawings (Jasper's
// pick, 2026-11-20, after the upgrade to 1.x redrew `Images`): a 16x16
// front frame at 6,2 with an L-shaped stack line 4 units behind it.
// ImagesStack is 0.468's `Images` copied as it was.
const ImagesStack = lucideSvg(<>
  <path d="M18 22H4a2 2 0 0 1-2-2V6" />
  <path d="m22 13-1.296-1.296a2.41 2.41 0 0 0-3.408 0L11 18" />
  <circle cx="12" cy="8" r="2" />
  <rect x="6" y="2" width="16" height="16" rx="2" />
</>)

// "Many videos", its video counterpart: the same frame and stack line, with
// 0.468's SquarePlay triangle moved to the frame's centre (14,10).
const VideoStack = lucideSvg(<>
  <path d="M18 22H4a2 2 0 0 1-2-2V6" />
  <rect x="6" y="2" width="16" height="16" rx="2" />
  <path d="m11 6 6 4-6 4Z" />
</>)

// Lucide's `radio` (1.x arcs) with the waves squeezed sideways to 90% (the dot stays
// round): the original's 20 x 14.2 outline read too wide at 14px.
const RadioNarrow = lucideSvg(<>
  <g transform="translate(12 12) scale(0.9 1) translate(-12 -12)">
    <path d="M4.925 19.067a10 10 0 0 1 0-14.134" />
    <path d="M7.753 16.239a6 6 0 0 1 0-8.478" />
    <path d="M16.247 7.761a6 6 0 0 1 0 8.478" />
    <path d="M19.075 4.933a10 10 0 0 1 0 14.134" />
  </g>
  <circle cx="12" cy="12" r="2" />
</>)

// Lucide's moon slimmed a little (Jasper's pick, 2026-11-21: filled in the
// accent, Lucide's read too thick). Same 9-unit disc at (12,12); the cut-out
// circle is bigger and closer (r 6.77 at 16.13,7.88 instead of r 6.36 at
// 16.5,7.5), so the crescent's widest part is ≈ 8.1 units instead of 9.
// Picked from steps towards r 8 at 15,9 (≈ 5.2). Lucide's own Moon tried
// against it again on 2026-11-22 (with the grey outline): slim kept.
const MoonSlim = lucideSvg(<path d="M20.98 12.597A9 9 0 1 1 11.403 3.02A6.773 6.773 0 1 0 20.98 12.597Z" />)


// The list view's capture kind icons (window / region / screen) are all
// 20 wide and 18 tall overall, at (2,3) to (22,21): Lucide's Monitor
// already is (screen 20x14 + stand); the other two are redrawn to match
// (2026-11-21).
// WindowMacTall: Lucide's AppWindowMac with its frame 20x18 (was 20x16 at
// (2,4)); the three dots stay 4 units below the top edge.
const WindowMacTall = lucideSvg(<>
  <rect width="20" height="18" x="2" y="3" rx="2" />
  <path d="M6 7h.01" />
  <path d="M10 7h.01" />
  <path d="M14 7h.01" />
</>)

// RectDashed: Lucide's SquareDashed widened to 20x18 (the square's own
// height). Same rounded corners (r 2) and 1-unit dashes: the sides keep the
// square's, the longer top and bottom spread theirs evenly.
const RectDashed = lucideSvg(<>
  <path d="M4 3a2 2 0 0 0-2 2" />
  <path d="M20 3a2 2 0 0 1 2 2" />
  <path d="M22 19a2 2 0 0 1-2 2" />
  <path d="M4 21a2 2 0 0 1-2-2" />
  <path d="M8.5 3h1" />
  <path d="M14.5 3h1" />
  <path d="M8.5 21h1" />
  <path d="M14.5 21h1" />
  <path d="M2 9v1" />
  <path d="M2 14v1" />
  <path d="M22 9v1" />
  <path d="M22 14v1" />
</>)

/** Icon names (the old Material Symbols names, kept so data like
 *  `icon: 'crop'` didn't need rewriting) → Lucide. */
const ICONS: Record<string, SvgIcon> = {
  // History panel tabs and the Layers tab (2026-11-23).
  layers: Layers, edit_history: RotateCcwClock, list_clock: ListClock, drag_indicator: GripVertical,
  visibility: Eye, visibility_off: EyeOff,
  // actions
  add: Plus, remove: Minus, close: X, check: Check, done: Check,
  delete: Trash2, delete_sweep: Trash2, cleaning_services: Eraser,
  edit: SquarePen, mode: Pencil, pencil: Pencil, colorize: Pipette, swap_horiz: ArrowLeftRight, draw: PenLine, save: Save,
  download: Download, downloading: Download, system_update: CircleArrowDown,
  content_copy: Copy, content_paste: ClipboardPaste, cut: Scissors,
  share: Share2, link: Link, open_in_new: ExternalLink, launch: ExternalLink,
  undo: Undo2, redo: Redo2, refresh: RefreshCw, sync: RefreshCw, restart_alt: RotateCcw,
  progress_activity: LoaderCircle, search: Search, image_search: Search,
  search_off: SearchX, preview: Eye, hide: EyeOff, hide_image: ImageOff,
  checklist: ListChecks, select: MousePointer2, power_settings_new: Power, bug_report: Bug, build: Wrench, sparkle: Sparkle, trending_up: TrendingUp, speed: Gauge,
  // navigation + arrows
  arrow_back: ArrowLeft, arrow_forward: ArrowUpRight, arrow_upward: ArrowUp, arrow_downward: ArrowDown,
  pin: Pin, pin_off: PinOff, more_horiz: Ellipsis, chevron_left: ChevronLeft, chevron_right: ChevronRight, open_with: Move, line_weight: LineSquiggle, expand_more: ChevronDown, expand_less: ChevronUp, forward: Forward,
  start: Play, menu: Menu, space_dashboard: LayoutDashboard, view_module: LayoutGrid, list: List,
  settings: Settings, tune: SlidersHorizontal, swipe_down: ChevronsDown,
  fullscreen: Maximize, open_in_full: Maximize2, crop_free: Maximize, move: Move, resize: Scaling,
  // capture + media
  photo_camera: Camera, add_a_photo: Camera, screenshot: Scan, capture: Scan,
  screenshot_region: Crop, target: Crosshair, crop: Crop, crop_square: Square,
  videocam: Video, videocam_off: VideoOff,
  fiber_manual_record: filled(Circle),
  mic: Mic, mic_off: MicOff, volume_up: Volume2, volume_off: VolumeX, play_arrow: Play, play_off: PlayOff, play_filled: filled(Play), pause: Pause, stop: Square,
  image: Image, broken_image: ImageOff, file_x_corner: FileXCorner, collections: ImagesStack, video_library: VideoStack, smart_display: SquarePlay,
  monitor: Monitor, tv_displays: Tv, window: AppWindow, web_asset: AppWindow,
  window_mac: WindowMacTall, region: RectDashed, scroll_page: ScrollText,
  wallpaper: Wallpaper, portrait: User,
  // annotation tools
  arrow_selector_tool: MousePointer2, circle: Circle, title: Type,
  highlight: Highlighter, blur_on: Droplets, add_reaction: Sticker, sticker: Sticker,
  palette: Palette, gradient: Blend, padding: SquareDashed, shadow: Layers,
  // The image editor's Background button (2026-11-26; Blend before, which
  // read as a blend mode): the image inside its padded background.
  background: SquarePadding,
  auto_fix_high: WandSparkles, auto_awesome: Sparkles,
  // status
  check_circle: CircleCheck, task_alt: CircleCheckBig, error: CircleAlert,
  warning: CircleAlert, info: Info, help: CircleHelp,
  history: History, schedule: Clock, hourglass_empty: Hourglass, hourglass_top: Hourglass,
  notifications: Bell, sentiment_dissatisfied: Frown, star: filled(Star), star_outline: Star,
  // cloud + files
  cloud_upload: CloudUpload, add_to_drive: HardDriveUpload, cloud_download: CloudDownload,
  cloud_done: Cloud, radio: RadioNarrow, cloud_off: CloudOff, folder_open: FolderOpen, inbox: Inbox,
  extension: Puzzle, code: Code, function: SquareFunction,
  http: Globe, public: Globe, key: Key, keyboard: Keyboard, tag: Tag, bolt: Zap,
  message: MessageSquare, group: Users, step: ChevronRight, stream: Layers,
  // theme
  dark_mode: MoonSlim, light_mode: Sun, contrast: SunMoon, light: Lightbulb,
  // wallpaper categories (rocket_launch is also the workflow picker's)
  architecture: Landmark, location_city: Building,
  pets: PawPrint, water: Waves,
  forest: TreePine, wb_twilight: Sunset, local_florist: Flower2,
  rocket_launch: Rocket, mountain: Mountain, waterfall: Droplets,
  sailboat: Sailboat, foggy: CloudFog, telescope: Telescope, bird: Bird,
  church: Church, swords: Swords, landscape: MountainTree,
  // the search field's press-to-search hint (Settings › Wallpapers)
  keyboard_return: CornerDownLeft,
  shapes: Shapes, moon_star: MoonStar, square: Square, cube: Box, castle: Castle,
  rocket: Rocket, gamepad: Gamepad2, car: Car,
  // Settings › Wallpapers' categories toggle (2026-11-25)
  filter_alt: Funnel,
}

interface IconProps {
  name: string
  className?: string
  style?: CSSProperties
  title?: string
}

/** A Lucide icon sized by font-size (1em), so `text-[20px]` on the icon or
 *  its parent sets its size and `text-*` colors it. Sizes: 14, 16, 20, 24.
 *  Lines are the same pixel width at every size (`.icon` in index.css).
 *  Licence: resources/licenses/Lucide-ISC.txt. */
export function Icon({ name, className = '', style, title }: IconProps) {
  const Svg = ICONS[name]
  if (!Svg) {
    if (import.meta.env.DEV) console.warn(`[Icon] no icon mapped for "${name}"`)
    return null
  }
  return (
    <Svg
      className={`icon inline-block w-[1em] h-[1em] shrink-0 align-middle ${className}`}
      style={style}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
    />
  )
}
