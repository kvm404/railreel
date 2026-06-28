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
  | { t: 'roster'; participants: ParticipantInfo[] }
  | { t: 'requestDecision'; id: string; approved: boolean }
  | { t: 'chat'; from: string; text: string; at: number }
  | { t: 'reaction'; from: string; emoji: string; at: number }
  | { t: 'syncPong'; t1: number; t2: number; t3: number }
  | { t: 'ended'; reason: 'host-left' | 'host-ended' }

// ── Client → host ───────────────────────────────────────────────────────────
export type ClientMsg =
  // `grant` is a per-client download secret the client mints itself; the host authorizes it
  // on the data plane only when it approves this join (see docs/architecture.md §10).
  | { t: 'join'; name: string; token: string; grant: string }
  | {
      t: 'heartbeat'
      bufferedAheadSec: number
      downloadMbps: number
      positionSec: number
    }
  | { t: 'ready'; positionSec: number } // ACK after a seek / when buffered to start
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
