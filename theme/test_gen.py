"""Tests for the palette math: gamut mapping, contrast floors, hue discipline."""

import importlib.util
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from gen import (  # noqa: E402
    ACCENT_HUES,
    DEFAULT_LIGHTNESS,
    MIN_DECLARABLE_CONTRAST,
    MIN_DECLARABLE_DISTANCE,
    THEME_DIR,
    build_palette,
    hex_to_oklch,
    load_setup_toml,
    text_contrast,
    oklch_to_hex,
    wcag_contrast_ratio,
)


def _load_theme_cli():
    """Import bin/theme as a module: it is an executable without a .py name, and
    the glass resolution under test lives there rather than in gen.py."""
    path = Path(__file__).resolve().parent.parent / "bin" / "theme"
    spec = importlib.util.spec_from_loader("theme_cli", SourceFileLoader("theme_cli", str(path)))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_theme_cli = _load_theme_cli()
glass_of = _theme_cli.glass_of
wallpaper_file = _theme_cli.wallpaper_file

SETUPS_DIR = Path(__file__).resolve().parent / "setups"
SHIPPED_SETUPS = {p.stem: load_setup_toml(p) for p in sorted(SETUPS_DIR.glob("*.toml"))}

# Hex colours spread across the gamut -- greys, warm and cool desaturated
# tones, light and dark -- for the OKLCH round-trip check.
ROUND_TRIP_SAMPLES = (
    "#e5dfd3", "#4a5353", "#896d6d", "#6d896d", "#89896d", "#6d6d89",
    "#896d89", "#6d8989", "#a38989", "#89a389", "#a3a389", "#8989a3",
    "#a389a3", "#89a3a3", "#ffffff", "#1a1a1a", "#e5e5e5", "#b6001c",
)


def hue_gap(a: float, b: float) -> float:
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


class GamutMappingTest(unittest.TestCase):
    def test_out_of_gamut_oklch_keeps_hue_and_lightness(self):
        for l, h in ((0.78, 145.0), (0.50, 265.0), (0.30, 25.0), (0.90, 85.0)):
            with self.subTest(l=l, h=h):
                hexval = oklch_to_hex(l, 0.4, h)  # chroma 0.4 is far outside sRGB
                self.assertRegex(hexval, r"^#[0-9a-f]{6}$")
                got_l, got_c, got_h = hex_to_oklch(hexval)
                self.assertLess(abs(got_l - l), 0.01)
                self.assertLess(hue_gap(got_h, h), 2.0)
                self.assertLess(got_c, 0.4)

    def test_in_gamut_oklch_is_left_alone(self):
        hexval = oklch_to_hex(0.6, 0.05, 265.0)
        got_l, got_c, got_h = hex_to_oklch(hexval)
        self.assertAlmostEqual(got_c, 0.05, delta=0.005)
        self.assertLess(hue_gap(got_h, 265.0), 2.0)


