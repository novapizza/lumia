// Dev builds get their own profile so `pnpm dev` never collides with the
// installed Lumia: same userData dir means the same single-instance lock, so
// the dev instance quit and the installed app came to the front instead.
// Imported first in index.ts: settings.ts, hotkeys.ts and stickers.ts read
// the userData path while they load, so it must be set before them.
// An explicit --user-data-dir still wins. The profile must stay under the
// home directory (lumia-media:// only serves files there).
import { app } from 'electron'
import { join } from 'path'

if (!app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', join(app.getPath('appData'), 'lumia-history-dev'))
}
