/** Release notes for Settings › Release notes, newest first.
 *
 *  Add an entry with every release, from the release commit's body (the
 *  changelog the GitHub release page is built from, see CLAUDE.md ›
 *  Releases), written for users. No em dashes. Format (2026-11-22):
 *  - `kind`: 'improve' for something that was there and got better,
 *    'fix' for bug fixes, 'internal' for maintenance with no visible
 *    change; leave it out for new features. Shown as an icon.
 *  - Order (Jasper, 2026-11-27): within a release, new features first,
 *    then 'improve', then 'fix', then 'internal'. Settings shows the notes
 *    in the order they're written here; it doesn't sort them. Internal notes name the change too ("Upgraded to Electron
 *    42"), never a catch-all like "Under the hood" (too vague).
 *  - `title`: a short call-out led by an action word, shown bold, like
 *    Settings' row titles: "Trim videos in the editor", "Step frame by
 *    frame", "Fixed", "Upgraded to Electron 42". It names what changed in this
 *    release, never just the area ("Video trim" says nothing).
 *  - `text`: one short sentence after it, only when it says more than the
 *    title (not "Smaller recordings: Video files are smaller."); else
 *    leave it out.
 *  - `points`: sub-bullets when there's more to say than one sentence;
 *    one change each, never two in one line ("easier to read in the
 *    editor, Share dialog and Wallpapers" is three points).
 *  Written 2026-11-22 for 2.0.0 to 2.6.5 from the GitHub PRs and issues,
 *  the commits between the release tags and the release commit bodies. */
export interface ReleaseNote {
  /** Its icon: a new feature (default, sparkle), an improvement to
   *  something that was there (wand), a bug fix (bug), or
   *  maintenance with no visible change (wrench). */
  kind?: 'improve' | 'fix' | 'internal'
  title: string
  text?: string
  points?: string[]
}

export interface Release {
  version: string
  date: string // YYYY-MM-DD
  notes: ReleaseNote[]
}

