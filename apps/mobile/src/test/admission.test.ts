import { describe, it, expect } from 'vitest'
import {
  admission,
  inviteRosterLine,
  joinRequestHeadline,
  listNames,
  lobbyCtaLabel,
  startWithoutCopy,
  startWithoutSheetVisible,
  startWithoutVerdict,
} from '@/lib/host/admission'
import { decideStartGate } from '@/lib/sync/startGate'
import { bucketRoster } from '@/lib/sync/readiness'
import type { ParticipantStatus } from '@/lib/protocol/session'

const p = (id: string, status: ParticipantStatus, name = id) => ({ id, name, status, progress: status === 'ready' ? 1 : 0 })

describe('admission', () => {
  it('separates the door from the cabin (the audit case: three pending, none aboard)', () => {
    const people = [p('host', 'ready'), p('a', 'requested'), p('b', 'requested'), p('c', 'requested')]
    const a = admission(people)
    expect(a.pending.map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(a.admitted).toHaveLength(0)
    expect(inviteRosterLine({ pending: a.pending.length, admitted: a.admitted.length })).toBe('3 waiting for approval')
    expect(lobbyCtaLabel(a.pending.length)).toBe('Review 3 requests')
  })

  it('counts admitted guests in any boarding state, never the host or those who left', () => {
    const people = [p('host', 'ready'), p('a', 'approved'), p('b', 'downloading'), p('c', 'ready'), p('d', 'left'), p('e', 'requested')]
    const a = admission(people)
    expect(a.admitted.map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(a.pending.map((x) => x.id)).toEqual(['e'])
  })

  it('agrees with the lobby buckets and the start gate (requests are never aboard)', () => {
    const people = [p('host', 'ready'), p('a', 'ready'), p('b', 'requested')]
    const a = admission(people)
    const buckets = bucketRoster(people)
    expect(a.pending).toEqual(buckets.wantsIn)
    expect(a.admitted).toEqual(buckets.gateRoster)
    // the gate opens without the requester — which is exactly why the Lobby must ask first
    const gate = decideStartGate(
      buckets.gateRoster.map((x) => ({ ...x, downloadMbps: 0, positionSec: 0 })),
      { sizeBytes: 1e9, durationSec: 3600, precacheOnly: false },
    )
    expect(gate.start).toBe(true)
    expect(a.pending).toHaveLength(1)
  })
})

describe('inviteRosterLine', () => {
  it('reports aboard and waiting separately', () => {
    expect(inviteRosterLine({ pending: 0, admitted: 0 })).toBe('Waiting for guests…')
    expect(inviteRosterLine({ pending: 0, admitted: 2 })).toBe('2 aboard')
    expect(inviteRosterLine({ pending: 1, admitted: 2 })).toBe('2 aboard · 1 waiting for approval')
  })
})

describe('lobbyCtaLabel', () => {
  it('turns into a review action while anyone is at the door', () => {
    expect(lobbyCtaLabel(0)).toBe('Open lobby')
    expect(lobbyCtaLabel(1)).toBe('Review 1 request')
    expect(lobbyCtaLabel(4)).toBe('Review 4 requests')
  })
})

describe('listNames', () => {
  it('reads naturally and stays short', () => {
    expect(listNames([])).toBe('')
    expect(listNames(['Sam'])).toBe('Sam')
    expect(listNames(['Sam', 'Alex'])).toBe('Sam and Alex')
    expect(listNames(['Sam', 'Alex', 'Jo'])).toBe('Sam, Alex and Jo')
    expect(listNames(['Sam', 'Alex', 'Jo', 'Ria', 'Lee'])).toBe('Sam, Alex and 3 others')
  })
})

describe('startWithoutCopy', () => {
  it('names who stays outside', () => {
    expect(startWithoutCopy(['Sam']).title).toBe('Start without Sam?')
    expect(startWithoutCopy(['Sam']).body).toMatch(/^Sam is still waiting/)
    expect(startWithoutCopy(['Sam', 'Alex']).title).toBe('Start without Sam and Alex?')
    expect(startWithoutCopy(['Sam', 'Alex']).body).toMatch(/^They're still waiting/)
  })
})

describe('joinRequestHeadline', () => {
  it('leads with the oldest request and counts the rest', () => {
    expect(joinRequestHeadline(['Sam'])).toEqual({ name: 'Sam', detail: 'wants to board' })
    expect(joinRequestHeadline(['Sam', 'Alex', 'Jo'])).toEqual({ name: 'Sam', detail: 'wants to board · 2 more waiting' })
  })
})

describe('start without — revalidated', () => {
  it('starts on confirm only while the gate is still open', () => {
    expect(startWithoutVerdict({ gateOpen: true, pending: 2 })).toBe('start')
    expect(startWithoutVerdict({ gateOpen: false, pending: 2 })).toBe('close')
  })

  it('withdraws the sheet when the gate closes or the door empties', () => {
    expect(startWithoutSheetVisible({ asked: true, gateOpen: true, pending: 1 })).toBe(true)
    expect(startWithoutSheetVisible({ asked: true, gateOpen: false, pending: 1 })).toBe(false)
    expect(startWithoutSheetVisible({ asked: true, gateOpen: true, pending: 0 })).toBe(false)
    expect(startWithoutSheetVisible({ asked: false, gateOpen: true, pending: 1 })).toBe(false)
  })
})
