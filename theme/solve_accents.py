"""Find the six accent tones closest to a reference set that still pass the floors
the mode declares: pairwise OKLab distance and WCAG contrast on its own background.

Usage: python3 theme/solve_accents.py SETUP MODE
Reads [MODE.accents] from theme/setups/SETUP.toml as the reference and prints a
replacement table. Distances are measured on the colours as shipped (after sRGB
gamut clipping), which is why hand-nudging OKLCH numbers does not converge.
"""

from __future__ import annotations

import math
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from gen import (  # noqa: E402
    ACCENT_HUES,
    DEFAULT_FLOORS,
    background_of,
    hex_to_oklch,
    load_setup_toml,
    oklch_to_hex,
    oklch_to_oklab,
    text_contrast,
    wcag_contrast_ratio,
)

Tone = tuple[float, float, float]
MARGIN = 1.05  # solve slightly inside the floor so rounding cannot fail it


def shipped_lab(t: Tone):
    return oklch_to_oklab(*hex_to_oklch(oklch_to_hex(*t)))


def feasible(cand: dict[int, Tone], bg: str, surface: str, floor: float, distance: float) -> bool:
    labs = {k: shipped_lab(t) for k, t in cand.items()}
    keys = list(labs)
    for i, a in enumerate(keys):
        for b in keys[i + 1 :]:
            if math.dist(labs[a], labs[b]) < distance * MARGIN:
                return False
    return all(text_contrast(oklch_to_hex(*t), bg, surface) >= floor * MARGIN for t in cand.values())


def cost(cand: dict[int, Tone], ref: dict[int, Tone]) -> float:
    return sum(math.dist(shipped_lab(cand[k]), shipped_lab(ref[k])) for k in ref)


def clamp(t: Tone, dark: bool) -> Tone:
    l, c, h = t
    l_lo, l_hi = (0.60, 0.92) if dark else (0.25, 0.62)
    return (min(l_hi, max(l_lo, l)), min(0.16, max(0.05, c)), h % 360.0)


def solve(
    ref: dict[int, Tone],
    bg: str,
    surface: str,
    dark: bool,
    floor: float,
    distance: float,
    seed: int = 0,
) -> dict[int, Tone]:
    rng = random.Random(seed)
    best: tuple[float, dict[int, Tone]] | None = None
    for _ in range(3000):
        cand = {
            k: clamp((l + rng.gauss(0, 0.05), c + rng.gauss(0, 0.02), h + rng.gauss(0, 12)), dark)
            for k, (l, c, h) in ref.items()
        }
        if feasible(cand, bg, surface, floor, distance):
            score = cost(cand, ref)
            if best is None or score < best[0]:
                best = (score, cand)
    if best is None:
        raise SystemExit("solve_accents: no feasible palette near the reference")
    score, cand = best
    for _ in range(20000):
        k = rng.choice(list(cand))
        l, c, h = cand[k]
        trial = dict(cand)
        trial[k] = clamp((l + rng.gauss(0, 0.01), c + rng.gauss(0, 0.006), h + rng.gauss(0, 3)), dark)
        if feasible(trial, bg, surface, floor, distance):
            trial_score = cost(trial, ref)
            if trial_score < score:
                cand, score = trial, trial_score
    return cand


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] not in ("dark", "light"):
        print(__doc__)
        return 2
    name, mode = argv
    setup = load_setup_toml(Path(__file__).resolve().parent / "setups" / f"{name}.toml")
    ref_table = setup.get(mode, {}).get("accents")
    if not ref_table:
        raise SystemExit(f"solve_accents: {name}.toml has no [{mode}.accents] to use as reference")
    # Slots 1-6 only. A mode may also pin its brights (9-14) explicitly, but
    # those are not what the distance and contrast floors are measured on.
    ref = {
        int(k): tuple(float(v) for v in lch)
        for k, lch in ref_table.items()
        if int(k) in ACCENT_HUES
    }
    if set(ref) != set(ACCENT_HUES):
        raise SystemExit("solve_accents: reference must list slots 1-6")
    bg = background_of(setup, mode)
    surface = background_of(setup, mode, "surface")
    # The floors this mode declares, not the defaults: solving a desaturated
    # reference against 4.5:1 walks it away from the reference for no reason.
    declared = {**DEFAULT_FLOORS, **setup.get(mode, {}).get("floors", {})}
    floor = float(declared["accent"])
    distance = float(declared["accent_distance"])
    # "dark" here means light ink on a dark surface, which is what decides the
    # lightness range the accents live in -- end4 light is a mid-blue surface
    # with light ink, so it solves like dark.
    surface_is_dark = hex_to_oklch(bg)[0] < 0.55
    solved = solve(ref, bg, surface, dark=surface_is_dark, floor=floor, distance=distance)
    print(f"# solved for {name} {mode}, deviation {cost(solved, ref):.3f}")
    print(f"[{mode}.accents]")
    for k in sorted(solved):
        l, c, h = solved[k]
        hex_color = oklch_to_hex(l, c, h)
        worst = text_contrast(hex_color, bg, surface)
        print(f"{k} = [{l:.2f}, {c:.3f}, {h:.0f}]   # {hex_color}  {worst:.1f}:1")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
