/**
 * In-app updates from GitHub Releases (pure). The app asks GitHub for the latest published
 * release, and this module decides — from untrusted JSON — whether it is a newer RailReel build
 * this phone can install, and what to tell the person. Fetching, downloading and installing live in
 * hooks/useAppUpdate and the native module; everything that can be judged without a device is here
 * and unit-tested.
 *
 * Trust: the release JSON comes over HTTPS from api.github.com, but it is still parsed defensively.
 * The APK must be the build workflow's own asset for this exact tag, served from this repo's
 * release-download path, and the download is checked against GitHub's size and SHA-256 digest
 * before Android's installer — which also refuses an APK signed by a different key — ever sees it.
 */

export const RELEASES_REPO = 'kvm404/railreel'
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`
export const RELEASES_PAGE_URL = `https://github.com/${RELEASES_REPO}/releases`
const DOWNLOAD_PREFIX = `https://github.com/${RELEASES_REPO}/releases/download/`

/** How many "what's new" lines the About screen shows; the full notes are one tap away. */
export const MAX_NOTES = 6

export type Version = readonly [number, number, number]

/** "v0.3.0" or "0.3.0" → [0, 3, 0]. Anything else (pre-release suffixes included) → null. */
export function parseVersion(raw: unknown): Version | null {
  if (typeof raw !== 'string') return null
  const m = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(raw.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1
  }
  return 0
}

export function formatVersion(v: Version): string {
  return `${v[0]}.${v[1]}.${v[2]}`
}

export type AvailableUpdate = {
  version: Version
  tag: string
  apkName: string
  apkUrl: string
  sizeBytes: number
  /** Lowercase hex SHA-256 from GitHub's asset digest; null when GitHub didn't publish one. */
  sha256: string | null
  notes: string[]
  /** The release's page, for the full notes. */
  pageUrl: string
  /** ISO timestamp, or null. */
  publishedAt: string | null
}

export type UpdateVerdict =
  | { kind: 'available'; update: AvailableUpdate }
  | { kind: 'current' }
  /** The response wasn't a usable release (no APK attached yet, malformed, a draft). */
  | { kind: 'invalid'; reason: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Decide what the latest-release response means for a phone running `currentVersion`. */
export function evaluateRelease(json: unknown, currentVersion: string): UpdateVerdict {
  const current = parseVersion(currentVersion)
  if (!current) return { kind: 'invalid', reason: 'This build has no version number to compare.' }
  if (!isObj(json)) return { kind: 'invalid', reason: 'GitHub sent an unexpected response.' }
  if (json.draft === true || json.prerelease === true) return { kind: 'current' }
  const tag = typeof json.tag_name === 'string' ? json.tag_name.trim() : ''
  const version = parseVersion(tag)
  if (!version) return { kind: 'invalid', reason: 'The latest release has no version number.' }
  if (compareVersions(version, current) <= 0) return { kind: 'current' }

  const apkName = `RailReel-${tag}.apk`
  const asset = Array.isArray(json.assets) ? json.assets.find((a) => isObj(a) && a.name === apkName) : undefined
  if (!isObj(asset)) return { kind: 'invalid', reason: `Version ${formatVersion(version)} has no app file yet — it may still be building.` }
  const url = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : ''
  const size = typeof asset.size === 'number' && Number.isSafeInteger(asset.size) ? asset.size : 0
  if (asset.state !== undefined && asset.state !== 'uploaded') {
    return { kind: 'invalid', reason: `Version ${formatVersion(version)} is still uploading. Try again in a few minutes.` }
  }
  if (url !== `${DOWNLOAD_PREFIX}${tag}/${apkName}` || size <= 0) {
    return { kind: 'invalid', reason: "The release file looks wrong, so RailReel won't download it." }
  }
  const digest = typeof asset.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest) : null
  const pageUrl = typeof json.html_url === 'string' && json.html_url.startsWith(`https://github.com/${RELEASES_REPO}/releases/`)
    ? json.html_url
    : RELEASES_PAGE_URL

  return {
    kind: 'available',
    update: {
      version,
      tag,
      apkName,
      apkUrl: url,
      sizeBytes: size,
      sha256: digest ? digest[1]!.toLowerCase() : null,
      notes: releaseNotes(json.body),
      pageUrl,
      publishedAt: typeof json.published_at === 'string' ? json.published_at : null,
    },
  }
}

/**
 * The release-please changelog as plain lines: its bullets, with markdown links reduced to their
 * text and the trailing PR / commit references dropped ("([#47](…)) ([436e04c](…))").
 */
export function releaseNotes(body: unknown): string[] {
  if (typeof body !== 'string') return []
  const out: string[] = []
  for (const raw of body.split(/\r?\n/)) {
    const m = /^\s*[*-]\s+(.*)$/.exec(raw)
    if (!m) continue
    const line = m[1]!
      .replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '') // ([#47](url)) / ([436e04c](url))
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) → text
      .replace(/\*\*|__|`/g, '')
      .trim()
    if (!line) continue
    out.push(line.charAt(0).toUpperCase() + line.slice(1))
    if (out.length === MAX_NOTES) break
  }
  return out
}

/** Why a finished download can't be installed (null = it can). */
export function downloadProblem(
  got: { exists: boolean; sizeBytes: number; sha256: string | null },
  expected: Pick<AvailableUpdate, 'sizeBytes' | 'sha256'>,
): string | null {
  if (!got.exists || got.sizeBytes !== expected.sizeBytes) return "The download didn't finish. Try again."
  if (expected.sha256 && got.sha256?.toLowerCase() !== expected.sha256) {
    return "The downloaded file doesn't match the release, so it wasn't installed. Try again."
  }
  return null
}

/** How often the quiet check on Home may run while the app stays open. */
export const QUIET_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export function shouldQuietCheck(lastCheckedAt: number | null, now: number): boolean {
  return lastCheckedAt === null || now - lastCheckedAt >= QUIET_CHECK_INTERVAL_MS
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-11-27T04:36:23Z" → "27 Nov 2026" (local date); null for anything unparseable. */
export function formatReleaseDate(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** Local wall-clock "HH:MM" for "checked at" lines. */
export function formatClock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
