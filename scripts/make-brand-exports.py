"""Export the logo (src/assets/logo.svg) for the website, favicons and the
browser extension, into design/logo/.

  website/    logo.svg (the mark, trimmed to the circle), logo-{64..1024}.png,
              logo-tile.svg + logo-tile-{512,1024}.png (the mark on the app
              icon's dark squircle tile)
  favicon/    favicon.svg, favicon.ico (16 + 32 + 48), favicon-{16,32,48}.png,
              apple-touch-icon.png (180, opaque tile; iOS rounds it),
              icon-192.png + icon-512.png (web manifest)
  extension/  icon16/32/48/128.png in the names extension/ uses. 128 keeps
              Chrome's 16px transparent margin (96px artwork).

Small sizes (16 to 48) are drawn with wider gaps between the blades, like the
Windows tray icon, so the gaps survive; everything is rendered big and
reduced. Run: python3 scripts/make-brand-exports.py (needs Pillow and Google
Chrome, like pnpm icons).
"""
import importlib.util
import struct
from io import BytesIO
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'design' / 'logo'

# Reuse the app-icon renderer (same logo, same tile).
_spec = importlib.util.spec_from_file_location('icons', ROOT / 'scripts' / 'make-app-icons.py')
icons = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(icons)

BIG = 1024


def gaps_for(size):
    """Gap scale per output size: wider where the gaps would close up."""
    return 2.0 if size <= 32 else 1.5 if size <= 48 else 1.0


def mark_svg_file(gap_scale=1.0):
    """A standalone SVG of the mark, trimmed to the aperture's circle."""
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="31 31 193 193">'
            f'{icons.logo_inner(gap_scale)}</svg>\n')


def tile_inner(size, square=False):
    """The app icon's tile filling `size` (squircle, or a full square for
    apple-touch-icon, which iOS masks itself), the mark at 70%."""
    m = size * icons.MARK
    shape = (f'<rect width="{size}" height="{size}" fill="{icons.TILE}"/>' if square
             else f'<path d="{icons.squircle(size / 2, size / 2, size / 2)}" fill="{icons.TILE}"/>')
    return shape + icons.mark_svg(size / 2 - m / 2, size / 2 - m / 2, m)


def render_big(inner_fn, tmp_name):
    path = OUT / f'.{tmp_name}.png'
    icons.render(icons.page(BIG, inner_fn(BIG)), BIG, path)
    img = Image.open(path).convert('RGBA')
    path.unlink()
    return img


def save(img, size, path, pad=0):
    """Reduce `img` to `size`, optionally inside a transparent margin."""
    path.parent.mkdir(parents=True, exist_ok=True)
    art = img.resize((size - 2 * pad, size - 2 * pad), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.paste(art, (pad, pad), art)
    canvas.save(path, optimize=True)
    print('  ✓', path.relative_to(ROOT))
    return canvas


def write_ico(images, path):
    """ICO with PNG entries (Vista+ and every browser read these)."""
    blobs = []
    for im in images:
        buf = BytesIO()
        im.save(buf, format='PNG', optimize=True)
        blobs.append((im.width, buf.getvalue()))
    header = struct.pack('<HHH', 0, 1, len(blobs))
    offset = 6 + 16 * len(blobs)
    entries, data = b'', b''
    for w, png in blobs:
        entries += struct.pack('<BBBBHHII', w % 256, w % 256, 0, 0, 1, 32, len(png), offset + len(data))
        data += png
    path.write_bytes(header + entries + data)
    print('  ✓', path.relative_to(ROOT))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    marks = {g: render_big(lambda s, g=g: icons.mark_svg(0, 0, s, gap_scale=g), f'mark-{g}')
             for g in (1.0, 1.5, 2.0)}
    tile = render_big(lambda s: tile_inner(s), 'tile')
    square_tile = render_big(lambda s: tile_inner(s, square=True), 'tile-square')

    # Website
    web = OUT / 'website'
    web.mkdir(parents=True, exist_ok=True)
    (web / 'logo.svg').write_text(mark_svg_file())
    print('  ✓', (web / 'logo.svg').relative_to(ROOT))
    (web / 'logo-tile.svg').write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">{tile_inner(512)}</svg>\n')
    print('  ✓', (web / 'logo-tile.svg').relative_to(ROOT))
    for s in (64, 128, 256, 512, 1024):
        save(marks[1.0], s, web / f'logo-{s}.png')
    for s in (512, 1024):
        save(tile, s, web / f'logo-tile-{s}.png')

    # Favicons
    fav = OUT / 'favicon'
    fav.mkdir(parents=True, exist_ok=True)
    (fav / 'favicon.svg').write_text(mark_svg_file(gap_scale=1.5))
    print('  ✓', (fav / 'favicon.svg').relative_to(ROOT))
    small = [save(marks[gaps_for(s)], s, fav / f'favicon-{s}.png') for s in (16, 32, 48)]
    write_ico(small, fav / 'favicon.ico')
    apple = square_tile.resize((180, 180), Image.LANCZOS).convert('RGB')
    apple.save(fav / 'apple-touch-icon.png', optimize=True)
    print('  ✓', (fav / 'apple-touch-icon.png').relative_to(ROOT))
    for s in (192, 512):
        save(marks[1.0], s, fav / f'icon-{s}.png')

    # Browser extension (names as in extension/)
    ext = OUT / 'extension'
    for s in (16, 32, 48):
        save(marks[gaps_for(s)], s, ext / f'icon{s}.png')
    save(marks[1.0], 128, ext / 'icon128.png', pad=16)


if __name__ == '__main__':
    main()
