package expo.modules.railreelhost

/**
 * A Matroska (MKV/WebM) file's track list, read straight from its EBML header.
 *
 * Android's platform MatroskaExtractor silently DROPS tracks whose codec it doesn't know — AC-3,
 * E-AC-3, DTS and TrueHD among them — so an H.264 MKV with Dolby sound reports no audio at all and
 * would pass as a silent movie (guests then download gigabytes of a film with no sound). The track
 * list itself names every track's codec, so the probe reads it from here instead.
 *
 * The parser walks a bounded prefix of the file: EBML header → Segment → its children up to the
 * first Cluster, looking for Tracks. Muxers write Tracks before the media, so the prefix finds it in
 * practice; when it doesn't (Tracks placed after the clusters, a damaged header) the result is
 * null and the probe reports the tracks as unverified rather than guessing.
 */
internal object MatroskaTracks {
  /** Codec IDs ("V_MPEGH/ISO/HEVC", "A_AC3", …) of the first video and audio track ("" if none). */
  class Result(
    val videoCodecId: String,
    val audioCodecId: String,
    val trackCount: Int,
    val audioTrackCount: Int,
  )

  /** How much of the file's head is searched for the Tracks element. */
  const val PREFIX_BYTES = 4 * 1024 * 1024

  private const val ID_EBML = 0x1A45DFA3L
  private const val ID_SEGMENT = 0x18538067L
  private const val ID_TRACKS = 0x1654AE6BL
  private const val ID_CLUSTER = 0x1F43B675L
  private const val ID_TRACK_ENTRY = 0xAEL
  private const val ID_TRACK_TYPE = 0x83L
  private const val ID_CODEC_ID = 0x86L
  private const val TYPE_VIDEO = 1L
  private const val TYPE_AUDIO = 2L

  /** A data size with every value bit set: "unknown" (live/streamed muxing). */
  private const val UNKNOWN_SIZE = -1L

  private class Vint(val value: Long, val length: Int)

  /** An element ID (1–4 bytes, marker bit kept, as the spec writes IDs). */
  private fun readId(b: ByteArray, pos: Int, end: Int): Vint? {
    if (pos >= end) return null
    val first = b[pos].toInt() and 0xff
    val len = when {
      (first and 0x80) != 0 -> 1
      (first and 0x40) != 0 -> 2
      (first and 0x20) != 0 -> 3
      (first and 0x10) != 0 -> 4
      else -> return null
    }
    if (pos + len > end) return null
    var v = 0L
    for (i in 0 until len) v = (v shl 8) or (b[pos + i].toLong() and 0xff)
    return Vint(v, len)
  }

  /** An element data size (1–8 bytes, marker bit stripped; all value bits set = unknown). */
  private fun readSize(b: ByteArray, pos: Int, end: Int): Vint? {
    if (pos >= end) return null
    val first = b[pos].toInt() and 0xff
    if (first == 0) return null
    val len = Integer.numberOfLeadingZeros(first) - 23 // 0x80 → 1 … 0x01 → 8
    if (pos + len > end) return null
    val mask = 0xff shr len
    var v = (first and mask).toLong()
    var allOnes = (first and mask) == mask
    for (i in 1 until len) {
      val byte = b[pos + i].toLong() and 0xff
      if (byte != 0xffL) allOnes = false
      v = (v shl 8) or byte
    }
    return Vint(if (allOnes) UNKNOWN_SIZE else v, len)
  }

  /** Parse the first [length] bytes of a file; null when its Tracks element isn't in them. */
  fun parse(b: ByteArray, length: Int): Result? {
    val end = minOf(length, b.size)
    var pos = 0

    // EBML header: must come first; skip its body.
    val headerId = readId(b, pos, end) ?: return null
    if (headerId.value != ID_EBML) return null
    pos += headerId.length
    val headerSize = readSize(b, pos, end) ?: return null
    pos += headerSize.length
    if (headerSize.value == UNKNOWN_SIZE || headerSize.value > end - pos) return null
    pos += headerSize.value.toInt()

    // Top level: step over anything (Void, CRC) until the Segment, then enter it.
    while (true) {
      val id = readId(b, pos, end) ?: return null
      pos += id.length
      val size = readSize(b, pos, end) ?: return null
      pos += size.length
      if (id.value == ID_SEGMENT) break
      if (size.value == UNKNOWN_SIZE || size.value > end - pos) return null
      pos += size.value.toInt()
    }

    // Segment children (SeekHead, Info, Tracks, …) up to the first Cluster.
    while (pos < end) {
      val id = readId(b, pos, end) ?: return null
      pos += id.length
      val size = readSize(b, pos, end) ?: return null
      pos += size.length
      if (id.value == ID_CLUSTER) return null
      if (size.value == UNKNOWN_SIZE || size.value > end - pos) return null
      val dataEnd = pos + size.value.toInt()
      if (id.value == ID_TRACKS) return parseTracks(b, pos, dataEnd)
      pos = dataEnd
    }
    return null
  }

