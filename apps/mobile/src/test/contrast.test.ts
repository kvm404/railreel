import { describe, it, expect } from 'vitest'
import { palette, veils } from '@/theme/tokens'
import { ghostSkins } from '@/theme/buttonSkins'
import { TONE_COLOR } from '@/theme/tones'

/** WCAG 2.x relative luminance / contrast ratio. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
type RGB = [number, number, number]
function toRgb(hex: string): RGB {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB
}
const toHex = (c: RGB) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
/** Source-over composite of an `rgba(r,g,b,a)` veil on an opaque hex background. */
function over(veil: string, bgHex: string): string {
  const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(veil)
  if (!m) throw new Error(`not an rgba(): ${veil}`)
  const [r, g, b, a] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  const bg = toRgb(bgHex)
  return toHex([r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)])
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

const SURFACES = { base: palette.base, raised: palette.raised, overlay: palette.overlay } as const

describe('palette contrast (WCAG AA for normal text = 4.5:1)', () => {
  for (const [name, bg] of Object.entries(SURFACES)) {
    it(`textMuted passes on ${name}`, () => {
      expect(contrast(palette.textMuted, bg)).toBeGreaterThanOrEqual(4.5)
    })
    it(`textSecondary and textPrimary pass on ${name}`, () => {
      expect(contrast(palette.textSecondary, bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.textPrimary, bg)).toBeGreaterThanOrEqual(4.5)
    })
    it(`amber, cyan and danger text pass on ${name}`, () => {
      expect(contrast(palette.amber, bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.cyan, bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.danger, bg)).toBeGreaterThanOrEqual(4.5)
    })
  }

  it('onAmber text passes on both ends of the amber fill', () => {
    expect(contrast(palette.onAmber, palette.amber)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(palette.onAmber, palette.amberCore)).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps hierarchy: muted sits between secondary and the decorative dim value', () => {
    expect(contrast(palette.textMuted, palette.raised)).toBeLessThan(contrast(palette.textSecondary, palette.raised))
    expect(contrast(palette.textMuted, palette.raised)).toBeGreaterThan(contrast(palette.textTertiary, palette.raised))
  })

  it('documents why textTertiary is decorative-only: it fails AA on every surface', () => {
    for (const bg of Object.values(SURFACES)) expect(contrast(palette.textTertiary, bg)).toBeLessThan(4.5)
  })

  it('the QR field is a high-contrast scan target (dark modules on the warm ticket)', () => {
    expect(contrast(palette.base, palette.ticket)).toBeGreaterThanOrEqual(12)
  })

  // Buttons sit on translucent tints, so text must be checked against the COMPOSITED background
  // (surface + tint, and surface + tint + press veil) — not the bare surface.
  describe('ghost buttons on composited backgrounds', () => {
    const surfaces = { void: palette.void, ...SURFACES }
    for (const [intent, skin] of Object.entries(ghostSkins)) {
      for (const [surfaceName, surface] of Object.entries(surfaces)) {
        const rest = over(veils[skin.bg], surface)
        const pressed = over(veils[skin.pressed], rest)
        for (const [state, bg] of [['rest', rest], ['pressed', pressed]] as const) {
          it(`${intent} title + subtitle pass on ${surfaceName} (${state})`, () => {
            expect(contrast(palette[TONE_COLOR[skin.title]], bg)).toBeGreaterThanOrEqual(4.5)
            expect(contrast(palette[TONE_COLOR[skin.subtitle]], bg)).toBeGreaterThanOrEqual(4.5)
          })
        }
      }
    }
  })

  it('amber button text passes at rest and under the press veil', () => {
    for (const fill of [palette.amber, palette.amberCore]) {
      expect(contrast(palette.onAmber, fill)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.onAmber, over(veils.buttonEdge, fill))).toBeGreaterThanOrEqual(4.5)
    }
  })
})
