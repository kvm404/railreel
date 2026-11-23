import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, FlatList, KeyboardAvoidingView, Pressable, StyleSheet, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated'
import { Send, X } from 'lucide-react-native'
import { Text } from '@/ui'
import { IconButton } from '@/ui/IconButton'
import { withAlpha } from '@/ui/alpha'
import { useTheme } from '@/theme/ThemeProvider'
import { radii } from '@/theme/tokens'
import { CHAT_MAX_CHARS, type ChatEntry } from '@/lib/social/feed'
import { useBackHandler } from '@/navigation/context'

/**
 * The cabin chat sheet: full history + input, pulled up over the film. Kept deliberately quiet —
 * overlay surface, hairline top, mono names in filament amber ("You" stays cool), mono
 * timestamps — so returning to the movie feels like lights-down again.
 *
 * It is a modal layer: the Player hides everything underneath from TalkBack while it is open
 * (importantForAccessibility on the underlay), focus moves to the sheet's title on open, and it
 * closes three ways — the visible ✕, a tap on the dimmed film, or Android Back.
 */

function clock(ms: number): string {
  const d = new Date(ms)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

export const ChatSheet = memo(function ChatSheet({
  visible,
  log,
  onSend,
  onClose,
}: {
  visible: boolean
  log: ChatEntry[]
  onSend: (text: string) => void
  onClose: () => void
}) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const [draft, setDraft] = useState('')
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

  if (!visible) return null

  const canSend = draft.trim().length > 0
  const submit = () => {
    const text = draft.trim()
    if (!text) return
    onSend(text)
    setDraft('')
  }

  return (
    <View style={styles.layer} accessibilityViewIsModal>
      <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(160)} style={[styles.backdrop, { backgroundColor: withAlpha(t.palette.void, 0.55) }]}>
        {/* The tap-outside target; TalkBack users get the explicit ✕ instead of a full-screen button. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} importantForAccessibility="no" accessible={false} />
      </Animated.View>
      <KeyboardAvoidingView style={styles.avoider} pointerEvents="box-none">
        <Animated.View
          entering={SlideInDown.duration(260)}
          exiting={SlideOutDown.duration(200)}
          style={[
            styles.sheet,
            {
              backgroundColor: t.palette.overlay,
              borderColor: t.palette.hairline,
              paddingBottom: insets.bottom + 10,
              paddingLeft: Math.max(16, insets.left),
              paddingRight: Math.max(16, insets.right),
            },
          ]}
        >
          <View style={[styles.handle, { backgroundColor: t.palette.hairline }]} />
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
            style={styles.list}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) => (
              <View
                style={styles.row}
                accessible
                accessibilityLabel={`${item.from === 'You' ? 'You' : item.from} at ${clock(item.at)}: ${item.text}`}
              >
                <View style={styles.meta}>
                  <Text
                    variant="data"
                    numberOfLines={1}
                    style={[styles.sender, { color: item.from === 'You' ? t.palette.textSecondary : t.palette.amber }]}
                  >
                    {item.from.toLowerCase()}
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
          <View style={[styles.inputRow, { borderColor: t.palette.hairline }]}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={submit}
              placeholder="Message the cabin…"
              placeholderTextColor={t.palette.textSecondary}
              maxLength={CHAT_MAX_CHARS}
              returnKeyType="send"
              accessibilityLabel="Message the cabin"
              style={[styles.input, { color: t.palette.textPrimary, backgroundColor: t.palette.raised, borderColor: t.palette.hairline, fontFamily: t.fonts.monoRegular }]}
            />
            <IconButton
              variant={canSend ? 'amber' : 'ghost'}
              size={44}
              radius={radii.md}
              disabled={!canSend}
              icon={(c) => <Send size={18} color={c} strokeWidth={2.25} />}
              accessibilityLabel="Send message"
              onPress={submit}
            />
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  )
})

const styles = StyleSheet.create({
  // Its own top layer: above captions, chrome and the social overlays.
  layer: { ...StyleSheet.absoluteFill, zIndex: 100, elevation: 100 },
  backdrop: { ...StyleSheet.absoluteFill },
  avoider: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '64%',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginTop: 10 },
  header: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  headerSide: { width: 48 },
  headerEnd: { alignItems: 'flex-end' },
  title: { flex: 1, alignItems: 'center' },
  list: { flexGrow: 0 },
  listContent: { paddingVertical: 8, gap: 12 },
  row: { gap: 2 },
  meta: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  // Long names truncate instead of squeezing the message into a sliver.
  sender: { maxWidth: '60%', flexShrink: 1 },
  time: { fontSize: 11 },
  msg: { flexShrink: 1 },
  empty: { textAlign: 'center', paddingVertical: 24 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 10, borderTopWidth: 1 },
  input: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 14,
  },
})
