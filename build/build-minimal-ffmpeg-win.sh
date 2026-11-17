#!/usr/bin/env bash
# Cross-compile a MINIMAL static ffmpeg.exe for Windows x64 (mingw-w64).
#
# Lumia only ever runs `ffmpeg -i in.webm -c copy -f webm out.webm` (a pure
# container remux that rebuilds Cues/Duration so MediaRecorder WebM becomes
# seekable — see electron/ffmpeg-remux.ts). No encode/decode, so we strip every
# encoder, decoder, filter, device, and all demuxers/muxers/protocols except
# the matroska demuxer + webm muxer + file/pipe protocol, and the libraries the
# ffmpeg CLI runs fine without (avdevice / swscale / swresample / postproc —
# fftools guards every use behind CONFIG_*). Parsers: only what MediaRecorder
# WebM carries (vp8 / vp9 / opus / vorbis — matroskadec asks for header parsing
# on these). Bitstream filters: all off; configure's matroska_muxer_select
# force-enables the ones the webm muxer auto-inserts (vp9_superframe,
# aac_adtstoasc, pgs_frame_merge).
#
# Result: ~2.5 MB vs ffmpeg-static's ~82 MB full build.
#
# LICENCE: Lumia is closed source, so this build is gated to LGPL v2.1+ (see
# "Licence gate" below). Never add --enable-gpl / --enable-nonfree /
# --enable-version3 or an external library. It ships alongside
# resources/licenses/FFmpeg-*.txt (electron-builder extraResources).
#
# This is the SINGLE SOURCE OF TRUTH for the configure flags. Both the local
# Docker build (build/minimal-ffmpeg/Dockerfile) and CI run this script.
#
# Requirements (on a Linux host): gcc-mingw-w64-x86-64, make, nasm, curl, xz.
# Usage: build/build-minimal-ffmpeg-win.sh <output-dir>   # writes <dir>/ffmpeg.exe
set -euo pipefail

OUT_DIR="${1:?usage: build-minimal-ffmpeg-win.sh <output-dir>}"
FFMPEG_VERSION="${FFMPEG_VERSION:-6.1.1}"
# sha256 of ffmpeg-${FFMPEG_VERSION}.tar.xz from ffmpeg.org. Bumping the version
# means bumping this (in BOTH scripts) and resources/licenses/FFmpeg-NOTICE.txt.
FFMPEG_SHA256="${FFMPEG_SHA256:-8684f4b00f94b85461884c3719382f1261f0d9eb3d59640a1f4ac0873616f968}"
# Resolve OUT_DIR to an absolute path NOW — we cd into a temp build dir below,
# after which a relative OUT_DIR would land inside (and get cleaned up with) it.
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[ffmpeg-min] fetching ffmpeg ${FFMPEG_VERSION} source"
curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
  "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" -o "$WORK/ffmpeg.tar.xz"
# Pin the exact source: the LGPL "corresponding source" named in
# FFmpeg-NOTICE.txt must be what this binary was really built from.
ACTUAL_SHA="$(sha256sum "$WORK/ffmpeg.tar.xz" | cut -d' ' -f1)"
if [ "$ACTUAL_SHA" != "$FFMPEG_SHA256" ]; then
  echo "[ffmpeg-min] source checksum mismatch: got $ACTUAL_SHA, want $FFMPEG_SHA256" >&2
  exit 1
fi
tar xf "$WORK/ffmpeg.tar.xz" -C "$WORK"
cd "$WORK/ffmpeg-${FFMPEG_VERSION}"

echo "[ffmpeg-min] configuring (matroska demux + webm mux only)"
./configure \
  --arch=x86_64 \
  --target-os=mingw32 \
  --cross-prefix=x86_64-w64-mingw32- \
  --disable-autodetect \
  --disable-network \
  --disable-doc \
  --disable-debug \
  --disable-shared \
  --enable-static \
  --enable-small \
  --disable-ffplay \
  --disable-ffprobe \
  --disable-avdevice \
  --disable-swscale \
  --disable-swresample \
  --disable-postproc \
  --disable-encoders \
  --disable-decoders \
  --disable-filters \
  --disable-devices \
  --disable-bsfs \
  --disable-parsers --enable-parser=vp8,vp9,opus,vorbis \
  --disable-demuxers --enable-demuxer=matroska \
  --disable-muxers --enable-muxer=webm,matroska \
  --disable-protocols --enable-protocol=file,pipe \
  --extra-ldflags=-static

# ── Licence gate ─────────────────────────────────────────────────────────────
# Lumia is closed source, so the shipped ffmpeg MUST stay LGPL v2.1+:
#   - never --enable-gpl      (GPL would then cover the binary we distribute)
#   - never --enable-nonfree  (the result may not be redistributed at all)
#   - never --enable-version3 (LGPLv3's "installation information" duty clashes
#                              with the signed / notarized bundle)
# --disable-autodetect keeps external libraries (some GPL) from sneaking in.
for flag in GPL NONFREE VERSION3; do
  if ! grep -q "^#define CONFIG_${flag} 0$" config.h; then
    echo "[ffmpeg-min] licence gate: CONFIG_${flag} is enabled — refusing to build" >&2
    exit 1
  fi
done
echo "[ffmpeg-min] licence gate OK: LGPL v2.1 or later"

echo "[ffmpeg-min] compiling"
make -j"$(nproc)"
x86_64-w64-mingw32-strip ffmpeg.exe

mkdir -p "$OUT_DIR"
cp ffmpeg.exe "$OUT_DIR/ffmpeg.exe"
echo "[ffmpeg-min] done -> $OUT_DIR/ffmpeg.exe ($(du -h "$OUT_DIR/ffmpeg.exe" | cut -f1))"
