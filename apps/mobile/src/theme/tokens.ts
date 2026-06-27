/**
 * RailReel design tokens — the single source of truth for the visual system.
 *
 * This is a FOUNDATION palette (cinematic dark). The full, WOW-grade visual
 * direction is defined with the user before the UI build; refine here, not inline.
 */

export const palette = {
  // Surfaces — deep "lights-down" cinema blacks
  bg: '#0B0B0F',
  surface: '#15151C',
  surfaceElevated: '#1D1D27',
  border: '#2A2A36',

  // Text
  text: '#F4F4F7',
  textMuted: '#A0A0B0',
  textFaint: '#6B6B7B',

  // Brand accent — "projector" warm/electric pairing (placeholder)
  accent: '#FF5C72',
  accentAlt: '#7C5CFF',

  // Status
  success: '#3BD17A',
  warning: '#FFC24B',
  danger: '#FF5247',

  // Pure
  black: '#000000',
  white: '#FFFFFF',
} as const

export const gradients = {
  accent: ['#FF5C72', '#7C5CFF'] as const,
  hero: ['#1D1D27', '#0B0B0F'] as const,
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const

export const radii = {
  sm: 8,
  md: 12,
  lg: 18,
  xl: 26,
  pill: 999,
} as const

export const typography = {
  display: { fontSize: 40, lineHeight: 46, fontWeight: '800' as const, letterSpacing: -0.5 },
  title: { fontSize: 26, lineHeight: 32, fontWeight: '700' as const, letterSpacing: -0.3 },
  heading: { fontSize: 20, lineHeight: 26, fontWeight: '700' as const },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '500' as const },
  label: { fontSize: 14, lineHeight: 18, fontWeight: '600' as const },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' as const },
} as const

/** Motion durations (ms) and easings — keep animations consistent and smooth. */
export const motion = {
  fast: 150,
  base: 250,
  slow: 400,
  spring: { damping: 18, stiffness: 180, mass: 1 },
} as const

export const tokens = { palette, gradients, spacing, radii, typography, motion }
export type Tokens = typeof tokens
