package expo.modules.railreelhost

import android.content.ContentResolver
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.exception.CodedException
import fi.iki.elonen.NanoHTTPD
import java.io.File
import java.io.FileInputStream
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * RailReel host data plane (Android). A NanoHTTPD server that streams the selected movie file
 * with HTTP byte-range support, gated by the session token. Native streaming avoids the
 * JS-bridge bottleneck that capped the spike at ~1.8 Mbps. See docs/data-plane-module.md.
 *
 * v1 scope: serves a file:// path. content:// (SAF) sources + a foreground service come later.
 */
class RailReelHostModule : Module() {
  private val lock = Any()
  private var server: FileServer? = null
  private var ctrl: CtrlServer? = null
  private var proxy: ProxyServer? = null // client-side playback proxy (see ProxyServer.kt)
  private var nsd: NsdHelper? = null // mDNS advertise (host) / discover (guest) — see NsdHelper.kt

  override fun definition() = ModuleDefinition {
    Name("RailReelHost")
    Events("onWsOpen", "onWsClose", "onWsMessage", "onNsdFound", "onNsdLost", "onNsdError")

    // The host's own LAN/hotspot IPv4, for the QR/join link. NanoHTTPD binds to all interfaces,
    // so we pick the address clients actually reach: prefer the hotspot/wifi interface.
    Function("getHostIpAddress") { hostIpAddress() }

    // Every usable IPv4 on this device with the transport of the network that owns its interface
    // ("none" = no network does — the SoftAP/tethering case). JS ranks them (lib/net/hostNetwork)
    // so the invite can say whether it is really on the hotspot.
    Function("getNetworkCandidates") {
      networkCandidates().map { mapOf("iface" to it.iface, "ip" to it.ip, "transport" to it.transport) }
    }

    // The host's MONOTONIC clock (ms) — the same timebase the WS sync handshake answers in (see
    // CtrlServer). The host stamps each PlaybackState with this so clients can convert it to their
    // own clock via the measured offset. Never wall-clock.
    Function("getMonotonicMs") { android.os.SystemClock.elapsedRealtimeNanos() / 1_000_000.0 }

    AsyncFunction("start") { fileUri: String, httpPort: Int, wsPort: Int, token: String ->
      if (token.isBlank()) throw CodedException("Session token must not be empty")
      synchronized(lock) {
        val ctx = appContext.reactContext ?: throw CodedException("No app context")
        // Resolve the movie source. The document picker hands us a content:// URI; we stream it
        // straight off the provider (no multi-GB copy into cache). file:// is still supported.
        val media: MediaSource = try {
          if (fileUri.startsWith("content://")) {
            ContentSource(ctx.contentResolver, Uri.parse(fileUri))
          } else {
            val file = File(fileUri.removePrefix("file://"))
            if (!file.exists() || !file.canRead()) {
              throw CodedException("File not found or unreadable: ${file.path}")
            }
            FileSource(file)
          }
        } catch (e: CodedException) {
          throw e
        } catch (e: Exception) {
          throw CodedException("Cannot open media source: ${e.message}")
        }
        // Fully tear down any previous session first.
        teardown(ctx)

        val s = FileServer(httpPort, media, token)
        try {
          s.start(NanoHTTPD.SOCKET_READ_TIMEOUT, true) // daemon listener thread
        } catch (e: Exception) {
          runCatching { s.stop() }
          throw CodedException("Failed to start HTTP server: ${e.message}")
        }

        val c = CtrlServer(wsPort, token) { type, connId, payload ->
          // CtrlServer fires these from per-connection socket threads; hop to the JS thread
          // before touching the event emitter (sendEvent goes straight into JSI). `conn` is the
          // native connection id — the ONLY identity JS may attribute a frame or close to.
          appContext.runtime.schedule {
            when (type) {
              "open" -> sendEvent("onWsOpen", mapOf("conn" to connId))
              "close" -> sendEvent("onWsClose", mapOf("conn" to connId))
              "message" -> sendEvent("onWsMessage", mapOf("data" to payload, "conn" to connId))
            }
          }
        }
        try {
          // The control channel is idle for long stretches of a movie, so its per-connection
          // socket read timeout must comfortably exceed the client keepalive interval — otherwise
          // the server closes the socket between pings. (HTTP uses the default 5s; data flows there.)
          c.start(WS_SOCKET_READ_TIMEOUT_MS, true)
        } catch (e: Exception) {
          runCatching { s.stop() }
          runCatching { c.stop() } // its watchdog thread is already running
          throw CodedException("Failed to start WS server: ${e.message}")
        }

        // Foreground service keeps the process + CPU/WiFi alive. Keep start atomic.
        try {
          RailReelHostService.start(ctx)
        } catch (e: Exception) {
          runCatching { s.stop() }
          runCatching { c.stop() }
          runCatching { RailReelHostService.stop(ctx) }
          throw CodedException("Failed to start foreground service: ${e.message}")
        }
        server = s
        ctrl = c
        mapOf("httpPort" to s.listeningPort, "wsPort" to c.listeningPort)
      }
    }

    // Approve a client's download grant: until the host calls this, the data plane serves no
    // bytes to that client even though it holds the session token (see docs/architecture.md §10).
    // Fail closed — validate the grant shape and require a live session, so a JS bug can never
    // widen the gate with a blank/oversized value or "approve" into a torn-down server.
    AsyncFunction("approve") { grant: String ->
      if (!isValidGrant(grant)) throw CodedException("Invalid grant")
      val s = synchronized(lock) { server } ?: throw CodedException("No active session")
      s.approve(grant)
    }

    // Revoke a previously-approved grant (client kicked / left). Affects FUTURE requests only —
    // a transfer already streaming is not interrupted. That is acceptable for v1: clients fully
    // pre-cache the file, so a revoked client's only recourse (re-request) is already blocked.
    AsyncFunction("revoke") { grant: String ->
      synchronized(lock) { server }?.revoke(grant)
    }

    // Host → every APPROVED connection (state/roster/chat/reactions/subtitle as JSON strings).
    // Only enqueues: each socket has its own bounded writer, so a stuck client can't stall this
    // queue, start or stop.
    AsyncFunction("broadcast") { message: String ->
      val c = synchronized(lock) { ctrl }
      c?.broadcast(message)
    }

    // Host → every accepted connection, pending ones included. Lifecycle frames only (`ended`).
    AsyncFunction("broadcastAll") { message: String ->
      val c = synchronized(lock) { ctrl }
      c?.broadcastAll(message)
    }

    // Host → one connection, approved or not (a pending requester's own requestDecision).
    AsyncFunction("sendTo") { conn: String, message: String ->
      val c = synchronized(lock) { ctrl }
      c?.sendTo(conn, message) ?: false
    }

    // Mark a connection approved so broadcasts reach it. JS calls this after binding an approved
    // guest to the connection (approval, or a grant-proven reconnect).
    AsyncFunction("approveConnection") { conn: String ->
      val c = synchronized(lock) { ctrl }
      c?.approveConnection(conn) ?: false
    }

    // Stop broadcasting to a connection and close it once queued frames are flushed (leave, deny,
    // or an old socket superseded by a reconnect).
    AsyncFunction("dropConnection") { conn: String ->
      val c = synchronized(lock) { ctrl }
      c?.dropConnection(conn) ?: false
    }

    AsyncFunction("stop") {
      synchronized(lock) {
        appContext.reactContext?.let { teardown(it) }
      }
    }

    // Probe the media the host picked BEFORE any server starts. Two jobs:
    //  1. Start-gate inputs: duration, frame size, and whether the MP4 is "faststart" (moov before
    //     mdat) — a player can only open a PARTIALLY-downloaded file if the moov atom is at the
    //     front, so non-faststart files must fully pre-cache before the show.
    //  2. Compatibility inputs (PRD §7: H.264 + AAC in MP4 only): the container hint and the real
    //     track mimes, read by MediaExtractor — the retriever alone happily reports a duration for
    //     HEVC/AV1/MKV files that guests would download in full and then fail to play.
    // Works for both file:// paths and content:// (SAF) documents. Throws only when the container
    // can't be parsed at all (JS treats that as "unreadable"); a missing duration/size degrades to
    // 0 so an otherwise-valid MP4 still hosts, in pre-cache mode.
    AsyncFunction("probe") { fileUri: String ->
      val ctx = appContext.reactContext ?: throw CodedException("No app context")
      try {
        val container = sniffContainer(ctx, fileUri)
        // The platform extractor is strict: it can fail outright, or skip tracks whose sample
        // entry it doesn't know (e.g. H.264 stored as `avc3`, common in fragmented MP4 — which
        // Media3, our player, plays fine). So an extractor miss is NOT a verdict: for ISO files we
        // fall back to reading the sample-entry fourccs straight out of the moov box.
        val extractorTracks = try { readTracks(ctx, fileUri) } catch (e: Exception) { null }
        var tracks = extractorTracks ?: TrackSummary("", "", 0, 0, 0, 0, 0L)
        val iso = container == "mp4" || container == "quicktime"
        if (iso && (tracks.videoMime.isEmpty() || tracks.audioMime.isEmpty())) {
          val isoTracks = readIsoTracks(ctx, fileUri)
          if (isoTracks != null) tracks = mergeTracks(tracks, isoTracks)
        }
        // Matroska: the platform extractor drops tracks it can't decode (AC-3, DTS, TrueHD…), so
        // an MKV with Dolby sound would look silent. The file's own track list is the truth for
        // audio; when it can't be found the JS verdict refuses to call the file silent.
        var tracksVerified = true
        if (container == "matroska") {
          val mkv = readMatroskaTracks(ctx, fileUri)
          if (mkv != null) tracks = mergeMatroska(tracks, mkv) else tracksVerified = false
        }
        // Nothing could be read by either route (and it isn't a Matroska file we can name) → the
        // JS side reports "unreadable".
        if (extractorTracks == null && tracks.trackCount == 0 && container != "matroska") {
          throw CodedException("Cannot read media tracks")
        }
        val (retrieverDurationMs, retrieverWidth, retrieverHeight) = readRetrieverMeta(ctx, fileUri)
        // Resolution feeds the client decode-capability check — a 4K file plays as a slideshow on
        // phones whose hardware decoder tops out at 1080p. Fall back to the track format when the
        // retriever has nothing (it is the less forgiving of the two on odd containers).
        val durationMs = if (retrieverDurationMs > 0) retrieverDurationMs else tracks.durationMs
        val width = if (retrieverWidth > 0) retrieverWidth else tracks.width
        val height = if (retrieverHeight > 0) retrieverHeight else tracks.height
        // Only an ISO file has the moov/mdat boxes this scan reads; any other container's bytes would be
        // misread as box sizes (an MKV's EBML magic reads as a ~420 MB box to skip).
        val fastStart = if (!iso) false else runCatching {
          openMediaStream(ctx.contentResolver, fileUri).use { isFastStart(it) }
        }.getOrNull()
        // Undeterminable layout (odd container, read error) → treat as NOT faststart: the cost of
        // being wrong is only a later start, never a frozen room.
        mapOf(
          "durationSec" to durationMs / 1000.0,
          "fastStart" to (fastStart ?: false),
          "width" to width,
          "height" to height,
          "videoMime" to tracks.videoMime,
          "audioMime" to tracks.audioMime,
          "trackCount" to tracks.trackCount,
          "tracksVerified" to tracksVerified,
          "audioTrackCount" to tracks.audioTrackCount,
          "container" to container,
        )
      } catch (e: CodedException) {
        throw e
      } catch (e: Exception) {
        throw CodedException("Cannot probe media: ${e.message}")
      }
    }

    // Can THIS device's hardware decoder handle a frame size? (PRD: H.264 only, so callers pass
    // video/avc.) A 4K file on a 1080p-max decoder falls back to software = slideshow — the lobby
    // warns before the show instead of the phone stuttering during it. Unknown size (0) → true.
    Function("canDecode") { mime: String, width: Int, height: Int ->
      if (width <= 0 || height <= 0) true
      else try {
        val codecs = android.media.MediaCodecList(android.media.MediaCodecList.REGULAR_CODECS)
        codecs.codecInfos.any { info ->
          !info.isEncoder &&
            info.supportedTypes.any { it.equals(mime, ignoreCase = true) } &&
            runCatching {
              info.getCapabilitiesForType(mime).videoCapabilities?.isSizeSupported(width, height) == true
            }.getOrDefault(false)
        }
      } catch (e: Exception) {
        true // capability query failed — don't block playback on a diagnostic
      }
    }

    // Host preflight: battery level (0..1) + charging, read from the sticky battery intent.
    Function("getBatteryStatus") {
      val ctx = appContext.reactContext ?: return@Function mapOf("level" to -1.0, "charging" to false)
      val intent = ctx.registerReceiver(null, android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED))
      val level = intent?.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1) ?: -1
      val scale = intent?.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, -1) ?: -1
      val status = intent?.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1) ?: -1
      val charging = status == android.os.BatteryManager.BATTERY_STATUS_CHARGING ||
        status == android.os.BatteryManager.BATTERY_STATUS_FULL
      mapOf(
        "level" to if (level >= 0 && scale > 0) level.toDouble() / scale else -1.0,
        "charging" to charging,
      )
    }

    // Quick integrity fingerprint: sha256 over (head 1MB + tail 1MB + size). Not a full-file hash
    // (2+ GB would take ~a minute on a phone) but catches the real failure modes: wrong file,
    // truncation, corrupted tail. The tail is read by SEEKING to it (positioned fd) — never by
    // streaming through the whole file, or a 2GB content:// source would stall the host for
    // seconds before its QR even appears. Same function runs host- and client-side.
    AsyncFunction("fingerprint") { fileUri: String, sizeBytes: Double ->
      val ctx = appContext.reactContext ?: throw CodedException("No app context")
      val size = sizeBytes.toLong()
      if (size <= 0) throw CodedException("fingerprint needs the real size")
      val md = java.security.MessageDigest.getInstance("SHA-256")
      val chunk = FP_CHUNK_BYTES
      if (size <= 2L * chunk) {
        openAt(ctx.contentResolver, fileUri, 0).use { digestFully(md, it, size) }
      } else {
        openAt(ctx.contentResolver, fileUri, 0).use { digestFully(md, it, chunk) }
        openAt(ctx.contentResolver, fileUri, size - chunk).use { digestFully(md, it, chunk) }
      }
      md.update(size.toString().toByteArray())
      "qf1:" + md.digest().joinToString("") { "%02x".format(it) }
    }

    // ── mDNS tap-to-join (PRD §6) ──────────────────────────────────────────────
    // Host: advertise this session on the local network. TXT carries what the QR carries — the
    // deliberate trade-off is that anyone on the hotspot can *request* to join, which the trust
    // model already assumes: the host approves every person and bytes need an approved grant.
    AsyncFunction("advertise") { name: String, port: Int, txt: Map<String, String> ->
      val helper = ensureNsd() ?: throw CodedException("No app context")
      helper.advertise(name, port, txt)
    }

    AsyncFunction("stopAdvertise") { synchronized(lock) { nsd?.stopAdvertise() } }

    // Guest: discover nearby cabins; results stream via onNsdFound/onNsdLost events.
    AsyncFunction("startDiscovery") {
      val helper = ensureNsd() ?: throw CodedException("No app context")
      helper.startDiscovery()
    }

    AsyncFunction("stopDiscovery") { synchronized(lock) { nsd?.stopDiscovery() } }

    // Client: start the localhost playback proxy over the still-downloading movie file.
    // `expectedBytes` is the final size (from the host's Content-Length); crosses the bridge as a
    // Double because the bridge has no 64-bit int, exact for sizes < 2^53. Returns the bound port.
    AsyncFunction("startProxy") { filePath: String, expectedBytes: Double ->
      if (expectedBytes < 1) throw CodedException("expectedBytes must be positive")
      synchronized(lock) {
        proxy?.let { runCatching { it.stop() } }
        val p = ProxyServer(File(filePath.removePrefix("file://")), expectedBytes.toLong())
        try {
          p.start(NanoHTTPD.SOCKET_READ_TIMEOUT, true)
        } catch (e: Exception) {
          runCatching { p.stop() }
          throw CodedException("Failed to start playback proxy: ${e.message}")
        }
        proxy = p
        p.listeningPort
      }
    }

    AsyncFunction("stopProxy") {
      synchronized(lock) {
        proxy?.let { runCatching { it.stop() } }
        proxy = null
      }
    }

    OnDestroy {
      synchronized(lock) {
        appContext.reactContext?.let { teardown(it) }
        proxy?.let { runCatching { it.stop() } }
        proxy = null
        nsd?.teardown()
        nsd = null
      }
    }
  }

  /** Lazily build the NSD helper (needs a context; events hop to the JS thread here). */
  private fun ensureNsd(): NsdHelper? = synchronized(lock) {
    nsd ?: appContext.reactContext?.let { ctx ->
      NsdHelper(ctx) { kind, payload ->
        appContext.runtime.schedule {
          sendEvent(
            when (kind) {
              "found" -> "onNsdFound"
              "error" -> "onNsdError"
              else -> "onNsdLost"
            },
            payload,
          )
        }
      }.also { nsd = it }
    }
  }

  private data class NetCandidate(val iface: String, val ip: String, val transport: String)

  /**
   * Interface name → transport of the ConnectivityManager network using it. The SoftAP (and any
   * tethering interface) is never a network the phone itself uses, so it is absent here — that
   * absence is how a hotspot `wlan1` is told apart from the station `wlan0`.
   */
  @Suppress("DEPRECATION") // getAllNetworks: a one-shot snapshot is all we need, no callback
  private fun transportsByInterface(): Map<String, String> {
    val ctx = appContext.reactContext ?: return emptyMap()
    val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return emptyMap()
    val out = HashMap<String, String>()
    for (network in cm.allNetworks) {
      runCatching {
        val name = cm.getLinkProperties(network)?.interfaceName ?: return@runCatching
        val caps = cm.getNetworkCapabilities(network) ?: return@runCatching
        out[name] = when {
          caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
          caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
          caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
          caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
          else -> "other"
        }
      }
    }
    return out
  }

  /** Every up, non-loopback IPv4 (link-local excluded) with its interface's owning transport. */
  private fun networkCandidates(): List<NetCandidate> = try {
    val transports = runCatching { transportsByInterface() }.getOrDefault(emptyMap())
    NetworkInterface.getNetworkInterfaces().toList()
      .filter { it.isUp && !it.isLoopback }
      .flatMap { nif ->
        nif.inetAddresses.toList()
          .filter { it is Inet4Address && !it.isLoopbackAddress && !it.isLinkLocalAddress && !it.isAnyLocalAddress }
          .mapNotNull { addr -> addr.hostAddress?.let { NetCandidate(nif.name, it, transports[nif.name] ?: "none") } }
      }
  } catch (e: Exception) {
    emptyList()
  }

  /**
   * Best-effort LAN IPv4 of this device (kept for older JS; the store ranks getNetworkCandidates
   * itself — same order): the hotspot interface (a wlan/ap interface no network owns), then the
   * Wi-Fi station, then any other reachable link. Never cellular or VPN. Null if none.
   */
  private fun hostIpAddress(): String? {
    val usable = networkCandidates().filter { it.transport != "cellular" && it.transport != "vpn" }
    val apName = Regex("^(wlan|swlan|ap|softap|wigig|tether)", RegexOption.IGNORE_CASE)
    val hotspot = usable.firstOrNull { it.transport == "none" && (apName.containsMatchIn(it.iface) || it.ip.startsWith("192.168.43.")) }
    return (hotspot ?: usable.firstOrNull { it.transport == "wifi" } ?: usable.firstOrNull())?.ip
  }

  /** Open a raw byte stream over the picked media, whichever URI scheme the picker returned. */
  private fun openMediaStream(resolver: ContentResolver, fileUri: String): InputStream =
    if (fileUri.startsWith("content://")) {
      resolver.openInputStream(Uri.parse(fileUri)) ?: throw IOException("cannot open $fileUri")
    } else {
      FileInputStream(File(fileUri.removePrefix("file://")))
    }

  /**
   * Open the media positioned at [offset] using a SEEK (fd channel.position), not a stream skip —
   * so reading the tail of a multi-GB file is instant instead of a full read-through. Works for
   * file:// and content:// (SAF) sources; the caller closes the stream (which releases the fd).
   */
  private fun openAt(resolver: ContentResolver, fileUri: String, offset: Long): InputStream {
    if (fileUri.startsWith("content://")) {
      val pfd = resolver.openFileDescriptor(Uri.parse(fileUri), "r") ?: throw IOException("cannot open $fileUri")
      val fis = FileInputStream(pfd.fileDescriptor)
      try {
        if (offset > 0) fis.channel.position(offset)
      } catch (e: Exception) {
        runCatching { fis.close() }; runCatching { pfd.close() }
        throw e
      }
      return object : FilterInputStream(fis) {
        override fun close() {
          try { super.close() } finally { pfd.close() }
        }
      }
    }
    val fis = FileInputStream(File(fileUri.removePrefix("file://")))
    if (offset > 0) {
      try {
        fis.channel.position(offset)
      } catch (e: Exception) {
        fis.close(); throw e
      }
    }
    return fis
  }

  /**
   * Walk the top-level MP4 boxes: `true` iff `moov` appears before `mdat` (faststart), `null` if
   * the layout can't be determined. Decides in a handful of tiny reads — the first `mdat`/`moov`
   * header settles it, so multi-GB payloads are never skipped over.
   */
  private fun isFastStart(s: InputStream): Boolean? {
    val header = ByteArray(16)
    var walked = 0L
    while (walked < FASTSTART_SCAN_CAP) {
      if (!readFully(s, header, 8)) return null
      var size = be32(header, 0)
      val type = String(header, 4, 4, Charsets.US_ASCII)
      var headerLen = 8L
      when (size) {
        1L -> { // 64-bit largesize follows
          if (!readFully(s, header, 8)) return null
          size = be64(header, 0)
          headerLen = 16L
        }
        0L -> size = Long.MAX_VALUE // box extends to EOF
      }
      when (type) {
        "moov" -> return true
        "mdat" -> return false
      }
      val skip = size - headerLen
      // Stay inside the scan budget BEFORE skipping: on a non-seekable stream a skip is a read.
      if (size < headerLen || size > FASTSTART_SCAN_CAP - walked || !skipFully(s, skip)) return null
      walked += size
    }
    return null
  }

  /** What MediaExtractor found inside the file: first video/audio mime ("" if none) + counts. */
  private class TrackSummary(
    val videoMime: String,
    val audioMime: String,
    val trackCount: Int,
    val audioTrackCount: Int,
    val width: Int,
    val height: Int,
    val durationMs: Long,
  )

  /**
   * Enumerate the container's tracks. MediaExtractor only PARSES (it never instantiates a
   * decoder), so HEVC/AV1 report their real mime even on phones that can't decode them. Throws if
   * the file can't be parsed; the extractor is always released.
   */
  private fun readTracks(ctx: android.content.Context, fileUri: String): TrackSummary {
    val extractor = android.media.MediaExtractor()
    try {
      if (fileUri.startsWith("content://")) {
        extractor.setDataSource(ctx, Uri.parse(fileUri), null)
      } else {
        extractor.setDataSource(fileUri.removePrefix("file://"))
      }
      var videoMime = ""
      var audioMime = ""
      var audioTracks = 0
      var width = 0
      var height = 0
      var durationUs = 0L
      for (i in 0 until extractor.trackCount) {
        val format = extractor.getTrackFormat(i)
        val mime = format.getString(android.media.MediaFormat.KEY_MIME) ?: continue
        if (mime.startsWith("video/")) {
          if (videoMime.isEmpty()) {
            videoMime = mime
            if (format.containsKey(android.media.MediaFormat.KEY_WIDTH)) {
              width = format.getInteger(android.media.MediaFormat.KEY_WIDTH)
            }
            if (format.containsKey(android.media.MediaFormat.KEY_HEIGHT)) {
              height = format.getInteger(android.media.MediaFormat.KEY_HEIGHT)
            }
          }
        } else if (mime.startsWith("audio/")) {
          audioTracks++
          if (audioMime.isEmpty()) audioMime = mime
        }
        if (format.containsKey(android.media.MediaFormat.KEY_DURATION)) {
          val d = runCatching { format.getLong(android.media.MediaFormat.KEY_DURATION) }.getOrDefault(0L)
          if (d > durationUs) durationUs = d
        }
      }
      return TrackSummary(videoMime, audioMime, extractor.trackCount, audioTracks, width, height, durationUs / 1000)
    } finally {
      runCatching { extractor.release() }
    }
  }

  /** Duration (ms) + frame size from MediaMetadataRetriever; zeros for anything it can't read. */
  private fun readRetrieverMeta(ctx: android.content.Context, fileUri: String): Triple<Long, Int, Int> {
    val retriever = android.media.MediaMetadataRetriever()
    try {
      if (fileUri.startsWith("content://")) {
        retriever.setDataSource(ctx, Uri.parse(fileUri))
      } else {
        retriever.setDataSource(fileUri.removePrefix("file://"))
      }
      val durationMs = retriever
        .extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)
        ?.toLongOrNull() ?: 0L
      val width = retriever
        .extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
        ?.toIntOrNull() ?: 0
      val height = retriever
        .extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
        ?.toIntOrNull() ?: 0
      return Triple(durationMs, width, height)
    } catch (e: Exception) {
      return Triple(0L, 0, 0)
    } finally {
      runCatching { retriever.release() }
    }
  }

  /** One MP4/QuickTime box header: payload starts [headerLen] bytes after the box start. */
  private class BoxHeader(val type: String, val size: Long, val headerLen: Long)

  /** Read a box header at the stream's position; handles 64-bit largesize and size 0 (to EOF). */
  private fun readBoxHeader(s: InputStream, buf: ByteArray): BoxHeader? {
    if (!readFully(s, buf, 8)) return null
    var size = be32(buf, 0)
    val type = String(buf, 4, 4, Charsets.ISO_8859_1)
    var headerLen = 8L
    when (size) {
      1L -> {
        if (!readFully(s, buf, 8)) return null
        size = be64(buf, 0)
        headerLen = 16L
      }
      0L -> size = Long.MAX_VALUE
    }
    return BoxHeader(type, size, headerLen)
  }

  /**
   * Walk the TOP-LEVEL boxes (a few tiny positioned reads — payloads are seeked over, never read)
   * to classify the container and, when [wantMoov], return the moov payload (capped, so a corrupt
   * size can't allocate gigabytes). A leading `free` / `uuid` / `wide` box before `ftyp` is common
   * in real files, so the first box alone is not enough. Container is "mp4" (ISO `ftyp`),
   * "quicktime" (`qt  ` brand, or a legacy file made only of QuickTime atoms) or "unknown".
   */
  private fun scanIsoBoxes(
    ctx: android.content.Context,
    fileUri: String,
    wantMoov: Boolean,
  ): Pair<String, ByteArray?> {
    var container = "unknown"
    var moov: ByteArray? = null
    var offset = 0L
    val buf = ByteArray(16)
    var boxes = 0
    while (boxes < ISO_SCAN_MAX_BOXES) {
      boxes++
      val stream = try {
        openAt(ctx.contentResolver, fileUri, offset)
      } catch (e: Exception) {
        break
      }
      val header: BoxHeader? = try {
        val h = readBoxHeader(stream, buf)
        if (h != null) {
          when (h.type) {
            "ftyp" -> if (container == "unknown" && readFully(stream, buf, 4)) {
              container = if (String(buf, 0, 4, Charsets.ISO_8859_1) == "qt  ") "quicktime" else "mp4"
            }
            "moov" -> {
              if (container == "unknown") container = "quicktime"
              if (wantMoov) {
                if (h.size == Long.MAX_VALUE) {
                  // size 0 = "extends to EOF": no length to trust, so read with a hard ceiling.
                  val bytes = readBounded(stream, ISO_MOOV_CAP_BYTES)
                  if (bytes != null && bytes.isNotEmpty()) moov = bytes
                } else {
                  val len = h.size - h.headerLen
                  if (len > 0 && len <= ISO_MOOV_CAP_BYTES) {
                    val bytes = ByteArray(len.toInt())
                    if (readFully(stream, bytes, bytes.size)) moov = bytes
                  }
                }
              }
            }
            "mdat" -> if (container == "unknown") container = "quicktime"
          }
        }
        h
      } catch (e: Exception) {
        null
      } finally {
        runCatching { stream.close() }
      }
      if (header == null) break
      if (header.type == "moov" && wantMoov) break // read (or too big to read) — nothing further to find
      if (container == "unknown") {
        if (header.type != "free" && header.type != "skip" && header.type != "wide" &&
          header.type != "pnot" && header.type != "uuid"
        ) break // not an ISO/QuickTime file
      } else if (!wantMoov) {
        break
      }
      if (header.size == Long.MAX_VALUE || header.size < header.headerLen) break
      val next = offset + header.size
      if (next <= offset) break
      offset = next
    }
    return Pair(container, moov)
  }

  /**
   * Container hint: "matroska" (EBML magic 1A 45 DF A3 — MKV and WebM) or the ISO/QuickTime
   * classification from [scanIsoBoxes]; "unknown" otherwise.
   */
  private fun sniffContainer(ctx: android.content.Context, fileUri: String): String {
    val magic = ByteArray(4)
    val read = runCatching {
      openMediaStream(ctx.contentResolver, fileUri).use { readFully(it, magic, 4) }
    }.getOrDefault(false)
    if (!read) return "unknown"
    if (magic[0] == 0x1A.toByte() && magic[1] == 0x45.toByte() && magic[2] == 0xDF.toByte() && magic[3] == 0xA3.toByte()) {
      return "matroska"
    }
    return runCatching { scanIsoBoxes(ctx, fileUri, false).first }.getOrDefault("unknown")
  }

  /** Read the rest of [s], or null if it holds more than [maxBytes] (never buffers past the cap). */
  private fun readBounded(s: InputStream, maxBytes: Long): ByteArray? {
    val out = java.io.ByteArrayOutputStream()
    val chunk = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
      val n = s.read(chunk)
      if (n < 0) break
      total += n
      if (total > maxBytes) return null
      out.write(chunk, 0, n)
    }
    return out.toByteArray()
  }

  /** Child boxes of [type] inside b[start, end): each as (payloadStart, payloadEnd). Bounded to the buffer. */
  private fun findBoxes(b: ByteArray, start: Int, end: Int, type: String): List<IntArray> {
    val out = ArrayList<IntArray>()
    var pos = start
    while (pos + 8 <= end) {
      var size = be32(b, pos)
      val t = String(b, pos + 4, 4, Charsets.ISO_8859_1)
      var headerLen = 8
      if (size == 1L) {
        if (pos + 16 > end) break
        size = be64(b, pos + 8)
        headerLen = 16
      } else if (size == 0L) {
        size = (end - pos).toLong() // extends to the end of the parent
      }
      if (size < headerLen.toLong() || size > (end - pos).toLong()) break
      if (t == type) out.add(intArrayOf(pos + headerLen, pos + size.toInt()))
      pos += size.toInt()
    }
    return out
  }

  /** Android mime for a video sample-entry fourcc, or null when unknown. */
  private fun videoMimeForFourcc(fourcc: String): String? = when (fourcc) {
    "avc1", "avc3" -> "video/avc"
    "hvc1", "hev1" -> "video/hevc"
    "dvh1", "dvhe" -> "video/dolby-vision"
    "av01" -> "video/av01"
    "vp09" -> "video/x-vnd.on2.vp9"
    "vp08" -> "video/x-vnd.on2.vp8"
    "mp4v" -> "video/mp4v-es"
    "s263" -> "video/3gpp"
    else -> null
  }

  /** Android mime for an audio sample-entry fourcc, or null when unknown. */
  private fun audioMimeForFourcc(fourcc: String): String? = when (fourcc) {
    "mp4a" -> "audio/mp4a-latm"
    "ac-3" -> "audio/ac3"
    "ec-3" -> "audio/eac3"
    "Opus" -> "audio/opus"
    "fLaC" -> "audio/flac"
    "alac" -> "audio/alac"
    ".mp3" -> "audio/mpeg"
    "dtsc", "dtsh", "dtse", "dtsl" -> "audio/vnd.dts"
    "mlpa" -> "audio/true-hd"
    "sowt", "twos", "lpcm", "ipcm", "fpcm" -> "audio/raw"
    "samr" -> "audio/3gpp"
    "sawb" -> "audio/amr-wb"
    else -> null
  }

  /**
   * Fallback track enumeration for ISO files the platform extractor couldn't fully identify:
   * moov → trak → mdia → minf → stbl → stsd, reading the first sample-entry fourcc of each track
   * (fragmented MP4s keep their stsd in the init segment's moov too). Null if there is no
   * readable moov. Frame size and duration are left 0 — the retriever supplies those.
   */
  private fun readIsoTracks(ctx: android.content.Context, fileUri: String): TrackSummary? {
    val moov = try { scanIsoBoxes(ctx, fileUri, true).second } catch (e: Exception) { null } ?: return null
    var videoMime = ""
    var audioMime = ""
    var audioTracks = 0
    var trackCount = 0
    for (trak in findBoxes(moov, 0, moov.size, "trak")) {
      trackCount++
      var level = listOf(trak)
      for (name in listOf("mdia", "minf", "stbl", "stsd")) {
        level = level.flatMap { findBoxes(moov, it[0], it[1], name) }
      }
      val stsd = level.firstOrNull() ?: continue
      // stsd payload: version/flags (4) + entry count (4), then the entries (each: size + fourcc).
      // Validate the first entry's header so trailing/garbage bytes can't pose as a codec.
      if (stsd[0] + 16 > stsd[1]) continue
      if (be32(moov, stsd[0] + 4) <= 0L) continue
      val entrySize = be32(moov, stsd[0] + 8)
      if (entrySize < 8L || entrySize > (stsd[1] - (stsd[0] + 8)).toLong()) continue
      val fourcc = String(moov, stsd[0] + 12, 4, Charsets.ISO_8859_1)
      val v = videoMimeForFourcc(fourcc)
      val a = audioMimeForFourcc(fourcc)
      if (v != null) {
        if (videoMime.isEmpty()) videoMime = v
      } else if (a != null) {
        audioTracks++
        if (audioMime.isEmpty()) audioMime = a
      }
    }
    if (trackCount == 0) return null
    return TrackSummary(videoMime, audioMime, trackCount, audioTracks, 0, 0, 0L)
  }

  /** Prefer the extractor's findings; fill only what it missed from the moov fallback. */
  /** Read a bounded head of the file and find its Matroska track list (null: not found / unreadable). */
  private fun readMatroskaTracks(ctx: android.content.Context, fileUri: String): MatroskaTracks.Result? =
    runCatching {
      openMediaStream(ctx.contentResolver, fileUri).use { s ->
        val buf = ByteArray(MatroskaTracks.PREFIX_BYTES)
        var got = 0
        while (got < buf.size) {
          val n = s.read(buf, got, buf.size - got)
          if (n <= 0) break
          got += n
        }
        MatroskaTracks.parse(buf, got)
      }
    }.getOrNull()

  /**
   * The extractor's view of an MKV corrected by its own track list: audio comes from the track list
   * (the extractor hides codecs it can't decode); video keeps the extractor's more specific mime
   * when it has one (it tells Dolby Vision from plain HEVC), else the track list's.
   */
  private fun mergeMatroska(a: TrackSummary, mkv: MatroskaTracks.Result): TrackSummary = TrackSummary(
    if (a.videoMime.isNotEmpty()) a.videoMime else MatroskaTracks.videoMime(mkv.videoCodecId),
    if (mkv.audioTrackCount > 0) MatroskaTracks.audioMime(mkv.audioCodecId) else a.audioMime,
    maxOf(a.trackCount, mkv.trackCount),
    maxOf(a.audioTrackCount, mkv.audioTrackCount),
    a.width,
    a.height,
    a.durationMs,
  )

  private fun mergeTracks(a: TrackSummary, b: TrackSummary): TrackSummary = TrackSummary(
    if (a.videoMime.isNotEmpty()) a.videoMime else b.videoMime,
    if (a.audioMime.isNotEmpty()) a.audioMime else b.audioMime,
    maxOf(a.trackCount, b.trackCount),
    maxOf(a.audioTrackCount, b.audioTrackCount),
    a.width,
    a.height,
    a.durationMs,
  )

  private val ISO_SCAN_MAX_BOXES = 64

  /** moov larger than this is treated as corrupt and not read into memory. */
  private val ISO_MOOV_CAP_BYTES = 16L * 1024 * 1024


  private fun be32(b: ByteArray, off: Int): Long =
    ((b[off].toLong() and 0xff) shl 24) or ((b[off + 1].toLong() and 0xff) shl 16) or
      ((b[off + 2].toLong() and 0xff) shl 8) or (b[off + 3].toLong() and 0xff)

  private fun be64(b: ByteArray, off: Int): Long {
    var v = 0L
    for (i in 0 until 8) v = (v shl 8) or (b[off + i].toLong() and 0xff)
    return v
  }

  private fun readFully(s: InputStream, into: ByteArray, len: Int): Boolean {
    var got = 0
    while (got < len) {
      val n = s.read(into, got, len - got)
      if (n <= 0) return false
      got += n
    }
    return true
  }

  /** Feed exactly [count] bytes from the stream into the digest. */
  private fun digestFully(md: java.security.MessageDigest, s: InputStream, count: Long) {
    val buf = ByteArray(64 * 1024)
    var left = count
    while (left > 0) {
      val n = s.read(buf, 0, minOf(left, buf.size.toLong()).toInt())
      if (n <= 0) throw CodedException("fingerprint: unexpected EOF")
      md.update(buf, 0, n)
      left -= n
    }
  }

  /** skip() may short-skip (esp. content:// streams); loop, falling back to reads. */
  private fun skipFully(s: InputStream, count: Long): Boolean {
    var left = count
    val sink = ByteArray(8192)
    while (left > 0) {
      val skipped = s.skip(left)
      if (skipped > 0) {
        left -= skipped
      } else {
        val n = s.read(sink, 0, minOf(left, sink.size.toLong()).toInt())
        if (n <= 0) return false
        left -= n
      }
    }
    return true
  }

  /** Stop the HTTP + WS servers, proxy, advert, and the foreground service. Caller holds `lock`. */
  private fun teardown(ctx: android.content.Context) {
    server?.stop()
    server = null
    ctrl?.stop()
    ctrl = null
    proxy?.let { runCatching { it.stop() } }
    proxy = null
    nsd?.stopAdvertise()
    RailReelHostService.stop(ctx)
  }

  private companion object {
    /**
     * Read timeout for an accepted WS control connection. Must be > 2× the client keepalive
     * interval so the socket survives a missed ping. Keepalive is 10s (see syncClient.ts).
     */
    const val WS_SOCKET_READ_TIMEOUT_MS = 30_000

    /** Give up the faststart box walk after this many bytes of top-level headers/skips. */
    const val FASTSTART_SCAN_CAP = 64L * 1024 * 1024

    /** Bytes hashed from each end of the file for the quick integrity fingerprint. */
    const val FP_CHUNK_BYTES = 1L * 1024 * 1024

    /**
     * A real grant is base64url of 16 random bytes (22 chars). Accept a small range to allow
     * future sizing, but bound it so a malformed/oversized value can never reach the grant set.
     */
    fun isValidGrant(g: String): Boolean =
      g.length in 16..64 && g.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_' }
  }
}

