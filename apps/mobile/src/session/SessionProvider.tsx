import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PermissionsAndroid, Platform } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import * as LegacyFS from 'expo-file-system/legacy'
import {
  awaitOwnership,
  clearSessionCache,
  configureCacheStorage,
  createExpoFileSystemAdapter,
  createOwnershipQueue,
  type OwnershipQueue,
  encodeKeptMovieMeta,
  findKeptCacheFiles,
  getCacheStatus,
  getMovieCachePath,
  getMovieMetaPath,
  getSubtitleCachePath,
  isKeptMovieIntact,
  keptReuseDecision,
  parseKeptMovieMeta,
  sweepOrphanCache,
  type CacheStatus,
  type ClearCacheResult,
  type OrphanSweepResult,
} from '@/lib/storage'

import RailReelHost from '../../modules/railreel-host'
import { openSyncSession, type SyncSession } from '@/net/syncClient'
import { reconnectDelayMs } from '@/lib/net/backoff'
import {
  isTransferStalled,
  MAX_INTEGRITY_RETRIES,
  MAX_TRANSFER_RETRIES,
  resumeOffset,
  shouldAutoResume,
  retriesAfterFailure,
  unvalidatedProgress,
  transferResultOk,
  transferRetryDelayMs,
} from '@/lib/net/transfer'
import {
  appendCapped,
  isValidReaction,
  sanitizeChatText,
  type ChatEntry,
  type ReactionEvent,
} from '@/lib/social/feed'
import { mediaVerdict } from '@/lib/media/compat'
import { batteryWarning, decodeWarning, storageWarning } from '@/lib/media/preflight'
import { downloadBufferedAheadSec, smoothedMbps, updateFloorHolds } from '@/lib/sync/startGate'
import { randomBytes } from '@/net/random'
import {
  decodeJoinUrl,
  encodeJoinUrl,
  generateGrant,
  generateSessionId,
  isMediaInfo,
  isSubtitleMeta,
  isValidSecret,
  isVersionMismatch,
  VERSION_MISMATCH_MESSAGE,
  needsSubtitleFetch,
  newSession,
  parseClientMsg,
  parseServerMsg,
  parseSubtitlePayload,
  recordSubtitlePull,
  SUBTITLE_PULL_TIMEOUT_MS,
  PROTOCOL_VERSION,
  subtitleMeta,
  subtitleRev,
  type JoinPayload,
  type MediaInfo,
  type ParticipantInfo,
  type PlaybackState,
  type SubtitleMeta,
  type SubtitlePull,
} from '@/lib/protocol'
import { parseSrt, type SubtitleCue } from '@/lib/subtitles'
import {
  applyJoin,
  approvalTicket,
  approveWithTicket,
  bind,
  createHostIdentity,
  decideFrame,
  decideJoin,
  forget,
  isApproved,
  openConnection,
  releaseConnection,
  resetHostIdentity,
  ticketValid,
  type HostIdentity,
} from '@/lib/host/identity'

/**
 * Session store: the one place that owns a live RailReel session and survives screen navigation
 * (the host's HTTP/WS servers must stay up from "create" through the lobby and into playback).
 *
 * It wires the native host module + the WS sync client into a single state machine the Create /
 * Join / Lobby screens render. Host and client roles share one store; only one is active at a time.
 *
 * v1 client join is by pasted railreel:// link (mDNS auto-discovery + QR scan land in M6).
 */

const HTTP_PORT = 8493
const WS_PORT = 8492
const KEEP_AWAKE_TAG = 'railreel-host'
const CACHE_DIR = LegacyFS.cacheDirectory ?? ''
const fsAdapter = createExpoFileSystemAdapter(LegacyFS)
configureCacheStorage(CACHE_DIR, fsAdapter)
const MOVIE_CACHE = getMovieCachePath(CACHE_DIR)
const MOVIE_META = getMovieMetaPath(CACHE_DIR) // "Keep & Leave" identity record (lib/storage/keptCache)
const SUBTITLE_CACHE = getSubtitleCachePath(CACHE_DIR)
/** Kept-copy reuse: how long to wait for the roster carrying the host's fingerprint. */
const KEPT_HASH_WAIT_MS = 3000
/** A new transfer attempt waits this long for the previous one to settle before giving up (it
 *  then errors + retries; it never shares MOVIE_CACHE with a possibly-live writer). */
const PREV_ATTEMPT_CEILING_MS = 30_000
/**
 * Who may touch MOVIE_CACHE right now: the startup sweep and every transfer attempt queue here.
 * MODULE scope on purpose — a remounted provider (StrictMode, a Fast Refresh of this module)
 * must inherit an outstanding owner whose native writer may still be running (see
 * lib/storage/ownership). Pinned on globalThis so a Fast Refresh re-evaluating this module keeps
 * the same queue; a full JS reload starts fresh (nothing in JS survives it).
 */
const cacheGlobals = globalThis as {
  __railreelMovieCacheOwner?: OwnershipQueue
  __railreelStartupSweep?: Promise<OrphanSweepResult>
}
const movieCacheOwner = (cacheGlobals.__railreelMovieCacheOwner ??= createOwnershipQueue())
/** A guest's playback request with no decision by now is shown as dismissed (decision lost). */
const PLAYBACK_REQUEST_DEADLINE_MS = 12_000
/** Host: ignore a guest's repeat pull of the same subtitle revision within this window. */
const SUBTITLE_PULL_GAP_MS = 2000
/** A stalled follower that hasn't sent a heartbeat in this long is treated as gone — clear its
 *  stall so it can't hang the room (followers beat every ~500ms during playback). */
const STALE_BEAT_MS = 4000
/** Give up reconnecting (and tear down) after this many failed attempts. */
const MAX_RECONNECT_ATTEMPTS = 8
/** Chat history cap (older lines scroll off; this is a cabin, not an archive). */
const CHAT_LOG_CAP = 200
/** Recent reaction events kept for the floating overlay (it filters by freshness anyway). */
const REACTION_KEEP = 16
/** Minimum gap between our own outgoing reactions (taps are cheap, broadcasts are not). */
const REACTION_SEND_GAP_MS = 250
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export type Role = 'none' | 'host' | 'client'

/** A person in the lobby, as the UI needs them (grant stays host-side only, never in state). */
export type Participant = {
  id: string
  name: string
  status: ParticipantInfo['status']
  progress: number
  downloadMbps: number
  /** Seconds of media between this client's playhead and its download edge (gate + floor math). */
  bufferedAheadSec: number
  /** During playback: this follower's player is loading and the room is waiting on it. */
  stalled: boolean
  /** This follower's player is live in the show (buffer-floor holds apply only then). */
  inShow: boolean
  /** False when this device's decoder can't handle the movie's frame size (lobby warns). */
  decodeOk: boolean
  /** Wall-clock ms of the last heartbeat — a stale stall (client gone) is cleared so we don't hang. */
  lastBeatAt: number
}

/** Host phases: picking/launching the servers, then live and accepting guests. */
export type HostPhase = 'idle' | 'starting' | 'live'
/** Client phases from connect through approval, download, and ready. */
export type ClientPhase =
  | 'idle'
  | 'connecting'
  | 'requested'
  | 'approved'
  | 'downloading'
  | 'ready'
  | 'denied'

export interface SessionStore {
  role: Role
  error: string | null
  /** durationSec 0 (probe failed) or fastStart false degrade the start gate to full pre-cache. */
  movie: { title: string; sizeBytes: number; durationSec: number; fastStart: boolean } | null
  participants: Participant[]

  // host
  hostPhase: HostPhase
  joinUrl: string | null
  joinCode: string | null
  hostIp: string | null

  // client
  clientPhase: ClientPhase
  progress: number // this client's own download fraction
  hostName: string | null
  /** Client: the WS dropped and we're re-handshaking with backoff (the Player shows "Reconnecting…"). */
  reconnecting: boolean
  /** Client: this phone's decoder can't handle the movie (lobby warning; also reported to host). */
  decodeCaution: string | null
  /** Host: preflight warning while hosting (battery, for now). */
  hostWarning: string | null
  /** An abnormal end (host left, lost signal) that Home surfaces as a designed StatusScreen. */
  sessionEnd: SessionEnd | null

  // playback (the show)
  /** The local movie file the player should open (host: the picked source; client: the cached copy). */
  movieUri: string | null
  /** Latest authoritative playback state. Host owns it; clients receive it over WS. */
  playback: PlaybackState | null
  /** Host view: names of followers whose player is currently stalled (the room waits on them). */
  waitingFor: string[]

  // social (the cabin)
  /** Chat history, host-ordered, capped — newest last. Own lines carry `from: 'You'`. */
  chatLog: ChatEntry[]
  /** Recent reaction events for the floating overlay (UI filters by freshness). */
  reactions: ReactionEvent[]
  /**
   * Send a chat line to the room (host broadcasts; a guest routes via the host). Returns whether
   * the line was accepted: false for empty text, or for a guest whose link to the host is down or
   * reconnecting — the caller keeps the draft.
   */
  sendChat: (text: string) => boolean
  /** Send a floating emoji reaction to the room. */
  sendReaction: (emoji: string) => void

  // actions
  startHost: () => Promise<void>
  /** Recompute the join link from the current device IP (call after enabling the hotspot). */
  refreshJoin: () => void
  /** Host: publish a new playback state (play/pause/seek), stamped + broadcast to clients. */
  setHostPlayback: (positionSec: number, isPlaying: boolean, rate?: number, ended?: boolean) => void
  /** Client: report whether our player is keeping up (host pauses the room while any are stalled). */
  reportPlayback: (stalled: boolean, positionSec: number) => void
  /** Client: current host-monotonic time (for drift math); host: its own monotonic clock. */
  hostNowMs: () => number
  approve: (id: string) => void
  deny: (id: string) => void
  connect: (joinLink: string, name: string) => Promise<void>
  leave: () => void
  /** Follower: left the player screen to return to lobby */
  userLeftShow: boolean
  exitShow: () => void
  enterShow: () => void
  /** Client: retry a failed download without re-joining (the grant + approval still stand). */
  retryDownload: () => void
  /** Clear the session-end status once the user acknowledges it. */
  dismissEnd: () => void

  // subtitles
  /** Active subtitle state (parsed cues + metadata) for synchronized rendering. */
  subtitle: SubtitleState | null
  /** Attach an .srt subtitle file (parsed into cues, persisted, and distributed to followers). */
  attachSubtitle: (name: string, content: string) => Promise<void>
  /** Remove currently attached subtitles. */
  removeSubtitle: () => void

  // playback moderation
  pendingPlaybackRequests: PendingPlaybackRequest[]
  handlePlaybackRequest: (requestId: string, approved: boolean) => void
  playbackRequestStatus: PlaybackRequestStatus
  sendPlaybackRequest: (action: 'pause' | 'rewind', seconds?: number) => void
  clearPlaybackRequestStatus: () => void
  registerHostTransport: (handler: HostTransportHandler | null) => void

  // cache management
  cacheStatus: CacheStatus | null
  getCacheInfo: () => Promise<CacheStatus>
  /** Resolves with what was actually deleted — `ok: false` / `remainingBytes` when something survived. */
  purgeCache: (options?: { movie?: boolean; subtitles?: boolean }) => Promise<ClearCacheResult>
}

export type PlaybackRequestStatus = 'idle' | 'pending' | 'approved' | 'dismissed'

export interface PendingPlaybackRequest {
  requestId: string
  requesterId: string
  requesterName: string
  action: 'pause' | 'rewind'
  seconds?: number
  receivedAt: number
}

export interface HostTransportHandler {
  pause: () => void
  seekTo: (positionSec: number) => void
  getCurrentPosition: () => number
  isPlaying: () => boolean
}

export interface SubtitleState {
  name: string
  content: string
  /** Content revision (subtitleRev) — identity for reloads, so a same-name replacement isn't missed. */
  rev: string
  cues: SubtitleCue[]
}

/** A designed end-of-the-road moment (see components/StatusScreen). */
export type SessionEnd = {
  kind: 'host-ended' | 'lost'
  eyebrow: string
  headline: string
  body: string
}

const SessionContext = createContext<SessionStore | null>(null)

export function useSession(): SessionStore {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used within <SessionProvider>')
  return ctx
}

/** Host's grant for a participant — kept out of UI state so it can never leak into a render/log. */
type GrantMap = Map<string, string>

