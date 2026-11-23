/**
 * Host-side identity + admission bookkeeping (pure, no IO).
 *
 * The native control socket gives every accepted connection an opaque `conn` id and tags every
 * frame/close with it. A client's self-assigned participant `id` is NOT trusted on its own: it is
 * bound to the connection that proved it (a valid `join`, or a grant-proven frame from an
 * approved participant reconnecting), and from then on:
 *  - a connection speaks for exactly one participant — frames claiming any other id are dropped;
 *  - a socket close only affects the participant bound to THAT connection;
 *  - a `join` for an id that already holds a grant must present the same grant (no hijack).
 *
 * Approval is tracked separately from the roster row's connection status: a row can be `left`
 * (socket gone) yet still approved (resume silently on reconnect), or `left` and never approved
 * (a reconnect must not promote it). Approval is keyed to the grant it was given for, so a stale
 * entry (grants cleared at a session boundary) can never authorize anything.
 *
 * Only LIVE connections may act: opened, and not since closed, superseded by a reconnect, or tied
 * to a guest who left / was denied. Leaving the live set is permanent — native emits a
 * connection's "open" strictly before its "close" and never reuses an id — so a late frame from a
 * dead or replaced socket can't take the identity back, and memory is bounded by the sockets
 * actually open rather than every connection ever seen.
 *
 * The host's approve() is async (native grant first), so it holds an approval TICKET that deny /
 * leave / reset invalidate — a stale continuation can't re-approve.
 *
 * Memory is bounded by what an unapproved peer can make the host keep: ids and names have a
 * length cap, at most MAX_PENDING_REQUESTS requests wait at once, and a requester that was never
 * approved is forgotten entirely when its socket closes (it simply asks again on reconnect).
 * Only approved guests survive a close (silent resume), and the roster keeps at most
 * MAX_DEPARTED_ROWS of them (departedOverflow).
 */

/** Longest participant id accepted (real ids are ~12 base64url chars). */
export const MAX_PARTICIPANT_ID_LENGTH = 64
/** Display names are cut to this many characters. */
export const MAX_PARTICIPANT_NAME_LENGTH = 40
/** Join requests that may wait for the host's decision at once (a cabin seats 4–6). */
export const MAX_PENDING_REQUESTS = 12
/** Approved guests whose socket is gone that the roster keeps for a silent resume. */
export const MAX_DEPARTED_ROWS = 16

export type HostIdentity = {
  /** participant id → the grant it joined with (the secret proving the id). */
  grants: Map<string, string>
  /** participant id → the grant that was approved. Valid only while it equals `grants.get(id)`. */
  approved: Map<string, string>
  /** participant id → the connection currently speaking for it. */
  connOf: Map<string, string>
  /** connection id → the participant it speaks for. */
  idOf: Map<string, string>
  /** Connections that are open and still allowed to act (see the module doc). */
  live: Set<string>
  /**
   * participant id → generation of the grant it holds, fresh (from `seq`) whenever a grant is
   * first stored. Forgetting an id deletes it, so a same-grant re-join gets a NEW generation and
   * every ticket issued before is void — without remembering forgotten ids forever.
   */
  gens: Map<string, number>
  /** Bumped on every reset (session boundary), voiding every ticket. */
  session: number
  seq: number
}

export const HOST_ID = 'host'

export function createHostIdentity(grants: Map<string, string> = new Map()): HostIdentity {
  return {
    grants,
    approved: new Map(),
    connOf: new Map(),
    idOf: new Map(),
    live: new Set(),
    gens: new Map(),
    session: 0,
    seq: 0,
  }
}

/** Forget approvals + bindings (session boundary). Grants are owned by the caller's lifecycle. */
export function resetHostIdentity(s: HostIdentity): void {
  s.approved.clear()
  s.connOf.clear()
  s.idOf.clear()
  s.live.clear()
  s.gens.clear()
  s.session++
}

export function isApproved(s: HostIdentity, id: string): boolean {
  const g = s.grants.get(id)
  return g !== undefined && s.approved.get(id) === g
}

function grantMatches(s: HostIdentity, id: unknown, grant: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id !== HOST_ID &&
    typeof grant === 'string' &&
    s.grants.get(id) === grant
  )
}

export type Rejection =
  | 'bad-id'
  | 'grant-mismatch'
  | 'conn-is-someone-else'
  | 'not-approved'
  | 'not-live'
  | 'too-many-pending'

