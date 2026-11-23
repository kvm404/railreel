/**
 * Who is waiting at the door versus who is aboard, for every host surface (invite, lobby, player).
 * A request is NOT a passenger: it is never counted as aboard, and it is always an action the
 * host has to take — so it gets its own count, its own call to action, and a name when the host
 * is about to start without it. Pure + unit-tested.
 */

export interface AdmissionPerson {
  id: string
  name: string
  status: string
}

export interface Admission<T extends AdmissionPerson> {
  /** Asked to board; the host has not decided. Oldest first (roster order). */
  pending: T[]
  /** Guests the host let in who have not left (the host itself excluded). */
  admitted: T[]
}

export function admission<T extends AdmissionPerson>(people: readonly T[]): Admission<T> {
  const guests = people.filter((p) => p.id !== 'host' && p.status !== 'left')
  return {
    pending: guests.filter((p) => p.status === 'requested'),
    admitted: guests.filter((p) => p.status !== 'requested'),
  }
}

/** The invite screen's roster line: aboard and waiting, never one folded into the other. */
export function inviteRosterLine(counts: { pending: number; admitted: number }): string {
  const aboard = counts.admitted > 0 ? `${counts.admitted} aboard` : ''
  const waiting = counts.pending > 0 ? `${counts.pending} waiting for approval` : ''
  return [aboard, waiting].filter(Boolean).join(' · ') || 'Waiting for guests…'
}

/** The invite screen's main action: review the door when someone is at it, else open the lobby. */
export function lobbyCtaLabel(pending: number): string {
  if (pending <= 0) return 'Open lobby'
  return pending === 1 ? 'Review 1 request' : `Review ${pending} requests`
}

/** "Sam", "Sam and Alex", "Sam, Alex and Jo", "Sam, Alex and 3 others". */
export function listNames(names: readonly string[], max = 3): string {
  const n = names.length
  if (n === 0) return ''
  if (n === 1) return names[0]!
  if (n <= max) return `${names.slice(0, -1).join(', ')} and ${names[n - 1]}`
  const shown = names.slice(0, max - 1)
  const rest = n - shown.length
  return `${shown.join(', ')} and ${rest} others`
}

/** Starting the show with people still at the door is a decision the host makes explicitly. */
export function startWithoutCopy(names: readonly string[]): { title: string; body: string } {
  const subject = names.length === 1 ? `${names[0]} is` : "They're"
  return {
    title: `Start without ${listNames(names)}?`,
    body: `${subject} still waiting for your approval and won't see the show until you let them in. You can still approve them from the player.`,
  }
}

/** The player's door notice: who is asking, and how many more are behind them. */
export function joinRequestHeadline(names: readonly string[]): { name: string; detail: string } {
  const first = names[0] ?? ''
  const more = names.length - 1
  return {
    name: first,
    detail: more <= 0 ? 'wants to board' : `wants to board · ${more} more waiting`,
  }
}
