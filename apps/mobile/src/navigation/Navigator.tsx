import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { BackHandler, StyleSheet, View } from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { WindowAtmosphere } from '@/components/WindowAtmosphere'
import { motion } from '@/theme/tokens'
import { NavContext, type NavParams, type RouteName } from './context'

export type ScreenComponent = ComponentType<{ params?: NavParams }>
export type Routes = Record<RouteName, ScreenComponent>

type Entry = { key: string; name: RouteName; params?: NavParams }
let counter = 0
const makeEntry = (name: RouteName, params?: NavParams): Entry => ({
  key: `${name}-${counter++}`,
  name,
  params,
})

/**
 * Custom stack navigator. Renders the top screen over a persistent WindowAtmosphere;
 * each navigation slides the new screen in (direction-aware) and respects the Android
 * back button + reduce-motion.
 */
export function Navigator({ routes, initial }: { routes: Routes; initial: RouteName }) {
  const [stack, setStack] = useState<Entry[]>(() => [makeEntry(initial)])
  const dir = useRef<1 | -1>(1) // 1 = forward (push), -1 = back (pop)
  const reduced = useReducedMotion()
  const anim = useSharedValue(1)

  const top = stack[stack.length - 1]!
  const canGoBack = stack.length > 1

  const navigate = useCallback((name: RouteName, params?: NavParams) => {
    dir.current = 1
    setStack((s) => [...s, makeEntry(name, params)])
  }, [])

  const replace = useCallback((name: RouteName, params?: NavParams) => {
    dir.current = 1
    setStack((s) => [...s.slice(0, -1), makeEntry(name, params)])
  }, [])

  const goBack = useCallback(() => {
    dir.current = -1
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
  }, [])

  // Android hardware back.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length > 1) {
        goBack()
        return true
      }
      return false
    })
    return () => sub.remove()
  }, [stack.length, goBack])

  // Animate whenever the visible screen changes.
  useEffect(() => {
    if (reduced) {
      anim.value = 1
      return
    }
    anim.value = 0
    anim.value = withTiming(1, { duration: motion.slow, easing: Easing.bezier(...motion.expoOut) })
  }, [top.key, reduced, anim])

  const screenStyle = useAnimatedStyle(() => ({
    opacity: anim.value,
    transform: [{ translateX: (1 - anim.value) * 28 * dir.current }],
  }))

  const api = useMemo(() => ({ navigate, replace, goBack, canGoBack }), [navigate, replace, goBack, canGoBack])
  const Screen = routes[top.name]

  return (
    <NavContext.Provider value={api}>
      <View style={styles.root}>
        <WindowAtmosphere intensity={1} />
        <Animated.View key={top.key} style={[StyleSheet.absoluteFill, screenStyle]}>
          <Screen params={top.params} />
        </Animated.View>
      </View>
    </NavContext.Provider>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
})