/**
 * A movie source the host serves. Abstracts file:// (a real File) from content:// (a SAF document
 * streamed off the ContentResolver), so the byte-range server doesn't care which it got.
 */
private interface MediaSource {
  /** Total bytes; must be known so range responses can set Content-Length/Content-Range. */
  val length: Long
  /** Strong validator for the bytes; stable for the life of the source. */
  val etag: String
  /** Open a stream positioned at [offset]; the caller closes it. */
  fun openAt(offset: Long): InputStream
}

private class FileSource(private val file: File) : MediaSource {
  override val length = file.length()
  override val etag = "\"${file.lastModified()}-${file.length()}\""
  override fun openAt(offset: Long): InputStream {
    val fis = FileInputStream(file)
    if (offset > 0) {
      try {
        fis.channel.position(offset) // reliable seek (skip() may short-skip)
      } catch (e: Exception) {
        fis.close()
        throw e
      }
    }
    return fis
  }
}

private class ContentSource(
  private val resolver: ContentResolver,
  private val uri: Uri,
) : MediaSource {
  override val length: Long = resolveLength()
  override val etag = "\"${uri.toString().hashCode()}-$length\""

  private fun resolveLength(): Long {
    resolver.openFileDescriptor(uri, "r")?.use { pfd ->
      if (pfd.statSize >= 0) return pfd.statSize
    }
    // Some providers report an unknown statSize; fall back to the OpenableColumns size.
    resolver.query(uri, arrayOf(android.provider.OpenableColumns.SIZE), null, null, null)?.use { c ->
      val idx = c.getColumnIndex(android.provider.OpenableColumns.SIZE)
      if (idx >= 0 && c.moveToFirst() && !c.isNull(idx)) return c.getLong(idx)
    }
    throw IOException("content length unknown for $uri")
  }

  override fun openAt(offset: Long): InputStream {
    val pfd = resolver.openFileDescriptor(uri, "r") ?: throw IOException("cannot open $uri")
    val fis = FileInputStream(pfd.fileDescriptor)
    try {
      if (offset > 0) fis.channel.position(offset)
    } catch (e: Exception) {
      runCatching { fis.close() }
      runCatching { pfd.close() }
      throw e
    }
    // NanoHTTPD closes the response stream when done; make that release the fd too.
    return object : FilterInputStream(fis) {
      override fun close() {
        try {
          super.close()
        } finally {
          pfd.close()
        }
      }
    }
  }
}

