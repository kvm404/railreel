import { NativeModule, requireNativeModule } from 'expo'
import { Platform } from 'react-native'

export type HostPorts = { httpPort: number; wsPort: number }

/** What `probe` reports about the picked file (see the native module for how each is derived). */
export type MediaProbeResult = {
  /** 0 when the container carries no readable duration. */
  durationSec: number
  fastStart: boolean
  /** Frame size, 0 when unknown. */
  width: number
  height: number
  /** Android mime of the FIRST video track (e.g. "video/avc", "video/hevc"); "" if none. */
  videoMime: string
  /** Android mime of the FIRST audio track (e.g. "audio/mp4a-latm", "audio/ac3"); "" if none. */
  audioMime: string
  /** All tracks the extractor found (video + audio + text/other). */
  trackCount: number
  audioTrackCount: number
  /** Container hint sniffed from the first bytes: "mp4" | "quicktime" | "matroska" | "unknown". */
  container: string
}

type RailReelHostEvents = {
  onWsOpen: () => void
  onWsClose: (event?: { id?: string }) => void
  onWsMessage: (event: { data: string }) => void
  /** mDNS discovery: a nearby cabin appeared (TXT mirrors the QR payload). */
  onNsdFound: (event: { name: string; host: string; port: number; txt: Record<string, string> }) => void
  onNsdLost: (event: { name: string }) => void
  /** mDNS discovery could not start (Android reports this asynchronously, after startDiscovery resolved). */
  onNsdError: (event: { code: number }) => void
}

declare class RailReelHostModule extends NativeModule<RailReelHostEvents> {
  /** This device's LAN/hotspot IPv4 for the join link, or null if none found. */
  getHostIpAddress(): string | null
  /** The host's monotonic clock in ms (matches the WS sync timebase); for stamping PlaybackState. */
  getMonotonicMs(): number
  /** Start the HTTP (range) + WebSocket (control) servers. Ports 0 = OS-assigned.
   *  `fileUri` may be a file:// path or a content:// (SAF) URI from the document picker. */
  start(fileUri: string, httpPort: number, wsPort: number, token: string): Promise<HostPorts>
  /** Authorize a client's download grant so the data plane will serve it bytes (§10). */
  approve(grant: string): Promise<void>
  /** Revoke a previously-approved grant; future requests with it are rejected. */
  revoke(grant: string): Promise<void>
  /** Send a JSON message to every connected client (play/pause/seek/chat/reactions). */
  broadcast(message: string): Promise<void>
  /** Stop both servers + the foreground service. */
  stop(): Promise<void>
  /**
   * Read media metadata + real track codecs from a file:// or content:// source — for the
   * start-gate math and the H.264/AAC-in-MP4 compatibility verdict (`lib/media/compat`).
   * `fastStart` = the MP4's moov atom precedes mdat, i.e. a player can open a partial file —
   * false means only a full pre-cache start is safe. `width`/`height` are 0 when unknown and
   * feed the client decode-capability check. Rejects when the container can't be parsed.
   */
  probe(fileUri: string): Promise<MediaProbeResult>
  /**
   * Client: start the localhost playback proxy over the still-downloading movie file, declaring
   * its final size — the player streams from this instead of opening a partially-written file.
   * Returns the bound 127.0.0.1 port.
   */
  startProxy(filePath: string, expectedBytes: number): Promise<number>
  /** Stop the playback proxy (idempotent). */
  stopProxy(): Promise<void>
  /** Can this device's decoder handle the frame size? (Unknown size → true; never blocks on a diagnostic.) */
  canDecode(mime: string, width: number, height: number): boolean
  /** Battery preflight for the hosting phone. level is 0..1, or -1 when unknown. */
  getBatteryStatus(): { level: number; charging: boolean }
  /** Quick integrity fingerprint: sha256(head 1MB + tail 1MB + size), as "qf1:<hex>". */
  fingerprint(fileUri: string, sizeBytes: number): Promise<string>
  /** Host: advertise the session on mDNS (_railreel._tcp); TXT mirrors the QR payload. */
  advertise(name: string, port: number, txt: Record<string, string>): Promise<void>
  stopAdvertise(): Promise<void>
  /** Guest: stream nearby cabins via onNsdFound/onNsdLost. */
  startDiscovery(): Promise<void>
  stopDiscovery(): Promise<void>
}

// Android-only native module. In non-Android environments (e.g. tests), expose a stub so importing it
// (which runs at module-load time) never throws.
const androidOnly = (): RailReelHostModule => {
  const unavailable = async () => {
    throw new Error('RailReelHost is only available on Android')
  }
  return {
    getHostIpAddress: () => null,
    getMonotonicMs: () => Date.now(),
    start: unavailable,
    approve: async () => {},
    revoke: async () => {},
    broadcast: async () => {},
    stop: async () => {},
    probe: unavailable,
    startProxy: unavailable,
    stopProxy: async () => {},
    canDecode: () => true,
    getBatteryStatus: () => ({ level: -1, charging: false }),
    fingerprint: unavailable,
    advertise: async () => {},
    stopAdvertise: async () => {},
    startDiscovery: async () => {},
    stopDiscovery: async () => {},
    addListener: () => ({ remove: () => {} }),
    removeAllListeners: () => {},
  } as unknown as RailReelHostModule
}

export default Platform.OS === 'android'
  ? requireNativeModule<RailReelHostModule>('RailReelHost')
  : androidOnly()
