/**
 * Guest movie-transfer recovery rules (pure). A hotspot blip kills the HTTP transfer and the WS
 * together; the WS reconnects on its own, and these decide how the transfer follows it back.
 *
 * Resume beats restart: the host's data plane answers `Range: bytes=N-` with 206, and appending
 * to the SAME file keeps the playback proxy's open fd valid (a restart unlinks the file, leaving
 * the proxy reading a dead inode) and doesn't re-pull gigabytes over a shared hotspot.
 */

import { reconnectDelayMs } from './backoff'

/** Automatic transfer retries per failure streak (a success, or a manual retry, resets it). */
export const MAX_TRANSFER_RETRIES = 6

/** Backoff before automatic transfer retry #attempt: 1s, 2s, 4s, 8s, then 15s. */
export function transferRetryDelayMs(attempt: number): number {
  return reconnectDelayMs(attempt, 1000, 15_000)
}

/**
 * Byte offset to resume from, or 0 for a fresh transfer. Resume only a partial copy THIS session
 * wrote (the caller vouches for that) that is non-empty and strictly short of the final size —
 * an empty, complete, or oversized file (unknown size, foreign bytes) restarts clean.
 */
export function resumeOffset(localBytes: number | null | undefined, expectedBytes: number): number {
  if (!(expectedBytes > 0)) return 0 // no size, no Range proof → restart
  if (typeof localBytes !== 'number' || !Number.isFinite(localBytes) || localBytes <= 0) return 0
  if (localBytes >= expectedBytes) return 0
  return Math.floor(localBytes)
}

/**
 * Did the transfer leave a trustworthy file? The legacy downloader writes ANY response body to
 * disk (appending on a resume) — so a resumed transfer must have been a 206 (a 200 would have
 * appended the whole movie again; a 4xx appended an error page), and the final size must be
 * exactly the movie's size when we know it.
 */
export function transferResultOk(
  resumedFrom: number,
  status: number | undefined,
  finalBytes: number | null | undefined,
  expectedBytes: number,
): boolean {
  if (typeof status !== 'number') return false
  if (resumedFrom > 0 ? status !== 206 : status < 200 || status >= 300) return false
  if (expectedBytes > 0 && finalBytes !== expectedBytes) return false
  return true
}

export interface AutoResumeInput {
  /** The host approved us (grant live on the data plane). */
  approved: boolean
  /** Current client phase. */
  phase: string
  /** The movie is fully cached AND validated (status, size, fingerprint) — not merely all bytes read. */
  complete: boolean
  /** A transfer attempt is running right now. */
  transferring: boolean
  /** The WS is down and re-handshaking (a retry now would fail the same way). */
  reconnecting: boolean
  /** Automatic retries already spent in this failure streak. */
  retries: number
}

/** Should the guest automatically restart its (failed) transfer now? */
export function shouldAutoResume(i: AutoResumeInput): boolean {
  return (
    i.approved &&
    i.phase === 'approved' && // the failure path parks us here; 'downloading'/'ready' need nothing
    !i.complete &&
    !i.transferring &&
    !i.reconnecting &&
    i.retries < MAX_TRANSFER_RETRIES
  )
}

/**
 * A running transfer with no bytes for this long is presumed dead. Well under the playback
 * proxy's 30s silent-edge timeout (and OkHttp's 60s read timeout), well over a healthy hotspot's
 * gaps between progress events (~100ms) and the host's time to first byte.
 */
export const TRANSFER_STALL_MS = 8000

/**
 * Watchdog tick: is the transfer still "running" but silently dead (OkHttp's 60s read timeout
 * hasn't fired yet)? Then abort and resume it now rather than wait out the timeout — the
 * playback proxy gives up on a silent edge after 30s. `lastProgressAtMs` starts at the moment
 * the request was issued, which is the first-byte grace.
 */
export function isTransferStalled(
  transferring: boolean,
  lastProgressAtMs: number,
  nowMs: number,
  stallMs = TRANSFER_STALL_MS,
): boolean {
  return transferring && lastProgressAtMs > 0 && nowMs - lastProgressAtMs >= stallMs
}

/** Bytes of real progress in one attempt that earn back the automatic retry budget. */
export const MEANINGFUL_PROGRESS_BYTES = 4 * 1024 * 1024

/**
 * Reset the retry budget? Only on success or real forward progress — never merely because the
 * WS reconnected (WS handshakes can succeed while HTTP keeps failing; resetting on reconnect
 * would allow unlimited, un-backed-off attempts).
 */
export function earnsRetryBudget(bytesThisAttempt: number): boolean {
  return Number.isFinite(bytesThisAttempt) && bytesThisAttempt >= MEANINGFUL_PROGRESS_BYTES
}

/**
 * Byte progress for telemetry and the UI before the file is validated: never a full 1, because
 * the host treats progress ≥ 1 as "ready" and an unvalidated file (fingerprint pending, disk
 * write failed after the last read) is not.
 */
export const UNVALIDATED_PROGRESS_CAP = 0.999

export function unvalidatedProgress(bytesWritten: number, totalBytes: number): number {
  if (!(totalBytes > 0) || !Number.isFinite(bytesWritten) || bytesWritten <= 0) return 0
  return Math.min(UNVALIDATED_PROGRESS_CAP, bytesWritten / totalBytes)
}
