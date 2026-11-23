/**
 * What the Join screen should say about nearby-cabin discovery. Without this, a failed mDNS start
 * and "nobody is hosting" both looked like endless scanning. Pure + unit-tested.
 */

/** After this long with no cabin found, say so (and what to check) instead of scanning forever. */
export const DISCOVERY_EMPTY_AFTER_MS = 8000

export type DiscoveryState =
  /** Looking, nothing yet (within the grace period). */
  | 'scanning'
  /** The grace period passed and no cabin has appeared. */
  | 'empty'
  /** startDiscovery itself failed — retry, or use the QR / pasted link. */
  | 'failed'
  /** At least one cabin is listed. */
  | 'found'

export function discoveryState(input: { cabinCount: number; startFailed: boolean; elapsedMs: number }): DiscoveryState {
  if (input.cabinCount > 0) return 'found'
  if (input.startFailed) return 'failed'
  return input.elapsedMs >= DISCOVERY_EMPTY_AFTER_MS ? 'empty' : 'scanning'
}
