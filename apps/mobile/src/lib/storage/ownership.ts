/**
 * Exclusive ownership of a shared cache path (MOVIE_CACHE) across async work that can outlive
 * whoever started it. A native download keeps writing until its promise settles — cancelling only
 * REQUESTS a stop — so every operation that touches the file (startup sweep, each transfer
 * attempt) joins one queue and waits for everything queued before it.
 *
 * The queue must live at MODULE scope, not in a component: a provider remount (dev reload,
 * StrictMode) has to inherit the outstanding owner, or the new instance sweeps/writes the file
 * while the old instance's writer is still alive.
 *
 * A waiter may give up after a ceiling (`awaitOwnership` → false: it must not touch the file),
 * but a wedged predecessor stays at the head of the queue for everyone after it. Pure + tested.
 */

export interface OwnershipQueue {
  /** Everything queued so far, settled (never rejects); null when nothing was ever queued. */
  tail(): Promise<void> | null
  /**
   * Queue work behind everything before it: `start` is called synchronously with the
   * predecessor it must wait for (null = none) and returns the work's promise.
   */
  run<T>(start: (prev: Promise<void> | null) => Promise<T>): Promise<T>
}

export function createOwnershipQueue(): OwnershipQueue {
  let tail: Promise<void> | null = null
  return {
    tail: () => tail,
    run(start) {
      const prev = tail
      const work = start(prev)
      const settled = work.then(
        () => {},
        () => {},
      )
      // Even if `work` gives up waiting on a wedged `prev`, `prev` still guards later work.
      tail = prev ? Promise.all([prev, settled]).then(() => {}) : settled
      return work
    },
  }
}

/**
 * Wait for `prev` to settle, at most `ceilingMs`. true = we own the file now; false = the
 * predecessor is still running (don't touch the file — fail this attempt and retry later).
 */
export async function awaitOwnership(
  prev: Promise<void> | null,
  ceilingMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  if (!prev) return true
  return Promise.race([prev.then(() => true), sleep(ceilingMs).then(() => false)])
}

/**
 * Queue exclusive work on the file (a cache purge): registered in `queue` SYNCHRONOUSLY — so
 * anything queued after this call (a newer session's download) waits for it — then run once
 * everything before it has settled. If a predecessor is still running past `ceilingMs`,
 * `onBusy` reports why instead (the file is never touched under a live writer).
 */
export function runExclusive<T>(
  queue: OwnershipQueue,
  ceilingMs: number,
  sleep: (ms: number) => Promise<void>,
  work: () => Promise<T>,
  onBusy: () => T,
): Promise<T> {
  return queue.run(async (prev) => ((await awaitOwnership(prev, ceilingMs, sleep)) ? work() : onBusy()))
}
