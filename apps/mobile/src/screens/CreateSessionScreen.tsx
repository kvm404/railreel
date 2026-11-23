import { useEffect, useState } from 'react'
import { AppState, Share, StyleSheet, View } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import * as LegacyFS from 'expo-file-system/legacy'
import { Check, DoorClosed, Film, Share2, Subtitles, Wifi } from 'lucide-react-native'
import { Screen } from '@/components/Screen'
import { SyncDots } from '@/components/SyncDots'
import { InviteTicket } from '@/components/InviteTicket'
import { ConfirmSheet } from '@/components/ConfirmSheet'
import { Button, Text } from '@/ui'
import { useNavigation } from '@/navigation/context'
import { useTheme } from '@/theme/ThemeProvider'
import { radii } from '@/theme/tokens'
import { useSession } from '@/session/SessionProvider'
import { validateSrtFile } from '@/lib/subtitles/validate'
import {
  isPickerCacheCopy,
  probeExceedsLimit,
  SUBTITLE_PROBE_BYTES,
  SUBTITLE_TOO_LARGE_MESSAGE,
  subtitleSizeVerdict,
} from '@/lib/subtitles/pick'
import { inviteStatus, readHostNetwork } from '@/lib/net/hostNetwork'
import { activeGuestCount, endSessionBody, needsEndConfirmation } from '@/lib/host/endSession'
import { admission, inviteRosterLine, lobbyCtaLabel } from '@/lib/host/admission'

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

type BoundedRead = { ok: true; content: string } | { ok: false; message: string }

/**
 * Read a picked subtitle without ever loading an oversized file: judge the reported size first,
 * then the on-disk copy's, and only when neither is known probe a bounded slice (one byte past
 * the limit) before the full read.
 */
async function readSubtitleBounded(uri: string, reportedSize: number | undefined): Promise<BoundedRead> {
  const tooLarge: BoundedRead = { ok: false, message: SUBTITLE_TOO_LARGE_MESSAGE }
  if (subtitleSizeVerdict(reportedSize) === 'too-large') return tooLarge
  let diskSize: number | undefined
  try {
    const info = await LegacyFS.getInfoAsync(uri)
    diskSize = info.exists ? info.size : undefined
  } catch {
    diskSize = undefined
  }
  const verdict = subtitleSizeVerdict(reportedSize, diskSize)
  if (verdict === 'too-large') return tooLarge
  if (verdict === 'unknown') {
    const probe = await LegacyFS.readAsStringAsync(uri, {
      encoding: LegacyFS.EncodingType.Base64,
      position: 0,
      length: SUBTITLE_PROBE_BYTES,
    })
    if (probeExceedsLimit(probe)) return tooLarge
  }
  const content = await LegacyFS.readAsStringAsync(uri, { encoding: LegacyFS.EncodingType.UTF8 })
  return { ok: true, content }
}

