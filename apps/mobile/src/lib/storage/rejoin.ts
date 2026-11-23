/**
 * Is there a finished movie copy on this phone that a rejoin could reuse? The cleanup sheet only
 * promises a "quick rejoin" when this is true — a half-downloaded file is not a quick anything
 * (the next session resumes or restarts it). Reads the same identity record the kept-copy reuse
 * and the startup orphan sweep trust, so the promise and the behavior can't disagree.
 */

import { findKeptCacheFiles } from './keptCache'
import { getDefaultCacheDir, getDefaultFsAdapter, type FileSystemAdapter } from './cache'

export async function hasReusableMovieCopy(
  readText: (uri: string) => Promise<string>,
  cacheDir: string = getDefaultCacheDir(),
  fs: FileSystemAdapter | null = getDefaultFsAdapter(),
): Promise<boolean> {
  if (!fs || !cacheDir) return false
  try {
    return (await findKeptCacheFiles(cacheDir, fs, readText)).length > 0
  } catch {
    return false
  }
}