class ContrastFloorTest(unittest.TestCase):
    def test_shipped_setups_meet_the_floors_they_declare(self):
        for name, setup in SHIPPED_SETUPS.items():
            for mode in ("dark", "light"):
                with self.subTest(setup=name, mode=mode):
                    built = build_palette(setup, mode)
                    bg, f = built["bg"], built["floors"]
                    # On the WORSE of bg and slot 0, and on all twelve accent
                    # slots. Measured on bg alone and on slots 1-6 alone, this
                    # test passed while the light mode's brights sat at 1.56:1.
                    held = lambda h: text_contrast(h, bg, built["palette"][0])  # noqa: E731
                    self.assertGreaterEqual(held(built["fg"]), f["fg"])
                    self.assertGreaterEqual(held(built["palette"][7]), f["muted"])
                    self.assertGreaterEqual(held(built["palette"][8]), f["dim"])
                    for slot in list(ACCENT_HUES) + [s + 8 for s in ACCENT_HUES]:
                        self.assertGreaterEqual(held(built["palette"][slot]), f["accent"])

    def test_a_declared_floor_is_enforced_not_merely_recorded(self):
        """The whole point of declaring: 2.7 that ships 2.4 must fail.

        The probe floor is derived from what the palette actually holds, never
        written down. A literal went stale the moment light mode's accents were
        re-solved against the glass: 6.0 was just above the 5.9 they held, and
        at 8.4 the test stopped testing anything while still passing.
        """
        setup = dict(SHIPPED_SETUPS["end4"])
        built = build_palette(setup, "light")
        held = lambda h: text_contrast(h, built["bg"], built["palette"][0])  # noqa: E731
        worst = min(held(built["palette"][s])
                    for s in list(ACCENT_HUES) + [s + 8 for s in ACCENT_HUES])
        setup["light"] = {**setup["light"], "floors": {"accent": round(worst + 0.5, 2)}}
        with self.assertRaises(AssertionError):
            build_palette(setup, "light")

    def test_no_mode_may_declare_its_way_to_an_invisible_slot(self):
        for floors in ({"fg": MIN_DECLARABLE_CONTRAST - 0.1},
                       {"accent_distance": MIN_DECLARABLE_DISTANCE - 0.001}):
            with self.subTest(floors=floors):
                setup = dict(SHIPPED_SETUPS["end4"])
                setup["light"] = {**setup["light"], "floors": floors}
                with self.assertRaises(ValueError):
                    build_palette(setup, "light")

    def test_an_unknown_floor_name_is_a_typo_not_a_new_tier(self):
        setup = dict(SHIPPED_SETUPS["end4"])
        setup["light"] = {**setup["light"], "floors": {"accnet": 3.0}}
        with self.assertRaises(ValueError):
            build_palette(setup, "light")

    def test_bg_and_fg_carry_the_lightness_their_mode_asked_for(self):
        """Gamut mapping reduces chroma only, so a slot keeps its lightness.

        This replaces a rule that said bg is never pure black and fg never pure
        white. Two shipped themes are exactly that, on purpose -- cyberdream's
        background IS #000000 and its foreground IS #ffffff, and its setup file
        says so in as many words -- so the rule had not been the rule since it
        landed, while the test and the README still claimed it was.

        What that rule was really guarding is this: a lightness must arrive.
        A theme may declare an extreme; no theme may be handed one it did not
        ask for by clipping on the way out.
        """
        for name, setup in SHIPPED_SETUPS.items():
            for mode in ("dark", "light"):
                built = build_palette(setup, mode)
                asked = setup.get(mode, {})
                for slot, key in (("bg", "bg"), ("fg", "fg")):
                    want = float(asked.get(key, DEFAULT_LIGHTNESS[mode][key]))
                    with self.subTest(setup=name, mode=mode, slot=slot):
                        self.assertAlmostEqual(hex_to_oklch(built[slot])[0], want, delta=0.01)


class GlassTest(unittest.TestCase):
    """Glass is per mode, resolved the way the wallpaper is: the mode table wins,
    the top level is the default for both. bin/theme owns the resolution."""

    def test_a_per_mode_value_overrides_the_top_level_one(self):
        setup = {**SHIPPED_SETUPS["end4"], "opacity": 0.78, "blur": 30}
        setup["light"] = {**setup["light"], "opacity": 1.0, "blur": 0}
        self.assertEqual(glass_of(setup, "light"), (1.0, 0))
        self.assertEqual(glass_of(setup, "dark"), (0.78, 30))

    def test_a_top_level_value_alone_reaches_both_modes(self):
        setup = {"opacity": 0.68, "blur": 20, "dark": {}, "light": {}}
        for mode in ("dark", "light"):
            with self.subTest(mode=mode):
                self.assertEqual(glass_of(setup, mode), (0.68, 20))

    def test_build_palette_accepts_a_mode_table_carrying_glass(self):
        """opacity and blur are bin/theme's, not lightnesses: build_palette must
        drop them rather than read one as an OKLCH lightness."""
        setup = dict(SHIPPED_SETUPS["end4"])
        for mode in ("dark", "light"):
            with self.subTest(mode=mode):
                plain = build_palette(setup, mode)
                loud = build_palette(
                    {**setup, mode: {**setup[mode], "opacity": 0.5, "blur": 7}}, mode
                )
                self.assertEqual(loud["palette"], plain["palette"])

    def test_every_shipped_setup_declares_its_glass(self):
        """Absent is not the same as opaque, and here it has to be written down.

        Moving these keys out of [dark] once dropped them entirely, and every
        window went opaque with no error anywhere to say so. So a theme states
        its glass the way a mode states its [floors]: a theme that wants to be
        opaque writes `opacity = 1.0` and `blur = 0` and says why. Omission is
        the one thing it cannot mean. The top level is enough -- it is what both
        modes fall back to.
        """
        for name, setup in SHIPPED_SETUPS.items():
            with self.subTest(setup=name):
                self.assertIn("opacity", setup)
                self.assertIn("blur", setup)

    def test_a_shipped_blur_has_an_opacity_it_can_show_through(self):
        """Ghostty blurs the background only while background-opacity < 1, so a
        blur under an opaque mode is a number that does nothing. Per mode, since
        that is how it now resolves: light mode is exactly this case, and it
        carries blur = 0 rather than an exemption."""
        for name, setup in SHIPPED_SETUPS.items():
            for mode in ("dark", "light"):
                opacity, blur = glass_of(setup, mode)
                with self.subTest(setup=name, mode=mode):
                    if blur > 0:
                        self.assertLess(opacity, 1.0)


