// A restrained CRT treatment with a quiet top-to-bottom rainbow for text.
// Ghostty supplies iChannel0, iResolution, and the main() wrapper.

const float PI = 3.14159265359;
const float VIGNETTE = 0.10;
const float SCANLINE_DEPTH = 0.018;
const float PHOSPHOR_GAIN = 0.018;

// Dark mode is the approved appearance. Keep these values unchanged.
const float DARK_RAINBOW_SATURATION = 0.32;
const float DARK_RAINBOW_STRENGTH = 0.72;

// Light mode runs the identical formula, so only saturation and strength differ.
// Saturation is the knob if edges ever look thick: the tint is a multiply, so a
// heavily saturated hue drags luminance further from the source than a pale one.
// Dark mode gets away with vivid-looking text precisely because 0.32 barely
// moves luminance at all.
const float LIGHT_RAINBOW_SATURATION = 1.00;
// 0.0: light mode is grey glass with untouched text (see themes/jarvis-white).
const float LIGHT_RAINBOW_STRENGTH = 0.00;

// How dark a pixel must be to count as ink. The old 0.30/0.78 window was set
// when this branch had never actually run, and it throttled the tint hard: the
// foreground #000C6B has a sourceValue of 0.42, which sits inside that ramp and
// so scored only 0.84 before `detail` cut it further. 0.55/0.95 scores it a
// full 1.0 while still excluding the white background at 1.0 outright.
const float LIGHT_INK_LO = 0.55;
const float LIGHT_INK_HI = 0.95;

// Flat fills (block backgrounds, selection highlights, the terminal background
// itself) used to soak up the rainbow, which turned whole output blocks pink or
// mint. Glyph strokes are thin, so they show a large luminance swing across a
// couple of pixels; a filled panel shows none. Tint only where that swing is.
// Radius stays at one pixel: reaching further colored the pixels *beside* a
// glyph too, which read as a blurry halo rather than colored text.
// Dark mode stays at one pixel: there, bright glyphs and bright flat fills are
// only told apart by this edge test, and reaching further tinted the pixels
// BESIDE a glyph, which read as a blurry halo.
//
// Light mode can afford to reach further, and has to. Its mask already throws
// away everything bright -- the white background included -- so a wider radius
// cannot produce that halo here; the pixels it would have bled onto are white
// and excluded anyway. At radius 1 the interior of every stroke scored 0 and
// stayed untinted navy, so only the antialiased rim took any colour at all.
const float DETAIL_RADIUS_DARK = 1.0;
const float DETAIL_RADIUS_LIGHT = 3.0;
const float DETAIL_FLOOR = 0.12;
const float DETAIL_CEILING = 0.34;

float luma(vec3 rgb) {
    return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}

// Ghostty's iBackgroundColor uniform can lag a live theme switch, leaving this
// shader running dark-mode maths on a white screen: dark mode keys its mask on
// BRIGHT pixels, so on white it tints the antialiasing ring around each glyph
// and leaves the dark glyph itself alone -- a coloured fringe and no coloured
// text. Read the background off the frame instead. The window padding in all
// four corners is always background, and taking the median of four samples
// ignores a star or a stray glyph intruding on any single one.
float backgroundLuma() {
    vec2 p = vec2(2.5) / iResolution.xy;
    float a = luma(texture(iChannel0, vec2(p.x, p.y)).rgb);
    float b = luma(texture(iChannel0, vec2(1.0 - p.x, p.y)).rgb);
    float c = luma(texture(iChannel0, vec2(p.x, 1.0 - p.y)).rgb);
    float d = luma(texture(iChannel0, vec2(1.0 - p.x, 1.0 - p.y)).rgb);
    float lo = min(min(a, b), min(c, d));
    float hi = max(max(a, b), max(c, d));
    return (a + b + c + d - lo - hi) * 0.5;
}

