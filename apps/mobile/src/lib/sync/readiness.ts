/**
 * Lobby readiness, as pure functions: who is merely asking to board, who is still boarding
 * (downloading/buffering), who is ready — all derived from ONE eligible roster so the headline
 * counts, the board state and the host's start gate can never disagree. Plus the timing of the
 * one-shot "everyone's ready" ignition and a once-per-session milestone latch.
 */

export type RosterPerson = { id: string; status: string; progress: number }

export type RosterBuckets<T extends RosterPerson> = {
  /** Asked to join; the host has not approved yet. Never counted as aboard. */
  wantsIn: T[]
  /** Approved and still downloading/buffering. */
  boarding: T[]
  /** Fully downloaded. */
  ready: T[]
  /** Everyone actually in the cabin: not requested, not left (includes the host). */
  eligible: T[]
  /** The roster the start gate evaluates: eligible guests (the host already has the file). */
  gateRoster: T[]
}

export function bucketRoster<T extends RosterPerson>(people: T[]): RosterBuckets<T> {
  const wantsIn = people.filter((p) => p.status === 'requested')
  const eligible = people.filter((p) => p.status !== 'requested' && p.status !== 'left')
  const ready = eligible.filter((p) => p.status === 'ready')
  const boarding = eligible.filter((p) => p.status !== 'ready')
  const gateRoster = eligible.filter((p) => p.id !== 'host')
  return { wantsIn, boarding, ready, eligible, gateRoster }
}

/**
 * What the departure board should say.
 *  - awaiting-approval: THIS phone is still only requesting a seat (never show readiness).
 *  - solo: nobody but the host is aboard yet.
 *  - boarding: someone is still downloading and the gate is closed.
 *  - ready-to-depart: the gate is open but downloads are still finishing (head start).
 *  - all-aboard: every eligible passenger is fully ready.
 */
export type BoardPhase = 'awaiting-approval' | 'solo' | 'boarding' | 'ready-to-depart' | 'all-aboard'

export function boardPhase(input: {
  iAmRequested: boolean
  buckets: Pick<RosterBuckets<RosterPerson>, 'eligible' | 'boarding' | 'gateRoster'>
  gateStart: boolean
}): BoardPhase {
  if (input.iAmRequested) return 'awaiting-approval'
  const { eligible, boarding, gateRoster } = input.buckets
  if (gateRoster.length === 0) return 'solo'
  if (!input.gateStart) return 'boarding'
  return boarding.length === 0 && eligible.length > 0 ? 'all-aboard' : 'ready-to-depart'
}

export type IgnitionSchedule = {
  /** Per ready row (in roster order): when its filament ignites. */
  rowDelaysMs: number[]
  /** The board flips to ALL ABOARD. */
  boardMs: number
  /** The amber bloom and the single success haptic. */
  bloomMs: number
  /** The Start control lights. */
  startMs: number
}

const ROW_STEP_MS = 140
const BOARD_LEAD_MS = 160
const BLOOM_AFTER_BOARD_MS = 520 // the 10-cell flap cascade lands first
const START_AFTER_BLOOM_MS = 240

/**
 * The Start control waits for the sequence, so the host is never held longer than this — however
 * many rows there are, the row stagger tightens to fit.
 */
export const MAX_START_DELAY_MS = 1500

/** The coordinated beat: rows ignite in turn, then the board, then bloom (+haptic), then Start. */
export function ignitionSchedule(readyRows: number, reduced: boolean): IgnitionSchedule {
  if (reduced) return { rowDelaysMs: Array.from({ length: readyRows }, () => 0), boardMs: 0, bloomMs: 0, startMs: 0 }
  const fixedMs = BOARD_LEAD_MS + BLOOM_AFTER_BOARD_MS + START_AFTER_BLOOM_MS
  const rowStepMs =
    readyRows > 1 ? Math.min(ROW_STEP_MS, Math.max(0, Math.floor((MAX_START_DELAY_MS - fixedMs) / (readyRows - 1)))) : ROW_STEP_MS
  const rowDelaysMs = Array.from({ length: readyRows }, (_, i) => i * rowStepMs)
  const boardMs = Math.max(0, (readyRows - 1) * rowStepMs) + BOARD_LEAD_MS
  const bloomMs = boardMs + BLOOM_AFTER_BOARD_MS
  return { rowDelaysMs, boardMs, bloomMs, startMs: bloomMs + START_AFTER_BLOOM_MS }
}

/** Fires each key once per process/session: the climax plays (and buzzes) a single time. */
export function createMilestoneLatch() {
  const seen = new Set<string>()
  return {
    /** Whether `key` has already fired (lets a remount skip the replay without consuming it). */
    has(key: string): boolean {
      return seen.has(key)
    },
    /** True the first time `key` is claimed, false afterwards. */
    claim(key: string): boolean {
      if (seen.has(key)) return false
      seen.add(key)
      return true
    },
    reset(): void {
      seen.clear()
    },
  }
}