/** Requests currently waiting for a decision (a grant with no approval for it). */
export function pendingCount(s: HostIdentity): number {
  let n = 0
  for (const id of s.grants.keys()) if (!isApproved(s, id)) n++
  return n
}

/** A join's display name, normalised and bounded; '' means "no usable name" (reject the join). */
export function cleanJoinName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_PARTICIPANT_NAME_LENGTH)
}

export type JoinDecision =
  | { kind: 'reject'; reason: Rejection }
  /** First (or still-pending) request: store the grant, bind, row → requested. */
  | { kind: 'request'; supersedes?: string }
  /** Already approved with this same grant (missed the decision): re-send approval, keep the row. */
  | { kind: 'resume'; supersedes?: string }

/**
 * Decide a shape-validated `join` arriving on `conn`. `supersedes` is a previous connection that
 * was bound to this id and should be dropped once the new binding is applied.
 */
export function decideJoin(s: HostIdentity, conn: string, id: string, grant: string): JoinDecision {
  if (id.length === 0 || id.length > MAX_PARTICIPANT_ID_LENGTH || id === HOST_ID) return { kind: 'reject', reason: 'bad-id' }
  if (!s.live.has(conn)) return { kind: 'reject', reason: 'not-live' }
  const bound = s.idOf.get(conn)
  if (bound !== undefined && bound !== id) return { kind: 'reject', reason: 'conn-is-someone-else' }
  const stored = s.grants.get(id)
  // A join can only (re)claim an id with the grant it already holds — otherwise anyone who saw
  // an id in the roster could reset that guest to "requested" and steal its approval.
  if (stored !== undefined && stored !== grant) return { kind: 'reject', reason: 'grant-mismatch' }
  // A NEW requester needs a free slot; a pending one re-joining (same grant) already holds one.
  if (stored === undefined && pendingCount(s) >= MAX_PENDING_REQUESTS) return { kind: 'reject', reason: 'too-many-pending' }
  const prev = s.connOf.get(id)
  const supersedes = prev !== undefined && prev !== conn ? prev : undefined
  return isApproved(s, id) ? { kind: 'resume', supersedes } : { kind: 'request', supersedes }
}

export type FrameDecision = { kind: 'reject'; reason: Rejection } | { kind: 'accept'; bind: boolean; supersedes?: string }

/**
 * Decide whether a grant-carrying frame on `conn` may act for `id`. `needsApproval` is true for
 * everything a guest can only do once admitted (heartbeat, ready, chat, reaction, playback
 * requests); false for `leave` (a pending requester may withdraw).
 *
 * An unbound live connection may take over an APPROVED id by proving its grant: that is the
 * silent reconnect path (the old socket may still be half-open until its read timeout; the
 * takeover removes it from the live set). A pending id can only be (re)bound by a `join`.
 */
export function decideFrame(
  s: HostIdentity,
  conn: string,
  id: unknown,
  grant: unknown,
  needsApproval: boolean,
): FrameDecision {
  if (!s.live.has(conn)) return { kind: 'reject', reason: 'not-live' }
  if (!grantMatches(s, id, grant)) return { kind: 'reject', reason: 'grant-mismatch' }
  const bound = s.idOf.get(conn)
  if (bound !== undefined) {
    if (bound !== id) return { kind: 'reject', reason: 'conn-is-someone-else' }
    if (needsApproval && !isApproved(s, id)) return { kind: 'reject', reason: 'not-approved' }
    return { kind: 'accept', bind: false }
  }
  if (!isApproved(s, id)) return { kind: 'reject', reason: 'not-approved' }
  const prev = s.connOf.get(id)
  return { kind: 'accept', bind: true, supersedes: prev !== undefined && prev !== conn ? prev : undefined }
}

/** Apply an accepted join: store the grant, bind the connection. A fresh request starts unapproved. */
export function applyJoin(s: HostIdentity, conn: string, id: string, grant: string, d: JoinDecision): void {
  if (d.kind === 'reject') return
  if (d.kind === 'request') s.approved.delete(id)
  if (s.grants.get(id) === undefined || !s.gens.has(id)) s.gens.set(id, ++s.seq)
  s.grants.set(id, grant)
  bind(s, conn, id)
}

