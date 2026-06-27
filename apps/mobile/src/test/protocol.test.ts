import { describe, it, expect } from 'vitest'
import {
  encodeJoinUrl,
  decodeJoinUrl,
  JoinPayloadError,
  parseClientMsg,
  parseServerMsg,
  encodeMsg,
  PROTOCOL_VERSION,
  type JoinPayload,
  type ClientMsg,
  type ServerMsg,
} from '@/lib/protocol'

const payload: JoinPayload = {
  v: PROTOCOL_VERSION,
  host: '192.168.43.1',
  wsPort: 8081,
  httpPort: 8080,
  sessionId: 'abc123',
  token: 's3cr3t-token',
}

describe('join payload codec', () => {
  it('round-trips a payload through the URL', () => {
    expect(decodeJoinUrl(encodeJoinUrl(payload))).toEqual(payload)
  })

  it('rejects a non-railreel scheme', () => {
    expect(() => decodeJoinUrl('https://join?v=1')).toThrow(JoinPayloadError)
  })

  it('rejects a mismatched protocol version', () => {
    const url = encodeJoinUrl(payload).replace('v=1', 'v=999')
    expect(() => decodeJoinUrl(url)).toThrow(/unsupported protocol/)
  })

  it('rejects an out-of-range port', () => {
    const url = encodeJoinUrl(payload).replace('ws=8081', 'ws=70000')
    expect(() => decodeJoinUrl(url)).toThrow(/invalid port/)
  })

  it('rejects a missing token', () => {
    const url = encodeJoinUrl(payload).replace('tk=s3cr3t-token', 'tk=')
    expect(() => decodeJoinUrl(url)).toThrow(/missing "tk"/)
  })

  it('preserves tokens containing url-sensitive characters', () => {
    const tricky: JoinPayload = { ...payload, token: 'a+b/c=d&e?f' }
    expect(decodeJoinUrl(encodeJoinUrl(tricky))).toEqual(tricky)
  })
})

describe('message parsing', () => {
  it('accepts a valid client message', () => {
    const msg: ClientMsg = { t: 'join', name: 'Riya', token: 'x' }
    const r = parseClientMsg(encodeMsg(msg))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.msg).toEqual(msg)
  })

  it('accepts a valid server message', () => {
    const msg: ServerMsg = { t: 'resume', atHostMonotonicMs: 12345 }
    const r = parseServerMsg(encodeMsg(msg))
    expect(r.ok).toBe(true)
  })

  it('rejects invalid JSON', () => {
    const r = parseClientMsg('{not json')
    expect(r).toEqual({ ok: false, error: 'invalid JSON' })
  })

  it('rejects a non-object frame', () => {
    expect(parseClientMsg('42').ok).toBe(false)
    expect(parseClientMsg('null').ok).toBe(false)
  })

  it('rejects a missing message type', () => {
    expect(parseServerMsg('{"foo":1}')).toEqual({ ok: false, error: 'missing message type' })
  })

  it('rejects an unknown message type', () => {
    const r = parseClientMsg('{"t":"hack"}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/unknown client message/)
  })

  it('does not accept a server type on the client channel', () => {
    // 'welcome' is a server message; it must not validate as a client message.
    expect(parseClientMsg('{"t":"welcome"}').ok).toBe(false)
  })
})
