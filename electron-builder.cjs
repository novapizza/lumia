// electron-builder config — JS form so we can pull dynamic values from
// process.env. Required because:
//   - `${env.X}` template expansion in YAML is per-field, and `publish.*`
//     fields aren't in electron-builder's expansion whitelist (verified
//     empirically: literal `${env.X}` ends up baked into app-update.yml).
//   - `--config.publish.0.url=...` CLI override fails schema validation:
//     the parser turns `publish` into an object with numeric keys instead
//     of an array.
// Same reason `azureSignOptions` is set via --config in the CI workflow.

// ── Publish — bridge release (R2 primary, GitHub fallback) ──────────────────
// Order matters: the FIRST provider is baked into `app-update.yml` shipped in
// the app, so once a user installs this build, autoUpdater polls R2 forever.
// `s3` is upload-only here (R2 endpoint requires auth); `generic` is the
// read path the client uses against the public R2 URL.
// `github` stays in this build so users on legacy versions (pre-R2) still
// see this update via their GitHub-pinned `app-update.yml` and can migrate.
// Drop the `github` entry once the long tail of legacy installs has moved.
//
// Env vars resolved at build time (CI workflow + .env.example):
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  → S3 publisher auth (read by SDK)
//   R2_RELEASES_ACCOUNT_ID                     → S3 endpoint host
//   R2_RELEASES_BUCKET                         → S3 bucket name
//   R2_RELEASES_PUBLIC_URL                     → full URL autoUpdater hits
//                                                 (scheme + host, no trailing /)
//   GH_TOKEN                                   → GitHub publisher auth
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
  },
  // GitHub provider temporarily disabled — testing a R2-only publish first.
  // Re-enable for the bridge release so 1.2.x users still get the update
  // through their existing GitHub-pinned app-update.yml.
  // {
  //   provider: 'github',
  //   owner: 'emtyty',
  //   repo: 'lumia',
  //   // Publish as a draft so GitHub's /releases/latest API doesn't surface
  //   // the new version while the mac/win jobs are still uploading. The
  //   // mark-latest workflow job un-drafts after both finish.
  //   releaseType: 'draft'
  // }
]

module.exports = {
  appId: 'com.lumia.app',
  productName: 'Lumia',
  publish,

  files: ['out/**/*'],

  extraResources: [
    {
      from: 'resources/tray',
      to: 'tray',
      filter: ['**/*.png', '**/*.ico']
    },
    { from: 'resources/icons/png/icon.png', to: 'icons/png/icon.png' },
    { from: 'resources/icon.png', to: 'icon.png' },
    { from: 'resources/picker.html', to: 'picker.html' },
    // macOS Swift helpers — looked up at runtime via process.resourcesPath.
    // CI compiles them as universal (arm64 + x86_64) before packaging via
    // build/compile-mac-helpers.sh. The same script is what local devs run.
    { from: 'electron/helpers/ocr-vision', to: 'ocr-vision' },
    { from: 'electron/helpers/window-at-point', to: 'window-at-point' },
    { from: 'electron/helpers/scroll-helper', to: 'scroll-helper' }
  ],

  directories: {
    buildResources: 'resources',
    output: 'release'
  },

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
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
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

  mac: {
    icon: 'resources/icons/mac/icon.icns',
    category: 'public.app-category.graphics-design',
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
