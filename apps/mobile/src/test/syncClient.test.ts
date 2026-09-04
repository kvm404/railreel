import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { openSyncSession } from '@/net/syncClient'

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
})