export function CreateSessionScreen() {
  const t = useTheme()
  const nav = useNavigation()
  const s = useSession()
  const [subError, setSubError] = useState<string | null>(null)
  const [confirmEnd, setConfirmEnd] = useState(false)

  // The reachable address can change under a live invite (hotspot toggled, WiFi switched) — and
  // the screen is only revisited by coming back from the lobby or the foreground. Rebuild the
  // link on both so the QR on screen is never a stale one.
  const { refreshJoin } = s
  useEffect(() => {
    refreshJoin() // mount-only: back from the lobby re-reads the address
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshJoin()
    })
    return () => sub.remove()
  }, [refreshJoin])

  const pickSubtitle = async () => {
    setSubError(null)
    // The picker copies the chosen file into the app cache; that copy is ours to remove on EVERY
    // way out of this function (attached, rejected, failed) — never the user's original.
    let tempUri: string | null = null
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['*/*'],
        copyToCacheDirectory: true,
      })
      if (res.canceled || !res.assets[0]) return
      const asset = res.assets[0]
      if (isPickerCacheCopy(asset.uri, LegacyFS.cacheDirectory)) tempUri = asset.uri
      if (!asset.name.toLowerCase().endsWith('.srt')) {
        setSubError('Please select a valid .srt file')
        return
      }
      const read = await readSubtitleBounded(asset.uri, asset.size)
      if (!read.ok) {
        setSubError(read.message)
        return
      }
      // Validate BEFORE attaching: attachSubtitle stores whatever it is given, so an empty or
      // non-SRT file would replace a working subtitle with zero usable cues.
      const check = validateSrtFile(asset.name, read.content)
      if (!check.ok) {
        setSubError(check.message)
        return
      }
      await s.attachSubtitle(asset.name, read.content)
    } catch {
      setSubError('Failed to read subtitle file')
    } finally {
      if (tempUri) await LegacyFS.deleteAsync(tempUri, { idempotent: true }).catch(() => {})
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

  // Everyone who would be cut off by ending (requests included) vs. the door and the cabin, which
  // the invite reports separately: a request is an action for the host, not a passenger.
  const guests = activeGuestCount(s.participants)
  const door = admission(s.participants)
  const pending = door.pending.length

  // Backing out (header or hardware Back) of a live (or starting) session tears it down — servers,
  // keep-awake, roster — so the next session starts clean instead of inheriting a zombie; the stack
  // resets so nothing above Home survives the session.
  const exitSession = () => {
    if (s.hostPhase === 'idle') return nav.goBack()
    s.leave()
    nav.reset('Home')
  }

  // Both Back paths land here: with friends aboard the consequence is spelled out first.
  const requestExit = () => {
    if (needsEndConfirmation(s.hostPhase, guests)) setConfirmEnd(true)
    else exitSession()
  }
  // If the last guest leaves while the question is open there is nothing left to confirm.
  useEffect(() => {
    if (guests === 0) setConfirmEnd(false)
  }, [guests])

  const endSheet = (
    <ConfirmSheet
      visible={confirmEnd && guests > 0}
      icon={<DoorClosed size={32} color={t.palette.textSecondary} strokeWidth={1.75} />}
      title="End the session for everyone?"
      body={endSessionBody(guests)}
      confirmLabel="End session"
      cancelLabel="Keep hosting"
      onConfirm={() => {
        setConfirmEnd(false)
        exitSession()
      }}
      onCancel={() => setConfirmEnd(false)}
    />
  )

  // Before the session is live: a deliberate "choose a movie" step. (We open the picker on a tap
  // rather than on mount so it can't interrupt the screen-entry animation — that left the screen
  // mounted but invisible.) It scrolls so the button stays reachable in short windows / large text.
  if (s.hostPhase !== 'live') {
    const starting = s.hostPhase === 'starting'
    return (
      <Screen title="NEW SESSION" scroll onBack={requestExit}>
        <View style={styles.center}>
          <Film size={40} color={t.palette.amber} strokeWidth={1.75} />
          <Text variant="title" style={{ textAlign: 'center' }}>
            Share a movie with the cabin
          </Text>
          <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>
            Pick a video on this phone — friends download their own copy and watch in sync.
          </Text>
          {s.error ? (
            <Text variant="caption" tone="amber" accessibilityLiveRegion="polite" style={{ textAlign: 'center' }}>
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
  // A reachable address is not proof of a hotspot: claim only what the network told us.
  const invite = inviteStatus(live, readHostNetwork(s))

  return (
    <Screen title="NEW SESSION" scroll onBack={requestExit}>
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

        {/* subtitles: the info gets the full card width, the actions sit on their own row */}
        <View style={[styles.subCard, { borderColor: t.palette.hairline, backgroundColor: t.palette.raised }]}>
          <View style={styles.subInfo}>
            <Subtitles size={18} color={s.subtitle ? t.palette.amber : t.palette.textMuted} strokeWidth={2.25} />
            <View style={{ flex: 1 }}>
              <Text variant="eyebrow" tone="muted">
                SUBTITLES (OPTIONAL)
              </Text>
              <Text variant="cardTitle" numberOfLines={2}>
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
          </View>
          <View style={styles.subActions}>
            {s.subtitle ? (
              <>
                <Button title="Replace" intent="neutral" compact onPress={pickSubtitle} />
                <Button title="Remove" intent="danger" compact onPress={s.removeSubtitle} />
              </>
            ) : (
              <Button title="Attach .srt" intent="neutral" compact onPress={pickSubtitle} />
            )}
          </View>
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

        {/* guided steps: the invite first, then friends join the network, then they find the cabin */}
        <View style={[styles.steps, { borderColor: t.palette.hairline }]}>
          <Step n={1} done={invite.ready} active={!invite.ready} title={invite.title} body={invite.body}>
            {/* Always available: the address can change under a live invite (hotspot/WiFi switch). */}
            <Button
              title="Refresh link"
              intent="cyan"
              compact
              icon={<Wifi size={14} color={t.palette.cyan} strokeWidth={2.5} />}
              onPress={s.refreshJoin}
            />
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

        <View style={styles.waiting} accessible accessibilityLiveRegion="polite">
          {pending > 0 ? <View style={[styles.doorDot, { backgroundColor: t.palette.amber }]} /> : <SyncDots />}
          <Text variant="data" tone={pending > 0 ? 'amber' : 'secondary'}>
            {inviteRosterLine({ pending, admitted: door.admitted.length })}
          </Text>
        </View>

        {s.hostWarning ? (
          <Text variant="caption" tone="amber" style={{ textAlign: 'center' }}>
            {s.hostWarning}
          </Text>
        ) : null}

        <Button
          title={lobbyCtaLabel(pending)}
          subtitle={pending > 0 ? 'Approve or deny in the lobby' : undefined}
          intent="amber"
          height={64}
          onPress={() => nav.navigate('Lobby')}
        />
      </View>
      {endSheet}
    </Screen>
  )
}

/**
 * One numbered step of the host's guided setup. `done` = amber check, `active` = the one to do now.
 * Only the explanatory text is one accessible element; an action in `children` stays its own
 * focusable control (grouping it would hide the button from TalkBack).
 */
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
    <View style={styles.stepRow}>
      <View style={styles.stepRail} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
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
        <View accessible accessibilityLabel={`Step ${n}. ${title}. ${body}${done ? ' Done.' : ''}`} style={styles.stepText}>
          <Text variant="cardTitle" tone={done || active ? 'primary' : 'secondary'}>
            {title}
          </Text>
          <Text variant="caption" tone="muted">
            {body}
          </Text>
        </View>
        {children ? <View style={{ alignSelf: 'flex-start', marginTop: 8 }}>{children}</View> : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: 16, paddingTop: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18, paddingHorizontal: 24, paddingVertical: 16 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
    borderWidth: 1,
    borderRadius: radii.lg,
  },
  subCard: { gap: 12, padding: 14, borderWidth: 1, borderRadius: radii.lg },
  subInfo: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  subActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 },
  steps: { borderWidth: 1, borderRadius: radii.lg, padding: 16 },
  stepRow: { flexDirection: 'row', gap: 14 },
  stepRail: { alignItems: 'center' },
  stepBadge: { width: 28, height: 28, borderRadius: 14, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  stepLine: { flex: 1, width: 1, marginVertical: 4 },
  stepBody: { flex: 1, paddingBottom: 16 },
  stepText: { gap: 2 },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'center' },
  doorDot: { width: 8, height: 8, borderRadius: 4 },
})
