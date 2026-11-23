import { Text as RNText, type TextProps as RNTextProps } from 'react-native'
import { useTheme } from '@/theme/ThemeProvider'
import { typography } from '@/theme/tokens'
import { TONE_COLOR, type Tone } from '@/theme/tones'

type Variant = keyof typeof typography
export type TextProps = RNTextProps & {
  variant?: Variant
  tone?: Tone
  /** Uppercase the content (pairs with the eyebrow variant). */
  upper?: boolean
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
