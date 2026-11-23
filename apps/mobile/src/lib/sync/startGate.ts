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

import type { ParticipantStatus } from '../protocol/session'

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
  /** Participant lifecycle status (guests that left or are unapproved requested do not hold the start gate). */
  status?: ParticipantStatus
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
 * Approximates the file as constant-bitrate: `progress × duration − position`; never negative.
 * This is the TELEMETRY number (heartbeats → buffer floor) and stays an unbiased estimate on
 * purpose: during the show a VBR miss is backstopped by the player's own stall report, while a
 * pessimistic floor would hold the room for marginal-but-fine downloaders mid-movie. The
 * decisions that put a player INTO playback (start gate, late join) use the conservative
 * `conservativeCoverageSec` below instead.
 */
export function downloadBufferedAheadSec(progress: number, durationSec: number, positionSec: number): number {
  const p = !Number.isFinite(progress) || progress < 0 ? 0 : progress > 1 ? 1 : progress
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  const pos = Number.isFinite(positionSec) && positionSec > 0 ? positionSec : 0
  const ahead = p * dur - pos
  return ahead > 0 ? ahead : 0
}

/**
 * VBR safety for entering playback. Byte progress is not time progress: a valid H.264 MP4 whose
 * opening scenes run at 2× the average bitrate has only ~2.5% of its RUNTIME in the first 5% of
 * its BYTES, so a CBR estimate promises a late joiner minutes it doesn't have. We discount with
 * `p − k·p·(1 − p)`: exact at both ends (nothing / the whole file), ~30% pessimistic near the
 * start (where a start or late join is usually decided), ~7.5% at the midpoint. Real sample
 * offsets from the moov would be exact, but a guest can't read them before it has the file.
 */
export const VBR_COVERAGE_K = 0.3

/** Conservative seconds of media covered by `progress` of the file (see VBR_COVERAGE_K). */
export function conservativeCoverageSec(progress: number, durationSec: number, k = VBR_COVERAGE_K): number {
  const p = !Number.isFinite(progress) || progress < 0 ? 0 : progress > 1 ? 1 : progress
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  return (p - k * p * (1 - p)) * dur
}

/** Inverse of conservativeCoverageSec: the progress whose conservative coverage reaches `sec`. */
export function progressForCoverage(sec: number, durationSec: number, k = VBR_COVERAGE_K): number {
  if (!(durationSec > 0) || !Number.isFinite(sec) || sec <= 0) return 0
  const c = Math.min(1, sec / durationSec)
  if (k <= 0) return c // degenerates to CBR
  // k·p² + (1 − k)·p − c = 0 → the positive root.
  return (-(1 - k) + Math.sqrt((1 - k) ** 2 + 4 * k * c)) / (2 * k)
}

/** Seconds until this client's download completes at its measured rate (Infinity if unknowable). */
export function secondsToFinish(client: GateClient, media: GateMedia): number {
  const p = Number.isFinite(client.progress) ? Math.max(0, Math.min(1, client.progress)) : 0
  if (p >= 1) return 0
  if (!Number.isFinite(client.downloadMbps) || !(client.downloadMbps > 0)) return Infinity
  const sizeBytes = Number.isFinite(media.sizeBytes) && media.sizeBytes > 0 ? media.sizeBytes : 0
  const remainingBytes = (1 - p) * sizeBytes
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
    if (c.status === 'left' || c.status === 'requested') continue
    if (c.progress >= 1) continue
    const finish = secondsToFinish(c, media)
    if (unprovable) {
      waitingOn.push(c.name)
      if (Number.isFinite(finish)) etaSec = Math.max(etaSec, finish)
      continue
    }
    const pos = Number.isFinite(c.positionSec) && c.positionSec > 0 ? Math.min(media.durationSec, c.positionSec) : 0
    const remainingPlaySec = Math.max(0, media.durationSec - pos)
    const outruns = finish < remainingPlaySec - finishMarginSec
    // Starting puts a player into playback → judge the buffer with the VBR-safe coverage.
    const buffered = Math.max(0, conservativeCoverageSec(c.progress, media.durationSec) - pos)
    if (!outruns) {
      // Throughput can't beat the playhead — a progressive start would stall mid-movie. The only
      // safe start for this client is after its download completes.
      precache = true
      waitingOn.push(c.name)
      if (Number.isFinite(finish)) etaSec = Math.max(etaSec, finish)
    } else if (buffered < minStartBufferSec) {
      waitingOn.push(c.name)
      // Not the full download — just how long until the (conservative) start buffer fills.
      const targetP = progressForCoverage(pos + minStartBufferSec, media.durationSec)
      const needBytes = Math.max(0, targetP - c.progress) * media.sizeBytes
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
    const buffered = Number.isFinite(c.bufferedAheadSec) && c.bufferedAheadSec >= 0 ? c.bufferedAheadSec : 0
    if (buffered < threshold) held.add(c.id)
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

/** What a late joiner can actually play right now. Required: no default may admit an empty player. */
export interface JoinShowSource {
  /**
   * A partial copy is playable (faststart MP4 behind the local proxy). false → no progressive
   * source exists (moov at EOF), so only a FINISHED file may enter.
   */
  progressive: boolean
  /** The player has a source to open right now (the store's movieUri is set). */
  hasSource: boolean
}

/**
 * May a late joiner enter the show yet? It needs something to play, and its download edge must
 * cover the CURRENT playhead plus a lead — judged with the VBR-safe coverage — or the download is
 * simply done. Without a progressive source only a finished file can enter: an empty player would
 * report itself in-show and stalled, pausing the established room for the rest of the transfer.
 */
export function canJoinShow(
  progress: number,
  durationSec: number,
  positionSec: number,
  source: JoinShowSource,
  leadSec = CATCH_UP_LEAD_SEC,
): boolean {
  if (!source.hasSource) return false
  if (progress >= 1) return true
  if (!source.progressive) return false
  if (!(durationSec > 0)) return false // can't reason without a duration — wait for the full file
  const pos = Number.isFinite(positionSec) && positionSec > 0 ? positionSec : 0
  return conservativeCoverageSec(progress, durationSec) - pos >= leadSec
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
  const prev = Number.isFinite(prevMbps) && prevMbps > 0 ? prevMbps : 0
  if (!Number.isFinite(msDelta) || !Number.isFinite(bytesDelta) || msDelta < 250 || bytesDelta < 0) return prev
  const instant = (bytesDelta * 8) / (msDelta / 1000) / 1e6
  if (!Number.isFinite(instant)) return prev
  return prev > 0 ? prev + alpha * (instant - prev) : instant
}
