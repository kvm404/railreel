import { bestEstimate, type ClockEstimate, type ClockSample } from '@/lib/sync/clock'

/**
 * Client side of the control plane. Connects to the host's WebSocket, runs an NTP-style clock
 * handshake (answered natively by the host for accuracy), and keeps the socket open to receive
 * broadcast state (play/pause/seek/chat/reactions). The offset/RTT math lives in lib/sync/clock.
 */

export type SyncSession = {
  estimate: ClockEstimate
  samples: number
  /** Convert a client monotonic-ms reading to host time. */
  toHostTime: (clientMs: number) => number
  /** Send a client→host message (join/chat/reaction/request) on the open socket. */
  send: (msg: Record<string, unknown>) => void
  close: () => void
}

const nowMs = (): number =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Keepalive ping cadence. Must stay well under the host's WS read timeout (30s) so a missed
 *  ping does not drop the control channel. See RailReelHostModule WS_SOCKET_READ_TIMEOUT_MS. */
const KEEPALIVE_MS = 10000
const ROLLING_WINDOW_SIZE = 8

/** The handshake was abandoned through its AbortSignal (the caller moved on). */
export class SyncCancelledError extends Error {
  constructor() {
    super('sync cancelled')
    this.name = 'SyncCancelledError'
  }
}

/**
 * Open a WS session: do `rounds` ping/pong exchanges, resolve with the best clock estimate,
 * then forward any later messages to `onMessage`. Reject on connect/handshake failure.
 *
 * `signal` cancels a handshake still in flight: the socket is closed, the promise rejects with
 * SyncCancelledError, and neither callback ever fires for it. Once resolved, the returned
 * session's `close()` is the only off switch (and a deliberate close never calls `onClose`).
 */
export function openSyncSession(
  host: string,
  wsPort: number,
  token: string,
  onMessage: (msg: Record<string, unknown>) => void,
  /** Called once if the socket drops AFTER the session was established (host stop, WiFi loss). */
  onClose?: () => void,
  rounds = 6,
  signal?: AbortSignal,
): Promise<SyncSession> {
  if (signal?.aborted) return Promise.reject(new SyncCancelledError())
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}:${wsPort}/?tk=${encodeURIComponent(token)}`)
    // Silenced: cancelled mid-handshake, or closed on purpose — nothing more reaches the caller.
    let silenced = false
    const samples: ClockSample[] = []
    const rollingSamples: ClockSample[] = []
    let currentEstimate: ClockEstimate | null = null
    let settled = false
    let keepalive: ReturnType<typeof setInterval> | undefined
    let pingTimeout: ReturnType<typeof setTimeout> | undefined
    const ping = () => {
      try {
        ws.send(JSON.stringify({ t: 'syncPing', t1: nowMs() }))
      } catch {
        // socket closed; timers cleared from a terminal handler
      }
    }

    // Clear timers from every terminal path (resolve/close, error, close, timeout) so the
    // keepalive or handshake retry interval can never outlive the socket (host stop, WiFi loss, server timeout).
    const clearTimers = () => {
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(timeout)
      if (pingTimeout) {
        clearTimeout(pingTimeout)
        pingTimeout = undefined
      }
      if (keepalive) {
        clearInterval(keepalive)
        keepalive = undefined
      }
    }

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        ws.close()
        reject(new Error('sync timed out'))
      }
    }, 8000)

    // Declared as a function so clearTimers (above) can unregister it before this line runs.
    function onAbort() {
      if (settled) return // resolved first: the caller owns the session (and closes it)
      settled = true
      silenced = true
      clearTimers()
      ws.close()
      reject(new SyncCancelledError())
    }
    signal?.addEventListener('abort', onAbort)

    ws.onopen = () => ping()

    ws.onmessage = (e) => {
      if (silenced) return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String((e as MessageEvent).data))
      } catch {
        return
      }
      if (msg.t === 'syncPong') {
        if (settled) {
          // Keepalive pong after initial handshake: update rolling window to compensate for thermal clock drift
          if (isFiniteNum(msg.t1) && isFiniteNum(msg.t2) && isFiniteNum(msg.t3)) {
            rollingSamples.push({ t1: msg.t1, t2: msg.t2, t3: msg.t3, t4: nowMs() })
            if (rollingSamples.length > ROLLING_WINDOW_SIZE) {
              rollingSamples.shift()
            }
            const updated = bestEstimate(rollingSamples)
            if (updated && currentEstimate) {
              currentEstimate.offsetMs = updated.offsetMs
              currentEstimate.rttMs = updated.rttMs
            }
          }
          return
        }
        // Only sample a well-formed pong; a malformed one must not yield a NaN offset/RTT.
        if (isFiniteNum(msg.t1) && isFiniteNum(msg.t2) && isFiniteNum(msg.t3)) {
          samples.push({ t1: msg.t1, t2: msg.t2, t3: msg.t3, t4: nowMs() })
        }
        if (samples.length >= rounds) {
          const estimate = bestEstimate(samples)
          if (!estimate) return
          settled = true
          currentEstimate = { ...estimate }
          rollingSamples.push(...samples.slice(-ROLLING_WINDOW_SIZE))
          clearTimeout(timeout)
          // Keepalive: NanoWSD has no idle ping, and the host closes a connection that sends
          // nothing for its socket read timeout (WS_SOCKET_READ_TIMEOUT_MS = 30s). A periodic
          // ping keeps the channel alive through quiet stretches of a movie. Stay well under that
          // timeout so a single dropped ping still leaves the connection alive.
          keepalive = setInterval(() => {
            try {
              ws.send(JSON.stringify({ t: 'syncPing', t1: nowMs() }))
            } catch {
              // socket closed; interval is cleared from a terminal handler
            }
          }, KEEPALIVE_MS)
          resolve({
            estimate: currentEstimate,
            samples: samples.length,
            toHostTime: (clientMs) => (Number.isFinite(clientMs) ? clientMs : 0) + (currentEstimate?.offsetMs ?? 0),
            send: (msg) => {
              try {
                ws.send(JSON.stringify(msg))
              } catch {
                // socket closed; caller's onclose/onerror will surface it
              }
            },
            close: () => {
              silenced = true // deliberate: not a drop, so no onClose (and no late messages)
              clearTimers()
              ws.close()
            },
          })
        } else {
          pingTimeout = setTimeout(ping, 100)
        }
        return
      }
      onMessage(msg)
    }

    ws.onerror = () => {
      clearTimers()
      if (!settled) {
        settled = true
        reject(new Error('WebSocket error'))
      }
    }

    ws.onclose = () => {
      clearTimers()
      if (!settled) {
        settled = true
        reject(new Error('WebSocket closed'))
      } else if (!silenced) {
        silenced = true // once
        onClose?.() // session was live; let the caller tear down its UI/state
      }
    }
  })
}
