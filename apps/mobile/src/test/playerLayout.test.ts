import { describe, it, expect } from 'vitest'
import {
  captionBlockHeight,
  captionFloor,
  nextCompaction,
  playerLayout,
  CAPTION_CLEARANCE,
  COMPACT_CAPTIONS,
  COMPACT_CONTROLS,
  COMPACT_NOTICE,
  compactionKey,
  hostBannerQueue,
  type ChromeCompaction,
  type CompactionContext,
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
/** The lowest edge the host's banner stack reaches (0 when none) — it hangs in both chrome states. */
const bannerFloor = (i: PlayerLayoutInput, l: PlayerLayout) => (i.bannerHeight ? l.bannerTop + i.bannerHeight : 0)

function expectBandFits(i: PlayerLayoutInput, l: PlayerLayout) {
  for (const open of [true, false]) {
    const b = open ? l.social.open : l.social.closed
    const topEdge = Math.max(open ? l.bannerTop : i.insets.top + SIDE_MIN, bannerFloor(i, l))
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

/**
 * The caption invariant, computed independently of the layout's own captionTop: in both chrome
 * states the caption block's top edge stays below the top controls (+ clearance) and any banner.
 */
function expectCaptionsClear(i: PlayerLayoutInput, l: PlayerLayout) {
  const block = l.captionBlock
  const openTop = i.height - (l.captionBottom + l.lift) - block
  const closedTop = i.height - l.captionBottom - block
  expect(openTop).toBeGreaterThanOrEqual(l.topControlsBottom + CAPTION_CLEARANCE)
  expect(closedTop).toBeGreaterThanOrEqual(i.insets.top + SIDE_MIN)
  const bannerLow = bannerFloor(i, l)
  if (bannerLow > 0) {
    expect(openTop).toBeGreaterThan(bannerLow)
    expect(closedTop).toBeGreaterThan(bannerLow)
  }
  expect(l.captionOverflow).toBe(0)
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

    it('a join-request banner pushes the social band below it, chrome open and hidden', () => {
      const withBanner = { ...portrait, bannerHeight: 112 }
      const l = playerLayout(withBanner)
      const base = playerLayout(portrait)
      expectBandFits(withBanner, l)
      expect(l.social.open.room).toBeLessThan(base.social.open.room)
      expect(l.social.closed.room).toBeLessThan(base.social.closed.room)
      // landscape: a one-row banner over a crowded hold leaves no room for sparks at all
      const crowded = { ...landscape, bottomCurtainHeight: 190, bannerHeight: 60 }
      const lc = playerLayout(crowded)
      expectBandFits(crowded, lc)
      expect(lc.social.open.reactions).toBeNull()
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

describe('caption ceiling', () => {
  // The audit case: a holding notice grows the landscape curtain to 190dp and a long cue (or
  // enlarged text) measures 110dp — the caption top landed at 50dp under 58dp of top controls.
  const crowded: PlayerLayoutInput = { ...landscape, bottomCurtainHeight: 190, captionHeight: 110 }

  it('detects the crowded landscape collision instead of drawing captions over the header', () => {
    const l = playerLayout(crowded)
    expect(l.topControlsBottom).toBe(58)
    expect(l.captionTop.open).toBe(50)
    expect(l.captionOverflow).toBe(58 + CAPTION_CLEARANCE - 50)
    expect(nextCompaction(0, l.captionOverflow)).toBe(COMPACT_NOTICE)
  })

  it('crowded landscape: folding the notice into the controls row clears the header', () => {
    // compaction 'controls': the notice row (44 + 10 gap) leaves the curtain
    const folded = { ...crowded, bottomCurtainHeight: 190 - 54 }
    const l = playerLayout(folded)
    expectCaptionsClear(folded, l)
    expect(l.captionMaxLines).toBeUndefined() // the cue still renders in full
  })

  it('crowded landscape, last resort: the cue is capped at the lines that fit — and then fits', () => {
    const capped = { ...crowded, capCaptionLines: 'open' as const }
    const l = playerLayout(capped)
    expect(l.captionMaxLines).toBe(l.captionLines.open)
    expect(l.captionMaxLines).toBeGreaterThanOrEqual(1)
    expect(l.captionBlock).toBeLessThanOrEqual(captionBlockHeight(l.captionMaxLines!))
    expectCaptionsClear(capped, l)
    // the capped block, once rendered and reported, keeps fitting (no feedback into the cap)
    const reported = { ...capped, captionHeight: captionBlockHeight(l.captionMaxLines!) }
    const l2 = playerLayout(reported)
    expect(l2.captionMaxLines).toBe(l.captionMaxLines)
    expectCaptionsClear(reported, l2)
  })

  it('crowded landscape with the chrome hidden: plenty of lines once the curtain is away', () => {
    const l = playerLayout(crowded)
    expect(l.captionLines.closed).toBeGreaterThan(l.captionLines.open)
    expect(l.captionTop.closed).toBeGreaterThanOrEqual(l.captionCeiling.closed)
  })

  it('portrait 360×760 and 360×640: captions clear the header without any compaction', () => {
    expectCaptionsClear(portrait, playerLayout(portrait))
    const tallCue = { ...portrait, bottomCurtainHeight: 234, captionHeight: 140 }
    expectCaptionsClear(tallCue, playerLayout(tallCue))
    const big = { ...small, fontScale: 1.5, captionHeight: 150, topCurtainHeight: small.topCurtainHeight! + 24 }
    expectCaptionsClear(big, playerLayout(big))
  })

  it('portrait with a join-request banner: captions stay below the banner too', () => {
    const withBanner = { ...portrait, bottomCurtainHeight: 234, captionHeight: 110, bannerHeight: 112 }
    const l = playerLayout(withBanner)
    expectCaptionsClear(withBanner, l)
    expect(l.captionCeiling.open).toBeGreaterThan(l.bannerTop + 112)
  })

  it('captions off: nothing to budget, never an overflow', () => {
    const l = playerLayout({ ...crowded, captionsOn: false })
    expect(l.captionBlock).toBe(0)
    expect(l.captionOverflow).toBe(0)
    expect(l.captionMaxLines).toBeUndefined()
  })

  it('the cap never goes below one line, and grows with the room', () => {
    const cramped = playerLayout({ ...crowded, bannerHeight: 120, capCaptionLines: 'open' })
    expect(cramped.captionMaxLines).toBe(1)
    const roomy = playerLayout({ ...portrait, capCaptionLines: 'open' })
    expect(roomy.captionMaxLines!).toBeGreaterThan(3)
  })
})

describe('host banners over a crowded landscape hold', () => {
  // Codex P2: a playback request AND a join request stacked (≈190dp) left no room for even one
  // caption line, so level 3 still overflowed. One banner at a time, one row in landscape.
  const crowded: PlayerLayoutInput = { ...landscape, bottomCurtainHeight: 190, captionHeight: 110 }
  const ONE_ROW_BANNER = 58 // 8 + 40dp actions + 8 + border
  const FOLDED_CURTAIN = 190 - 54 // compaction 'controls' folds the 44dp notice row (+10 gap) away

  it('stacked banners cannot fit a caption line even fully squeezed (why they are queued)', () => {
    const l = playerLayout({ ...crowded, bottomCurtainHeight: FOLDED_CURTAIN, bannerHeight: 190, capCaptionLines: 'open' })
    expect(l.captionMaxLines).toBe(1)
    expect(l.captionOverflow).toBeGreaterThan(0)
  })

  it('queued to one row: fully squeezed, at least one caption line genuinely fits', () => {
    const squeezed = { ...crowded, bottomCurtainHeight: FOLDED_CURTAIN, bannerHeight: ONE_ROW_BANNER, capCaptionLines: 'open' as const }
    const l = playerLayout(squeezed)
    expect(l.captionMaxLines).toBeGreaterThanOrEqual(1)
    const reported = { ...squeezed, captionHeight: captionBlockHeight(l.captionMaxLines!) }
    expectCaptionsClear(reported, playerLayout(reported))
  })
})

describe('hostBannerQueue', () => {
  it('shows one prompt at a time, the expiring playback request first, and counts the rest', () => {
    expect(hostBannerQueue(0, 0)).toEqual({ show: null, queued: 0 })
    expect(hostBannerQueue(1, 0)).toEqual({ show: 'playback', queued: 0 })
    expect(hostBannerQueue(1, 2)).toEqual({ show: 'playback', queued: 2 })
    expect(hostBannerQueue(2, 1)).toEqual({ show: 'playback', queued: 2 })
    expect(hostBannerQueue(0, 3)).toEqual({ show: 'join', queued: 0 }) // the join banner counts its own
  })
})

describe('compaction settles and releases', () => {
  const ctx: CompactionContext = { notice: 'hold', banner: 'none', wide: true, fontScale: 1, captionsOn: true, cueKey: '41' }
  // The Player's loop, with the curtain each level actually renders (folded from 'controls' on).
  const layoutAt = (level: ChromeCompaction, captionHeight: number) =>
    playerLayout({
      ...landscape,
      bottomCurtainHeight: level >= COMPACT_CONTROLS ? 136 : 190,
      captionHeight,
      capCaptionLines: level >= COMPACT_CAPTIONS ? 'open' : undefined,
    })
  const settle = (start: ChromeCompaction, captionHeight: number, steps = 12) => {
    const levels: ChromeCompaction[] = []
    let level = start
    const key = compactionKey(ctx)
    for (let i = 0; i < steps; i++) {
      level = nextCompaction(level, layoutAt(level, captionHeight).captionOverflow)
      // the context is built from inputs the squeeze cannot change: it never resets itself
      expect(compactionKey(ctx)).toBe(key)
      levels.push(level)
    }
    return levels
  }

  it('a tall cue squeezes to the first level that fits, then holds there (no oscillation)', () => {
    const levels = settle(0, 110)
    const final = levels[levels.length - 1]!
    expect(final).toBe(COMPACT_CONTROLS)
    expect(layoutAt(final, 110).captionOverflow).toBe(0)
    expect(new Set(levels.slice(3))).toEqual(new Set([final])) // steady, no flapping back
  })

  it('the next cue resets the context, and a short cue then needs no squeeze', () => {
    expect(compactionKey({ ...ctx, cueKey: '42' })).not.toBe(compactionKey(ctx))
    expect(settle(0, 0).every((l) => l === 0)).toBe(true)
  })

  it('a resolved banner or a cleared hold resets it too', () => {
    expect(compactionKey({ ...ctx, banner: 'join' })).not.toBe(compactionKey(ctx))
    expect(compactionKey({ ...ctx, notice: 'none' })).not.toBe(compactionKey(ctx))
  })
})

describe('nextCompaction', () => {
  it('steps up one level per overflowing measurement and stops at the caption cap', () => {
    expect(nextCompaction(0, 0)).toBe(0)
    expect(nextCompaction(0, 4)).toBe(COMPACT_NOTICE)
    expect(nextCompaction(COMPACT_NOTICE, 4)).toBe(COMPACT_CONTROLS)
    expect(nextCompaction(COMPACT_CONTROLS, 4)).toBe(COMPACT_CAPTIONS)
    expect(nextCompaction(COMPACT_CAPTIONS, 4)).toBe(COMPACT_CAPTIONS)
  })

  it('never steps down on its own (no flapping when the squeezed curtain re-measures)', () => {
    expect(nextCompaction(COMPACT_CONTROLS, 0)).toBe(COMPACT_CONTROLS)
    expect(nextCompaction(COMPACT_NOTICE, Number.NaN)).toBe(COMPACT_NOTICE)
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
