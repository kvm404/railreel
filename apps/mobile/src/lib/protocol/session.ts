/**
 * Session & participant model (pure types + small helpers).
 *
 * A session is owned by one host. Clients request to join, the host approves,
 * then clients move through readiness toward synchronized playback. See
 * docs/architecture.md §3 and §10.
 */

export const RAILREEL_SERVICE_TYPE = '_railreel._tcp'

/** Lifecycle of a participant from the host's point of view. */
export type ParticipantStatus =
  | 'requested' // asked to join, awaiting host approval
  | 'approved' // approved; may begin downloading
  | 'downloading' // pulling the movie
  | 'ready' // buffered/cached enough to start
  | 'playing' // in synchronized playback
  | 'buffering' // fell behind the buffer floor; group may be waiting on them
  | 'left' // disconnected / removed

/** Media the host is sharing, with integrity + sizing metadata. */
export interface MediaInfo {
  /** Display title (filename-derived or user-set). */
  title: string
  /** Total bytes of the movie file. */
  sizeBytes: number
  /** Duration in seconds. */
  durationSec: number
  /** Average bitrate in megabits/sec (for the start-gate math). */
  bitrateMbps: number
  /** Content hash (e.g. sha256) so clients can verify what they received. */
  hash: string
  /** Container/codec summary, e.g. "mp4 / h264 / aac". */
  format: string
  /** moov before mdat — a player can open a partially-downloaded copy (progressive start). */
  fastStart?: boolean
  /** Video frame size (0 = unknown) — for the client decode-capability check (a 4K file is a slideshow on a 1080p-max decoder). */
  width?: number
  height?: number
  /** Android mime of the first video / audio track (e.g. "video/avc"). Guests check THEIR decoder against the real codec; absent from older hosts → assume H.264. */
  videoMime?: string
  audioMime?: string
  /** Sidecar subtitle metadata attached by the host. */
  subtitle?: {
    name: string
    sizeBytes: number
    content?: string
  }
}

/** Validate media metadata off the wire before it drives buffer math or decode checks. */
export function isMediaInfo(m: unknown): m is MediaInfo {
  if (typeof m !== 'object' || m === null) return false
  const o = m as Record<string, unknown>
  return (
    typeof o.title === 'string' &&
    typeof o.sizeBytes === 'number' &&
    Number.isFinite(o.sizeBytes) &&
    o.sizeBytes > 0 &&
    typeof o.durationSec === 'number' &&
    Number.isFinite(o.durationSec) &&
    o.durationSec >= 0 &&
    // Optional codec hints: wrong-typed values reject the whole media block, like the other fields.
    (o.videoMime === undefined || typeof o.videoMime === 'string') &&
    (o.audioMime === undefined || typeof o.audioMime === 'string')
  )
}

/** Everything a client needs to connect to a host, encoded into the QR/link. */
export interface JoinPayload {
  /** Protocol version, so old/new apps can refuse mismatches. */
  v: number
  /** Host LAN IP address (e.g. "192.168.43.1"). */
  host: string
  /** Port of the WebSocket control plane. */
  wsPort: number
  /** Port of the HTTP data plane. */
  httpPort: number
  /** Opaque session id. */
  sessionId: string
  /** High-entropy secret required on every WS + HTTP request (see §10). */
  token: string
}

export interface ParticipantInfo {
  id: string
  name: string
  status: ParticipantStatus
  /** Fraction of the movie this client has cached (0–1). Drives the lobby readiness ring. */
  progress: number
  /** Seconds of media buffered ahead of this client's playhead. */
  bufferedAheadSec: number
  /** Last measured download throughput (Mbps) under real conditions. */
  downloadMbps: number
  /** False when this client's decoder can't handle the movie's frame size. */
  decodeOk?: boolean
}

export const PROTOCOL_VERSION = 1
