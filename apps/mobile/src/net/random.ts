import * as Crypto from 'expo-crypto'

import type { RandomBytes } from '@/lib/protocol'

/**
 * The app's cryptographically-strong randomness source, used to mint session tokens and
 * download grants. Kept out of src/lib so the credential logic there stays pure and unit-
 * testable with injected bytes; the runtime wiring binds it to expo-crypto here.
 */
export const randomBytes: RandomBytes = (n) => Crypto.getRandomBytes(n)
