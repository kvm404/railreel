import { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Screen } from '@/components/Screen'
import { FilamentRing } from '@/components/FilamentRing'
import { Button, FlapText, Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import type { NavParams } from '@/navigation/context'

/**
 * The lobby: each friend's download/buffer readiness as a filament ring; the board flips
 * to READY and Start ignites when everyone's aboard. (v1 mock — progress is simulated
 * until the real transfer layer lands.) See docs/design-language.md.
 */

type Person = { name: string; progress: number; speed: number }

const INITIAL: Person[] = [
  { name: 'You', progress: 1, speed: 0 },
  { name: 'Aanya', progress: 0.62, speed: 0.06 },
  { name: 'Kabir', progress: 0.34, speed: 0.09 },
  { name: 'Mira', progress: 0.15, speed: 0.05 },
]

export function LobbyScreen({ params }: { params?: NavParams }) {
  const t = useTheme()
  const title = (params?.title as string) ?? 'Dune · Part Two'
  const [people, setPeople] = useState<Person[]>(INITIAL)

  // Simulate everyone buffering up to ready.
  useEffect(() => {
    const id = setInterval(() => {
      setPeople((prev) => {
        if (prev.every((p) => p.progress >= 1)) return prev
        return prev.map((p) => ({ ...p, progress: Math.min(1, p.progress + p.speed) }))
      })
    }, 600)
    return () => clearInterval(id)
  }, [])

  const aboard = people.filter((p) => p.progress >= 1).length
  const ready = aboard === people.length

  return (
    <Screen title="LOBBY">
      <View style={styles.body}>
        <View style={styles.head}>
          <Text variant="title" numberOfLines={1}>
            {title}
          </Text>
          <View style={styles.count}>
            <FlapText value={ready ? 'READY' : `${aboard}/${people.length}`} size={22} tone={ready ? 'amber' : 'cyan'} stagger={40} />
            <Text variant="eyebrow" tone="tertiary" style={{ marginTop: 6 }}>
              {ready ? 'EVERYONE ABOARD' : 'ABOARD'}
            </Text>
          </View>
        </View>

        <View style={styles.grid}>
          {people.map((p) => (
            <View key={p.name} style={[styles.person, { borderColor: t.palette.hairline, backgroundColor: t.palette.raised }]}>
              <FilamentRing progress={p.progress} size={84} />
              <Text variant="cardTitle" style={{ marginTop: 10 }}>
                {p.name}
              </Text>
              <Text variant="data" tone="tertiary">
                {p.progress >= 1 ? 'ready' : `${Math.round(p.progress * 100)}%`}
              </Text>
            </View>
          ))}
        </View>

        <View style={{ flex: 1 }} />

        <Button
          title={ready ? 'Start the show' : 'Waiting for everyone…'}
          subtitle={ready ? 'Lights down — everyone in sync' : undefined}
          intent="amber"
          height={72}
          disabled={!ready}
        />
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: 18, paddingTop: 8 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  count: { alignItems: 'flex-end' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  person: {
    width: '47.5%',
    flexGrow: 1,
    alignItems: 'center',
    paddingVertical: 20,
    borderWidth: 1,
    borderRadius: 18,
  },
})
