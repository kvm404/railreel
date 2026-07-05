/**
 * Progressive start gate + group buffer floor (PRD §7 — the "never ruin it" rules).
 *
 * The host decides when the show may start from each client's download telemetry. Two modes:
 *  - progressive: every client has a real head start (~60s buffered) AND the math proves their
 *    download will finish before the playhead catches the download edge — start now, keep pulling.
 *  - precache: the throughput can't outrun playback for someone, so the only safe start is after
 *    they finish — show an honest ETA instead of promising real-time.
 *
 * During the show, the same telemetry drives the group buffer floor: anyone still downloading who
 * falls under ~15s of buffer holds the room, and releases only after recovering to ~30s —
 * hysteresis so a client hovering at the edge can't flap the room pause/resume.
 *
 * All pure: the host feeds heartbeat data in, decisions come out. Unit-tested against fixtures.
 */

export interface GateMedia {
  /** Total bytes of the movie file. */
  sizeBytes: number
  /** Duration in seconds. */
  durationSec: number
  /**
   * Progressive start is off the table for this file (e.g. the moov atom sits at the end, so a
   * player can't even initialize from a partial file) — only a full pre-cache start is safe.
   */
  precacheOnly?: boolean
}

export interface GateClient {
  /** Roster identity (gate results name who the room is waiting on). */
  id: string
  name: string
  /** Fraction of the movie cached (0–1). */
  progress: number
  /** Measured download throughput, Mbps. 0/unknown while downloading = can't prove a safe start. */
  downloadMbps: number
  /** Playhead in seconds (0 in the lobby). */
  positionSec: number
}

export interface StartGateOptions {
  /** Every client must have at least this many seconds buffered ahead to start. */
  minStartBufferSec?: number
  /** The download must beat playback to the end by at least this margin (seconds). */
  finishMarginSec?: number
}

export interface StartGateDecision {
  /** The show may start now. */
  start: boolean
  /**
   * 'progressive' — starting (or waiting) with downloads still running is safe/planned.
   * 'precache' — someone's throughput can't outrun playback; the start waits for full downloads.
   */
  mode: 'progressive' | 'precache'
  /** When not startable: longest remaining download time (seconds) across clients, for the ETA. */
  etaSec: number | null
  /** Names of the clients the start is waiting on. */
  waitingOn: string[]
}

const GATE_DEFAULTS = { minStartBufferSec: 60, finishMarginSec: 60 }

/**
 * Seconds of playable media between the playhead and the download edge, from download progress.
 * Approximates the file as constant-bitrate: `progress × duration − position`. Good enough for the
 * gate/floor (H.264 MP4s the app accepts are near-CBR at this granularity); never negative.
 */
export function downloadBufferedAheadSec(progress: number, durationSec: number, positionSec: number): number {
  const p = progress < 0 ? 0 : progress > 1 ? 1 : progress
  const ahead = p * durationSec - positionSec
  return ahead > 0 ? ahead : 0
}

/** Seconds until this client's download completes at its measured rate (Infinity if unknowable). */
export function secondsToFinish(client: GateClient, media: GateMedia): number {
  if (client.progress >= 1) return 0
  if (!(client.downloadMbps > 0)) return Infinity
  const remainingBytes = (1 - client.progress) * media.sizeBytes
  return (remainingBytes * 8) / (client.downloadMbps * 1e6)
}

/**
 * PRD §7 rule 1 — may the show start now?
 * A client passes when it has finished, OR it has the start buffer AND its download provably
 * finishes before playback would catch it (`secondsToFinish < remainingPlayTime − margin`).
 */
