import { describe, it, expect, beforeEach } from 'vitest'
import {
  applyJoin,
  approvalTicket,
  approveWithTicket,
  bind,
  cleanJoinName,
  createHostIdentity,
  decideFrame,
  decideJoin,
  departConnection,
  departedOverflow,
  forget,
  isApproved,
  markApproved,
  MAX_DEPARTED_ROWS,
  MAX_PARTICIPANT_ID_LENGTH,
  MAX_PENDING_REQUESTS,
  openConnection,
  pendingCount,
  releaseConnection,
  resetHostIdentity,
  ticketValid,
  type HostIdentity,
} from '@/lib/host/identity'

const ALICE = 'alice-id'
const ALICE_GRANT = 'alice-grant-0123456789ab'
const MALLORY = 'mallory-id'
const MALLORY_GRANT = 'mallory-grant-0123456789'

/** A fresh identity with the connections these tests use already opened (native "open"). */
function opened(): HostIdentity {
  const s = createHostIdentity()
  for (const c of ['c1', 'c2', 'c3', 'c5', 'c7', 'c9']) openConnection(s, c)
  return s
}

function join(s: HostIdentity, conn: string, id: string, grant: string) {
  const d = decideJoin(s, conn, id, grant)
  applyJoin(s, conn, id, grant, d)
  return d
}

describe('host identity — join', () => {
  let s: HostIdentity
  beforeEach(() => {
    s = opened()
  })

  it('a first join is a request and binds the connection', () => {
    expect(join(s, 'c1', ALICE, ALICE_GRANT)).toEqual({ kind: 'request', supersedes: undefined })
    expect(s.grants.get(ALICE)).toBe(ALICE_GRANT)
    expect(s.idOf.get('c1')).toBe(ALICE)
    expect(isApproved(s, ALICE)).toBe(false)
  })

  it('rejects the reserved host id and empty ids', () => {
    expect(decideJoin(s, 'c1', 'host', ALICE_GRANT)).toEqual({ kind: 'reject', reason: 'bad-id' })
    expect(decideJoin(s, 'c1', '', ALICE_GRANT)).toEqual({ kind: 'reject', reason: 'bad-id' })
  })

  it('a forged join for an existing id with a different grant is rejected and changes nothing', () => {
    join(s, 'c1', ALICE, ALICE_GRANT)
    markApproved(s, ALICE)
    const d = join(s, 'c2', ALICE, MALLORY_GRANT)
    expect(d).toEqual({ kind: 'reject', reason: 'grant-mismatch' })
    expect(s.grants.get(ALICE)).toBe(ALICE_GRANT)
    expect(isApproved(s, ALICE)).toBe(true)
    expect(s.connOf.get(ALICE)).toBe('c1')
    expect(s.idOf.has('c2')).toBe(false)
  })

  it('a connection cannot join as a second identity', () => {
    join(s, 'c1', MALLORY, MALLORY_GRANT)
    expect(decideJoin(s, 'c1', ALICE, ALICE_GRANT)).toEqual({ kind: 'reject', reason: 'conn-is-someone-else' })
  })

  it('a pending guest re-joining with its own grant on a new socket stays a request', () => {
    join(s, 'c1', ALICE, ALICE_GRANT)
    expect(join(s, 'c2', ALICE, ALICE_GRANT)).toEqual({ kind: 'request', supersedes: 'c1' })
    expect(s.connOf.get(ALICE)).toBe('c2')
    expect(s.idOf.has('c1')).toBe(false)
  })

  it('an approved guest re-joining with its grant resumes (approval kept)', () => {
    join(s, 'c1', ALICE, ALICE_GRANT)
    markApproved(s, ALICE)
    releaseConnection(s, 'c1')
    expect(join(s, 'c2', ALICE, ALICE_GRANT)).toEqual({ kind: 'resume', supersedes: undefined })
    expect(isApproved(s, ALICE)).toBe(true)
  })
})

