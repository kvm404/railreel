import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, FlatList, Keyboard, Pressable, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated'
import { Send, X } from 'lucide-react-native'
import { Text } from '@/ui'
import { IconButton } from '@/ui/IconButton'
import { withAlpha } from '@/ui/alpha'
import { useReduceMotion } from '@/hooks/useReduceMotion'
import { useTheme } from '@/theme/ThemeProvider'
import { fonts, motion, radii, sheet, sizes } from '@/theme/tokens'
import { CHAT_MAX_CHARS, type ChatEntry } from '@/lib/social/feed'
import { useBackHandler } from '@/navigation/context'

/**
 * The cabin chat sheet: full history + input, pulled up over the film. Kept deliberately quiet —
 * overlay surface, hairline top, names in filament amber ("You" stays cool), mono timestamps — so
 * returning to the movie feels like lights-down again. People's words are set in Space Grotesk;
 * only the timestamps are instrumentation (Space Mono).
 *
 * It is a modal layer: the Player hides everything underneath from TalkBack while it is open
 * (importantForAccessibility on the underlay), focus moves to the sheet's title on open, and it
 * closes three ways — the visible ✕, a tap on the dimmed film, or Android Back.
 *
 * A line leaves the composer only once the session ACCEPTED it (`onSend` returns true); while the
 * link to the host is reconnecting, Send is disabled and says so, and the draft stays put.
 *
 * Keyboard: the app's one strategy is Android `adjustResize` (the window shrinks). In a compact
 * window (landscape) or with the keyboard up, the sheet takes all of the remaining height — the
 * composer pinned at the bottom, the history shrinking above it — instead of a share of a window
 * that may be only ~140dp tall.
 */

function clock(ms: number): string {
  const d = new Date(ms)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

/** Follow the soft keyboard (Android fires the did* events). */
function useKeyboardOpen(enabled: boolean): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!enabled) {
      setOpen(false)
      return
    }
    const show = Keyboard.addListener('keyboardDidShow', () => setOpen(true))
    const hide = Keyboard.addListener('keyboardDidHide', () => setOpen(false))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [enabled])
  return open
}

