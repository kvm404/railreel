import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { openSyncSession, SyncCancelledError } from '@/net/syncClient'

class MockWebSocket {
  url: string
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  serverOffset = 1000

  constructor(url: string) {
    this.url = url
    setTimeout(() => this.onopen?.(), 0)
  }

  send(data: string) {
    this.sent.push(data)
    try {
      const msg = JSON.parse(data)
      if (msg.t === 'syncPing') {
        const t1 = msg.t1
        setTimeout(() => {
          this.receive({
            t: 'syncPong',
            t1,
            t2: t1 + this.serverOffset + 5,
            t3: t1 + this.serverOffset + 5,
          })
        }, 10)
      }
    } catch {
      // ignore
    }
  }

  close() {
    this.onclose?.()
  }

  receive(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

describe('openSyncSession and rolling NTP drift compensation', () => {
  let originalWebSocket: typeof WebSocket
  let activeSocket: MockWebSocket | null = null

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket
    activeSocket = null
    const setActiveSocket = (s: MockWebSocket) => {
      activeSocket = s
    }
    // @ts-expect-error mock assignment
    globalThis.WebSocket = class extends MockWebSocket {
      constructor(url: string) {
        super(url)
        setActiveSocket(this)
      }
    }
  })

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
  })

  it('settles clock estimate initially and compensates for clock drift on keepalive pongs', async () => {
    const onMessage = vi.fn()
    const sessionPromise = openSyncSession('127.0.0.1', 8081, 'token123', onMessage, undefined, 3)

    const session = await sessionPromise
    expect(session.samples).toBe(3)
    const initialOffset = session.estimate.offsetMs
    expect(Math.abs(initialOffset - 1000)).toBeLessThan(10)

    // Now simulate clock drift on keepalive: server offset changes by +50ms (to 1050ms)
    // Send 8 keepalive pongs with new offset
    for (let i = 0; i < 8; i++) {
      const t1 = performance.now()
      await new Promise((r) => setTimeout(r, 10))
      activeSocket!.receive({
        t: 'syncPong',
        t1,
        t2: t1 + 1050 + 5,
        t3: t1 + 1050 + 5,
      })
    }

    // After rolling window is populated with new samples, offsetMs should track the +50ms drift!
    const driftedOffset = session.estimate.offsetMs
    expect(Math.abs((driftedOffset - initialOffset) - 50)).toBeLessThan(5)
    expect(session.toHostTime(100)).toBeCloseTo(100 + driftedOffset, 0)
    expect(session.toHostTime(NaN)).toBeCloseTo(driftedOffset, 0)

    session.close()
  })

  it('cancels pending handshake ping timer when socket closes early', async () => {
    const onMessage = vi.fn()
    const sessionPromise = openSyncSession('127.0.0.1', 8081, 'token123', onMessage, undefined, 5)

    // Wait for the first ping/pong
    await new Promise((r) => setTimeout(r, 20))
    // Trigger close before remaining 4 rounds complete
    activeSocket!.close()

    await expect(sessionPromise).rejects.toThrow('WebSocket closed')
  })

  it('an aborted handshake rejects as cancelled and never reaches the callbacks', async () => {
    const onMessage = vi.fn()
    const onClose = vi.fn()
    const ctl = new AbortController()
    const sessionPromise = openSyncSession('127.0.0.1', 8081, 'token123', onMessage, onClose, 5, ctl.signal)
    await new Promise((r) => setTimeout(r, 20))
    const sock = activeSocket!
    ctl.abort()
    await expect(sessionPromise).rejects.toBeInstanceOf(SyncCancelledError)
    // A late frame (e.g. the old host's `ended`) on the abandoned socket goes nowhere.
    sock.receive({ t: 'ended', reason: 'host-left' })
    sock.close()
    expect(onMessage).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('an already-aborted signal rejects without opening a socket', async () => {
    const ctl = new AbortController()
    ctl.abort()
    await expect(openSyncSession('127.0.0.1', 8081, 't', vi.fn(), undefined, 3, ctl.signal)).rejects.toBeInstanceOf(
      SyncCancelledError,
    )
    expect(activeSocket).toBeNull()
  })

  it('aborting after the session resolved is a no-op (the caller owns close)', async () => {
    const onMessage = vi.fn()
    const ctl = new AbortController()
    const session = await openSyncSession('127.0.0.1', 8081, 't', onMessage, undefined, 3, ctl.signal)
    ctl.abort()
    activeSocket!.receive({ t: 'chat', from: 'a', text: 'hi', at: 1 })
    expect(onMessage).toHaveBeenCalledTimes(1)
    session.close()
  })

  it('a deliberate close is silent; a drop calls onClose exactly once', async () => {
    const onClose = vi.fn()
    const s1 = await openSyncSession('127.0.0.1', 8081, 't', vi.fn(), onClose, 3)
    s1.close()
    expect(onClose).not.toHaveBeenCalled()

    const onClose2 = vi.fn()
    await openSyncSession('127.0.0.1', 8081, 't', vi.fn(), onClose2, 3)
    activeSocket!.close() // the host went away
    activeSocket!.close()
    expect(onClose2).toHaveBeenCalledTimes(1)
  })
})

/**
 * React Native's Android WebSocket registers a socket natively only in onOpen, so a close()
 * issued while still CONNECTING does nothing and the connection opens anyway.
 */
class ConnectingNoopCloseSocket {
  static last: ConnectingNoopCloseSocket | null = null
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  open = false
  closed = false
  sent: string[] = []
  constructor() {
    ConnectingNoopCloseSocket.last = this
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    if (!this.open || this.closed) return // native no-op before onOpen
    this.closed = true
    this.onclose?.()
  }
  /** The native side finished connecting. */
  connect() {
    this.open = true
    this.onopen?.()
  }
}

describe('openSyncSession cancelled before the socket opened (Android)', () => {
  let original: typeof WebSocket
  beforeEach(() => {
    original = globalThis.WebSocket
    ConnectingNoopCloseSocket.last = null
    // @ts-expect-error mock assignment
    globalThis.WebSocket = ConnectingNoopCloseSocket
  })
  afterEach(() => {
    globalThis.WebSocket = original
  })

  it('closes the socket for real once it opens, and never pings', async () => {
    const onMessage = vi.fn()
    const onClose = vi.fn()
    const ctl = new AbortController()
    const p = openSyncSession('127.0.0.1', 8081, 't', onMessage, onClose, 3, ctl.signal)
    const sock = ConnectingNoopCloseSocket.last!
    ctl.abort() // Back pressed while still CONNECTING: the close is a native no-op
    await expect(p).rejects.toBeInstanceOf(SyncCancelledError)
    expect(sock.closed).toBe(false)
    sock.connect() // ...and the socket opens anyway
    expect(sock.closed).toBe(true)
    expect(sock.sent).toEqual([]) // no clock handshake on an abandoned socket
    expect(onMessage).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a handshake timeout before open also closes the socket once it opens', async () => {
    vi.useFakeTimers()
    try {
      const p = openSyncSession('127.0.0.1', 8081, 't', vi.fn(), undefined, 3)
      const sock = ConnectingNoopCloseSocket.last!
      const rejected = expect(p).rejects.toThrow('sync timed out')
      vi.advanceTimersByTime(8000)
      await rejected
      sock.connect()
      expect(sock.closed).toBe(true)
      expect(sock.sent).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
