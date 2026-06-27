import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg'
import { StyleSheet, View, type ViewStyle } from 'react-native'

/**
 * A soft radial filament bloom — the warm light behind primary actions / ignited
 * elements. Pure SVG so it renders identically on both platforms.
 */
export function Bloom({
  size = 280,
  color = '#FFC78A',
  intensity = 0.4,
  style,
}: {
  size?: number
  color?: string
  intensity?: number
  style?: ViewStyle
}) {
  return (
    <View pointerEvents="none" style={[{ width: size, height: size }, style]}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="bloom" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={color} stopOpacity={intensity} />
            <Stop offset="100%" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width={size} height={size} fill="url(#bloom)" />
      </Svg>
    </View>
  )
}
