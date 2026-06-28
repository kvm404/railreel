import { NativeModule, requireNativeModule } from 'expo'
import { Platform } from 'react-native'

export type HostPorts = { httpPort: number; wsPort: number }

type RailReelHostEvents = {
  onWsOpen: () => void
  onWsClose: () => void
  onWsMessage: (event: { data: string }) => void
}

declare class RailReelHostModule extends NativeModule<RailReelHostEvents> {
  /** Start the HTTP (range) + WebSocket (control) servers. Ports 0 = OS-assigned. */
  start(fileUri: string, httpPort: number, wsPort: number, token: string): Promise<HostPorts>
  /** Send a JSON message to every connected client (play/pause/seek/chat/reactions). */
  broadcast(message: string): Promise<void>
  /** Stop both servers + the foreground service. */
  stop(): Promise<void>
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
    start: unavailable,
    broadcast: async () => {},
    stop: async () => {},
    createTestFile: unavailable,
    addListener: () => ({ remove: () => {} }),
    removeAllListeners: () => {},
  } as unknown as RailReelHostModule
}

export default Platform.OS === 'android'
  ? requireNativeModule<RailReelHostModule>('RailReelHost')
  : androidOnly()
