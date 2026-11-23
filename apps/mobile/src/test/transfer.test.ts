import { describe, it, expect } from 'vitest'
import {
  INITIAL_RESPONSE_GRACE_MS,
  isTransferStalled,
  MAX_INTEGRITY_RETRIES,
  MAX_TRANSFER_RETRIES,
  resumeOffset,
  shouldAutoResume,
  transferResultOk,
  transferRetryDelayMs,
  TRANSFER_STALL_MS,
  earnsRetryBudget,
  retriesAfterFailure,
  MEANINGFUL_PROGRESS_BYTES,
  unvalidatedProgress,
  UNVALIDATED_PROGRESS_CAP,
  type AutoResumeInput,
} from '@/lib/net/transfer'

const SIZE = 3_000_000_000

describe('resumeOffset', () => {
  it('resumes a partial copy from its length', () => {
    expect(resumeOffset(1_234_567, SIZE)).toBe(1_234_567)
  })

  it('restarts clean for an empty, complete, oversized or unknown file', () => {
    expect(resumeOffset(0, SIZE)).toBe(0)
    expect(resumeOffset(SIZE, SIZE)).toBe(0)
    expect(resumeOffset(SIZE + 10, SIZE)).toBe(0)
    expect(resumeOffset(null, SIZE)).toBe(0)
    expect(resumeOffset(undefined, SIZE)).toBe(0)
    expect(resumeOffset(NaN, SIZE)).toBe(0)
  })

  it('never resumes without a known final size', () => {
    expect(resumeOffset(1000, 0)).toBe(0)
    expect(resumeOffset(1000, NaN)).toBe(0)
  })
})

describe('transferResultOk', () => {
  it('a fresh transfer needs 2xx and the exact size', () => {
    expect(transferResultOk(0, 200, SIZE, SIZE)).toBe(true)
    expect(transferResultOk(0, 403, 13, SIZE)).toBe(false)
    expect(transferResultOk(0, 200, SIZE - 1, SIZE)).toBe(false) // truncated
    expect(transferResultOk(0, undefined, SIZE, SIZE)).toBe(false) // cancelled
  })

  it('a resumed transfer must be a 206 — a 200 appended the whole movie again', () => {
    expect(transferResultOk(1000, 206, SIZE, SIZE)).toBe(true)
    expect(transferResultOk(1000, 200, SIZE + 1000, SIZE)).toBe(false)
    expect(transferResultOk(1000, 416, 1000, SIZE)).toBe(false)
    expect(transferResultOk(1000, 403, 1013, SIZE)).toBe(false)
  })

  it('without a known size, the status alone decides', () => {
    expect(transferResultOk(0, 200, 42, 0)).toBe(true)
  })
})

describe('shouldAutoResume', () => {
  const base: AutoResumeInput = {
    approved: true,
    phase: 'approved',
    complete: false,
    transferring: false,
    reconnecting: false,
    retries: 0,
    integrityFailures: 0,
  }

  it('resumes a failed, approved, unfinished transfer', () => {
    expect(shouldAutoResume(base)).toBe(true)
  })

  it('waits while the WS is still reconnecting (a retry would fail the same way)', () => {
    expect(shouldAutoResume({ ...base, reconnecting: true })).toBe(false)
  })

  it('does nothing when there is nothing to recover', () => {
    expect(shouldAutoResume({ ...base, complete: true })).toBe(false)
    expect(shouldAutoResume({ ...base, transferring: true })).toBe(false)
    expect(shouldAutoResume({ ...base, phase: 'downloading' })).toBe(false)
    expect(shouldAutoResume({ ...base, phase: 'ready' })).toBe(false)
    expect(shouldAutoResume({ ...base, phase: 'denied' })).toBe(false)
    expect(shouldAutoResume({ ...base, approved: false })).toBe(false)
  })

  it('is bounded', () => {
    expect(shouldAutoResume({ ...base, retries: MAX_TRANSFER_RETRIES - 1 })).toBe(true)
    expect(shouldAutoResume({ ...base, retries: MAX_TRANSFER_RETRIES })).toBe(false)
  })

  it('integrity failures have their own small budget (each one re-pulls the whole movie)', () => {
    expect(shouldAutoResume({ ...base, integrityFailures: MAX_INTEGRITY_RETRIES })).toBe(true)
    expect(shouldAutoResume({ ...base, integrityFailures: MAX_INTEGRITY_RETRIES + 1 })).toBe(false)
  })
})

describe('transferRetryDelayMs', () => {
  it('backs off exponentially from 1s and caps at 15s', () => {
    expect(transferRetryDelayMs(0)).toBe(1000)
    expect(transferRetryDelayMs(1)).toBe(2000)
    expect(transferRetryDelayMs(3)).toBe(8000)
    expect(transferRetryDelayMs(4)).toBe(15_000)
    expect(transferRetryDelayMs(10)).toBe(15_000)
  })
})

