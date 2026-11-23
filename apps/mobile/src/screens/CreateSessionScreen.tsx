import { useState } from 'react'
import { Share, StyleSheet, View } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import * as LegacyFS from 'expo-file-system/legacy'
import { Check, Film, Share2, Subtitles, Wifi } from 'lucide-react-native'
import { Screen } from '@/components/Screen'
import { SyncDots } from '@/components/SyncDots'
import { InviteTicket } from '@/components/InviteTicket'
import { Button, Text } from '@/ui'
import { useNavigation } from '@/navigation/context'
import { useTheme } from '@/theme/ThemeProvider'
import { radii } from '@/theme/tokens'
import { useSession } from '@/session/SessionProvider'
import { validateSrtFile } from '@/lib/subtitles/validate'

/**
 * Host's "ready to invite" screen. Opens the movie picker, starts the native HTTP+WS servers,
 * and shows the real QR ticket + split-flap join code + the guided hotspot steps. The session
 * lives in the store so it survives the trip into the lobby. See docs/design-language.md.
 */

function fmtSize(bytes: number): string {
  if (bytes <= 0) return '—'
  const gb = bytes / 1e9
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

export function CreateSessionScreen() {
  const t = useTheme()
  const nav = useNavigation()
  const s = useSession()
  const [subError, setSubError] = useState<string | null>(null)

  const pickSubtitle = async () => {
    setSubError(null)
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['*/*'],
        copyToCacheDirectory: true,
      })
      if (res.canceled || !res.assets[0]) return
      const asset = res.assets[0]
      if (!asset.name.toLowerCase().endsWith('.srt')) {
        setSubError('Please select a valid .srt file')
        return
      }
      const content = await LegacyFS.readAsStringAsync(asset.uri, {
        encoding: LegacyFS.EncodingType.UTF8,
      })
      // Validate BEFORE attaching: attachSubtitle stores whatever it is given, so an empty or
      // non-SRT file would replace a working subtitle with zero usable cues.
      const check = validateSrtFile(asset.name, content)
      if (!check.ok) {
        setSubError(check.message)
        return
      }
      await s.attachSubtitle(asset.name, content)
    } catch {
      setSubError('Failed to read subtitle file')
    }
  }

  // The system share sheet (Messages, WhatsApp, Copy…): a full invite link is what Join's paste
  // field accepts — the short code alone cannot carry the host address offline.
  const shareInvite = async () => {
    if (!s.joinUrl) return
    try {
      await Share.share({ message: `Join my RailReel cabin (connect to my hotspot first): ${s.joinUrl}` })
    } catch {
      // The sheet failing to open is not actionable; the QR and code are still on screen.
    }
  }

  const guests = s.participants.filter((p) => p.id !== 'host').length

  // Backing out (header or hardware Back) of a live (or starting) session tears it down — servers,
  // keep-awake, roster — so the next session starts clean instead of inheriting a zombie; the stack
  // resets so nothing above Home survives the session.
  const exitSession = () => {
    if (s.hostPhase === 'idle') return nav.goBack()
    s.leave()
    nav.reset('Home')
  }

  // Before the session is live: a deliberate "choose a movie" step. (We open the picker on a tap
  // rather than on mount so it can't interrupt the screen-entry animation — that left the screen
  // mounted but invisible.)
  if (s.hostPhase !== 'live') {
    const starting = s.hostPhase === 'starting'
    return (
      <Screen title="NEW SESSION" onBack={exitSession}>
        <View style={styles.center}>
          <Film size={40} color={t.palette.amber} strokeWidth={1.75} />
          <Text variant="title" style={{ textAlign: 'center' }}>
            Share a movie with the cabin
          </Text>
          <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>
            Pick a video on this phone — friends download their own copy and watch in sync.
          </Text>
          {s.error ? (
            <Text variant="caption" tone="amber" style={{ textAlign: 'center' }}>
              {s.error}
            </Text>
          ) : null}
          {starting ? <SyncDots /> : null}
          <Button
            title={starting ? 'Opening…' : s.error ? 'Try another movie' : 'Choose a movie'}
            intent="amber"
            height={64}
            disabled={starting}
            onPress={() => s.startHost()}
          />
        </View>
      </Screen>
    )
  }

  const live = s.joinUrl != null
  const code = s.joinCode

  return (
    <Screen title="NEW SESSION" scroll onBack={exitSession}>
      <View style={styles.body}>
        {/* now sharing */}
        <View style={[styles.card, { borderColor: t.palette.hairline, backgroundColor: t.palette.raised }]}>
          <Film size={18} color={t.palette.amber} strokeWidth={2.25} />
          <View style={{ flex: 1 }}>
            <Text variant="eyebrow" tone="muted">
              NOW SHARING
            </Text>
            <Text variant="cardTitle" numberOfLines={1}>
              {s.movie?.title ?? 'Movie'}
            </Text>
          </View>
          <Text variant="data" tone="muted">
            {fmtSize(s.movie?.sizeBytes ?? 0)}
          </Text>
        </View>

        {/* subtitles */}
        <View style={[styles.card, { borderColor: t.palette.hairline, backgroundColor: t.palette.raised }]}>
          <Subtitles size={18} color={s.subtitle ? t.palette.amber : t.palette.textMuted} strokeWidth={2.25} />
          <View style={{ flex: 1 }}>
            <Text variant="eyebrow" tone="muted">
              SUBTITLES (OPTIONAL)
            </Text>
            <Text variant="cardTitle" numberOfLines={1}>
              {s.subtitle ? s.subtitle.name : 'None attached'}
            </Text>
            {s.subtitle ? (
              <Text variant="caption" tone="secondary">
                {`${s.subtitle.cues.length} cues`}
              </Text>
            ) : null}
            {subError ? (
              <Text variant="caption" tone="danger" accessibilityLiveRegion="polite">
                {subError}
              </Text>
            ) : null}
          </View>
          {s.subtitle ? (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button title="Replace" intent="neutral" compact onPress={pickSubtitle} />
              <Button title="Remove" intent="danger" compact onPress={s.removeSubtitle} />
            </View>
          ) : (
            <Button title="Attach .srt" intent="neutral" compact onPress={pickSubtitle} />
          )}
        </View>

        {/* invite ticket — QR + join code (only once we have a reachable address) */}
        {live ? (
          <>
            <InviteTicket joinUrl={s.joinUrl!} code={code} hostIp={s.hostIp} />
            <Button
              title="Share invite link"
              subtitle="For friends who can't scan — they paste it on Join"
              intent="neutral"
              height={60}
              icon={<Share2 size={20} color={t.palette.textPrimary} strokeWidth={2.25} />}
              onPress={shareInvite}
            />
          </>
        ) : null}

        {/* guided steps: hotspot first, then friends join it, then they find the cabin */}
        <View style={[styles.steps, { borderColor: t.palette.hairline }]}>
          <Step
            n={1}
            done={live}
            active={!live}
            title={live ? 'Hotspot is on' : 'Turn on your hotspot'}
            body={
              live
                ? 'Keep it on for the whole movie. Name it so friends recognize it.'
                : 'No reachable address yet. Enable your hotspot, then refresh to show the invite.'}
          >
            {!live ? <Button title="Refresh link" intent="cyan" compact icon={<Wifi size={14} color={t.palette.cyan} strokeWidth={2.5} />} onPress={s.refreshJoin} /> : null}
          </Step>
          <Step
            n={2}
            title="Friends join your hotspot"
            body="On their phones: Settings → WiFi → your hotspot's name. RailReel needs no internet."
          />
          <Step
            n={3}
            last
            title={code ? `Then they pick cabin ${code}` : 'Then they pick your cabin'}
            body="On Join they tap the cabin with the matching code, or scan the QR above."
          />
        </View>

        <View style={styles.waiting}>
          <SyncDots />
          <Text variant="data" tone="secondary">
            {guests > 0 ? `${guests} aboard` : 'Waiting for guests…'}
          </Text>
        </View>

        {s.hostWarning ? (
          <Text variant="caption" tone="amber" style={{ textAlign: 'center' }}>
            {s.hostWarning}
          </Text>
        ) : null}

        <Button title="Open lobby" intent="amber" height={64} onPress={() => nav.navigate('Lobby')} />
      </View>
    </Screen>
  )
}

