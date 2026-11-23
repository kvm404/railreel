import { describe, it, expect } from 'vitest'
import {
  isTransferStalled,
  MAX_TRANSFER_RETRIES,
  resumeOffset,
  shouldAutoResume,
  transferResultOk,
  transferRetryDelayMs,
  TRANSFER_STALL_MS,
  earnsRetryBudget,
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
  it('flags a running transfer with no progress past the window', () => {
    expect(isTransferStalled(true, 1000, 1000 + TRANSFER_STALL_MS)).toBe(true)
    expect(isTransferStalled(true, 1000, 1000 + TRANSFER_STALL_MS - 1)).toBe(false)
  })

  it('never flags an idle transfer or one with no progress sample yet', () => {
    expect(isTransferStalled(false, 1000, 99_999)).toBe(false)
    expect(isTransferStalled(true, 0, 99_999)).toBe(false)
  })

  it('stays under the proxy edge timeout (30s) and over a hotspot hiccup', () => {
    expect(TRANSFER_STALL_MS).toBeLessThan(30_000)
    expect(TRANSFER_STALL_MS).toBeGreaterThanOrEqual(5000)
    expect(isTransferStalled(true, 1000, 3000, 2000)).toBe(true) // custom window
  })
})

describe('earnsRetryBudget', () => {
  it('only real forward progress earns the budget back (never a mere WS reconnect)', () => {
    expect(earnsRetryBudget(0)).toBe(false)
    expect(earnsRetryBudget(MEANINGFUL_PROGRESS_BYTES - 1)).toBe(false)
    expect(earnsRetryBudget(MEANINGFUL_PROGRESS_BYTES)).toBe(true)
    expect(earnsRetryBudget(NaN)).toBe(false)
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
