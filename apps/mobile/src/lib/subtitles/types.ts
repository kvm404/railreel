/**
 * Types for SubRip (.srt) subtitle parsing, formatting, and real-time synchronization.
 */

export interface SubtitleSpan {
  text: string
  italic?: boolean
  bold?: boolean
  underline?: boolean
}

export interface SubtitleLine {
  text: string
  spans: SubtitleSpan[]
}

export interface SubtitleCue {
  id: number | string
  startMs: number
  endMs: number
  startSec: number
  endSec: number
  text: string
  rawText: string
  lines: SubtitleLine[]
}

export interface SubtitleFile {
  name: string
  cues: SubtitleCue[]
  rawContent?: string
}
