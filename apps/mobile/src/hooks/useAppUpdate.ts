import { useEffect, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import * as LegacyFS from 'expo-file-system/legacy'
import RailReelHost from '../../modules/railreel-host'
import {
  downloadProblem,
  evaluateRelease,
  LATEST_RELEASE_URL,
  shouldQuietCheck,
  type AvailableUpdate,
} from '@/lib/update/release'

/**
 * In-app update: check GitHub for a newer release, download its APK, verify it, and hand it to
 * Android's installer. One app-wide store (Home's quiet check and the About screen share it), with
 * the decisions in lib/update/release and the device work in the native module.
 *
 * This is the one place RailReel uses the internet. A quiet check (Home) never shows an error: no
 * connection simply means no news. A check the person asked for (About) always reports.
 */

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'current'; checkedAt: number }
  | { status: 'available'; update: AvailableUpdate }
  | { status: 'downloading'; update: AvailableUpdate; receivedBytes: number }
  | { status: 'verifying'; update: AvailableUpdate }
  /** Android needs the "Install unknown apps" switch turned on for RailReel first. */
  | { status: 'permission'; update: AvailableUpdate }
  /** The system installer was opened; it asks the person to confirm. */
  | { status: 'installing'; update: AvailableUpdate }
  | { status: 'error'; message: string; update: AvailableUpdate | null }

const UPDATES_DIR = `${LegacyFS.cacheDirectory ?? ''}updates/`
const CHECK_TIMEOUT_MS = 12_000
const PROGRESS_STEP_BYTES = 512 * 1024

let state: UpdateState = { status: 'idle' }
const listeners = new Set<() => void>()
let lastQuietCheckAt: number | null = null
let download: LegacyFS.DownloadResumable | null = null
let downloadedFile: string | null = null

function set(next: UpdateState) {
  state = next
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useAppUpdate(): UpdateState {
  return useSyncExternalStore(subscribe, () => state)
}

export const currentVersion = (): string => RailReelHost.getAppVersion()

/** Remove downloaded APKs (a finished install leaves the old file behind). */
async function clearDownloads() {
  await LegacyFS.deleteAsync(UPDATES_DIR, { idempotent: true }).catch(() => {})
  downloadedFile = null
}

const busy = () => state.status === 'downloading' || state.status === 'verifying' || state.status === 'installing'

/** Ask GitHub for the latest release. `quiet`: a background check that never reports failure. */
export async function checkForUpdate({ quiet = false }: { quiet?: boolean } = {}): Promise<void> {
  if (busy() || state.status === 'checking') return
  const before = state
  if (!quiet) set({ status: 'checking' })
  const fail = (message: string) => set(quiet ? before : { status: 'error', message, update: null })

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), CHECK_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(LATEST_RELEASE_URL, { headers: { Accept: 'application/vnd.github+json' }, signal: abort.signal })
  } catch {
    return fail("Couldn't reach GitHub. Connect to Wi-Fi or mobile data, then try again.")
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 403 || res.status === 429) return fail('GitHub is limiting requests right now. Try again in a little while.')
  if (res.status === 404) return set({ status: 'current', checkedAt: Date.now() }) // no published release yet
  if (!res.ok) return fail(`GitHub answered with an error (${res.status}). Try again later.`)
  let json: unknown
  try {
    json = await res.json()
  } catch {
    return fail('GitHub sent an unreadable response. Try again later.')
  }

  const verdict = evaluateRelease(json, currentVersion())
  if (verdict.kind === 'available') return set({ status: 'available', update: verdict.update })
  if (verdict.kind === 'current') {
    await clearDownloads()
    return set({ status: 'current', checkedAt: Date.now() })
  }
  return fail(verdict.reason)
}

/** Download the update's APK, verify it against GitHub's size and digest, then install it. */
export async function downloadUpdate(): Promise<void> {
  const update = 'update' in state ? state.update : null
  if (!update || busy()) return
  await clearDownloads()
  await LegacyFS.makeDirectoryAsync(UPDATES_DIR, { intermediates: true }).catch(() => {})
  const file = `${UPDATES_DIR}${update.apkName}`
  set({ status: 'downloading', update, receivedBytes: 0 })

  let lastReported = 0
  const task = LegacyFS.createDownloadResumable(update.apkUrl, file, {}, ({ totalBytesWritten }) => {
    if (state.status !== 'downloading' || download !== task) return
    if (totalBytesWritten - lastReported < PROGRESS_STEP_BYTES && totalBytesWritten < update.sizeBytes) return
    lastReported = totalBytesWritten
    set({ status: 'downloading', update, receivedBytes: totalBytesWritten })
  })
  download = task
  let result: LegacyFS.FileSystemDownloadResult | undefined
  try {
    result = await task.downloadAsync()
  } catch {
    if (download !== task) return // cancelled
    download = null
    return set({ status: 'error', message: 'The download stopped. Check your connection and try again.', update })
  }
  if (download !== task) return // cancelled while finishing
  download = null
  if (!result || result.status < 200 || result.status >= 300) {
    return set({ status: 'error', message: `The download failed (${result?.status ?? 'no response'}). Try again.`, update })
  }

  set({ status: 'verifying', update })
  const info = await LegacyFS.getInfoAsync(file).catch(() => ({ exists: false as const }))
  const sizeBytes = info.exists && 'size' in info && typeof info.size === 'number' ? info.size : 0
  const sha256 = update.sha256 && info.exists ? await RailReelHost.sha256File(file).catch(() => null) : null
  const problem = downloadProblem({ exists: info.exists, sizeBytes, sha256 }, update)
  if (problem) {
    await clearDownloads()
    return set({ status: 'error', message: problem, update })
  }
  downloadedFile = file
  await installUpdate()
}

/** Stop a running download and go back to the offer. */
export async function cancelDownload(): Promise<void> {
  if (state.status !== 'downloading') return
  const { update } = state
  const task = download
  download = null
  set({ status: 'available', update })
  await task?.pauseAsync().catch(() => {})
  await clearDownloads()
}

/** Open Android's installer for the verified APK (asking for the install permission first). */
export async function installUpdate(): Promise<void> {
  const update = 'update' in state ? state.update : null
  if (!update) return
  if (!downloadedFile) return downloadUpdate()
  if (!RailReelHost.canInstallPackages()) return set({ status: 'permission', update })
  try {
    const uri = await LegacyFS.getContentUriAsync(downloadedFile)
    await RailReelHost.installApk(uri)
    set({ status: 'installing', update })
  } catch {
    set({ status: 'error', message: "Android's installer didn't open. Try again.", update })
  }
}

/** Send the person to the "Install unknown apps" switch; returning to the app resumes the install. */
export async function openInstallPermission(): Promise<void> {
  await RailReelHost.openInstallSettings().catch(() => {})
}

// Coming back from the settings switch: carry on with the install once it's allowed.
AppState.addEventListener('change', (next) => {
  if (next === 'active' && state.status === 'permission' && RailReelHost.canInstallPackages()) void installUpdate()
})

/** Home: check quietly when it opens, at most every few hours while the app stays running. */
export function useQuietUpdateCheck(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !shouldQuietCheck(lastQuietCheckAt, Date.now())) return
    lastQuietCheckAt = Date.now()
    void checkForUpdate({ quiet: true })
  }, [enabled])
}
