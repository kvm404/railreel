import { useEffect, useSyncExternalStore } from 'react'
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
 * A verified download waits as `ready`; only the About screen starts the install, and never during
 * a session (installing restarts the app). Every async step owns an operation number: a result that
 * lands after a newer check, download or cancel has started is dropped, so a late quiet check or a
 * cancelled transfer can never overwrite or delete what came after it.
 *
 * The internet is used only here. A quiet check (Home) never shows an error: no connection simply
 * means no news. A check the person asked for (About) always reports.
 */

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'current'; checkedAt: number }
  | { status: 'available'; update: AvailableUpdate }
  | { status: 'downloading'; update: AvailableUpdate; receivedBytes: number }
  | { status: 'verifying'; update: AvailableUpdate }
  /** Verified on disk. `launched`: Android's installer was opened (and may have been backed out of). */
  | { status: 'ready'; update: AvailableUpdate; launched: boolean }
  /** Android needs the "Install unknown apps" switch turned on for RailReel first. */
  | { status: 'permission'; update: AvailableUpdate }
  | { status: 'error'; message: string; update: AvailableUpdate | null }

const UPDATES_DIR = `${LegacyFS.cacheDirectory ?? ''}updates/`
const CHECK_TIMEOUT_MS = 12_000
const PROGRESS_STEP_BYTES = 512 * 1024

let state: UpdateState = { status: 'idle' }
const listeners = new Set<() => void>()
let lastQuietCheckAt: number | null = null
/** Bumped by every check, download and cancel; an async step only lands while it owns the latest. */
let op = 0
let download: LegacyFS.DownloadResumable | null = null
let readyFile: string | null = null

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

/** The store's current state (for event handlers outside React). */
export const getUpdateState = (): UpdateState => state

export const currentVersion = (): string => RailReelHost.getAppVersion()

const transferring = () => state.status === 'downloading' || state.status === 'verifying'

/** Ask GitHub for the latest release. `quiet`: a background check that never reports failure. */
export async function checkForUpdate({ quiet = false }: { quiet?: boolean } = {}): Promise<void> {
  // Never under a transfer, and a quiet check never pre-empts one the person started.
  if (transferring() || (quiet && state.status === 'checking')) return
  const mine = ++op
  const before = state
  if (!quiet) set({ status: 'checking' })
  const owned = () => op === mine
  const fail = (message: string) => {
    if (owned()) set(quiet ? before : { status: 'error', message, update: null })
  }

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
  if (res.status === 404) return fail("GitHub has no published RailReel release to offer. Try again later.")
  if (!res.ok) return fail(`GitHub answered with an error (${res.status}). Try again later.`)
  let json: unknown
  try {
    json = await res.json()
  } catch {
    return fail('GitHub sent an unreadable response. Try again later.')
  }
  if (!owned()) return

  const verdict = evaluateRelease(json, currentVersion())
  if (verdict.kind === 'available') {
    // Already holding this exact build verified on disk: keep it ready instead of re-offering.
    if ((before.status === 'ready' || before.status === 'permission') && before.update.tag === verdict.update.tag) return set(before)
    return set({ status: 'available', update: verdict.update })
  }
  if (verdict.kind === 'current') {
    readyFile = null
    set({ status: 'current', checkedAt: Date.now() })
    await LegacyFS.deleteAsync(UPDATES_DIR, { idempotent: true }).catch(() => {}) // the installed update's APK
    return
  }
  return fail(verdict.reason)
}

