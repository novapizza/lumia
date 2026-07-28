// electron-builder config — JS form so we can pull dynamic values from
// process.env. Required because:
//   - `${env.X}` template expansion in YAML is per-field, and `publish.*`
//     fields aren't in electron-builder's expansion whitelist (verified
//     empirically: literal `${env.X}` ends up baked into app-update.yml).
//   - `--config.publish.0.url=...` CLI override fails schema validation:
//     the parser turns `publish` into an object with numeric keys instead
//     of an array.
// Same reason `azureSignOptions` is set via --config in the CI workflow.

// ── Publish — Cloudflare R2 ─────────────────────────────────────────────────
// `s3` is upload-only here (R2 endpoint requires auth); `generic` is the
// read path the client uses against the public R2 URL. `generic` stays
// first so it's the provider baked into the `app-update.yml` shipped in
// the app — that's what autoUpdater polls.
//
// Env vars resolved at build time (CI workflow):
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  → S3 publisher auth (read by SDK)
//   R2_RELEASES_ACCOUNT_ID                     → S3 endpoint host
//   R2_RELEASES_BUCKET                         → S3 bucket name
//   R2_RELEASES_PUBLIC_URL                     → full URL autoUpdater hits
//                                                 (scheme + host, no trailing /)
const publish = [
  {
    provider: 'generic',
    url: process.env.R2_RELEASES_PUBLIC_URL || ''
  },
  {
    provider: 's3',
    endpoint: `https://${process.env.R2_RELEASES_ACCOUNT_ID || ''}.r2.cloudflarestorage.com`,
    bucket: process.env.R2_RELEASES_BUCKET || '',
    region: 'auto',
    // R2 doesn't support ACLs; sending one trips a SignatureDoesNotMatch error.
    acl: null
  }
]