private class FileServer(
  port: Int,
  private val media: MediaSource,
  private val token: String,
) : NanoHTTPD(port) {
  private val etag = media.etag

  // Per-client download grants the host has approved. The session token gets a client onto the
  // network; only an approved grant unlocks the bytes (docs/architecture.md §10). Set operations
  // (add/remove/contains) are each individually synchronized — we never iterate it.
  private val approvedGrants = java.util.Collections.synchronizedSet(mutableSetOf<String>())

  fun approve(grant: String) { approvedGrants.add(grant) }
  fun revoke(grant: String) { approvedGrants.remove(grant) }

  override fun serve(session: IHTTPSession): Response {
    if (session.method != Method.GET && session.method != Method.HEAD) {
      return newFixedLengthResponse(Response.Status.METHOD_NOT_ALLOWED, TEXT, "method not allowed")
    }
    // Token gate (query param ?tk= — works from fetch/expo-file-system without custom headers).
    if (session.parameters["tk"]?.firstOrNull() != token) {
      return newFixedLengthResponse(Response.Status.FORBIDDEN, TEXT, "forbidden")
    }
    // Approval gate: a valid token is not enough — the client must present a grant the host
    // approved. Covers HEAD (size probe) too, so an unapproved client learns nothing.
    val grant = session.parameters["g"]?.firstOrNull()
    if (grant == null || grant !in approvedGrants) {
      return newFixedLengthResponse(Response.Status.FORBIDDEN, TEXT, "not approved")
    }

    val fileLen = media.length

    if (session.method == Method.HEAD) {
      return newFixedLengthResponse(Response.Status.OK, MIME, "").apply {
        addHeader("Accept-Ranges", "bytes")
        addHeader("Content-Length", fileLen.toString())
        addHeader("ETag", etag)
      }
    }

    val rangeHeader = session.headers["range"] ?: session.headers.entries.firstOrNull { it.key.equals("range", ignoreCase = true) }?.value
    return when (val r = parseByteRange(rangeHeader, fileLen)) {
      ByteRange.Full -> newFixedLengthResponse(Response.Status.OK, MIME, media.openAt(0), fileLen).apply {
        addHeader("Accept-Ranges", "bytes")
        addHeader("ETag", etag)
      }
      ByteRange.Unsatisfiable -> newFixedLengthResponse(Response.Status.RANGE_NOT_SATISFIABLE, TEXT, "").apply {
        addHeader("Content-Range", "bytes */$fileLen")
        addHeader("Accept-Ranges", "bytes")
      }
      is ByteRange.Partial -> {
        val contentLen = r.end - r.start + 1
        newFixedLengthResponse(Response.Status.PARTIAL_CONTENT, MIME, media.openAt(r.start), contentLen).apply {
          addHeader("Accept-Ranges", "bytes")
          addHeader("Content-Range", "bytes ${r.start}-${r.end}/$fileLen")
          addHeader("ETag", etag)
        }
      }
    }
  }

  companion object {
    private const val MIME = "application/octet-stream"
    private const val TEXT = "text/plain"
  }
}

