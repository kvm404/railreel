import type { ReactNode } from 'react'
import { Linking, StyleSheet, View } from 'react-native'
import { CircleAlert, CircleCheck, Download, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react-native'
import { Screen } from '@/components/Screen'
import { SyncDots } from '@/components/SyncDots'
import { FilamentBar } from '@/components/FilamentBar'
import { Button, FlapText, Text } from '@/ui'
import { IconButton } from '@/ui/IconButton'
import { useTheme } from '@/theme/ThemeProvider'
import { radii } from '@/theme/tokens'
import { useSession } from '@/session/SessionProvider'
import { formatBytes } from '@/lib/storage'
import { formatClock, formatReleaseDate, formatVersion, RELEASES_PAGE_URL, type AvailableUpdate } from '@/lib/update/release'
import {
  cancelDownload,
  checkForUpdate,
  currentVersion,
  downloadUpdate,
  installUpdate,
  openInstallPermission,
  useAppUpdate,
  type UpdateState,
} from '@/hooks/useAppUpdate'

/**
 * About: what this build is, and the way to the next one. The version flips in on the split-flap
 * board; below it a single berth carries the update, whose state (checked, available, downloading,
 * needs Android's install permission, installing, failed) is the whole job of the screen.
 */
export function AboutScreen() {
  const t = useTheme()
  const s = useSession()
  const update = useAppUpdate()
  const version = currentVersion()
  // Installing replaces the app (it restarts), so never mid-session.
  const inSession = s.role !== 'none'

  return (
    <Screen title="ABOUT" scroll>
      <View style={styles.body}>
        <View style={styles.identity}>
          <Text variant="title">RailReel</Text>
          {version ? <FlapText value={`V${version}`} size={26} tone="amber" haptics={false} /> : null}
          <Text variant="body" tone="secondary" style={styles.lede}>
            Watch a movie together, each on your own phone, in sync. One phone shares it over its hotspot. No internet, no
            accounts.
          </Text>
        </View>

        <View style={[styles.berth, { backgroundColor: t.palette.raised, borderColor: t.palette.hairline }]}>
          <UpdateBerth state={update} version={version} inSession={inSession} />
        </View>

        <View style={styles.footer}>
          <Text variant="caption" tone="muted">
            Updates come from RailReel's GitHub releases. Checking is the only time the app uses the internet.
          </Text>
          <IconButton
            variant="ghost"
            size={36}
            label="Releases on GitHub"
            icon={(c) => <ExternalLink size={14} color={c} strokeWidth={2} />}
            accessibilityLabel="Open RailReel's releases on GitHub"
            onPress={() => void Linking.openURL(RELEASES_PAGE_URL).catch(() => {})}
            style={styles.footerLink}
          />
        </View>
      </View>
    </Screen>
  )
}

function UpdateBerth({ state, version, inSession }: { state: UpdateState; version: string; inSession: boolean }) {
  const t = useTheme()
  const guard = inSession ? (
    <Text variant="caption" tone="muted">
      Finish the session first. Installing an update restarts RailReel.
    </Text>
  ) : null

  switch (state.status) {
    case 'idle':
      return (
        <Row icon={<RefreshCw size={18} color={t.palette.textSecondary} strokeWidth={2.25} />} title="Updates" detail="Not checked yet">
          <Button title="Check for updates" intent="neutral" compact onPress={() => void checkForUpdate()} style={styles.start} />
        </Row>
      )
    case 'checking':
      return (
        <Row icon={<RefreshCw size={18} color={t.palette.textSecondary} strokeWidth={2.25} />} title="Checking GitHub…" detail={<SyncDots />} live />
      )
    case 'current':
      return (
        <Row
          icon={<CircleCheck size={18} color={t.palette.amber} strokeWidth={2.25} />}
          title="You're up to date"
          detail={`${version ? `v${version} is the latest release` : 'This is the latest release'} · checked ${formatClock(state.checkedAt)}`}
          live
        >
          <Button title="Check again" intent="neutral" compact onPress={() => void checkForUpdate()} style={styles.start} />
        </Row>
      )
    case 'available':
      return (
        <Row
          icon={<Download size={18} color={t.palette.amber} strokeWidth={2.25} />}
          title={`Version ${formatVersion(state.update.version)} is out`}
          detail={meta(state.update)}
          live
        >
          <Notes update={state.update} />
          {guard ?? (
            <Button
              title="Download and install"
              subtitle={`${formatBytes(state.update.sizeBytes)} from GitHub`}
              intent="amber"
              height={60}
              icon={<Download size={20} color={t.palette.onAmber} strokeWidth={2.25} />}
              onPress={() => void downloadUpdate()}
            />
          )}
        </Row>
      )
    case 'downloading': {
      const { update, receivedBytes } = state
      const p = update.sizeBytes > 0 ? Math.min(1, receivedBytes / update.sizeBytes) : 0
      return (
        <Row
          icon={<Download size={18} color={t.palette.amber} strokeWidth={2.25} />}
          title={`Downloading ${formatVersion(update.version)}`}
          detail={`${formatBytes(receivedBytes)} of ${formatBytes(update.sizeBytes)} · ${Math.round(p * 100)}%`}
        >
          <FilamentBar progress={p} label={`Downloading version ${formatVersion(update.version)}`} />
          <Button title="Cancel" intent="neutral" compact onPress={() => void cancelDownload()} style={styles.start} />
        </Row>
      )
    }
    case 'verifying':
      return (
        <Row
          icon={<ShieldCheck size={18} color={t.palette.amber} strokeWidth={2.25} />}
          title="Checking the download"
          detail="Making sure the file matches the release"
          live
        >
          <SyncDots />
        </Row>
      )
    case 'permission':
      return (
        <Row
          icon={<ShieldCheck size={18} color={t.palette.amber} strokeWidth={2.25} />}
          title="Allow RailReel to install updates"
          detail={'Android asks once. Turn on "Allow from this source" for RailReel, then come back. The install carries on by itself.'}
          live
        >
          <Button title="Open Android settings" intent="amber" height={56} onPress={() => void openInstallPermission()} />
        </Row>
      )
    case 'installing':
      return (
        <Row
          icon={<Download size={18} color={t.palette.amber} strokeWidth={2.25} />}
          title="Confirm in Android's installer"
          detail={`RailReel closes while it updates to ${formatVersion(state.update.version)}. Open it again once Android says it's installed.`}
          live
        >
          <Button title="Open the installer again" intent="neutral" compact onPress={() => void installUpdate()} style={styles.start} />
        </Row>
      )
    case 'error':
      return (
        <Row icon={<CircleAlert size={18} color={t.palette.danger} strokeWidth={2.25} />} title="That didn't work" detail={state.message} live>
          {state.update ? (
            guard ?? <Button title="Try again" intent="neutral" compact onPress={() => void downloadUpdate()} style={styles.start} />
          ) : (
            <Button title="Check again" intent="neutral" compact onPress={() => void checkForUpdate()} style={styles.start} />
          )}
        </Row>
      )
  }
}

/** One berth layout for every state: icon, title, a detail line, then the state's own content. */
function Row({
  icon,
  title,
  detail,
  live = false,
  children,
}: {
  icon: ReactNode
  title: string
  detail: ReactNode
  /** Announce the change to TalkBack (state results, not progress ticks). */
  live?: boolean
  children?: ReactNode
}) {
  return (
    <View style={styles.rowWrap}>
      <View style={styles.row} accessible accessibilityLiveRegion={live ? 'polite' : 'none'}>
        <View style={styles.icon}>{icon}</View>
        <View style={styles.rowText}>
          <Text variant="cardTitle">{title}</Text>
          {typeof detail === 'string' ? (
            <Text variant="caption" tone="muted">
              {detail}
            </Text>
          ) : (
            detail
          )}
        </View>
      </View>
      {children}
    </View>
  )
}

function Notes({ update }: { update: AvailableUpdate }) {
  const t = useTheme()
  if (update.notes.length === 0) return null
  return (
    <View style={styles.notes}>
      {update.notes.map((line, i) => (
        <View key={i} style={styles.note}>
          <View style={[styles.noteMark, { backgroundColor: t.palette.amberDeep }]} />
          <Text variant="caption" tone="secondary" style={styles.noteText}>
            {line}
          </Text>
        </View>
      ))}
      <IconButton
        variant="plain"
        size={32}
        label="Full release notes"
        icon={(c) => <ExternalLink size={13} color={c} strokeWidth={2} />}
        accessibilityLabel={`Open the full notes for version ${formatVersion(update.version)} on GitHub`}
        onPress={() => void Linking.openURL(update.pageUrl).catch(() => {})}
        style={styles.start}
      />
    </View>
  )
}

function meta(u: AvailableUpdate): string {
  const date = formatReleaseDate(u.publishedAt)
  return `${formatBytes(u.sizeBytes)}${date ? ` · released ${date}` : ''}`
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: 28, paddingTop: 12 },
  identity: { gap: 12 },
  lede: { maxWidth: 420 },
  berth: { padding: 16, borderWidth: 1, borderRadius: radii.lg },
  rowWrap: { gap: 16 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  icon: { paddingTop: 2 },
  rowText: { flex: 1, gap: 4 },
  start: { alignSelf: 'flex-start' },
  notes: { gap: 8 },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  noteMark: { width: 6, height: 6, borderRadius: 3, marginTop: 6 },
  noteText: { flex: 1 },
  footer: { gap: 6 },
  footerLink: { alignSelf: 'flex-start', marginLeft: -8 },
})
