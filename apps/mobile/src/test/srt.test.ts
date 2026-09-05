import { describe, it, expect } from 'vitest'
import {
  parseSrt,
  stripHtmlTags,
  parseSpans,
  formatTimeSrt,
  decodeHtmlEntities,
} from '@/lib/subtitles'

describe('SRT Parser (parseSrt)', () => {
  describe('Standard SubRip Timing & Formats', () => {
    it('parses standard HH:MM:SS,mmm format with comma separator', () => {
      const srt = `1
00:01:23,456 --> 00:01:27,890
Hello, world!`

      const cues = parseSrt(srt)
      expect(cues).toHaveLength(1)
      const cue = cues[0]!
      expect(cue.id).toBe(1)
      expect(cue.startMs).toBe((1 * 60 + 23) * 1000 + 456)
      expect(cue.endMs).toBe((1 * 60 + 27) * 1000 + 890)
      expect(cue.startSec).toBe(83.456)
      expect(cue.endSec).toBe(87.89)
      expect(cue.text).toBe('Hello, world!')
    })

    it('parses dot decimal separator for milliseconds', () => {
      const srt = `1
00:00:02.500 --> 00:00:05.120
Dot separated timing`

      const cues = parseSrt(srt)
      expect(cues).toHaveLength(1)
      expect(cues[0]!.startMs).toBe(2500)
      expect(cues[0]!.endMs).toBe(5120)
      expect(cues[0]!.startSec).toBe(2.5)
      expect(cues[0]!.endSec).toBe(5.12)
    })

    it('handles 1-digit hours and variable millisecond precision', () => {
      const srt = `1
1:02:03,5 --> 1:02:05,50
Variable digits test`

      const cues = parseSrt(srt)
      expect(cues).toHaveLength(1)
      expect(cues[0]!.startMs).toBe((3600 + 2 * 60 + 3) * 1000 + 500)
      expect(cues[0]!.endMs).toBe((3600 + 2 * 60 + 5) * 1000 + 500)
    })

    it('ignores trailing line coordinates on timestamp line', () => {
      const srt = `1
00:00:01,000 --> 00:00:04,000 X1:0 X2:720 Y1:0 Y2:480
Positioned subtitle`

      const cues = parseSrt(srt)
      expect(cues).toHaveLength(1)
      expect(cues[0]!.startMs).toBe(1000)
      expect(cues[0]!.endMs).toBe(4000)
      expect(cues[0]!.text).toBe('Positioned subtitle')
    })

    it('formats milliseconds back to SRT timestamp format', () => {
      expect(formatTimeSrt(0)).toBe('00:00:00,000')
      expect(formatTimeSrt(1500)).toBe('00:00:01,500')
      expect(formatTimeSrt(3723456)).toBe('01:02:03,456')
    })
  })

  describe('Multiline Cues', () => {
    it('preserves line breaks in multiline cues', () => {
      const srt = `1
00:00:10,000 --> 00:00:15,000
Line one of speech
Line two of speech
Line three of speech`

      const cues = parseSrt(srt)
      expect(cues).toHaveLength(1)
      expect(cues[0]!.text).toBe('Line one of speech\nLine two of speech\nLine three of speech')
      expect(cues[0]!.lines).toHaveLength(3)
      expect(cues[0]!.lines[0]!.text).toBe('Line one of speech')
      expect(cues[0]!.lines[1]!.text).toBe('Line two of speech')
      expect(cues[0]!.lines[2]!.text).toBe('Line three of speech')
    })
  })

  describe('HTML Formatting Tags & Entity Decoding', () => {
    it('parses italic <i> tags into styled spans', () => {
      const srt = `1
00:00:01,000 --> 00:00:04,000
<i>Italic speech</i>`

      const cues = parseSrt(srt)
      expect(cues).toHaveLength(1)
      expect(cues[0]!.text).toBe('Italic speech')
      expect(cues[0]!.lines[0]!.spans).toEqual([{ text: 'Italic speech', italic: true }])
    })

    it('parses bold <b> and underline <u> tags', () => {
      const srt = `1
00:00:01,000 --> 00:00:04,000
<b>Bold</b> and <u>Underline</u>`

      const cues = parseSrt(srt)
      expect(cues).toHaveLength(1)
      expect(cues[0]!.text).toBe('Bold and Underline')
      expect(cues[0]!.lines[0]!.spans).toEqual([
        { text: 'Bold', bold: true },
        { text: ' and ' },
        { text: 'Underline', underline: true },
      ])
    })

    it('parses nested tags <b><i>...</i></b>', () => {
      const srt = `1
00:00:01,000 --> 00:00:04,000
<b><i>Bold and italic</i></b>`

      const cues = parseSrt(srt)
      expect(cues).toHaveLength(1)
      expect(cues[0]!.text).toBe('Bold and italic')
      expect(cues[0]!.lines[0]!.spans).toEqual([
        { text: 'Bold and italic', italic: true, bold: true },
      ])
    })

    it('handles unclosed tags gracefully without crashing or losing text', () => {
      const srt = `1
00:00:01,000 --> 00:00:04,000
<i>Unclosed italic text`

      const cues = parseSrt(srt)
      expect(cues).toHaveLength(1)
      expect(cues[0]!.text).toBe('Unclosed italic text')
      expect(cues[0]!.lines[0]!.spans[0]!.text).toBe('Unclosed italic text')
      expect(cues[0]!.lines[0]!.spans[0]!.italic).toBe(true)
    })

    it('strips unsupported tags like <font> while keeping text', () => {
      const srt = `1
00:00:01,000 --> 00:00:04,000
<font color="#ffff00">Yellow text</font>`

      const cues = parseSrt(srt)
      expect(cues).toHaveLength(1)
      expect(cues[0]!.text).toBe('Yellow text')
      expect(cues[0]!.lines[0]!.spans).toEqual([{ text: 'Yellow text' }])
    })

    it('decodes HTML entities in text and spans', () => {
      const srt = `1
00:00:01,000 --> 00:00:04,000
Tom &amp; Jerry &gt; Cat &lt; &quot;Mouse&quot; &#39;Friends&#39;`

      const cues = parseSrt(srt)
      expect(cues).toHaveLength(1)
      expect(cues[0]!.text).toBe('Tom & Jerry > Cat < "Mouse" \'Friends\'')
      expect(cues[0]!.lines[0]!.spans[0]!.text).toBe('Tom & Jerry > Cat < "Mouse" \'Friends\'')
    })
  })

  describe('BOM & Line Ending Normalization', () => {
    it('strips UTF-8 Byte Order Mark (BOM)', () => {
      const srt = `\uFEFF1
00:00:01,000 --> 00:00:03,000
With BOM`

      const cues = parseSrt(srt)
      expect(cues).toHaveLength(1)
      expect(cues[0]!.id).toBe(1)
      expect(cues[0]!.text).toBe('With BOM')
    })

    it('normalizes Windows CRLF (\\r\\n) and Mac CR (\\r)', () => {
      const srt = '1\r\n00:00:01,000 --> 00:00:03,000\r\nCRLF Line 1\r\nCRLF Line 2\r\n\r\n2\r00:00:04,000 --> 00:00:06,000\rCR Line\r\n'

      const cues = parseSrt(srt)
      expect(cues).toHaveLength(2)
      expect(cues[0]!.text).toBe('CRLF Line 1\nCRLF Line 2')
      expect(cues[1]!.text).toBe('CR Line')
    })
  })

  describe('Out-of-Order Cues & Resiliency', () => {
    it('sorts out-of-order cues chronologically', () => {
      const srt = `2
00:00:10,000 --> 00:00:15,000
Second cue

1
00:00:01,000 --> 00:00:05,000
First cue`

      const cues = parseSrt(srt)
      expect(cues).toHaveLength(2)
      expect(cues[0]!.id).toBe(1)
      expect(cues[0]!.startMs).toBe(1000)
      expect(cues[1]!.id).toBe(2)
      expect(cues[1]!.startMs).toBe(10000)
    })

    it('handles missing cue sequence numbers', () => {
      const srt = `00:00:01,000 --> 00:00:04,000
No number cue 1

00:00:05,000 --> 00:00:08,000
No number cue 2`

      const cues = parseSrt(srt)
      expect(cues).toHaveLength(2)
      expect(cues[0]!.text).toBe('No number cue 1')
      expect(cues[1]!.text).toBe('No number cue 2')
    })

    it('handles non-numeric or string cue identifiers', () => {
      const srt = `cue-alpha
00:00:01,000 --> 00:00:04,000
String id cue`

      const cues = parseSrt(srt)
      expect(cues).toHaveLength(1)
      expect(cues[0]!.id).toBe('cue-alpha')
      expect(cues[0]!.text).toBe('String id cue')
    })

    it('handles multiple irregular blank lines between cues', () => {
      const srt = `1
00:00:01,000 --> 00:00:03,000
Cue 1



2
00:00:05,000 --> 00:00:07,000
Cue 2`

      const cues = parseSrt(srt)
      expect(cues).toHaveLength(2)
      expect(cues[0]!.text).toBe('Cue 1')
      expect(cues[1]!.text).toBe('Cue 2')
    })

    it('discards cues with zero or negative duration', () => {
      const srt = `1
00:00:05,000 --> 00:00:05,000
Zero duration

2
00:00:08,000 --> 00:00:06,000
Negative duration

3
00:00:10,000 --> 00:00:12,000
Valid cue`

      const cues = parseSrt(srt)
      expect(cues).toHaveLength(1)
      expect(cues[0]!.id).toBe(3)
      expect(cues[0]!.text).toBe('Valid cue')
    })

    it('discards cues with empty or whitespace-only text', () => {
      const srt = `1
00:00:01,000 --> 00:00:03,000
   

2
00:00:05,000 --> 00:00:07,000
Valid text`

      const cues = parseSrt(srt)
      expect(cues).toHaveLength(1)
      expect(cues[0]!.id).toBe(2)
      expect(cues[0]!.text).toBe('Valid text')
    })

    it('returns empty array for empty strings or non-SRT text', () => {
      expect(parseSrt('')).toEqual([])
      expect(parseSrt('   \n\t  ')).toEqual([])
      expect(parseSrt('This is not an SRT file at all.')).toEqual([])
    })
  })

  describe('Pure helper functions', () => {
    it('stripHtmlTags strips all tags and decodes entities', () => {
      expect(stripHtmlTags('<b>Hello</b> &amp; <i>World</i>')).toBe('Hello & World')
    })

    it('decodeHtmlEntities decodes numeric and named entities', () => {
      expect(decodeHtmlEntities('&#65;&#66;&#67;')).toBe('ABC')
      expect(decodeHtmlEntities('&quot;quoted&quot;')).toBe('"quoted"')
    })

    it('parseSpans produces empty span when given empty string', () => {
      expect(parseSpans('')).toEqual([{ text: '' }])
    })
  })
})
