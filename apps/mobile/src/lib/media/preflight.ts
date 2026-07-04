/**
 * Preflight verdicts (pure): storage, decode capability, host battery. Each turns raw device
 * readings into either null (fine) or the exact sentence the UI shows — so the copy is tested
 * and the screens stay dumb. PRD §8: surface constraints honestly, before they ruin the show.
 */

/** Extra room demanded beyond the movie itself — the OS, other apps, and the download need air. */
export const STORAGE_MARGIN_BYTES = 200 * 1024 * 1024

export function storageWarning(freeBytes: number, movieBytes: number): string | null {
  if (!(freeBytes >= 0) || !(movieBytes > 0)) return null // unknowns never block
  if (freeBytes >= movieBytes + STORAGE_MARGIN_BYTES) return null
  const needGb = ((movieBytes + STORAGE_MARGIN_BYTES) / 1e9).toFixed(1)
  const freeGb = (freeBytes / 1e9).toFixed(1)
  return `Not enough space — the movie needs ~${needGb} GB free, this phone has ${freeGb} GB.`
}

export function decodeWarning(canDecode: boolean, height: number): string | null {
  if (canDecode || !(height > 0)) return null
  return `This phone's decoder can't smoothly play ${height}p — expect heavy lag.`
}

/** Below this (discharging), hosting a whole movie is a gamble. */
export const HOST_BATTERY_FLOOR = 0.3

export function batteryWarning(level: number, charging: boolean): string | null {
  if (charging || level < 0 || level >= HOST_BATTERY_FLOOR) return null
  return `Host battery at ${Math.round(level * 100)}% — plug in, the session ends if this phone dies.`
}
