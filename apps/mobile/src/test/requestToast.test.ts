import { describe, it, expect } from 'vitest'
import { requestToastCopy } from '@/lib/player/requestToast'

describe('requestToastCopy', () => {
  it('tells a host decline apart from a request that ran out of time', () => {
    expect(requestToastCopy('declined')?.message).toBe('The host passed on that one')
    expect(requestToastCopy('expired')?.message).toBe('No answer yet — you can ask again')
  })

  it('says the connection dropped for a request lost with the socket (not the host, not a timeout)', () => {
    expect(requestToastCopy('lost')?.message).toBe("Connection dropped — ask again once you're back")
    expect(requestToastCopy('lost')?.tone).toBe('neutral')
  })

  it('no negative outcome ever reads as still pending', () => {
    const pending = requestToastCopy('pending')!.message
    for (const s of ['declined', 'expired', 'lost', 'dismissed']) {
      const copy = requestToastCopy(s)
      expect(copy).not.toBeNull()
      expect(copy?.message).not.toBe(pending)
      expect(copy?.tone).not.toBe('pending')
    }
  })

  it('never blames the host for the older catch-all status', () => {
    expect(requestToastCopy('dismissed')?.message).not.toMatch(/host/i)
  })

  it('fades terminal outcomes on their own and holds while pending', () => {
    for (const s of ['approved', 'declined', 'expired', 'lost', 'dismissed']) expect(requestToastCopy(s)?.terminal).toBe(true)
    expect(requestToastCopy('pending')?.terminal).toBe(false)
  })

  it('keeps cyan (sync) for an approval only', () => {
    expect(requestToastCopy('approved')?.tone).toBe('sync')
    expect(requestToastCopy('declined')?.tone).toBe('neutral')
    expect(requestToastCopy('expired')?.tone).toBe('neutral')
  })

  it('renders nothing for idle or a status this build does not know', () => {
    expect(requestToastCopy('idle')).toBeNull()
    expect(requestToastCopy('lost-in-transit')).toBeNull()
  })
})
