"""Palette math for the terminal theme system: sRGB/OKLab/OKLCH, WCAG contrast,
and the fixed slot roles that every generated theme fills. Stdlib only.

The 16 ANSI colours are the single runtime source of truth (see theme/README.md);
this module is what decides what those 16 colours are, from a four-key setup file.
"""

from __future__ import annotations

import math
import tomllib
from pathlib import Path

# Lightness (OKLCH L) of every slot, per mode. A setup file may override any of
# these under its [dark] / [light] table. The numbers are the readability
# contract: fg >=7:1 on bg, muted >=5:1, dim >=3:1, accents >=4.5:1 -- checked by
# assertion in build_palette, so a bad override fails loudly instead of shipping.
DEFAULT_LIGHTNESS = {
    "dark": {
        "bg": 0.24,  # default background
        "fg": 0.80,  # default foreground, ~8:1 on bg
        "surface": 0.30,  # slot 0: background of selected rows and panels
        "dim": 0.55,  # slot 8: dim text and borders
        "muted": 0.68,  # slot 7: muted text
        "strong": 0.90,  # slot 15: strong text
        "accent": 0.78,  # slots 1-6
        "bright_delta": 0.06,  # slots 9-14 are slots 1-6 shifted by this
        "cursor": 0.80,
        "selection": 0.38,
    },
    "light": {
        "bg": 0.95,
        "fg": 0.35,
        "surface": 0.90,
        "dim": 0.62,
        "muted": 0.50,
        "strong": 0.22,
        "accent": 0.52,
        "bright_delta": -0.06,
        "cursor": 0.45,
        "selection": 0.84,
    },
}

# Hue (OKLCH h, degrees) of the six accent slots. Every pair is >=45 deg apart so
# that a colour-coded diff or log line stays legible as shape, not just as hue.
ACCENT_HUES = {1: 25.0, 2: 145.0, 3: 85.0, 4: 265.0, 5: 325.0, 6: 205.0}

CURSOR_CHROMA = 0.12

def hue_gap(a: float, b: float) -> float:
    """Shortest angular distance between two hues, in degrees."""
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


def pull_hue_toward(hue: float, target: float, pull: float) -> float:
    """Move `hue` a fraction `pull` (0..1) of the way to `target` along the short arc.

    This is the single knob that turns the full-wheel ANSI set into a family:
    pull=0 keeps the spectrum, pull=0.5 folds red/yellow/green into pink/rose/teal
    around a blue seed (the end-4 look) while every slot stays distinguishable.
    """
    diff = ((hue - target + 180.0) % 360.0) - 180.0
    return (target + diff * (1.0 - pull)) % 360.0


def accent_hues(seed_hue: float, pull: float) -> dict[int, float]:
    """Accent hue per slot after hue_pull. Distinctness is checked on the shipped
    colours (_assert_accents_distinct), not here: at accent chroma a hue gap alone
    says little about whether two colours read as different."""
    return {slot: pull_hue_toward(h, seed_hue, pull) for slot, h in ACCENT_HUES.items()}

_LINEAR_TO_LMS = (
    (0.4122214708, 0.5363325363, 0.0514459929),
    (0.2119034982, 0.6806995451, 0.1073969566),
    (0.0883024619, 0.2817188376, 0.6299787005),
)
_LMS_TO_OKLAB = (
    (0.2104542553, 0.7936177850, -0.0040720468),
    (1.9779984951, -2.4285922050, 0.4505937099),
    (0.0259040371, 0.7827717662, -0.8086757660),
)
_OKLAB_TO_LMS = (
    (1.0, 0.3963377774, 0.2158037573),
    (1.0, -0.1055613458, -0.0638541728),
    (1.0, -0.0894841775, -1.2914855480),
)
_LMS_TO_LINEAR = (
    (4.0767416621, -3.3077115913, 0.2309699292),
    (-1.2684380046, 2.6097574011, -0.3413193965),
    (-0.0041960863, -0.7034186147, 1.7076147010),
)


