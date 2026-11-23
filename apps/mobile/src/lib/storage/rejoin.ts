/**
 * Is there a finished movie copy on this phone that a rejoin of THIS movie could reuse? The
 * cleanup sheet only promises a "quick rejoin" when this is true — a half-downloaded file, or a
 * kept copy of some other movie, is not a quick anything. Decided by the same rule the real reuse
 * path applies (`keptReuseDecision`): the kept record must match the current movie's exact size
 * AND its host fingerprint. While the current movie's fingerprint is unknown the answer is no —
 * never promise on a guess.
 */

import { keptReuseDecision, parseKeptMovieMeta, getMovieMetaPath } from './keptCache'
import { getDefaultCacheDir, getDefaultFsAdapter, getMovieCachePath, type FileSystemAdapter } from './cache'

export type MovieIdentity = { sizeBytes: number; hash: string }

/**
 * The current movie's identity if the session store exposes the host's fingerprint (`hash`),
 * else null. Read with a type guard so this compiles whether or not the store carries the field.
 */
export function movieIdentity(movie: object | null | undefined): MovieIdentity | null {
  if (!movie || !('sizeBytes' in movie) || !('hash' in movie)) return null
  const { sizeBytes, hash } = movie
  if (typeof sizeBytes !== 'number' || !(sizeBytes > 0) || typeof hash !== 'string' || hash.length === 0) return null
  return { sizeBytes, hash }
}

export async function hasReusableMovieCopy(
  current: MovieIdentity | null,
  readText: (uri: string) => Promise<string>,
  cacheDir: string = getDefaultCacheDir(),
  fs: FileSystemAdapter | null = getDefaultFsAdapter(),
): Promise<boolean> {
  if (!current || !fs || !cacheDir) return false
  try {
    const meta = parseKeptMovieMeta(await readText(getMovieMetaPath(cacheDir)))
    if (!meta) return false
    const movie = await fs.getInfoAsync(getMovieCachePath(cacheDir))
    return keptReuseDecision(meta, movie, current) === 'verify'
  } catch {
    return false // unreadable record → nothing to promise
  }
}
