import { describe, it, expect } from 'vitest'
import { friendlyJoinError } from '@/lib/errors/friendly'
import { VERSION_MISMATCH_MESSAGE } from '@/lib/protocol'

describe('friendlyJoinError', () => {
  it('says nothing for no error', () => {
    expect(friendlyJoinError(null)).toBeNull()
    expect(friendlyJoinError(undefined)).toBeNull()
    expect(friendlyJoinError('  ')).toBeNull()
  })

  it('turns a socket failure into hotspot guidance and keeps the raw line as detail', () => {
    const e = friendlyJoinError('Error: WebSocket error')
    expect(e?.message).toMatch(/Couldn't reach the host.*hotspot/)
    expect(e?.detail).toBe('WebSocket error')
  })

  it('explains a sync timeout', () => {
    const e = friendlyJoinError('Error: sync timed out')
    expect(e?.message).toMatch(/didn't answer/)
    expect(e?.detail).toBe('sync timed out')
  })

  it('explains a host-closed socket differently from an unreachable one', () => {
    const closed = friendlyJoinError('Error: WebSocket closed')
    const unreachable = friendlyJoinError('Error: WebSocket error')
    expect(closed?.message).toMatch(/closed the connection/)
    expect(closed?.message).not.toBe(unreachable?.message)
  })

  it('passes the version-mismatch sentence through untouched, with no technical detail', () => {
    expect(friendlyJoinError(VERSION_MISMATCH_MESSAGE)).toEqual({ message: VERSION_MISMATCH_MESSAGE, detail: null })
  })

  it('rewrites a bad link', () => {
    const e = friendlyJoinError('Bad join link: Error: missing host')
    expect(e?.message).toMatch(/invite/i)
    expect(e?.detail).toContain('Bad join link')
  })

  it('falls back to actionable generic guidance for anything unknown', () => {
    const e = friendlyJoinError('TypeError: undefined is not a function')
    expect(e?.message).toMatch(/Couldn't join/)
    expect(e?.detail).toBe('undefined is not a function')
  })
})
