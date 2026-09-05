/**
 * SubRip (.srt) subtitle parser and formatting utilities.
 *
 * Implements standard SubRip timecode parsing, multiline text preservation,
 * basic HTML styling tag extraction (<i>, <b>, <u>), BOM normalization,
 * and robust error recovery for malformed or out-of-order blocks.
 */

import type { SubtitleCue, SubtitleLine, SubtitleSpan } from './types'

const TIMESTAMP_REGEX =
  /^\s*(\d{1,4}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,4}):(\d{2}):(\d{2})[,.](\d{1,3})/

/**
 * Decode common HTML entities found in subtitle files.
 */
export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => {
      const num = Number.parseInt(code, 10)
      return Number.isNaN(num) ? _ : String.fromCharCode(num)
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const num = Number.parseInt(hex, 16)
      return Number.isNaN(num) ? _ : String.fromCharCode(num)
    })
}

/**
 * Strip all HTML tags while preserving inner text and decoding entities.
 */
export function stripHtmlTags(str: string): string {
  return decodeHtmlEntities(str.replace(/<[^>]*>/g, '')).trim()
}

/**
 * Parse a line of subtitle text into styled spans (italic, bold, underline).
 */
export function parseSpans(lineText: string): SubtitleSpan[] {
  const tagRegex = /<\/?[a-zA-Z0-9]+(?:\s+[^>]*)?>/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  let italic = false
  let bold = false
  let underline = false

  const spans: SubtitleSpan[] = []

  const pushText = (raw: string) => {
    if (!raw) return
    const text = decodeHtmlEntities(raw)
    if (text) {
      spans.push({
        text,
        ...(italic ? { italic: true } : {}),
        ...(bold ? { bold: true } : {}),
        ...(underline ? { underline: true } : {}),
      })
    }
  }

  while ((match = tagRegex.exec(lineText)) !== null) {
    if (match.index > lastIndex) {
      pushText(lineText.slice(lastIndex, match.index))
    }
    lastIndex = tagRegex.lastIndex

    const tagStr = match[0]?.toLowerCase() ?? ''
    const isClosing = tagStr.startsWith('</')
    const tagNameMatch = /<\/?([a-zA-Z0-9]+)/.exec(tagStr)
    const tagName = tagNameMatch && tagNameMatch[1] ? tagNameMatch[1] : ''

    if (tagName === 'i') {
      italic = !isClosing
    } else if (tagName === 'b') {
      bold = !isClosing
    } else if (tagName === 'u') {
      underline = !isClosing
    }
  }

  if (lastIndex < lineText.length) {
    pushText(lineText.slice(lastIndex))
  }

  if (spans.length === 0) {
    spans.push({ text: '' })
  }

  return spans
}

/**
 * Convert time parts into milliseconds.
 */
function parseTimeParts(h: string, m: string, s: string, ms: string): number {
  const hours = Number.parseInt(h, 10) || 0
  const minutes = Number.parseInt(m, 10) || 0
  const seconds = Number.parseInt(s, 10) || 0
  const msPadded = ms.padEnd(3, '0').slice(0, 3)
  const milliseconds = Number.parseInt(msPadded, 10) || 0

  return (hours * 3600 + minutes * 60 + seconds) * 1000 + milliseconds
}

/**
 * Format milliseconds back to SubRip timestamp format (HH:MM:SS,mmm).
 */
export function formatTimeSrt(ms: number): string {
  const totalMs = Math.max(0, Math.floor(ms))
  const hours = Math.floor(totalMs / 3600000)
  const minutes = Math.floor((totalMs % 3600000) / 60000)
  const seconds = Math.floor((totalMs % 60000) / 1000)
  const millis = totalMs % 1000

  const hh = String(hours).padStart(2, '0')
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  const mmm = String(millis).padStart(3, '0')

  return `${hh}:${mm}:${ss},${mmm}`
}

/**
 * Parse raw .srt file content into an array of SubtitleCue objects.
 * Handles BOM, CRLF/LF, multiline cues, HTML tags, and corrupted blocks.
 */
export function parseSrt(content: string): SubtitleCue[] {
  if (!content || typeof content !== 'string') return []

  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n')
  const rawLines = normalized.split('\n')
  const cues: SubtitleCue[] = []

  let currentId: number | string | null = null
  let currentStartMs: number | null = null
  let currentEndMs: number | null = null
  let currentTextLines: string[] = []
  let autoId = 1

  const commitCue = () => {
    if (currentStartMs !== null && currentEndMs !== null && currentTextLines.length > 0) {
      if (currentEndMs > currentStartMs) {
        const rawText = currentTextLines.join('\n')
        const parsedLines: SubtitleLine[] = currentTextLines.map((line) => ({
          text: stripHtmlTags(line),
          spans: parseSpans(line),
        }))
        const text = parsedLines.map((l) => l.text).join('\n')
        if (text.trim().length > 0) {
          cues.push({
            id: currentId ?? autoId,
            startMs: currentStartMs,
            endMs: currentEndMs,
            startSec: currentStartMs / 1000,
            endSec: currentEndMs / 1000,
            text,
            rawText,
            lines: parsedLines,
          })
          autoId++
        }
      }
    }
    currentId = null
    currentStartMs = null
    currentEndMs = null
    currentTextLines = []
  }

  let pendingIdCandidate: string | null = null

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i]
    if (rawLine === undefined) continue
    const line = rawLine.trim()

    if (line.length === 0) {
      if (currentStartMs !== null && currentTextLines.length > 0) {
        commitCue()
      }
      pendingIdCandidate = null
      continue
    }

    const timeMatch = TIMESTAMP_REGEX.exec(line)
    if (timeMatch) {
      commitCue()

      const h1 = timeMatch[1] ?? '0'
      const m1 = timeMatch[2] ?? '0'
      const s1 = timeMatch[3] ?? '0'
      const ms1 = timeMatch[4] ?? '0'
      const h2 = timeMatch[5] ?? '0'
      const m2 = timeMatch[6] ?? '0'
      const s2 = timeMatch[7] ?? '0'
      const ms2 = timeMatch[8] ?? '0'

      currentStartMs = parseTimeParts(h1, m1, s1, ms1)
      currentEndMs = parseTimeParts(h2, m2, s2, ms2)

      if (pendingIdCandidate !== null) {
        const num = Number.parseInt(pendingIdCandidate, 10)
        currentId = Number.isNaN(num) ? pendingIdCandidate : num
      } else {
        currentId = autoId
      }
      pendingIdCandidate = null
      continue
    }

    if (currentStartMs !== null) {
      const nextRaw = rawLines[i + 1]
      if (nextRaw !== undefined && TIMESTAMP_REGEX.test(nextRaw.trim())) {
        commitCue()
        pendingIdCandidate = line
        continue
      }
      currentTextLines.push(line)
    } else {
      pendingIdCandidate = line
    }
  }

  commitCue()

  cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)

  return cues
}