export const RELEASES: Release[] = [
  {
    version: '3.0.0',
    date: '2026-11-28',
    notes: [
      {
        title: 'Meet the new Lumia',
        points: [
          'A new look in light and dark',
          'A new logo and app icon',
          'A top bar on every screen in place of the sidebar',
          'Messages show inside the app while it is open',
        ],
      },
      {
        title: 'Make the theme your own',
        text: 'Pick an accent and a light and dark base in Settings › Appearance.',
      },
      {
        title: 'Choose where files are saved',
        points: [
          'Pick any folder in Settings › General › Save to',
          'Each folder keeps its own history',
          'Move your files over when you switch',
        ],
      },
      {
        title: 'Do more in the image editor',
        points: [
          'Highlighter',
          'Layers: reorder, hide and select shapes',
          'Edits: jump back to any step',
          'Background: put your image on a gradient or colour',
          'Stickers in a sidebar with search',
          'A colour picker with an eyedropper',
          'Change every editor key in Settings › Hotkeys',
        ],
      },
      {
        title: 'Capture scrolling pages again',
        text: 'Press Ctrl+Shift+5 or pick Scroll in the capture overlay; in a browser it goes through the extension.',
      },
      {
        title: 'Change your desktop wallpaper',
        text: 'Photos from Wikimedia Commons or Wallhaven, on all screens or the ones you pick, in Settings › Wallpapers.',
      },
      {
        kind: 'improve',
        title: 'Find files faster in the Dashboard',
        points: [
          'The Images or Videos filter is remembered',
          'See which app each file came from',
          'Drag to select, Shift-click a range',
          'Cmd+A is back and selects all of history',
          'Cmd+click to show a file in Finder or Explorer',
          'Come back to where you were after the editor or Settings',
          'Changes made in Finder or Explorer show up right away',
        ],
      },
      {
        kind: 'improve',
        title: 'Trim videos with a new trim bar',
        points: [
          'The filmstrip shows at once',
          'The playhead follows your pointer',
          'Arrow keys step one frame at the rate the video was recorded at',
        ],
      },
      {
        kind: 'improve',
        title: 'Capture and record with a cleaner overlay',
        points: [
          'One bar for Image or Video and every mode',
          'In your theme, lined up with the menu bar',
          'Every tool is remembered for New capture and PrintScreen',
          'Count down 3 or 5 seconds, or not at all; Esc cancels',
          'Draw while recording like in the image editor, with Text and Redo',
        ],
      },
      {
        kind: 'improve',
        title: 'Update when you choose',
        text: 'Update downloads, Restart installs; turn on Auto-update Lumia to do it in the background.',
      },
      {
        kind: 'improve',
        title: 'Get a smaller watermark',
        text: 'The same small size on every image and video.',
      },
      {
        kind: 'improve',
        title: 'Use the browser extension 1.6.0',
        points: [
          'Follows the theme you picked in Lumia',
          'A redesigned picker for part of a page',
        ],
      },
      {
        kind: 'fix',
        title: 'Fixed',
        points: [
          'The capture cursor no longer turns into an arrow on two displays',
          'A crosshair no longer shows over other apps after opening Lumia',
          'A failed capture or recording says why and brings the window back',
          'Cancelled recordings no longer leave a part-written file',
        ],
      },
    ],
  },
  {
    version: '2.6.6',
    date: '2026-11-19',
    notes: [
      {
        kind: 'improve',
        title: 'Keep every file in your history',
        text: 'No more limit of 1,000; history is now saved one file per day, and yours moves over on first start.',
      },
      {
        kind: 'improve',
        title: 'Open the Dashboard faster',
        points: [
          'Days load as you scroll to them',
          'Uses less memory with a long history',
          'New captures show up right away',
        ],
      },
      {
        kind: 'improve',
        title: 'Keep your history safe',
        text: 'A crash or a locked file no longer risks losing or damaging it.',
      },
    ],
  },
  {
    version: '2.6.5',
    date: '2026-11-18',
    notes: [
      {
        kind: 'improve',
        title: 'Save smaller recordings',
        points: [
          'A 2-minute recording: about 250 MB before, under 70 MB now',
          'Saves and uploads faster',
          'Recorded at 30 fps',
          'On-screen text stays sharp',
        ],
      },
    ],
  },
  {
    version: '2.6.4',
    date: '2026-11-18',
    notes: [
      {
        kind: 'improve',
        title: 'Capture faster on Windows',
        text: 'The capture overlay appears sooner after the hotkey, especially with the Lumia window open.',
      },
      {
        kind: 'improve',
        title: 'Trim with a cleaner bar',
        points: [
          'The handles frame the filmstrip',
          'Start, playhead, end and clip length show below the bar',
          'Shortcuts show as keys below the bar',
          "The player's own timeline hides while you trim",
        ],
      },
      {
        kind: 'improve',
        title: 'Set trim points faster',
        points: [
          'Click outside the selection to move the nearest handle there',
          'Right-click for Start here / End here',
          'The playhead stays inside the selection',
          'Handles no longer jump to the cursor when you grab them',
          'Start and end shortcuts are now D and F (were I and O)',
        ],
      },
      {
        kind: 'fix',
        title: 'Fixed',
        text: 'A trim handle no longer gets stuck when you release the mouse outside the window.',
      },
    ],
  },
  {
    version: '2.6.3',
    date: '2026-11-17',
    notes: [
      { title: 'See frames while trimming', text: 'A filmstrip on the trim timeline shows where to cut.' },
      {
        title: 'Step frame by frame',
        points: [
          'Left / Right steps one frame, Shift jumps 10',
          'The playhead time shows next to the selection',
        ],
      },
      { title: 'Copy trims to the clipboard', text: 'Applying a trim copies the clip right away.' },
      { kind: 'internal', title: 'Slimmed the video tool', text: 'The bundled FFmpeg is smaller.' },
      { kind: 'internal', title: 'Added the FFmpeg license', text: 'Its notice ships with the app.' },
    ],
  },
  {
    version: '2.6.2',
    date: '2026-11-16',
    notes: [
      { kind: 'internal', title: 'Fixed the macOS build', text: 'The app builds again on the latest macOS.' },
      { kind: 'internal', title: 'Updated the auto-updater', text: 'Now on the latest 6.x.' },
    ],
  },
  {
    version: '2.6.1',
    date: '2026-11-16',
    notes: [
      {
        title: 'Trim videos in the editor',
        points: [
          'Trim recordings right in the editor',
          'Drag the handles to set start and end',
          'I and O set the start and end',
          'Space plays',
          'The cut is lossless and fast',
          'The original recording stays untouched',
          'Share, Save As and Copy use the trimmed clip',
        ],
      },
      { kind: 'fix', title: 'Copy with annotations', text: 'Cmd/Ctrl+C copies the image with your drawings and text.' },
      {
        kind: 'fix',
        title: 'Capture across monitors',
        points: [
          'Captures no longer grab the wrong area when a selection ends near another display',
          'macOS: the recording border and toolbar line up on external displays',
        ],
      },
      { kind: 'internal', title: 'Moved to Vite 8', text: 'The build tooling behind the app.' },
    ],
  },
  {
    version: '2.6.0',
    date: '2026-09-01',
    notes: [
      {
        title: 'Type on the image',
        points: [
          'Type right on the image: Enter commits, Shift+Enter adds a line',
          'Click a text with the Text tool to edit it',
          'Double-click a text with the cursor tool to edit it',
          'Clear a text to delete it',
          'Placing a second text no longer loses the first',
        ],
      },
      { title: 'Keep your last style', text: 'The toolbar keeps your last color and stroke for the next capture.' },
      {
        kind: 'improve',
        title: 'Edit shapes from any tool',
        text: 'Shapes stay editable whichever tool is active.',
        points: [
          'Click a shape to select it',
          'Drag a shape to move it',
          'Selecting a shape switches the toolbar to its tool, color and stroke',
          'Toolbar changes restyle the selected shape',
        ],
      },
      { kind: 'improve', title: 'Confirm captures faster', text: 'Especially on 4K displays.' },
      {
        kind: 'improve',
        title: 'Use less memory',
        points: [
          'Capture overlays use less memory',
          'Overlays let go of the last screenshot between captures',
          'History file: about 2.5 MB before, 65 KB now',
          'Existing history moves over on first launch',
        ],
      },
      { kind: 'internal', title: 'Log memory use', text: 'Each launch writes a memory breakdown to the log, for performance reports.' },
    ],
  },
  {
    version: '2.5.0',
    date: '2026-08-12',
    notes: [
      { title: 'Include Lumia in captures', text: "A new option keeps Lumia's own windows in the shot." },
      {
        kind: 'improve',
        title: 'Match screen colors',
        text: "On displays with a custom color profile, captures now match what's on screen.",
        points: [
          'No more purple tint on panels with vendor profiles',
          'The editor, clipboard, saved files and uploads all match',
          'Works in every capture mode, scrolling capture included',
        ],
      },
      {
        kind: 'improve',
        title: 'Pan and zoom further',
        points: ['Drag with the cursor tool to pan', 'Zoom goes past 500%, small captures much further'],
      },
      {
        kind: 'improve',
        title: 'Read easier in light mode',
        points: ['Easier to read in the editor', 'Easier to read in the Share dialog', 'Easier to read in Wallpapers'],
      },
      { kind: 'improve', title: 'Capture in place', text: 'Browser extension 1.5.0: Visible area no longer jumps to the top.' },
    ],
  },
  {
    version: '2.4.3',
    date: '2026-08-05',
    notes: [
      {
        title: 'Spot outdated extensions',
        text: "The Dashboard tells you when your browser's extension is older than the one that comes with Lumia.",
      },
      {
        kind: 'improve',
        title: 'Capture cleaner full pages',
        points: [
          "Sticky bars, chat bubbles and Back to top buttons don't repeat down the page",
          'Side rails run the full length of the page',
          'Menus with their own scroll show all their items',
          'Bars pinned to the bottom appear once, at the end of the page',
          'Lumia picks the main content pane instead of a side panel',
          'Pages that keep their content in a frame, like cloud consoles, capture the right pane',
          'No more streaks in the side margins of pane captures',
        ],
      },
    ],
  },
  {
    version: '2.4.2',
    date: '2026-07-30',
    notes: [
      {
        title: 'Install from Chrome Web Store',
        points: [
          "Scroll capture setup opens the extension's Chrome Web Store page",
          'Copy link to install it in another browser',
        ],
      },
    ],
  },
  {
    version: '2.4.1',
    date: '2026-07-30',
    notes: [
      {
        kind: 'fix',
        title: 'Fixed',
        text: 'On Windows, full-screen captures across monitors with different scaling no longer show shifted screens or black bands.',
      },
    ],
  },
  {
    version: '2.4.0',
    date: '2026-07-29',
    notes: [
      {
        title: 'Choose Scroll as a capture',
        points: [
          'Scroll is its own capture type next to Image and Video',
          'Choose the browser extension or screen scroll, which works in any app',
          'Start it from the Dashboard or the extension',
          'The scrolling capture hotkey is gone',
          'Install steps for the extension are on the Dashboard',
        ],
      },
      {
        title: 'Capture pages with the extension',
        text: 'Captures web pages from their exact scroll position, so nothing is guessed.',
        points: [
          'Visible area captures what you see',
          'Full page scrolls and stitches the whole page',
          'Select area captures one element or pane, scrolling it if needed',
          'Arrow keys move the selection to the parent, child or sibling element',
          'Select area works inside same-origin frames',
          "Sticky headers don't repeat down the page",
          'Colors match the screen on wide-gamut displays',
          'With several browsers connected, pick one from live tab previews',
          'Asks for fewer permissions',
          'One click in its popup allows captures started from Lumia',
        ],
      },
      { kind: 'fix', title: 'Fixed', text: 'After a browser capture, Lumia comes to the front ready for typing.' },
    ],
  },
  {
    version: '2.3.0',
    date: '2026-07-25',
    notes: [
      {
        kind: 'improve',
        title: 'Capture faster on macOS',
        points: [
          'The screen freezes the moment you press the hotkey',
          'The capture overlay shows in about 0.3 to 0.4 s, down from 2 to 3 s',
          'Full-screen and monitor captures are faster too',
          'Needs macOS 14 or later; older versions work as before',
        ],
      },
      {
        kind: 'improve',
        title: 'Capture windows cleanly',
        points: [
          'Rounded corners are transparent, like the real window',
          'On Windows, captures no longer trim 2 px off each edge',
        ],
      },
      {
        kind: 'improve',
        title: 'Pick windows faster',
        points: [
          'With only one window open, it is captured right away',
          'Enter picks the active window',
          'Both work for screenshots and recordings',
        ],
      },
      {
        kind: 'fix',
        title: 'Fixed',
        points: [
          'Sharp menu bar icon on Retina Macs',
          'Double-clicking New Capture no longer starts two captures',
          'New Capture repeats your last Region or Window pick, never a full-screen or scrolling capture',
        ],
      },
      { kind: 'internal', title: 'Upgraded to Electron 42' },
      { kind: 'internal', title: 'Upgraded to React 19' },
    ],
  },
  {
    version: '2.2.2',
    date: '2026-06-19',
    notes: [
      {
        kind: 'improve',
        title: 'Download less on macOS',
        text: 'About 10 to 20 MB less per download.',
        points: [
          'The Apple Silicon build gets the slim video tool too',
          'Unused language files are left out',
        ],
      },
    ],
  },
  {
    version: '2.2.1',
    date: '2026-06-19',
    notes: [
      {
        kind: 'improve',
        title: 'Download a smaller app',
        points: [
          'Windows installer: about 300 MB before, about 78 MB now',
          'macOS: the Intel build is slimmer too',
          'Quicker to download, install and update',
        ],
      },
    ],
  },
  {
    version: '2.2.0',
    date: '2026-06-19',
    notes: [
      { kind: 'improve', title: 'Removed auto-blur', text: 'The blur tool in the editor stays.' },
      { kind: 'improve', title: 'Slimmed the app', text: 'Unused files are left out of the download.' },
    ],
  },
  {
    version: '2.1.4',
    date: '2026-06-18',
    notes: [
      {
        kind: 'improve',
        title: 'Place stickers better',
        points: [
          'Drag the category tabs to scroll them',
          'Stickers start smaller',
          'Stickers always fit inside the image',
          'New stickers show up without restarting',
        ],
      },
      { kind: 'fix', title: 'Fixed', text: 'The mode tabs in the capture overlay work in region and window mode.' },
    ],
  },
  {
    version: '2.1.3',
    date: '2026-06-17',
    notes: [
      {
        title: 'Add stickers',
        points: [
          'New sticker tool in the editor',
          'Open it from the toolbar or press S',
          'Search, browse by category or pick from Recent',
          'Move and resize a sticker like any other shape',
          'Stickers you used before work offline',
          'New stickers arrive without an app update',
        ],
      },
    ],
  },
  {
    version: '2.1.2',
    date: '2026-06-15',
    notes: [
      { kind: 'improve', title: 'Capture fast from the start', text: 'The first capture after launch or a long idle is as quick as the rest.' },
      { kind: 'improve', title: "Removed the What's New pop-up", text: 'It no longer opens after updates.' },
    ],
  },
  {
    version: '2.1.1',
    date: '2026-06-12',
    notes: [
      {
        kind: 'improve',
        title: 'Upload faster',
        text: 'Recordings upload to Cloudflare R2 over several connections at once.',
      },
      {
        kind: 'improve',
        title: 'Upload with less memory',
        text: 'Uploads read straight from disk: a 150 MB recording no longer takes over 1 GB of memory.',
      },
    ],
  },
  {
    version: '2.1.0',
    date: '2026-06-12',
    notes: [
      {
        kind: 'improve',
        title: 'Keep color and quality',
        points: [
          "Screenshots carry your display's color profile",
          'Save As copies the original file, with no quality loss',
          'Edited screenshots save as smaller files',
        ],
      },
      { kind: 'improve', title: 'Freeze faster on Windows', text: 'The screen snapshot at the hotkey is much quicker.' },
      { kind: 'improve', title: 'Run auto-blur offline', text: 'No network needed.' },
      { kind: 'fix', title: 'Scrub recordings', text: 'Seeking works in Lumia, VLC and browsers.' },
      {
        kind: 'fix',
        title: 'Record reliably',
        points: [
          'Long recordings save without failing or filling up memory',
          'Recovers cleanly when screen recording permission is denied',
          'Recovers from a recorder crash instead of getting stuck',
          'Pause and resume work correctly',
          'Microphone availability shows correctly',
          'Stop during the countdown cancels the recording',
        ],
      },
      {
        kind: 'fix',
        title: 'Capture reliably',
        points: [
          'Scrolling capture no longer saves debug images to the Desktop',
          'No more swapped red and blue on the frozen screen when switching modes',
          'Dragging a region across a monitor edge no longer gets stuck',
          'More accurate captures across several monitors',
          'Scrolling capture lines up on scaled displays',
        ],
      },
      {
        kind: 'fix',
        title: 'Edit reliably',
        points: [
          'Undo works on the first press',
          'Moving and resizing annotations is saved',
          'Exported images no longer include the selection outline',
        ],
      },
      {
        kind: 'fix',
        title: 'Run more reliably',
        points: [
          'Custom capture hotkeys survive updates',
          'History cleanup never deletes your original screenshots',
          'Updates wait until you finish a recording or capture',
          'Google Drive sign-in is handled more securely',
          'On Windows, clicking a notification opens the right capture',
          'Many smaller fixes',
        ],
      },
    ],
  },
  {
    version: '2.0.3',
    date: '2026-05-19',
    notes: [
      {
        kind: 'improve',
        title: 'Open the overlay faster',
        points: [
          'On 4K displays: about 1 to 2 s before, under 0.15 s now',
          'The first capture after launch is as quick as the rest',
        ],
      },
    ],
  },
  {
    version: '2.0.2',
    date: '2026-05-15',
    notes: [
      {
        title: 'Freeze the screen',
        text: 'Lumia snapshots the screen the moment you press the hotkey, so tooltips and menus stay in the capture.',
      },
      {
        kind: 'fix',
        title: 'Fixed',
        points: [
          'On Windows, Launch at startup keeps working after the first boot',
          'Captures taken while Lumia sat in the tray show up as soon as you open it',
        ],
      },
    ],
  },
  {
    version: '2.0.1',
    date: '2026-05-12',
    notes: [{ kind: 'fix', title: 'Fixed', text: 'Picking a Google Drive folder works in the released app.' }],
  },
  {
    version: '2.0.0',
    date: '2026-05-07',
    notes: [
      {
        kind: 'internal',
        title: "Update from Lumia's server",
        points: [
          "Updates now come from Lumia's own server instead of GitHub",
          'On 1.2.13 or older, update to 1.2.14 first',
          'No other changes since 1.2.14',
        ],
      },
    ],
  },
]