export function decideStartGate(
  clients: GateClient[],
  media: GateMedia,
  opts: StartGateOptions = {},
): StartGateDecision {
  const { minStartBufferSec, finishMarginSec } = { ...GATE_DEFAULTS, ...opts }
  const waitingOn: string[] = []
  // A progressive start needs PROOF the downloads outrun playback; without real size/duration
  // (probe failed, picker gave no size) or with a file a player can't open partially, the only
  // provably safe start is after everyone has the whole file.
  const unprovable = media.precacheOnly === true || !(media.sizeBytes > 0) || !(media.durationSec > 0)
  let precache = unprovable
  let etaSec = 0

  for (const c of clients) {
    if (c.progress >= 1) continue
    const finish = secondsToFinish(c, media)
    if (unprovable) {
      waitingOn.push(c.name)
      if (Number.isFinite(finish)) etaSec = Math.max(etaSec, finish)
      continue
    }
    const remainingPlaySec = media.durationSec - c.positionSec
    const outruns = finish < remainingPlaySec - finishMarginSec
    const buffered = downloadBufferedAheadSec(c.progress, media.durationSec, c.positionSec)
    if (!outruns) {
      // Throughput can't beat the playhead — a progressive start would stall mid-movie. The only
      // safe start for this client is after its download completes.
      precache = true
      waitingOn.push(c.name)
      if (Number.isFinite(finish)) etaSec = Math.max(etaSec, finish)
    } else if (buffered < minStartBufferSec) {
      waitingOn.push(c.name)
      // Not the full download — just how long until the start buffer fills.
      const needSec = minStartBufferSec - buffered
      const needBytes = (needSec / media.durationSec) * media.sizeBytes
      etaSec = Math.max(etaSec, (needBytes * 8) / (c.downloadMbps * 1e6))
    }
  }

  // The ETA is the longest KNOWN wait — one client with an unmeasurable rate (Infinity) must not
  // erase the finite estimates of the others; 0 means we know nothing (e.g. sizeBytes unknown).
  const knownEta = waitingOn.length > 0 && Number.isFinite(etaSec) && etaSec > 0 ? Math.ceil(etaSec) : null
  return {
    start: waitingOn.length === 0,
    mode: precache ? 'precache' : 'progressive',
    etaSec: knownEta,
    waitingOn,
  }
}

export interface FloorClient {
  id: string
  /** Fraction downloaded — a finished client (≥1) can never trip the floor. */
  progress: number
  bufferedAheadSec: number
}

export interface BufferFloorOptions {
  /** Falling under this many seconds of buffer holds the room. */
  floorSec?: number
  /** A held client releases only after recovering to this (hysteresis; > floorSec). */
  releaseSec?: number
}

const FLOOR_DEFAULTS = { floorSec: 15, releaseSec: 30 }

/**
 * PRD §7 rule 2 — the group buffer floor with hysteresis. Returns the ids of clients the room is
 * held on. Feed the previous result back each tick: a client enters the held set under `floorSec`
 * and leaves it only at `releaseSec`, so hovering at the floor can't flap the room.
 */
export function updateFloorHolds(
  prevHeld: ReadonlySet<string>,
  clients: FloorClient[],
  opts: BufferFloorOptions = {},
): Set<string> {
  const { floorSec, releaseSec } = { ...FLOOR_DEFAULTS, ...opts }
  const held = new Set<string>()
  for (const c of clients) {
    if (c.progress >= 1) continue
    const threshold = prevHeld.has(c.id) ? releaseSec : floorSec
    if (c.bufferedAheadSec < threshold) held.add(c.id)
  }
  return held
}

/**
 * The boarding-board departure clock: seconds-until-start → "M:SS" for the split-flap display.
 * null (unknown/unmeasurable) shows dashes; a huge pre-cache ETA is clamped so the board never
 * overflows. Ready (etaSec 0/negative) reads "0:00" — the caller flips the board to ALL ABOARD.
 */
export function departureClock(etaSec: number | null): string {
  if (etaSec == null || !Number.isFinite(etaSec)) return '--:--'
  const s = Math.max(0, Math.min(Math.round(etaSec), 99 * 60 + 59))
  const m = Math.floor(s / 60)
  return `${m}:${(s % 60).toString().padStart(2, '0')}`
}

/** Lead a late joiner needs beyond the live playhead before it may enter the show (seconds). */
export const CATCH_UP_LEAD_SEC = 30

/**
 * May a late joiner enter the show yet? Its download edge must cover the CURRENT playhead plus a
 * lead (or the download is simply done) — entering earlier would just stall the player at a
 * position it hasn't downloaded and hold nothing but its own experience hostage.
 */
export function canJoinShow(progress: number, durationSec: number, positionSec: number, leadSec = CATCH_UP_LEAD_SEC): boolean {
  if (progress >= 1) return true
  if (!(durationSec > 0)) return false // can't reason without a duration — wait for the full file
  return downloadBufferedAheadSec(progress, durationSec, positionSec) >= leadSec
}

/**
 * Smoothed throughput from two byte/time samples (EMA so one bursty read doesn't swing the gate).
 * Returns `prevMbps` unchanged when the window is too short to measure.
 */
export function smoothedMbps(
  prevMbps: number,
  bytesDelta: number,
  msDelta: number,
  alpha = 0.5,
): number {
  if (msDelta < 250 || bytesDelta < 0) return prevMbps
  const instant = (bytesDelta * 8) / (msDelta / 1000) / 1e6
  return prevMbps > 0 ? prevMbps + alpha * (instant - prevMbps) : instant
}
