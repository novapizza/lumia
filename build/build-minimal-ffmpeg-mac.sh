#!/usr/bin/env bash
# Compile a MINIMAL static-internal ffmpeg for macOS (darwin x64 / arm64).
#
# Counterpart to build/build-minimal-ffmpeg-win.sh — KEEP THE COMPONENT FLAGS
# (the --disable-*/--enable-demuxer/muxer/protocol block) IN SYNC with that
# script. Only the toolchain bits differ: clang + -arch instead of mingw, and
# x86 asm is disabled (a `-c copy` remux has no perf-critical codec paths, and
# dropping asm means no nasm dependency + lets an arm64 host cross-build x64).
#
# Must run on a macOS host (CI `release-mac` on macos-latest, or a local mac).
# macos-latest is arm64, so the x64 target is cross-compiled via `clang -arch`.
#
# Usage: build/build-minimal-ffmpeg-mac.sh <x64|arm64> <output-dir>
#   -> writes <output-dir>/ffmpeg-darwin-<x64|arm64>  (~2-3 MB)
set -euo pipefail

TARGET_ARCH="${1:?usage: build-minimal-ffmpeg-mac.sh <x64|arm64> <output-dir>}"
OUT_DIR="${2:?usage: build-minimal-ffmpeg-mac.sh <x64|arm64> <output-dir>}"
FFMPEG_VERSION="${FFMPEG_VERSION:-6.1.1}"

case "$TARGET_ARCH" in
  x64)   FF_ARCH=x86_64 ;;
  arm64) FF_ARCH=arm64  ;;
  *) echo "[ffmpeg-min] unknown arch '$TARGET_ARCH' (expected x64 |arm64)" >&2; exit 1 ;;
esac

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

# Cross-compile only when the host arch differs from the target (macos-latest is
# arm64, so building x64 needs --enable-cross-compile; configure can't run test
# binaries for the other arch).
CROSS_FLAGS=()
if [ "$(uname -m)" != "$FF_ARCH" ]; then
  CROSS_FLAGS+=(--enable-cross-compile)
fi

echo "[ffmpeg-min] configuring darwin-${TARGET_ARCH} (matroska demux + webm mux only)"
./configure \
  --cc="clang -arch ${FF_ARCH}" \
  --arch="${FF_ARCH}" \
  --target-os=darwin \
  "${CROSS_FLAGS[@]}" \
  --extra-cflags="-arch ${FF_ARCH}" \
  --extra-ldflags="-arch ${FF_ARCH}" \
  --disable-x86asm \
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
  --disable-protocols --enable-protocol=file,pipe

echo "[ffmpeg-min] compiling"
make -j"$(sysctl -n hw.ncpu)"
strip ffmpeg

mkdir -p "$OUT_DIR"
cp ffmpeg "$OUT_DIR/ffmpeg-darwin-${TARGET_ARCH}"
echo "[ffmpeg-min] done -> $OUT_DIR/ffmpeg-darwin-${TARGET_ARCH} ($(du -h "$OUT_DIR/ffmpeg-darwin-${TARGET_ARCH}" | cut -f1))"
