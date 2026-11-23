import { describe, it, expect } from 'vitest'
import { BOTTOM_PAD, CLOSE_STRIP, RETICLE_MAX, RETICLE_MIN, SCANNER_GAP, scannerReticle } from '@/lib/layout/scanner'

const portrait = { width: 360, height: 760, insets: { top: 24, bottom: 16, left: 0, right: 0 } }
const landscape = { width: 760, height: 360, insets: { top: 0, bottom: 0, left: 32, right: 0 } }

/** Everything stacked in the overlay must fit the window (inside the safe area). */
function stackHeight(reticle: number, hasAction: boolean, fontScale = 1) {
  const caption = Math.ceil(2 * 18 * fontScale + 16)
  return CLOSE_STRIP + reticle + SCANNER_GAP + caption + (hasAction ? SCANNER_GAP + 56 : 0) + BOTTOM_PAD
}

describe('scannerReticle', () => {
  it('uses the full reticle on a roomy portrait phone', () => {
    expect(scannerReticle({ ...portrait, hasAction: false })).toBe(RETICLE_MAX)
  })

  it('shrinks the reticle in landscape so the instruction stays on screen', () => {
    const r = scannerReticle({ ...landscape, hasAction: false })
    expect(r).toBeLessThan(RETICLE_MAX)
    expect(stackHeight(r, false)).toBeLessThanOrEqual(360)
  })

  it('reserves the action button (Scan again) before sizing the reticle', () => {
    const without = scannerReticle({ ...landscape, hasAction: false })
    const withAction = scannerReticle({ ...landscape, hasAction: true })
    expect(withAction).toBeLessThan(without)
    expect(stackHeight(withAction, true)).toBeLessThanOrEqual(360 + 8) // at the floor: scrolls the last few dp
  })

  it('accounts for enlarged text and never drops below a scannable floor', () => {
    const big = scannerReticle({ ...portrait, height: 480, fontScale: 1.5, hasAction: true })
    expect(stackHeight(big, true, 1.5)).toBeLessThanOrEqual(480)
    expect(scannerReticle({ ...landscape, height: 200, hasAction: true })).toBe(RETICLE_MIN)
  })

  it('stays inside a narrow split-screen width', () => {
    const r = scannerReticle({ width: 260, height: 700, insets: { top: 0, bottom: 0, left: 0, right: 0 }, hasAction: false })
    expect(r).toBeLessThanOrEqual(260 - 64)
  })
})