export function SessionProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<Role>('none')
  const [error, setError] = useState<string | null>(null)
  const [movie, setMovie] = useState<{ title: string; sizeBytes: number; durationSec: number; fastStart: boolean } | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])

  const [hostPhase, setHostPhase] = useState<HostPhase>('idle')
  const [joinUrl, setJoinUrl] = useState<string | null>(null)
  const [joinCode, setJoinCode] = useState<string | null>(null)
  const [hostIp, setHostIp] = useState<string | null>(null)

  const [clientPhase, setClientPhase] = useState<ClientPhase>('idle')
  const [progress, setProgress] = useState(0)
  const [reconnecting, setReconnecting] = useState(false)
  // Reserved for M6 when the join link carries the host's name; null in M5.
  const [hostName] = useState<string | null>(null)
  const [movieUri, setMovieUri] = useState<string | null>(null)
  const [playback, setPlayback] = useState<PlaybackState | null>(null)
  const playbackRef = useRef<PlaybackState | null>(null)
  playbackRef.current = playback

  // Playback moderation state (host & follower)
  const [pendingPlaybackRequests, setPendingPlaybackRequests] = useState<PendingPlaybackRequest[]>([])
  const pendingPlaybackRequestsRef = useRef<PendingPlaybackRequest[]>([])
  const autoDismissTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const hostTransportRef = useRef<HostTransportHandler | null>(null)

  const [playbackRequestStatus, setPlaybackRequestStatus] = useState<PlaybackRequestStatus>('idle')
  const activeRequestIdRef = useRef<string | null>(null)
  const dismissToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [chatLog, setChatLog] = useState<ChatEntry[]>([])
  const [reactions, setReactions] = useState<ReactionEvent[]>([])
  const [subtitle, setSubtitle] = useState<SubtitleState | null>(null)
  const subtitleRef = useRef<SubtitleState | null>(null)
  subtitleRef.current = subtitle
  const reactionSeqRef = useRef(0) // animation keys + lane assignment for incoming reactions
  const lastReactionSentRef = useRef(0) // client-side reaction rate limit
  const [decodeCaution, setDecodeCaution] = useState<string | null>(null)
  const [hostWarning, setHostWarning] = useState<string | null>(null)
  const [userLeftShow, setUserLeftShow] = useState(false)
  const [sessionEnd, setSessionEnd] = useState<SessionEnd | null>(null)
  const [cacheStatus, setCacheStatus] = useState<CacheStatus | null>(null)
  const decodeOkRef = useRef(true) // rides every heartbeat so the host's lobby can flag us
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const downloadingRef = useRef(false) // synchronous re-entrancy guard for startDownload
  const clientPhaseRef = useRef<ClientPhase>('idle')

  // Mutable session handles + identity, read from listeners without stale closures.
  const roleRef = useRef<Role>('none')
  const hostTokenRef = useRef<string | null>(null)
  const grantsRef = useRef<GrantMap>(new Map())
  const participantsRef = useRef<Participant[]>([])
  const clientRef = useRef<{ session: SyncSession; payload: JoinPayload; grant: string; myId: string; name: string } | null>(null)
  const lastBeatRef = useRef(0)
  const leavingRef = useRef(false) // a deliberate leave() is in progress — don't try to reconnect
  const reconnectingRef = useRef(false) // a reconnect loop is already running
  const reconnectRef = useRef<() => void>(() => {})
  const approvedRef = useRef(false) // host has approved us — a reconnect must NOT re-join (that would reset us to 'requested')
  const epochRef = useRef(0) // bumps on every connect()/leave() so an in-flight reconnect loop can detect it's stale and bail
  // Epoch of the startHost() attempt still in flight (null when none). During startup the native
  // servers can be up while roleRef is still 'none', so leave() needs this to know to stop them.
  const hostStartRef = useRef<number | null>(null)
  // Enough to rebuild the join link if the reachable IP changes (e.g. after the hotspot comes up).
  const joinMetaRef = useRef<{ sessionId: string; token: string; httpPort: number; wsPort: number } | null>(null)
  const downloadRef = useRef<LegacyFS.DownloadResumable | null>(null)
  // Download/playback telemetry for heartbeats (refs: read by beats fired from timers + callbacks).
  const mediaRef = useRef<MediaInfo | null>(null) // host: what it shares; client: from the roster
  const progressRef = useRef(0)
  const mbpsRef = useRef(0)
  const mbpsSampleRef = useRef<{ bytes: number; ms: number } | null>(null)
  const positionRef = useRef(0) // this client's playhead (0 until the show starts)
  const stalledRef = useRef(false) // player-not-ready, debounced by the PlayerScreen
  const inShowRef = useRef(false) // our player is live (only an in-show client may hold the room)
  // Playback-proxy lifecycle (client). 'starting' claims synchronously so racing progress
  // callbacks can't double-start; 'failed' pins the pre-cache fallback (no native retry storm).
  const proxyStateRef = useRef<'idle' | 'starting' | 'up' | 'failed'>('idle')
  // Proxy generation: bumped whenever the proxy must let go of the file (fresh restart, session
  // reset). An in-flight startProxy from an older generation must not publish its URL; it stops
  // the proxy it started only if no newer start has been issued since (stopProxy is global).
  const proxyGenRef = useRef(0)
  const proxyIssuedGenRef = useRef(0)
  const proxyStartRef = useRef<Promise<void> | null>(null)
  // Transfer attempt generation: bumped by resetTransfer and by a forced restart, so every await
  // in a superseded attempt bails without touching state, telemetry or MOVIE_CACHE.
  const attemptRef = useRef(0)
  // (The cache-ownership queue every attempt joins is module-level: movieCacheOwner.)
  // Epoch whose transfer wrote the partial MOVIE_CACHE (null: none, or not a clean prefix). Only
  // that partial may be resumed with a Range request.
  const partialEpochRef = useRef<number | null>(null)
  // The stall watchdog's clocks: when this attempt's request went out, and its latest progress
  // event (0 = no byte yet → the longer initial-response grace applies).
  const transferStartedAtRef = useRef(0)
  const lastProgressAtRef = useRef(0)
  // Consecutive fully-downloaded copies that failed validation — a separate, small budget
  // (lib/net/transfer MAX_INTEGRITY_RETRIES); discarded bytes never earn retry credit.
  const integrityFailuresRef = useRef(0)
  // Bytes the running attempt has pulled beyond its resume offset (retry credit, see transfer.ts).
  const attemptBytesRef = useRef(0)
  // The provider has unmounted: socket handlers, timers and async entry points must not act.
  const disposedRef = useRef(false)
  // The movie is cached AND validated (status, size, fingerprint). Byte progress is capped below 1
  // until then, so neither the host nor the retry logic mistakes "all bytes read" for "ready".
  const completeRef = useRef(false)
  // An automatic retry's backoff elapsed while the WS was re-handshaking; reconnect fires it.
  const retryPendingRef = useRef(false)
  const transferRetriesRef = useRef(0) // automatic retries spent in the current failure streak
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startDownloadRef = useRef<(opts?: { resume?: boolean }) => Promise<void>>(async () => {})
  // Subtitles (client): the roster's latest subtitle metadata, and our outstanding pull on this
  // connection (so a roster storm can't become a request storm, yet a lost reply is re-asked).
  const rosterSubtitleRef = useRef<SubtitleMeta | null>(null)
  const subtitlePullRef = useRef<SubtitlePull | null>(null)
  const subtitlePullTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Subtitles (host): last pull answered per CONNECTION (a rebind after a reconnect is a new
  // connection, so its request is never suppressed by the dead socket's cooldown).
  const subtitlePullsRef = useRef<Map<string, { rev: string; at: number }>>(new Map())
  const sendSubtitleToRef = useRef<(id: string) => void>(() => {})
  // Guest playback request still awaiting a decision (cleared on decision, deadline, reconnect).
  const requestDeadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Mount (and StrictMode's re-mount, which reuses these refs): we're live again.
    disposedRef.current = false
    return () => {
      // Disposed: socket handlers, reconnect, timers and async entry points all check this.
      disposedRef.current = true
      leavingRef.current = true // no reconnect loop may start (or continue) from a dead provider
      reconnectingRef.current = false
      if (clientRef.current) {
        clientRef.current.session.close()
        clientRef.current = null
      }
      if (subtitlePullTimerRef.current) clearTimeout(subtitlePullTimerRef.current)
      subtitlePullTimerRef.current = null
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current)
        stopTimerRef.current = null
      }
      autoDismissTimersRef.current.forEach((t) => clearTimeout(t))
      autoDismissTimersRef.current.clear()
      if (dismissToastTimerRef.current) {
        clearTimeout(dismissToastTimerRef.current)
        dismissToastTimerRef.current = null
      }
      if (requestDeadlineRef.current) clearTimeout(requestDeadlineRef.current)
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
      // Invalidate ownership: every in-flight continuation (transfer awaits, proxy start, retry
      // and reconnect timers) checks the epoch/attempt and bails instead of updating a dead
      // provider or arming new work. The native download is cancelled; its attempt stays in the
      // module-level movieCacheOwner queue, so a remounted provider waits for the writer to stop.
      epochRef.current++
      attemptRef.current++
      proxyGenRef.current++
      downloadRef.current?.cancelAsync().catch(() => {})
      downloadRef.current = null
      downloadingRef.current = false
    }
  }, [])

  useEffect(() => {
    roleRef.current = role
  }, [role])

  useEffect(() => {
    clientPhaseRef.current = clientPhase
  }, [clientPhase])

  // Host preflight: while hosting, keep an eye on the battery — the host phone IS the session
  // (PRD §8), so "plug in" needs saying before the movie dies with it.
  useEffect(() => {
    if (role !== 'host') return
    const check = () => {
      const b = RailReelHost.getBatteryStatus()
      setHostWarning(batteryWarning(b.level, b.charging))
    }
    check()
    const id = setInterval(check, 60_000)
    return () => clearInterval(id)
  }, [role])

  // ── host roster helpers ─────────────────────────────────────────────────────
  const rosterJson = useCallback((list: Participant[]): string => {
    const payload: ParticipantInfo[] = list.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      progress: p.progress,
      bufferedAheadSec: p.bufferedAheadSec,
      downloadMbps: p.downloadMbps,
      decodeOk: p.decodeOk,
    }))
    // media rides along so clients can do their own buffer math (duration/size).
    const media = mediaRef.current ?? undefined
    return JSON.stringify({ t: 'roster', participants: payload, media })
  }, [])
  // Native broadcast reaches approved connections only — a pending requester never sees the
  // roster, the media (incl. subtitle text) or any room traffic.
  const broadcastRoster = useCallback(
    (list: Participant[]) => {
      RailReelHost.broadcast(rosterJson(list)).catch(() => {})
    },
    [rosterJson],
  )

  // Update participants everywhere at once: ref (for listeners), state (for render), and — when
  // hosting — the broadcast so every client's lobby mirrors the host's.
  const updateParticipants = useCallback(
    (fn: (prev: Participant[]) => Participant[], broadcast = true) => {
      const next = fn(participantsRef.current)
      participantsRef.current = next
      setParticipants(next)
      if (broadcast && roleRef.current === 'host') broadcastRoster(next)
    },
    [broadcastRoster],
  )

  // Fold an incoming, already-validated chat line / reaction into local state. Reactions get a
  // local sequence for animation keys + lane assignment; freshness is judged by local receipt
  // time so cross-device clock skew can't strand or fast-expire an animation.
  // Chat lines get a local monotonic id: stable list keys + the unread cursor (works past the cap).
  const chatSeqRef = useRef(0)
  const ingestChat = useCallback((from: string, text: string, at: number) => {
    const id = ++chatSeqRef.current
    setChatLog((log) => appendCapped(log, { id, from, text, at }, CHAT_LOG_CAP))
  }, [])
  const ingestReaction = useCallback((from: string, emoji: string) => {
    const seq = ++reactionSeqRef.current
    setReactions((r) => appendCapped(r, { seq, from, emoji, at: Date.now() }, REACTION_KEEP))
  }, [])

  // ── subtitle helpers ────────────────────────────────────────────────────────
  const loadSubtitle = useCallback(async (name: string, content: string, rev?: string) => {
    try {
      const cues = parseSrt(content)
      const sub: SubtitleState = { name, content, rev: rev ?? subtitleRev(content), cues }
      subtitleRef.current = sub
      setSubtitle(sub)
      await LegacyFS.writeAsStringAsync(SUBTITLE_CACHE, content, {
        encoding: LegacyFS.EncodingType.UTF8,
      }).catch(() => {})
    } catch {
      // Best-effort: invalid subtitle or failed write
    }
  }, [])

  const clearSubtitle = useCallback(async () => {
    subtitleRef.current = null
    setSubtitle(null)
    await LegacyFS.deleteAsync(SUBTITLE_CACHE, { idempotent: true }).catch(() => {})
  }, [])

  const attachSubtitle = useCallback(
    async (name: string, content: string) => {
      const meta = subtitleMeta(name, content)
      await loadSubtitle(name, content, meta.rev)
      // The roster carries only metadata (it's re-broadcast on every download percent); the body
      // goes out once here, and again to any guest that pulls the revision (sendSubtitleTo).
      if (mediaRef.current) mediaRef.current = { ...mediaRef.current, subtitle: meta }
      if (roleRef.current === 'host') {
        subtitlePullsRef.current.clear() // a new revision — every guest may pull it once
        RailReelHost.broadcast(JSON.stringify({ t: 'subtitle', name, content, rev: meta.rev })).catch(() => {})
        broadcastRoster(participantsRef.current)
      }
    },
    [loadSubtitle, broadcastRoster],
  )


  const removeSubtitle = useCallback(() => {
    clearSubtitle()
    if (mediaRef.current?.subtitle) {
      const { subtitle: _, ...rest } = mediaRef.current
      mediaRef.current = rest
    }
    if (roleRef.current === 'host') {
      RailReelHost.broadcast(JSON.stringify({ t: 'subtitle', name: '', content: '' })).catch(() => {})
      broadcastRoster(participantsRef.current)
    }
  }, [clearSubtitle, broadcastRoster])

  // ── host identity ───────────────────────────────────────────────────────────
  /** A host socket that hasn't joined / resumed within this long is closed (see the WS wiring). */
  const UNBOUND_SOCKET_MS = 15_000
  // Every frame/close arrives tagged with a native connection id; a participant id is trusted only
  // on the connection it was bound to (see lib/host/identity). Shares grantsRef's map, so the
  // session-boundary clears of grants also void every approval (approval is keyed to its grant).
  const hostIdRef = useRef<HostIdentity | null>(null)
  const hostIds = useCallback((): HostIdentity => {
    if (!hostIdRef.current) hostIdRef.current = createHostIdentity(grantsRef.current)
    return hostIdRef.current
  }, [])
  useEffect(() => {
    if (role !== 'host') resetHostIdentity(hostIds())
  }, [role, hostIds])

  // Targeted roster for a socket that just became approved (it missed the broadcasts so far).
  const sendRosterTo = useCallback(
    (conn: string) => {
      RailReelHost.sendTo(conn, rosterJson(participantsRef.current)).catch(() => {})
    },
    [rosterJson],
  )

  // Host: deliver the current subtitle body to ONE guest, on the connection its identity is bound
  // to — its pull (`subtitleRequest`, sent when the roster names a revision it lacks: just
  // approved, or reconnected after a replacement). Only an approved, live guest gets it; each may
  // pull a given revision once per SUBTITLE_PULL_GAP_MS.
  const sendSubtitleTo = useCallback(
    (id: string) => {
      if (roleRef.current !== 'host' || id === 'host') return
      const ids = hostIds()
      const conn = ids.connOf.get(id)
      if (!conn || !isApproved(ids, id)) return
      const sub = subtitleRef.current
      if (!sub) return // nothing attached — the roster (no subtitle) already tells it to clear
      // Cooldown per CONNECTION: a guest that reconnected (rebound to a new socket) right after
      // a reply was lost with the old one must get its fresh request answered.
      const now = Date.now()
      const last = subtitlePullsRef.current.get(conn)
      if (last && last.rev === sub.rev && now - last.at < SUBTITLE_PULL_GAP_MS) return
      if (subtitlePullsRef.current.size > 64) subtitlePullsRef.current.clear() // dead sockets' entries
      subtitlePullsRef.current.set(conn, { rev: sub.rev, at: now })
      RailReelHost.sendTo(conn, JSON.stringify({ t: 'subtitle', name: sub.name, content: sub.content, rev: sub.rev })).catch(() => {})
    },
    [hostIds],
  )
  sendSubtitleToRef.current = sendSubtitleTo

  // ── WS event wiring (host side; registered once) ────────────────────────────
  useEffect(() => {
    // A departed guest's pending moderation requests go with it (their timers would fire into nothing).
    const dropRequestsOf = (id: string) => {
      const userReqs = pendingPlaybackRequestsRef.current.filter((r) => r.requesterId === id)
      if (userReqs.length === 0) return
      userReqs.forEach((r) => {
        const t = autoDismissTimersRef.current.get(r.requestId)
        if (t) {
          clearTimeout(t)
          autoDismissTimersRef.current.delete(r.requestId)
        }
      })
      pendingPlaybackRequestsRef.current = pendingPlaybackRequestsRef.current.filter((r) => r.requesterId !== id)
      setPendingPlaybackRequests(pendingPlaybackRequestsRef.current)
    }
    const markLeft = (id: string) => {
      dropRequestsOf(id)
      updateParticipants(
        (prev) => prev.map((p) => (p.id === id ? { ...p, status: 'left', stalled: false, inShow: false } : p)),
        true,
      )
    }
    // Admit a grant-proven frame on `conn` acting for `id`. Everything a guest does once inside
    // needs APPROVAL (not merely a non-"requested" row): a never-approved guest that dropped and
    // came back must not promote itself. An approved guest's first frame on a new socket rebinds
    // it (the silent reconnect) — re-admit that socket natively and retire the old one.
    const admit = (conn: string, id: unknown, grant: unknown, needsApproval: boolean): boolean => {
      const ids = hostIds()
      const d = decideFrame(ids, conn, id, grant, needsApproval)
      if (d.kind === 'reject') return false
      if (d.bind && typeof id === 'string') {
        bind(ids, conn, id)
        if (d.supersedes) RailReelHost.dropConnection(d.supersedes).catch(() => {})
        RailReelHost.approveConnection(conn)
          .then(() => sendRosterTo(conn))
          .catch(() => {})
      }
      return true
    }

    const onMessage = RailReelHost.addListener('onWsMessage', ({ data, conn }) => {
      if (roleRef.current !== 'host') return
      const r = parseClientMsg(data)
      if (!r.ok) return
      const msg = r.msg
      if (msg.t === 'join') {
        // Trust only a well-formed join for the current session before it can reach approve().
        if (
          msg.token !== hostTokenRef.current ||
          !isValidSecret(msg.grant, 22) ||
          typeof msg.id !== 'string' ||
          msg.id.length === 0 ||
          msg.id === 'host' ||
          typeof msg.name !== 'string' ||
          msg.name.length === 0
        ) {
          return
        }
        const ids = hostIds()
        // A join can't re-claim an id under a different grant, nor switch this socket's identity.
        const d = decideJoin(ids, conn, msg.id, msg.grant)
        if (d.kind === 'reject') return
        applyJoin(ids, conn, msg.id, msg.grant, d)
        if (d.supersedes) RailReelHost.dropConnection(d.supersedes).catch(() => {})
        const joinId = msg.id
        const name = msg.name.slice(0, 40)
        if (d.kind === 'resume') {
          // Approved while it was away and it missed the decision: re-admit this socket, repeat
          // the decision to it alone, and keep its row (no reset to "requested"). Roster (movie
          // metadata) first — the decision starts its download. Re-check after every await: a
          // deny / leave / takeover in between must not get an "approved" sent after it.
          const live = () => ids.idOf.get(conn) === joinId && isApproved(ids, joinId)
          void (async () => {
            await RailReelHost.approveConnection(conn).catch(() => false)
            if (!live()) return
            await RailReelHost.sendTo(conn, rosterJson(participantsRef.current)).catch(() => false)
            if (!live()) return
            RailReelHost.sendTo(conn, JSON.stringify({ t: 'requestDecision', id: joinId, approved: true })).catch(() => {})
          })()
          updateParticipants((prev) =>
            prev.some((p) => p.id === joinId)
              ? prev.map((p) => (p.id === joinId && p.status === 'left' ? { ...p, status: 'approved', lastBeatAt: Date.now() } : p))
              : [...prev, { id: joinId, name, status: 'approved', progress: 0, downloadMbps: 0, bufferedAheadSec: 0, stalled: false, inShow: false, decodeOk: true, lastBeatAt: Date.now() }],
          )
          return
        }
        updateParticipants((prev) => {
          const without = prev.filter((p) => p.id !== joinId)
          return [...without, { id: joinId, name, status: 'requested', progress: 0, downloadMbps: 0, bufferedAheadSec: 0, stalled: false, inShow: false, decodeOk: true, lastBeatAt: Date.now() }]
        })
      } else if (msg.t === 'heartbeat') {
        if (!Number.isFinite(msg.progress) || !admit(conn, msg.id, msg.grant, true)) return
        const mbps = Number.isFinite(msg.downloadMbps) ? msg.downloadMbps : 0
        const buffered = Number.isFinite(msg.bufferedAheadSec) && msg.bufferedAheadSec >= 0 ? msg.bufferedAheadSec : 0
        const newStatus = msg.progress >= 1 ? 'ready' : 'downloading'
        const newProgress = clamp01(msg.progress)
        // Only re-broadcast the roster when a roster-visible change happened — and progress only
        // counts in whole percents, or every heartbeat from every downloader would fan out an
        // O(N) roster to N clients ~3×/s on the same hotspot carrying the movie bytes.
        const prevP = participantsRef.current.find((p) => p.id === msg.id)
        const rosterChanged =
          !prevP ||
          (prevP.status !== 'requested' &&
            (prevP.status !== newStatus || Math.round(prevP.progress * 100) !== Math.round(newProgress * 100)))
        updateParticipants(
          (prev) =>
            prev.map((p) =>
              p.id === msg.id && p.status !== 'requested'
                ? {
                    ...p,
                    progress: newProgress,
                    downloadMbps: mbps,
                    bufferedAheadSec: buffered,
                    stalled: msg.stalled === true,
                    inShow: msg.inShow === true,
                    decodeOk: msg.decodeOk !== false,
                    status: newStatus,
                    lastBeatAt: Date.now(),
                  }
                : p,
            ),
          rosterChanged,
        )
      } else if (msg.t === 'ready') {
        if (!admit(conn, msg.id, msg.grant, true)) return
        updateParticipants((prev) =>
          prev.map((p) => (p.id === msg.id && p.status !== 'requested' ? { ...p, status: 'ready', progress: 1 } : p)),
        )
      } else if (msg.t === 'playbackRequest') {
        if (!admit(conn, msg.id, msg.grant, true)) return
        const sender = participantsRef.current.find((p) => p.id === msg.id)
        if (!sender) return
        if (msg.action !== 'pause' && msg.action !== 'rewind') return
        if (typeof msg.requestId !== 'string' || msg.requestId.length === 0) return
        if (pendingPlaybackRequestsRef.current.some((r) => r.requestId === msg.requestId)) return

        const req: PendingPlaybackRequest = {
          requestId: msg.requestId,
          requesterId: msg.id,
          requesterName: sender.name || 'Guest',
          action: msg.action,
          seconds: typeof msg.seconds === 'number' && msg.seconds > 0 ? msg.seconds : (msg.action === 'rewind' ? 15 : undefined),
          receivedAt: Date.now(),
        }

        pendingPlaybackRequestsRef.current = [...pendingPlaybackRequestsRef.current, req]
        setPendingPlaybackRequests(pendingPlaybackRequestsRef.current)

        const timer = setTimeout(() => {
          handlePlaybackRequestRef.current(req.requestId, false)
        }, 10_000)
        autoDismissTimersRef.current.set(req.requestId, timer)
      } else if (msg.t === 'leave') {
        // A pending requester may withdraw too, so no approval needed — only the bound grant.
        if (!admit(conn, msg.id, msg.grant, false)) return
        const leftId = msg.id
        // Revoke the data-plane grant BEFORE forgetting it, or the departed guest could keep
        // issuing fresh movie requests while the session runs.
        RailReelHost.revoke(msg.grant).catch(() => {})
        const leftConn = forget(hostIds(), leftId)
        if (leftConn) RailReelHost.dropConnection(leftConn).catch(() => {})
        markLeft(leftId)
      } else if (msg.t === 'chat') {
        // Hub: validate ownership + approval + content, stamp the sender's NAME and our clock, fan out.
        if (!admit(conn, msg.id, msg.grant, true)) return
        const sender = participantsRef.current.find((p) => p.id === msg.id)
        if (!sender) return
        const text = sanitizeChatText(typeof msg.text === 'string' ? msg.text : '')
        if (!text) return
        const name = sender.name ?? 'Guest'
        const at = Date.now()
        RailReelHost.broadcast(JSON.stringify({ t: 'chat', from: name, fromId: msg.id, text, at })).catch(() => {})
        ingestChat(name, text, at)
      } else if (msg.t === 'reaction') {
        if (!isValidReaction(msg.emoji) || !admit(conn, msg.id, msg.grant, true)) return
        const sender = participantsRef.current.find((p) => p.id === msg.id)
        if (!sender) return
        const name = sender.name ?? 'Guest'
        RailReelHost.broadcast(JSON.stringify({ t: 'reaction', from: name, fromId: msg.id, emoji: msg.emoji, at: Date.now() })).catch(() => {})
        ingestReaction(name, msg.emoji)
      } else if (msg.t === 'subtitleRequest') {
        // Approved, connection-bound senders only; the body goes back to that connection alone.
        if (!admit(conn, msg.id, msg.grant, true)) return
        sendSubtitleToRef.current(msg.id)
      }
    })
    // The session token is discoverable (mDNS TXT), so a socket must identify itself promptly — a
    // real client sends `join` (or, reconnecting, a heartbeat) right after its clock handshake.
    // Anything still unbound after UNBOUND_SOCKET_MS is closed so idlers can't hold slots.
    const unboundTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const onOpen = RailReelHost.addListener('onWsOpen', ({ conn }) => {
      // Recorded whatever the role: the servers come up inside startHost() before role flips to
      // 'host', and a socket opened in that window must still be able to join. Only live
      // connections may act (lib/host/identity); native orders open strictly before close.
      openConnection(hostIds(), conn)
      unboundTimers.set(
        conn,
        setTimeout(() => {
          unboundTimers.delete(conn)
          if (!hostIds().idOf.has(conn)) RailReelHost.dropConnection(conn).catch(() => {})
        }, UNBOUND_SOCKET_MS),
      )
    })
    // A close affects only the participant bound to THAT connection (never an id a frame claimed).
    // Grant + approval survive it, so an approved guest resumes silently on reconnect.
    const onClose = RailReelHost.addListener('onWsClose', ({ conn }) => {
      const t = unboundTimers.get(conn)
      if (t) {
        clearTimeout(t)
        unboundTimers.delete(conn)
      }
      const id = releaseConnection(hostIds(), conn) // always: keeps the live set exact
      if (id && roleRef.current === 'host') markLeft(id)
    })
    return () => {
      onMessage.remove()
      onOpen.remove()
      onClose.remove()
      unboundTimers.forEach((t) => clearTimeout(t))
      unboundTimers.clear()
    }
  }, [updateParticipants, hostIds, sendRosterTo, rosterJson, ingestChat, ingestReaction])

  // Host: a client whose heartbeats have gone quiet (left / backgrounded / crashed) must stop
  // holding the room — clear the flags that make it count (stalled, inShow). The next live beat
  // re-reports both, so a client that comes back is held again if it genuinely needs it.
  useEffect(() => {
    const id = setInterval(() => {
      if (roleRef.current !== 'host') return
      const cutoff = Date.now() - STALE_BEAT_MS
      const goneQuiet = (p: Participant): boolean =>
        p.id !== 'host' && p.lastBeatAt < cutoff && (p.stalled || p.inShow)
      updateParticipants(
        (prev) =>
          prev.some(goneQuiet)
            ? prev.map((p) => (goneQuiet(p) ? { ...p, stalled: false, inShow: false } : p))
            : prev,
        false,
      )
    }, 1000)
    return () => clearInterval(id)
  }, [updateParticipants])

  // Cancel any in-flight transfer and zero all transfer telemetry. MOVIE_CACHE is one shared
  // path and the gate's ETA math trusts these refs, so EVERY session boundary (leave, a fresh
  // connect, re-hosting) must pass through here — a prior session's dying download otherwise
  // keeps feeding near-zero Mbps into the new session's gate (the "~232 min ETA" bug).
  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }, [])

  const resetTransfer = useCallback(() => {
    attemptRef.current++ // every await of the running attempt now bails
    clearRetryTimer()
    transferRetriesRef.current = 0
    partialEpochRef.current = null
    lastProgressAtRef.current = 0
    transferStartedAtRef.current = 0
    integrityFailuresRef.current = 0
    completeRef.current = false
    retryPendingRef.current = false
    downloadingRef.current = false
    downloadRef.current?.cancelAsync().catch(() => {})
    downloadRef.current = null
    proxyGenRef.current++ // an in-flight startProxy must not publish into whatever comes next
    proxyStartRef.current = null
    RailReelHost.stopProxy().catch(() => {})
    proxyStateRef.current = 'idle'
    progressRef.current = 0
    mbpsRef.current = 0
    mbpsSampleRef.current = null
    positionRef.current = 0
    stalledRef.current = false
    inShowRef.current = false
    setProgress(0)
    setMovieUri(null)
  }, [clearRetryTimer])

  // ── cache management ────────────────────────────────────────────────────────
  const getCacheInfo = useCallback(async (): Promise<CacheStatus> => {
    const status = await getCacheStatus(CACHE_DIR, fsAdapter)
    setCacheStatus(status)
    return status
  }, [])

  const purgeCache = useCallback(
    async (options?: { movie?: boolean; subtitles?: boolean }): Promise<ClearCacheResult> => {
      const result = await clearSessionCache({
        movie: options?.movie,
        subtitles: options?.subtitles,
        cacheDir: CACHE_DIR,
        fs: fsAdapter,
        hooks: {
          detachMedia: async () => {
            setMovieUri(null)
            await RailReelHost.stopProxy().catch(() => {})
          },
          cancelDownloads: async () => {
            resetTransfer()
          },
        },
      })
      if (options?.subtitles !== false) {
        await clearSubtitle()
      }
      await getCacheInfo()
      return result
    },
    [clearSubtitle, getCacheInfo, resetTransfer],
  )

  useEffect(() => {
    // Startup orphan sweep: remove any abandoned cache files from previous crashed sessions —
    // except a copy the user chose to keep ("Keep & Leave") that is still complete. It runs once
    // per JS runtime, queued in the module-level movieCacheOwner: behind any writer a previous
    // provider instance left running, and ahead of every download (whose kept-copy check, deletes
    // and writes then run only after it), so a snapshot keep-set can never delete a movie +
    // record that a download completed meanwhile.
    const startupSweep = (cacheGlobals.__railreelStartupSweep ??= movieCacheOwner.run(async (prev) => {
        await prev // no ceiling: deleting under a live writer is exactly what this prevents
        try {
          const keep = await findKeptCacheFiles(CACHE_DIR, fsAdapter, (uri) => LegacyFS.readAsStringAsync(uri))
          return await sweepOrphanCache(CACHE_DIR, fsAdapter, keep)
        } catch {
          return { sweptFiles: [], reclaimedBytes: 0 }
        }
    }))
    startupSweep
      .then((result) => {
        if (disposedRef.current) return

        if (__DEV__ && result.sweptFiles.length > 0) {
          console.log(
            `[RailReel] Startup orphan sweep reclaimed ${result.reclaimedBytes} bytes across ${result.sweptFiles.length} files`,
          )
        }
        return getCacheInfo()
      })
      .catch(() => {})
  }, [getCacheInfo])

  // ── host actions ────────────────────────────────────────────────────────────
  const startHost = useCallback(async () => {
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
    setUserLeftShow(false)
    setError(null)
    setHostPhase('starting')
    // Re-hosting (or hosting after having been a guest) must not inherit the previous session:
    // stale playback would yank fresh guests straight into the Player, and a leftover download /
    // floor-hold would corrupt the new gate's math. Bump the epoch so any zombie transfer bails.
    epochRef.current++
    // Cancellation: leave() (Back during startup) bumps the epoch. Every await below re-checks it;
    // a stale attempt releases what it acquired and returns WITHOUT touching state, so it can't
    // resurrect a host session behind the Home screen.
    const myEpoch = epochRef.current
    const stale = (): boolean => epochRef.current !== myEpoch
    hostStartRef.current = myEpoch
    let advertised: Promise<void> | null = null
    const abandon = async () => {
      if (hostStartRef.current === myEpoch) hostStartRef.current = null
      // Release the (global) native host and keep-awake only while nothing newer owns them: a newer
      // startHost() claims hostStartRef synchronously (and its native start() re-tears down itself);
      // a live session or a guest's proxy must survive. Re-checked after EVERY await, since a newer
      // attempt can begin while we wait.
      const unowned = () => hostStartRef.current === null && roleRef.current === 'none'
      if (!unowned()) return
      await advertised
      if (!unowned()) return
      await RailReelHost.stopAdvertise().catch(() => {})
      if (!unowned()) return
      await RailReelHost.stop().catch(() => {})
      if (!unowned()) return
      await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {})
    }
    resetTransfer()
    setPlayback(null)
    setFloorHeld(new Set())
    setChatLog([])
    setReactions([])
    clearSubtitle()
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: 'video/*', copyToCacheDirectory: false })
      if (stale()) return // nothing acquired yet
      if (picked.canceled || !picked.assets[0]) {
        hostStartRef.current = null
        setHostPhase('idle')
        return
      }
      const asset = picked.assets[0]

      // Vet the file BEFORE anything is acquired (no servers, no foreground-service notification,
      // no permission prompt): every guest downloads its own copy, so a file the host can play but
      // a guest can't (HEVC/AV1, MKV, AC3…) would cost them GBs and then fail in the player.
      // A probe that throws means the container couldn't be parsed at all → rejected as unreadable.
      // (A MISSING duration on an otherwise-valid MP4 is not a throw: it comes back as 0 and the
      // start gate degrades to full pre-cache, below.)
      const probed = await RailReelHost.probe(asset.uri).catch(() => null)
      if (stale()) return // nothing acquired yet
      const verdict = mediaVerdict(probed)
      if (!verdict.ok || !probed) {
        hostStartRef.current = null
        setError(verdict.ok ? null : verdict.message)
        setHostPhase('idle')
        return
      }

      // Android 13+ needs runtime notification permission for the foreground-service notification.
      if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => {})
        if (stale()) return
      }

      const { sessionId, token } = newSession(randomBytes)
      hostTokenRef.current = token
      const ports = await RailReelHost.start(asset.uri, HTTP_PORT, WS_PORT, token)
      if (stale()) return abandon()
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG)
      if (stale()) return abandon()

      joinMetaRef.current = { sessionId, token, httpPort: ports.httpPort, wsPort: ports.wsPort }
      const ip = RailReelHost.getHostIpAddress()
      setHostIp(ip)

      // Tap-to-join: advertise the session on mDNS. The TXT mirrors the QR payload (the host IP
      // comes from NSD resolution itself, so hotspot IP changes never stale the advert). Anyone
      // on the network can *request* to join — the trust model already assumes that: the host
      // approves every person, and bytes flow only to approved grants (architecture §10).
      advertised = RailReelHost.advertise(`RailReel-${humanCode(sessionId)}`, ports.wsPort, {
        v: String(PROTOCOL_VERSION),
        t: token,
        s: sessionId,
        h: String(ports.httpPort),
        c: humanCode(sessionId),
        n: cleanTitle(asset.name).slice(0, 24),
      }).catch(() => {})
      // Only publish a link once we have a real LAN/hotspot IP — a 0.0.0.0/Wi-Fi address would
      // hand guests an unreachable host. refreshJoin() rebuilds it after the hotspot comes up.
      setJoinUrl(ip ? encodeJoinUrl(buildJoinPayload(joinMetaRef.current, ip)) : null)
      setJoinCode(humanCode(sessionId))

      // Duration powers the progressive start gate (progress → seconds buffered); fastStart says
      // whether a partial copy is even playable. A file without a readable duration still hosts:
      // the gate then degrades to "start after full pre-cache".
      const durationSec = Number.isFinite(probed.durationSec) && probed.durationSec > 0 ? probed.durationSec : 0
      const fastStart = probed.fastStart === true
      const sizeBytes = asset.size ?? 0
      const title = cleanTitle(asset.name)
      mediaRef.current = {
        title,
        sizeBytes,
        durationSec,
        bitrateMbps: durationSec > 0 ? (sizeBytes * 8) / durationSec / 1e6 : 0,
        hash: '', // integrity fingerprint fills in a moment later (off the critical path — below)
        format: '',
        fastStart,
        width: probed.width || 0,
        height: probed.height || 0,
        videoMime: probed.videoMime,
        audioMime: probed.audioMime,
        // Metadata only — the body never rides the roster (see attachSubtitle / sendSubtitleTo).
        ...(subtitleRef.current ? { subtitle: subtitleMeta(subtitleRef.current.name, subtitleRef.current.content) } : {}),
      }
      setMovie({ title, sizeBytes, durationSec, fastStart })
      setMovieUri(asset.uri) // the host plays the same source it shares

      // Seed the roster with the host (it already has the file).
      grantsRef.current.clear()
      // Named "Host" so guests see "Host"; the host's own lobby relabels this entry to "You".
      updateParticipants(() => [{ id: 'host', name: 'Host', status: 'ready', progress: 1, downloadMbps: 0, bufferedAheadSec: Infinity, stalled: false, inShow: false, decodeOk: true, lastBeatAt: Date.now() }], false)

      hostStartRef.current = null
      setRole('host')
      roleRef.current = 'host'
      setHostPhase('live')

      // The QR is up — the show can gather. Compute the integrity fingerprint OFF the critical
      // path so a slow/large file can never stall the invite screen, then patch it into the media
      // and re-broadcast so guests verify their download against it. Downloads take minutes; the
      // fingerprint lands in ~a moment, so the window where a client would skip verification is
      // negligible (and skipping is a safe no-op, not a failure).
      if (sizeBytes > 0) {
        const hostEpoch = epochRef.current
        RailReelHost.fingerprint(asset.uri, sizeBytes)
          .then((hash) => {
            if (epochRef.current !== hostEpoch || !mediaRef.current) return // session changed — drop
            mediaRef.current = { ...mediaRef.current, hash }
            if (roleRef.current === 'host') broadcastRoster(participantsRef.current)
          })
          .catch(() => {})
      }
    } catch (e) {
      if (stale()) return abandon() // the user already left — no error for a screen they're not on
      hostStartRef.current = null
      setError(String(e))
      setHostPhase('idle')
      await RailReelHost.stop().catch(() => {})
      await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {})
    }
  }, [updateParticipants, resetTransfer, broadcastRoster, clearSubtitle])

  // Re-read the device IP and rebuild the join link — call after enabling the hotspot, when the
  // reachable address may have changed (or only just appeared).
  const refreshJoin = useCallback(() => {
    const meta = joinMetaRef.current
    if (!meta) return
    const ip = RailReelHost.getHostIpAddress()
    setHostIp(ip)
    setJoinUrl(ip ? encodeJoinUrl(buildJoinPayload(meta, ip)) : null)
  }, [])

  // Host: publish playback. Stamp it with the host's monotonic clock (the timebase clients sync
  // against) so a follower can compute where the playhead should be right now.
  const setHostPlayback = useCallback((positionSec: number, isPlaying: boolean, rate = 1, ended = false) => {
    const pos = Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0
    const r = Number.isFinite(rate) && rate > 0 ? rate : 1
    const state: PlaybackState = {
      positionSec: pos,
      rate: r,
      isPlaying,
      hostMonotonicMs: RailReelHost.getMonotonicMs(),
      ended,
    }
    setPlayback(state)
    RailReelHost.broadcast(JSON.stringify({ t: 'state', state })).catch(() => {})
  }, [])

  // Current host-monotonic time: the host reads its own clock; a client converts its clock via the
  // measured offset from the sync handshake.
  const hostNowMs = useCallback((): number => {
    const c = clientRef.current
    return c ? c.session.toHostTime(nowMs()) : RailReelHost.getMonotonicMs()
  }, [])

  const approve = useCallback(
    (id: string) => {
      if (id === 'host') return
      const ids = hostIds()
      // The ticket pins THIS request: deny / leave / a session reset void it, so a continuation
      // that resumes after one of those can't approve a later request without a new host decision.
      const ticket = approvalTicket(ids, id)
      if (!ticket) return
      RailReelHost.approve(ticket.grant)
        .then(async () => {
          // Voided while the native call was in flight. Nothing to undo: deny/leave queued their
          // revoke() after this approve() on the serial native queue (revoking here could cancel a
          // newer approval of the same grant).
          if (!approveWithTicket(ids, ticket)) return
          // A guest who dropped while pending stays "left"; its re-join resumes as approved.
          updateParticipants((prev) =>
            prev.map((p) => (p.id === id && p.status === 'requested' ? { ...p, status: 'approved' } : p)),
          )
          const conn = ids.connOf.get(id)
          if (!conn) return
          const live = () => ticketValid(ids, ticket) && ids.connOf.get(id) === conn
          await RailReelHost.approveConnection(conn).catch(() => false)
          if (!live()) return
          // Metadata BEFORE the decision: the decision starts the guest's download, whose storage
          // preflight needs the movie size from the roster. Same socket queue → delivered in order.
          await RailReelHost.sendTo(conn, rosterJson(participantsRef.current)).catch(() => false)
          if (!live()) return
          RailReelHost.sendTo(conn, JSON.stringify({ t: 'requestDecision', id, approved: true })).catch(() => {})
        })
        .catch((e) => setError(String(e)))
    },
    [updateParticipants, hostIds, rosterJson],
  )

  const deny = useCallback(
    (id: string) => {
      if (id === 'host') return
      const ids = hostIds()
      const grant = ids.grants.get(id)
      if (grant) RailReelHost.revoke(grant).catch(() => {})
      const conn = forget(ids, id)
      if (conn) {
        // Tell that socket alone, then close it once the decision is flushed.
        RailReelHost.sendTo(conn, JSON.stringify({ t: 'requestDecision', id, approved: false }))
          .catch(() => false)
          .then(() => RailReelHost.dropConnection(conn))
          .catch(() => {})
      }
      updateParticipants((prev) => prev.filter((p) => p.id !== id))
    },
    [updateParticipants, hostIds],
  )

  const handlePlaybackRequest = useCallback(
    (requestId: string, approved: boolean) => {
      const timer = autoDismissTimersRef.current.get(requestId)
      if (timer) {
        clearTimeout(timer)
        autoDismissTimersRef.current.delete(requestId)
      }

      const req = pendingPlaybackRequestsRef.current.find((r) => r.requestId === requestId)
      if (!req) return

      pendingPlaybackRequestsRef.current = pendingPlaybackRequestsRef.current.filter((r) => r.requestId !== requestId)
      setPendingPlaybackRequests(pendingPlaybackRequestsRef.current)

      if (approved) {
        if (req.action === 'pause') {
          if (hostTransportRef.current) {
            hostTransportRef.current.pause()
            const cur = hostTransportRef.current.getCurrentPosition()
            setHostPlayback(cur, false)
          } else {
            const cur = playbackRef.current?.positionSec ?? 0
            setHostPlayback(cur, false)
          }
        } else if (req.action === 'rewind') {
          const delta = typeof req.seconds === 'number' && req.seconds > 0 ? req.seconds : 15
          if (hostTransportRef.current) {
            const cur = hostTransportRef.current.getCurrentPosition()
            const target = Math.max(0, cur - delta)
            hostTransportRef.current.seekTo(target)
            setHostPlayback(target, hostTransportRef.current.isPlaying())
          } else {
            const cur = playbackRef.current?.positionSec ?? 0
            const target = Math.max(0, cur - delta)
            setHostPlayback(target, playbackRef.current?.isPlaying ?? false)
          }
        }

        RailReelHost.broadcast(
          JSON.stringify({
            t: 'playbackRequestDecision',
            requestId: req.requestId,
            requesterId: req.requesterId,
            approved: true,
            action: req.action,
            seconds: req.seconds,
          }),
        ).catch(() => {})
      } else {
        RailReelHost.broadcast(
          JSON.stringify({
            t: 'playbackRequestDecision',
            requestId: req.requestId,
            requesterId: req.requesterId,
            approved: false,
            action: req.action,
            seconds: req.seconds,
          }),
        ).catch(() => {})
      }
    },
    [setHostPlayback],
  )

  const handlePlaybackRequestRef = useRef(handlePlaybackRequest)
  handlePlaybackRequestRef.current = handlePlaybackRequest

  const registerHostTransport = useCallback((handler: HostTransportHandler | null) => {
    hostTransportRef.current = handler
  }, [])

  const clearRequestDeadline = useCallback(() => {
    if (requestDeadlineRef.current) {
      clearTimeout(requestDeadlineRef.current)
      requestDeadlineRef.current = null
    }
  }, [])

  // Show a request's outcome briefly, then return the controls to idle.
  const showRequestOutcome = useCallback(
    (status: 'approved' | 'dismissed') => {
      clearRequestDeadline()
      setPlaybackRequestStatus(status)
      if (dismissToastTimerRef.current) clearTimeout(dismissToastTimerRef.current)
      dismissToastTimerRef.current = setTimeout(() => {
        dismissToastTimerRef.current = null
        setPlaybackRequestStatus('idle')
        activeRequestIdRef.current = null
      }, 3000)
    },
    [clearRequestDeadline],
  )

  const sendPlaybackRequest = useCallback(
    (action: 'pause' | 'rewind', seconds?: number) => {
      const c = clientRef.current
      if (!c) return
      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      activeRequestIdRef.current = requestId
      if (dismissToastTimerRef.current) {
        clearTimeout(dismissToastTimerRef.current)
        dismissToastTimerRef.current = null
      }
      setPlaybackRequestStatus('pending')
      // The decision (or the host's own 10s auto-dismiss) can be lost to a WS drop, and nothing
      // replays it — so the request expires here too, or the request buttons stay disabled forever.
      clearRequestDeadline()
      requestDeadlineRef.current = setTimeout(() => {
        requestDeadlineRef.current = null
        if (activeRequestIdRef.current === requestId) showRequestOutcome('dismissed')
      }, PLAYBACK_REQUEST_DEADLINE_MS)
      c.session.send({
        t: 'playbackRequest',
        id: c.myId,
        grant: c.grant,
        requestId,
        action,
        seconds: typeof seconds === 'number' && seconds > 0 ? seconds : (action === 'rewind' ? 15 : undefined),
      })
    },
    [clearRequestDeadline, showRequestOutcome],
  )

  const clearPlaybackRequestStatus = useCallback(() => {
    clearRequestDeadline()
    if (dismissToastTimerRef.current) {
      clearTimeout(dismissToastTimerRef.current)
      dismissToastTimerRef.current = null
    }
    setPlaybackRequestStatus('idle')
    activeRequestIdRef.current = null
  }, [clearRequestDeadline])

  // ── client actions ──────────────────────────────────────────────────────────
  // One heartbeat builder for both phases (downloading + playback), reading the telemetry refs so
  // a download-progress beat can never clobber the playback fields (or vice versa). Always sends
  // over the LIVE session: a reconnect swaps clientRef's socket under us.
  const sendBeat = useCallback(() => {
    const c = clientRef.current
    if (!c) return
    const durationSec = mediaRef.current?.durationSec ?? 0
    c.session.send({
      t: 'heartbeat',
      id: c.myId,
      grant: c.grant,
      progress: progressRef.current,
      stalled: stalledRef.current,
      inShow: inShowRef.current,
      decodeOk: decodeOkRef.current,
      downloadMbps: mbpsRef.current,
      bufferedAheadSec: downloadBufferedAheadSec(progressRef.current, durationSec, positionRef.current),
      positionSec: positionRef.current,
    })
  }, [])

  // Follower → host during playback: whether our player is keeping up (stall debounced by the
  // PlayerScreen) and where our playhead is. The download may still be running underneath.
  const reportPlayback = useCallback(
    (stalled: boolean, positionSec: number) => {
      inShowRef.current = true // only the PlayerScreen calls this — our player is live
      stalledRef.current = stalled
      positionRef.current = Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0
      sendBeat()
    },
    [sendBeat],
  )

  const exitShow = useCallback(() => {
    inShowRef.current = false
    setUserLeftShow(true)
    sendBeat()
  }, [sendBeat])

  const enterShow = useCallback(() => {
    setUserLeftShow(false)
  }, [])

  // ── social (the cabin) ──────────────────────────────────────────────────────
  // Both role-aware: the host IS the hub (stamp + broadcast + local append); a guest routes via
  // the host and waits for the echo — the host's ordering is the only ordering.
  const sendChat = useCallback(
    (raw: string): boolean => {
      const text = sanitizeChatText(raw)
      if (!text) return false
      if (roleRef.current === 'host') {
        const at = Date.now()
        RailReelHost.broadcast(JSON.stringify({ t: 'chat', from: 'Host', fromId: 'host', text, at })).catch(() => {})
        ingestChat('You', text, at)
        return true
      }
      // Mid-reconnect clientRef still holds the dead socket, whose send fails silently.
      const c = clientRef.current
      if (!c || reconnectingRef.current) return false
      c.session.send({ t: 'chat', id: c.myId, grant: c.grant, text })
      return true
    },
    [ingestChat],
  )

  const sendReaction = useCallback(
    (emoji: string) => {
      if (!isValidReaction(emoji)) return
      const now = Date.now()
      if (now - lastReactionSentRef.current < REACTION_SEND_GAP_MS) return
      lastReactionSentRef.current = now
      if (roleRef.current === 'host') {
        RailReelHost.broadcast(JSON.stringify({ t: 'reaction', from: 'Host', fromId: 'host', emoji, at: now })).catch(() => {})
        ingestReaction('You', emoji)
      } else {
        const c = clientRef.current
        if (c) c.session.send({ t: 'reaction', id: c.myId, grant: c.grant, emoji })
      }
    },
    [ingestReaction],
  )

  // Fresh-restart prerequisite: everything reading the old file must let go BEFORE we unlink it.
  // The proxy holds an open fd on the current inode (it would serve the dead partial until its
  // edge timeout), and the player holds the proxy URL. A new proxy comes up with the new transfer.
  const detachProgressive = useCallback(async () => {
    proxyGenRef.current++
    const pending = proxyStartRef.current
    proxyStartRef.current = null
    setMovieUri(null)
    if (pending) await pending.catch(() => {}) // its handler sees the bumped generation and bails
    await RailReelHost.stopProxy().catch(() => {})
    proxyStateRef.current = 'idle'
  }, [])

  // Keep & Leave reuse: is the kept MOVIE_CACHE this exact movie? The record is only a pre-filter
  // (same size + same recorded fingerprint); the proof is a fresh fingerprint of the local file
  // matching the host's. The roster carrying the host's fingerprint can trail the approval by a
  // moment, so wait briefly for it — never long: a normal download is the safe fallback.
  const reuseKeptCopy = useCallback(async (stale: () => boolean): Promise<boolean> => {
    const meta = parseKeptMovieMeta(await LegacyFS.readAsStringAsync(MOVIE_META).catch(() => null))
    if (stale() || !meta) return false
    const info = await LegacyFS.getInfoAsync(MOVIE_CACHE).catch(() => null)
    if (stale() || !info) return false
    const file = info.exists ? { exists: true, size: info.size } : { exists: false }
    const decide = () => {
      const m = mediaRef.current
      if (!m) return isKeptMovieIntact(meta, file) ? 'need-hash' : 'mismatch'
      return keptReuseDecision(meta, file, { sizeBytes: m.sizeBytes, hash: m.hash })
    }
    let decision = decide()
    for (let waited = 0; decision === 'need-hash' && waited < KEPT_HASH_WAIT_MS; waited += 150) {
      await sleep(150)
      if (stale()) return false
      decision = decide()
    }
    const hostHash = mediaRef.current?.hash ?? ''
    if (decision !== 'verify' || !hostHash) return false
    const local = await RailReelHost.fingerprint(MOVIE_CACHE, meta.sizeBytes).catch(() => '')
    return !stale() && local === hostHash
  }, [])

  // Arm the next automatic transfer retry (bounded backoff). It only fires into the same session,
  // and only if the transfer still needs it (see maybeAutoResume) — during playback there is no
  // retry button, so a hotspot blip must heal on its own.
  const maybeAutoResume = useCallback((): boolean => {
    const go = shouldAutoResume({
      approved: approvedRef.current,
      phase: clientPhaseRef.current,
      complete: completeRef.current, // validated — byte progress alone can hit 100% and still fail
      transferring: downloadingRef.current || downloadRef.current !== null,
      reconnecting: reconnectingRef.current,
      retries: transferRetriesRef.current,
      integrityFailures: integrityFailuresRef.current,
    })
    if (disposedRef.current || !go) return false
    transferRetriesRef.current++
    startDownloadRef.current({ resume: true }).catch(() => {})
    return true
  }, [])

  const scheduleTransferRetry = useCallback(() => {
    clearRetryTimer()
    const n = transferRetriesRef.current
    if (disposedRef.current || n >= MAX_TRANSFER_RETRIES || integrityFailuresRef.current > MAX_INTEGRITY_RETRIES) return
    const myEpoch = epochRef.current
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null
      if (epochRef.current !== myEpoch) return // session over (or provider unmounted)
      // The backoff has elapsed, but the WS is still re-handshaking (a retry would fail the same
      // way): park it — the reconnect success path fires it, keeping budget and backoff intact.
      if (reconnectingRef.current) {
        retryPendingRef.current = true
        return
      }
      maybeAutoResume()
    }, transferRetryDelayMs(n))
  }, [clearRetryTimer, maybeAutoResume])

  // A running transfer that has gone silent is dead (OkHttp would wait out its 60s read timeout;
  // the proxy gives up on a silent edge after 30s). Abort it and let the normal retry path —
  // budget + backoff — resume it. Abandoning bumps the attempt, so the dead attempt's own
  // continuations bail; the next attempt waits for its native download to settle.
  const abortStalledTransfer = useCallback(() => {
    if (disposedRef.current) return
    // Credit FIRST: the aborted attempt exits at its own stale guard and never reaches its error
    // handler, so the kept-bytes credit it earned must be applied here. Its partial is still this
    // session's clean prefix (a stall doesn't invalidate it), which the resume will continue.
    const retained = partialEpochRef.current === epochRef.current
    transferRetriesRef.current = retriesAfterFailure(transferRetriesRef.current, attemptBytesRef.current, retained)
    attemptBytesRef.current = 0
    attemptRef.current++
    downloadRef.current?.cancelAsync().catch(() => {})
    downloadRef.current = null
    downloadingRef.current = false
    // Like any failure: the lobby offers Retry (which also covers a spent automatic budget).
    setError('The transfer stalled — reconnecting to the host…')
    setClientPhase('approved')
    clientPhaseRef.current = 'approved'
    scheduleTransferRetry()
  }, [scheduleTransferRetry])

  // Pull the subtitle body when the roster names a revision we don't have. Only once approved
  // (the host serves only admitted guests). An unanswered pull is re-sent after a timeout — the
  // reply can die with a dropped socket — a bounded number of times (lib/protocol/subtitle).
  const maybeFetchSubtitle = useCallback(function fetchSubtitle() {
    if (disposedRef.current) return
    const c = clientRef.current
    const meta = rosterSubtitleRef.current
    if (!c || !approvedRef.current || !meta) return
    const now = Date.now()
    if (!needsSubtitleFetch(subtitleRef.current?.rev ?? null, meta, subtitlePullRef.current, now)) return
    subtitlePullRef.current = recordSubtitlePull(subtitlePullRef.current, meta.rev, now)
    c.session.send({ t: 'subtitleRequest', id: c.myId, grant: c.grant, rev: meta.rev })
    if (subtitlePullTimerRef.current) clearTimeout(subtitlePullTimerRef.current)
    subtitlePullTimerRef.current = setTimeout(() => {
      subtitlePullTimerRef.current = null
      fetchSubtitle() // no-op if it arrived (rev matches) or the tries are spent
    }, SUBTITLE_PULL_TIMEOUT_MS)
  }, [])

  // A fresh connection: forget the old one's pull so it's asked again right away.
  const resetSubtitlePull = useCallback(() => {
    subtitlePullRef.current = null
    if (subtitlePullTimerRef.current) clearTimeout(subtitlePullTimerRef.current)
    subtitlePullTimerRef.current = null
  }, [])

  /**
   * Client: fetch (or resume) the movie into MOVIE_CACHE and publish it to the player.
   *
   * Ownership: every await re-checks `stale()` (session epoch AND attempt generation) before it
   * mutates state, telemetry or the shared MOVIE_CACHE, so an abandoned attempt can never create
   * a download, delete the next session's file, or publish ready. A new attempt also waits for
   * the previous one to unwind before touching the file.
   *
   * `resume`: continue this session's partial file with a Range request (same inode → the proxy
   * and the playing show keep working). Falls back to a clean restart when there's no trustworthy
   * partial. A fresh start first tries a kept copy (Keep & Leave).
   */
  const startDownload = useCallback(
    (opts: { resume?: boolean } = {}): Promise<void> => {
      const c = clientRef.current
      if (!c || disposedRef.current) return Promise.resolve()
      // Re-entrancy guard: a duplicate approval (host double-tap, decision re-delivered after a
      // reconnect) must NOT start a second writer on the same cache file.
      if (downloadRef.current || downloadingRef.current) return Promise.resolve()
      downloadingRef.current = true
      clearRetryTimer()
      retryPendingRef.current = false
      completeRef.current = false
      const myEpoch = epochRef.current
      const myAttempt = ++attemptRef.current
      const stale = (): boolean =>
        disposedRef.current || epochRef.current !== myEpoch || attemptRef.current !== myAttempt
      setError(null)
      setClientPhase('downloading')
      clientPhaseRef.current = 'downloading' // synchronously: retry decisions read the ref
      const url =`http://${c.payload.host}:${c.payload.httpPort}/movie?tk=${encodeURIComponent(c.payload.token)}&g=${encodeURIComponent(c.grant)}`
      const expectedSize = (): number => mediaRef.current?.sizeBytes ?? 0
      let dl: LegacyFS.DownloadResumable | null = null

      const publishReady = () => {
        transferRetriesRef.current = 0
        integrityFailuresRef.current = 0
        completeRef.current = true // the ONLY place completion is claimed: after validation
        progressRef.current = 1
        setProgress(1)
        // If the proxy is serving the show (or about to — its handler sets the source), leave it
        // alone: swapping the source mid-playback would rebuffer. Otherwise open the file directly.
        if (proxyStateRef.current === 'idle' || proxyStateRef.current === 'failed') setMovieUri(MOVIE_CACHE)
        setError(null)
        setClientPhase('ready')
        clientPhaseRef.current = 'ready'
        getCacheInfo().catch(() => {})
        sendBeat()
        const live = clientRef.current ?? c
        live.session.send({ t: 'ready', id: c.myId, grant: c.grant, positionSec: positionRef.current })
      }

      // Bytes this attempt pulled (beyond its resume offset) live in attemptBytesRef: credited to
      // the retry budget only if they're still on disk when it ends — whether it fails on its own
      // (catch below) or the watchdog aborts it (abortStalledTransfer).
      attemptBytesRef.current = 0

      const run = async (prev: Promise<void> | null): Promise<void> => {
        try {
          // Exclusive ownership of MOVIE_CACHE: everything queued before us in movieCacheOwner
          // (earlier attempts — even a previous provider instance's — and the startup sweep) must
          // have FULLY settled. cancelAsync only requests cancellation; the native downloadAsync
          // promise settles only once its writer has stopped. Starting early would let the old
          // writer append behind our resume offset, so a wedged predecessor is never "timed
          // out" into sharing the file: past the ceiling we give up THIS attempt (error + the
          // normal retry path) without touching the file, and the predecessor stays at the head
          // of the queue for every later attempt.
          {
            const owned = await awaitOwnership(prev, PREV_ATTEMPT_CEILING_MS, sleep)
            if (stale()) return
            if (!owned) {
              setError('The previous transfer is still shutting down — trying again shortly.')
              setClientPhase('approved')
              clientPhaseRef.current = 'approved'
              downloadingRef.current = false
              scheduleTransferRetry()
              return
            }
          }

          if (!opts.resume) {
            const reused = await reuseKeptCopy(stale)
            if (stale()) return
            if (reused) {
              partialEpochRef.current = null
              publishReady()
              return
            }
          }

          // Resume only a partial THIS session wrote as a clean prefix.
          let from = 0
          if (opts.resume && partialEpochRef.current === myEpoch) {
            const info = await LegacyFS.getInfoAsync(MOVIE_CACHE).catch(() => null)
            if (stale()) return
            from = resumeOffset(info?.exists ? info.size : 0, expectedSize())
          }
          if (from === 0) {
            await detachProgressive()
            if (stale()) return
            partialEpochRef.current = null
            progressRef.current = 0
            setProgress(0)
            mbpsRef.current = 0
            // The kept-copy record describes the file we're about to replace — drop it first.
            await LegacyFS.deleteAsync(MOVIE_META, { idempotent: true }).catch(() => {})
            if (stale()) return
            await LegacyFS.deleteAsync(MOVIE_CACHE, { idempotent: true }).catch(() => {})
            if (stale()) return
          }
          mbpsSampleRef.current = null // the outage gap is not a throughput sample

          // Storage preflight (PRD §8: surface the 1–4 GB requirement up front, not at 97%).
          const freeBytes = await LegacyFS.getFreeDiskStorageAsync().catch(() => -1)
          if (stale()) return
          const storageMsg = storageWarning(freeBytes, Math.max(0, expectedSize() - from))
          if (storageMsg) {
            setError(storageMsg)
            setClientPhase('approved') // freeing space + Retry tries again; no auto-retry (it'd fail the same way)
            clientPhaseRef.current = 'approved'
            return
          }

          const resumedFrom = from
          dl = LegacyFS.createDownloadResumable(
            url,
            MOVIE_CACHE,
            {},
            (p) => {
              if (stale()) return // a newer attempt owns the telemetry refs now
              const now = Date.now()
              if (p.totalBytesWritten > resumedFrom) lastProgressAtRef.current = now // real bytes only
              const total = p.totalBytesExpectedToWrite
              const size = expectedSize()
              // A resumed transfer that isn't a 206 for the rest of THIS file (an error page, a
              // full-body 200) is being appended as garbage — stop it; the retry restarts clean.
              if (resumedFrom > 0 && size > 0 && total > 0 && total !== size) {
                partialEpochRef.current = null
                dl?.cancelAsync().catch(() => {})
                return
              }
              // Progress against the movie's real size when known, so an error body's tiny
              // Content-Length can't read as "100%". Capped below 1 until validated: the host
              // treats 1 as ready, and the last read can still fail its write or fingerprint.
              const frac = unvalidatedProgress(p.totalBytesWritten, size > 0 ? size : total)
              progressRef.current = frac
              setProgress(frac)
              attemptBytesRef.current = Math.max(0, p.totalBytesWritten - resumedFrom)

              // Measured throughput (smoothed) — the number the host's start gate reasons about.
              const sample = mbpsSampleRef.current
              if (!sample) {
                mbpsSampleRef.current = { bytes: p.totalBytesWritten, ms: now }
              } else if (now - sample.ms >= 1000) {
                mbpsRef.current = smoothedMbps(mbpsRef.current, p.totalBytesWritten - sample.bytes, now - sample.ms)
                mbpsSampleRef.current = { bytes: p.totalBytesWritten, ms: now }
              }

              // Progressive playback: once the final size is confirmed, stand up the localhost
              // proxy over the growing file and hand THAT to the player — never the partial file.
              // FastStart required: moov at EOF can't be opened partially (proxy stalls, crashes).
              // The proxy belongs to the session's file, not to this attempt: a resume keeps it.
              if (
                total > 0 &&
                (size <= 0 || total === size) &&
                proxyStateRef.current === 'idle' &&
                mediaRef.current?.fastStart === true
              ) {
                proxyStateRef.current = 'starting'
                const gen = proxyGenRef.current
                proxyIssuedGenRef.current = gen
                const proxyStale = () => epochRef.current !== myEpoch || proxyGenRef.current !== gen
                proxyStartRef.current = RailReelHost.startProxy(MOVIE_CACHE, total)
                  .then((port) => {
                    if (proxyStale()) {
                      // Ours is orphaned — stop it unless a newer start already replaced it.
                      if (proxyIssuedGenRef.current === gen) RailReelHost.stopProxy().catch(() => {})
                      return
                    }
                    proxyStateRef.current = 'up'
                    setMovieUri(`http://127.0.0.1:${port}/movie`)
                  })
                  .catch(() => {
                    if (proxyStale()) return
                    // Full pre-cache fallback — and if the download already finished while we
                    // were starting, the completion block has passed, so set the source here.
                    proxyStateRef.current = 'failed'
                    if (completeRef.current) setMovieUri(MOVIE_CACHE)
                  })
              }

              // Throttle heartbeats to ~3/s so a fast download doesn't flood the control channel.
              // Once our player is live the PlayerScreen's report loop is already beating.
              if (!inShowRef.current && now - lastBeatRef.current > 300) {
                lastBeatRef.current = now
                sendBeat()
              }
            },
            resumedFrom > 0 ? String(resumedFrom) : undefined,
          )
          downloadRef.current = dl
          partialEpochRef.current = myEpoch // from here MOVIE_CACHE is this session's partial
          transferStartedAtRef.current = Date.now()
          lastProgressAtRef.current = 0 // no byte yet → the initial-response grace applies
          // Watchdog for the whole transfer, not just at WS reconnect: a quick WS blip can leave
          // the HTTP request silently dead long after the reconnect check has passed.
          const watched = dl
          const watchdog = setInterval(() => {
            if (stale() || downloadRef.current !== watched) return
            if (isTransferStalled(true, transferStartedAtRef.current, lastProgressAtRef.current, Date.now())) {
              abortStalledTransfer()
            }
          }, 1000)
          let res: Awaited<ReturnType<LegacyFS.DownloadResumable['downloadAsync']>>
          try {
            res = await dl.downloadAsync()
          } finally {
            clearInterval(watchdog)
          }
          if (stale() || downloadRef.current !== dl) return // superseded — not ours to finish
          downloadRef.current = null

          // The legacy downloader writes ANY response body to disk (and appends on a resume) —
          // trust the file only with the right status and the exact final size.
          const done = await LegacyFS.getInfoAsync(MOVIE_CACHE).catch(() => null)
          if (stale()) return
          const finalBytes = done?.exists ? done.size : null
          if (!transferResultOk(resumedFrom, res?.status, finalBytes, expectedSize())) {
            partialEpochRef.current = null // not a clean prefix any more → the retry restarts
            // A full-length body that is still wrong (wrong size / unexpected status after all
            // bytes arrived) counts against the integrity budget, like a failed fingerprint.
            if (typeof res?.status === 'number' && res.status >= 200 && res.status < 300) integrityFailuresRef.current++
            throw new Error(`download failed (HTTP ${res?.status ?? '?'})`)
          }

          // Integrity: our copy must match the host's fingerprint — but only pre-show. During a
          // progressive show the proxy is actively serving this file (deleting it would kill the
          // playback that's demonstrably working); a truly wrong file would never have decoded.
          const expected = mediaRef.current?.hash ?? ''
          const size = expectedSize()
          let fingerprint = ''
          if (!inShowRef.current && expected.startsWith('qf1:') && size > 0) {
            fingerprint = await RailReelHost.fingerprint(MOVIE_CACHE, size).catch(() => '')
            if (stale()) return
            if (fingerprint !== expected) {
              partialEpochRef.current = null
              integrityFailuresRef.current++ // its own budget; these bytes earn no retry credit
              await LegacyFS.deleteAsync(MOVIE_CACHE, { idempotent: true }).catch(() => {})
              throw new Error(
                integrityFailuresRef.current > MAX_INTEGRITY_RETRIES
                  ? 'The downloaded copy keeps failing its integrity check — ask the host to re-share the movie.'
                  : 'The downloaded copy failed its integrity check — trying again.',
              )
            }
          }
          partialEpochRef.current = null
          publishReady()

          // Keep & Leave: record what this file IS, so a rejoin can skip the transfer. Part of this
          // attempt's promise, so the next attempt can't replace the file mid-write.
          if (size > 0) {
            if (!fingerprint) fingerprint = await RailReelHost.fingerprint(MOVIE_CACHE, size).catch(() => '')
            if (fingerprint.startsWith('qf1:')) {
              await LegacyFS.writeAsStringAsync(
                MOVIE_META,
                encodeKeptMovieMeta({ hash: fingerprint, sizeBytes: size, title: mediaRef.current?.title ?? '', savedAt: Date.now() }),
              ).catch(() => {})
            }
          }
        } catch (e) {
          if (stale()) return // a zombie's failure must not clobber the session that came after
          if (downloadRef.current === dl) downloadRef.current = null
          if (clientPhaseRef.current === 'denied' || !approvedRef.current) return
          // NOTE: no deleteAsync for a network failure — the partial is a clean prefix we resume.
          // If the partial is NOT resumable (bad status, wrong size, failed fingerprint), withdraw
          // the progress we advertised: the next attempt starts from zero.
          const retained = partialEpochRef.current === myEpoch
          if (!retained) {
            progressRef.current = 0
            setProgress(0)
          }
          // Real forward progress that is still on disk earns back the automatic retry budget
          // (a WS reconnect doesn't; bytes we just discarded don't either).
          transferRetriesRef.current = retriesAfterFailure(transferRetriesRef.current, attemptBytesRef.current, retained)
          attemptBytesRef.current = 0
          sendBeat()
          setError(String(e))
          setClientPhase('approved') // Retry in the lobby; automatic below (no button mid-show)
          clientPhaseRef.current = 'approved'
          downloadingRef.current = false
          scheduleTransferRetry()
        } finally {
          if (!stale()) downloadingRef.current = false
        }
      }

      // Join the module-level queue: the next attempt waits on this one AND everything before it
      // (if this attempt gives up on a wedged predecessor, that predecessor still guards the file).
      return movieCacheOwner.run(run)
    },
    [sendBeat, getCacheInfo, clearRetryTimer, detachProgressive, reuseKeptCopy, scheduleTransferRetry, abortStalledTransfer],
  )
  startDownloadRef.current = startDownload

  // The WS is back (hotspot blip): bring the HTTP transfer back with it — WITHOUT resetting the
  // retry budget or skipping the backoff (a WS handshake can succeed while HTTP keeps failing).
  // A retry whose backoff elapsed during the outage fires now; a pending one keeps its deadline;
  // a silent "running" transfer is caught here immediately and by its watchdog thereafter.
  const recoverTransfer = useCallback(() => {
    if (disposedRef.current) return
    if (isTransferStalled(downloadRef.current !== null, transferStartedAtRef.current, lastProgressAtRef.current, Date.now())) {
      abortStalledTransfer()
      return
    }
    if (retryPendingRef.current) {
      retryPendingRef.current = false
      maybeAutoResume()
    }
  }, [abortStalledTransfer, maybeAutoResume])

  // Open a client WS session (clock handshake + handlers). On the FIRST connect we send `join`;
  // on a reconnect we don't — the host still has our approved grant and our cached file, so we just
  // resume the same `id` (a fresh join would reset us to "requested" and force re-approval).
  type ClientParams = { payload: JoinPayload; myId: string; grant: string; name: string }
  const openClient = useCallback(
    async (p: ClientParams, initial: boolean): Promise<SyncSession> => {
      const { payload, myId, grant, name } = p
      const session = await openSyncSession(
        payload.host,
        payload.wsPort,
        payload.token,
        (raw) => {
          if (disposedRef.current) return // a dead provider's socket must not restart anything
          const r = parseServerMsg(JSON.stringify(raw))
          if (!r.ok) return
          const m = r.msg
          if (m.t === 'requestDecision' && m.id === myId) {
            if (m.approved) {
              // A re-delivered approval (reconnect, host double-tap) while we're already
              // transferring or done must not restart: a fresh start would delete a good file.
              if (approvedRef.current && (downloadingRef.current || completeRef.current)) return
              approvedRef.current = true // from now on, reconnects resume silently (no re-join)
              setClientPhase('approved')
              clientPhaseRef.current = 'approved'
              startDownload()
              maybeFetchSubtitle() // the roster may already have named a subtitle revision
            } else {
              approvedRef.current = false
              setClientPhase('denied')
              resetTransfer()
              clientRef.current?.session.close()
              clientRef.current = null
            }
          } else if (m.t === 'roster' && Array.isArray(m.participants)) {
            // The roster carries the movie's metadata — what our own buffer math needs.
            if (isMediaInfo(m.media)) {
              mediaRef.current = m.media
              setMovie({
                title: m.media.title,
                sizeBytes: m.media.sizeBytes,
                durationSec: m.media.durationSec,
                fastStart: m.media.fastStart === true,
              })
              // Decode preflight: can THIS phone's hardware handle the movie's frame size?
              // (PRD accepts H.264 only, so video/avc.) Warn here, and flag the host via beats.
              const w = m.media.width ?? 0
              const h = m.media.height ?? 0
              const ok = w > 0 && h > 0 ? RailReelHost.canDecode(m.media.videoMime || 'video/avc', w, h) : true
              decodeOkRef.current = ok
              setDecodeCaution(decodeWarning(ok, h))
            }
            // Subtitles: the roster names the current revision; the body is pulled when ours
            // differs (identity is the content revision, so a same-name replacement reloads).
            if (isMediaInfo(m.media)) {
              const meta = isSubtitleMeta(m.media.subtitle) ? m.media.subtitle : null
              rosterSubtitleRef.current = meta
              if (meta) maybeFetchSubtitle()
              else if (subtitleRef.current) clearSubtitle()
            }
            const list: Participant[] = m.participants
              .filter(isParticipantInfo)
              .map((q) => ({
                id: q.id,
                name: q.id === myId ? 'You' : q.name,
                status: q.status,
                progress: clamp01(q.progress),
                downloadMbps: Number.isFinite(q.downloadMbps) ? q.downloadMbps : 0,
                bufferedAheadSec: Number.isFinite(q.bufferedAheadSec) ? q.bufferedAheadSec : 0,
                stalled: false, // roster is a lobby-phase view; stall is host-tracked during playback
                inShow: false,
                decodeOk: q.decodeOk !== false,
                lastBeatAt: Date.now(),
              }))
            participantsRef.current = list
            setParticipants(list)
          } else if (m.t === 'state') {
            setPlayback(m.state) // host's authoritative playback; the Player drift-corrects to it
          } else if (m.t === 'chat') {
            // The host's echo is the single source of ordering — we never append optimistically,
            // so our own line arrives here too and gets relabelled.
            if (typeof m.from === 'string' && typeof m.text === 'string' && Number.isFinite(m.at)) {
              const displayName = (m.fromId ? m.fromId === myId : m.from === name) ? 'You' : m.from
              ingestChat(displayName, m.text.slice(0, 280), m.at)
            }
          } else if (m.t === 'reaction') {
            if (typeof m.from === 'string' && isValidReaction(m.emoji)) {
              const displayName = (m.fromId ? m.fromId === myId : m.from === name) ? 'You' : m.from
              ingestReaction(displayName, m.emoji)
            }
          } else if (m.t === 'subtitle') {
            const sub = parseSubtitlePayload(m)
            if (sub?.kind === 'load') {
              if (subtitleRef.current?.rev !== sub.rev) loadSubtitle(sub.name, sub.content, sub.rev)
            } else if (sub?.kind === 'clear') {
              clearSubtitle()
            }
          } else if (m.t === 'playbackRequestDecision') {
            // Only the decision for OUR live request: a late one for an expired request is moot.
            if (m.requesterId === myId && m.requestId === activeRequestIdRef.current) {
              showRequestOutcome(m.approved ? 'approved' : 'dismissed')
            }
          } else if (m.t === 'ended') {
            // The host wrapped the show / left. leave() clears everything (incl. sessionEnd), so
            // set the designed end-state right after — Home surfaces it.
            leave()
            setSessionEnd({
              kind: 'host-ended',
              eyebrow: 'THE SHOW HAS ENDED',
              headline: 'The cabin went dark',
              body: 'The host ended the session. Thanks for riding along.',
            })
          }
        },
        // Socket dropped after we were live: kick off a reconnect (unless we're deliberately leaving).
        () => {
          if (!disposedRef.current && !leavingRef.current && roleRef.current === 'client') reconnectRef.current()
        },
      )
      if (initial) session.send({ t: 'join', id: myId, name, token: payload.token, grant })
      return session
    },
    [startDownload, ingestChat, ingestReaction, loadSubtitle, clearSubtitle, maybeFetchSubtitle, showRequestOutcome],
  )

  // Reconnect loop: re-handshake with exponential backoff, then resume the same session identity.
  // Gives up (and tears down) after MAX_RECONNECT_ATTEMPTS so the UI can't hang forever.
  const reconnect = useCallback(async () => {
    const c = clientRef.current
    if (!c || disposedRef.current || reconnectingRef.current || leavingRef.current || clientPhaseRef.current === 'denied') return
    const myEpoch = epochRef.current // a leave()/new connect() bumps this → this loop is stale, abort
    const stale = (): boolean => leavingRef.current || epochRef.current !== myEpoch
    // Re-join only if the host hasn't approved us yet (e.g. it approved during the outage and we
    // missed the decision); an approved client resumes silently so it isn't reset to 'requested'.
    const rejoin = !approvedRef.current
    reconnectingRef.current = true
    setReconnecting(true)
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      await sleep(reconnectDelayMs(attempt))
      if (stale()) {
        reconnectingRef.current = false
        setReconnecting(false)
        return
      }
      try {
        const session = await openClient({ payload: c.payload, myId: c.myId, grant: c.grant, name: c.name }, rejoin)
        if (stale()) {
          session.close() // we were torn down / re-connected while handshaking — drop this socket
          reconnectingRef.current = false
          setReconnecting(false)
          return
        }
        clientRef.current = { ...c, session }
        reconnectingRef.current = false
        setReconnecting(false)
        sendBeat()
        // A pending playback request's decision may have been lost with the old socket and is
        // never replayed — release the request controls.
        if (requestDeadlineRef.current) clearPlaybackRequestStatus()
        // Anything we asked for on the dead socket may be lost too: re-evaluate the subtitle
        // against the latest roster (a replacement may have gone out while we were away).
        resetSubtitlePull()
        maybeFetchSubtitle()
        // The HTTP transfer died with the hotspot too — bring it back (no retry UI mid-show).
        recoverTransfer()
        return
      } catch {
        // keep retrying until the attempt budget runs out
      }
    }
    reconnectingRef.current = false
    setReconnecting(false)
    if (!stale()) {
      leave() // tear down first — leave() clears state, so surface the end-state afterwards
      setSessionEnd({
        kind: 'lost',
        eyebrow: 'SIGNAL LOST',
        headline: 'Lost the cabin',
        body: "Couldn't reach the host — they may have left, or the hotspot dropped.",
      })
    }
  }, [openClient, sendBeat, clearPlaybackRequestStatus, maybeFetchSubtitle, recoverTransfer, resetSubtitlePull])

  useEffect(() => {
    reconnectRef.current = reconnect
  }, [reconnect])

  const connect = useCallback(
    async (joinLink: string, name: string) => {
      if (disposedRef.current) return
      setError(null)
      setClientPhase('connecting')
      let payload: JoinPayload
      try {
        payload = decodeJoinUrl(joinLink.trim())
      } catch (e) {
        // A version mismatch is not a "bad link" — say what to do about it.
        setError(isVersionMismatch(e) ? VERSION_MISMATCH_MESSAGE : `Bad join link: ${String(e)}`)
        setClientPhase('idle')
        return
      }
      const myId = generateSessionId(randomBytes)
      const grant = generateGrant(randomBytes)
      setUserLeftShow(false)
      leavingRef.current = false
      approvedRef.current = false
      epochRef.current++ // a fresh session — invalidate any reconnect loop left over from a prior one
      const myEpoch = epochRef.current
      // A fresh join must not inherit ANYTHING from a previous session: no zombie download feeding
      // the gate a dying transfer rate, no stale playback state yanking us straight into the
      // Player, no leftover roster/media.
      resetTransfer()
      clientRef.current?.session.close()
      clientRef.current = null
      mediaRef.current = null
      rosterSubtitleRef.current = null
      resetSubtitlePull()
      setPlayback(null)
      participantsRef.current = []
      setParticipants([])
      setMovie(null)
      setChatLog([])
      setReactions([])
      setDecodeCaution(null)
      decodeOkRef.current = true
      try {
        const session = await openClient({ payload, myId, grant, name }, true)
        if (epochRef.current !== myEpoch || leavingRef.current) {
          session.close()
          return
        }
        clientRef.current = { session, payload, grant, myId, name }
        // hostName stays null — the join link doesn't carry the host's name yet.
        setRole('client')
        roleRef.current = 'client'
        setClientPhase('requested')
      } catch (e) {
        setError(String(e))
        setClientPhase('idle')
      }
    },
    [openClient, resetTransfer, resetSubtitlePull],
  )

  const leave = useCallback(() => {
    leavingRef.current = true // a deliberate teardown — stop any reconnect loop from firing/looping
    reconnectingRef.current = false
    approvedRef.current = false
    epochRef.current++ // invalidate any in-flight reconnect loop so it can't resurrect this session
    setUserLeftShow(false)
    inShowRef.current = false
    downloadingRef.current = false
    setReconnecting(false)
    resetTransfer()
    mediaRef.current = null
    setFloorHeld(new Set())
    if (clientRef.current) {
      try {
        clientRef.current.session.send({
          t: 'leave',
          id: clientRef.current.myId,
          grant: clientRef.current.grant,
        })
      } catch {
        // best-effort: socket might already be broken
      }
      clientRef.current.session.close()
      clientRef.current = null
    }
    if (roleRef.current === 'host') {
      // Tell guests the cabin's closing BEFORE the servers die — they get the graceful
      // "cabin went dark" moment instantly, instead of a ~30s reconnect timeout → "lost". Every
      // socket, pending requesters included (broadcast() is approved-only); native stop() drains
      // queued frames for a bounded moment before closing.
      RailReelHost.broadcastAll(JSON.stringify({ t: 'ended', reason: 'host-left' })).catch(() => {})
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
      stopTimerRef.current = setTimeout(() => {
        RailReelHost.stop().catch(() => {})
        stopTimerRef.current = null
      }, 200) // let the frame flush first
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {})
    } else if (hostStartRef.current !== null) {
      // Leaving mid-startHost(): servers may already be up though the role isn't 'host' yet. No guest
      // can have been admitted, so skip the 'ended' frame and stop now; startHost's own stale checks
      // catch anything (keep-awake, advert) that lands after this.
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current)
        stopTimerRef.current = null
      }
      RailReelHost.stopAdvertise().catch(() => {})
      RailReelHost.stop().catch(() => {})
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {})
    }
    hostStartRef.current = null
    hostTokenRef.current = null
    joinMetaRef.current = null
    grantsRef.current.clear()
    participantsRef.current = []
    setParticipants([])
    setMovie(null)
    setJoinUrl(null)
    setJoinCode(null)
    setHostIp(null)
    setHostPhase('idle')
    setClientPhase('idle')
    setPlayback(null)
    setChatLog([])
    setReactions([])
    clearSubtitle()
    setDecodeCaution(null)
    decodeOkRef.current = true
    setHostWarning(null)
    setSessionEnd(null)
    setError(null)
    setRole('none')
    roleRef.current = 'none'
    pendingPlaybackRequestsRef.current = []
    setPendingPlaybackRequests([])
    autoDismissTimersRef.current.forEach((t) => clearTimeout(t))
    autoDismissTimersRef.current.clear()
    if (dismissToastTimerRef.current) {
      clearTimeout(dismissToastTimerRef.current)
      dismissToastTimerRef.current = null
    }
    setPlaybackRequestStatus('idle')
    activeRequestIdRef.current = null
    hostTransportRef.current = null
    getCacheInfo().catch(() => {})
  }, [resetTransfer, clearSubtitle, getCacheInfo])

  // Client: retry a download that failed (bad HTTP, integrity mismatch). The grant + approval
  // still stand, so we just kick the transfer again.
  // Client: retry a failed download (bad HTTP, integrity mismatch, lost signal). The grant +
  // approval still stand. Resumes this session's partial when it's a clean prefix (the proxy and
  // any playing show keep their file); otherwise restarts clean, proxy included.
  const retryDownload = useCallback(() => {
    transferRetriesRef.current = 0 // a deliberate retry starts fresh automatic budgets
    integrityFailuresRef.current = 0
    setError(null)
    startDownload({ resume: true })
  }, [startDownload])

  const dismissEnd = useCallback(() => setSessionEnd(null), [])

  // Group buffer floor (PRD §7 rule 2): advance the hysteretic held-set whenever new telemetry
  // lands (an effect, not render math — the held set is real state). Held under 15s of buffer,
  // released at 30s, so a client hovering at the edge can't flap the room. Only followers whose
  // player is live can hold the room — a late joiner still downloading in the lobby must never
  // pause everyone else's movie.
  const [floorHeld, setFloorHeld] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const inShow = participants.filter((p) => p.id !== 'host' && p.inShow)
    setFloorHeld((prev) => {
      const held = updateFloorHolds(prev, inShow)
      return held.size === prev.size && [...held].every((id) => prev.has(id)) ? prev : held
    })
  }, [participants])

  // Followers the room waits on: a stalled player, or a floor-held downloader.
  const waitingFor = useMemo(
    () =>
      participants
        .filter((p) => p.id !== 'host' && p.inShow && (p.stalled || floorHeld.has(p.id)))
        .map((p) => p.name),
    [participants, floorHeld],
  )

  const value = useMemo<SessionStore>(
    () => ({
      role,
      error,
      movie,
      participants,
      hostPhase,
      joinUrl,
      joinCode,
      hostIp,
      clientPhase,
      progress,
      hostName,
      reconnecting,
      decodeCaution,
      hostWarning,
      sessionEnd,
      movieUri,
      playback,
      waitingFor,
      chatLog,
      reactions,
      sendChat,
      sendReaction,
      startHost,
      refreshJoin,
      setHostPlayback,
      reportPlayback,
      hostNowMs,
      approve,
      deny,
      connect,
      leave,
      userLeftShow,
      exitShow,
      enterShow,
      retryDownload,
      dismissEnd,
      subtitle,
      attachSubtitle,
      removeSubtitle,
      pendingPlaybackRequests,
      handlePlaybackRequest,
      playbackRequestStatus,
      sendPlaybackRequest,
      clearPlaybackRequestStatus,
      registerHostTransport,
      cacheStatus,
      getCacheInfo,
      purgeCache,
    }),
    [role, error, movie, participants, hostPhase, joinUrl, joinCode, hostIp, clientPhase, progress, hostName, reconnecting, decodeCaution, hostWarning, sessionEnd, movieUri, playback, waitingFor, chatLog, reactions, sendChat, sendReaction, startHost, refreshJoin, setHostPlayback, reportPlayback, hostNowMs, approve, deny, connect, leave, userLeftShow, exitShow, enterShow, retryDownload, dismissEnd, subtitle, attachSubtitle, removeSubtitle, pendingPlaybackRequests, handlePlaybackRequest, playbackRequestStatus, sendPlaybackRequest, clearPlaybackRequestStatus, registerHostTransport, cacheStatus, getCacheInfo, purgeCache],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

const clamp01 = (n: number): number => (!Number.isFinite(n) || n < 0 ? 0 : n > 1 ? 1 : n)

/** Client monotonic clock — must match openSyncSession's timebase so the offset maps correctly. */
const nowMs = (): number =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()

/** Build the join payload from the session meta + the currently-reachable IP. */
function buildJoinPayload(
  meta: { sessionId: string; token: string; httpPort: number; wsPort: number },
  ip: string,
): JoinPayload {
  return {
    v: PROTOCOL_VERSION,
    host: ip,
    wsPort: meta.wsPort,
    httpPort: meta.httpPort,
    sessionId: meta.sessionId,
    token: meta.token,
  }
}

const PARTICIPANT_STATUSES = ['requested', 'approved', 'downloading', 'ready', 'playing', 'buffering', 'left']

/** Validate one roster entry from the network before it drives the lobby UI. */
function isParticipantInfo(p: unknown): p is ParticipantInfo {
  if (typeof p !== 'object' || p === null) return false
  const o = p as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.status === 'string' &&
    PARTICIPANT_STATUSES.includes(o.status) &&
    typeof o.progress === 'number' &&
    typeof o.downloadMbps === 'number'
  )
}

/** Drop a file extension and trim for a tidy "now sharing" title. */
function cleanTitle(name: string): string {
  return name.replace(/\.[^.]+$/, '').slice(0, 60)
}

/** A short, human-shoutable code derived from the (non-secret) session id, for the flap board. */
function humanCode(sessionId: string): string {
  const alnum = sessionId.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return (alnum + 'RAIL').slice(0, 4)
}
