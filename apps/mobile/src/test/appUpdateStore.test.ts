import { describe, it, expect, vi, beforeEach } from 'vitest'

// The update store's ordering guarantees, with the network, file system and native module mocked:
// one writer per download, late results dropped, cancel cleanup scoped, install never automatic.

const SHA = 'a'.repeat(64)
const SIZE = 1000
const release = (tag = 'v0.3.0') => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  html_url: `https://github.com/kvm404/railreel/releases/tag/${tag}`,
  body: '* a change',
  assets: [
    {
      name: `RailReel-${tag}.apk`,
      size: SIZE,
      state: 'uploaded',
      digest: `sha256:${SHA}`,
      browser_download_url: `https://github.com/kvm404/railreel/releases/download/${tag}/RailReel-${tag}.apk`,
    },
  ],
})

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const files = new Set<string>()
type Task = { file: string; done: Deferred<{ status: number } | undefined>; paused: boolean }
const tasks: Task[] = []

vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  deleteAsync: vi.fn(async (path: string) => {
    for (const f of [...files]) if (f === path || f.startsWith(path)) files.delete(f)
  }),
  makeDirectoryAsync: vi.fn(async () => {}),
  getInfoAsync: vi.fn(async (path: string) => (files.has(path) ? { exists: true, size: SIZE } : { exists: false })),
  getContentUriAsync: vi.fn(async (path: string) => path.replace('file://', 'content://')),
  createDownloadResumable: vi.fn((_url: string, file: string) => {
    const task: Task = { file, done: deferred(), paused: false }
    tasks.push(task)
    return {
      downloadAsync: () =>
        task.done.promise.then((r) => {
          if (r && !task.paused) files.add(file)
          return r
        }),
      pauseAsync: async () => {
        task.paused = true
        task.done.resolve(undefined)
      },
    }
  }),
}))

const native = {
  getAppVersion: vi.fn(() => '0.2.0'),
  sha256File: vi.fn(async () => SHA),
  canInstallPackages: vi.fn(() => true),
  installApk: vi.fn(async () => {}),
  openInstallSettings: vi.fn(async () => {}),
}
vi.mock('../../modules/railreel-host', () => ({ default: native }))

const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as unknown as Response
const flush = () => new Promise((r) => setTimeout(r, 0))

async function load() {
  vi.resetModules()
  return import('@/hooks/useAppUpdate')
}

async function offered(m: Awaited<ReturnType<typeof load>>) {
  globalThis.fetch = vi.fn(async () => ok(release())) as typeof fetch
  await m.checkForUpdate()
  expect(m.getUpdateState().status).toBe('available')
}

beforeEach(() => {
  files.clear()
  tasks.length = 0
  vi.clearAllMocks()
  native.canInstallPackages.mockReturnValue(true)
})

describe('update store', () => {
  it('starts exactly one download however fast Download is tapped', async () => {
    const m = await load()
    await offered(m)
    void m.downloadUpdate()
    void m.downloadUpdate()
    await flush()
    expect(tasks).toHaveLength(1)
  })

  it('downloads, verifies and stops at ready: the store never opens the installer by itself', async () => {
    const m = await load()
    await offered(m)
    const run = m.downloadUpdate()
    await flush()
    tasks[0]!.done.resolve({ status: 200 })
    await run
    expect(m.getUpdateState()).toMatchObject({ status: 'ready', launched: false })
    expect(native.installApk).not.toHaveBeenCalled()
    await m.installUpdate()
    expect(native.installApk).toHaveBeenCalledTimes(1)
    expect(m.getUpdateState()).toMatchObject({ status: 'ready', launched: true })
  })

  it('drops a late quiet-check failure instead of wiping a download that started meanwhile', async () => {
    const m = await load()
    const quietFetch = deferred<Response>()
    globalThis.fetch = vi.fn(() => quietFetch.promise) as typeof fetch
    const quiet = m.checkForUpdate({ quiet: true })
    await offered(m) // the person checks by hand while the quiet one is still out
    void m.downloadUpdate()
    await flush()
    quietFetch.reject(new Error('offline'))
    await quiet
    expect(m.getUpdateState().status).toBe('downloading')
  })

  it('keeps Download inert until a cancel has cleaned up, and the old cleanup spares the retry', async () => {
    const m = await load()
    await offered(m)
    void m.downloadUpdate()
    await flush()
    const cancelling = m.cancelDownload()
    void m.downloadUpdate() // tapped while the cancel is still settling: ignored
    await cancelling
    expect(m.getUpdateState().status).toBe('available')
    expect(tasks).toHaveLength(1)

    const retry = m.downloadUpdate()
    await flush()
    expect(tasks).toHaveLength(2)
    expect(tasks[1]!.file).not.toBe(tasks[0]!.file)
    tasks[1]!.done.resolve({ status: 200 })
    await retry
    expect(m.getUpdateState().status).toBe('ready')
  })

  it('rejects a download whose digest does not match and offers a retry', async () => {
    native.sha256File.mockResolvedValueOnce('b'.repeat(64))
    const m = await load()
    await offered(m)
    const run = m.downloadUpdate()
    await flush()
    tasks[0]!.done.resolve({ status: 200 })
    await run
    expect(m.getUpdateState()).toMatchObject({ status: 'error', update: { tag: 'v0.3.0' } })
    expect(native.installApk).not.toHaveBeenCalled()
  })

  it('asks for the install permission instead of failing, then installs once it is granted', async () => {
    native.canInstallPackages.mockReturnValue(false)
    const m = await load()
    await offered(m)
    const run = m.downloadUpdate()
    await flush()
    tasks[0]!.done.resolve({ status: 200 })
    await run
    await m.installUpdate()
    expect(m.getUpdateState().status).toBe('permission')
    native.canInstallPackages.mockReturnValue(true)
    await m.installUpdate()
    expect(native.installApk).toHaveBeenCalledTimes(1)
  })

  it('after the installer is backed out of, stays recoverable: checks run and the build stays ready', async () => {
    const m = await load()
    await offered(m)
    const run = m.downloadUpdate()
    await flush()
    tasks[0]!.done.resolve({ status: 200 })
    await run
    await m.installUpdate()
    await m.checkForUpdate()
    expect(m.getUpdateState()).toMatchObject({ status: 'ready', launched: true })
  })

  it('re-downloads when the verified APK was evicted from the cache before install', async () => {
    const m = await load()
    await offered(m)
    const run = m.downloadUpdate()
    await flush()
    tasks[0]!.done.resolve({ status: 200 })
    await run
    files.clear() // Android cleared the cache
    void m.installUpdate()
    await flush()
    expect(m.getUpdateState().status).toBe('downloading')
    expect(native.installApk).not.toHaveBeenCalled()
  })

  it('reports a missing release (404) as an error, not as up to date', async () => {
    const m = await load()
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response) as typeof fetch
    await m.checkForUpdate()
    expect(m.getUpdateState().status).toBe('error')
  })
})
