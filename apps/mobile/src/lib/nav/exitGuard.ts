/**
 * What an exit that awaited something (a cache purge, a cache-size query) may still do when it
 * resumes. The world can move on during the await: the host may end the session (the screen resets
 * itself to Home and unmounts), and the user may even join a NEW session before the purge settles.
 * The continuation must only ever act on the session it started from.
 */
export type ExitStep =
  /** The screen is gone — its session ended or the user moved on (maybe into a new session). */
  | 'skip'
  /** Still here but the session already ended: just go Home. leave() would wipe the end card. */
  | 'reset'
  /** Still here, same session: tear it down and go Home. */
  | 'leave'

export function resumeExit({ mounted, sessionActive }: { mounted: boolean; sessionActive: boolean }): ExitStep {
  if (!mounted) return 'skip'
  return sessionActive ? 'leave' : 'reset'
}
