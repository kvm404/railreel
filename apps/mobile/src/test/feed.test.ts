import { describe, it, expect } from 'vitest'
import {
  appendCapped,
  CHAT_MAX_CHARS,
  isValidReaction,
  liveReactions,
  reactionLane,
  sanitizeChatText,
  tickerWindow,
  type ChatEntry,
  type ReactionEvent,
} from '@/lib/social/feed'

const line = (at: number, text = 'hi'): ChatEntry => ({ from: 'asha', text, at })
const rx = (seq: number, at: number): ReactionEvent => ({ seq, from: 'ben', emoji: '❤️', at })

describe('sanitizeChatText', () => {
  it('trims and collapses whitespace', () => {
    expect(sanitizeChatText('  hello   there \n friend  ')).toBe('hello there friend')
  })

  it('bounds the length', () => {
    expect(sanitizeChatText('x'.repeat(500)).length).toBe(CHAT_MAX_CHARS)
  })

  it('reduces whitespace-only input to empty (caller drops it)', () => {
    expect(sanitizeChatText('   \n\t ')).toBe('')
  })
})

describe('isValidReaction', () => {
  it('accepts an emoji and rejects paragraphs/padded strings', () => {
    expect(isValidReaction('❤️')).toBe(true)
    expect(isValidReaction('🍿')).toBe(true)
    expect(isValidReaction('')).toBe(false)
    expect(isValidReaction('hello there friend')).toBe(false)
    expect(isValidReaction(' ❤️')).toBe(false)
  })
})

describe('appendCapped', () => {
  it('appends under the cap and drops the oldest over it', () => {
    let log: number[] = []
    for (let i = 0; i < 5; i++) log = appendCapped(log, i, 3)
    expect(log).toEqual([2, 3, 4])
  })
})

describe('tickerWindow', () => {
  it('returns the last fresh lines, oldest first', () => {
    const log = [line(1000, 'a'), line(2000, 'b'), line(3000, 'c'), line(4000, 'd')]
    expect(tickerWindow(log, 5000, 6000, 3).map((l) => l.text)).toEqual(['b', 'c', 'd'])
  })

  it('drops lines older than the window', () => {
    const log = [line(1000, 'old'), line(9000, 'fresh')]
    expect(tickerWindow(log, 10_000, 6000, 3).map((l) => l.text)).toEqual(['fresh'])
  })

  it('is empty when everything has faded', () => {
    expect(tickerWindow([line(1000)], 60_000)).toEqual([])
  })
})

describe('reactionLane', () => {
  it('cycles deterministically over the lanes', () => {
    expect([0, 1, 2, 3, 4, 5].map((s) => reactionLane(s, 4))).toEqual([0, 1, 2, 3, 0, 1])
  })
})

describe('liveReactions', () => {
  it('keeps only reactions younger than their life', () => {
    const events = [rx(1, 1000), rx(2, 4000)]
    expect(liveReactions(events, 5000, 2500).map((e) => e.seq)).toEqual([2])
  })

  it('caps a burst to the newest few', () => {
    const burst = [1, 2, 3, 4, 5, 6].map((s) => rx(s, 4900 + s))
    expect(liveReactions(burst, 5000, 2500, 4).map((e) => e.seq)).toEqual([3, 4, 5, 6])
  })
})
