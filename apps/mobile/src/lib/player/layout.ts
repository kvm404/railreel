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
 *
 * The captions themselves have a hard ceiling: their top edge never rises past the top controls
 * (or a banner hanging below them) — `captionTop >= captionCeiling` in both chrome states. When a
 * tall cue over a crowded curtain would break that, the layout reports the overflow and the Player
 * escalates, one measured step at a time (`nextCompaction`): compact the notice, then fold it into
 * the controls row, and only as a last resort cap the cue at the lines that fit.
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
  /**
   * Measured height of the host's banner stack hanging at `bannerTop` (join requests, a playback
   * request), 0 when none. It stays up whether the chrome is open or hidden, so both states budget
   * below it.
   */
  bannerHeight?: number
  /**
   * Last resort (compaction 'captions'): cap the caption block at the lines that fit in this chrome
   * state. The Player then renders at most `captionMaxLines` lines and reports the capped height.
   */
  capCaptionLines?: 'open' | 'closed'
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
  /** Bottom of the top curtain's controls (its fade excluded): nothing in the middle band may cross it. */
  topControlsBottom: number
  /** Height budgeted for the caption block itself (0 when captions are off). */
  captionBlock: number
  /** The highest the caption block's top edge may reach, per chrome state (px from the top). */
  captionCeiling: { open: number; closed: number }
  /** Where the caption block's top edge sits, per chrome state (px from the top). */
  captionTop: { open: number; closed: number }
  /** How far the caption block crosses its ceiling in either state (0 = fits): compact the chrome. */
  captionOverflow: number
  /** The most caption lines that fit under the ceiling, per chrome state (≥ 1). */
  captionLines: { open: number; closed: number }
  /** The line cap in force (`capCaptionLines`), or undefined when captions render in full. */
  captionMaxLines: number | undefined
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
/** Clearance between the top controls and the caption block's top edge. */
export const CAPTION_CLEARANCE = 8
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

/** A caption block of `lines` lines at the current text scale, on its plate. */
export function captionBlockHeight(lines: number, fontScale = 1): number {
  return Math.ceil(lines * CAPTION_LINE * fontScale + CAPTION_CHROME)
}

/** The caption block the layout always makes room for: two lines at the current text scale, on its plate. */
export function captionFloor(fontScale = 1): number {
  return captionBlockHeight(2, fontScale)
}

/**
 * How hard the Player squeezes its chrome so the captions clear the top controls, in order:
 *  0 none · 1 'notice' — the bottom-curtain notice goes to one line, its action to a compact pill
 *  · 2 'controls' — wide layouts fold the notice into the controls row and the reaction rail down
 *  to its chat key · 3 'captions' — the caption block is capped at the lines that fit.
 */
export type ChromeCompaction = 0 | 1 | 2 | 3
export const COMPACT_NOTICE = 1
export const COMPACT_CONTROLS = 2
export const COMPACT_CAPTIONS = 3

/**
 * One step up while the captions still cross their ceiling — never down: the Player re-measures
 * between steps and resets to 0 only when the situation changes (another notice, an orientation
 * or text-scale change, captions toggled), so a squeezed curtain can't flap open and shut.
 */
export function nextCompaction(level: ChromeCompaction, overflowPx: number): ChromeCompaction {
  if (!(overflowPx > 0) || level >= COMPACT_CAPTIONS) return level
  return (level + 1) as ChromeCompaction
}

/**
 * The situation a compaction level belongs to; the Player resets to 0 whenever it changes. Built
 * ONLY from inputs the squeeze cannot change — which notice and banner are up, orientation, text
 * scale, captions on, and the cue on screen — never from measured heights, so squeezing the chrome
 * can't reset itself (no oscillation), while a new cue, a resolved banner or a cleared hold
 * releases a squeeze that is no longer needed.
 */
export interface CompactionContext {
  notice: string
  banner: string
  wide: boolean
  fontScale: number
  captionsOn: boolean
  /** Identity of the last cue set shown (a gap between cues keeps the previous one). */
  cueKey: string
}

export function compactionKey(c: CompactionContext): string {
  return [c.notice, c.banner, c.wide ? 'w' : 'n', c.fontScale, c.captionsOn ? 'c' : '-', c.cueKey].join('|')
}

/**
 * The host's prompts over the film, one at a time: a playback request first (it expires within
 * seconds), then join requests. Two stacked banners in landscape leave no room for even one
 * caption line under them; the one shown says how many more are queued.
 */
export function hostBannerQueue(playbackRequests: number, joinRequests: number): {
  show: 'playback' | 'join' | null
  /** Prompts waiting behind the one shown that it does not already count itself. */
  queued: number
} {
  if (playbackRequests > 0) return { show: 'playback', queued: playbackRequests - 1 + joinRequests }
  if (joinRequests > 0) return { show: 'join', queued: 0 } // the join banner counts its own queue
  return { show: null, queued: 0 }
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

  const topControlsBottom =
    i.topCurtainHeight && i.topCurtainHeight > TOP_FADE ? i.topCurtainHeight - TOP_FADE : i.insets.top + TOP_BAR_FALLBACK
  const bannerTop = topControlsBottom + CURTAIN_GAP

  // A banner stack below the controls pushes the band's top edge down in BOTH chrome states.
  const banner = i.bannerHeight && i.bannerHeight > 0 ? Math.ceil(i.bannerHeight) : 0
  const bannerBottom = banner > 0 ? bannerTop + banner + CURTAIN_GAP : 0
  const openTop = Math.max(bannerTop, bannerBottom)
  const closedTop = Math.max(i.insets.top + SIDE_MIN, bannerBottom)

  // The caption ceiling, and how many lines fit under it (from the room alone — never from the
  // caption's own height, so capping a cue can't feed back into the cap).
  const captionCeiling = { open: Math.max(topControlsBottom + CAPTION_CLEARANCE, bannerBottom), closed: closedTop }
  const linesIn = (room: number): number => Math.max(1, Math.floor((room - CAPTION_CHROME) / (CAPTION_LINE * fontScale)))
  const captionLines = {
    open: linesIn(i.height - (captionBottom + lift) - captionCeiling.open),
    closed: linesIn(i.height - captionBottom - captionCeiling.closed),
  }
  const captionMaxLines = i.captionsOn && i.capCaptionLines ? captionLines[i.capCaptionLines] : undefined

  const measured = i.captionHeight && i.captionHeight > 0 ? Math.ceil(i.captionHeight) : 0
  const cap = captionMaxLines !== undefined ? captionBlockHeight(captionMaxLines, fontScale) : Number.POSITIVE_INFINITY
  const floor = Math.min(captionFloor(fontScale), cap)
  const captionBlock = i.captionsOn ? Math.min(Math.max(floor, measured), cap) : 0
  const captionReserve = i.captionsOn ? captionBlock + CAPTION_GAP : 0
  const socialBottom = captionBottom + captionReserve

  const captionTop = { open: i.height - (captionBottom + lift) - captionBlock, closed: i.height - captionBottom - captionBlock }
  const captionOverflow = i.captionsOn
    ? Math.max(0, captionCeiling.open - captionTop.open, captionCeiling.closed - captionTop.closed)
    : 0

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
    open: band(openTop, socialBottom + lift),
    closed: band(closedTop, socialBottom),
  }

  return {
    wide,
    sideLeft,
    sideRight,
    railKey,
    captionBottom,
    captionReserve,
    captionFloor: floor,
    lift,
    socialBottom,
    bannerTop,
    topControlsBottom,
    captionBlock,
    captionCeiling,
    captionTop,
    captionOverflow,
    captionLines,
    captionMaxLines,
    social,
  }
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
