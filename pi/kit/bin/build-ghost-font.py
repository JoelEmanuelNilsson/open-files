#!/usr/bin/env python3
"""Build the Ghost Insignia font: one glyph, the Koenigsegg ghost, at U+100000.

The home directory is text, so its marker becomes a character: the ghost
stands in for `~` in the prompt and in pi's chrome. Ghostty maps the codepoint
to this font via `font-codepoint-map` in ~/.config/ghostty/config.

    build-ghost-font.py <image> [out.ttf]

Needs: potrace (brew install potrace), Pillow, fontTools.
"""

import subprocess
import sys
import tempfile
from pathlib import Path
from xml.etree import ElementTree

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import SVGPath
from fontTools.ttLib.tables.O_S_2f_2 import Panose
from PIL import Image

CODEPOINT = 0x100000
FAMILY = "Ghost Insignia"
UPM = 1000
# One mono cell. Comic Code Ligatures, the primary face, is 620/1000 em wide per
# cell, and Ghostty does not constrain glyphs it reaches through
# `font-codepoint-map`: whatever this font says, it draws. Any wider and the
# ghost would paint over the character next to it.
ADVANCE = 620
# Air on both sides, so the ghost does not touch the `/` that follows it.
SIDE_BEARING = 30
ASCENDER = 800
DESCENDER = -200
# The ghost stands on the baseline and stops short of the cap height, so it
# carries the same weight in a line of text as a capital letter.
TOP = 700
BOTTOM = 0


def trace(image: Path, svg: Path) -> None:
    with tempfile.NamedTemporaryFile(suffix=".pbm", delete=False) as pbm:
        gray = Image.open(image).convert("L")
        bw = gray.point(lambda p: 0 if p < 128 else 255, mode="1")
        bw.save(pbm.name)
        subprocess.run(["potrace", "-s", "-o", str(svg), pbm.name], check=True)


def svg_bounds_pen(svg: Path) -> tuple[RecordingPen, tuple[float, float, float, float]]:
    """Record the SVG outline (in SVG user units, y down) and return its bbox."""
    root = ElementTree.parse(svg).getroot()
    ns = {"svg": "http://www.w3.org/2000/svg"}
    group = root.find("svg:g", ns)
    transform = group.get("transform", "") if group is not None else ""
    # potrace emits: translate(0,H) scale(sx,-sy) — parse both.
    tx = ty = 0.0
    sx = sy = 1.0
    for part in transform.replace(")", ") ").split(") "):
        part = part.strip()
        if part.startswith("translate("):
            tx, ty = (float(v) for v in part[len("translate("):].replace(",", " ").split())
        elif part.startswith("scale("):
            vals = [float(v) for v in part[len("scale("):].replace(",", " ").split()]
            sx, sy = (vals[0], vals[0]) if len(vals) == 1 else (vals[0], vals[1])

    rec = RecordingPen()
    pen = TransformPen(rec, (sx, 0, 0, sy, tx, ty))
    SVGPath(str(svg)).draw(pen)

    from fontTools.pens.boundsPen import BoundsPen

    bounds = BoundsPen(None)
    rec.replay(bounds)
    return rec, bounds.bounds


def monospace_panose() -> Panose:
    panose = Panose()
    panose.bFamilyType = 2
    panose.bProportion = 9
    return panose


def build(image: Path, out: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        svg = Path(tmp) / "ghost.svg"
        trace(image, svg)
        rec, (xmin, ymin, xmax, ymax) = svg_bounds_pen(svg)

    width = xmax - xmin
    height = ymax - ymin
    scale = min((TOP - BOTTOM) / height, (ADVANCE - 2 * SIDE_BEARING) / width)
    # SVG y is down; flip so the top of the image is the top of the glyph, then
    # stand the result on the baseline rather than hanging it from the top.
    glyph_w = width * scale
    dx = (ADVANCE - glyph_w) / 2 - xmin * scale
    dy = BOTTOM + ymax * scale
    tt = TTGlyphPen(None)
    rec.replay(TransformPen(Cu2QuPen(tt, max_err=1.0, reverse_direction=True), (scale, 0, 0, -scale, dx, dy)))
    glyph = tt.glyph()
    # The left side bearing in `hmtx` has to agree with the outline's own xMin:
    # rasterisers shift the glyph by the difference, and a stale 0 here slides
    # the ghost left out of its air and into the previous cell.
    glyph.recalcBounds(None)

    name = "ghost"
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder([".notdef", name])
    fb.setupCharacterMap({CODEPOINT: name})
    fb.setupGlyf({".notdef": TTGlyphPen(None).glyph(), name: glyph})
    fb.setupHorizontalMetrics({".notdef": (ADVANCE, 0), name: (ADVANCE, glyph.xMin)})
    fb.setupHorizontalHeader(ascent=ASCENDER, descent=DESCENDER)
    fb.setupNameTable(
        {"familyName": FAMILY, "styleName": "Regular", "fullName": FAMILY, "psName": "GhostInsignia-Regular", "uniqueFontIdentifier": "GhostInsignia-Regular"}
    )
    # Flagged monospace (panose proportion 9, fixed pitch): Ghostty's font
    # discovery on macOS only considers monospace families.
    fb.setupOS2(
        sTypoAscender=ASCENDER,
        sTypoDescender=DESCENDER,
        usWinAscent=ASCENDER,
        usWinDescent=-DESCENDER,
        panose=monospace_panose(),
    )
    fb.setupPost(isFixedPitch=1)
    fb.save(str(out))
    print(f"wrote {out}  glyph {glyph_w:.0f}x{height * scale:.0f} units, advance {ADVANCE}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    image = Path(sys.argv[1]).expanduser()
    out = Path(sys.argv[2]).expanduser() if len(sys.argv) > 2 else Path.home() / "Library/Fonts/GhostInsignia.ttf"
    build(image, out)