def _matmul(m, v):
    return tuple(sum(row[i] * v[i] for i in range(3)) for row in m)


def srgb_channel_to_linear(c: float) -> float:
    """sRGB transfer function, inverse: one 0..1 channel to linear light."""
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear_channel_to_srgb(c: float) -> float:
    """sRGB transfer function: one linear-light channel back to 0..1 sRGB."""
    return c * 12.92 if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055


def srgb_to_oklab(rgb: tuple[float, float, float]) -> tuple[float, float, float]:
    """Gamma-encoded sRGB (0..1 per channel) to OKLab (L, a, b)."""
    lin = tuple(srgb_channel_to_linear(c) for c in rgb)
    lms = _matmul(_LINEAR_TO_LMS, lin)
    lms_ = tuple(math.copysign(abs(c) ** (1 / 3), c) for c in lms)
    return _matmul(_LMS_TO_OKLAB, lms_)


def oklab_to_srgb(lab: tuple[float, float, float]) -> tuple[float, float, float]:
    """OKLab (L, a, b) to gamma-encoded sRGB, unclamped: channels may fall
    outside 0..1, which is how out-of-gamut colours are detected."""
    lms_ = _matmul(_OKLAB_TO_LMS, lab)
    lms = tuple(c**3 for c in lms_)
    lin = _matmul(_LMS_TO_LINEAR, lms)
    return tuple(linear_channel_to_srgb(c) for c in lin)


def oklch_to_oklab(l: float, c: float, h: float) -> tuple[float, float, float]:
    """OKLCH (lightness, chroma, hue in degrees) to OKLab."""
    rad = math.radians(h)
    return (l, c * math.cos(rad), c * math.sin(rad))


def oklab_to_oklch(lab: tuple[float, float, float]) -> tuple[float, float, float]:
    """OKLab to OKLCH; hue is normalised to 0..360."""
    l, a, b = lab
    return (l, math.hypot(a, b), math.degrees(math.atan2(b, a)) % 360.0)


def hex_to_oklch(value: str) -> tuple[float, float, float]:
    """Parse a #rrggbb string into OKLCH (lightness, chroma, hue in degrees)."""
    s = value.lstrip("#")
    if len(s) != 6:
        raise ValueError(f"Theme seed colour must be #rrggbb, got {value!r}")
    rgb = tuple(int(s[i : i + 2], 16) / 255.0 for i in (0, 2, 4))
    return oklab_to_oklch(srgb_to_oklab(rgb))


def _in_gamut(rgb, eps=1e-6) -> bool:
    return all(-eps <= c <= 1 + eps for c in rgb)


def oklch_to_hex(l: float, c: float, h: float) -> str:
    """OKLCH to a #rrggbb string, gamut-mapped by reducing chroma only.

    Clipping RGB channels would move both hue and lightness; holding L and h and
    binary-searching C keeps the slot's role (its contrast) and its identity
    (its hue) exactly as specified.
    """
    if _in_gamut(oklab_to_srgb(oklch_to_oklab(l, c, h))):
        chroma = c
    else:
        lo, hi = 0.0, c
        for _ in range(64):
            mid = (lo + hi) / 2
            if _in_gamut(oklab_to_srgb(oklch_to_oklab(l, mid, h))):
                lo = mid
            else:
                hi = mid
        chroma = lo
    rgb = oklab_to_srgb(oklch_to_oklab(l, chroma, h))
    return "#" + "".join(f"{round(min(1.0, max(0.0, ch)) * 255):02x}" for ch in rgb)


