import { describe, it, expect } from 'vitest'
import { fractionLeft, secondsLeft } from '@/lib/social/countdown'

describe('secondsLeft', () => {
  it('counts down from the arrival time, not from when it is asked', () => {
    expect(secondsLeft(1_000, 1_000, 10_000)).toBe(10)
    expect(secondsLeft(1_000, 4_200, 10_000)).toBe(7) // 6.8s left → shows 7
    expect(secondsLeft(1_000, 10_999, 10_000)).toBe(1) // last sliver still reads 1s
  })

  it('is stable across repeated reads at the same instant (a re-render cannot reset it)', () => {
    const reads = [0, 1, 2].map(() => secondsLeft(5_000, 9_000, 10_000))
    expect(reads).toEqual([6, 6, 6])
  })

  it('bottoms out at zero once the window has passed', () => {
    expect(secondsLeft(1_000, 11_000, 10_000)).toBe(0)
    expect(secondsLeft(1_000, 99_000, 10_000)).toBe(0)
  })

  it('treats non-finite input as expired', () => {
    expect(secondsLeft(NaN, 1_000, 10_000)).toBe(0)
    expect(secondsLeft(1_000, NaN, 10_000)).toBe(0)
  })
})

describe('fractionLeft', () => {
  it('drains linearly and clamps to 0..1', () => {
    expect(fractionLeft(0, 0, 10_000)).toBe(1)
    expect(fractionLeft(0, 2_500, 10_000)).toBeCloseTo(0.75, 6)
    expect(fractionLeft(0, 20_000, 10_000)).toBe(0)
    expect(fractionLeft(5_000, 0, 10_000)).toBe(1) // clock skew can't overfill it
    expect(fractionLeft(0, 0, 0)).toBe(0)
  })
})
