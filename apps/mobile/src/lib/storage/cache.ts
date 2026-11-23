/**
 * RailReel Storage & Cache Lifecycle Engine
 *
 * Governs multi-gigabyte video cache (MOVIE_CACHE), sidecar subtitle cache (SUBTITLE_CACHE),
 * and temporary chunk files.
 *
 * Implements:
 * 1. Cache path definitions & resolvers
 * 2. File size & metrics formatting (formatBytes)
 * 3. Cache status inspection (getCacheStatus)
 * 4. Pure deletion sequencing (detach -> cancel -> unlink)
 * 5. Idempotent selective cleanup (clearSessionCache)
 * 6. Orphan detection & directory sweep (sweepOrphanCache)
 */

export const MOVIE_CACHE_FILENAME = 'railreel-movie.bin'
export const SUBTITLE_CACHE_FILENAME = 'railreel-subtitles.srt'
export const CHUNK_CACHE_PREFIX = 'railreel-chunk-'

export interface CacheStatus {
  hasMovieCache: boolean
  hasSubtitleCache: boolean
  movieBytes: number
  subtitleBytes: number
  totalBytes: number
}

export interface FileSystemAdapter {
  getInfoAsync: (fileUri: string) => Promise<{ exists: boolean; size?: number }>
  deleteAsync: (fileUri: string, options?: { idempotent?: boolean }) => Promise<void>
  readDirectoryAsync: (dirUri: string) => Promise<string[]>
}

export type DeletionStep = 'detach-media' | 'cancel-downloads' | 'unlink-files'

export interface DeletionLifecycleHooks {
  detachMedia?: () => Promise<void> | void
  cancelDownloads?: () => Promise<void> | void
  onStep?: (step: DeletionStep) => void
}

export interface ClearCacheOptions {
  movie?: boolean
  subtitles?: boolean
  cacheDir?: string
  fs?: FileSystemAdapter
  hooks?: DeletionLifecycleHooks
}

export interface ClearCacheResult {
  /** Targeted files that no longer exist after the attempt. */
  cleared: string[]
  /** Targeted files that could not be removed (a locked/in-use file, a permissions error…). */
  failed: { path: string; error: string }[]
  /** Bytes still on disk for the targeted files — what the person did NOT get back. */
  remainingBytes: number
  /** Everything targeted is gone. */
  ok: boolean
}

export interface OrphanSweepResult {
  sweptFiles: string[]
  reclaimedBytes: number
}

let defaultCacheDir: string = ''
let defaultFsAdapter: FileSystemAdapter | null = null

export function configureCacheStorage(dir: string, adapter: FileSystemAdapter): void {
  defaultCacheDir = dir
  defaultFsAdapter = adapter
}

export function resetCacheStorageConfiguration(): void {
  defaultCacheDir = ''
  defaultFsAdapter = null
}

export function getDefaultCacheDir(): string {
  return defaultCacheDir
}

export function getDefaultFsAdapter(): FileSystemAdapter | null {
  return defaultFsAdapter
}

export function normalizeDir(dir: string): string {
  if (!dir) return ''
  return dir.endsWith('/') ? dir : `${dir}/`
}

export function getMovieCachePath(cacheDir: string): string {
  return `${normalizeDir(cacheDir)}${MOVIE_CACHE_FILENAME}`
}

export function getSubtitleCachePath(cacheDir: string): string {
  return `${normalizeDir(cacheDir)}${SUBTITLE_CACHE_FILENAME}`
}

/**
 * Human-readable byte formatting for storage metrics and UI dialogues.
 * e.g., 0 -> "0 B", 1024 -> "1 KB", 1975684956 -> "1.84 GB".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const k = 1024
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1)
  if (i === 0) return `${Math.round(bytes)} B`
  const val = bytes / Math.pow(k, i)
  const decimals = i >= 3 ? 2 : 1
  const str = val.toFixed(decimals)
  const formatted = str.indexOf('.') !== -1 ? str.replace(/0+$/, '').replace(/\.$/, '') : str
  return `${formatted} ${units[i]}`
}

/**
 * Pure deletion sequencing:
 * 1. Detach media references (prevent locked file descriptors)
 * 2. Cancel any running download jobs (halt active disk writes)
 * 3. Unlink files with idempotent error-handling
 */
