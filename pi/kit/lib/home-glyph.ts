/**
 * The Koenigsegg ghost, printed where a path would otherwise say `~`.
 *
 * U+100000 is a private-use codepoint: it means nothing until a font gives it a
 * shape. Ghostty does that with `font-codepoint-map = U+100000=Ghost Insignia`
 * in `ghostty/config`, pointing at the one-glyph font that
 * `bin/build-ghost-font.py` installs to `~/Library/Fonts/GhostInsignia.ttf`.
 *
 * Two rules follow from that, and they are the whole reason this is a constant
 * rather than a literal:
 *
 * 1. **Rendered labels only.** Anywhere else — a path copied into a shell, a
 *    file that gets written, anything sent to a model — the character has to
 *    stay a real `~`, because outside this terminal it is an empty box, and
 *    outside this display it is not a home directory to anyone.
 * 2. **It measures one column**, exactly like the tilde it replaces, so no
 *    width arithmetic changes. `visibleWidth` reads it as 1, Ghostty draws it
 *    in one cell, and the two agree.
 */
export const HOME_GLYPH = "\u{100000}";
