import { describe, it, expect } from 'vitest'
import {
  captionFloor,
  playerLayout,
  railWidth,
  reactionLanes,
  LANE_STEP_Y,
  MIN_RISE,
  RAIL_KEY_MIN,
  SIDE_MIN,
  SPARK_H,
  TICKER_MIN_W,
  TOP_FADE,
  type PlayerLayout,
  type PlayerLayoutInput,
} from '@/lib/player/layout'

const portrait: PlayerLayoutInput = {
  width: 360,
  height: 760,
  insets: { top: 24, bottom: 16, left: 0, right: 0 },
  bottomCurtainHeight: 200,
  topCurtainHeight: 24 + 10 + 48 + TOP_FADE,
  captionsOn: true,
}
const landscape: PlayerLayoutInput = {
  width: 760,
  height: 360,
  insets: { top: 0, bottom: 0, left: 32, right: 0 }, // a cutout on the left
  bottomCurtainHeight: 130,
  topCurtainHeight: 10 + 48 + TOP_FADE,
  captionsOn: true,
}
const small: PlayerLayoutInput = {
  width: 360,
  height: 640,
  insets: { top: 24, bottom: 0, left: 0, right: 0 },
  bottomCurtainHeight: 234, // host: notice + rail + filament + transport
  topCurtainHeight: 24 + 10 + 48 + TOP_FADE,
  captionsOn: true,
}

/**
 * Nothing in the social band may cross the top edge of its state: the top curtain's controls
 * (open) or the safe top (hidden). Checks the highest point every layer can reach.
 */
