import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PermissionsAndroid, Platform } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import * as LegacyFS from 'expo-file-system/legacy'

import RailReelHost from '../../modules/railreel-host'
import { openSyncSession, type SyncSession } from '@/net/syncClient'
import { reconnectDelayMs } from '@/lib/net/backoff'
import {
  appendCapped,
  isValidReaction,
  sanitizeChatText,
  type ChatEntry,
  type ReactionEvent,
} from '@/lib/social/feed'
import { batteryWarning, decodeWarning, storageWarning } from '@/lib/media/preflight'
import { downloadBufferedAheadSec, smoothedMbps, updateFloorHolds } from '@/lib/sync/startGate'
import { randomBytes } from '@/net/random'
import {
  decodeJoinUrl,
  encodeJoinUrl,
  generateGrant,
  generateSessionId,
  isValidSecret,
  newSession,
  parseClientMsg,
  parseServerMsg,
  PROTOCOL_VERSION,
  type JoinPayload,
  type MediaInfo,
  type ParticipantInfo,
  type PlaybackState,
} from '@/lib/protocol'

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
const MOVIE_CACHE = `${LegacyFS.cacheDirectory}railreel-movie.bin`
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
  /** Send a chat line to the room (host broadcasts; a guest routes via the host). */
  sendChat: (text: string) => void
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
  /** Client: retry a failed download without re-joining (the grant + approval still stand). */
  retryDownload: () => void
  /** Clear the session-end status once the user acknowledges it. */
  dismissEnd: () => void
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
  const [chatLog, setChatLog] = useState<ChatEntry[]>([])
  const [reactions, setReactions] = useState<ReactionEvent[]>([])
  const reactionSeqRef = useRef(0) // animation keys + lane assignment for incoming reactions
  const lastReactionSentRef = useRef(0) // client-side reaction rate limit
  const [decodeCaution, setDecodeCaution] = useState<string | null>(null)
  const [hostWarning, setHostWarning] = useState<string | null>(null)
  const [sessionEnd, setSessionEnd] = useState<SessionEnd | null>(null)
  const decodeOkRef = useRef(true) // rides every heartbeat so the host's lobby can flag us

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

  useEffect(() => {
    roleRef.current = role
  }, [role])

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
  const broadcastRoster = useCallback((list: Participant[]) => {
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
    RailReelHost.broadcast(JSON.stringify({ t: 'roster', participants: payload, media })).catch(() => {})
  }, [])

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
  const ingestChat = useCallback((from: string, text: string, at: number) => {
    setChatLog((log) => appendCapped(log, { from, text, at }, CHAT_LOG_CAP))
  }, [])
  const ingestReaction = useCallback((from: string, emoji: string) => {
    const seq = ++reactionSeqRef.current
    setReactions((r) => appendCapped(r, { seq, from, emoji, at: Date.now() }, REACTION_KEEP))
  }, [])

  // A later client→host frame is trusted only if it proves ownership of its `id` with the grant
  // the host stored at join time. Blocks spoofing a peer's row or the reserved "host" id.
  const ownsId = useCallback(
    (id: unknown, grant: unknown): boolean =>
      typeof id === 'string' &&
      typeof grant === 'string' &&
      id !== 'host' &&
      grantsRef.current.get(id) === grant,
    [],
  )

  // ── WS event wiring (host side; registered once) ────────────────────────────
  useEffect(() => {
    const onMessage = RailReelHost.addListener('onWsMessage', ({ data }) => {
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
          typeof msg.name !== 'string' ||
          msg.name.length === 0
        ) {
          return
        }
        const name = msg.name.slice(0, 40)
        grantsRef.current.set(msg.id, msg.grant)
        updateParticipants((prev) => {
          const without = prev.filter((p) => p.id !== msg.id)
          return [...without, { id: msg.id, name, status: 'requested', progress: 0, downloadMbps: 0, bufferedAheadSec: 0, stalled: false, inShow: false, decodeOk: true, lastBeatAt: Date.now() }]
        })
      } else if (msg.t === 'heartbeat') {
        if (!ownsId(msg.id, msg.grant) || !Number.isFinite(msg.progress)) return
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
              // Only an already-approved guest can report progress (no pre-approval self-ready).
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
        if (!ownsId(msg.id, msg.grant)) return
        updateParticipants((prev) =>
          prev.map((p) => (p.id === msg.id && p.status !== 'requested' ? { ...p, status: 'ready', progress: 1 } : p)),
        )
      } else if (msg.t === 'chat') {
        // Hub: validate ownership + content, stamp the sender's NAME and our clock, fan out.
        if (!ownsId(msg.id, msg.grant)) return
        const text = sanitizeChatText(typeof msg.text === 'string' ? msg.text : '')
        if (!text) return
        const name = participantsRef.current.find((p) => p.id === msg.id)?.name ?? 'Guest'
        const at = Date.now()
        RailReelHost.broadcast(JSON.stringify({ t: 'chat', from: name, text, at })).catch(() => {})
        ingestChat(name, text, at)
      } else if (msg.t === 'reaction') {
        if (!ownsId(msg.id, msg.grant) || !isValidReaction(msg.emoji)) return
        const name = participantsRef.current.find((p) => p.id === msg.id)?.name ?? 'Guest'
        RailReelHost.broadcast(JSON.stringify({ t: 'reaction', from: name, emoji: msg.emoji, at: Date.now() })).catch(() => {})
        ingestReaction(name, msg.emoji)
      }
    })
    return () => onMessage.remove()
  }, [updateParticipants, ownsId, ingestChat, ingestReaction])

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
  const resetTransfer = useCallback(() => {
    downloadRef.current?.cancelAsync().catch(() => {})
    downloadRef.current = null
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
  }, [])

  // ── host actions ────────────────────────────────────────────────────────────
  const startHost = useCallback(async () => {
    setError(null)
    setHostPhase('starting')
    // Re-hosting (or hosting after having been a guest) must not inherit the previous session:
    // stale playback would yank fresh guests straight into the Player, and a leftover download /
    // floor-hold would corrupt the new gate's math. Bump the epoch so any zombie transfer bails.
    epochRef.current++
    resetTransfer()
    setPlayback(null)
    setFloorHeld(new Set())
    setChatLog([])
    setReactions([])
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: 'video/*', copyToCacheDirectory: false })
      if (picked.canceled || !picked.assets[0]) {
        setHostPhase('idle')
        return
      }
      const asset = picked.assets[0]

      // Android 13+ needs runtime notification permission for the foreground-service notification.
      if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => {})
      }

      const { sessionId, token } = newSession(randomBytes)
      hostTokenRef.current = token
      const ports = await RailReelHost.start(asset.uri, HTTP_PORT, WS_PORT, token)
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG)

      joinMetaRef.current = { sessionId, token, httpPort: ports.httpPort, wsPort: ports.wsPort }
      const ip = RailReelHost.getHostIpAddress()
      setHostIp(ip)

      // Tap-to-join: advertise the session on mDNS. The TXT mirrors the QR payload (the host IP
      // comes from NSD resolution itself, so hotspot IP changes never stale the advert). Anyone
      // on the network can *request* to join — the trust model already assumes that: the host
      // approves every person, and bytes flow only to approved grants (architecture §10).
      RailReelHost.advertise(`RailReel-${humanCode(sessionId)}`, ports.wsPort, {
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
      // whether a partial copy is even playable. If the probe fails we keep going with 0/false:
      // the gate then degrades to "start after full pre-cache".
      const probed = await RailReelHost.probe(asset.uri).catch(() => ({ durationSec: 0, fastStart: false, width: 0, height: 0 }))
      const durationSec = Number.isFinite(probed.durationSec) && probed.durationSec > 0 ? probed.durationSec : 0
      const fastStart = probed.fastStart === true
      const sizeBytes = asset.size ?? 0
      const title = cleanTitle(asset.name)
      // Quick integrity fingerprint (head+tail+size) — clients verify their copy against it after
      // the download. Best-effort: an unprobeable source just skips verification.
      const hash = sizeBytes > 0 ? await RailReelHost.fingerprint(asset.uri, sizeBytes).catch(() => '') : ''
      mediaRef.current = {
        title,
        sizeBytes,
        durationSec,
        bitrateMbps: durationSec > 0 ? (sizeBytes * 8) / durationSec / 1e6 : 0,
        hash,
        format: '',
        fastStart,
        width: probed.width || 0,
        height: probed.height || 0,
      }
      setMovie({ title, sizeBytes, durationSec, fastStart })
      setMovieUri(asset.uri) // the host plays the same source it shares

      // Seed the roster with the host (it already has the file).
      grantsRef.current.clear()
      // Named "Host" so guests see "Host"; the host's own lobby relabels this entry to "You".
      updateParticipants(() => [{ id: 'host', name: 'Host', status: 'ready', progress: 1, downloadMbps: 0, bufferedAheadSec: Infinity, stalled: false, inShow: false, decodeOk: true, lastBeatAt: Date.now() }], false)

      setRole('host')
      roleRef.current = 'host'
      setHostPhase('live')
    } catch (e) {
      setError(String(e))
      setHostPhase('idle')
      await RailReelHost.stop().catch(() => {})
      await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {})
    }
  }, [updateParticipants, resetTransfer])

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
    const state: PlaybackState = {
      positionSec,
      rate,
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
      const grant = grantsRef.current.get(id)
      if (!grant) return
      RailReelHost.approve(grant)
        .then(() => {
          RailReelHost.broadcast(JSON.stringify({ t: 'requestDecision', id, approved: true })).catch(() => {})
          updateParticipants((prev) =>
            prev.map((p) => (p.id === id ? { ...p, status: 'approved' } : p)),
          )
        })
        .catch((e) => setError(String(e)))
    },
    [updateParticipants],
  )

  const deny = useCallback(
    (id: string) => {
      const grant = grantsRef.current.get(id)
      if (grant) RailReelHost.revoke(grant).catch(() => {})
      grantsRef.current.delete(id)
      RailReelHost.broadcast(JSON.stringify({ t: 'requestDecision', id, approved: false })).catch(() => {})
      updateParticipants((prev) => prev.filter((p) => p.id !== id))
    },
    [updateParticipants],
  )

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
      positionRef.current = positionSec
      sendBeat()
    },
    [sendBeat],
  )

  // ── social (the cabin) ──────────────────────────────────────────────────────
  // Both role-aware: the host IS the hub (stamp + broadcast + local append); a guest routes via
  // the host and waits for the echo — the host's ordering is the only ordering.
  const sendChat = useCallback(
    (raw: string) => {
      const text = sanitizeChatText(raw)
      if (!text) return
      if (roleRef.current === 'host') {
        const at = Date.now()
        RailReelHost.broadcast(JSON.stringify({ t: 'chat', from: 'Host', text, at })).catch(() => {})
        ingestChat('You', text, at)
      } else {
        const c = clientRef.current
        if (c) c.session.send({ t: 'chat', id: c.myId, grant: c.grant, text })
      }
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
        RailReelHost.broadcast(JSON.stringify({ t: 'reaction', from: 'Host', emoji, at: now })).catch(() => {})
        ingestReaction('You', emoji)
      } else {
        const c = clientRef.current
        if (c) c.session.send({ t: 'reaction', id: c.myId, grant: c.grant, emoji })
      }
    },
    [ingestReaction],
  )

  const startDownload = useCallback(async () => {
    const c = clientRef.current
    if (!c) return
    // Re-entrancy guard: a duplicate approval (host double-tap, decision re-delivered after a
    // reconnect) must NOT start a second download — two writers on the same cache file, and
    // either one's failure path deleting the file out from under the other (the player then
    // streams a ghost inode the proxy can't see).
    if (downloadRef.current) {
      return
    }
    // Session epoch at start: if a leave()/new connect() bumps it, this download is a zombie —
    // it must not write telemetry, state, or errors into whatever session came after it.
    const myEpoch = epochRef.current
    const stale = (): boolean => epochRef.current !== myEpoch
    setClientPhase('downloading')
    const url = `http://${c.payload.host}:${c.payload.httpPort}/movie?tk=${encodeURIComponent(c.payload.token)}&g=${encodeURIComponent(c.grant)}`
    try {
      // Clear any stale partial from a previous attempt BEFORE the download opens the file —
      // never after another attempt may have started (deleting a file mid-write detaches the
      // writer onto a deleted inode while the proxy reads the path).
      await LegacyFS.deleteAsync(MOVIE_CACHE, { idempotent: true }).catch(() => {})

      // Storage preflight (PRD §8: surface the 1–4 GB requirement up front, not at 97%).
      const freeBytes = await LegacyFS.getFreeDiskStorageAsync().catch(() => -1)
      const storageMsg = storageWarning(freeBytes, mediaRef.current?.sizeBytes ?? 0)
      if (storageMsg) {
        setError(storageMsg)
        setClientPhase('approved') // freeing space + a re-approval retries
        return
      }
      const dl = LegacyFS.createDownloadResumable(url, MOVIE_CACHE, {}, (p) => {
        if (stale()) return // a newer session owns the telemetry refs now
        const total = p.totalBytesExpectedToWrite
        const frac = total > 0 ? clamp01(p.totalBytesWritten / total) : 0
        progressRef.current = frac
        setProgress(frac)

        // Measured throughput (smoothed) — the number the host's start gate reasons about.
        const now = Date.now()
        const sample = mbpsSampleRef.current
        if (!sample) {
          mbpsSampleRef.current = { bytes: p.totalBytesWritten, ms: now }
        } else if (now - sample.ms >= 1000) {
          mbpsRef.current = smoothedMbps(mbpsRef.current, p.totalBytesWritten - sample.bytes, now - sample.ms)
          mbpsSampleRef.current = { bytes: p.totalBytesWritten, ms: now }
        }

        // Progressive playback: as soon as we know the final size, stand up the localhost proxy
        // over the growing file and hand THAT to the player — never the partially-written file.
        if (total > 0 && proxyStateRef.current === 'idle') {
          proxyStateRef.current = 'starting'
          RailReelHost.startProxy(MOVIE_CACHE, total)
            .then((port) => {
              if (stale()) return // a newer session owns the proxy state (its own startProxy replaces this server)
              proxyStateRef.current = 'up'
              setMovieUri(`http://127.0.0.1:${port}/movie`)
            })
            .catch(() => {
              if (stale()) return
              // Full pre-cache fallback — and if the download already finished while we were
              // starting, the completion block has passed, so set the source here.
              proxyStateRef.current = 'failed'
              if (progressRef.current >= 1) setMovieUri(MOVIE_CACHE)
            })
        }

        // Throttle heartbeats to ~3/s so a fast download doesn't flood the control channel. Once
        // our player is live the PlayerScreen's report loop is already beating — don't double up.
        if (!inShowRef.current && now - lastBeatRef.current > 300) {
          lastBeatRef.current = now
          sendBeat()
        }
      })
      downloadRef.current = dl
      const res = await dl.downloadAsync()
      if (stale() || downloadRef.current !== dl) return // superseded — not ours to finish
      downloadRef.current = null
      // downloadAsync resolves even on 4xx/5xx (writing the error body to disk) — verify the status
      // before trusting the file, or a 403 would show up as "ready".
      if (!res || res.status < 200 || res.status >= 300) {
        await LegacyFS.deleteAsync(MOVIE_CACHE, { idempotent: true }).catch(() => {})
        throw new Error(`download failed (HTTP ${res?.status ?? '?'})`)
      }
      // Integrity: our copy must match the host's fingerprint — but only pre-show. During a
      // progressive show the proxy is actively serving this file (deleting it would kill the
      // playback that's demonstrably working); a truly wrong file would never have decoded.
      const expected = mediaRef.current?.hash ?? ''
      const expectedSize = mediaRef.current?.sizeBytes ?? 0
      if (!inShowRef.current && expected.startsWith('qf1:') && expectedSize > 0) {
        const local = await RailReelHost.fingerprint(MOVIE_CACHE, expectedSize).catch(() => '')
        if (local !== expected) {
          await LegacyFS.deleteAsync(MOVIE_CACHE, { idempotent: true }).catch(() => {})
          throw new Error('The downloaded copy failed its integrity check — try approving again.')
        }
      }
      progressRef.current = 1
      setProgress(1)
      // If the proxy is serving the show (or about to — its .then/.catch sets the source), leave
      // it alone: swapping the source mid-playback would rebuffer. Otherwise this is the
      // pre-cache path — open the finished file directly.
      if (proxyStateRef.current === 'idle' || proxyStateRef.current === 'failed') setMovieUri(MOVIE_CACHE)
      setClientPhase('ready')
      sendBeat()
      ;(clientRef.current ?? c).session.send({ t: 'ready', id: c.myId, grant: c.grant, positionSec: positionRef.current })
    } catch (e) {
      if (stale()) return // a zombie's failure must not clobber the next session's phase/error
      downloadRef.current = null
      // NOTE: no deleteAsync here — a failed transfer's partial bytes are harmless (a retry
      // truncates them) and the path may already belong to a newer attempt.
      setError(String(e))
      setClientPhase('approved') // allow a retry
    }
  }, [sendBeat])

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
          const r = parseServerMsg(JSON.stringify(raw))
          if (!r.ok) return
          const m = r.msg
          if (m.t === 'requestDecision' && m.id === myId) {
            if (m.approved) {
              approvedRef.current = true // from now on, reconnects resume silently (no re-join)
              setClientPhase('approved')
              startDownload()
            } else {
              setClientPhase('denied')
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
              const ok = w > 0 && h > 0 ? RailReelHost.canDecode('video/avc', w, h) : true
              decodeOkRef.current = ok
              setDecodeCaution(decodeWarning(ok, h))
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
              ingestChat(m.from === name ? 'You' : m.from, m.text.slice(0, 280), m.at)
            }
          } else if (m.t === 'reaction') {
            if (typeof m.from === 'string' && isValidReaction(m.emoji)) {
              ingestReaction(m.from === name ? 'You' : m.from, m.emoji)
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
          if (!leavingRef.current && roleRef.current === 'client') reconnectRef.current()
        },
      )
      if (initial) session.send({ t: 'join', id: myId, name, token: payload.token, grant })
      return session
    },
    [startDownload, ingestChat, ingestReaction],
  )

  // Reconnect loop: re-handshake with exponential backoff, then resume the same session identity.
  // Gives up (and tears down) after MAX_RECONNECT_ATTEMPTS so the UI can't hang forever.
  const reconnect = useCallback(async () => {
    const c = clientRef.current
    if (!c || reconnectingRef.current || leavingRef.current) return
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
  }, [openClient])

  useEffect(() => {
    reconnectRef.current = reconnect
  }, [reconnect])

  const connect = useCallback(
    async (joinLink: string, name: string) => {
      setError(null)
      setClientPhase('connecting')
      let payload: JoinPayload
      try {
        payload = decodeJoinUrl(joinLink.trim())
      } catch (e) {
        setError(`Bad join link: ${String(e)}`)
        setClientPhase('idle')
        return
      }
      const myId = generateSessionId(randomBytes)
      const grant = generateGrant(randomBytes)
      leavingRef.current = false
      approvedRef.current = false
      epochRef.current++ // a fresh session — invalidate any reconnect loop left over from a prior one
      // A fresh join must not inherit ANYTHING from a previous session: no zombie download feeding
      // the gate a dying transfer rate, no stale playback state yanking us straight into the
      // Player, no leftover roster/media.
      resetTransfer()
      clientRef.current?.session.close()
      clientRef.current = null
      mediaRef.current = null
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
    [openClient, resetTransfer],
  )

  const leave = useCallback(() => {
    leavingRef.current = true // a deliberate teardown — stop any reconnect loop from firing/looping
    reconnectingRef.current = false
    approvedRef.current = false
    epochRef.current++ // invalidate any in-flight reconnect loop so it can't resurrect this session
    setReconnecting(false)
    resetTransfer()
    mediaRef.current = null
    setFloorHeld(new Set())
    clientRef.current?.session.close()
    clientRef.current = null
    if (roleRef.current === 'host') {
      // Tell guests the cabin's closing BEFORE the servers die — they get the graceful
      // "cabin went dark" moment instantly, instead of a ~30s reconnect timeout → "lost".
      RailReelHost.broadcast(JSON.stringify({ t: 'ended', reason: 'host-left' })).catch(() => {})
      setTimeout(() => RailReelHost.stop().catch(() => {}), 200) // let the frame flush first
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {})
    }
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
    setDecodeCaution(null)
    decodeOkRef.current = true
    setHostWarning(null)
    setSessionEnd(null)
    setError(null)
    setRole('none')
    roleRef.current = 'none'
  }, [resetTransfer])

  // Client: retry a download that failed (bad HTTP, integrity mismatch). The grant + approval
  // still stand, so we just kick the transfer again.
  const retryDownload = useCallback(() => {
    setError(null)
    startDownload()
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
      retryDownload,
      dismissEnd,
    }),
    [role, error, movie, participants, hostPhase, joinUrl, joinCode, hostIp, clientPhase, progress, hostName, reconnecting, decodeCaution, hostWarning, sessionEnd, movieUri, playback, waitingFor, chatLog, reactions, sendChat, sendReaction, startHost, refreshJoin, setHostPlayback, reportPlayback, hostNowMs, approve, deny, connect, leave, retryDownload, dismissEnd],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

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

/** Validate the media metadata off the roster before it drives buffer math. */
function isMediaInfo(m: unknown): m is MediaInfo {
  if (typeof m !== 'object' || m === null) return false
  const o = m as Record<string, unknown>
  return (
    typeof o.title === 'string' &&
    typeof o.sizeBytes === 'number' &&
    Number.isFinite(o.sizeBytes) &&
    o.sizeBytes > 0 &&
    typeof o.durationSec === 'number' &&
    Number.isFinite(o.durationSec) &&
    o.durationSec >= 0
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
