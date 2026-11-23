import { describe, it, expect, beforeEach } from 'vitest'
import {
  applyJoin,
  bind,
  createHostIdentity,
  decideFrame,
  decideJoin,
  forget,
  isApproved,
  markApproved,
  releaseConnection,
  resetHostIdentity,
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
    // The stale socket's frames and its eventual close no longer speak for Alice.
    expect(decideFrame(s, 'c1', ALICE, ALICE_GRANT, true).kind).toBe('accept') // c1 unbound + approved → would rebind
    expect(releaseConnection(s, 'c1')).toBeNull()
    expect(s.connOf.get(ALICE)).toBe('c2')
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
