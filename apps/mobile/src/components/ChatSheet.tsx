import { useState } from 'react'
import { FlatList, KeyboardAvoidingView, Pressable, StyleSheet, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated'
import { Send } from 'lucide-react-native'
import { Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { CHAT_MAX_CHARS, type ChatEntry } from '@/lib/social/feed'

/**
 * The cabin chat sheet: full history + input, pulled up over the film and dismissed with a tap
 * on the dimmed screen. Kept deliberately quiet — overlay surface, hairline top, mono names in
 * filament amber ("You" stays cool) — so returning to the movie feels like lights-down again.
 */

export function ChatSheet({
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

  if (!visible) return null

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    onSend(text)
    setDraft('')
  }

  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(160)} style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close chat" />
      </Animated.View>
      <KeyboardAvoidingView style={styles.avoider} pointerEvents="box-none">
        <Animated.View
          entering={SlideInDown.duration(260)}
          exiting={SlideOutDown.duration(200)}
          style={[styles.sheet, { backgroundColor: t.palette.overlay, borderColor: t.palette.hairline, paddingBottom: insets.bottom + 10 }]}
        >
          <View style={[styles.handle, { backgroundColor: t.palette.hairline }]} />
          <Text variant="eyebrow" tone="tertiary" style={styles.title}>
            CABIN CHAT
          </Text>
          <FlatList
            data={[...log].reverse()}
            inverted
            keyExtractor={(m, i) => `${m.at}-${i}`}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) => (
              <View style={styles.row}>
                <Text variant="data" style={{ color: item.from === 'You' ? t.palette.textSecondary : t.palette.amber }}>
                  {item.from.toLowerCase()}
                </Text>
                <Text variant="body" style={styles.msg}>
                  {item.text}
                </Text>
              </View>
            )}
            ListEmptyComponent={
              <Text variant="caption" tone="tertiary" style={styles.empty}>
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
              placeholderTextColor={t.palette.textTertiary}
              maxLength={CHAT_MAX_CHARS}
              returnKeyType="send"
              style={[styles.input, { color: t.palette.textPrimary, backgroundColor: t.palette.raised, borderColor: t.palette.hairline, fontFamily: t.fonts.monoRegular }]}
            />
            <Pressable
              onPress={submit}
              disabled={!draft.trim()}
              style={({ pressed }) => [
                styles.send,
                { backgroundColor: draft.trim() ? t.palette.amber : t.palette.raised },
                pressed && { transform: [{ scale: 0.94 }] },
              ]}
              accessibilityLabel="Send message"
            >
              <Send size={18} color={draft.trim() ? '#1A1206' : t.palette.textTertiary} strokeWidth={2.25} />
            </Pressable>
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  )
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill as object, backgroundColor: 'rgba(5,7,12,0.55)' },
  avoider: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '64%',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    paddingHorizontal: 16,
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginTop: 10 },
  title: { textAlign: 'center', marginTop: 10, marginBottom: 4 },
  list: { flexGrow: 0 },
  listContent: { paddingVertical: 8, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
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
  send: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
})
