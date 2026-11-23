import { describe, it, expect } from 'vitest'
import { encodeJoinUrl, PROTOCOL_VERSION } from '@/lib/protocol'
import { minQrModules, QR_QUIET_MODULES, qrQuietZone } from '@/lib/qr'

// Byte-mode capacity per version (1..10), ECC M — the sparsest encoding the QR library can pick.
const BYTE_CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]
const byteModules = (len: number) => 17 + 4 * (BYTE_CAPACITY_M.findIndex((c) => c >= len) + 1)

const sample = encodeJoinUrl({
  v: PROTOCOL_VERSION,
  host: '192.168.43.1',
  wsPort: 41234,
  httpPort: 41235,
  sessionId: 'abcDEF1234567890xyzQ',
  token: 'tok_tok_tok_tok_tok_tok_',
})

describe('qrQuietZone', () => {
  it('never estimates MORE modules than the real symbol has (so the quiet zone is never short)', () => {
    for (let len = 1; len <= 213; len++) expect(minQrModules(len)).toBeLessThanOrEqual(byteModules(len))
  })

  it('reserves at least four modules on every side for a real invite', () => {
    const size = 200
    const q = qrQuietZone(size, sample.length)
    // Rendered: viewBox = size + 2q mapped to `size`; the symbol is `size` viewBox units wide.
    const scale = size / (size + 2 * q)
    const quietDp = q * scale
    const moduleDp = (size * scale) / byteModules(sample.length)
    expect(quietDp / moduleDp).toBeGreaterThanOrEqual(QR_QUIET_MODULES)
  })

  it('keeps the symbol large enough to scan (modules stay >= 3dp at the ticket size)', () => {
    const size = 200
    const q = qrQuietZone(size, sample.length)
    const moduleDp = ((size * size) / (size + 2 * q)) / byteModules(sample.length)
    expect(moduleDp).toBeGreaterThanOrEqual(3)
  })
})
