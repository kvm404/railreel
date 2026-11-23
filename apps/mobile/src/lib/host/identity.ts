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
}

export const HOST_ID = 'host'

export function createHostIdentity(grants: Map<string, string> = new Map()): HostIdentity {
  return { grants, approved: new Map(), connOf: new Map(), idOf: new Map() }
}

/** Forget approvals + bindings (session boundary). Grants are owned by the caller's lifecycle. */
export function resetHostIdentity(s: HostIdentity): void {
  s.approved.clear()
  s.connOf.clear()
  s.idOf.clear()
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

export type Rejection = 'bad-id' | 'grant-mismatch' | 'conn-is-someone-else' | 'not-approved'

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
 * An unbound connection may take over an APPROVED id by proving its grant: that is the silent
 * reconnect path (the old socket may still be half-open until its read timeout). A pending id can
 * only be (re)bound by a `join`.
 */
export function decideFrame(
  s: HostIdentity,
  conn: string,
  id: unknown,
  grant: unknown,
  needsApproval: boolean,
): FrameDecision {
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

/** Record the host's approval of `id` (for the grant it currently holds). False if unknown. */
export function markApproved(s: HostIdentity, id: string): boolean {
  const g = s.grants.get(id)
  if (g === undefined) return false
  s.approved.set(id, g)
  return true
}

/** Bind `id` to `conn`, releasing any connection previously bound to it. */
export function bind(s: HostIdentity, conn: string, id: string): void {
  const prev = s.connOf.get(id)
  if (prev !== undefined && prev !== conn) s.idOf.delete(prev)
  s.connOf.set(id, conn)
  s.idOf.set(conn, id)
}

/**
 * A connection closed: unbind it and return the participant it spoke for (to mark `left`), or
 * null when it spoke for no one (never joined, or superseded by a reconnect). Grant + approval
 * are kept so the guest can resume.
 */
export function releaseConnection(s: HostIdentity, conn: string): string | null {
  const id = s.idOf.get(conn)
  if (id === undefined) return null
  s.idOf.delete(conn)
  if (s.connOf.get(id) === conn) s.connOf.delete(id)
  return id
}

/** Drop everything about `id` (leave / deny). Returns its bound connection, if any. */
export function forget(s: HostIdentity, id: string): string | undefined {
  const conn = s.connOf.get(id)
  if (conn !== undefined) s.idOf.delete(conn)
  s.connOf.delete(id)
  s.approved.delete(id)
  s.grants.delete(id)
  return conn
}
