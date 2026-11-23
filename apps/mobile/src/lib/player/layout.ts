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
 *
 * One vertical budget, from MEASURED heights (both curtains and the rendered caption block — a
 * holding notice, long names, enlarged text or a three-line cue all grow them): the social band
 * (ticker + reactions) gets whatever is left between the captions and the top edge, separately for
 * the chrome open and hidden. When that is too little the ticker is clipped to it or dropped, and
 * reactions are dropped rather than drawn over the header — the film and its captions win.
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
  /** Measured height of the open top curtain, fade included (0 until measured). */
  topCurtainHeight?: number
  /** Captions are on and the movie has cues — reserve their region. */
  captionsOn: boolean
  /** Measured height of the caption block on screen right now (0 when none / shorter than the floor). */
  captionHeight?: number
  /** OS text scale (useWindowDimensions().fontScale). */
  fontScale?: number
}

/** What the social band (chat ticker + floating reactions) may use in one chrome state. */
export interface SocialBand {
  /** Vertical room between the top of the caption reservation and the top edge (px). */
  room: number
  /** Show the chat ticker at all (at least one line fits). */
  ticker: boolean
  /** Clip the ticker's stack to this height (oldest lines give way first). */
  tickerMaxHeight: number
  /** Chat ticker's right inset: clear of the reaction lanes, never below TICKER_MIN_W wide. */
  tickerRight: number
  /** Floating-reaction lane plan, or null when no spark fits without crossing the top edge. */
  reactions: ReactionLanes | null
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
  /** Height reserved for captions above `captionBottom` (0 when captions are off). */
  captionReserve: number
  /** A caption block up to this tall fits the default reservation (callers can skip reporting it). */
  captionFloor: number
  /** Upward shift for the whole middle band while the bottom curtain is open. */
  lift: number
  /** Chat ticker / floating reactions start above the caption region (resting position). */
  socialBottom: number
  /** Where the moderation banner / request toast hang (below the top curtain's controls). */
  bannerTop: number
  /** The social band's budget with the chrome open (curtains in) and hidden. */
  social: { open: SocialBand; closed: SocialBand }
}

export const SIDE_MIN = 16
/** Touch-target floor for a rail key (dp). */
export const RAIL_KEY_MIN = 44
const RAIL_KEY_MAX = 48
/** 5 reactions + chat. */
export const RAIL_KEYS = 6
/** Divider (1 + 2×4 margin) + horizontal padding (2×6) + border (2×1). */
export const RAIL_CHROME = 9 + 12 + 2
/** One caption line's line height at 1× text (CaptionOverlay). */
const CAPTION_LINE = 23
/** Plate padding + border (12 + 2) and the gap above the plate. */
const CAPTION_CHROME = 14
const CAPTION_GAP = 8
const CAPTION_REST_GAP = 20
const CURTAIN_GAP = 10
/**
 * The top curtain's soft fade below its controls (the top bar's paddingBottom). Banners may hang
 * over it — it is only gradient — but never over the controls above it.
 */
export const TOP_FADE = 28
/** Top bar before it is measured: its top padding + a 48dp control row. */
const TOP_BAR_FALLBACK = 10 + 48
/** One ticker line (caption type, 18 lh) plus its stack gap. */
const TICKER_LINE = 18 + 6
/** In a wide row the rail gets at most this share of the width (transport takes the rest). */
const WIDE_RAIL_SHARE = 0.5

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n)

/** Rail width for a given key size (keeps the component and the layout in agreement). */
export function railWidth(key: number): number {
  return key * RAIL_KEYS + RAIL_CHROME
}

/** The caption block the layout always makes room for: two lines at the current text scale, on its plate. */
export function captionFloor(fontScale = 1): number {
  return Math.ceil(2 * CAPTION_LINE * fontScale + CAPTION_CHROME)
}

export function playerLayout(i: PlayerLayoutInput): PlayerLayout {
  const fontScale = i.fontScale && i.fontScale > 0 ? i.fontScale : 1
  const wide = i.width > i.height
  const sideLeft = Math.max(SIDE_MIN, i.insets.left)
  const sideRight = Math.max(SIDE_MIN, i.insets.right)
  const usable = Math.max(0, i.width - sideLeft - sideRight)
  const railRoom = wide ? usable * WIDE_RAIL_SHARE : usable
  const railKey = clamp(Math.floor((railRoom - RAIL_CHROME) / RAIL_KEYS), RAIL_KEY_MIN, RAIL_KEY_MAX)

  const captionBottom = i.insets.bottom + CAPTION_REST_GAP
  const lifted = i.bottomCurtainHeight > 0 ? i.bottomCurtainHeight + CURTAIN_GAP : captionBottom
  const lift = Math.max(0, lifted - captionBottom)

  const floor = captionFloor(fontScale)
  const measured = i.captionHeight && i.captionHeight > 0 ? Math.ceil(i.captionHeight) : 0
  const captionReserve = i.captionsOn ? Math.max(floor, measured) + CAPTION_GAP : 0
  const socialBottom = captionBottom + captionReserve

  const topControlsBottom =
    i.topCurtainHeight && i.topCurtainHeight > TOP_FADE ? i.topCurtainHeight - TOP_FADE : i.insets.top + TOP_BAR_FALLBACK
  const bannerTop = topControlsBottom + CURTAIN_GAP

  const tickerLine = Math.ceil(TICKER_LINE * fontScale)
  const band = (topEdge: number, bottom: number): SocialBand => {
    const room = Math.max(0, i.height - topEdge - bottom)
    const reactions = reactionLanes(room, usable)
    return {
      room,
      ticker: room >= tickerLine,
      tickerMaxHeight: room,
      tickerRight: sideRight + (reactions ? reactions.span + TICKER_GAP : 0),
      reactions,
    }
  }
  const social = {
    open: band(bannerTop, socialBottom + lift),
    closed: band(i.insets.top + SIDE_MIN, socialBottom),
  }

  return { wide, sideLeft, sideRight, railKey, captionBottom, captionReserve, captionFloor: floor, lift, socialBottom, bannerTop, social }
}

// ── floating-reaction lanes ────────────────────────────────────────────────────
export const SPARK_W = 92
export const SPARK_RISE = 170
export const LANE_STEP_Y = 54
export const LANE_STEP_X = 52
export const MAX_LANES = 4
/** A spark's own height (emoji + name). */
export const SPARK_H = 48
/** Less travel than this doesn't read as a drifting spark — drop the reactions instead. */
export const MIN_RISE = 60
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
 * may share a lane briefly. With less room than one spark plus a minimal rise there are no lanes
 * at all (null): a spark must never travel past the room it was given.
 */
export function reactionLanes(room: number, usableWidth: number): ReactionLanes | null {
  if (room < SPARK_H + MIN_RISE) return null
  const stack = LANE_STEP_Y * (MAX_LANES - 1) + SPARK_H
  if (room >= stack + MIN_RISE) {
    return { axis: 'vertical', count: MAX_LANES, rise: Math.min(SPARK_RISE, room - stack), span: SPARK_W }
  }
  const widthForLanes = usableWidth - TICKER_MIN_W - TICKER_GAP - SPARK_W
  const count = clamp(Math.floor(widthForLanes / LANE_STEP_X) + 1, 1, MAX_LANES)
  return {
    axis: 'sideways',
    count,
    rise: Math.min(SPARK_RISE, room - SPARK_H),
    span: (count - 1) * LANE_STEP_X + SPARK_W,
  }
}
