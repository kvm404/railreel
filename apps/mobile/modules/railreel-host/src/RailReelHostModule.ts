import { NativeModule, requireNativeModule } from 'expo'
import { Platform } from 'react-native'

export type HostPorts = { httpPort: number; wsPort: number }

type RailReelHostEvents = {
  onWsOpen: () => void
  onWsClose: () => void
  onWsMessage: (event: { data: string }) => void
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
   * false means only a full pre-cache start is safe.
   */
  probe(fileUri: string): Promise<{ durationSec: number; fastStart: boolean }>
  /**
   * Client: start the localhost playback proxy over the still-downloading movie file, declaring
   * its final size — the player streams from this instead of opening a partially-written file.
   * Returns the bound 127.0.0.1 port.
   */
  startProxy(filePath: string, expectedBytes: number): Promise<number>
  /** Stop the playback proxy (idempotent). */
  stopProxy(): Promise<void>
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
    createTestFile: unavailable,
    addListener: () => ({ remove: () => {} }),
    removeAllListeners: () => {},
  } as unknown as RailReelHostModule
}

export default Platform.OS === 'android'
  ? requireNativeModule<RailReelHostModule>('RailReelHost')
  : androidOnly()
