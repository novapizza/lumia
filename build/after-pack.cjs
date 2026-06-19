/**
 * Single electron-builder `afterPack` entry point. electron-builder allows only
 * one afterPack hook, so this composes the per-arch steps that must run after a
 * build is packed (and before code-signing):
 *   1. embed-ffmpeg  — drop the correct ffmpeg into Resources.
 *   2. prune-locales — strip unused Chromium locale paks (Windows).
 */
const embedFfmpeg = require('./embed-ffmpeg.cjs').default
const pruneLocales = require('./prune-locales.cjs').default

exports.default = async function afterPack(context) {
  await embedFfmpeg(context)
  await pruneLocales(context)
}
