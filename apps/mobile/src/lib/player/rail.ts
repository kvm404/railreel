/**
 * The reaction rail's idle dimming, as numbers the contrast test can hold to account. The rail
 * rides over arbitrary footage — worst case a white frame — so its controls stay legible through a
 * strong dark backing that never dims, and only the glyphs soften when idle. The unread badge
 * never dims at all. Verified ≥ 4.5:1 over white footage in src/test/railContrast.test.ts.
 */

/** Alpha of the rail's `raised` backing (constant — it is what keeps the glyphs readable). */
export const RAIL_BACKING_ALPHA = 0.9
/** Glyph opacity while the rail is idle (awake: 1). */
export const RAIL_IDLE_OPACITY = 0.75
/** The rail dims after this long without a touch. */
export const RAIL_IDLE_MS = 4000