/** One numbered step of the host's guided setup. `done` = amber check, `active` = the one to do now. */
function Step({
  n,
  title,
  body,
  done = false,
  active = false,
  last = false,
  children,
}: {
  n: number
  title: string
  body: string
  done?: boolean
  active?: boolean
  last?: boolean
  children?: React.ReactNode
}) {
  const t = useTheme()
  const accent = done ? t.palette.amber : active ? t.palette.cyan : t.palette.hairline
  return (
    <View style={styles.stepRow} accessible accessibilityLabel={`Step ${n}. ${title}. ${body}${done ? ' Done.' : ''}`}>
      <View style={styles.stepRail}>
        <View
          style={[
            styles.stepBadge,
            { borderColor: accent, backgroundColor: done ? t.palette.amber : 'transparent' },
          ]}
        >
          {done ? (
            <Check size={14} color={t.palette.onAmber} strokeWidth={3} />
          ) : (
            <Text variant="eyebrow" tone={active ? 'cyan' : 'muted'}>
              {n}
            </Text>
          )}
        </View>
        {last ? null : <View style={[styles.stepLine, { backgroundColor: t.palette.hairline }]} />}
      </View>
      <View style={[styles.stepBody, last && { paddingBottom: 0 }]}>
        <Text variant="cardTitle" tone={done || active ? 'primary' : 'secondary'}>
          {title}
        </Text>
        <Text variant="caption" tone="muted">
          {body}
        </Text>
        {children ? <View style={{ alignSelf: 'flex-start', marginTop: 8 }}>{children}</View> : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: 16, paddingTop: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18, paddingHorizontal: 24 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
    borderWidth: 1,
    borderRadius: radii.lg,
  },
  steps: { borderWidth: 1, borderRadius: radii.lg, padding: 16 },
  stepRow: { flexDirection: 'row', gap: 14 },
  stepRail: { alignItems: 'center' },
  stepBadge: { width: 28, height: 28, borderRadius: 14, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  stepLine: { flex: 1, width: 1, marginVertical: 4 },
  stepBody: { flex: 1, gap: 2, paddingBottom: 16 },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'center' },
})
