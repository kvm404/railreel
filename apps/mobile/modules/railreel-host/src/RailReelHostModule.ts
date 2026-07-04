import { NativeModule, requireNativeModule } from 'expo'
import { Platform } from 'react-native'

export type HostPorts = { httpPort: number; wsPort: number }

type RailReelHostEvents = {
  onWsOpen: () => void
  onWsClose: () => void
  onWsMessage: (event: { data: string }) => void
  /** mDNS discovery: a nearby cabin appeared (TXT mirrors the QR payload). */
  onNsdFound: (event: { name: string; host: string; port: number; txt: Record<string, string> }) => void
  onNsdLost: (event: { name: string }) => void
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
   * Read media metadata from a file:// or content:// source, for the start-gate math.
   * `fastStart` = the MP4's moov atom precedes mdat, i.e. a player can open a partial file —
   * false means only a full pre-cache start is safe. `width`/`height` are 0 when unknown and
   * feed the (future) client decode-capability check.
   */
  probe(fileUri: string): Promise<{ durationSec: number; fastStart: boolean; width: number; height: number }>
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
  /** DEV (M1): write an N-MB test file to cache and return its file:// uri. */
  createTestFile(sizeMb: number): Promise<string>
}

// Android-only native module. On other platforms, expose a stub so importing it (which runs at
// module-load time) never throws — the host role is Android-first for v1.
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
    createTestFile: unavailable,
    addListener: () => ({ remove: () => {} }),
    removeAllListeners: () => {},
  } as unknown as RailReelHostModule
}

export default Platform.OS === 'android'
  ? requireNativeModule<RailReelHostModule>('RailReelHost')
  : androidOnly()