def relative_luminance(hex_color: str) -> float:
    """WCAG relative luminance of a #rrggbb colour."""
    s = hex_color.lstrip("#")
    rgb = [int(s[i : i + 2], 16) / 255.0 for i in (0, 2, 4)]
    r, g, b = (srgb_channel_to_linear(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def wcag_contrast_ratio(a: str, b: str) -> float:
    """WCAG 2.1 contrast ratio between two #rrggbb colours, 1.0 .. 21.0."""
    la, lb = relative_luminance(a), relative_luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


THEME_DIR = Path(__file__).resolve().parent


def _merge_mode_base(setup: dict, mode: str) -> None:
    """Fold theme/<mode>.toml, if it exists, in under setup[mode].

    A mode that every theme shares belongs in one file, not copied into each
    setup. It was copied into each setup, verbatim, three times -- and had
    already drifted from its own comments, because nothing makes three copies
    agree. So: theme/light.toml IS the light mode, and a setup's own [light]
    table overrides it key by key (and slot by slot, for [light.accents]).
    theme/dark.toml would work the same way; there is no shared dark, so there
    is no such file.
    """
    base_path = THEME_DIR / f"{mode}.toml"
    if not base_path.exists():
        return
    with open(base_path, "rb") as fh:
        merged = tomllib.load(fh)
    for key, value in setup.get(mode, {}).items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = {**merged[key], **value}
        else:
            merged[key] = value
    setup[mode] = merged


def load_setup_toml(path: str | Path) -> dict:
    """Read a theme setup file (theme/setups/NAME.toml) into a plain dict, with
    any shared mode base (theme/<mode>.toml) merged in under [dark] / [light]."""
    with open(path, "rb") as fh:
        setup = tomllib.load(fh)
    for mode in ("dark", "light"):
        _merge_mode_base(setup, mode)
    return setup


MODE_NON_LIGHTNESS_KEYS = (
    "accents",
    "floors",
    "wallpaper",
    "seed",
    "text_seed",
    "tint",
    "text_tint",
    "cursor_tint",
    "accent_chroma",
    "hue_pull",
    "opacity",
    "blur",
)

# The readability a mode promises, as WCAG ratios against its own background,
# plus the least OKLab distance any two accents may be apart. These are the
# DEFAULTS. A mode states its own under [MODE.floors] when it reproduces a
# reference that is deliberately quieter than this -- cardboard's accents sit
# at 2.7:1 and 0.039 apart, which is the theme, not a mistake.
#
# The declaration is the contract, and it is asserted: a mode that says 2.7 and
# ships 2.4 fails generation. What the floors are NOT is a universal taste. The
# previous mechanism was one scalar (`contrast_scale`, 0.7..1) applied to all
# four tiers at once, which cannot describe a palette whose fg is fine and
# whose accents are not -- cardboard needs 0.85 on fg and 0.60 on yellow.
#
# `theme check` marks every slot under WCAG AA (4.5:1) so the cost of a quiet
# palette is visible rather than enforced.
CONTRAST_FLOORS = {"fg": 7.0, "muted": 5.0, "dim": 3.0, "accent": 4.5}
MIN_ACCENT_DISTANCE = 0.08
DEFAULT_FLOORS = {**CONTRAST_FLOORS, "accent_distance": MIN_ACCENT_DISTANCE}

# What no mode may declare its way past, because below these a slot is not
# quiet, it is absent: 1.5:1 is roughly where a colour stops separating from
# its background at text size, and 0.02 is about one perceptual step in OKLab,
# so two accents closer than that are the same colour with two names.
MIN_DECLARABLE_CONTRAST = 1.5
MIN_DECLARABLE_DISTANCE = 0.02

# Slots that may be given explicitly as [MODE.accents]: the six hues and their
# six brights. The brights are normally derived (base lightness + bright_delta
# at the same chroma), which lands within a fifth of a perceptual step of a
# reference whose brights are a uniform lift. A reference whose brights are
# something else says so here.
ACCENT_SLOTS = frozenset(ACCENT_HUES) | frozenset(s + 8 for s in ACCENT_HUES)


def background_of(setup: dict, mode: str, tier: str = "bg") -> str:
    """One surface tier of a mode, without building the rest of the palette.

    `tier` is "bg" or "surface" (slot 0). Both, because a floor is measured on
    the worse of the two (text_contrast) and solve_accents.py has to solve
    against the same pair the assertions check.
    """
    table = setup.get(mode, {})
    lightness = dict(DEFAULT_LIGHTNESS[mode])
    lightness.update({k: float(v) for k, v in table.items() if k not in MODE_NON_LIGHTNESS_KEYS})
    _, _, seed_hue = hex_to_oklch(table.get("seed", setup["seed"]))
    return oklch_to_hex(lightness[tier], float(table.get("tint", setup["tint"])), seed_hue)


def build_palette(setup: dict, mode: str) -> dict:
    """Build one mode of a theme: bg, fg, palette[0..15], cursor and selection.

    `setup` is a parsed setups/NAME.toml (seed, tint, text_tint, accent_chroma,
    plus optional [dark]/[light] lightness overrides); `mode` is "dark" or "light".
    """
    if mode not in ("dark", "light"):
        raise ValueError(f"Theme mode must be dark or light, got {mode!r}")

    mode_table = dict(setup.get(mode, {}))
    # [dark.accents] / [light.accents]: per-slot [L, C, h] that replaces the
    # derived accent for that slot. This is how a theme reproduces a specific
    # reference palette (e.g. end-4's Material tones) instead of a spectrum.
    explicit_accents = {
        int(slot): tuple(float(v) for v in lch) for slot, lch in mode_table.pop("accents", {}).items()
    }
    for slot in explicit_accents:
        if slot not in ACCENT_SLOTS:
            raise ValueError(f"[{mode}.accents] slot must be 1-6 or 9-14, got {slot}")
    floors = dict(DEFAULT_FLOORS)
    floors.update({k: float(v) for k, v in mode_table.pop("floors", {}).items()})
    if set(floors) != set(DEFAULT_FLOORS):
        raise ValueError(
            f"[{mode}.floors] may only name {', '.join(sorted(DEFAULT_FLOORS))}; "
            f"got {', '.join(sorted(set(floors) - set(DEFAULT_FLOORS)))}"
        )
    for tier in CONTRAST_FLOORS:
        if floors[tier] < MIN_DECLARABLE_CONTRAST:
            raise ValueError(
                f"[{mode}.floors] {tier} = {floors[tier]} is below {MIN_DECLARABLE_CONTRAST}:1, "
                "which is not a quiet colour but an invisible one"
            )
    if floors["accent_distance"] < MIN_DECLARABLE_DISTANCE:
        raise ValueError(
            f"[{mode}.floors] accent_distance = {floors['accent_distance']} is below "
            f"{MIN_DECLARABLE_DISTANCE}, about one perceptual step: two accents that close "
            "are one colour with two names"
        )
    # Glass is per mode, like the wallpaper: bin/theme resolves it for the
    # current appearance, writes theme/gen/ghostty/glass and reloads. Ghostty's
    # docs say background-opacity needs a full restart; on 1.3.1 that is wrong
    # for a `config-file` include -- SIGUSR2 changes a live window's opacity
    # (measured, see bin/theme write_glass). None of the three is a lightness.
    for key in ("opacity", "blur", "wallpaper"):
        mode_table.pop(key, None)
    # [light] seed / tint: a mode may sit on a different surface hue than the
    # other (end4: periwinkle night, sky-blue day) without being a second theme.
    seed = mode_table.pop("seed", setup["seed"])
    # `text_seed`: the hue of the INK, when it is not the hue of the paper.
    # One seed with two chromas gets a family whose text and surfaces agree, and
    # that is most themes. It cannot get cardboard, whose paper is warm sand
    # (h 85) and whose ink is cool slate (h 197) -- 112 degrees apart, which no
    # choice of chroma fakes. Defaults to `seed`, so a theme with one hue is
    # written exactly as before.
    text_seed = mode_table.pop("text_seed", seed)
    tint = float(mode_table.pop("tint", setup["tint"]))
    text_tint = float(mode_table.pop("text_tint", setup["text_tint"]))
    cursor_tint = float(mode_table.pop("cursor_tint", CURSOR_CHROMA))
    lightness = dict(DEFAULT_LIGHTNESS[mode])
    lightness.update({k: float(v) for k, v in mode_table.items()})

    _, _, seed_hue = hex_to_oklch(seed)
    _, _, text_hue = hex_to_oklch(text_seed)
    # Per mode, like seed and tint. A mode that ships its own accents ships its
    # own chroma and its own hue spread with them: end4's dark is a Material
    # reference folded 0.15 toward its seed, and its light is a different
    # palette entirely, which the setup-wide value would have bent to match.
    accent_chroma = float(mode_table.pop("accent_chroma", setup["accent_chroma"]))
    hue_pull = float(mode_table.pop("hue_pull", setup.get("hue_pull", 0.0)))
    if not 0.0 <= hue_pull <= 0.75:
        raise ValueError(f"hue_pull must be within 0..0.75, got {hue_pull}")

    def paper(l: float, chroma: float) -> str:
        return oklch_to_hex(l, chroma, seed_hue)

    def ink(l: float, chroma: float) -> str:
        return oklch_to_hex(l, chroma, text_hue)

    bg = paper(lightness["bg"], tint)
    fg = ink(lightness["fg"], text_tint)

    palette = [""] * 16
    palette[0] = paper(lightness["surface"], tint)
    palette[7] = ink(lightness["muted"], text_tint)
    palette[15] = ink(lightness["strong"], text_tint)
    # Slot 8 is the one slot with two jobs -- "dim text and borders" -- so it is
    # the one slot that takes from both families: the ink's hue, because a
    # hairline is thin ink and not a pale surface, and the surfaces' chroma,
    # because at this lightness it is a rule far more often than a paragraph.
    # With one seed the question never came up, and both answers were the same.
    palette[8] = ink(lightness["dim"], tint)
    for slot, hue in accent_hues(seed_hue, hue_pull).items():
        l, c, h = explicit_accents.get(slot, (lightness["accent"], accent_chroma, hue))
        palette[slot] = oklch_to_hex(l, c, h)
        bl, bc, bh = explicit_accents.get(slot + 8, (l + lightness["bright_delta"], c, h))
        palette[slot + 8] = oklch_to_hex(bl, bc, bh)
    _assert_accents_distinct(palette, floors["accent_distance"])

    result = {
        "mode": mode,
        "seed_hue": seed_hue,
        "bg": bg,
        "fg": fg,
        "palette": palette,
        # The cursor is ink: a block cursor is a filled character cell, so it
        # belongs to the text family's hue. Its chroma is its own knob, because
        # the default is a deliberate 0.12 -- far above any text tier -- to make
        # the cursor the one saturated thing on a muted screen. A theme whose
        # cursor is plain ink sets cursor_tint to its text_tint.
        "cursor": oklch_to_hex(lightness["cursor"], cursor_tint, text_hue),
        "cursor_text": bg,
        "selection_bg": paper(lightness["selection"], tint),
        # The contract this palette was built against, so `theme check` can
        # print what the mode promised beside what it shipped.
        "floors": floors,
    }

    def held(hex_color: str) -> float:
        return text_contrast(hex_color, bg, palette[0])

    assert held(fg) >= floors["fg"], f"fg contrast {held(fg):.2f} < {floors['fg']}"
    assert held(palette[7]) >= floors["muted"], f"slot 7 (muted) below {floors['muted']}:1"
    assert held(palette[8]) >= floors["dim"], f"slot 8 (dim) below {floors['dim']}:1"
    # All twelve accent slots, not the six bases. A bright is text like any
    # other and terminal programs reach for slots 9-14 constantly; this floor
    # covered 1-6 only, so every theme here shipped brights nobody had measured
    # and the light mode's sat at 1.94:1 -- below the floor it declared for
    # itself -- while generation passed.
    for slot in sorted(ACCENT_SLOTS):
        ratio = held(palette[slot])
        assert ratio >= floors["accent"], f"accent slot {slot} contrast {ratio:.2f} < {floors['accent']}"
    return result


def _assert_accents_distinct(palette: list[str], floor: float) -> None:
    """Every pair of slots 1-6 at least `floor` apart in OKLab.

    The default floor (0.08) is where two colours stop reading as different at
    text size, which is what colour-coded output depends on. A mode that
    reproduces a desaturated reference declares a lower one and lives with it:
    cardboard's six accents are one pair of sRGB values permuted across the
    three channels, so its closest pair -- green and yellow -- is 0.039 apart,
    and being nearly the same colour is the look.
    """
    # The bases and the brights, each group against itself. Not across the two:
    # a bright is meant to sit near its own base, and cyberdream's brights ARE
    # its bases. Within a group the requirement is the same one -- six slots
    # that colour-coded output expects to tell apart.
    for group in (ACCENT_HUES, [s + 8 for s in ACCENT_HUES]):
        labs = {slot: oklch_to_oklab(*hex_to_oklch(palette[slot])) for slot in group}
        slots = list(labs)
        for i, a in enumerate(slots):
            for b in slots[i + 1 :]:
                d = math.dist(labs[a], labs[b])
                assert d >= floor, (
                    f"accent slots {a} and {b} are too alike (OKLab distance {d:.3f} < {floor})"
                )


# The WCAG 2.1 ratio for normal-size text. Terminal text is normal-size text.
# Not a floor here -- a mode may declare its way below it -- but `theme check`
# says so on every slot that sits under it, because a palette this quiet is a
# choice and the reader should be able to see what it cost.
WCAG_AA = 4.5


def text_contrast(hex_color: str, bg: str, surface: str) -> float:
    """The contrast a text slot actually holds: the WORSE of its ratio against
    the window background and against slot 0.

    Floors used to be measured on `bg` alone, and slot 0 is a fill a fifth of a
    step off it, so every ratio in the table was the best case. A terminal UI
    paints most of its text on panels -- an input box, a status line, a diff
    gutter -- and there each colour is ~20% worse than the number the theme
    promised. Measuring the worse of the two makes the floor mean what it says
    wherever the text lands.
    """
    return min(wcag_contrast_ratio(hex_color, bg), wcag_contrast_ratio(hex_color, surface))

# Rows in the contrast table that something is expected to be READ on. The
# others (bg, slot 0, selection) are fills, and a fill sitting close to the
# background is the point of it, not a failing.
_TEXT_ROWS = frozenset({"fg", *(f"{i}" for i in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15))})


def contrast_report(built: dict) -> list[tuple[str, str, float, float, str]]:
    """Table of (slot name, hex, ratio on bg, ratio on slot 0, note).

    Both, because text lands on both and the panel is always the worse of the
    two. The note is empty unless the row is text whose WORSE ratio is under
    WCAG AA, which is where a mode's declared floors have bought quiet at the
    cost of legibility.
    """
    bg = built["bg"]
    names = {
        0: "0 surface",
        1: "1 red",
        2: "2 green",
        3: "3 yellow",
        4: "4 blue",
        5: "5 magenta",
        6: "6 cyan",
        7: "7 muted",
        8: "8 dim",
        9: "9 br red",
        10: "10 br green",
        11: "11 br yellow",
        12: "12 br blue",
        13: "13 br magenta",
        14: "14 br cyan",
        15: "15 strong",
    }
    plain = [("bg", bg), ("fg", built["fg"])]
    plain += [(names[i], built["palette"][i]) for i in range(16)]
    plain += [("cursor", built["cursor"]), ("selection", built["selection_bg"])]

    surface = built["palette"][0]
    rows = []
    for name, hexval in plain:
        on_bg = wcag_contrast_ratio(hexval, bg)
        on_surface = wcag_contrast_ratio(hexval, surface)
        is_text = name.split()[0] in _TEXT_ROWS
        under = is_text and min(on_bg, on_surface) < WCAG_AA
        rows.append((name, hexval, on_bg, on_surface, "under AA" if under else ""))
    return rows