class AccentHueTest(unittest.TestCase):
    def test_accent_hues_are_at_least_45_degrees_apart(self):
        hues = list(ACCENT_HUES.values())
        for i, a in enumerate(hues):
            for b in hues[i + 1 :]:
                self.assertGreaterEqual(hue_gap(a, b), 45.0)

    def test_bright_slots_share_hue_with_their_base(self):
        for name, setup in SHIPPED_SETUPS.items():
            for mode in ("dark", "light"):
                built = build_palette(setup, mode)
                for slot in ACCENT_HUES:
                    with self.subTest(setup=name, mode=mode, slot=slot):
                        base = hex_to_oklch(built["palette"][slot])[2]
                        bright = hex_to_oklch(built["palette"][slot + 8])[2]
                        self.assertLess(hue_gap(base, bright), 2.0)


class SharedModeBaseTest(unittest.TestCase):
    """theme/<mode>.toml is the mode every setup gets, overridable key by key.

    The merge is in load_setup_toml, so these go through a real file on disk
    rather than a hand-built dict -- a dict assembled here would skip the one
    thing under test.
    """

    BASE = 'seed = "#98a5dc"\ntint = 0.045\ntext_tint = 0.04\naccent_chroma = 0.11\n'

    # What theme/light.toml builds to on its own. The expected values here used
    # to be cardboard's reference bytes, which stopped being what light mode
    # ships the moment it had to be legible; comparing against the shared mode
    # itself is what these tests were always checking.
    SHARED = build_palette(load_setup_toml(THEME_DIR / "setups" / "end4.toml"), "light")

    def build_light(self, extra: str = "") -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "probe.toml"
            path.write_text(self.BASE + extra)
            return build_palette(load_setup_toml(path), "light")

    def test_a_setup_with_no_light_table_gets_the_shared_one_whole(self):
        self.assertEqual(self.build_light()["bg"], self.SHARED["bg"])
        self.assertEqual(self.build_light()["palette"], self.SHARED["palette"])

    def test_every_shipped_setup_gets_the_same_light_mode(self):
        built = [build_palette(s, "light") for s in SHIPPED_SETUPS.values()]
        self.assertGreater(len(built), 1)
        for other in built[1:]:
            self.assertEqual(other["palette"], built[0]["palette"])
            self.assertEqual((other["bg"], other["fg"]), (built[0]["bg"], built[0]["fg"]))

    def test_a_setup_key_overrides_the_shared_one(self):
        got = self.build_light("\n[light]\nbg = 0.93\n")
        self.assertAlmostEqual(hex_to_oklch(got["bg"])[0], 0.93, delta=0.01)
        self.assertEqual(got["fg"], self.SHARED["fg"])  # the rest still shared

    def test_a_setup_accent_overrides_one_shared_slot_and_leaves_the_rest(self):
        got = self.build_light("\n[light.accents]\n1 = [0.441, 0.095, 31.0]\n")["palette"]
        self.assertEqual(got[1], oklch_to_hex(0.441, 0.095, 31.0))
        for slot in (2, 3, 4, 5, 6, 10, 11, 12, 13, 14):
            with self.subTest(slot=slot):
                self.assertEqual(got[slot], self.SHARED["palette"][slot])


