import { describe, it, expect } from 'vitest'
import {
  compareVersions,
  downloadProblem,
  evaluateRelease,
  formatClock,
  formatReleaseDate,
  MAX_NOTES,
  parseVersion,
  QUIET_CHECK_INTERVAL_MS,
  releaseNotes,
  RELEASES_PAGE_URL,
  shouldQuietCheck,
} from '@/lib/update/release'

// Shaped like the real api.github.com/repos/kvm404/railreel/releases/latest response for v0.3.0.
const BODY =
  '## [0.3.0](https://github.com/kvm404/railreel/compare/v0.2.0...v0.3.0) (2026-11-27)\n\n\n### Features\n\n' +
  '* host HEVC and MKV, recover blank screens, bring back hidden player controls ([#47](https://github.com/kvm404/railreel/issues/47)) ([436e04c](https://github.com/kvm404/railreel/commit/436e04cfa8c5f5ae0c874b29a92a6e5da80e71db))\n\n\n' +
  '### Bug Fixes\n\n' +
  '* keep sync through sleep, detect a silent host ([#49](https://github.com/kvm404/railreel/issues/49)) ([9e6a696](https://github.com/kvm404/railreel/commit/9e6a696f56aea4b3ecbf71153d1ab10892c476e6))'
const SHA = '1ea2fcc6aa522001424ebf3c771acd9b5e76b057c06ddc7468f21fa10fa9a6d5'

const release = (over: Record<string, unknown> = {}, asset: Record<string, unknown> = {}) => ({
  tag_name: 'v0.3.0',
  draft: false,
  prerelease: false,
  published_at: '2026-11-27T04:36:23Z',
  html_url: 'https://github.com/kvm404/railreel/releases/tag/v0.3.0',
  body: BODY,
  assets: [
    {
      name: 'RailReel-v0.3.0.apk',
      size: 64435191,
      state: 'uploaded',
      digest: `sha256:${SHA}`,
      browser_download_url: 'https://github.com/kvm404/railreel/releases/download/v0.3.0/RailReel-v0.3.0.apk',
      ...asset,
    },
  ],
  ...over,
})

describe('versions', () => {
  it('parses tags with or without the v and rejects anything else', () => {
    expect(parseVersion('v0.3.0')).toEqual([0, 3, 0])
    expect(parseVersion(' 1.12.4 ')).toEqual([1, 12, 4])
    for (const bad of ['0.3', 'v0.3.0-beta.1', 'latest', '', null, 3]) expect(parseVersion(bad)).toBeNull()
  })

  it('compares numerically, not as text', () => {
    expect(compareVersions([0, 10, 0], [0, 9, 9])).toBe(1)
    expect(compareVersions([1, 0, 0], [1, 0, 0])).toBe(0)
    expect(compareVersions([0, 3, 0], [0, 3, 1])).toBe(-1)
  })
})

