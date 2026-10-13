"""Render a wallpaper from a palette: the theme background with soft glows of its
accents, so glass terminals sit on a surface that is the same colour family.
Stdlib only (PNG written with zlib). Rendered small and upscaled by macOS; it
is a gradient, so nothing is lost.
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

from gen import hex_to_oklch, oklab_to_srgb, oklch_to_oklab

WIDTH, HEIGHT = 640, 400

# Where the glows sit (fractions of width/height), their radius (fraction of
# width) and how strong they are at the centre. Fixed by design: the theme decides
# the colours, the composition is the same for every theme so they look related.
GLOWS = (
    ((0.18, 0.22), 0.55, 0.55),
    ((0.82, 0.70), 0.60, 0.45),
    ((0.55, 1.05), 0.45, 0.35),
)


def _png(width: int, height: int, rows: list[bytes]) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + row for row in rows)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def render_wallpaper(built: dict, out: Path) -> Path:
    """Write a PNG for one built palette (see gen.build_palette) and return its path."""
    l_bg, c_bg, h_bg = hex_to_oklch(built["bg"])
    # Glow colours: the seed hue and its two neighbours (a blue seed gives
    # blue/periwinkle/violet, a gold seed gives orange/gold/amber), lifted from
    # the bg lightness so they read as light behind glass, not a second background.
    # Fixed ANSI slots would be wrong here: slot 4 is always blue-ish, which on a
    # warm theme mixes to teal-on-brown.
    dark = l_bg < 0.5
    lift = 0.16 if dark else -0.10
    seed_hue = built["seed_hue"]
    glow_labs = [
        oklch_to_oklab(l_bg + lift, 0.09, (seed_hue + offset) % 360.0)
        for offset in (-40.0, -15.0, 10.0)
    ]
    base_lab = oklch_to_oklab(l_bg, c_bg, h_bg)

    rows: list[bytes] = []
    for y in range(HEIGHT):
        fy = y / HEIGHT
        row = bytearray()
        for x in range(WIDTH):
            fx = x / WIDTH
            L, a, b = base_lab
            for ((gx, gy), radius, strength), (gl, ga, gb) in zip(GLOWS, glow_labs):
                d = math.hypot((fx - gx) * (WIDTH / HEIGHT), fy - gy) / radius
                w = strength * math.exp(-d * d * 1.8)
                L += (gl - L) * w
                a += (ga - a) * w
                b += (gb - b) * w
            # Slight vertical falloff so the bottom is calmer than the top.
            L += (l_bg - L) * 0.25 * fy
            r, g, bl = oklab_to_srgb((L, a, b))
            row += bytes(max(0, min(255, round(v * 255))) for v in (r, g, bl))
        rows.append(bytes(row))

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(_png(WIDTH, HEIGHT, rows))
    return out
