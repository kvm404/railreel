import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { BackHandler, StyleSheet, View } from 'react-native'
import Animated, {
  Easing,
  runOnJS,
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
 *
 * v1 note: only the top route is mounted — going back remounts the previous screen
 * (Home replays its intro; no form/discovery state is retained). Fine while screens are
 * stateless/mock; revisit when a screen needs to preserve state across navigation.
 */
export function Navigator({ routes, initial }: { routes: Routes; initial: RouteName }) {
  const [stack, setStack] = useState<Entry[]>(() => [makeEntry(initial)])
  const reduced = useReducedMotion()
  const anim = useSharedValue(1)
  const dirSv = useSharedValue<1 | -1>(1) // 1 = forward (push), -1 = back (pop)
  const transitioning = useRef(false)

  const top = stack[stack.length - 1]!
  const canGoBack = stack.length > 1

  // One navigation at a time — blocks double-tap double-push and rapid multi-pop.
  const begin = useCallback(
    (d: 1 | -1) => {
      if (transitioning.current) return false
      transitioning.current = true
      dirSv.value = d
      if (!reduced) anim.value = 0 // reset BEFORE the new screen paints (no flash)
      return true
    },
    [reduced, anim, dirSv],
  )
  const endTransition = useCallback(() => {
    transitioning.current = false
  }, [])

  const navigate = useCallback(
    (name: RouteName, params?: NavParams) => {
      if (begin(1)) setStack((s) => [...s, makeEntry(name, params)])
    },
    [begin],
  )
  const replace = useCallback(
    (name: RouteName, params?: NavParams) => {
      if (begin(1)) setStack((s) => [...s.slice(0, -1), makeEntry(name, params)])
    },
    [begin],
  )
  const goBack = useCallback(() => {
    if (stack.length <= 1) return
    if (begin(-1)) setStack((s) => s.slice(0, -1))
  }, [stack.length, begin])

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

  // Animate whenever the visible screen changes, then release the transition lock.
  useEffect(() => {
    if (reduced) {
      anim.value = 1
      transitioning.current = false
      return
    }
    anim.value = 0
    anim.value = withTiming(
      1,
      { duration: motion.slow, easing: Easing.bezier(...motion.expoOut) },
      (finished) => {
        if (finished) runOnJS(endTransition)()
      },
    )
  }, [top.key, reduced, anim, endTransition])

  const screenStyle = useAnimatedStyle(() => ({
    opacity: anim.value,
    transform: [{ translateX: (1 - anim.value) * 28 * dirSv.value }],
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
