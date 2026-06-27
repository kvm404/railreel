import { Text as RNText, type TextProps as RNTextProps } from 'react-native'
import { useTheme } from '@/theme/ThemeProvider'
import { typography } from '@/theme/tokens'

type Variant = keyof typeof typography
type Tone = 'default' | 'muted' | 'faint' | 'accent'

export type TextProps = RNTextProps & {
  variant?: Variant
  tone?: Tone
}

export function Text({ variant = 'body', tone = 'default', style, ...rest }: TextProps) {
  const t = useTheme()
  const color =
    tone === 'muted'
      ? t.palette.textMuted
      : tone === 'faint'
        ? t.palette.textFaint
        : tone === 'accent'
          ? t.palette.accent
          : t.palette.text

  return <RNText style={[typography[variant], { color }, style]} {...rest} />
}