export type ApprovalTicket = { id: string; grant: string; gen: number; session: number }

/** Start approving `id`'s current request; null if there is none. */
export function approvalTicket(s: HostIdentity, id: string): ApprovalTicket | null {
  const grant = s.grants.get(id)
  if (grant === undefined || id === HOST_ID) return null
  let gen = s.gens.get(id)
  if (gen === undefined) s.gens.set(id, (gen = ++s.seq)) // a grant stored outside applyJoin
  return { id, grant, gen, session: s.session }
}

/** Is the request this ticket was issued for still the live one (no deny/leave/reset since)? */
export function ticketValid(s: HostIdentity, t: ApprovalTicket): boolean {
  return t.session === s.session && s.gens.get(t.id) === t.gen && s.grants.get(t.id) === t.grant
}

/** Record the approval — only if its ticket is still valid. */
export function approveWithTicket(s: HostIdentity, t: ApprovalTicket): boolean {
  if (!ticketValid(s, t)) return false
  s.approved.set(t.id, t.grant)
  return true
}

/** Synchronous approval of `id`'s current request (ticket issued and redeemed at once). */
export function markApproved(s: HostIdentity, id: string): boolean {
  const t = approvalTicket(s, id)
  return t !== null && approveWithTicket(s, t)
}

/** Bind `id` to `conn`; a connection previously bound to it stops being live. */
export function bind(s: HostIdentity, conn: string, id: string): void {
  const prev = s.connOf.get(id)
  if (prev !== undefined && prev !== conn) {
    s.idOf.delete(prev)
    s.live.delete(prev)
  }
  s.connOf.set(id, conn)
  s.idOf.set(conn, id)
}

/** A connection opened (native "open" event): it may now join / resume. */
export function openConnection(s: HostIdentity, conn: string): void {
  s.live.add(conn)
}

/**
 * A connection closed: drop it from the live set, unbind it and return the participant it spoke for (to mark
 * `left`), or null when it spoke for no one (never joined, or superseded by a reconnect). Grant +
 * approval are kept so the guest can resume on a NEW connection.
 */
export function releaseConnection(s: HostIdentity, conn: string): string | null {
  s.live.delete(conn) // a frame delivered after the close must not bind a dead socket
  const id = s.idOf.get(conn)
  if (id === undefined) return null
  s.idOf.delete(conn)
  if (s.connOf.get(id) === conn) s.connOf.delete(id)
  return id
}

/** Drop everything about `id` (leave / deny) and void its approval tickets. Returns its connection. */
export function forget(s: HostIdentity, id: string): string | undefined {
  const conn = s.connOf.get(id)
  if (conn !== undefined) {
    s.idOf.delete(conn)
    s.live.delete(conn)
  }
  s.connOf.delete(id)
  s.approved.delete(id)
  s.grants.delete(id)
  s.gens.delete(id)
  return conn
}

export type Departure =
  /** Approved: keep grant + approval (silent resume); the row becomes `left`. */
  | { id: string; forgotten: false }
  /** Never approved: forgotten entirely — revoke `grant` natively and drop the row. */
  | { id: string; forgotten: true; grant: string | undefined }

/**
 * A connection closed (see releaseConnection). A requester that was never approved is forgotten
 * on the spot: otherwise every connect-join-disconnect would leave a row + grant behind that
 * enlarges every later roster broadcast. It re-asks with a fresh join if it comes back.
 */
export function departConnection(s: HostIdentity, conn: string): Departure | null {
  const id = releaseConnection(s, conn)
  if (id === null) return null
  if (isApproved(s, id)) return { id, forgotten: false }
  const grant = s.grants.get(id)
  forget(s, id)
  return { id, forgotten: true, grant }
}

/**
 * Departed (`left`) roster rows beyond `cap`, oldest last-heartbeat first: these should be
 * forgotten (grant revoked, row dropped) so a long session's churn can't grow the roster forever.
 */
export function departedOverflow(
  rows: readonly { id: string; status: string; lastBeatAt: number }[],
  cap = MAX_DEPARTED_ROWS,
): string[] {
  const left = rows.filter((r) => r.status === 'left' && r.id !== HOST_ID)
  if (left.length <= cap) return []
  return [...left]
    .sort((a, b) => a.lastBeatAt - b.lastBeatAt)
    .slice(0, left.length - cap)
    .map((r) => r.id)
}
