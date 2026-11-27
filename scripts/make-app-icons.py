"""Build the app icon PNGs from the logo (src/assets/logo.svg).

Writes:
  resources/icons/png/icon.png      1024, the bare mark, full-bleed (Windows .ico source)
  resources/icons/png/icon-mac.png  1024, the mark on a dark tile inside Apple's
                                    824 grid (macOS .icns source; macOS 26+ puts
                                    icons without a full tile on a grey plate)
  resources/icon.png                256, the tile cropped to its edge (favicon on
                                    the Drive pages, Linux window icon)
  resources/tray/win/tray-icon.png  32, the bare mark with gaps twice as wide so
                                    they survive the small size
  extension/icon{16,32,48}.png      the browser extension's toolbar icons: the
                                    bare mark, gaps twice as wide at 16 and 32
  extension/icon128.png             its install / Web Store icon: the macOS tile
                                    at 96 in a 128 canvas (Chrome's 16px margin)

The macOS menu-bar icon (resources/tray/mac) is a separate template image and
is not made here.

Run: pnpm icons   (this, then build/generate-icons.cjs for .ico / .icns)
Needs Pillow and Google Chrome (renders the SVGs headless).
"""
import math
import re
import subprocess
import tempfile
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
LOGO = (ROOT / 'src' / 'assets' / 'logo.svg').read_text()
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

TILE = '#121020'        # the old icon's tile colour
GRID = 824              # Apple's icon grid inside the 1024 canvas
MARK = 0.70             # the aperture's diameter as a share of the tile


def logo_inner(gap_scale=1.0):
    """The logo's markup without its outer <svg>, gaps scaled."""
    body = re.sub(r'^.*?<svg[^>]*>|</svg>\s*$', '', LOGO, flags=re.S)
    body = re.sub(r'<!--.*?-->', '', body, flags=re.S)
    if gap_scale != 1.0:
        body = body.replace('stroke-width="6"', f'stroke-width="{6 * gap_scale:g}"')
    return body


def mark_svg(x, y, size, gap_scale=1.0):
    # The aperture's circle (centre 127.5, radius 96.5) fills the box.
    return (f'<svg x="{x}" y="{y}" width="{size}" height="{size}" viewBox="31 31 193 193">'
            f'{logo_inner(gap_scale)}</svg>')


def squircle(cx, cy, half, n=5.0, steps=720):
    """Superellipse close to Apple's continuous-corner icon shape."""
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        x = cx + half * math.copysign(abs(c) ** (2 / n), c)
        y = cy + half * math.copysign(abs(s) ** (2 / n), s)
        pts.append(f'{x:.2f},{y:.2f}')
    return 'M' + ' L'.join(pts) + ' Z'


def page(size, inner):
    return (f'<!doctype html><html style="background:transparent"><body style="margin:0">'
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
            f'viewBox="0 0 {size} {size}">{inner}</svg></body></html>')


def render(html, size, out):
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / 'icon.html'
        src.write_text(html)
        shot = Path(tmp) / 'icon.png'
        subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars',
                        '--force-device-scale-factor=1', '--default-background-color=00000000',
                        f'--window-size={size},{size}', f'--screenshot={shot}', src.as_uri()],
                       check=True, capture_output=True)
        Image.open(shot).convert('RGBA').crop((0, 0, size, size)).save(out, optimize=True)
    if not out.name.startswith('.'):
        print('  ✓', out.relative_to(ROOT))


def main():
    S = 1024
    png_dir = ROOT / 'resources' / 'icons' / 'png'

    # Bare mark, full-bleed (Windows .ico).
    render(page(S, mark_svg(0, 0, S)), S, png_dir / 'icon.png')

    # Tile in Apple's grid (macOS .icns).
    off = (S - GRID) / 2
    m = GRID * MARK
    tile = (f'<path d="{squircle(S / 2, S / 2, GRID / 2)}" fill="{TILE}"/>'
            + mark_svg(S / 2 - m / 2, S / 2 - m / 2, m))
    render(page(S, tile), S, png_dir / 'icon-mac.png')

    # The tile alone at 256 (favicon / Linux).
    mac = Image.open(png_dir / 'icon-mac.png')
    mac.crop((round(off), round(off), round(off + GRID), round(off + GRID))) \
       .resize((256, 256), Image.LANCZOS).save(ROOT / 'resources' / 'icon.png', optimize=True)
    print('  ✓ resources/icon.png')

    # Windows tray: 32px, wider gaps. Rendered big, then reduced.
    big = 256
    tmp = png_dir / '.tray-win-big.png'
    render(page(big, mark_svg(0, 0, big, gap_scale=2)), big, tmp)
    Image.open(tmp).resize((32, 32), Image.LANCZOS).save(
        ROOT / 'resources' / 'tray' / 'win' / 'tray-icon.png', optimize=True)
    tmp.unlink()
    print('  ✓ resources/tray/win/tray-icon.png')

    # Browser extension (2026-11-26; it kept the old logo until then). The
    # toolbar draws its connection dot onto 16 / 32 / 48 (background.js).
    ext = ROOT / 'extension'
    for size, gaps in ((16, 2), (32, 2), (48, 1)):
        tmp = ext / f'.icon{size}-big.png'
        render(page(big, mark_svg(0, 0, big, gap_scale=gaps)), big, tmp)
        Image.open(tmp).resize((size, size), Image.LANCZOS).save(ext / f'icon{size}.png', optimize=True)
        tmp.unlink()
        print(f'  ✓ extension/icon{size}.png')
    store = Image.new('RGBA', (128, 128), (0, 0, 0, 0))
    store.paste(mac.crop((round(off), round(off), round(off + GRID), round(off + GRID)))
                .resize((96, 96), Image.LANCZOS), (16, 16))
    store.save(ext / 'icon128.png', optimize=True)
    print('  ✓ extension/icon128.png')


if __name__ == '__main__':
    main()