describe('host identity — frames', () => {
  let s: HostIdentity
  beforeEach(() => {
    s = opened()
    join(s, 'c1', ALICE, ALICE_GRANT)
  })

  it('accepts a grant-proven frame from the bound, approved connection', () => {
    markApproved(s, ALICE)
    expect(decideFrame(s, 'c1', ALICE, ALICE_GRANT, true)).toEqual({ kind: 'accept', bind: false })
  })

  it('rejects a wrong or missing grant', () => {
    markApproved(s, ALICE)
    expect(decideFrame(s, 'c1', ALICE, 'nope', true).kind).toBe('reject')
    expect(decideFrame(s, 'c1', ALICE, undefined, true).kind).toBe('reject')
    expect(decideFrame(s, 'c1', 42, ALICE_GRANT, true).kind).toBe('reject')
    expect(decideFrame(s, 'c1', 'host', ALICE_GRANT, true).kind).toBe('reject')
  })

  it('a spoofed id from another bound connection is rejected even with the right grant', () => {
    markApproved(s, ALICE)
    join(s, 'c9', MALLORY, MALLORY_GRANT)
    markApproved(s, MALLORY)
    expect(decideFrame(s, 'c9', ALICE, ALICE_GRANT, true)).toEqual({ kind: 'reject', reason: 'conn-is-someone-else' })
    // ...and without the grant it never gets that far.
    expect(decideFrame(s, 'c9', ALICE, MALLORY_GRANT, true)).toEqual({ kind: 'reject', reason: 'grant-mismatch' })
  })

  it('a pending guest cannot heartbeat / chat, but may leave', () => {
    expect(decideFrame(s, 'c1', ALICE, ALICE_GRANT, true)).toEqual({ kind: 'reject', reason: 'not-approved' })
    expect(decideFrame(s, 'c1', ALICE, ALICE_GRANT, false)).toEqual({ kind: 'accept', bind: false })
  })

  it('a never-approved guest that dropped cannot promote itself with a heartbeat on reconnect', () => {
    expect(releaseConnection(s, 'c1')).toBe(ALICE) // row → left, grant retained
    expect(decideFrame(s, 'c2', ALICE, ALICE_GRANT, true)).toEqual({ kind: 'reject', reason: 'not-approved' })
    expect(s.idOf.has('c2')).toBe(false)
  })

  it('an approved guest that dropped resumes silently on its first grant-proven frame', () => {
    markApproved(s, ALICE)
    releaseConnection(s, 'c1')
    const d = decideFrame(s, 'c2', ALICE, ALICE_GRANT, true)
    expect(d).toEqual({ kind: 'accept', bind: true, supersedes: undefined })
    bind(s, 'c2', ALICE)
    expect(decideFrame(s, 'c2', ALICE, ALICE_GRANT, true)).toEqual({ kind: 'accept', bind: false })
  })

  it('an approved reconnect takes over from a half-open old socket', () => {
    markApproved(s, ALICE)
    const d = decideFrame(s, 'c2', ALICE, ALICE_GRANT, true)
    expect(d).toEqual({ kind: 'accept', bind: true, supersedes: 'c1' })
    bind(s, 'c2', ALICE)
    // The superseded socket is no longer live: a delayed frame from it can't take Alice back (which
    // would also drop her live replacement), and its eventual close speaks for no one.
    expect(decideFrame(s, 'c1', ALICE, ALICE_GRANT, true)).toEqual({ kind: 'reject', reason: 'not-live' })
    expect(decideJoin(s, 'c1', ALICE, ALICE_GRANT)).toEqual({ kind: 'reject', reason: 'not-live' })
    expect(releaseConnection(s, 'c1')).toBeNull()
    expect(s.connOf.get(ALICE)).toBe('c2')
  })

  it('a frame delivered after its connection closed cannot bind the dead socket', () => {
    markApproved(s, ALICE)
    releaseConnection(s, 'c1')
    expect(decideFrame(s, 'c1', ALICE, ALICE_GRANT, true)).toEqual({ kind: 'reject', reason: 'not-live' })
    // A socket that closed before ever joining is gone too.
    releaseConnection(s, 'c7')
    expect(decideJoin(s, 'c7', MALLORY, MALLORY_GRANT)).toEqual({ kind: 'reject', reason: 'not-live' })
  })

  it('a connection that was never opened cannot join or act', () => {
    expect(decideJoin(s, 'c-never', MALLORY, MALLORY_GRANT)).toEqual({ kind: 'reject', reason: 'not-live' })
    markApproved(s, ALICE)
    expect(decideFrame(s, 'c-never', ALICE, ALICE_GRANT, true)).toEqual({ kind: 'reject', reason: 'not-live' })
  })

  it('connection churn does not accumulate state (memory bounded by open sockets)', () => {
    for (let i = 0; i < 1000; i++) {
      const c = `churn-${i}`
      openConnection(s, c)
      releaseConnection(s, c)
    }
    expect(s.live.size).toBe(6) // just the opened() fixtures
    expect(s.idOf.size).toBe(1) // only Alice on c1
  })

  it("a left/denied guest's socket stops being live", () => {
    forget(s, ALICE)
    expect(decideJoin(s, 'c1', ALICE, ALICE_GRANT)).toEqual({ kind: 'reject', reason: 'not-live' })
  })

  it('approval is tied to the grant it was given for (stale approvals authorize nothing)', () => {
    markApproved(s, ALICE)
    s.grants.clear() // session boundary clears grants
    expect(isApproved(s, ALICE)).toBe(false)
    expect(join(s, 'c5', ALICE, MALLORY_GRANT)).toEqual({ kind: 'request', supersedes: 'c1' })
    expect(isApproved(s, ALICE)).toBe(false)
  })
})

