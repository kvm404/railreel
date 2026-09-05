import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  formatBytes,
  getMovieCachePath,
  getSubtitleCachePath,
  normalizeDir,
  isRailreelCacheFile,
  getCacheStatus,
  clearSessionCache,
  executePureDeletionSequencing,
  sweepOrphanCache,
  configureCacheStorage,
  resetCacheStorageConfiguration,
  createExpoFileSystemAdapter,
  MOVIE_CACHE_FILENAME,
  SUBTITLE_CACHE_FILENAME,
  type FileSystemAdapter,
  type DeletionStep,
} from '@/lib/storage'

describe('Storage & Cache Lifecycle Management', () => {
  const TEST_DIR = 'file:///data/user/0/com.kvm404.railreel/cache/'

  beforeEach(() => {
    resetCacheStorageConfiguration()
  })

  describe('formatBytes', () => {
    it('formats 0 and non-positive numbers as 0 B', () => {
      expect(formatBytes(0)).toBe('0 B')
      expect(formatBytes(-100)).toBe('0 B')
      expect(formatBytes(NaN)).toBe('0 B')
      expect(formatBytes(Infinity)).toBe('0 B')
      expect(formatBytes(-Infinity)).toBe('0 B')
    })

    it('formats byte-range sizes below 1 KB', () => {
      expect(formatBytes(1)).toBe('1 B')
      expect(formatBytes(512)).toBe('512 B')
      expect(formatBytes(1023)).toBe('1023 B')
    })

    it('formats kilobyte-range sizes', () => {
      expect(formatBytes(1024)).toBe('1 KB')
      expect(formatBytes(1536)).toBe('1.5 KB')
      expect(formatBytes(1024 * 100)).toBe('100 KB')
    })

    it('formats megabyte-range sizes', () => {
      expect(formatBytes(1024 * 1024)).toBe('1 MB')
      expect(formatBytes(1024 * 1024 * 2.5)).toBe('2.5 MB')
      expect(formatBytes(1024 * 1024 * 500)).toBe('500 MB')
    })

    it('formats gigabyte-range sizes with high precision', () => {
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB')
      // Exact test case from user prompt: "Free up 1.84 GB"
      const gigabytes184 = Math.round(1.84 * 1024 * 1024 * 1024)
      expect(formatBytes(gigabytes184)).toBe('1.84 GB')
      expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2 GB')
      expect(formatBytes(3.75 * 1024 * 1024 * 1024)).toBe('3.75 GB')
    })
  })

  describe('Path Resolvers and Directory Normalization', () => {
    it('normalizes directories with or without trailing slashes', () => {
      expect(normalizeDir('')).toBe('')
      expect(normalizeDir('/data/cache')).toBe('/data/cache/')
      expect(normalizeDir('/data/cache/')).toBe('/data/cache/')
    })

    it('resolves movie and subtitle cache paths correctly', () => {
      expect(getMovieCachePath('/data/cache')).toBe(`/data/cache/${MOVIE_CACHE_FILENAME}`)
      expect(getMovieCachePath('/data/cache/')).toBe(`/data/cache/${MOVIE_CACHE_FILENAME}`)
      expect(getSubtitleCachePath('/data/cache')).toBe(`/data/cache/${SUBTITLE_CACHE_FILENAME}`)
      expect(getSubtitleCachePath('/data/cache/')).toBe(`/data/cache/${SUBTITLE_CACHE_FILENAME}`)
    })
  })

  describe('isRailreelCacheFile', () => {
    it('identifies railreel cache files by filename and path', () => {
      expect(isRailreelCacheFile('railreel-movie.bin')).toBe(true)
      expect(isRailreelCacheFile('railreel-subtitles.srt')).toBe(true)
      expect(isRailreelCacheFile('railreel-test.bin')).toBe(true)
      expect(isRailreelCacheFile('railreel-chunk-0001.tmp')).toBe(true)
      expect(isRailreelCacheFile('railreel-download-partial.bin')).toBe(true)
      expect(isRailreelCacheFile('/some/path/railreel-movie.bin')).toBe(true)
    })

    it('rejects unrelated files', () => {
      expect(isRailreelCacheFile('movie.mp4')).toBe(false)
      expect(isRailreelCacheFile('subtitles.srt')).toBe(false)
      expect(isRailreelCacheFile('rail-reel.bin')).toBe(false)
      expect(isRailreelCacheFile('other-file.bin')).toBe(false)
      expect(isRailreelCacheFile('')).toBe(false)
      // @ts-expect-error test non-string input
      expect(isRailreelCacheFile(null)).toBe(false)
      // @ts-expect-error test non-string input
      expect(isRailreelCacheFile(undefined)).toBe(false)
    })
  })

  describe('getCacheStatus', () => {
    it('returns empty status when no adapter is configured', async () => {
      const status = await getCacheStatus()
      expect(status).toEqual({
        hasMovieCache: false,
        hasSubtitleCache: false,
        movieBytes: 0,
        subtitleBytes: 0,
        totalBytes: 0,
      })
    })

    it('detects both movie and subtitle caches with byte sizes', async () => {
      const moviePath = getMovieCachePath(TEST_DIR)
      const subPath = getSubtitleCachePath(TEST_DIR)

      const mockFs: FileSystemAdapter = {
        getInfoAsync: vi.fn().mockImplementation(async (uri: string) => {
          if (uri === moviePath) return { exists: true, size: 1_840_000_000 }
          if (uri === subPath) return { exists: true, size: 52_400 }
          return { exists: false }
        }),
        deleteAsync: vi.fn().mockResolvedValue(undefined),
        readDirectoryAsync: vi.fn().mockResolvedValue([]),
      }

      const status = await getCacheStatus(TEST_DIR, mockFs)
      expect(status.hasMovieCache).toBe(true)
      expect(status.movieBytes).toBe(1_840_000_000)
      expect(status.hasSubtitleCache).toBe(true)
      expect(status.subtitleBytes).toBe(52_400)
      expect(status.totalBytes).toBe(1_840_052_400)
    })

    it('detects movie cache only when subtitles are absent', async () => {
      const moviePath = getMovieCachePath(TEST_DIR)

      const mockFs: FileSystemAdapter = {
        getInfoAsync: vi.fn().mockImplementation(async (uri: string) => {
          if (uri === moviePath) return { exists: true, size: 500_000_000 }
          return { exists: false }
        }),
        deleteAsync: vi.fn().mockResolvedValue(undefined),
        readDirectoryAsync: vi.fn().mockResolvedValue([]),
      }

      const status = await getCacheStatus(TEST_DIR, mockFs)
      expect(status.hasMovieCache).toBe(true)
      expect(status.movieBytes).toBe(500_000_000)
      expect(status.hasSubtitleCache).toBe(false)
      expect(status.subtitleBytes).toBe(0)
      expect(status.totalBytes).toBe(500_000_000)
    })

    it('detects subtitle cache only when movie is absent', async () => {
      const subPath = getSubtitleCachePath(TEST_DIR)

      const mockFs: FileSystemAdapter = {
        getInfoAsync: vi.fn().mockImplementation(async (uri: string) => {
          if (uri === subPath) return { exists: true, size: 25_000 }
          return { exists: false }
        }),
        deleteAsync: vi.fn().mockResolvedValue(undefined),
        readDirectoryAsync: vi.fn().mockResolvedValue([]),
      }

      const status = await getCacheStatus(TEST_DIR, mockFs)
      expect(status.hasMovieCache).toBe(false)
      expect(status.movieBytes).toBe(0)
      expect(status.hasSubtitleCache).toBe(true)
      expect(status.subtitleBytes).toBe(25_000)
      expect(status.totalBytes).toBe(25_000)
    })

    it('handles missing size property gracefully by defaulting to 0', async () => {
      const mockFs: FileSystemAdapter = {
        getInfoAsync: vi.fn().mockResolvedValue({ exists: true }),
        deleteAsync: vi.fn().mockResolvedValue(undefined),
        readDirectoryAsync: vi.fn().mockResolvedValue([]),
      }

      const status = await getCacheStatus(TEST_DIR, mockFs)
      expect(status.hasMovieCache).toBe(true)
      expect(status.movieBytes).toBe(0)
      expect(status.hasSubtitleCache).toBe(true)
      expect(status.subtitleBytes).toBe(0)
      expect(status.totalBytes).toBe(0)
    })

    it('handles getInfoAsync failures gracefully', async () => {
      const mockFs: FileSystemAdapter = {
        getInfoAsync: vi.fn().mockRejectedValue(new Error('Permission denied')),
        deleteAsync: vi.fn().mockResolvedValue(undefined),
        readDirectoryAsync: vi.fn().mockResolvedValue([]),
      }

      const status = await getCacheStatus(TEST_DIR, mockFs)
      expect(status.hasMovieCache).toBe(false)
      expect(status.hasSubtitleCache).toBe(false)
      expect(status.totalBytes).toBe(0)
    })
  })

  describe('executePureDeletionSequencing', () => {
    it('executes detachMedia -> cancelDownloads -> unlinkFiles in strict sequential order', async () => {
      const executionOrder: string[] = []
      const stepEvents: DeletionStep[] = []

      const detachMedia = vi.fn().mockImplementation(async () => {
        executionOrder.push('detach')
      })
      const cancelDownloads = vi.fn().mockImplementation(async () => {
        executionOrder.push('cancel')
      })
      const unlinkFiles = vi.fn().mockImplementation(async () => {
        executionOrder.push('unlink')
      })

      await executePureDeletionSequencing(
        {
          detachMedia,
          cancelDownloads,
          onStep: (step) => stepEvents.push(step),
        },
        unlinkFiles,
      )

      expect(executionOrder).toEqual(['detach', 'cancel', 'unlink'])
      expect(stepEvents).toEqual(['detach-media', 'cancel-downloads', 'unlink-files'])
      expect(detachMedia).toHaveBeenCalledTimes(1)
      expect(cancelDownloads).toHaveBeenCalledTimes(1)
      expect(unlinkFiles).toHaveBeenCalledTimes(1)
    })

    it('continues through sequence even if detachMedia throws an error', async () => {
      const detachMedia = vi.fn().mockRejectedValue(new Error('Detach failed'))
      const cancelDownloads = vi.fn().mockResolvedValue(undefined)
      const unlinkFiles = vi.fn().mockResolvedValue(undefined)

      await expect(
        executePureDeletionSequencing({ detachMedia, cancelDownloads }, unlinkFiles),
      ).resolves.toBeUndefined()

      expect(detachMedia).toHaveBeenCalledTimes(1)
      expect(cancelDownloads).toHaveBeenCalledTimes(1)
      expect(unlinkFiles).toHaveBeenCalledTimes(1)
    })

    it('continues through sequence even if cancelDownloads throws an error', async () => {
      const detachMedia = vi.fn().mockResolvedValue(undefined)
      const cancelDownloads = vi.fn().mockRejectedValue(new Error('Cancel failed'))
      const unlinkFiles = vi.fn().mockResolvedValue(undefined)

      await expect(
        executePureDeletionSequencing({ detachMedia, cancelDownloads }, unlinkFiles),
      ).resolves.toBeUndefined()

      expect(detachMedia).toHaveBeenCalledTimes(1)
      expect(cancelDownloads).toHaveBeenCalledTimes(1)
      expect(unlinkFiles).toHaveBeenCalledTimes(1)
    })

    it('swallows unlink errors idempotently without rejecting', async () => {
      const unlinkFiles = vi.fn().mockRejectedValue(new Error('File not found'))

      await expect(
        executePureDeletionSequencing(undefined, unlinkFiles),
      ).resolves.toBeUndefined()

      expect(unlinkFiles).toHaveBeenCalledTimes(1)
    })
  })

  describe('clearSessionCache (Selective & Idempotent Cleanup)', () => {
    it('deletes both movie and subtitle caches by default with idempotent flag', async () => {
      const moviePath = getMovieCachePath(TEST_DIR)
      const subPath = getSubtitleCachePath(TEST_DIR)

      const mockFs: FileSystemAdapter = {
        getInfoAsync: vi.fn().mockResolvedValue({ exists: true }),
        deleteAsync: vi.fn().mockResolvedValue(undefined),
        readDirectoryAsync: vi.fn().mockResolvedValue([]),
      }

      await clearSessionCache({ cacheDir: TEST_DIR, fs: mockFs })

      expect(mockFs.deleteAsync).toHaveBeenCalledTimes(2)
      expect(mockFs.deleteAsync).toHaveBeenCalledWith(moviePath, { idempotent: true })
      expect(mockFs.deleteAsync).toHaveBeenCalledWith(subPath, { idempotent: true })
    })

    it('selectively deletes only movie cache when subtitles: false', async () => {
      const moviePath = getMovieCachePath(TEST_DIR)
      const subPath = getSubtitleCachePath(TEST_DIR)

      const mockFs: FileSystemAdapter = {
        getInfoAsync: vi.fn().mockResolvedValue({ exists: true }),
        deleteAsync: vi.fn().mockResolvedValue(undefined),
        readDirectoryAsync: vi.fn().mockResolvedValue([]),
      }

      await clearSessionCache({
        cacheDir: TEST_DIR,
        fs: mockFs,
        movie: true,
        subtitles: false,
      })

      expect(mockFs.deleteAsync).toHaveBeenCalledTimes(1)
      expect(mockFs.deleteAsync).toHaveBeenCalledWith(moviePath, { idempotent: true })
      expect(mockFs.deleteAsync).not.toHaveBeenCalledWith(subPath, expect.anything())
    })

    it('selectively deletes only subtitle cache when movie: false', async () => {
      const moviePath = getMovieCachePath(TEST_DIR)
      const subPath = getSubtitleCachePath(TEST_DIR)

      const mockFs: FileSystemAdapter = {
        getInfoAsync: vi.fn().mockResolvedValue({ exists: true }),
        deleteAsync: vi.fn().mockResolvedValue(undefined),
        readDirectoryAsync: vi.fn().mockResolvedValue([]),
      }

      await clearSessionCache({
        cacheDir: TEST_DIR,
        fs: mockFs,
        movie: false,
        subtitles: true,
      })

      expect(mockFs.deleteAsync).toHaveBeenCalledTimes(1)
      expect(mockFs.deleteAsync).toHaveBeenCalledWith(subPath, { idempotent: true })
      expect(mockFs.deleteAsync).not.toHaveBeenCalledWith(moviePath, expect.anything())
    })

    it('handles idempotent deletion when files do not exist (deleteAsync rejects)', async () => {
      const mockFs: FileSystemAdapter = {
        getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
        deleteAsync: vi.fn().mockRejectedValue(new Error('ENOENT: no such file or directory')),
        readDirectoryAsync: vi.fn().mockResolvedValue([]),
      }

      await expect(
        clearSessionCache({ cacheDir: TEST_DIR, fs: mockFs }),
      ).resolves.toBeUndefined()
    })

    it('coordinates lifecycle hooks during deletion sequencing', async () => {
      const detachMedia = vi.fn().mockResolvedValue(undefined)
      const cancelDownloads = vi.fn().mockResolvedValue(undefined)
      const mockFs: FileSystemAdapter = {
        getInfoAsync: vi.fn().mockResolvedValue({ exists: true }),
        deleteAsync: vi.fn().mockResolvedValue(undefined),
        readDirectoryAsync: vi.fn().mockResolvedValue([]),
      }

      await clearSessionCache({
        cacheDir: TEST_DIR,
        fs: mockFs,
        hooks: { detachMedia, cancelDownloads },
      })

      expect(detachMedia).toHaveBeenCalledTimes(1)
      expect(cancelDownloads).toHaveBeenCalledTimes(1)
      expect(mockFs.deleteAsync).toHaveBeenCalledTimes(2)
    })
  })

  describe('sweepOrphanCache', () => {
    it('sweeps all orphan railreel cache files and sums reclaimed bytes', async () => {
      const files = [
        'railreel-movie.bin',
        'railreel-subtitles.srt',
        'railreel-test.bin',
        'railreel-chunk-01.tmp',
        'railreel-chunk-02.tmp',
        'user-avatar.jpg',
        'unrelated-cache.dat',
      ]

      const fileSizes: Record<string, number> = {
        [`${TEST_DIR}railreel-movie.bin`]: 1_500_000_000,
        [`${TEST_DIR}railreel-subtitles.srt`]: 40_000,
        [`${TEST_DIR}railreel-test.bin`]: 10_000_000,
        [`${TEST_DIR}railreel-chunk-01.tmp`]: 2_000_000,
        [`${TEST_DIR}railreel-chunk-02.tmp`]: 3_000_000,
        [`${TEST_DIR}user-avatar.jpg`]: 50_000,
        [`${TEST_DIR}unrelated-cache.dat`]: 100_000,
      }

      const mockFs: FileSystemAdapter = {
        getInfoAsync: vi.fn().mockImplementation(async (uri: string) => ({
          exists: true,
          size: fileSizes[uri] ?? 0,
        })),
        deleteAsync: vi.fn().mockResolvedValue(undefined),
        readDirectoryAsync: vi.fn().mockResolvedValue(files),
      }

      const result = await sweepOrphanCache(TEST_DIR, mockFs)

      expect(result.sweptFiles).toEqual([
        'railreel-movie.bin',
        'railreel-subtitles.srt',
        'railreel-test.bin',
        'railreel-chunk-01.tmp',
        'railreel-chunk-02.tmp',
      ])
      expect(result.reclaimedBytes).toBe(
        1_500_000_000 + 40_000 + 10_000_000 + 2_000_000 + 3_000_000,
      )

      // Only railreel files should have been unlinked
      expect(mockFs.deleteAsync).toHaveBeenCalledTimes(5)
      expect(mockFs.deleteAsync).not.toHaveBeenCalledWith(
        `${TEST_DIR}user-avatar.jpg`,
        expect.anything(),
      )
      expect(mockFs.deleteAsync).not.toHaveBeenCalledWith(
        `${TEST_DIR}unrelated-cache.dat`,
        expect.anything(),
      )
    })

    it('protects active files specified in activeFiles list', async () => {
      const files = ['railreel-movie.bin', 'railreel-subtitles.srt', 'railreel-chunk-01.tmp']

      const mockFs: FileSystemAdapter = {
        getInfoAsync: vi.fn().mockResolvedValue({ exists: true, size: 1_000_000 }),
        deleteAsync: vi.fn().mockResolvedValue(undefined),
        readDirectoryAsync: vi.fn().mockResolvedValue(files),
      }

      const result = await sweepOrphanCache(TEST_DIR, mockFs, ['railreel-movie.bin'])

      expect(result.sweptFiles).toEqual(['railreel-subtitles.srt', 'railreel-chunk-01.tmp'])
      expect(mockFs.deleteAsync).not.toHaveBeenCalledWith(
        `${TEST_DIR}railreel-movie.bin`,
        expect.anything(),
      )
      expect(mockFs.deleteAsync).toHaveBeenCalledWith(
        `${TEST_DIR}railreel-subtitles.srt`,
        { idempotent: true },
      )
      expect(mockFs.deleteAsync).toHaveBeenCalledWith(
        `${TEST_DIR}railreel-chunk-01.tmp`,
        { idempotent: true },
      )
    })

    it('handles empty directories cleanly', async () => {
      const mockFs: FileSystemAdapter = {
        getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
        deleteAsync: vi.fn().mockResolvedValue(undefined),
        readDirectoryAsync: vi.fn().mockResolvedValue([]),
      }

      const result = await sweepOrphanCache(TEST_DIR, mockFs)
      expect(result.sweptFiles).toEqual([])
      expect(result.reclaimedBytes).toBe(0)
    })

    it('handles readDirectoryAsync errors gracefully', async () => {
      const mockFs: FileSystemAdapter = {
        getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
        deleteAsync: vi.fn().mockResolvedValue(undefined),
        readDirectoryAsync: vi.fn().mockRejectedValue(new Error('Permission denied')),
      }

      const result = await sweepOrphanCache(TEST_DIR, mockFs)
      expect(result.sweptFiles).toEqual([])
      expect(result.reclaimedBytes).toBe(0)
    })
  })

  describe('Global Configuration and Expo Adapter Factory', () => {
    it('uses configured cache directory and adapter when arguments omitted', async () => {
      const mockFs: FileSystemAdapter = {
        getInfoAsync: vi.fn().mockResolvedValue({ exists: true, size: 1024 }),
        deleteAsync: vi.fn().mockResolvedValue(undefined),
        readDirectoryAsync: vi.fn().mockResolvedValue(['railreel-movie.bin']),
      }

      configureCacheStorage(TEST_DIR, mockFs)

      const status = await getCacheStatus()
      expect(status.hasMovieCache).toBe(true)
      expect(status.movieBytes).toBe(1024)

      await clearSessionCache()
      expect(mockFs.deleteAsync).toHaveBeenCalledWith(
        getMovieCachePath(TEST_DIR),
        { idempotent: true },
      )

      const sweep = await sweepOrphanCache()
      expect(sweep.sweptFiles).toEqual(['railreel-movie.bin'])
    })

    it('createExpoFileSystemAdapter bridges legacy methods correctly', async () => {
      const legacy = {
        getInfoAsync: vi.fn().mockResolvedValue({ exists: true, size: 42 }),
        deleteAsync: vi.fn().mockResolvedValue(undefined),
        readDirectoryAsync: vi.fn().mockResolvedValue(['file1']),
      }

      const adapter = createExpoFileSystemAdapter(legacy)

      await expect(adapter.getInfoAsync('test://path')).resolves.toEqual({ exists: true, size: 42 })
      await expect(adapter.deleteAsync('test://path', { idempotent: true })).resolves.toBeUndefined()
      await expect(adapter.readDirectoryAsync('test://path')).resolves.toEqual(['file1'])

      expect(legacy.getInfoAsync).toHaveBeenCalledWith('test://path')
      expect(legacy.deleteAsync).toHaveBeenCalledWith('test://path', { idempotent: true })
      expect(legacy.readDirectoryAsync).toHaveBeenCalledWith('test://path')
    })
  })
})