export async function executePureDeletionSequencing<T = void>(
  hooks: DeletionLifecycleHooks | undefined,
  unlinkFn: () => Promise<T> | T,
): Promise<T | undefined> {
  hooks?.onStep?.('detach-media')
  if (hooks?.detachMedia) {
    try {
      await hooks.detachMedia()
    } catch {
      // Best-effort: ignore media detach failures
    }
  }

  hooks?.onStep?.('cancel-downloads')
  if (hooks?.cancelDownloads) {
    try {
      await hooks.cancelDownloads()
    } catch {
      // Best-effort: ignore download cancellation failures
    }
  }

  hooks?.onStep?.('unlink-files')
  try {
    return await unlinkFn()
  } catch {
    // The caller's unlink step reports its own per-file failures; a throw here is unexpected,
    // and surfacing it as `undefined` lets the caller treat the deletion as unverified.
    return undefined
  }
}

/**
 * Inspects cache directory for movie and subtitle cache files and computes storage metrics.
 */
export async function getCacheStatus(
  cacheDir?: string,
  fs?: FileSystemAdapter,
): Promise<CacheStatus> {
  const dir = cacheDir ?? defaultCacheDir
  const adapter = fs ?? defaultFsAdapter

  if (!adapter) {
    return {
      hasMovieCache: false,
      hasSubtitleCache: false,
      movieBytes: 0,
      subtitleBytes: 0,
      totalBytes: 0,
    }
  }

  const moviePath = getMovieCachePath(dir)
  const subtitlePath = getSubtitleCachePath(dir)

  let hasMovieCache = false
  let movieBytes = 0
  let hasSubtitleCache = false
  let subtitleBytes = 0

  try {
    const movieInfo = await adapter.getInfoAsync(moviePath)
    if (movieInfo.exists) {
      hasMovieCache = true
      movieBytes =
        typeof movieInfo.size === 'number' && Number.isFinite(movieInfo.size)
          ? movieInfo.size
          : 0
    }
  } catch {
    // Best-effort
  }

  try {
    const subInfo = await adapter.getInfoAsync(subtitlePath)
    if (subInfo.exists) {
      hasSubtitleCache = true
      subtitleBytes =
        typeof subInfo.size === 'number' && Number.isFinite(subInfo.size)
          ? subInfo.size
          : 0
    }
  } catch {
    // Best-effort
  }

  return {
    hasMovieCache,
    hasSubtitleCache,
    movieBytes,
    subtitleBytes,
    totalBytes: movieBytes + subtitleBytes,
  }
}

/**
 * Clears session cache files with optional selective filtering (movie vs subtitles)
 * and pure deletion lifecycle sequencing.
 *
 * Never throws, but REPORTS what happened: each target is re-inspected after the delete, so a
 * file that is still on disk (locked by the player, permission error) shows up in `failed` and
 * `remainingBytes` instead of being silently left behind. "Already gone" is success (idempotent).
 */
export async function clearSessionCache(options?: ClearCacheOptions): Promise<ClearCacheResult> {
  const dir = options?.cacheDir ?? defaultCacheDir
  const adapter = options?.fs ?? defaultFsAdapter
  const empty: ClearCacheResult = { cleared: [], failed: [], remainingBytes: 0, ok: true }
  if (!adapter) return empty

  const deleteMovie = options?.movie !== false
  const deleteSubtitles = options?.subtitles !== false
  const targets: string[] = []
  if (deleteMovie) targets.push(getMovieCachePath(dir))
  if (deleteSubtitles) targets.push(getSubtitleCachePath(dir))

  const unlinkAction = async (): Promise<ClearCacheResult> => {
    const result: ClearCacheResult = { cleared: [], failed: [], remainingBytes: 0, ok: true }
    for (const path of targets) {
      let deleteError: string | null = null
      try {
        await adapter.deleteAsync(path, { idempotent: true })
      } catch (e) {
        deleteError = e instanceof Error ? e.message : String(e)
      }
      let stillThere = false
      let size = 0
      try {
        const info = await adapter.getInfoAsync(path)
        stillThere = info.exists
        size = info.exists && typeof info.size === 'number' && Number.isFinite(info.size) ? info.size : 0
      } catch {
        // Can't verify: trust the delete call's own outcome.
        stillThere = deleteError !== null
      }
      if (stillThere) {
        result.failed.push({ path, error: deleteError ?? 'file is still present after delete' })
        result.remainingBytes += size
      } else {
        result.cleared.push(path)
      }
    }
    result.ok = result.failed.length === 0
    return result
  }

  const outcome = options?.hooks
    ? await executePureDeletionSequencing(options.hooks, unlinkAction)
    : await unlinkAction()
  // The sequencing wrapper returns undefined only if the unlink step itself blew up — unverified.
  return outcome ?? { cleared: [], failed: targets.map((path) => ({ path, error: 'deletion did not complete' })), remainingBytes: 0, ok: false }
}

