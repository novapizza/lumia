#!/usr/bin/env python3
"""Subset Material Symbols Outlined to the icons Lumia actually uses.

The stock `material-symbols` package ships ~3,900 ligature icons in a 3.9 MB
variable woff2 that *every* renderer process (main window + one pooled
overlay per display) downloads, decodes and keeps in its font cache. Lumia
uses ~150 of them. This script:

  1. scans src/ and electron/ for string literals and JSX text that match an
     icon name in the font (over-inclusion is harmless — a stray word such as
     "image" that happens to be an icon just keeps one extra glyph);
  2. subsets the font to those ligatures plus the a-z 0-9 _ input glyphs,
     keeping all four axes (FILL / wght / GRAD / opsz — the UI tweaks FILL and
     wght inline in a couple of places);
  3. verifies by shaping every kept icon name with HarfBuzz;
  4. writes src/assets/fonts/material-symbols-outlined.subset.woff2 plus the
     matching CSS and a reviewable icon list.

Re-run after adding a new <span class="material-symbols-outlined">…</span>:

    python scripts/subset-material-symbols.py

Requires Python 3.9+ with:  pip install fonttools brotli uharfbuzz
An icon that is missing from the subset renders as its literal name (e.g. the
word "settings") — visible, not fatal.
"""
from __future__ import annotations

import io
import re
import sys
from pathlib import Path

try:
    from fontTools import subset
    from fontTools.ttLib import TTFont
    import uharfbuzz as hb
except ImportError as e:  # pragma: no cover
    sys.exit(f'{e}\nInstall deps: pip install fonttools brotli uharfbuzz')

ROOT = Path(__file__).resolve().parents[1]
SRC_FONT = ROOT / 'node_modules' / 'material-symbols' / 'material-symbols-outlined.woff2'
OUT_DIR = ROOT / 'src' / 'assets' / 'fonts'
OUT_FONT = OUT_DIR / 'material-symbols-outlined.subset.woff2'
OUT_CSS = OUT_DIR / 'material-symbols.css'
OUT_LIST = OUT_DIR / 'material-symbols.icons.txt'

SCAN_DIRS = [ROOT / 'src', ROOT / 'electron']
SCAN_EXT = {'.ts', '.tsx', '.css', '.html'}
# Glyphs the ligature *inputs* are built from — icon names are [a-z0-9_].
INPUT_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789_'

LITERAL_RE = re.compile(r"""['"`]([a-z][a-z0-9_]{1,60})['"`]""")
JSX_TEXT_RE = re.compile(r'>\s*([a-z][a-z0-9_]{1,60})\s*<')


def scan_candidates() -> set[str]:
    found: set[str] = set()
    for base in SCAN_DIRS:
        for path in base.rglob('*'):
            if path.suffix not in SCAN_EXT or not path.is_file():
                continue
            if OUT_DIR in path.parents:
                continue  # don't read our own icon list back in
            text = path.read_text(encoding='utf-8', errors='ignore')
            found.update(LITERAL_RE.findall(text))
            found.update(JSX_TEXT_RE.findall(text))
    return found


def ligature_names(font: TTFont) -> dict[str, str]:
    """icon name → ligature glyph name, walked from the GSUB LigatureSubst tables."""
    rev = {g: chr(u) for u, g in font.getBestCmap().items()}
    names: dict[str, str] = {}
    for lookup in font['GSUB'].table.LookupList.Lookup:
        subtables = lookup.SubTable
        if lookup.LookupType == 7:  # Extension → unwrap
            subtables = [st.ExtSubTable for st in subtables]
        for st in subtables:
            ligs = getattr(st, 'ligatures', None)
            if not ligs:
                continue
            for first, entries in ligs.items():
                for lig in entries:
                    try:
                        name = ''.join(rev[g] for g in [first, *lig.Component])
                    except KeyError:
                        continue
                    names[name] = lig.LigGlyph
    return names