/** Download the update's APK and verify it against GitHub's size and digest; ends `ready`. */
export async function downloadUpdate(): Promise<void> {
  if (transferring() || state.status === 'checking') return
  const update = 'update' in state ? state.update : null
  if (!update) return
  // Claim the store before the first await, so a second tap can't start a second writer.
  const mine = ++op
  const owned = () => op === mine
  set({ status: 'downloading', update, receivedBytes: 0 })
  readyFile = null
  await LegacyFS.deleteAsync(UPDATES_DIR, { idempotent: true }).catch(() => {})
  await LegacyFS.makeDirectoryAsync(UPDATES_DIR, { intermediates: true }).catch(() => {})
  if (!owned()) return
  // A file per operation: a cancelled transfer's cleanup can only ever remove its own bytes.
  const file = `${UPDATES_DIR}${mine}-${update.apkName}`

  let lastReported = 0
  const task = LegacyFS.createDownloadResumable(update.apkUrl, file, {}, ({ totalBytesWritten }) => {
    if (!owned() || totalBytesWritten - lastReported < PROGRESS_STEP_BYTES) return
    lastReported = totalBytesWritten
    set({ status: 'downloading', update, receivedBytes: totalBytesWritten })
  })
  download = task
  let result: LegacyFS.FileSystemDownloadResult | undefined
  try {
    result = await task.downloadAsync()
  } catch {
    if (!owned()) return
    download = null
    return set({ status: 'error', message: 'The download stopped. Check your connection and try again.', update })
  }
  if (!owned()) return // cancelled
  download = null
  if (!result || result.status < 200 || result.status >= 300) {
    return set({ status: 'error', message: `The download failed (${result?.status ?? 'no response'}). Try again.`, update })
  }

  set({ status: 'verifying', update })
  const info = await LegacyFS.getInfoAsync(file).catch(() => ({ exists: false as const }))
  const sizeBytes = info.exists && 'size' in info && typeof info.size === 'number' ? info.size : 0
  const sha256 = info.exists ? await RailReelHost.sha256File(file).catch(() => null) : null
  if (!owned()) return
  const problem = downloadProblem({ exists: info.exists, sizeBytes, sha256 }, update)
  if (problem) {
    await LegacyFS.deleteAsync(file, { idempotent: true }).catch(() => {})
    if (owned()) set({ status: 'error', message: problem, update })
    return
  }
  readyFile = file
  set({ status: 'ready', update, launched: false })
}

/** Stop a running download; the offer comes back once the old transfer has let go of its file. */
export async function cancelDownload(): Promise<void> {
  if (state.status !== 'downloading') return
  const { update } = state
  const task = download
  download = null
  const mine = ++op // the transfer no longer owns the store; Cancel is ignored until cleanup settles
  await task?.pauseAsync().catch(() => {})
  await LegacyFS.deleteAsync(UPDATES_DIR, { idempotent: true }).catch(() => {})
  if (op === mine) set({ status: 'available', update })
}

/**
 * Open Android's installer for the verified APK (asking for the install permission first). The
 * caller (About) makes sure no session is running: installing replaces and restarts the app.
 */
export async function installUpdate(): Promise<void> {
  if (state.status !== 'ready' && state.status !== 'permission') return
  const { update } = state
  const file = readyFile
  const kept = file ? await LegacyFS.getInfoAsync(file).catch(() => ({ exists: false as const })) : null
  if (!file || !kept?.exists) {
    // The cache was cleared under us: fetch it again rather than dead-ending.
    set({ status: 'available', update })
    return downloadUpdate()
  }
  if (!RailReelHost.canInstallPackages()) return set({ status: 'permission', update })
  try {
    await RailReelHost.installApk(await LegacyFS.getContentUriAsync(file))
    set({ status: 'ready', update, launched: true })
  } catch {
    set({ status: 'error', message: "Android's installer didn't open. Try again.", update })
  }
}

/** Send the person to the "Install unknown apps" switch (About resumes the install on return). */
export async function openInstallPermission(): Promise<void> {
  await RailReelHost.openInstallSettings().catch(() => {})
}

/** Home: check quietly when it opens, at most every few hours while the app stays running. */
export function useQuietUpdateCheck(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !shouldQuietCheck(lastQuietCheckAt, Date.now())) return
    lastQuietCheckAt = Date.now()
    void checkForUpdate({ quiet: true })
  }, [enabled])
}
