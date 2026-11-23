import { describe, it, expect } from 'vitest'
import { awaitOwnership, createOwnershipQueue } from '@/lib/storage/ownership'

/** A promise you settle by hand (a native download that hasn't stopped writing yet). */
function deferred() {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('ownership queue', () => {
  it('the first owner has no predecessor', async () => {
    const q = createOwnershipQueue()
    let seen: Promise<void> | null | undefined
    await q.run(async (prev) => {
      seen = prev
    })
    expect(seen).toBeNull()
  })

  it('later work waits for earlier work, even after the earlier work rejects', async () => {
    const q = createOwnershipQueue()
    const a = deferred()
    q.run(() => a.promise)
    const order: string[] = []
    const b = q.run(async (prev) => {
      await prev
      order.push('b')
    })
    await tick()
    expect(order).toEqual([]) // a's writer is still alive
    a.reject(new Error('download failed'))
    await b
    expect(order).toEqual(['b'])
  })

  it('a waiter that gave up does not release the file: the wedged owner still guards the next one', async () => {
    const q = createOwnershipQueue()
    const wedged = deferred()
    q.run(() => wedged.promise)
    // Attempt 2 gives up after its ceiling and settles quickly.
    const gaveUp = await q.run((prev) => awaitOwnership(prev, 5, (ms) => new Promise((r) => setTimeout(r, ms))))
    expect(gaveUp).toBe(false)
    // Attempt 3 must still be blocked by the wedged owner, not by attempt 2's quick exit.
    let owned = false
    const third = q.run(async (prev) => {
      await prev
      owned = true
    })
    await tick()
    expect(owned).toBe(false)
    wedged.resolve()
    await third
    expect(owned).toBe(true)
  })

  it('awaitOwnership: immediate without a predecessor, true once it settles', async () => {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    expect(await awaitOwnership(null, 10, sleep)).toBe(true)
    expect(await awaitOwnership(Promise.resolve(), 1000, sleep)).toBe(true)
  })

  it('one module-level queue is shared by every consumer (a remounted provider inherits the owner)', async () => {
    // Simulate: provider #1 starts a download and unmounts; provider #2 mounts and sweeps.
    const q = createOwnershipQueue()
    const nativeWriter = deferred()
    q.run(() => nativeWriter.promise) // provider #1's attempt (cancel requested, not yet stopped)
    let swept = false
    const sweep = q.run(async (prev) => {
      await prev
      swept = true
    }) // provider #2's startup sweep
    await tick()
    expect(swept).toBe(false)
    nativeWriter.resolve()
    await sweep
    expect(swept).toBe(true)
  })
})