class TwoHueFamilyTest(unittest.TestCase):
    """`text_seed`: the ink's hue, when it is not the paper's."""

    def test_a_mode_puts_surfaces_and_text_on_the_hues_it_declared(self):
        paper, ink = "#e5dfd3", "#4a5353"  # 112 degrees apart: one seed cannot hold both
        setup = dict(SHIPPED_SETUPS["end4"])
        setup["light"] = {
            **setup["light"],
            "seed": paper, "text_seed": ink, "tint": 0.0174, "text_tint": 0.0115,
            "cursor_tint": 0.0115, "bg": 0.905, "surface": 0.838, "selection": 0.771,
            "accent": 0.441, "accent_chroma": 0.095, "fg": 0.339, "strong": 0.290,
        }
        built = build_palette(setup, "light")
        paper_hue, ink_hue = hex_to_oklch(paper)[2], hex_to_oklch(ink)[2]
        self.assertGreater(hue_gap(paper_hue, ink_hue), 100.0)  # why the key exists
        for slot in ("bg", "selection_bg"):
            self.assertLess(hue_gap(hex_to_oklch(built[slot])[2], paper_hue), 2.0)
        self.assertLess(hue_gap(hex_to_oklch(built["palette"][0])[2], paper_hue), 2.0)
        for slot in (7, 8, 15):
            with self.subTest(slot=slot):
                self.assertLess(hue_gap(hex_to_oklch(built["palette"][slot])[2], ink_hue), 2.0)

    def test_text_seed_defaults_to_seed_so_a_one_hue_theme_is_unchanged(self):
        setup = dict(SHIPPED_SETUPS["end4"])
        with_default = build_palette(setup, "dark")
        setup["dark"] = {**setup["dark"], "text_seed": setup["seed"]}
        self.assertEqual(build_palette(setup, "dark")["palette"], with_default["palette"])


class PaperAndInkTest(unittest.TestCase):
    """theme/light.toml: pure white paper, near-black ink, hueless greys and
    saturated accents. See the header of that file for the numbers."""

    def setUp(self):
        self.built = build_palette(SHIPPED_SETUPS["end4"], "light")

    def test_the_paper_is_pure_white(self):
        self.assertEqual(self.built["bg"], "#ffffff")

    def test_the_ink_is_near_black_and_bold_is_black(self):
        """fg stops short of black so `strong` has a darker step left."""
        self.assertEqual(self.built["fg"], "#1a1a1a")
        self.assertEqual(self.built["palette"][15], "#000000")

    def test_every_grey_is_a_pure_grey(self):
        greys = [self.built["bg"], self.built["fg"], self.built["selection_bg"],
                 self.built["cursor"], self.built["cursor_text"]]
        greys += [self.built["palette"][slot] for slot in (0, 7, 8, 15)]
        for hexval in greys:
            with self.subTest(hex=hexval):
                r, g, b = hexval[1:3], hexval[3:5], hexval[5:7]
                self.assertTrue(r == g == b, f"{hexval} carries a hue")

    def test_the_accents_are_saturated_not_muted(self):
        """Red, green, blue and magenta at least 1.5x the old muted 0.095.
        Yellow and cyan reach the sRGB gamut edge at this lightness, about
        0.1 and 0.08, so they are bounded by the gamut, not by this file."""
        for slot in (1, 2, 4, 5):
            with self.subTest(slot=slot):
                self.assertGreater(hex_to_oklch(self.built["palette"][slot])[1], 0.15)

    def test_a_bright_slot_is_darker_than_its_base(self):
        """On paper emphasis is darker."""
        for slot in (1, 2, 3, 4, 5, 6):
            with self.subTest(slot=slot):
                base = hex_to_oklch(self.built["palette"][slot])[0]
                bright = hex_to_oklch(self.built["palette"][slot + 8])[0]
                self.assertLess(bright, base)

    def test_the_cursor_is_black_reversed_out_to_white(self):
        self.assertEqual(self.built["cursor"], "#000000")
        self.assertEqual(self.built["cursor_text"], "#ffffff")

    def test_the_text_tiers_run_in_order_from_the_page(self):
        bg = self.built["bg"]
        ratios = [
            wcag_contrast_ratio(self.built["palette"][8], bg),   # dim
            wcag_contrast_ratio(self.built["palette"][7], bg),   # muted
            wcag_contrast_ratio(self.built["fg"], bg),           # fg
            wcag_contrast_ratio(self.built["palette"][15], bg),  # strong
        ]
        self.assertEqual(ratios, sorted(ratios), f"text tiers out of order: {ratios}")