describe('evaluateRelease', () => {
  it('offers a newer release with its APK, size, digest, notes and page', () => {
    const v = evaluateRelease(release(), '0.2.0')
    expect(v.kind).toBe('available')
    if (v.kind !== 'available') return
    expect(v.update).toMatchObject({
      version: [0, 3, 0],
      tag: 'v0.3.0',
      apkName: 'RailReel-v0.3.0.apk',
      apkUrl: 'https://github.com/kvm404/railreel/releases/download/v0.3.0/RailReel-v0.3.0.apk',
      sizeBytes: 64435191,
      sha256: SHA,
      pageUrl: 'https://github.com/kvm404/railreel/releases/tag/v0.3.0',
      publishedAt: '2026-11-27T04:36:23Z',
    })
    expect(v.update.notes).toEqual([
      'Host HEVC and MKV, recover blank screens, bring back hidden player controls',
      'Keep sync through sleep, detect a silent host',
    ])
  })

  it('is current when the release is the same or older than this build', () => {
    expect(evaluateRelease(release(), '0.3.0')).toEqual({ kind: 'current' })
    expect(evaluateRelease(release(), '0.4.0')).toEqual({ kind: 'current' })
  })

  it('never offers drafts or pre-releases', () => {
    expect(evaluateRelease(release({ draft: true }), '0.2.0')).toEqual({ kind: 'current' })
    expect(evaluateRelease(release({ prerelease: true }), '0.2.0')).toEqual({ kind: 'current' })
  })

  it('waits for the APK: a release whose build has not attached it yet is not offered', () => {
    const v = evaluateRelease(release({ assets: [] }), '0.2.0')
    expect(v).toMatchObject({ kind: 'invalid' })
    if (v.kind === 'invalid') expect(v.reason).toMatch(/no app file yet/)
    expect(evaluateRelease(release({}, { state: 'starter' }), '0.2.0')).toMatchObject({ kind: 'invalid' })
  })

  it('only downloads this repo’s asset for this exact tag', () => {
    for (const url of [
      'https://evil.example/RailReel-v0.3.0.apk',
      'https://github.com/someone/railreel/releases/download/v0.3.0/RailReel-v0.3.0.apk',
      'http://github.com/kvm404/railreel/releases/download/v0.3.0/RailReel-v0.3.0.apk',
      'https://github.com/kvm404/railreel/releases/download/v0.2.0/RailReel-v0.3.0.apk',
    ]) {
      expect(evaluateRelease(release({}, { browser_download_url: url }), '0.2.0')).toMatchObject({ kind: 'invalid' })
    }
    expect(evaluateRelease(release({}, { name: 'RailReel-v0.2.0.apk' }), '0.2.0')).toMatchObject({ kind: 'invalid' })
    expect(evaluateRelease(release({}, { size: 0 }), '0.2.0')).toMatchObject({ kind: 'invalid' })
  })

  it('refuses a release whose checksum is missing or malformed (verification is never skipped)', () => {
    for (const digest of [undefined, '', 'md5:abc', 'sha256:xyz', `sha256:${SHA}0`]) {
      const v = evaluateRelease(release({}, { digest }), '0.2.0')
      expect(v).toMatchObject({ kind: 'invalid' })
      if (v.kind === 'invalid') expect(v.reason).toMatch(/checksum/)
    }
  })

  it('falls back to the releases page for a foreign html_url', () => {
    const v = evaluateRelease(release({ html_url: 'https://evil.example' }), '0.2.0')
    expect(v.kind === 'available' && v.update.pageUrl).toBe(RELEASES_PAGE_URL)
  })

  it('treats garbage and an unversioned build as invalid, never as an update', () => {
    for (const json of [null, 'x', [], { tag_name: 'nightly' }]) {
      expect(evaluateRelease(json, '0.2.0').kind).toBe('invalid')
    }
    expect(evaluateRelease(release(), '').kind).toBe('invalid')
  })
})

describe('releaseNotes', () => {
  it('keeps bullets only, unwraps links and caps the list', () => {
    const body = Array.from({ length: 10 }, (_, i) => `- see [item ${i}](https://x) **now**`).join('\n')
    const notes = releaseNotes(`# Heading\nprose line\n${body}`)
    expect(notes).toHaveLength(MAX_NOTES)
    expect(notes[0]).toBe('See item 0 now')
  })

  it('is empty for a missing body', () => {
    expect(releaseNotes(undefined)).toEqual([])
  })
})

describe('downloadProblem', () => {
  const expected = { sizeBytes: 100, sha256: SHA }
  it('accepts the exact size and digest (any hex case)', () => {
    expect(downloadProblem({ exists: true, sizeBytes: 100, sha256: SHA.toUpperCase() }, expected)).toBeNull()
  })
  it('rejects a missing or short file, and a digest mismatch', () => {
    expect(downloadProblem({ exists: false, sizeBytes: 0, sha256: null }, expected)).toMatch(/didn't finish/)
    expect(downloadProblem({ exists: true, sizeBytes: 99, sha256: SHA }, expected)).toMatch(/didn't finish/)
    expect(downloadProblem({ exists: true, sizeBytes: 100, sha256: 'f'.repeat(64) }, expected)).toMatch(/doesn't match/)
    expect(downloadProblem({ exists: true, sizeBytes: 100, sha256: null }, expected)).toMatch(/doesn't match/)
  })
  it('fails closed when the file could not be hashed', () => {
    expect(downloadProblem({ exists: true, sizeBytes: 100, sha256: null }, expected)).toMatch(/doesn't match/)
  })
})

describe('shouldQuietCheck', () => {
  it('checks the first time, then at most every interval', () => {
    expect(shouldQuietCheck(null, 0)).toBe(true)
    expect(shouldQuietCheck(1000, 1000 + QUIET_CHECK_INTERVAL_MS - 1)).toBe(false)
    expect(shouldQuietCheck(1000, 1000 + QUIET_CHECK_INTERVAL_MS)).toBe(true)
  })
})

describe('date formatting', () => {
  it('formats a release date and rejects junk', () => {
    expect(formatReleaseDate('2026-11-27T12:00:00Z')).toMatch(/^2[67] Nov 2026$/) // local zone may roll the day
    expect(formatReleaseDate('not a date')).toBeNull()
    expect(formatReleaseDate(null)).toBeNull()
  })
  it('pads the clock', () => {
    expect(formatClock(new Date(2026, 0, 1, 7, 5).getTime())).toBe('07:05')
  })
})
