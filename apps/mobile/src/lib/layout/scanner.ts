/**
 * The QR scanner's reticle size, decided AFTER the things that must stay on screen: the close
 * button's strip at the top, the instruction line, the action button (when there is one) and the
 * gaps between them, all inside the safe area. A short landscape window gets a smaller reticle
 * rather than an instruction or "Scan again" pushed off-screen; only below the floor does the
 * overlay scroll.
 */
export interface ScannerLayoutInput {
  width: number
  height: number
  insets: { top: number; bottom: number; left: number; right: number }
  fontScale?: number
  /** An action button (Allow camera / Open settings / Scan again) sits under the instruction. */
  hasAction: boolean
}

export const RETICLE_MAX = 240
export const RETICLE_MIN = 120
/** Close button strip at the top: its offset + 44dp + a gap below (the overlay's top padding). */
export const CLOSE_STRIP = 12 + 44 + 12
/** The overlay's bottom padding inside the safe area. */
export const BOTTOM_PAD = 24
/** The instruction plate: up to two lines of data type (18 lh) + 16dp padding. */
const CAPTION_LINE = 18
const CAPTION_PAD = 16
const ACTION_H = 56
export const SCANNER_GAP = 22
export const SIDE_PAD = 32

export function scannerReticle(i: ScannerLayoutInput): number {
  const fontScale = i.fontScale && i.fontScale > 0 ? i.fontScale : 1
  const caption = Math.ceil(2 * CAPTION_LINE * fontScale + CAPTION_PAD)
  const action = i.hasAction ? SCANNER_GAP + ACTION_H : 0
  const usableH = i.height - i.insets.top - i.insets.bottom - CLOSE_STRIP - BOTTOM_PAD - caption - action - SCANNER_GAP
  const usableW = i.width - i.insets.left - i.insets.right - 2 * SIDE_PAD
  const fit = Math.floor(Math.min(usableH, usableW, RETICLE_MAX))
  return Math.max(RETICLE_MIN, fit)
}
