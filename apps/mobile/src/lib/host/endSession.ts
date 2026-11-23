/**
 * Ending a hosted session closes the cabin for everyone in it. The host's Back (header or
 * hardware) is easy to hit by accident, so with friends aboard it asks first — with the
 * consequence spelled out. Pure + unit-tested.
 */

/** Guests who would be cut off: everyone but the host who has not already left. */
export function activeGuestCount(people: readonly { id: string; status: string }[]): number {
  return people.filter((p) => p.id !== 'host' && p.status !== 'left').length
}

/** A running session with people aboard needs a confirmation; an empty or idle one does not. */
export function needsEndConfirmation(hostPhase: 'idle' | 'starting' | 'live', guests: number): boolean {
  return hostPhase === 'live' && guests > 0
}

export function endSessionBody(guests: number): string {
  return guests === 1
    ? 'Leaving turns the cabin dark for the friend aboard. Their movie stops and the invite stops working.'
    : `Leaving turns the cabin dark for the ${guests} friends aboard. Their movie stops and the invite stops working.`
}
