# syntax=docker/dockerfile:1
#
# Local builder for the minimal Windows ffmpeg.exe (see
# build/build-minimal-ffmpeg-win.sh for what it produces and why). This just
# provides the mingw-w64 toolchain and runs that script — the configure flags
# live in the script so CI (apt mingw on ubuntu) and this container can't drift.
#
# Build context is the repo's build/ dir so we can COPY the shared script:
#   docker build -f build/minimal-ffmpeg/Dockerfile \
#     -o type=local,dest=build/minimal-ffmpeg/dist --target export build
# Output: build/minimal-ffmpeg/dist/ffmpeg.exe   (~2.5 MB)
#
# Or just: pnpm ffmpeg:min:win

FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      gcc-mingw-w64-x86-64 \
      make nasm pkg-config curl xz-utils ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY build-minimal-ffmpeg-win.sh /build-minimal-ffmpeg-win.sh
RUN bash /build-minimal-ffmpeg-win.sh /out

FROM scratch AS export
COPY --from=build /out/ffmpeg.exe /ffmpeg.exe
