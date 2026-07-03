/**
 * WebSocket message contract between host and clients.
 *
 * One WS carries control, sync, chat and reactions. The host is the hub and the
 * single source of truth: clients never mutate playback directly — they send a
 * `request` and the host broadcasts the resulting `state`. See docs/architecture.md §6.
 */

import type { MediaInfo, ParticipantInfo } from './session'

/** Authoritative playback state, broadcast by the host. */
export interface PlaybackState {
  /** Playhead position in seconds at `hostMonotonicMs`. */
  positionSec: number
  /** Playback rate (1 = normal). */
  rate: number
  isPlaying: boolean
  /**
   * Host MONOTONIC clock reading (ms) when this state was true. Clients convert
   * via their measured offset. Never a wall-clock value. See docs/architecture.md §5.
   */
  hostMonotonicMs: number
  /** The movie reached its end — followers show "The End" even if they never hit EOF locally. */
  ended?: boolean
}

/** Why playback is paused (drives the overlay copy). */
export type PauseReason = 'host' | 'waiting'

/** Actions a client may request; the host decides. */
export type RequestAction = 'pause' | 'resume' | 'seek'

// ── Host → clients ──────────────────────────────────────────────────────────
export type ServerMsg =
  | { t: 'welcome'; sessionId: string; media: MediaInfo; you: string }
  | { t: 'state'; state: PlaybackState }
  | { t: 'pause'; reason: PauseReason; who?: string }
  | { t: 'resume'; atHostMonotonicMs: number } // scheduled resume (future host time)
  // `media` rides along so every client can do its own buffer math (duration/size) — the roster
  // is re-broadcast on every membership change, so late joiners always catch it.
  | { t: 'roster'; participants: ParticipantInfo[]; media?: MediaInfo }
  | { t: 'requestDecision'; id: string; approved: boolean }
  | { t: 'chat'; from: string; text: string; at: number }
  | { t: 'reaction'; from: string; emoji: string; at: number }
  | { t: 'syncPong'; t1: number; t2: number; t3: number }
  | { t: 'ended'; reason: 'host-left' | 'host-ended' }

// ── Client → host ───────────────────────────────────────────────────────────
export type ClientMsg =
  // The host can't tell connections apart (the native WS forwards frames without identity), so
  // every client→host message that must be attributed carries the client's self-assigned `id`
  // (a non-secret correlation handle; the secret is `grant`). The host echoes it in requestDecision.
  //
  // `grant` is a per-client download secret the client mints itself; the host authorizes it
  // on the data plane only when it approves this join (see docs/architecture.md §10).
  | { t: 'join'; id: string; name: string; token: string; grant: string }
  | {
      t: 'heartbeat'
      id: string
      /** The client's own grant — proves the sender owns `id`, so a peer can't spoof its row. */
      grant: string
      /** Fraction of the movie cached so far (0–1) — drives the lobby ring during pre-cache. */
      progress: number
      /** During playback: this follower's player isn't ready (loading) — the host waits for it. */
      stalled?: boolean
      /** This follower's player is live in the show — only then may it hold the room (buffer floor). */
      inShow?: boolean
      bufferedAheadSec: number
      downloadMbps: number
      positionSec: number
    }
  // ACK after a seek / when buffered to start. `grant` proves the sender owns `id`.
  | { t: 'ready'; id: string; grant: string; positionSec: number }
  | { t: 'request'; id: string; action: RequestAction; arg?: number }
  | { t: 'chat'; text: string }
  | { t: 'reaction'; emoji: string }
  | { t: 'syncPing'; t1: number }

export type AnyMsg = ServerMsg | ClientMsg

/** All valid `t` discriminants, for fast validation. */
export const SERVER_MSG_TYPES = [
  'welcome',
  'state',
  'pause',
  'resume',
  'roster',
  'requestDecision',
  'chat',
  'reaction',
  'syncPong',
  'ended',
] as const

export const CLIENT_MSG_TYPES = [
  'join',
  'heartbeat',
  'ready',
  'request',
  'chat',
  'reaction',
  'syncPing',
] as const
