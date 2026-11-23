import { describe, it, expect } from 'vitest'
import {
  encodeKeptMovieMeta,
  findKeptCacheFiles,
  getMovieCachePath,
  getMovieMetaPath,
  isKeptMovieIntact,
  keptReuseDecision,
  MOVIE_CACHE_FILENAME,
  MOVIE_META_FILENAME,
  parseKeptMovieMeta,
  SUBTITLE_CACHE_FILENAME,
  sweepOrphanCache,
  type FileSystemAdapter,
} from '@/lib/storage'

const DIR = 'file:///data/user/0/com.kvm404.railreel/cache/'
const HASH = 'qf1:' + 'ab'.repeat(32)
const SIZE = 2_147_483_648
const meta = { hash: HASH, sizeBytes: SIZE, title: 'Night Train', savedAt: 1 }

/** In-memory cache dir: name → { size, text? }. */
function memFs(files: Record<string, { size: number; text?: string }>) {
  const store = new Map(Object.entries(files))
  const name = (uri: string) => uri.split('/').pop() ?? uri
  const fs: FileSystemAdapter = {
    getInfoAsync: async (uri) => {
      const f = store.get(name(uri))
      return f ? { exists: true, size: f.size } : { exists: false }
    },
    deleteAsync: async (uri) => {
      store.delete(name(uri))
    },
    readDirectoryAsync: async () => [...store.keys()],
  }
  const readText = async (uri: string) => {
    const f = store.get(name(uri))
    if (!f || f.text === undefined) throw new Error('ENOENT')
    return f.text
  }
  return { fs, readText, store }
}

describe('kept movie record', () => {
  it('round-trips and lives next to the movie', () => {
    expect(parseKeptMovieMeta(encodeKeptMovieMeta(meta))).toEqual({ v: 1, ...meta })
    expect(getMovieMetaPath(DIR)).toBe(`${DIR}${MOVIE_META_FILENAME}`)
    expect(MOVIE_META_FILENAME.startsWith('railreel-')).toBe(true) // still swept when orphaned
  })

  it('rejects malformed or foreign records', () => {
    expect(parseKeptMovieMeta(null)).toBeNull()
    expect(parseKeptMovieMeta('')).toBeNull()
    expect(parseKeptMovieMeta('{nope')).toBeNull()
    expect(parseKeptMovieMeta(JSON.stringify({ ...meta, v: 2 }))).toBeNull()
    expect(parseKeptMovieMeta(JSON.stringify({ ...meta, v: 1, hash: 'sha:x' }))).toBeNull()
    expect(parseKeptMovieMeta(JSON.stringify({ ...meta, v: 1, sizeBytes: 0 }))).toBeNull()
    expect(parseKeptMovieMeta('x'.repeat(5000))).toBeNull()
  })

  it('is intact only while the movie has exactly the recorded size', () => {
    const m = parseKeptMovieMeta(encodeKeptMovieMeta(meta))
    expect(isKeptMovieIntact(m, { exists: true, size: SIZE })).toBe(true)
    expect(isKeptMovieIntact(m, { exists: true, size: SIZE - 1 })).toBe(false) // partial / truncated
    expect(isKeptMovieIntact(m, { exists: false })).toBe(false)
    expect(isKeptMovieIntact(null, { exists: true, size: SIZE })).toBe(false)
  })
})

describe('keptReuseDecision', () => {
  const m = parseKeptMovieMeta(encodeKeptMovieMeta(meta))
  const file = { exists: true, size: SIZE }

  it('verifies a same-size, same-fingerprint copy', () => {
    expect(keptReuseDecision(m, file, { sizeBytes: SIZE, hash: HASH })).toBe('verify')
  })

  it('waits for the host fingerprint when the size matches but no hash has arrived', () => {
    expect(keptReuseDecision(m, file, { sizeBytes: SIZE, hash: '' })).toBe('need-hash')
  })

  it('downloads normally for a different movie or a broken copy', () => {
    expect(keptReuseDecision(m, file, { sizeBytes: SIZE + 1, hash: HASH })).toBe('mismatch')
    expect(keptReuseDecision(m, file, { sizeBytes: SIZE, hash: 'qf1:' + 'cd'.repeat(32) })).toBe('mismatch')
    expect(keptReuseDecision(m, { exists: true, size: 10 }, { sizeBytes: SIZE, hash: HASH })).toBe('mismatch')
    expect(keptReuseDecision(null, file, { sizeBytes: SIZE, hash: HASH })).toBe('mismatch')
    expect(keptReuseDecision(m, file, null)).toBe('mismatch')
    expect(keptReuseDecision(m, file, { sizeBytes: 0, hash: HASH })).toBe('mismatch')
  })
})

describe('findKeptCacheFiles + sweepOrphanCache', () => {
  it('spares a kept movie and its record; sweeps everything else', async () => {
    const { fs, readText, store } = memFs({
      [MOVIE_CACHE_FILENAME]: { size: SIZE },
      [MOVIE_META_FILENAME]: { size: 120, text: encodeKeptMovieMeta(meta) },
      [SUBTITLE_CACHE_FILENAME]: { size: 900 },
      'railreel-chunk-1': { size: 50 },
      'other-app.bin': { size: 7 },
    })
    const keep = await findKeptCacheFiles(DIR, fs, readText)
    expect(keep).toEqual([MOVIE_CACHE_FILENAME, MOVIE_META_FILENAME])
    const r = await sweepOrphanCache(DIR, fs, keep)
    expect(r.sweptFiles.sort()).toEqual([SUBTITLE_CACHE_FILENAME, 'railreel-chunk-1'].sort())
    expect(store.has(MOVIE_CACHE_FILENAME)).toBe(true)
    expect(store.has(MOVIE_META_FILENAME)).toBe(true)
    expect(store.has('other-app.bin')).toBe(true)
  })

  it('a partial movie (size ≠ record) is an orphan, record included', async () => {
    const { fs, readText, store } = memFs({
      [MOVIE_CACHE_FILENAME]: { size: SIZE / 2 },
      [MOVIE_META_FILENAME]: { size: 120, text: encodeKeptMovieMeta(meta) },
    })
    const keep = await findKeptCacheFiles(DIR, fs, readText)
    expect(keep).toEqual([])
    await sweepOrphanCache(DIR, fs, keep)
    expect(store.size).toBe(0)
  })

  it('no record (crash mid-download) keeps nothing', async () => {
    const { fs, readText } = memFs({ [MOVIE_CACHE_FILENAME]: { size: SIZE } })
    expect(await findKeptCacheFiles(DIR, fs, readText)).toEqual([])
    expect(await findKeptCacheFiles('', fs, readText)).toEqual([])
  })

  it('resolves the movie path it checks', () => {
    expect(getMovieCachePath(DIR)).toBe(`${DIR}${MOVIE_CACHE_FILENAME}`)
  })
})
