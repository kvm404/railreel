import { describe, it, expect } from 'vitest'
import { encodeKeptMovieMeta, getMovieMetaPath, hasReusableMovieCopy, movieIdentity, type FileSystemAdapter } from '@/lib/storage'

const DIR = 'file:///cache/'
const SIZE = 1_000_000
const HASH = 'qf1:' + 'cd'.repeat(32)
const record = encodeKeptMovieMeta({ hash: HASH, sizeBytes: SIZE, title: 'Night Train', savedAt: 1 })
const current = { sizeBytes: SIZE, hash: HASH }

function fsWith(movie: { exists: boolean; size?: number }): FileSystemAdapter {
  return {
    getInfoAsync: async () => movie,
    deleteAsync: async () => {},
    readDirectoryAsync: async () => [],
  }
}

describe('hasReusableMovieCopy', () => {
  const read = async (uri: string) => {
    if (uri === getMovieMetaPath(DIR)) return record
    throw new Error('ENOENT')
  }
  const complete = fsWith({ exists: true, size: SIZE })

  it('is true for a complete copy that matches the current movie by size and fingerprint', async () => {
    expect(await hasReusableMovieCopy(current, read, DIR, complete)).toBe(true)
  })

  it('is false while the current movie identity is unknown', async () => {
    expect(await hasReusableMovieCopy(null, read, DIR, complete)).toBe(false)
  })

  it('is false for a kept copy of a different movie', async () => {
    expect(await hasReusableMovieCopy({ sizeBytes: SIZE, hash: 'qf1:' + 'ee'.repeat(32) }, read, DIR, complete)).toBe(false)
    expect(await hasReusableMovieCopy({ sizeBytes: SIZE + 1, hash: HASH }, read, DIR, complete)).toBe(false)
  })

  it('is false when the fingerprint is not a qf1 fingerprint yet', async () => {
    expect(await hasReusableMovieCopy({ sizeBytes: SIZE, hash: '' }, read, DIR, complete)).toBe(false)
    expect(await hasReusableMovieCopy({ sizeBytes: SIZE, hash: 'sha256:abc' }, read, DIR, complete)).toBe(false)
  })

  it('is false for a partial download (size differs from the record)', async () => {
    expect(await hasReusableMovieCopy(current, read, DIR, fsWith({ exists: true, size: SIZE - 10 }))).toBe(false)
  })

  it('is false when the movie is gone, the record is missing, or nothing is configured', async () => {
    expect(await hasReusableMovieCopy(current, read, DIR, fsWith({ exists: false }))).toBe(false)
    expect(await hasReusableMovieCopy(current, async () => { throw new Error('ENOENT') }, DIR, complete)).toBe(false)
    expect(await hasReusableMovieCopy(current, read, '', complete)).toBe(false)
    expect(await hasReusableMovieCopy(current, read, DIR, null)).toBe(false)
  })
})

describe('movieIdentity', () => {
  it('needs both a size and the host fingerprint', () => {
    expect(movieIdentity({ title: 'x', sizeBytes: SIZE, hash: HASH })).toEqual({ sizeBytes: SIZE, hash: HASH })
    expect(movieIdentity({ title: 'x', sizeBytes: SIZE })).toBeNull()
    expect(movieIdentity({ sizeBytes: SIZE, hash: '' })).toBeNull()
    expect(movieIdentity({ sizeBytes: 0, hash: HASH })).toBeNull()
    expect(movieIdentity(null)).toBeNull()
  })
})