describe('host identity — close attribution', () => {
  let s: HostIdentity
  beforeEach(() => {
    s = opened()
    join(s, 'c1', ALICE, ALICE_GRANT)
    markApproved(s, ALICE)
  })

  it('a close only affects the participant bound to that connection', () => {
    join(s, 'c2', MALLORY, MALLORY_GRANT)
    // Mallory's socket closing must not mark Alice left, whatever ids Mallory claimed.
    expect(releaseConnection(s, 'c2')).toBe(MALLORY)
    expect(s.connOf.get(ALICE)).toBe('c1')
    expect(releaseConnection(s, 'c1')).toBe(ALICE)
  })

  it('a connection that never joined closes as nobody', () => {
    expect(releaseConnection(s, 'c-unknown')).toBeNull()
  })

  it('close keeps grant + approval for a silent resume', () => {
    releaseConnection(s, 'c1')
    expect(s.grants.get(ALICE)).toBe(ALICE_GRANT)
    expect(isApproved(s, ALICE)).toBe(true)
  })

  it('forget drops grant, approval and binding and returns the connection', () => {
    expect(forget(s, ALICE)).toBe('c1')
    expect(s.grants.has(ALICE)).toBe(false)
    expect(isApproved(s, ALICE)).toBe(false)
    expect(s.idOf.has('c1')).toBe(false)
    expect(decideFrame(s, 'c1', ALICE, ALICE_GRANT, false).kind).toBe('reject')
  })

  it('reset clears approvals and bindings', () => {
    resetHostIdentity(s)
    expect(isApproved(s, ALICE)).toBe(false)
    expect(releaseConnection(s, 'c1')).toBeNull()
  })
})

describe('host identity — async approval tickets', () => {
  let s: HostIdentity
  beforeEach(() => {
    s = opened()
    join(s, 'c1', ALICE, ALICE_GRANT)
  })

  it('a ticket redeemed with nothing in between approves', () => {
    const t = approvalTicket(s, ALICE)!
    expect(approveWithTicket(s, t)).toBe(true)
    expect(isApproved(s, ALICE)).toBe(true)
  })

  it('deny before the approve continuation runs, then a same-grant rejoin: the stale ticket is void', () => {
    const t = approvalTicket(s, ALICE)! // host taps approve; native approve() in flight
    forget(s, ALICE) // host denies meanwhile
    join(s, 'c2', ALICE, ALICE_GRANT) // guest re-requests with the same id + grant
    expect(ticketValid(s, t)).toBe(false)
    expect(approveWithTicket(s, t)).toBe(false)
    expect(isApproved(s, ALICE)).toBe(false)
    // A fresh decision for the new request still works.
    expect(markApproved(s, ALICE)).toBe(true)
  })

  it('leave (forget) and a session reset void outstanding tickets', () => {
    const t1 = approvalTicket(s, ALICE)!
    resetHostIdentity(s)
    expect(approveWithTicket(s, t1)).toBe(false)
    openConnection(s, 'c3')
    expect(join(s, 'c3', ALICE, ALICE_GRANT).kind).toBe('request')
    const t2 = approvalTicket(s, ALICE)!
    forget(s, ALICE)
    expect(approveWithTicket(s, t2)).toBe(false)
  })

  it('no ticket for an unknown id or the host', () => {
    expect(approvalTicket(s, 'nobody')).toBeNull()
    expect(approvalTicket(s, 'host')).toBeNull()
  })
})