class WallpaperTest(unittest.TestCase):
    """Every wallpaper any setup names, in either mode, exists.

    This used to check one setup in one mode, which is no check at all: the
    file a setup names is resolved at apply time, so a missing one is a
    SystemExit in the middle of a theme switch -- after the Ghostty themes are
    written and before the consumers reload. Every setup x mode pair, so
    deleting a wallpaper fails here rather than there.

    Resolved by bin/theme's own wallpaper_file, so this checks the path apply
    will open. Images are vendored in theme/wallpapers/; videos live in
    ~/Pictures/wallpapers, so on a machine without them this fails -- which is
    true, because apply would stop there too.
    """

    def test_every_wallpaper_a_setup_names_exists(self):
        for name, setup in SHIPPED_SETUPS.items():
            for mode in ("dark", "light"):
                choice = setup.get(mode, {}).get("wallpaper", setup.get("wallpaper"))
                if choice is None or choice == "auto":
                    continue  # no key leaves the desktop alone; auto is rendered
                with self.subTest(setup=name, mode=mode):
                    file = wallpaper_file(name, setup, mode)
                    self.assertTrue(file.exists(), f"{name} [{mode}] names missing {file}")

    def test_a_wallpaper_path_resolves_the_way_the_readme_says(self):
        def resolve(choice):
            return wallpaper_file("t", {"dark": {"wallpaper": choice}}, "dark")

        self.assertEqual(resolve("ventertal.jpg"), THEME_DIR / "wallpapers" / "ventertal.jpg")
        self.assertEqual(resolve("~/Pictures/w/night.mov"), Path.home() / "Pictures" / "w" / "night.mov")
        self.assertEqual(resolve("/abs/day.mp4"), Path("/abs/day.mp4"))
        self.assertEqual(resolve("auto").name, "t-dark.png")
        self.assertIsNone(wallpaper_file("t", {}, "dark"))


class ExplicitAccentTest(unittest.TestCase):
    def test_hex_survives_a_round_trip_through_oklch(self):
        """Why [MODE.accents] can be exact: the conversion loses nothing."""
        for hexval in ROUND_TRIP_SAMPLES:
            with self.subTest(hex=hexval):
                self.assertEqual(oklch_to_hex(*hex_to_oklch(hexval)), hexval)

    def test_a_bright_slot_may_be_pinned_instead_of_derived(self):
        setup = dict(SHIPPED_SETUPS["end4"])
        setup["dark"] = {**setup["dark"], "accents": {**setup["dark"]["accents"], "9": [0.82, 0.14, 315.0]}}
        self.assertEqual(build_palette(setup, "dark")["palette"][9], oklch_to_hex(0.82, 0.14, 315.0))

    def test_a_slot_that_is_not_an_accent_is_refused(self):
        for slot in ("0", "7", "8", "15", "16"):
            with self.subTest(slot=slot):
                setup = dict(SHIPPED_SETUPS["end4"])
                setup["dark"] = {**setup["dark"], "accents": {slot: [0.5, 0.05, 10.0]}}
                with self.assertRaises(ValueError):
                    build_palette(setup, "dark")


if __name__ == "__main__":
    unittest.main()
