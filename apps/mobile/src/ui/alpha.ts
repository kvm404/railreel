/**
 * `#RRGGBB` token → `rgba(...)` at the given alpha. Translucent washes (glass chrome, selected
 * tints, curtain gradients) are derived from palette tokens through this instead of being
 * hand-typed as literals, so a palette change carries through to them.
 */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1]!, 16)
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}