function expectBandFits(i: PlayerLayoutInput, l: PlayerLayout) {
  for (const open of [true, false]) {
    const b = open ? l.social.open : l.social.closed
    const topEdge = open ? l.bannerTop : i.insets.top + SIDE_MIN
    const start = l.socialBottom + (open ? l.lift : 0)
    const ceiling = i.height - topEdge
    if (b.ticker) expect(start + b.tickerMaxHeight).toBeLessThanOrEqual(ceiling)
    if (b.reactions) {
      const stack = b.reactions.axis === 'vertical' ? (b.reactions.count - 1) * LANE_STEP_Y : 0
      expect(start + stack + SPARK_H + b.reactions.rise).toBeLessThanOrEqual(ceiling)
      expect(i.width - l.sideLeft - b.tickerRight).toBeGreaterThanOrEqual(TICKER_MIN_W)
    }
  }
  // the captions themselves sit clear of the open bottom curtain
  if (i.bottomCurtainHeight > 0) expect(l.captionBottom + l.lift).toBeGreaterThanOrEqual(i.bottomCurtainHeight)
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
    expect(off.captionReserve).toBe(0)
  })

  it('reserves the MEASURED caption block when it outgrows two lines', () => {
    const base = playerLayout(portrait)
    expect(base.captionReserve).toBeGreaterThan(captionFloor())
    const tall = playerLayout({ ...portrait, captionHeight: 140 }) // three lines + an overlapping cue
    expect(tall.captionReserve).toBeGreaterThan(140)
    expect(tall.socialBottom).toBeGreaterThan(base.socialBottom)
    // a short block never shrinks the reservation below the two-line floor (no jitter)
    expect(playerLayout({ ...portrait, captionHeight: 30 }).captionReserve).toBe(base.captionReserve)
    // a block exactly at the floor needs no report (the Player skips it)
    expect(playerLayout({ ...portrait, captionHeight: captionFloor() }).captionReserve).toBe(base.captionReserve)
  })

  it('grows the caption floor with the OS text scale', () => {
    expect(captionFloor(1.3)).toBeGreaterThan(captionFloor(1))
    expect(playerLayout({ ...portrait, fontScale: 1.3 }).captionReserve).toBeGreaterThan(playerLayout(portrait).captionReserve)
  })

  it('hangs banners below the measured top curtain controls, not a fixed guess', () => {
    const l = playerLayout(portrait)
    expect(l.bannerTop).toBeGreaterThan(portrait.topCurtainHeight! - TOP_FADE)
    // enlarged title text grows the curtain → the banner moves down with it
    const big = playerLayout({ ...portrait, topCurtainHeight: portrait.topCurtainHeight! + 30 })
    expect(big.bannerTop).toBe(l.bannerTop + 30)
    // before measurement: a safe fallback below a 48dp control row
    expect(playerLayout({ ...portrait, topCurtainHeight: 0 }).bannerTop).toBeGreaterThanOrEqual(24 + 10 + 48)
  })

  it('respects landscape cutouts and shares the bottom row in wide layouts', () => {
    const l = playerLayout(landscape)
    expect(l.wide).toBe(true)
    expect(l.sideLeft).toBe(32)
    expect(l.sideRight).toBe(16)
    expect(railWidth(l.railKey)).toBeLessThanOrEqual((760 - 32 - 16) / 2)
  })

  it('keeps the chat ticker readable on a 360×760 phone with the host curtain open', () => {
    // the review case: captions on + a 234dp host curtain left 72dp of ticker before
    const l = playerLayout({ ...portrait, bottomCurtainHeight: 234 })
    expect(l.social.open.reactions?.axis).toBe('vertical') // shortened rise, not a sideways sprawl
    expect(l.social.open.reactions!.rise).toBeGreaterThan(0)
    expect(360 - l.sideLeft - l.social.open.tickerRight).toBeGreaterThanOrEqual(TICKER_MIN_W)
  })

  describe('one vertical budget', () => {
    it('portrait 360×760: everything fits, open and hidden', () => {
      const l = playerLayout(portrait)
      expectBandFits(portrait, l)
      expect(l.social.open.reactions).not.toBeNull()
      expect(l.social.closed.reactions).not.toBeNull()
    })

    it('landscape 760×360: reactions give way while the chrome is open, return when it hides', () => {
      const l = playerLayout(landscape)
      expectBandFits(landscape, l)
      expect(l.social.open.reactions).toBeNull() // no room between the captions and the header
      expect(l.social.open.ticker).toBe(true) // but the chat still gets its lines (clipped)
      expect(l.social.closed.reactions?.axis).toBe('sideways')
      expect(760 - l.sideLeft - l.social.closed.tickerRight).toBeGreaterThanOrEqual(TICKER_MIN_W)
    })

    it('landscape 760×360 with a holding notice and a tall caption: the ticker goes too', () => {
      const crowded = { ...landscape, bottomCurtainHeight: 190, captionHeight: 110 }
      const l = playerLayout(crowded)
      expectBandFits(crowded, l)
      expect(l.social.open.ticker).toBe(false)
      expect(l.social.open.reactions).toBeNull()
    })

    it('small portrait 360×640 with the host curtain: fits, and gives way under large text', () => {
      const l = playerLayout(small)
      expectBandFits(small, l)
      const big = { ...small, fontScale: 1.5, captionHeight: 150, topCurtainHeight: small.topCurtainHeight! + 24 }
      const lb = playerLayout(big)
      expectBandFits(big, lb)
      expect(lb.social.open.room).toBeLessThan(l.social.open.room)
    })
  })
})

describe('reactionLanes', () => {
  it('spreads sideways only as far as the ticker allows', () => {
    const tight = reactionLanes(SPARK_H + MIN_RISE + 20, 360)
    expect(tight?.axis).toBe('sideways')
    expect(tight!.count).toBeLessThan(4)
    expect(360 - tight!.span - 8).toBeGreaterThanOrEqual(TICKER_MIN_W)
  })

  it('never lets a spark travel past the room it was given', () => {
    for (const room of [110, 150, 200, 260, 300, 400]) {
      const lanes = reactionLanes(room, 700)
      if (!lanes) continue
      const stack = lanes.axis === 'vertical' ? (lanes.count - 1) * LANE_STEP_Y : 0
      expect(stack + SPARK_H + lanes.rise).toBeLessThanOrEqual(room)
    }
  })

  it('has no lanes at all when even one short spark would not fit', () => {
    expect(reactionLanes(SPARK_H + MIN_RISE - 1, 700)).toBeNull()
    expect(reactionLanes(0, 700)).toBeNull()
  })
})
