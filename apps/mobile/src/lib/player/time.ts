/** Timecode for the filament readout: `m:ss`, or `h:mm:ss` once the movie passes an hour. */
export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const mm = h > 0 ? m.toString().padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${s.toString().padStart(2, '0')}`
}

/** The same position for TalkBack: "1 hour 5 minutes" rather than "1:05:00". */
export function spokenTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const parts = [h > 0 ? `${h} hour${h === 1 ? '' : 's'}` : '', `${m} minute${m === 1 ? '' : 's'}`]
  return parts.filter(Boolean).join(' ')
}