  private fun parseTracks(b: ByteArray, start: Int, end: Int): Result {
    var pos = start
    var video = ""
    var audio = ""
    var tracks = 0
    var audioTracks = 0
    while (pos < end) {
      val id = readId(b, pos, end) ?: break
      pos += id.length
      val size = readSize(b, pos, end) ?: break
      pos += size.length
      if (size.value == UNKNOWN_SIZE || size.value > end - pos) break
      val dataEnd = pos + size.value.toInt()
      if (id.value == ID_TRACK_ENTRY) {
        tracks++
        var type = 0L
        var codec = ""
        var p = pos
        while (p < dataEnd) {
          val childId = readId(b, p, dataEnd) ?: break
          p += childId.length
          val childSize = readSize(b, p, dataEnd) ?: break
          p += childSize.length
          if (childSize.value == UNKNOWN_SIZE || childSize.value > dataEnd - p) break
          val n = childSize.value.toInt()
          when (childId.value) {
            ID_TRACK_TYPE -> {
              var v = 0L
              for (i in 0 until minOf(n, 8)) v = (v shl 8) or (b[p + i].toLong() and 0xff)
              type = v
            }
            ID_CODEC_ID -> codec = String(b, p, n, Charsets.US_ASCII).trimEnd('\u0000')
          }
          p += n
        }
        if (type == TYPE_VIDEO && video.isEmpty()) video = codec.ifEmpty { "V_UNKNOWN" }
        if (type == TYPE_AUDIO) {
          audioTracks++
          if (audio.isEmpty()) audio = codec.ifEmpty { "A_UNKNOWN" }
        }
      }
      pos = dataEnd
    }
    return Result(video, audio, tracks, audioTracks)
  }

  /** Android mime for a Matroska video codec ID (the names lib/media/compat.ts knows). */
  fun videoMime(codecId: String): String = when {
    codecId.isEmpty() -> ""
    codecId == "V_MPEG4/ISO/AVC" -> "video/avc"
    codecId == "V_MPEGH/ISO/HEVC" -> "video/hevc"
    codecId == "V_AV1" -> "video/av01"
    codecId == "V_VP9" -> "video/x-vnd.on2.vp9"
    codecId == "V_VP8" -> "video/x-vnd.on2.vp8"
    codecId.startsWith("V_MPEG4/ISO/") -> "video/mp4v-es"
    codecId == "V_MPEG1" || codecId == "V_MPEG2" -> "video/mpeg2"
    else -> "video/" + codecId.removePrefix("V_").lowercase().replace('/', '-')
  }

  /** Android mime for a Matroska audio codec ID (the names lib/media/compat.ts knows). */
  fun audioMime(codecId: String): String = when {
    codecId.isEmpty() -> ""
    codecId.startsWith("A_AAC") -> "audio/mp4a-latm"
    codecId == "A_AC3" || codecId.startsWith("A_AC3/") -> "audio/ac3"
    codecId == "A_EAC3" -> "audio/eac3"
    codecId == "A_DTS" -> "audio/vnd.dts"
    codecId.startsWith("A_DTS/") -> "audio/vnd.dts.hd"
    codecId == "A_TRUEHD" -> "audio/true-hd"
    codecId == "A_OPUS" -> "audio/opus"
    codecId == "A_VORBIS" -> "audio/vorbis"
    codecId == "A_FLAC" -> "audio/flac"
    codecId == "A_ALAC" -> "audio/alac"
    codecId == "A_MPEG/L3" -> "audio/mpeg"
    codecId == "A_MPEG/L2" -> "audio/mpeg-l2"
    codecId.startsWith("A_PCM/") -> "audio/raw"
    else -> "audio/" + codecId.removePrefix("A_").lowercase().replace('/', '-')
  }
}
