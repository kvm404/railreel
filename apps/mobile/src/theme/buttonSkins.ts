import type { veils } from './tokens'
import type { Tone } from './tones'

/**
 * The ghost button intents as data: which veils sit over the surface (rest / pressed) and which
 * text tones they carry. Kept pure so the contrast test can composite the REAL translucent
 * backgrounds instead of checking text against an opaque surface.
 */
export type GhostSkin = {
  border: keyof typeof veils
  bg: keyof typeof veils
  pressed: keyof typeof veils
  title: Tone
  subtitle: Tone
}

export const ghostSkins = {
  cyan: { border: 'cyanBorder', bg: 'cyanTint', pressed: 'cyanTintStrong', title: 'cyan', subtitle: 'secondary' },
  neutral: { border: 'steelBorder', bg: 'steelTint', pressed: 'steelTintPressed', title: 'primary', subtitle: 'secondary' },
  danger: { border: 'dangerBorder', bg: 'dangerTint', pressed: 'dangerTintPressed', title: 'danger', subtitle: 'secondary' },
} as const satisfies Record<string, GhostSkin>
