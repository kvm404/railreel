import { useEffect, useState } from 'react'
import { useSharedValue, type SharedValue } from 'react-native-reanimated'
import type { VideoPlayer } from 'expo-video'
import { createPlayheadStore, type PlayheadStore } from '@/lib/player/playhead'

/** Native tick cadence (s): fine enough for caption timing, cheap across the bridge. */
const TICK_SEC = 0.1

export interface Playhead extends PlayheadStore {
  /** UI-thread mirror (seconds) for animated readouts like the filament scrubber. */
  sv: SharedValue<number>
  /** Publish a known position now (a seek), holding against stale native ticks. */
  seekTo(sec: number): void
}

/**
 * Observe a player's position without React state: expo-video's `timeUpdate` events feed a small
 * store (see lib/player/playhead) plus a Reanimated shared value. Readers subscribe; the screen
 * itself never re-renders on a tick.
 */
export function usePlayhead(player: VideoPlayer): Playhead {
  const sv = useSharedValue(0)
  const [playhead] = useState<Playhead>(() => {
    const store = createPlayheadStore()
    return {
      ...store,
      sv,
      seekTo: (sec) => store.publish(sec, Date.now()),
    }
  })

  useEffect(() => playhead.subscribe((sec) => (sv.value = sec)), [playhead, sv])

  useEffect(() => {
    player.timeUpdateEventInterval = TICK_SEC
    const sub = player.addListener('timeUpdate', (e) => playhead.ingest(e.currentTime, Date.now()))
    // No interval reset on cleanup: by unmount expo-video may already have released the player.
    return () => sub.remove()
  }, [player, playhead])

  return playhead
}

/** Re-render only when the displayed whole second changes (time readouts, a11y values). */
export function usePlayheadSecond(playhead: PlayheadStore): number {
  const [sec, setSec] = useState(() => Math.floor(playhead.get()))
  useEffect(() => {
    setSec(Math.floor(playhead.get()))
    return playhead.subscribe((s) => setSec(Math.floor(s)))
  }, [playhead])
  return sec
}
