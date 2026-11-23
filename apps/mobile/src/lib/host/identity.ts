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
 */

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
  /** participant id → bumped whenever the id is forgotten (leave/deny), voiding its tickets. */
  epochs: Map<string, number>
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
    epochs: new Map(),
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
  s.epochs.clear()
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

export type Rejection = 'bad-id' | 'grant-mismatch' | 'conn-is-someone-else' | 'not-approved' | 'not-live'

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
  if (id.length === 0 || id === HOST_ID) return { kind: 'reject', reason: 'bad-id' }
  if (!s.live.has(conn)) return { kind: 'reject', reason: 'not-live' }
  const bound = s.idOf.get(conn)
  if (bound !== undefined && bound !== id) return { kind: 'reject', reason: 'conn-is-someone-else' }
  const stored = s.grants.get(id)
  // A join can only (re)claim an id with the grant it already holds — otherwise anyone who saw
  // an id in the roster could reset that guest to "requested" and steal its approval.
  if (stored !== undefined && stored !== grant) return { kind: 'reject', reason: 'grant-mismatch' }
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
  s.grants.set(id, grant)
  bind(s, conn, id)
}

export type ApprovalTicket = { id: string; grant: string; epoch: number; session: number }

/** Start approving `id`'s current request; null if there is none. */
export function approvalTicket(s: HostIdentity, id: string): ApprovalTicket | null {
  const grant = s.grants.get(id)
  if (grant === undefined || id === HOST_ID) return null
  return { id, grant, epoch: s.epochs.get(id) ?? 0, session: s.session }
}

/** Is the request this ticket was issued for still the live one (no deny/leave/reset since)? */
export function ticketValid(s: HostIdentity, t: ApprovalTicket): boolean {
  return t.session === s.session && (s.epochs.get(t.id) ?? 0) === t.epoch && s.grants.get(t.id) === t.grant
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
  s.epochs.set(id, ++s.seq)
  return conn
}
