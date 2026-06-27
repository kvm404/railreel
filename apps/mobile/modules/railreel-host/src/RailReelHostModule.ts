import { NativeModule, requireNativeModule } from 'expo'

declare class RailReelHostModule extends NativeModule<Record<never, never>> {
  /** Start serving `fileUri` (file://) with HTTP byte-range. `port` 0 = OS-assigned. Returns the bound port. */
  start(fileUri: string, port: number, token: string): Promise<number>
  /** Stop the server. */
  stop(): Promise<void>
  /** DEV (M1): write an N-MB test file to cache and return its file:// uri. */
  createTestFile(sizeMb: number): Promise<string>
}

export default requireNativeModule<RailReelHostModule>('RailReelHost')
