import { NativeModule, requireNativeModule } from 'expo'
import { Platform } from 'react-native'

declare class RailReelHostModule extends NativeModule<Record<never, never>> {
  /** Start serving `fileUri` (file://) with HTTP byte-range. `port` 0 = OS-assigned. Returns the bound port. */
  start(fileUri: string, port: number, token: string): Promise<number>
  /** Stop the server. */
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
    stop: async () => {},
    createTestFile: unavailable,
  } as unknown as RailReelHostModule
}

export default Platform.OS === 'android'
  ? requireNativeModule<RailReelHostModule>('RailReelHost')
  : androidOnly()
