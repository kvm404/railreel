import type { palette } from './tokens'

/** Text tones → palette colour. Pure (no React Native) so contrast can be unit-tested. */
export type Tone = 'primary' | 'secondary' | 'muted' | 'tertiary' | 'dim' | 'amber' | 'cyan' | 'danger' | 'onAmber'

export const TONE_COLOR: Record<Tone, keyof typeof palette> = {
  primary: 'textPrimary',
  secondary: 'textSecondary',
  muted: 'textMuted',
  // Legacy name: it used to be the failing-contrast dim grey. It now resolves to the accessible
  // muted token so every pre-existing label is legible; use `dim` for genuinely decorative text.
  tertiary: 'textMuted',
  dim: 'textTertiary',
  danger: 'danger',
  amber: 'amber',
  cyan: 'cyan',
  onAmber: 'onAmber',
}
