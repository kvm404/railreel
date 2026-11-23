import { describe, it, expect } from 'vitest'
import {
  playerLayout,
  railWidth,
  reactionLanes,
  RAIL_KEY_MIN,
  TICKER_MIN_W,
  type PlayerLayoutInput,
} from '@/lib/player/layout'

const portrait: PlayerLayoutInput = {
  width: 360,
  height: 760,
  insets: { top: 24, bottom: 16, left: 0, right: 0 },
  bottomCurtainHeight: 200,
  captionsOn: true,
}
const landscape: PlayerLayoutInput = {
  width: 760,
  height: 360,
  insets: { top: 0, bottom: 0, left: 32, right: 0 }, // a cutout on the left
  bottomCurtainHeight: 130,
  captionsOn: true,
}

describe('playerLayout', () => {
  it('fits the reaction rail on a 360dp phone with ≥44dp keys', () => {
    const l = playerLayout(portrait)
    expect(l.railKey).toBeGreaterThanOrEqual(RAIL_KEY_MIN)
    expect(railWidth(l.railKey)).toBeLessThanOrEqual(360 - l.sideLeft - l.sideRight)
  })

  it('never shrinks rail keys below the touch floor, even on a very narrow screen', () => {
    expect(playerLayout({ ...portrait, width: 280 }).railKey).toBe(RAIL_KEY_MIN)
  })

  it('lifts captions exactly clear of the open bottom curtain', () => {
    const l = playerLayout(portrait)
    expect(l.captionBottom + l.lift).toBeGreaterThanOrEqual(portrait.bottomCurtainHeight)
  })

  it('does not lift before the curtain is measured', () => {
    expect(playerLayout({ ...portrait, bottomCurtainHeight: 0 }).lift).toBe(0)
  })

  it('stacks the social band above the caption region only when captions are on', () => {
    const on = playerLayout(portrait)
    const off = playerLayout({ ...portrait, captionsOn: false })
    expect(on.socialBottom).toBeGreaterThan(on.captionBottom)
    expect(off.socialBottom).toBe(off.captionBottom)
  })

  it('respects landscape cutouts and shares the bottom row in wide layouts', () => {
    const l = playerLayout(landscape)
    expect(l.wide).toBe(true)
    expect(l.sideLeft).toBe(32)
    expect(l.sideRight).toBe(16)
    // the rail fits in its half of the row
    expect(railWidth(l.railKey)).toBeLessThanOrEqual((760 - 32 - 16) / 2)
  })

  it('keeps the chat ticker readable on a 360×760 phone with the host curtain open', () => {
    // the review case: captions on + a 234dp host curtain left 72dp of ticker before
    const l = playerLayout({ ...portrait, bottomCurtainHeight: 234 })
    expect(l.reactions.axis).toBe('vertical') // shortened rise, not a sideways sprawl
    expect(l.reactions.rise).toBeGreaterThan(0)
    expect(360 - l.sideLeft - l.tickerRight).toBeGreaterThanOrEqual(TICKER_MIN_W)
  })

  it('spreads reactions sideways in landscape only as far as the ticker allows', () => {
    const l = playerLayout(landscape)
    expect(l.reactions.axis).toBe('sideways')
    expect(760 - l.sideLeft - l.tickerRight).toBeGreaterThanOrEqual(TICKER_MIN_W)
    // a short AND narrow viewport gives up lanes rather than the ticker
    const tight = reactionLanes(80, 360)
    expect(tight.axis).toBe('sideways')
    expect(tight.count).toBeLessThan(4)
    expect(360 - tight.span - 8).toBeGreaterThanOrEqual(TICKER_MIN_W)
  })

  it('reports little vertical room for reactions in landscape (they go sideways)', () => {
    const l = playerLayout(landscape)
    expect(l.reactionRoom).toBeLessThan(playerLayout(portrait).reactionRoom)
    expect(l.reactionRoom).toBeGreaterThanOrEqual(0)
  })
})
