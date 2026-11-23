import { describe, it, expect } from 'vitest'
import { requestToastCopy } from '@/lib/player/requestToast'

describe('requestToastCopy', () => {
  it('tells a host decline apart from a request that ran out of time', () => {
    expect(requestToastCopy('declined')?.message).toBe('The host passed on that one')
    expect(requestToastCopy('expired')?.message).toBe('No answer yet — you can ask again')
  })

  it('never blames the host for the older catch-all status', () => {
    expect(requestToastCopy('dismissed')?.message).not.toMatch(/host/i)
  })

  it('fades terminal outcomes on their own and holds while pending', () => {
    for (const s of ['approved', 'declined', 'expired', 'dismissed']) expect(requestToastCopy(s)?.terminal).toBe(true)
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
