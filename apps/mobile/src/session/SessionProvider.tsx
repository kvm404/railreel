import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PermissionsAndroid, Platform } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import * as LegacyFS from 'expo-file-system/legacy'

import RailReelHost from '../../modules/railreel-host'
import { openSyncSession, type SyncSession } from '@/net/syncClient'
import { reconnectDelayMs } from '@/lib/net/backoff'
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export type Role = 'none' | 'host' | 'client'

/** A person in the lobby, as the UI needs them (grant stays host-side only, never in state). */
export type Participant = {
  id: string
  name: string
  status: ParticipantInfo['status']
  progress: number
  downloadMbps: number
  /** During playback: this follower's player is loading and the room is waiting on it. */
  stalled: boolean
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
  movie: { title: string; sizeBytes: number } | null
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

  // playback (the show)
  /** The local movie file the player should open (host: the picked source; client: the cached copy). */
  movieUri: string | null
  /** Latest authoritative playback state. Host owns it; clients receive it over WS. */
  playback: PlaybackState | null
  /** Host view: names of followers whose player is currently stalled (the room waits on them). */
  waitingFor: string[]

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
  const [movie, setMovie] = useState<{ title: string; sizeBytes: number } | null>(null)
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

  useEffect(() => {
    roleRef.current = role
  }, [role])

  // ── host roster helpers ─────────────────────────────────────────────────────
  const broadcastRoster = useCallback((list: Participant[]) => {
    const payload: ParticipantInfo[] = list.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      progress: p.progress,
      bufferedAheadSec: 0,
      downloadMbps: p.downloadMbps,
    }))
    RailReelHost.broadcast(JSON.stringify({ t: 'roster', participants: payload })).catch(() => {})
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
          return [...without, { id: msg.id, name, status: 'requested', progress: 0, downloadMbps: 0, stalled: false, lastBeatAt: Date.now() }]
        })
      } else if (msg.t === 'heartbeat') {
        if (!ownsId(msg.id, msg.grant) || !Number.isFinite(msg.progress)) return
        const mbps = Number.isFinite(msg.downloadMbps) ? msg.downloadMbps : 0
        const newStatus = msg.progress >= 1 ? 'ready' : 'downloading'
        const newProgress = clamp01(msg.progress)
        // Only re-broadcast the roster when a roster-visible field actually changed — playback
        // heartbeats (progress already 1, only `stalled` toggling) must not spam the control plane.
        const prevP = participantsRef.current.find((p) => p.id === msg.id)
        const rosterChanged = !prevP || (prevP.status !== 'requested' && (prevP.status !== newStatus || prevP.progress !== newProgress))
        updateParticipants(
          (prev) =>
            prev.map((p) =>
              // Only an already-approved guest can report progress (no pre-approval self-ready).
              p.id === msg.id && p.status !== 'requested'
                ? {
                    ...p,
                    progress: newProgress,
                    downloadMbps: mbps,
                    stalled: msg.stalled === true,
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
      }
    })
    return () => onMessage.remove()
  }, [updateParticipants, ownsId])

  // Host: clear a stall whose heartbeats have gone quiet (client left/backgrounded/crashed) so the
  // room never stays paused waiting on someone who isn't coming back.
  useEffect(() => {
    const id = setInterval(() => {
      if (roleRef.current !== 'host') return
      const cutoff = Date.now() - STALE_BEAT_MS
      updateParticipants(
        (prev) =>
          prev.some((p) => p.stalled && p.id !== 'host' && p.lastBeatAt < cutoff)
            ? prev.map((p) => (p.stalled && p.id !== 'host' && p.lastBeatAt < cutoff ? { ...p, stalled: false } : p))
            : prev,
        false,
      )
    }, 1000)
    return () => clearInterval(id)
  }, [updateParticipants])

  // ── host actions ────────────────────────────────────────────────────────────
  const startHost = useCallback(async () => {
    setError(null)
    setHostPhase('starting')
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
      // Only publish a link once we have a real LAN/hotspot IP — a 0.0.0.0/Wi-Fi address would
      // hand guests an unreachable host. refreshJoin() rebuilds it after the hotspot comes up.
      setJoinUrl(ip ? encodeJoinUrl(buildJoinPayload(joinMetaRef.current, ip)) : null)
      setJoinCode(humanCode(sessionId))
      setMovie({ title: cleanTitle(asset.name), sizeBytes: asset.size ?? 0 })
      setMovieUri(asset.uri) // the host plays the same source it shares

      // Seed the roster with the host (it already has the file).
      grantsRef.current.clear()
      // Named "Host" so guests see "Host"; the host's own lobby relabels this entry to "You".
      updateParticipants(() => [{ id: 'host', name: 'Host', status: 'ready', progress: 1, downloadMbps: 0, stalled: false, lastBeatAt: Date.now() }], false)

      setRole('host')
      roleRef.current = 'host'
      setHostPhase('live')
    } catch (e) {
      setError(String(e))
      setHostPhase('idle')
      await RailReelHost.stop().catch(() => {})
      await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {})
    }
  }, [updateParticipants])

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
  const sendBeat = useCallback((frac: number, mbps: number) => {
    const c = clientRef.current
    if (!c) return
    c.session.send({ t: 'heartbeat', id: c.myId, grant: c.grant, progress: frac, downloadMbps: mbps, bufferedAheadSec: 0, positionSec: 0 })
  }, [])

  // Follower → host during playback: report whether our player is keeping up. The host pauses the
  // room while any follower is stalled (loading) and resumes once everyone is ready again.
  const reportPlayback = useCallback((stalled: boolean, positionSec: number) => {
    const c = clientRef.current
    if (!c) return
    c.session.send({ t: 'heartbeat', id: c.myId, grant: c.grant, progress: 1, stalled, downloadMbps: 0, bufferedAheadSec: 0, positionSec })
  }, [])

  const startDownload = useCallback(async () => {
    const c = clientRef.current
    if (!c) return
    setClientPhase('downloading')
    const url = `http://${c.payload.host}:${c.payload.httpPort}/movie?tk=${encodeURIComponent(c.payload.token)}&g=${encodeURIComponent(c.grant)}`
    try {
      const dl = LegacyFS.createDownloadResumable(url, MOVIE_CACHE, {}, (p) => {
        const total = p.totalBytesExpectedToWrite
        const frac = total > 0 ? clamp01(p.totalBytesWritten / total) : 0
        setProgress(frac)
        // Throttle heartbeats to ~3/s so a fast download doesn't flood the control channel.
        const now = Date.now()
        if (now - lastBeatRef.current > 300) {
          lastBeatRef.current = now
          sendBeat(frac, 0)
        }
      })
      downloadRef.current = dl
      const res = await dl.downloadAsync()
      downloadRef.current = null
      // downloadAsync resolves even on 4xx/5xx (writing the error body to disk) — verify the status
      // before trusting the file, or a 403 would show up as "ready".
      if (!res || res.status < 200 || res.status >= 300) {
        await LegacyFS.deleteAsync(MOVIE_CACHE, { idempotent: true }).catch(() => {})
        throw new Error(`download failed (HTTP ${res?.status ?? '?'})`)
      }
      setProgress(1)
      setMovieUri(MOVIE_CACHE) // the cached copy is what the player will open
      setClientPhase('ready')
      // Send over the LIVE session: a reconnect during download swaps clientRef's socket, so the
      // captured `c.session` may be the old, closed one. (sendBeat already reads clientRef fresh.)
      sendBeat(1, 0)
      ;(clientRef.current ?? c).session.send({ t: 'ready', id: c.myId, grant: c.grant, positionSec: 0 })
    } catch (e) {
      downloadRef.current = null
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
            const list: Participant[] = m.participants
              .filter(isParticipantInfo)
              .map((q) => ({
                id: q.id,
                name: q.id === myId ? 'You' : q.name,
                status: q.status,
                progress: clamp01(q.progress),
                downloadMbps: Number.isFinite(q.downloadMbps) ? q.downloadMbps : 0,
                stalled: false, // roster is a lobby-phase view; stall is host-tracked during playback
                lastBeatAt: Date.now(),
              }))
            participantsRef.current = list
            setParticipants(list)
          } else if (m.t === 'state') {
            setPlayback(m.state) // host's authoritative playback; the Player drift-corrects to it
          } else if (m.t === 'ended') {
            leave()
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
    [startDownload],
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
      leave() // tear down first — leave() clears error, so surface ours afterwards
      setError('Lost connection to the host')
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
    [openClient],
  )

  const leave = useCallback(() => {
    leavingRef.current = true // a deliberate teardown — stop any reconnect loop from firing/looping
    reconnectingRef.current = false
    approvedRef.current = false
    epochRef.current++ // invalidate any in-flight reconnect loop so it can't resurrect this session
    setReconnecting(false)
    downloadRef.current?.cancelAsync().catch(() => {})
    downloadRef.current = null
    clientRef.current?.session.close()
    clientRef.current = null
    if (roleRef.current === 'host') {
      RailReelHost.stop().catch(() => {})
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
    setProgress(0)
    setMovieUri(null)
    setPlayback(null)
    setError(null)
    setRole('none')
    roleRef.current = 'none'
  }, [])

  // Followers (not the host) whose player is stalled — the room waits on these.
  const waitingFor = useMemo(
    () => participants.filter((p) => p.id !== 'host' && p.stalled).map((p) => p.name),
    [participants],
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
      movieUri,
      playback,
      waitingFor,
      startHost,
      refreshJoin,
      setHostPlayback,
      reportPlayback,
      hostNowMs,
      approve,
      deny,
      connect,
      leave,
    }),
    [role, error, movie, participants, hostPhase, joinUrl, joinCode, hostIp, clientPhase, progress, hostName, reconnecting, movieUri, playback, waitingFor, startHost, refreshJoin, setHostPlayback, reportPlayback, hostNowMs, approve, deny, connect, leave],
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

/** Drop a file extension and trim for a tidy "now sharing" title. */
function cleanTitle(name: string): string {
  return name.replace(/\.[^.]+$/, '').slice(0, 60)
}

/** A short, human-shoutable code derived from the (non-secret) session id, for the flap board. */
function humanCode(sessionId: string): string {
  const alnum = sessionId.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return (alnum + 'RAIL').slice(0, 4)
}