export const ChatSheet = memo(function ChatSheet({
  visible,
  log,
  onSend,
  onClose,
  reconnecting = false,
}: {
  visible: boolean
  log: ChatEntry[]
  /** Returns whether the line was accepted for sending; the draft is kept when it wasn't. */
  onSend: (text: string) => boolean
  onClose: () => void
  /** The link to the host is down and being re-established — sending would be lost. */
  reconnecting?: boolean
}) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  const reduced = useReduceMotion()
  const keyboardOpen = useKeyboardOpen(visible)
  const [draft, setDraft] = useState('')
  const [sendFailed, setSendFailed] = useState(false)
  const titleRef = useRef<View>(null)
  // Android Back closes the sheet first — it must never leave the show from under the chat.
  useBackHandler(
    () => {
      onClose()
      return true
    },
    { enabled: visible, layer: 'overlay' },
  )

  // Newest-first for the inverted list. Memoized on the log so an unrelated Player render
  // doesn't hand FlatList a fresh array; keys are message ids, so appends never remount rows.
  const rows = useMemo(() => [...log].reverse(), [log])

  // Move screen-reader focus into the sheet when it opens (the underlay is hidden meanwhile).
  useEffect(() => {
    if (!visible) return
    const id = setTimeout(() => {
      if (titleRef.current) AccessibilityInfo.sendAccessibilityEvent(titleRef.current, 'focus')
    }, 300)
    return () => clearTimeout(id)
  }, [visible])

  // A failed send is old news once the link is back or the line changes.
  useEffect(() => {
    if (!reconnecting) setSendFailed(false)
  }, [reconnecting])

  if (!visible) return null

  const compact = keyboardOpen || height < sizes.compactHeight
  const hasText = draft.trim().length > 0
  const canSend = hasText && !reconnecting
  const submit = () => {
    const text = draft.trim()
    if (!text || reconnecting) return
    if (onSend(text)) {
      setDraft('')
      setSendFailed(false)
    } else {
      setSendFailed(true) // keep every character; they can send again in a moment
    }
  }
  const status = reconnecting ? 'Reconnecting… your message will wait here.' : sendFailed ? 'Couldn’t send — try again.' : null

  // Reduce-motion: no travel, just a quick fade (read live — the OS setting can flip mid-show).
  const sheetIn = reduced ? FadeIn.duration(motion.fade) : SlideInDown.duration(motion.sheetIn)
  const sheetOut = reduced ? FadeOut.duration(motion.fade) : SlideOutDown.duration(motion.sheetOut)

  return (
    <View style={styles.layer} accessibilityViewIsModal>
      <Animated.View
        entering={FadeIn.duration(motion.fade)}
        exiting={FadeOut.duration(motion.fade)}
        style={[styles.backdrop, { backgroundColor: withAlpha(t.palette.void, 0.55) }]}
      >
        {/* The tap-outside target; TalkBack users get the explicit ✕ instead of a full-screen button. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} importantForAccessibility="no" accessible={false} />
      </Animated.View>
      <View style={styles.dock} pointerEvents="box-none">
        <Animated.View
          entering={sheetIn}
          exiting={sheetOut}
          style={[
            styles.sheet,
            compact ? [styles.sheetCompact, { marginTop: keyboardOpen ? 0 : insets.top }] : styles.sheetResting,
            {
              backgroundColor: t.palette.overlay,
              borderColor: t.palette.hairline,
              // The keyboard covers the gesture bar, so its inset would only push the composer up.
              paddingBottom: keyboardOpen ? 8 : insets.bottom + 10,
              paddingLeft: Math.max(16, insets.left),
              paddingRight: Math.max(16, insets.right),
            },
          ]}
        >
          {compact ? null : <View style={[styles.handle, { backgroundColor: t.palette.hairline }]} />}
          <View style={styles.header}>
            <View style={styles.headerSide} />
            <View ref={titleRef} style={styles.title} accessible accessibilityRole="header" accessibilityLabel="Cabin chat">
              <Text variant="eyebrow" tone="secondary">
                CABIN CHAT
              </Text>
            </View>
            <View style={[styles.headerSide, styles.headerEnd]}>
              <IconButton
                variant="plain"
                size={36}
                minTouch={sizes.touch}
                haptic="none"
                icon={(c) => <X size={18} color={c} strokeWidth={2.25} />}
                accessibilityLabel="Close chat"
                onPress={onClose}
              />
            </View>
          </View>
          <FlatList
            data={rows}
            inverted
            keyExtractor={(m) => String(m.id)}
            style={compact ? styles.listCompact : styles.list}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <View
                style={styles.row}
                accessible
                accessibilityLabel={`${item.from === 'You' ? 'You' : item.from} at ${clock(item.at)}: ${item.text}`}
              >
                <View style={styles.meta}>
                  <Text
                    variant="caption"
                    numberOfLines={1}
                    style={[styles.sender, { color: item.from === 'You' ? t.palette.textSecondary : t.palette.amber }]}
                  >
                    {item.from}
                  </Text>
                  <Text variant="data" tone="secondary" style={styles.time}>
                    {clock(item.at)}
                  </Text>
                </View>
                <Text variant="body" style={styles.msg}>
                  {item.text}
                </Text>
              </View>
            )}
            ListEmptyComponent={
              <Text variant="caption" tone="secondary" style={styles.empty}>
                Say something — the whole cabin hears it.
              </Text>
            }
          />
          {status ? (
            <Text
              variant="caption"
              tone="secondary"
              style={styles.status}
              accessibilityLiveRegion="polite"
              numberOfLines={1}
            >
              {status}
            </Text>
          ) : null}
          <View style={[styles.inputRow, { borderColor: t.palette.hairline }]}>
            <TextInput
              value={draft}
              onChangeText={(v) => {
                setDraft(v)
                if (sendFailed) setSendFailed(false)
              }}
              onSubmitEditing={submit}
              submitBehavior="submit"
              placeholder="Message the cabin…"
              placeholderTextColor={t.palette.textSecondary}
              maxLength={CHAT_MAX_CHARS}
              returnKeyType="send"
              accessibilityLabel="Message the cabin"
              style={[
                styles.input,
                { color: t.palette.textPrimary, backgroundColor: t.palette.raised, borderColor: t.palette.hairline, fontFamily: t.fonts.bodyRegular },
              ]}
            />
            <IconButton
              variant={canSend ? 'amber' : 'ghost'}
              size={sizes.touch}
              minTouch={sizes.touch}
              radius={radii.md}
              disabled={!canSend}
              icon={(c) => <Send size={18} color={c} strokeWidth={2.25} />}
              accessibilityLabel={reconnecting ? 'Send message, unavailable while reconnecting' : 'Send message'}
              onPress={submit}
            />
          </View>
        </Animated.View>
      </View>
    </View>
  )
})

const styles = StyleSheet.create({
  // Its own top layer: above captions, chrome and the social overlays.
  layer: { ...StyleSheet.absoluteFill, zIndex: 100, elevation: 100 },
  backdrop: { ...StyleSheet.absoluteFill },
  dock: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: sheet.radius,
    borderTopRightRadius: sheet.radius,
    borderTopWidth: 1,
  },
  sheetResting: { maxHeight: `${sheet.maxHeightPct}%` },
  // All the height there is; the history (flex) gives way, the composer stays pinned.
  sheetCompact: { flex: 1 },
  handle: { alignSelf: 'center', width: sheet.handleWidth, height: sheet.handleHeight, borderRadius: sheet.handleHeight / 2, marginTop: 10 },
  header: { flexDirection: 'row', alignItems: 'center', minHeight: sizes.touch, marginTop: 2 },
  headerSide: { width: sizes.touch },
  headerEnd: { alignItems: 'flex-end' },
  title: { flex: 1, alignItems: 'center' },
  list: { flexGrow: 0, flexShrink: 1 },
  listCompact: { flex: 1 },
  listContent: { paddingVertical: 8, gap: 12 },
  row: { gap: 2 },
  meta: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  // Long names truncate instead of squeezing the message into a sliver.
  sender: { maxWidth: '60%', flexShrink: 1, fontFamily: fonts.bodyBold },
  time: { fontSize: 11 },
  msg: { flexShrink: 1 },
  empty: { textAlign: 'center', paddingVertical: 24 },
  status: { textAlign: 'center', paddingBottom: 6 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 10, borderTopWidth: 1 },
  input: {
    flex: 1,
    height: sizes.touch,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 15,
  },
})
