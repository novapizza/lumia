"""Build the dev-only tray icons: the normal tray icon with a "D" badge in the
bottom-right corner, so a `pnpm dev` instance is easy to tell apart from the
installed app. Output goes to resources/tray-dev/ (not packaged).

Run: python3 scripts/make-dev-tray-icons.py   (needs Pillow)
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'resources' / 'tray'
OUT = ROOT / 'resources' / 'tray-dev'
SS = 8  # supersampling factor for smooth edges

FONTS = [
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/Library/Fonts/Arial Bold.ttf',
    'C:/Windows/Fonts/arialbd.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
]


def font(size):
    for p in FONTS:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    raise SystemExit('No bold font found; add one to FONTS')


def badge_mask(size, badge_frac):
    """Return (ring, disc, letter) masks at `size`, supersampled then reduced.
    ring   = badge circle plus a gap around it (cleared from the icon)
    disc   = the badge circle
    letter = the "D" inside the badge
    """
    big = size * SS
    d = round(big * badge_frac)
    gap = round(big * 0.07)
    x0, y0 = big - d, big - d
    ring = Image.new('L', (big, big), 0)
    ImageDraw.Draw(ring).ellipse((x0 - gap, y0 - gap, big + gap, big + gap), fill=255)
    disc = Image.new('L', (big, big), 0)
    ImageDraw.Draw(disc).ellipse((x0, y0, big - 1, big - 1), fill=255)
    letter = Image.new('L', (big, big), 0)
    f = font(round(d * 0.72))
    dl = ImageDraw.Draw(letter)
    l, t, r, b = dl.textbbox((0, 0), 'D', font=f)
    cx, cy = x0 + d / 2, y0 + d / 2
    dl.text((cx - (r - l) / 2 - l, cy - (b - t) / 2 - t), 'D', font=f, fill=255)
    shrink = lambda m: m.resize((size, size), Image.LANCZOS)
    return shrink(ring), shrink(disc), shrink(letter)


def mac(src, dst):
    """Template image: only alpha matters. Badge = solid disc with the D cut out."""
    im = Image.open(src).convert('RGBA')
    ring, disc, letter = badge_mask(im.width, 0.56)
    a = im.getchannel('A')
    a = Image.composite(Image.new('L', im.size, 0), a, ring)           # clear corner
    badge = Image.composite(Image.new('L', im.size, 0), disc, letter)  # disc minus D
    a = Image.composite(badge, a, disc)
    black = Image.new('RGBA', im.size, (0, 0, 0, 0))
    black.putalpha(a)
    black.save(dst)


def win(src, dst):
    """Color icon: violet accent badge with a white D."""
    im = Image.open(src).convert('RGBA')
    ring, disc, letter = badge_mask(im.width, 0.56)
    clear = Image.new('RGBA', im.size, (0, 0, 0, 0))
    im = Image.composite(clear, im, ring)
    im = Image.composite(Image.new('RGBA', im.size, (116, 64, 213, 255)), im, disc)  # accent #7440d5
    im = Image.composite(Image.new('RGBA', im.size, (255, 255, 255, 255)), im, letter)
    im.save(dst)


OUT.joinpath('mac').mkdir(parents=True, exist_ok=True)
OUT.joinpath('win').mkdir(parents=True, exist_ok=True)
mac(SRC / 'mac' / 'tray-icon.png', OUT / 'mac' / 'tray-icon.png')
mac(SRC / 'mac' / 'tray-icon@2x.png', OUT / 'mac' / 'tray-icon@2x.png')
win(SRC / 'win' / 'tray-icon.png', OUT / 'win' / 'tray-icon.png')
print('wrote', *sorted(str(p.relative_to(ROOT)) for p in OUT.rglob('*.png')))
