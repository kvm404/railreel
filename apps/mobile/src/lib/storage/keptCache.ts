/**
 * "Keep & Leave" — a completed movie copy that survives the session for a quick rejoin.
 *
 * When a guest finishes (and verifies) a download it writes a tiny identity record next to the
 * movie: the host's `qf1:` fingerprint, the exact size, and the title. On the next approval the
 * guest reuses the kept copy instead of re-pulling gigabytes over the hotspot — but only once
 * the host's fingerprint is known AND a fresh fingerprint of the local file equals it (the
 * record is a cheap pre-filter, never the proof). The startup orphan sweep spares exactly this
 * pair while the movie still has the recorded size; anything else is an orphan.
 *
 * Pure decisions + one adapter-driven reader, unit-tested.
 */

import { getMovieCachePath, MOVIE_CACHE_FILENAME, normalizeDir, type FileSystemAdapter } from './cache'

export const MOVIE_META_FILENAME = 'railreel-movie.meta.json'

export function getMovieMetaPath(cacheDir: string): string {
  return `${normalizeDir(cacheDir)}${MOVIE_META_FILENAME}`
}

export interface KeptMovieMeta {
  v: 1
  /** Host fingerprint of the movie this copy matched ("qf1:<hex>"). */
  hash: string
  /** Exact byte size of the completed copy. */
  sizeBytes: number
  /** Display title (for a future "kept: <title>" hint; not used for identity). */
  title: string
  /** Wall-clock ms the copy completed. */
  savedAt: number
}

export function encodeKeptMovieMeta(meta: Omit<KeptMovieMeta, 'v'>): string {
  return JSON.stringify({ v: 1, ...meta })
}

/** Parse a stored record; anything malformed (or from a future version) is no record. */
export function parseKeptMovieMeta(raw: string | null | undefined): KeptMovieMeta | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return null
  let o: unknown
  try {
    o = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof o !== 'object' || o === null) return null
  const m = o as Record<string, unknown>
  if (
    m.v !== 1 ||
    typeof m.hash !== 'string' ||
    !m.hash.startsWith('qf1:') ||
    typeof m.sizeBytes !== 'number' ||
    !Number.isFinite(m.sizeBytes) ||
    m.sizeBytes <= 0 ||
    typeof m.title !== 'string'
  ) {
    return null
  }
  return {
    v: 1,
    hash: m.hash,
    sizeBytes: m.sizeBytes,
    title: m.title,
    savedAt: typeof m.savedAt === 'number' && Number.isFinite(m.savedAt) ? m.savedAt : 0,
  }
}

/** The kept movie is still the complete copy the record describes (exists, exact size). */
export function isKeptMovieIntact(
  meta: KeptMovieMeta | null,
  movie: { exists: boolean; size?: number } | null,
): meta is KeptMovieMeta {
  return !!meta && !!movie && movie.exists && movie.size === meta.sizeBytes
}

/**
 * Can the kept copy stand in for the host's movie?
 *  - 'mismatch': no intact copy, or it's provably a different movie — download normally.
 *  - 'need-hash': plausible (same size) but the host's fingerprint hasn't arrived yet.
 *  - 'verify': same size + same recorded fingerprint — fingerprint the local file to confirm.
 */
export function keptReuseDecision(
  meta: KeptMovieMeta | null,
  movie: { exists: boolean; size?: number } | null,
  host: { sizeBytes: number; hash: string } | null,
): 'mismatch' | 'need-hash' | 'verify' {
  if (!isKeptMovieIntact(meta, movie) || !host) return 'mismatch'
  if (!(host.sizeBytes > 0) || host.sizeBytes !== meta.sizeBytes) return 'mismatch'
  if (!host.hash.startsWith('qf1:')) return 'need-hash'
  return host.hash === meta.hash ? 'verify' : 'mismatch'
}

/**
 * Cache files the startup orphan sweep must spare: the kept movie + its record, while the movie
 * still matches the record. Pass the result as `sweepOrphanCache(dir, fs, activeFiles)`.
 */
export async function findKeptCacheFiles(
  cacheDir: string,
  fs: FileSystemAdapter,
  readText: (uri: string) => Promise<string>,
): Promise<string[]> {
  if (!cacheDir) return []
  try {
    const meta = parseKeptMovieMeta(await readText(getMovieMetaPath(cacheDir)))
    if (!meta) return []
    const movie = await fs.getInfoAsync(getMovieCachePath(cacheDir))
    return isKeptMovieIntact(meta, movie) ? [MOVIE_CACHE_FILENAME, MOVIE_META_FILENAME] : []
  } catch {
    return [] // unreadable record → nothing is kept; the sweep treats both as orphans
  }
}