/**
 * A person-facing explanation for a cleanup that did not free everything, or null when it did.
 * `remainingBytes` is what is still on disk after the attempt (verify with getCacheStatus).
 */
export function describeCleanupFailure(remainingBytes: number, failed = remainingBytes > 0): string | null {
  if (!failed && !(remainingBytes > 0)) return null
  return remainingBytes > 0
    ? `Couldn't free ${formatBytes(remainingBytes)} — the file may still be in use. Try again, or keep it and leave.`
    : "Couldn't delete the downloaded files. Try again, or keep them and leave."
}

/**
 * The message for a purge outcome: null when everything targeted is gone. `null` input means the
 * purge call itself threw — treat that as an unverified (failed) deletion.
 */
export function cleanupFailureMessage(result: ClearCacheResult | null): string | null {
  if (result === null) return describeCleanupFailure(0, true)
  return result.ok ? null : describeCleanupFailure(result.remainingBytes, true)
}

/**
 * Checks whether a filename matches RailReel session cache patterns (movie, subtitles, chunks, temp files).
 */
export function isRailreelCacheFile(filename: string): boolean {
  if (!filename || typeof filename !== 'string') return false
  const name = filename.split('/').pop() || filename
  return name.startsWith('railreel-')
}

/**
 * Sweeps cache directory for abandoned or stale RailReel files (e.g. from crashed or aborted sessions),
 * unlinking them and returning total reclaimed bytes.
 */
export async function sweepOrphanCache(
  cacheDir?: string,
  fs?: FileSystemAdapter,
  activeFiles: string[] = [],
): Promise<OrphanSweepResult> {
  const dir = cacheDir ?? defaultCacheDir
  const adapter = fs ?? defaultFsAdapter

  if (!adapter || !dir) {
    return { sweptFiles: [], reclaimedBytes: 0 }
  }

  const normalizedDir = normalizeDir(dir)
  const activeSet = new Set(
    activeFiles.map((f) => {
      const name = f.split('/').pop() || f
      return name
    }),
  )

  let entries: string[] = []
  try {
    entries = await adapter.readDirectoryAsync(normalizedDir)
  } catch {
    return { sweptFiles: [], reclaimedBytes: 0 }
  }

  const sweptFiles: string[] = []
  let reclaimedBytes = 0

  for (const entry of entries) {
    const filename = entry.split('/').pop() || entry
    if (isRailreelCacheFile(filename) && !activeSet.has(filename)) {
      const filePath = `${normalizedDir}${filename}`
      try {
        const info = await adapter.getInfoAsync(filePath)
        const size =
          info.exists && typeof info.size === 'number' && Number.isFinite(info.size)
            ? info.size
            : 0
        await adapter.deleteAsync(filePath, { idempotent: true })
        sweptFiles.push(filename)
        reclaimedBytes += size
      } catch {
        // Idempotent: continue
      }
    }
  }

  return { sweptFiles, reclaimedBytes }
}

/**
 * Creates a FileSystemAdapter bridging expo-file-system/legacy to the pure storage interface.
 */
export function createExpoFileSystemAdapter(legacyFs: {
  getInfoAsync: (uri: string) => Promise<{ exists: boolean; size?: number }>
  deleteAsync: (uri: string, options?: { idempotent?: boolean }) => Promise<void>
  readDirectoryAsync: (uri: string) => Promise<string[]>
}): FileSystemAdapter {
  return {
    getInfoAsync: (uri) => legacyFs.getInfoAsync(uri),
    deleteAsync: (uri, opts) => legacyFs.deleteAsync(uri, opts),
    readDirectoryAsync: (uri) => legacyFs.readDirectoryAsync(uri),
  }
}