def shape_check(ttf_bytes: bytes, names: list[str]) -> list[str]:
    """Return the icon names that do NOT shape to exactly one real glyph."""
    face = hb.Face(ttf_bytes)
    font = hb.Font(face)
    bad = []
    for name in names:
        buf = hb.Buffer()
        buf.add_str(name)
        buf.guess_segment_properties()
        hb.shape(font, buf, {'liga': True})
        infos = buf.glyph_infos
        if len(infos) != 1 or infos[0].codepoint == 0:
            bad.append(name)
    return bad


def main() -> int:
    if not SRC_FONT.exists():
        sys.exit(f'missing {SRC_FONT} — run pnpm install first')

    font = TTFont(SRC_FONT)
    all_icons = ligature_names(font)
    candidates = scan_candidates()
    keep = sorted(candidates & all_icons.keys())
    if len(keep) < 20:
        sys.exit(f'only {len(keep)} icons matched — scan is probably broken, refusing to write')
    print(f'font has {len(all_icons)} icons; source references {len(keep)}')

    opts = subset.Options()
    # The icon ligatures live in the *required* features `rlig` / `rclt` (not
    # `liga`, despite the stock CSS asking for it) — keep all three.
    opts.layout_features = ['rlig', 'rclt', 'liga']
    opts.layout_closure = False       # don't drag in every ligature reachable from a-z
    opts.notdef_outline = True
    opts.hinting = False
    opts.recommended_glyphs = True
    subsetter = subset.Subsetter(opts)
    subsetter.populate(unicodes=[ord(c) for c in INPUT_CHARS], glyphs=[all_icons[n] for n in keep])
    subsetter.subset(font)

    # Verify on the uncompressed TTF (HarfBuzz doesn't read woff2), then emit woff2.
    font.flavor = None
    raw = io.BytesIO()
    font.save(raw)
    bad = shape_check(raw.getvalue(), keep)
    if bad:
        sys.exit(f'{len(bad)} icon(s) fail to shape after subsetting: {bad}')
    # And a control: an icon we dropped must NOT still resolve to one glyph.
    dropped = next(n for n in sorted(all_icons) if n not in candidates)
    if not shape_check(raw.getvalue(), [dropped]):
        sys.exit(f'control failed: dropped icon "{dropped}" still shapes — subset kept too much')

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    font.flavor = 'woff2'
    font.save(OUT_FONT)

    OUT_LIST.write_text('\n'.join(keep) + '\n', encoding='utf-8')
    OUT_CSS.write_text(
        '/* Generated by scripts/subset-material-symbols.py — do not edit by hand.\n'
        '   Same @font-face + helper class as material-symbols/outlined.css, but the\n'
        '   font file is trimmed to the icons listed in material-symbols.icons.txt.\n'
        '   Added a new icon? Re-run the script. */\n'
        '@font-face {\n'
        '  font-family: "Material Symbols Outlined";\n'
        '  font-style: normal;\n'
        '  font-weight: 100 700;\n'
        '  font-display: block;\n'
        '  src: url("./material-symbols-outlined.subset.woff2") format("woff2");\n'
        '}\n'
        '.material-symbols-outlined {\n'
        '  font-family: "Material Symbols Outlined";\n'
        '  font-weight: normal;\n'
        '  font-style: normal;\n'
        '  font-size: 24px;\n'
        '  line-height: 1;\n'
        '  letter-spacing: normal;\n'
        '  text-transform: none;\n'
        '  display: inline-block;\n'
        '  white-space: nowrap;\n'
        '  word-wrap: normal;\n'
        '  direction: ltr;\n'
        '  -webkit-font-smoothing: antialiased;\n'
        '  -moz-osx-font-smoothing: grayscale;\n'
        '  text-rendering: optimizeLegibility;\n'
        '  font-feature-settings: "liga";\n'
        '}\n',
        encoding='utf-8',
    )

    before = SRC_FONT.stat().st_size
    after = OUT_FONT.stat().st_size
    print(f'wrote {OUT_FONT.relative_to(ROOT)}: {before/1024:.0f} KB -> {after/1024:.0f} KB ({len(keep)} icons, all shape OK)')
    print(f'icon list: {OUT_LIST.relative_to(ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