// 1.0 on glyph edges, 0.0 on anything flat.
float detailAmount(vec2 fragCoord, float radius) {
    vec2 texel = radius / iResolution.xy;
    vec2 uv = fragCoord / iResolution.xy;

    float here = luma(texture(iChannel0, uv).rgb);
    float lo = here;
    float hi = here;

    for (int i = 0; i < 4; i++) {
        vec2 offset = vec2(
            i == 0 ? -1.0 : (i == 1 ? 1.0 : 0.0),
            i == 2 ? -1.0 : (i == 3 ? 1.0 : 0.0)
        ) * texel;
        float neighbour = luma(texture(iChannel0, uv + offset).rgb);
        lo = min(lo, neighbour);
        hi = max(hi, neighbour);
    }

    return smoothstep(DETAIL_FLOOR, DETAIL_CEILING, hi - lo);
}

vec3 hsvToRgb(vec3 hsv) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(hsv.xxx + K.xyz) * 6.0 - K.www);
    return hsv.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), hsv.y);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 position = fragCoord / iResolution.xy * 2.0 - 1.0;

    // No barrel curvature. The image is sampled straight, so what you see sits
    // exactly where the mouse lands. Bending the picture did not bend the
    // cursor, so clicks near the edges (the tab bar above all) missed.
    vec4 color = texture(iChannel0, fragCoord / iResolution.xy);

    // Measured, not asked for -- see backgroundLuma above. White lands near
    // 1.0 and Rose Pine Moon's #232136 near 0.14, so 0.55 has margin either
    // way, premultiplied alpha included.
    bool lightMode = backgroundLuma() > 0.55;

    // Light mode gets NO shader: plain white, plain text, nothing on top.
    // Ghostty cannot switch custom-shader per theme, so pass through here.
    if (lightMode) {
        fragColor = color;
        return;
    }

    // Run one hue cycle from rose at the top through warm, green, blue,
    // and violet tones toward the bottom.
    float topToBottom = 1.0 - clamp(fragCoord.y / iResolution.y, 0.0, 1.0);
    float hue = fract(0.98 + topToBottom * 0.82);
    float sourceValue = max(max(color.r, color.g), color.b);
    float detail = detailAmount(
        fragCoord,
        lightMode ? DETAIL_RADIUS_LIGHT : DETAIL_RADIUS_DARK
    );

    if (lightMode) {
        // Same maths as the dark branch below; only the mask is inverted,
        // because on a light background the glyphs are the DARK pixels.
        //
        // The `rainbow * sourceValue` is the part that matters. Scaling the
        // tint by the pixel's own brightness means an antialiased pixel takes
        // an equally faint tint, so a glyph's edge ramp comes out the far side
        // unchanged. This used to mix toward a FLAT colour of fixed value 0.50
        // instead, which lifted the dark end of every ramp up to that one value
        // and flattened it -- glyphs read soft and smeared. Tying the tint to
        // the source makes that impossible rather than merely tuned away.
        float textMask = (1.0 - smoothstep(LIGHT_INK_LO, LIGHT_INK_HI, sourceValue)) * detail;
        vec3 rainbow = hsvToRgb(vec3(hue, LIGHT_RAINBOW_SATURATION, 1.0));
        vec3 tintedText = rainbow * sourceValue;
        color.rgb = mix(
            color.rgb,
            tintedText,
            textMask * LIGHT_RAINBOW_STRENGTH
        );
    } else {
        vec3 rainbow = hsvToRgb(vec3(hue, DARK_RAINBOW_SATURATION, 1.0));
        float textMask = smoothstep(0.24, 0.72, sourceValue) * detail;
        vec3 tintedText = rainbow * sourceValue;
        color.rgb = mix(
            color.rgb,
            tintedText,
            textMask * DARK_RAINBOW_STRENGTH
        );
    }

    float vignette = 1.0 - VIGNETTE
        * smoothstep(0.45, 1.25, dot(position, position));
    float scanlines = 1.0 - SCANLINE_DEPTH
        * (0.5 + 0.5 * sin(fragCoord.y * PI));
    float luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    float phosphor = 1.0 + PHOSPHOR_GAIN
        * smoothstep(0.35, 0.95, luminance);

    color.rgb *= vignette * scanlines * phosphor;
    fragColor = color;
}