describe('isTransferStalled', () => {
  const START = 1000

  it('an established transfer is dead after the inactivity window', () => {
    const last = START + 500
    expect(isTransferStalled(true, START, last, last + TRANSFER_STALL_MS)).toBe(true)
    expect(isTransferStalled(true, START, last, last + TRANSFER_STALL_MS - 1)).toBe(false)
  })

  it('before the first byte, a slow but valid response gets the longer initial grace', () => {
    // 9s to first byte is a slow host, not a dead one.
    expect(isTransferStalled(true, START, 0, START + 9000)).toBe(false)
    expect(isTransferStalled(true, START, 0, START + INITIAL_RESPONSE_GRACE_MS - 1)).toBe(false)
    expect(isTransferStalled(true, START, 0, START + INITIAL_RESPONSE_GRACE_MS)).toBe(true)
  })

  it('never flags an idle transfer or one that has not started', () => {
    expect(isTransferStalled(false, START, START, 99_999)).toBe(false)
    expect(isTransferStalled(true, 0, 0, 99_999)).toBe(false)
  })

  it('both windows stay under the proxy edge timeout (30s) and OkHttp (60s)', () => {
    expect(TRANSFER_STALL_MS).toBeLessThan(30_000)
    expect(TRANSFER_STALL_MS).toBeGreaterThanOrEqual(5000)
    expect(INITIAL_RESPONSE_GRACE_MS).toBeGreaterThan(TRANSFER_STALL_MS)
    expect(INITIAL_RESPONSE_GRACE_MS).toBeLessThan(60_000)
    expect(isTransferStalled(true, START, START + 1, START + 2001, 2000)).toBe(true) // custom window
  })
})

describe('earnsRetryBudget', () => {
  it('only real forward progress that was KEPT earns the budget back', () => {
    expect(earnsRetryBudget(0, true)).toBe(false)
    expect(earnsRetryBudget(MEANINGFUL_PROGRESS_BYTES - 1, true)).toBe(false)
    expect(earnsRetryBudget(MEANINGFUL_PROGRESS_BYTES, true)).toBe(true)
    expect(earnsRetryBudget(NaN, true)).toBe(false)
  })

  it('bytes an attempt discarded (failed fingerprint, bad status) earn nothing', () => {
    expect(earnsRetryBudget(10 * MEANINGFUL_PROGRESS_BYTES, false)).toBe(false)
  })
})

describe('unvalidatedProgress', () => {
  it('never reports a full 1 before validation (the host reads 1 as ready)', () => {
    expect(unvalidatedProgress(100, 100)).toBe(UNVALIDATED_PROGRESS_CAP)
    expect(unvalidatedProgress(150, 100)).toBe(UNVALIDATED_PROGRESS_CAP)
    expect(unvalidatedProgress(50, 100)).toBe(0.5)
  })

  it('is 0 for unknown size or no bytes', () => {
    expect(unvalidatedProgress(50, 0)).toBe(0)
    expect(unvalidatedProgress(0, 100)).toBe(0)
    expect(unvalidatedProgress(NaN, 100)).toBe(0)
  })
})

describe('retriesAfterFailure', () => {
  const failed = (retries: number): AutoResumeInput => ({
    approved: true,
    phase: 'approved',
    complete: false,
    transferring: false,
    reconnecting: false,
    retries,
    integrityFailures: 0,
  })

  it('kept progress resets the streak; discarded or tiny progress leaves it', () => {
    expect(retriesAfterFailure(3, MEANINGFUL_PROGRESS_BYTES, true)).toBe(0)
    expect(retriesAfterFailure(3, MEANINGFUL_PROGRESS_BYTES, false)).toBe(3)
    expect(retriesAfterFailure(3, MEANINGFUL_PROGRESS_BYTES - 1, true)).toBe(3)
  })

  it('repeated watchdog stalls that each keep real bytes never exhaust the budget', () => {
    // Each cycle: the retry fires (+1), the attempt keeps 5 MiB, then the watchdog aborts it.
    let retries = 0
    for (let stall = 0; stall < MAX_TRANSFER_RETRIES * 3; stall++) {
      expect(shouldAutoResume(failed(retries))).toBe(true)
      retries++ // maybeAutoResume
      retries = retriesAfterFailure(retries, 5 * 1024 * 1024, true) // the abort path credits kept bytes
    }
    expect(retries).toBe(0)
  })

  it('stalls that never get a byte through still run out (bounded)', () => {
    let retries = 0
    let fired = 0
    while (shouldAutoResume(failed(retries))) {
      retries = retriesAfterFailure(retries + 1, 0, true)
      fired++
    }
    expect(fired).toBe(MAX_TRANSFER_RETRIES)
  })
})
