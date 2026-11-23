import { describe, it, expect, beforeEach } from 'vitest'
import {
  applyJoin,
  approvalTicket,
  approveWithTicket,
  bind,
  createHostIdentity,
  decideFrame,
  decideJoin,
  forget,
  isApproved,
  markApproved,
  releaseConnection,
  resetHostIdentity,
  ticketValid,
  type HostIdentity,
} from '@/lib/host/identity'

const ALICE = 'alice-id'
const ALICE_GRANT = 'alice-grant-0123456789ab'
const MALLORY = 'mallory-id'
const MALLORY_GRANT = 'mallory-grant-0123456789'

function join(s: HostIdentity, conn: string, id: string, grant: string) {
  const d = decideJoin(s, conn, id, grant)
  applyJoin(s, conn, id, grant, d)
  return d
}

describe('host identity — join', () => {
  let s: HostIdentity
  beforeEach(() => {
    s = createHostIdentity()
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
    s = createHostIdentity()
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
    // The superseded socket is retired: a delayed frame from it can't take Alice back (which
    // would also drop her live replacement), and its eventual close speaks for no one.
    expect(decideFrame(s, 'c1', ALICE, ALICE_GRANT, true)).toEqual({ kind: 'reject', reason: 'retired' })
    expect(decideJoin(s, 'c1', ALICE, ALICE_GRANT)).toEqual({ kind: 'reject', reason: 'retired' })
    expect(releaseConnection(s, 'c1')).toBeNull()
    expect(s.connOf.get(ALICE)).toBe('c2')
  })

  it('a frame delivered after its connection closed cannot bind the dead socket', () => {
    markApproved(s, ALICE)
    releaseConnection(s, 'c1')
    expect(decideFrame(s, 'c1', ALICE, ALICE_GRANT, true)).toEqual({ kind: 'reject', reason: 'retired' })
    // An unknown socket that closed before ever joining is retired too.
    releaseConnection(s, 'c7')
    expect(decideJoin(s, 'c7', MALLORY, MALLORY_GRANT)).toEqual({ kind: 'reject', reason: 'retired' })
  })

  it("a left/denied guest's socket is retired", () => {
    forget(s, ALICE)
    expect(decideJoin(s, 'c1', ALICE, ALICE_GRANT)).toEqual({ kind: 'reject', reason: 'retired' })
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
    s = createHostIdentity()
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
    s = createHostIdentity()
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
    join(s, 'c3', ALICE, ALICE_GRANT)
    const t2 = approvalTicket(s, ALICE)!
    forget(s, ALICE)
    expect(approveWithTicket(s, t2)).toBe(false)
  })

  it('no ticket for an unknown id or the host', () => {
    expect(approvalTicket(s, 'nobody')).toBeNull()
    expect(approvalTicket(s, 'host')).toBeNull()
  })
})
