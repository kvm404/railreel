import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PermissionsAndroid, Platform } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import * as LegacyFS from 'expo-file-system/legacy'

import RailReelHost from '../../modules/railreel-host'
import { openSyncSession, type SyncSession } from '@/net/syncClient'
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

export type Role = 'none' | 'host' | 'client'

/** A person in the lobby, as the UI needs them (grant stays host-side only, never in state). */
export type Participant = {
  id: string
  name: string
  status: ParticipantInfo['status']
  progress: number
  downloadMbps: number
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

  // actions
  startHost: () => Promise<void>
  /** Recompute the join link from the current device IP (call after enabling the hotspot). */
  refreshJoin: () => void
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
  // Reserved for M6 when the join link carries the host's name; null in M5.
  const [hostName] = useState<string | null>(null)

  // Mutable session handles + identity, read from listeners without stale closures.
  const roleRef = useRef<Role>('none')
  const hostTokenRef = useRef<string | null>(null)
  const grantsRef = useRef<GrantMap>(new Map())
  const participantsRef = useRef<Participant[]>([])
  const clientRef = useRef<{ session: SyncSession; payload: JoinPayload; grant: string; myId: string } | null>(null)
  const lastBeatRef = useRef(0)
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
    (id: string, grant: string): boolean => id !== 'host' && grantsRef.current.get(id) === grant,
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
          return [...without, { id: msg.id, name, status: 'requested', progress: 0, downloadMbps: 0 }]
        })
      } else if (msg.t === 'heartbeat') {
        if (!ownsId(msg.id, msg.grant) || !Number.isFinite(msg.progress)) return
        const mbps = Number.isFinite(msg.downloadMbps) ? msg.downloadMbps : 0
        updateParticipants((prev) =>
          prev.map((p) =>
            // Only an already-approved guest can report progress (no pre-approval self-ready).
            p.id === msg.id && p.status !== 'requested'
              ? {
                  ...p,
                  progress: clamp01(msg.progress),
                  downloadMbps: mbps,
                  status: msg.progress >= 1 ? 'ready' : 'downloading',
                }
              : p,
          ),
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

      // Seed the roster with the host (it already has the file).
      grantsRef.current.clear()
      // Named "Host" so guests see "Host"; the host's own lobby relabels this entry to "You".
      updateParticipants(() => [{ id: 'host', name: 'Host', status: 'ready', progress: 1, downloadMbps: 0 }], false)

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
      setClientPhase('ready')
      sendBeat(1, 0)
      c.session.send({ t: 'ready', id: c.myId, grant: c.grant, positionSec: 0 })
    } catch (e) {
      downloadRef.current = null
      setError(String(e))
      setClientPhase('approved') // allow a retry
    }
  }, [sendBeat])

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
      try {
        const onClose = () => {
          // The socket dropped after we were live (host stopped / WiFi loss). Tear down so the UI
          // doesn't sit on a dead session. (Reconnection is M6.)
          if (roleRef.current === 'client') {
            setError('Disconnected from host')
            leave()
          }
        }
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
                setClientPhase('approved')
                startDownload()
              } else {
                setClientPhase('denied')
              }
            } else if (m.t === 'roster' && Array.isArray(m.participants)) {
              const list: Participant[] = m.participants
                .filter(isParticipantInfo)
                .map((p) => ({
                  id: p.id,
                  name: p.id === myId ? 'You' : p.name,
                  status: p.status,
                  progress: clamp01(p.progress),
                  downloadMbps: Number.isFinite(p.downloadMbps) ? p.downloadMbps : 0,
                }))
              participantsRef.current = list
              setParticipants(list)
            } else if (m.t === 'ended') {
              leave()
            }
          },
          onClose,
        )
        clientRef.current = { session, payload, grant, myId }
        // hostName stays null in M5 — the join link doesn't carry the host's name yet (M6).
        setRole('client')
        roleRef.current = 'client'
        setClientPhase('requested')
        session.send({ t: 'join', id: myId, name, token: payload.token, grant })
      } catch (e) {
        setError(String(e))
        setClientPhase('idle')
      }
    },
    // `leave` (stable, no deps) is referenced via closure; startDownload is the only changing dep.
    [startDownload],
  )

  const leave = useCallback(() => {
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
    setError(null)
    setRole('none')
    roleRef.current = 'none'
  }, [])

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
      startHost,
      refreshJoin,
      approve,
      deny,
      connect,
      leave,
    }),
    [role, error, movie, participants, hostPhase, joinUrl, joinCode, hostIp, clientPhase, progress, hostName, startHost, refreshJoin, approve, deny, connect, leave],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

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
