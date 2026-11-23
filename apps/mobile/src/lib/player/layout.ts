/**
 * The Player's overlay layout, as one pure computation: every layer over the film (curtains,
 * captions, chat ticker, floating reactions, the moderation banner) is placed from the same
 * numbers, so the reserved regions can't drift into each other.
 *
 *   ┌ top curtain ─ back · title · subtitles · sync ┐   ← banner / toast hang just below it
 *   │                                  ✦ reactions   │   ← right-edge lane, above captions
 *   │ ticker (chat)                                  │   ← left, above captions
 *   │            [ captions region ]                 │   ← rests low; lifts with the curtain
 *   └ bottom curtain ─ rail · filament · transport ─┘
 *
 * Everything in the middle band rests near the bottom edge while the chrome is hidden and is
 * lifted by exactly `lift` px (animated on the UI thread) while the bottom curtain is open, so
 * captions never sit under the transport or the reaction rail.
 */

export interface Insets {
  top: number
  bottom: number
  left: number
  right: number
}

export interface PlayerLayoutInput {
  width: number
  height: number
  insets: Insets
  /** Measured height of the open bottom curtain (0 until measured). */
  bottomCurtainHeight: number
  /** Captions are on and the movie has cues — reserve their region. */
  captionsOn: boolean
}

export interface PlayerLayout {
  /** Landscape-ish: transport and the reaction rail share one row. */
  wide: boolean
  /** Horizontal safe padding for every edge-anchored layer (cutouts in landscape). */
  sideLeft: number
  sideRight: number
  /** Width of each reaction-rail key (≥ RAIL_KEY_MIN, never overlapping its neighbours). */
  railKey: number
  /** Resting bottom of the caption region while the chrome is hidden. */
  captionBottom: number
  /** Upward shift for the whole middle band while the bottom curtain is open. */
  lift: number
  /** Chat ticker / floating reactions start above the caption region. */
  socialBottom: number
  /** Vertical room above `socialBottom` for floating reactions (worst case: curtain open). */
  reactionRoom: number
  /** Where the moderation banner / request toast hang (below the top curtain). */
  bannerTop: number
  /** Floating-reaction lane plan (see reactionLanes). */
  reactions: ReactionLanes
  /** Chat ticker's right inset: clear of the reaction lanes, never below TICKER_MIN_W wide. */
  tickerRight: number
}

export const SIDE_MIN = 16
/** Touch-target floor for a rail key (dp). */
export const RAIL_KEY_MIN = 44
const RAIL_KEY_MAX = 48
/** 5 reactions + chat. */
export const RAIL_KEYS = 6
/** Divider (1 + 2×4 margin) + horizontal padding (2×6) + border (2×1). */
export const RAIL_CHROME = 9 + 12 + 2
/** Two caption lines (23 lh) + plate padding + gap. */
const CAPTION_RESERVE = 2 * 23 + 12 + 8
const CAPTION_REST_GAP = 20
const CURTAIN_GAP = 10
const TOP_CURTAIN = 64
/** In a wide row the rail gets at most this share of the width (transport takes the rest). */
const WIDE_RAIL_SHARE = 0.5

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n)

/** Rail width for a given key size (keeps the component and the layout in agreement). */
export function railWidth(key: number): number {
  return key * RAIL_KEYS + RAIL_CHROME
}

export function playerLayout(i: PlayerLayoutInput): PlayerLayout {
  const wide = i.width > i.height
  const sideLeft = Math.max(SIDE_MIN, i.insets.left)
  const sideRight = Math.max(SIDE_MIN, i.insets.right)
  const usable = Math.max(0, i.width - sideLeft - sideRight)
  const railRoom = wide ? usable * WIDE_RAIL_SHARE : usable
  const railKey = clamp(Math.floor((railRoom - RAIL_CHROME) / RAIL_KEYS), RAIL_KEY_MIN, RAIL_KEY_MAX)

  const captionBottom = i.insets.bottom + CAPTION_REST_GAP
  const lifted = i.bottomCurtainHeight > 0 ? i.bottomCurtainHeight + CURTAIN_GAP : captionBottom
  const lift = Math.max(0, lifted - captionBottom)
  const socialBottom = captionBottom + (i.captionsOn ? CAPTION_RESERVE : 0)
  const bannerTop = i.insets.top + TOP_CURTAIN
  const reactionRoom = Math.max(0, i.height - bannerTop - socialBottom - lift)
  const reactions = reactionLanes(reactionRoom, usable)
  const tickerRight = sideRight + reactions.span + TICKER_GAP

  return { wide, sideLeft, sideRight, railKey, captionBottom, lift, socialBottom, reactionRoom, bannerTop, reactions, tickerRight }
}

// ── floating-reaction lanes ────────────────────────────────────────────────────
export const SPARK_W = 92
export const SPARK_RISE = 170
export const LANE_STEP_Y = 54
export const LANE_STEP_X = 52
export const MAX_LANES = 4
const SPARK_H = 48
const MIN_RISE = 60
/** The chat ticker must keep at least this much width for sender + message. */
export const TICKER_MIN_W = 160
const TICKER_GAP = 8

export interface ReactionLanes {
  /** Lanes stack up the right edge, or spread leftwards along it on a short viewport. */
  axis: 'vertical' | 'sideways'
  count: number
  /** How far each spark travels up (px). */
  rise: number
  /** Horizontal span reserved from the right safe edge (the ticker stays clear of it). */
  span: number
}

/**
 * Pick the reaction lanes for the room available. Vertical lanes are preferred (one narrow
 * column, so the chat ticker keeps nearly the full width) with the rise shortened to fit; only a
 * genuinely short viewport (landscape) spreads them sideways — and then only as many lanes as
 * leave the ticker its minimum readable width. Fewer lanes than concurrent sparks just means two
 * may share a lane briefly.
 */
export function reactionLanes(room: number, usableWidth: number): ReactionLanes {
  const stack = LANE_STEP_Y * (MAX_LANES - 1) + SPARK_H
  if (room >= stack + MIN_RISE) {
    return { axis: 'vertical', count: MAX_LANES, rise: Math.min(SPARK_RISE, room - stack), span: SPARK_W }
  }
  const widthForLanes = usableWidth - TICKER_MIN_W - TICKER_GAP - SPARK_W
  const count = clamp(Math.floor(widthForLanes / LANE_STEP_X) + 1, 1, MAX_LANES)
  return {
    axis: 'sideways',
    count,
    rise: Math.max(MIN_RISE, Math.min(SPARK_RISE, room - SPARK_H)),
    span: (count - 1) * LANE_STEP_X + SPARK_W,
  }
}