module.exports = {
  appId: 'com.lumia.app',
  productName: 'Lumia',
  publish,

  files: [
    'out/**/*',
    // ffmpeg-static ships an ~80 MB host-arch binary used only in dev. Packaged
    // builds get the correct per-arch ffmpeg placed in Resources by the
    // afterPack hook (build/embed-ffmpeg.cjs), so drop the bundled one.
    '!**/ffmpeg-static/ffmpeg',
    '!**/ffmpeg-static/ffmpeg.exe',
    // koffi prebuilds a koffi.node for 18 platforms (~26 MB total). We only ever
    // package Windows x64 and macOS x64/arm64, so the other ~15 are dead weight
    // shipped in (and asarUnpacked from) every installer. Keep only the three
    // we load at runtime; drop the rest (~18 MB).
    '!**/koffi/build/koffi/{freebsd_arm64,freebsd_ia32,freebsd_x64,linux_arm64,linux_armhf,linux_ia32,linux_loong64,linux_riscv64d,linux_x64,musl_arm64,musl_x64,openbsd_ia32,openbsd_x64,win32_arm64,win32_ia32}/**',
  ],

  extraResources: [
    {
      from: 'resources/tray',
      to: 'tray',
      filter: ['**/*.png', '**/*.ico']
    },
    { from: 'resources/icons/png/icon.png', to: 'icons/png/icon.png' },
    { from: 'resources/icon.png', to: 'icon.png' },
    { from: 'resources/picker.html', to: 'picker.html' },
    // Companion browser extension for the Scroll capture "Browser Extension"
    // method — users load it unpacked from Resources/extension (the
    // scroll-extension:open-folder IPC opens this directory for them).
    { from: 'extension', to: 'extension' },
    // macOS Swift helpers — looked up at runtime via process.resourcesPath.
    // CI compiles them as universal (arm64 + x86_64) before packaging via
    // build/compile-mac-helpers.sh. The same script is what local devs run.
    { from: 'electron/helpers/window-at-point', to: 'window-at-point' },
    { from: 'electron/helpers/scroll-helper', to: 'scroll-helper' },
    { from: 'electron/helpers/get-display-icc', to: 'get-display-icc' },
    { from: 'electron/helpers/screen-snap', to: 'screen-snap' }
  ],

  directories: {
    buildResources: 'resources',
    output: 'release'
  },

  // koffi: native FFI .node binaries must live outside the asar to load.
  // (ffmpeg is shipped as a per-arch binary in Resources by the afterPack hook,
  // not from node_modules, so it doesn't need asarUnpack.)
  asarUnpack: ['node_modules/koffi/**'],

  // ── Windows ────────────────────────────────────────────────────────────────
  // Code signing in CI uses Azure Trusted Signing — auth (tenant/client/
  // secret) flows through env vars consumed by the Azure CLI during signing,
  // while the four `azureSignOptions.*` fields are injected here from
  // process.env. Skipped automatically when any of the four are absent
  // (local builds, forks without secrets) — package.json's
  // CSC_IDENTITY_AUTO_DISCOVERY=false then short-circuits to no signing.
  win: {
    icon: 'resources/icons/win/icon.ico',
    // x64-only. Listing x64 + arm64 in one nsis target produced a single
    // installer carrying BOTH arch payloads (~2× size, ~300 MB). Windows-on-ARM
    // runs the x64 build via built-in emulation — embed-ffmpeg.cjs already ships
    // the x64 ffmpeg for arm64 on this assumption — so a dedicated arm64 build
    // bought little. Dropping it ~halves the installer.
    target: [{ target: 'nsis', arch: ['x64'] }],
    ...(['AZURE_PUBLISHER_NAME',
         'AZURE_TRUSTED_SIGNING_ENDPOINT',
         'AZURE_CODE_SIGNING_ACCOUNT_NAME',
         'AZURE_CERT_PROFILE_NAME'].every(k => process.env[k])
      ? {
          azureSignOptions: {
            publisherName: process.env.AZURE_PUBLISHER_NAME,
            endpoint: process.env.AZURE_TRUSTED_SIGNING_ENDPOINT,
            codeSigningAccountName: process.env.AZURE_CODE_SIGNING_ACCOUNT_NAME,
            certificateProfileName: process.env.AZURE_CERT_PROFILE_NAME
          }
        }
      : {})
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    // Default NSIS template is `${productName} Setup ${version}.${ext}` with
    // spaces. GitHub Releases auto-sanitizes spaces to hyphens in asset
    // names, but the S3 publisher uploads the file verbatim — so co-publish
    // ends up with `Lumia Setup X.exe` on R2, `Lumia-Setup-X.exe` on GitHub,
    // and a single `latest.yml` carrying the hyphenated URL. autoUpdater
    // polling R2 then 404s on the hyphenated URL. Force hyphens in the
    // local artifact name so all three line up.
    artifactName: '${productName}-Setup-${version}.${ext}'
  },

  // ── macOS ──────────────────────────────────────────────────────────────────
  // Code-signing — Developer ID Application certificate
  //   Local build (build:mac): CSC_IDENTITY_AUTO_DISCOVERY=false skips
  //     Keychain lookup → unsigned .app. notarize.cjs exits cleanly.
  //   CI: secrets CSC_LINK (base64 .p12) + CSC_KEY_PASSWORD trigger signing.
  // afterSign runs after code-signing; build/notarize.cjs skips gracefully
  // when APPLE_* vars are absent.
  afterSign: 'build/notarize.cjs',

  // Runs once per packed arch, before code-signing (so embedded binaries get
  // signed on macOS). Composes embed-ffmpeg (per-arch ffmpeg → Resources) and
  // prune-locales (strip unused Chromium locale paks on Windows).
  afterPack: 'build/after-pack.cjs',

  mac: {
    icon: 'resources/icons/mac/icon.icns',
    category: 'public.app-category.graphics-design',
    // Keep only the English Chromium locale (the rest are ~40 MB of .lproj
    // locale.pak files Chromium falls back out of anyway). On macOS these live
    // inside the pre-signed Electron Framework, so we let electron-builder prune
    // them via this option (correct resealing) rather than an afterPack delete.
    // Windows uses the flat locales/*.pak layout, pruned in build/prune-locales.cjs.
    electronLanguages: ['en'],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    darkModeSupport: true,
    // TCC prompts read the *UsageDescription strings from the bundle's
    // Info.plist. Without NSMicrophoneUsageDescription, macOS denies mic
    // access without ever prompting, silently breaking the recording mic.
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Lumia uses the microphone to capture narration when you record your screen with audio.'
    },
    // electron-updater on macOS requires a .zip artifact — latest-mac.yml
    // lists the .zip as the primary update file; the .dmg cannot be applied
    // as an in-place update. Without `zip` here, auto-update fails with
    // "file not found" even though the DMG uploads fine.
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] }
    ]
  },

  dmg: {
    window: { width: 540, height: 380 }
  }
}
