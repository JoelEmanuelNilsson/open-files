#!/usr/bin/env python3
"""Render what subtle-crt.glsl does, without a GPU or a config reload.

Ghostty silently ignores a shader that fails to compile and gives no way to see
a mask in isolation, so tuning this by reloading and squinting is guesswork --
that is how the light branch ended up tuned to values that were never reached.
This reimplements the shader's maths in numpy over a synthetic terminal frame
built from the real font and theme colours, and writes a PNG.

Constants are parsed out of subtle-crt.glsl, so this cannot drift from it.

    ./preview.py out.png

Only the two `smoothstep` ink windows are duplicated here (the dark one is a
literal in the shader); everything else is read from the source.
"""
import re, sys, pathlib
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).parent
FONT = "/Users/joel/Library/Fonts/HackNerdFontMono-Regular.ttf"
W, H, PX = 1100, 620, 40                      # device px; PX = font-size 20 at 2x
THEMES = {                                     # (background, foreground)
    "light  jarvis-white":       ((1.00, 1.00, 1.00), (0x00/255, 0x0C/255, 0x6B/255)),
    "dark   rose-pine-moon":     ((0x23/255, 0x21/255, 0x36/255), (0xe0/255, 0xde/255, 0xf4/255)),
}
DARK_INK = (0.24, 0.72)                        # literal in the shader's dark branch
LINES = ["The quick brown fox jumps over the lazy dog",
         "def backgroundLuma(): return median(corners)",
         "  git status --short  |  rg '^ M'  |  wc -l",
         "AAAAAAAA HHHHHHHH mmmmmmmm 01234567 ########",
         "light  dark  auto      # theme helpers",
         "~/dotfiles/ghostty/shaders $ ls -la"]


def constants():
    src = (HERE / "subtle-crt.glsl").read_text()
    return {m[0]: float(m[1]) for m in
            re.findall(r"const float (\w+)\s*=\s*([0-9.]+);", src)}


def frame(bg, fg):
    im = Image.new("RGB", (W, H), tuple(int(c * 255) for c in bg))
    d, f = ImageDraw.Draw(im), ImageFont.truetype(FONT, PX)
    for i in range(12):
        d.text((20, 16 + i * int(PX * 1.22)), LINES[i % len(LINES)],
               font=f, fill=tuple(int(c * 255) for c in fg))
    return np.asarray(im).astype(np.float32) / 255.0


def smoothstep(lo, hi, x):
    t = np.clip((x - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def detail(a, radius, floor, ceiling):
    L = a @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    r = int(round(radius))
    s = np.stack([L, np.roll(L, r, 1), np.roll(L, -r, 1),
                  np.roll(L, r, 0), np.roll(L, -r, 0)])
    return smoothstep(floor, ceiling, s.max(0) - s.min(0))


def hsv2rgb(h, s, v):
    i = (np.floor(h * 6.0).astype(int) % 6)
    f = h * 6.0 - np.floor(h * 6.0)
    p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
    order = [(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)]
    out = np.zeros(h.shape + (3,), dtype=np.float32)
    for k in range(6):
        m = i == k
        for c in range(3):
            out[..., c] = np.where(m, order[k][c], out[..., c])
    return out


def shade(a, k, light):
    hh, ww, _ = a.shape
    hue = np.mod(0.98 + np.repeat(np.arange(hh, dtype=np.float32)[:, None] / hh, ww, 1) * 0.82, 1.0)
    source = a.max(axis=2)
    d = detail(a, k["DETAIL_RADIUS_LIGHT"] if light else k["DETAIL_RADIUS_DARK"],
               k["DETAIL_FLOOR"], k["DETAIL_CEILING"])
    if light:
        mask = (1.0 - smoothstep(k["LIGHT_INK_LO"], k["LIGHT_INK_HI"], source)) * d
        sat, strength = k["LIGHT_RAINBOW_SATURATION"], k["LIGHT_RAINBOW_STRENGTH"]
    else:
        mask = smoothstep(*DARK_INK, source) * d
        sat, strength = k["DARK_RAINBOW_SATURATION"], k["DARK_RAINBOW_STRENGTH"]
    tinted = hsv2rgb(hue, np.float32(sat), np.float32(1.0)) * source[..., None]
    m = (mask * strength)[..., None]
    return np.clip(a * (1 - m) + tinted * m, 0, 1)


def main(out):
    k, BAR = constants(), 46
    canvas = Image.new("RGB", (W, (H + BAR) * len(THEMES)), (20, 20, 20))
    fb = ImageFont.truetype(FONT, 26)
    for i, (name, (bg, fg)) in enumerate(THEMES.items()):
        light = name.startswith("light")
        img = Image.fromarray((shade(frame(bg, fg), k, light) * 255).astype(np.uint8))
        bar = Image.new("RGB", (W, BAR), (20, 20, 20))
        sat = k["LIGHT_RAINBOW_SATURATION"] if light else k["DARK_RAINBOW_SATURATION"]
        ImageDraw.Draw(bar).text((16, 10), f"{name}   sat {sat:.2f}",
                                 font=fb, fill=(255, 220, 90))
        canvas.paste(bar, (0, i * (H + BAR)))
        canvas.paste(img, (0, i * (H + BAR) + BAR))
    canvas.save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "preview.png")
