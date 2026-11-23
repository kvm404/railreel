import { describe, it, expect } from 'vitest'
import { encodeKeptMovieMeta, getMovieMetaPath, hasReusableMovieCopy, type FileSystemAdapter } from '@/lib/storage'

const DIR = 'file:///cache/'
const SIZE = 1_000_000
const HASH = 'qf1:' + 'cd'.repeat(32)
const record = encodeKeptMovieMeta({ hash: HASH, sizeBytes: SIZE, title: 'Night Train', savedAt: 1 })

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

  it('is true for a complete copy that matches its record', async () => {
    expect(await hasReusableMovieCopy(read, DIR, fsWith({ exists: true, size: SIZE }))).toBe(true)
  })

  it('is false for a partial download (size differs from the record)', async () => {
    expect(await hasReusableMovieCopy(read, DIR, fsWith({ exists: true, size: SIZE - 10 }))).toBe(false)
  })

  it('is false when the movie is gone, the record is missing, or nothing is configured', async () => {
    expect(await hasReusableMovieCopy(read, DIR, fsWith({ exists: false }))).toBe(false)
    expect(await hasReusableMovieCopy(async () => { throw new Error('ENOENT') }, DIR, fsWith({ exists: true, size: SIZE }))).toBe(false)
    expect(await hasReusableMovieCopy(read, '', fsWith({ exists: true, size: SIZE }))).toBe(false)
    expect(await hasReusableMovieCopy(read, DIR, null)).toBe(false)
  })
})