/** HTTP single-range parse result — shared by the host data plane and the client playback proxy. */
internal sealed interface ByteRange {
  data object Full : ByteRange
  data object Unsatisfiable : ByteRange
  data class Partial(val start: Long, val end: Long) : ByteRange
}

/**
 * Strict single-range parser against a total length: supports `bytes=a-b`, `bytes=a-`, and suffix
 * `bytes=-n`. Malformed specs fall back to Full (serve the whole body), per RFC 7233's
 * ignore-invalid-Range allowance. ONE implementation — the data plane and the playback proxy must
 * answer the identical Range request identically.
 */
internal fun parseByteRange(header: String?, totalLen: Long): ByteRange {
  val trimmed = header?.trim() ?: return ByteRange.Full
  if (!trimmed.startsWith("bytes=", ignoreCase = true)) return ByteRange.Full
  val spec = trimmed.substring(6).trim()
  if (spec.contains(",")) return ByteRange.Full // multi-range unsupported → serve full body
  val dash = spec.indexOf('-')
  if (dash < 0) return ByteRange.Full
  val startStr = spec.substring(0, dash).trim()
  val endStr = spec.substring(dash + 1).trim()
  if (totalLen == 0L) return ByteRange.Unsatisfiable

  if (startStr.isEmpty()) {
    // suffix range: last N bytes
    val n = endStr.toLongOrNull() ?: return ByteRange.Full
    if (n <= 0L) return ByteRange.Unsatisfiable
    return ByteRange.Partial(maxOf(0L, totalLen - n), totalLen - 1)
  }
  val start = startStr.toLongOrNull() ?: return ByteRange.Full
  if (start < 0 || start >= totalLen) return ByteRange.Unsatisfiable
  val end = if (endStr.isEmpty()) totalLen - 1 else (endStr.toLongOrNull() ?: return ByteRange.Full)
  val realEnd = minOf(end, totalLen - 1)
  if (realEnd < start) return ByteRange.Unsatisfiable
  return ByteRange.Partial(start, realEnd)
}
