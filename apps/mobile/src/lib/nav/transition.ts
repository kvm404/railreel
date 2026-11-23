/**
 * Navigator presentation rules (pure): how strongly the persistent night-window runs behind each
 * route, and which outgoing screens stay on screen through the transition.
 *
 * - Atmosphere: the Player is opaque full-bleed film — six streak loops behind it are pure cost,
 *   so it gets 0 (unmounted). Every other route shows the window at full strength.
 * - Continuity: the outgoing screen stays mounted for the ~420ms transition, sliding and fading
 *   out over the persistent window while the incoming one arrives, so the window visibly connects
 *   the two. Never under reduce-motion (an instant swap), and never for the Player: it owns the
 *   room's transport and decoder, and its unmount (pausing the room) must not wait on an animation.
 *   Never on a reset either: resets are session endings, and the outgoing screen may still have a
 *   native Modal sheet open (e.g. the Lobby's cleanup sheet). A Modal escapes the stage wrapper's
 *   pointerEvents, TalkBack hiding and the Back registry, so a tap on it in those 420ms would act
 *   on a session that is already gone (a second leave() wiping Home's session-end card).
 */

/** How the stack changed: a push/pop/replace, or a terminal reset to a single route. */
export type TransitionKind = 'step' | 'reset'

export function atmosphereIntensity(route: string): number {
  return route === 'Player' ? 0 : 1
}

/**
 * The window's strength during a transition: the stronger of the two screens on stage, so it
 * never vanishes from under a screen that is still fading out (entering the Player keeps it until
 * the Lobby has gone; leaving the Player brings it back at once).
 */
export function stagedAtmosphere(top: string, leaving: string | null): number {
  const base = atmosphereIntensity(top)
  return leaving == null ? base : Math.max(base, atmosphereIntensity(leaving))
}

export function retainsOutgoing(outgoing: string, reduced: boolean, kind: TransitionKind): boolean {
  return !reduced && kind === 'step' && outgoing !== 'Player'
}

/** Horizontal parallax (dp): the incoming screen travels this far, the outgoing half of it. */
export const ENTER_SHIFT = 28
export const LEAVE_SHIFT = 14
