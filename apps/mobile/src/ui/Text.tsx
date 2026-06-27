import { Text as RNText, type TextProps as RNTextProps } from 'react-native'
import { useTheme } from '@/theme/ThemeProvider'
import { typography } from '@/theme/tokens'

type Variant = keyof typeof typography
type Tone = 'primary' | 'secondary' | 'tertiary' | 'amber' | 'cyan' | 'onAmber'

export type TextProps = RNTextProps & {
  variant?: Variant
  tone?: Tone
  /** Uppercase the content (pairs with the eyebrow variant). */
  upper?: boolean
}

const TONE_COLOR: Record<Tone, keyof ReturnType<typeof useTheme>['palette']> = {
  primary: 'textPrimary',
  secondary: 'textSecondary',
  tertiary: 'textTertiary',
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
      style={[typography[variant], { color }, upper && { textTransform: 'uppercase' }, style]}
      {...rest}
    />
  )
}
