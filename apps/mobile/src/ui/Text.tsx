import { Text as RNText, type TextProps as RNTextProps } from 'react-native'
import { useTheme } from '@/theme/ThemeProvider'
import { typography } from '@/theme/tokens'

type Variant = keyof typeof typography
type Tone = 'primary' | 'secondary' | 'muted' | 'tertiary' | 'dim' | 'amber' | 'cyan' | 'danger' | 'onAmber'

export type TextProps = RNTextProps & {
  variant?: Variant
  tone?: Tone
  /** Uppercase the content (pairs with the eyebrow variant). */
  upper?: boolean
}

const TONE_COLOR: Record<Tone, keyof ReturnType<typeof useTheme>['palette']> = {
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

export function Text({
  variant = 'body',
  tone = 'primary',
  upper = false,
  style,
  ...rest
}: TextProps) {
  const t = useTheme()
  const color = t.palette[TONE_COLOR[tone]]
  return (
    <RNText
      // Cap runaway font scaling so fixed-height chrome (buttons, flaps, headers) can't be blown out;
      // screens also scroll, so enlarged text stays reachable.
      maxFontSizeMultiplier={1.5}
      style={[typography[variant], { color }, upper && { textTransform: 'uppercase' }, style]}
      {...rest}
    />
  )
}
