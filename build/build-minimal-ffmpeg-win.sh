#!/usr/bin/env bash
# Cross-compile a MINIMAL static ffmpeg.exe for Windows x64 (mingw-w64).
#
# Lumia only ever runs `ffmpeg -i in.webm -c copy -f webm out.webm` (a pure
# container remux that rebuilds Cues/Duration so MediaRecorder WebM becomes
# seekable — see electron/ffmpeg-remux.ts). No encode/decode, so we strip every
# encoder, decoder, filter, device, and all demuxers/muxers/protocols except
# the matroska demuxer + webm muxer + file/pipe protocol. Parsers and bitstream
# filters stay enabled (tiny, and `-c copy` can auto-insert e.g. vp9_superframe).
#
# Result: ~2.5 MB vs ffmpeg-static's ~82 MB full build.
#
# This is the SINGLE SOURCE OF TRUTH for the configure flags. Both the local
# Docker build (build/minimal-ffmpeg/Dockerfile) and CI run this script.
#
# Requirements (on a Linux host): gcc-mingw-w64-x86-64, make, nasm, curl, xz.
# Usage: build/build-minimal-ffmpeg-win.sh <output-dir>   # writes <dir>/ffmpeg.exe
set -euo pipefail

OUT_DIR="${1:?usage: build-minimal-ffmpeg-win.sh <output-dir>}"
FFMPEG_VERSION="${FFMPEG_VERSION:-6.1.1}"
# Resolve OUT_DIR to an absolute path NOW — we cd into a temp build dir below,
# after which a relative OUT_DIR would land inside (and get cleaned up with) it.
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[ffmpeg-min] fetching ffmpeg ${FFMPEG_VERSION} source"
curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
  "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" -o "$WORK/ffmpeg.tar.xz"
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
  --disable-encoders \
  --disable-decoders \
  --disable-filters \
  --disable-devices \
  --disable-demuxers --enable-demuxer=matroska \
  --disable-muxers --enable-muxer=webm,matroska \
  --disable-protocols --enable-protocol=file,pipe \
  --extra-ldflags=-static

echo "[ffmpeg-min] compiling"
make -j"$(nproc)"
x86_64-w64-mingw32-strip ffmpeg.exe

mkdir -p "$OUT_DIR"
cp ffmpeg.exe "$OUT_DIR/ffmpeg.exe"
echo "[ffmpeg-min] done -> $OUT_DIR/ffmpeg.exe ($(du -h "$OUT_DIR/ffmpeg.exe" | cut -f1))"