describe('host identity — bounded admission state', () => {
  let s: HostIdentity
  beforeEach(() => {
    s = opened()
  })

  it('rejects an over-long id before it is stored', () => {
    const long = 'x'.repeat(MAX_PARTICIPANT_ID_LENGTH + 1)
    expect(decideJoin(s, 'c1', long, ALICE_GRANT)).toEqual({ kind: 'reject', reason: 'bad-id' })
    expect(decideJoin(s, 'c1', 'x'.repeat(MAX_PARTICIPANT_ID_LENGTH), ALICE_GRANT).kind).toBe('request')
  })

  it('caps the number of requests waiting for a decision', () => {
    for (let i = 0; i < MAX_PENDING_REQUESTS; i++) {
      openConnection(s, `p${i}`)
      expect(join(s, `p${i}`, `guest-${i}`, `grant-${i}-0123456789abcdef`).kind).toBe('request')
    }
    expect(pendingCount(s)).toBe(MAX_PENDING_REQUESTS)
    openConnection(s, 'late')
    expect(decideJoin(s, 'late', 'late-id', 'late-grant-0123456789abc')).toEqual({ kind: 'reject', reason: 'too-many-pending' })
    // A pending requester re-joining on a new socket already holds its slot.
    openConnection(s, 'p0b')
    expect(decideJoin(s, 'p0b', 'guest-0', 'grant-0-0123456789abcdef').kind).toBe('request')
    // Approving one frees a slot.
    markApproved(s, 'guest-1')
    expect(decideJoin(s, 'late', 'late-id', 'late-grant-0123456789abc').kind).toBe('request')
  })

  it('a never-approved requester is forgotten when its socket closes', () => {
    join(s, 'c1', ALICE, ALICE_GRANT)
    expect(departConnection(s, 'c1')).toEqual({ id: ALICE, forgotten: true, grant: ALICE_GRANT })
    expect(s.grants.has(ALICE)).toBe(false)
    expect(s.gens.has(ALICE)).toBe(false)
    expect(pendingCount(s)).toBe(0)
    // It may ask again from a new socket.
    expect(join(s, 'c2', ALICE, ALICE_GRANT).kind).toBe('request')
  })

  it('an approved guest survives its socket closing (silent resume)', () => {
    join(s, 'c1', ALICE, ALICE_GRANT)
    markApproved(s, ALICE)
    expect(departConnection(s, 'c1')).toEqual({ id: ALICE, forgotten: false })
    expect(isApproved(s, ALICE)).toBe(true)
  })

  it('a superseded or never-bound connection departs as nobody', () => {
    expect(departConnection(s, 'c1')).toBeNull()
    join(s, 'c1', ALICE, ALICE_GRANT)
    join(s, 'c2', ALICE, ALICE_GRANT) // re-join on a new socket supersedes c1
    expect(departConnection(s, 'c1')).toBeNull()
    expect(s.grants.get(ALICE)).toBe(ALICE_GRANT)
  })

  it('join/disconnect churn by unapproved peers leaves nothing behind', () => {
    for (let i = 0; i < 500; i++) {
      const conn = `churn${i}`
      openConnection(s, conn)
      join(s, conn, `spam-${i}`, `spam-grant-${i}-0123456789`)
      departConnection(s, conn)
    }
    expect(s.grants.size).toBe(0)
    expect(s.gens.size).toBe(0)
    expect(s.connOf.size).toBe(0)
    expect(s.idOf.size).toBe(0)
  })

  it('a ticket issued before a forget-on-close is void after a same-grant re-join', () => {
    join(s, 'c1', ALICE, ALICE_GRANT)
    const t = approvalTicket(s, ALICE)!
    departConnection(s, 'c1')
    join(s, 'c2', ALICE, ALICE_GRANT)
    expect(approveWithTicket(s, t)).toBe(false)
  })

  it('cleans join names: collapses whitespace, trims, caps length', () => {
    expect(cleanJoinName('  Asha \n  K ')).toBe('Asha K')
    expect(cleanJoinName('   ')).toBe('')
    expect(cleanJoinName(42)).toBe('')
    expect(cleanJoinName('n'.repeat(500))).toHaveLength(40)
  })

  it('departedOverflow names the oldest departed rows beyond the cap', () => {
    const rows = [
      { id: 'host', status: 'left', lastBeatAt: 0 },
      { id: 'live', status: 'ready', lastBeatAt: 1 },
      ...Array.from({ length: MAX_DEPARTED_ROWS + 2 }, (_, i) => ({ id: `gone${i}`, status: 'left', lastBeatAt: 100 - i })),
    ]
    // The two with the oldest last heartbeat go; the host and live rows never do.
    expect(departedOverflow(rows).sort()).toEqual([`gone${MAX_DEPARTED_ROWS}`, `gone${MAX_DEPARTED_ROWS + 1}`].sort())
    expect(departedOverflow(rows.slice(0, 5))).toEqual([])
  })
})
