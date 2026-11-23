import { describe, it, expect } from 'vitest'
import { palette } from '@/theme/tokens'
import { RAIL_BACKING_ALPHA, RAIL_IDLE_OPACITY } from '@/lib/player/rail'

type RGB = [number, number, number]
const rgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB
const mix = (fg: RGB, a: number, bg: RGB): RGB => [0, 1, 2].map((k) => fg[k]! * a + bg[k]! * (1 - a)) as RGB
function luminance(c: RGB): number {
  const [r, g, b] = c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

// The worst footage for light glyphs: a white frame. (Dark footage only helps.)
const footage = rgb(palette.white)
const backing = mix(rgb(palette.raised), RAIL_BACKING_ALPHA, footage)

describe('reaction rail contrast over bright footage', () => {
  it('keeps the idle chat glyph ≥ 4.5:1', () => {
    expect(contrast(mix(rgb(palette.textPrimary), RAIL_IDLE_OPACITY, backing), backing)).toBeGreaterThanOrEqual(4.5)
  })
  it('keeps the idle unread (amber) chat glyph ≥ 4.5:1', () => {
    expect(contrast(mix(rgb(palette.amber), RAIL_IDLE_OPACITY, backing), backing)).toBeGreaterThanOrEqual(4.5)
  })
  it('keeps the never-dimmed unread badge legible and distinct from the backing', () => {
    expect(contrast(rgb(palette.onAmber), rgb(palette.amber))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(rgb(palette.amber), backing)).toBeGreaterThanOrEqual(3)
  })
  it('was the bug: dimming the whole rail to 45% dropped the glyph near 2:1', () => {
    const oldBacking = mix(rgb(palette.raised), 0.78 * 0.45, footage)
    const oldIcon = mix(rgb(palette.textPrimary), 0.45, oldBacking)
    expect(contrast(oldIcon, oldBacking)).toBeLessThan(3)
  })
})
