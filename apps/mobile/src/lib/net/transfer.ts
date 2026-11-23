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
  /** Consecutive copies that downloaded fully but failed validation (fingerprint / size / status). */
  integrityFailures: number
}

/**
 * Integrity failures get their OWN, small budget: a host serving bytes that never match its own
 * fingerprint will fail the same way every time, and each try re-pulls the whole movie over the
 * shared hotspot. Bytes from such an attempt are discarded, so they never earn retry credit.
 */
export const MAX_INTEGRITY_RETRIES = 2

/** Should the guest automatically restart its (failed) transfer now? */
export function shouldAutoResume(i: AutoResumeInput): boolean {
  return (
    i.approved &&
    i.phase === 'approved' && // the failure path parks us here; 'downloading'/'ready' need nothing
    !i.complete &&
    !i.transferring &&
    !i.reconnecting &&
    i.retries < MAX_TRANSFER_RETRIES &&
    i.integrityFailures <= MAX_INTEGRITY_RETRIES
  )
}

/**
 * An ESTABLISHED transfer (bytes have flowed) with no new bytes for this long is presumed dead.
 * Well under the playback proxy's 30s silent-edge timeout (and OkHttp's 60s read timeout), well
 * over a healthy hotspot's gaps between progress events (~100ms).
 */
export const TRANSFER_STALL_MS = 8000

/**
 * Before the FIRST byte the bar is lower: a busy host (several guests starting at once, a slow
 * content:// source seeking) can take a while to answer, and cancelling a valid slow response
 * just restarts the same wait. Still under OkHttp's 60s connect/read timeouts.
 */
export const INITIAL_RESPONSE_GRACE_MS = 20_000

/**
 * Watchdog tick: is the transfer still "running" but silently dead (OkHttp's 60s read timeout
 * hasn't fired yet)? Then abort and resume it now rather than wait out the timeout — the
 * playback proxy gives up on a silent edge after 30s.
 * `startedAtMs`: when this attempt's request went out. `lastProgressAtMs`: its latest progress
 * event, or 0 while no byte has arrived yet (the initial-response grace applies).
 */
export function isTransferStalled(
  transferring: boolean,
  startedAtMs: number,
  lastProgressAtMs: number,
  nowMs: number,
  stallMs = TRANSFER_STALL_MS,
  graceMs = INITIAL_RESPONSE_GRACE_MS,
): boolean {
  if (!transferring || !(startedAtMs > 0)) return false
  if (lastProgressAtMs > 0) return nowMs - lastProgressAtMs >= stallMs
  return nowMs - startedAtMs >= graceMs
}

/** Bytes of real progress in one attempt that earn back the automatic retry budget. */
export const MEANINGFUL_PROGRESS_BYTES = 4 * 1024 * 1024

/**
 * Reset the retry budget? Only for real forward progress that was KEPT — bytes still in a
 * resumable partial (a network failure) or a validated file. Never merely because the WS
 * reconnected (handshakes can succeed while HTTP keeps failing), and never for bytes an attempt
 * then discarded (failed fingerprint, bad status): those would refill the budget forever.
 */
export function earnsRetryBudget(bytesThisAttempt: number, bytesRetained: boolean): boolean {
  return bytesRetained && Number.isFinite(bytesThisAttempt) && bytesThisAttempt >= MEANINGFUL_PROGRESS_BYTES
}

/**
 * The retry count to carry into the next attempt after one ends in failure — by ANY path: the
 * attempt's own error handler, or the stall watchdog aborting it from outside (that attempt never
 * reaches its handler, so the caller must apply this itself). Kept progress resets the streak;
 * anything else leaves it as is (the increment happens when the retry actually fires).
 */
export function retriesAfterFailure(retries: number, bytesThisAttempt: number, bytesRetained: boolean): number {
  return earnsRetryBudget(bytesThisAttempt, bytesRetained) ? 0 : retries
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
