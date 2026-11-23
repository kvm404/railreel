/**
 * QR quiet-zone sizing. Scanners need >= 4 light modules around the symbol (ISO 18004). The QR
 * component draws `size` pixels INCLUDING its `quietZone` and shrinks the symbol to fit, so the
 * quiet zone has to be sized in modules — which depends on the payload. We don't get the module
 * count back from the component, so we use a deliberately LOW estimate: a lower module count makes
 * each module look bigger, which makes the 4-module quiet zone larger than strictly needed (safe),
 * never smaller. Pure + unit-tested.
 */

/** Max characters per version (1..10) in the densest non-numeric mode (alphanumeric), ECC level M. */
const ALNUM_CAPACITY_M = [16, 29, 47, 67, 87, 108, 125, 157, 189, 221]

/** Quiet zone width, in modules, the QR spec requires. */
export const QR_QUIET_MODULES = 4

/**
 * A lower bound on the module count of the symbol for `payloadLength` characters at ECC M: the
 * version the densest mode would need, minus one version of slack for digit-run savings.
 */
export function minQrModules(payloadLength: number): number {
  let version = ALNUM_CAPACITY_M.findIndex((cap) => cap >= payloadLength) + 1
  if (version === 0) version = ALNUM_CAPACITY_M.length + 1 // longer than our table: still a valid (low) bound
  return 17 + 4 * Math.max(1, version - 1)
}

/**
 * The `quietZone` prop (in the same pixel units as `size`) that guarantees >= 4 light modules on
 * every side for a symbol of `size` pixels.
 */
export function qrQuietZone(size: number, payloadLength: number): number {
  return (QR_QUIET_MODULES * size) / minQrModules(payloadLength)
}
