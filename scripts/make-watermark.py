#!/usr/bin/env python3
"""Render the capture watermark: the Lumia mark (src/assets/logo.svg) and the
name "Lumia" in Manrope Bold, side by side, on a transparent background
(2026-11-27, Jasper: a bare logo can't be looked up; "A at 10%" in
out/previews/watermark.html).

Two inks, picked per capture by the brightness under the mark
(electron/watermark.ts):
  resources/watermark/watermark-light.png  white name, for dark corners
  resources/watermark/watermark-dark.png   near-black name, for light corners
The logo keeps its colours in both.

Proportions from the mockup: logo 22, name 20px bold, gap 6 (in logo units).
Rendered 128px tall; the app scales it down to 2.5% of the image's shorter
side.

Needs Pillow and Google Chrome (renders headless). Run: pnpm watermark
"""
import base64
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
OUT = ROOT / 'resources' / 'watermark'
H = 128  # rendered height (the logo's)
SCALE = H / 22
FONT = ROOT / 'node_modules/@fontsource/manrope/files/manrope-latin-700-normal.woff2'
LOGO = ROOT / 'src/assets/logo.svg'
INKS = {'light': '#ffffff', 'dark': '#111111'}


def page(ink: str) -> str:
    font = base64.b64encode(FONT.read_bytes()).decode()
    logo = base64.b64encode(LOGO.read_bytes()).decode()
    return f"""<!doctype html><html style="background:transparent"><head><style>
@font-face {{ font-family: M; font-weight: 700; src: url(data:font/woff2;base64,{font}) format('woff2'); }}
body {{ margin: 0; }}
.m {{ display: inline-flex; align-items: center; gap: {6 * SCALE:.1f}px; height: {H}px;
      font: 700 {20 * SCALE:.1f}px/1 M; color: {ink}; white-space: nowrap; }}
.m img {{ width: {H}px; height: {H}px; }}
</style></head><body><div class="m"><img src="data:image/svg+xml;base64,{logo}">Lumia</div></body></html>"""


def render(ink_name: str, ink: str) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / 'wm.html'
        src.write_text(page(ink))
        shot = Path(tmp) / 'wm.png'
        subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars',
                        '--force-device-scale-factor=1', '--default-background-color=00000000',
                        '--virtual-time-budget=2000',
                        f'--window-size={H * 6},{H}', f'--screenshot={shot}', src.as_uri()],
                       check=True, capture_output=True)
        img = Image.open(shot).convert('RGBA')
        box = img.getbbox()  # trim to the drawn mark, full height kept
        img = img.crop((0, 0, box[2], H))
        OUT.mkdir(parents=True, exist_ok=True)
        out = OUT / f'watermark-{ink_name}.png'
        img.save(out, optimize=True)
        print('  ✓', out.relative_to(ROOT), img.size)


def main() -> None:
    for name, ink in INKS.items():
        render(name, ink)


if __name__ == '__main__':
    main()
