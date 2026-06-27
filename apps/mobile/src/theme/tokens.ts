/**
 * RailReel design tokens — "The Night Train Window".
 * Dark-mode only. See docs/design-language.md for the rationale behind every value.
 *
 * Warm tungsten (people, CTAs) on cold blue-night (the world streaking past).
 */

export const palette = {
  // Night — "the world outside the window"
  void: '#05070C',
  base: '#0A0E16',
  raised: '#121826',
  overlay: '#1A2233',
  hairline: '#28324A',

  // Text — cool platform whites
  textPrimary: '#E9EEF7',
  textSecondary: '#97A3B8',
  textTertiary: '#58647A',

  // Filament Amber — warmth, people, primary actions
  amberGlow: '#FFC78A',
  amber: '#FFB266',
  amberCore: '#FF9B45',
  amberDeep: '#C76E26',
  onAmber: '#1A1206', // text on filled-amber (AA)

  // Exterior Cyan — sync / connection / scanning ONLY
  cyan: '#57D2E6',
  cyanDeep: '#2A93A8',

  // Status
  danger: '#FF6B5E',

  black: '#000000',
  white: '#FFFFFF',
} as const

export const gradients = {
  /** Soft horizontal light streak (cold). */
  streakCyan: ['transparent', 'rgba(87,210,230,0.22)', 'transparent'] as const,
  /** Soft horizontal light streak (warm). */
  streakAmber: ['transparent', 'rgba(255,178,102,0.16)', 'transparent'] as const,
  /** Radial filament glow behind CTAs (use as overlay). */
  filament: ['rgba(255,199,138,0.40)', 'rgba(255,199,138,0.0)'] as const,
  /** Amber CTA fill. */
  amberFill: ['#FFC78A', '#FF9B45'] as const,
  /** Cinematic top/bottom darken. */
  vignette: ['#05070C', 'transparent', '#05070C'] as const,
}

/** Font family names — must match the loaded @expo-google-fonts exports (see fonts.ts). */
export const fonts = {
  displayBold: 'Unbounded_700Bold',
  displaySemi: 'Unbounded_600SemiBold',
  bodyRegular: 'SpaceGrotesk_400Regular',
  bodyMedium: 'SpaceGrotesk_500Medium',
  bodyBold: 'SpaceGrotesk_700Bold',
  monoRegular: 'SpaceMono_400Regular',
  monoBold: 'SpaceMono_700Bold',
} as const

export const typography = {
  displayXl: { fontFamily: fonts.displayBold, fontSize: 56, lineHeight: 60, letterSpacing: -1.1 },
  displayL: { fontFamily: fonts.displaySemi, fontSize: 34, lineHeight: 38, letterSpacing: -0.34 },
  title: { fontFamily: fonts.bodyBold, fontSize: 22, lineHeight: 28 },
  cardTitle: { fontFamily: fonts.bodyMedium, fontSize: 17, lineHeight: 22 },
  body: { fontFamily: fonts.bodyRegular, fontSize: 15, lineHeight: 22 },
  caption: { fontFamily: fonts.bodyMedium, fontSize: 13, lineHeight: 18 },
  eyebrow: { fontFamily: fonts.monoBold, fontSize: 12, lineHeight: 16, letterSpacing: 1.4 },
  data: { fontFamily: fonts.monoRegular, fontSize: 14, lineHeight: 18, letterSpacing: 0.6 },
} as const

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

export const motion = {
  fast: 150,
  base: 250,
  slow: 420,
  /** Default UI spring. */
  spring: { stiffness: 200, damping: 22, mass: 1 },
  /** Snappy spring for split-flap cells. */
  flapSpring: { stiffness: 260, damping: 18, mass: 1 },
  /** expo-out bezier control points (use with Easing.bezier). */
  expoOut: [0.16, 1, 0.3, 1] as const,
} as const

export const tokens = { palette, gradients, fonts, typography, spacing, radii, motion }
export type Tokens = typeof tokens
