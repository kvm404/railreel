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
import { createBackRegistry } from '@/lib/nav/backStack'
import { BackRegistryContext, NavContext, RouteKeyContext, type NavParams, type RouteName } from './context'

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
 * each navigation slides the new screen in (direction-aware) and respects reduce-motion.
 * Android Back is routed through the top screen's `useBackHandler` registrations, so hardware
 * Back runs the same exit logic as the on-screen back button.
 *
 * v1 note: only the top route is mounted — going back remounts the previous screen
 * (Home replays its intro; no form/discovery state is retained). Fine while screens are
 * stateless/mock; revisit when a screen needs to preserve state across navigation.
 */
export function Navigator({ routes, initial }: { routes: Routes; initial: RouteName }) {
  const [stack, setStack] = useState<Entry[]>(() => [makeEntry(initial)])
  // Mirror of the stack, updated synchronously on every change: two navigation calls in the same
  // tick (e.g. a leave() handler and a role-loss redirect) must see each other's result.
  const stackRef = useRef(stack)
  const reduced = useReducedMotion()
  const anim = useSharedValue(1)
  const dirSv = useSharedValue<1 | -1>(1) // 1 = forward (push), -1 = back (pop)
  const transitioning = useRef(false)
  const [backRegistry] = useState(createBackRegistry)

  const top = stack[stack.length - 1]!
  const canGoBack = stack.length > 1

  const commit = useCallback(
    (next: Entry[], d: 1 | -1) => {
      transitioning.current = true
      dirSv.value = d
      if (!reduced) anim.value = 0 // reset BEFORE the new screen paints (no flash)
      stackRef.current = next
      setStack(next)
    },
    [reduced, anim, dirSv],
  )
  const endTransition = useCallback(() => {
    transitioning.current = false
  }, [])

  // One navigation at a time — blocks double-tap double-push and rapid multi-pop.
  const navigate = useCallback(
    (name: RouteName, params?: NavParams) => {
      if (transitioning.current) return
      commit([...stackRef.current, makeEntry(name, params)], 1)
    },
    [commit],
  )
  const replace = useCallback(
    (name: RouteName, params?: NavParams) => {
      if (transitioning.current) return
      commit([...stackRef.current.slice(0, -1), makeEntry(name, params)], 1)
    },
    [commit],
  )
  const goBack = useCallback(() => {
    if (transitioning.current || stackRef.current.length <= 1) return
    commit(stackRef.current.slice(0, -1), -1)
  }, [commit])
  // Session endings call this — it must win over an in-flight transition (a dropped redirect would
  // strand the user on a dead screen), and repeat calls collapse into one.
  const reset = useCallback(
    (name: RouteName, params?: NavParams) => {
      const cur = stackRef.current
      if (cur.length === 1 && cur[0]!.name === name) return
      commit([makeEntry(name, params)], -1)
    },
    [commit],
  )

  // Android hardware Back: the top screen's handlers (overlays first) decide; a screen that
  // registers none just pops. Mid-transition presses are swallowed so a half-mounted screen's exit
  // can't double-fire. At the root with nothing handling it, Android backgrounds the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (transitioning.current) return true
      const cur = stackRef.current
      if (backRegistry.dispatch(cur[cur.length - 1]!.key)) return true
      if (cur.length > 1) {
        goBack()
        return true
      }
      return false
    })
    return () => sub.remove()
  }, [backRegistry, goBack])

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

  const api = useMemo(
    () => ({ navigate, replace, reset, goBack, canGoBack }),
    [navigate, replace, reset, goBack, canGoBack],
  )
  const Screen = routes[top.name]

  return (
    <NavContext.Provider value={api}>
      <BackRegistryContext.Provider value={backRegistry}>
        <View style={styles.root}>
          <WindowAtmosphere intensity={1} />
          <Animated.View key={top.key} style={[StyleSheet.absoluteFill, screenStyle]}>
            <RouteKeyContext.Provider value={top.key}>
              <Screen params={top.params} />
            </RouteKeyContext.Provider>
          </Animated.View>
        </View>
      </BackRegistryContext.Provider>
    </NavContext.Provider>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
})
