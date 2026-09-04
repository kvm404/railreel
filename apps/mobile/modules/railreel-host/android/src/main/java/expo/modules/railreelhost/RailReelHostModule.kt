package expo.modules.railreelhost

import android.content.ContentResolver
import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.exception.CodedException
import fi.iki.elonen.NanoHTTPD
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
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
    Events("onWsOpen", "onWsClose", "onWsMessage", "onNsdFound", "onNsdLost")

    // The host's own LAN/hotspot IPv4, for the QR/join link. NanoHTTPD binds to all interfaces,
    // so we pick the address clients actually reach: prefer the hotspot/wifi interface.
    Function("getHostIpAddress") { hostIpAddress() }

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

        val c = CtrlServer(wsPort, token) { type, payload ->
          // CtrlServer fires these from per-connection socket threads; hop to the JS thread
          // before touching the event emitter (sendEvent goes straight into JSI).
          appContext.runtime.schedule {
            when (type) {
              "open" -> sendEvent("onWsOpen", mapOf<String, Any?>())
              "close" -> sendEvent("onWsClose", if (payload != null) mapOf("id" to payload) else mapOf<String, Any?>())
              "message" -> sendEvent("onWsMessage", mapOf("data" to payload))
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

    // Host → all clients (play/pause/seek/chat/reactions as JSON strings).
    AsyncFunction("broadcast") { message: String ->
      // Grab the server under the lock, but do the socket writes outside it so a slow/blocked
      // client can't stall start/stop.
      val c = synchronized(lock) { ctrl }
      c?.broadcast(message)
    }

    AsyncFunction("stop") {
      synchronized(lock) {
        appContext.reactContext?.let { teardown(it) }
      }
    }

    // Probe the media the host picked: duration (start-gate math) and whether the MP4 is
    // "faststart" (moov before mdat) — a player can only open a PARTIALLY-downloaded file if the
    // moov atom is at the front, so non-faststart files must fully pre-cache before the show.
    // Works for both file:// paths and content:// (SAF) documents.
    AsyncFunction("probe") { fileUri: String ->
      val ctx = appContext.reactContext ?: throw CodedException("No app context")
      val retriever = android.media.MediaMetadataRetriever()
      try {
        if (fileUri.startsWith("content://")) {
          retriever.setDataSource(ctx, Uri.parse(fileUri))
        } else {
          retriever.setDataSource(fileUri.removePrefix("file://"))
        }
        val durationMs = retriever
          .extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)
          ?.toLongOrNull()
          ?: throw CodedException("Media has no readable duration")
        // Resolution feeds the (future) client decode-capability check — a 4K file plays as a
        // slideshow on phones whose hardware decoder tops out at 1080p.
        val width = retriever
          .extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
          ?.toIntOrNull() ?: 0
        val height = retriever
          .extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
          ?.toIntOrNull() ?: 0
        val fastStart = runCatching {
          openMediaStream(ctx.contentResolver, fileUri).use { isFastStart(it) }
        }.getOrNull()
        // Undeterminable layout (odd container, read error) → treat as NOT faststart: the cost of
        // being wrong is only a later start, never a frozen room.
        mapOf(
          "durationSec" to durationMs / 1000.0,
          "fastStart" to (fastStart ?: false),
          "width" to width,
          "height" to height,
        )
      } catch (e: CodedException) {
        throw e
      } catch (e: Exception) {
        throw CodedException("Cannot probe media: ${e.message}")
      } finally {
        runCatching { retriever.release() }
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

    // DEV (M1): generate an N-MB test file in cache so we can measure throughput
    // without a media picker. Replaced by real content:// sources in later milestones.
    AsyncFunction("createTestFile") { sizeMb: Int ->
      val dir = appContext.reactContext?.cacheDir ?: throw CodedException("No cache dir")
      val f = File(dir, "railreel-test.bin")
      val buf = ByteArray(1024 * 1024)
      FileOutputStream(f).use { out -> repeat(sizeMb) { out.write(buf) } }
      "file://${f.absolutePath}"
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
          sendEvent(if (kind == "found") "onNsdFound" else "onNsdLost", payload)
        }
      }.also { nsd = it }
    }
  }

  /**
   * Best-effort LAN IPv4 of this device. Prefers the hotspot/wifi interface (ap, wlan, swlan)
   * since when hosting that is the address guests on the hotspot can reach. Returns null if none.
   */
  private fun hostIpAddress(): String? = try {
    val candidates = NetworkInterface.getNetworkInterfaces().toList()
      .filter { it.isUp && !it.isLoopback }
      .flatMap { nif ->
        nif.inetAddresses.toList()
          .filter { !it.isLoopbackAddress && it is Inet4Address }
          .mapNotNull { addr -> addr.hostAddress?.let { nif.name to it } }
      }
    val preferred = candidates.firstOrNull { (name, _) ->
      name.startsWith("ap") || name.startsWith("swlan") || name.startsWith("wlan")
    }
    (preferred ?: candidates.firstOrNull())?.second
  } catch (e: Exception) {
    null
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
      if (size < headerLen || !skipFully(s, skip)) return null
      walked += size
    }
    return null
  }

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

  /** Stop the HTTP + WS servers, the advert, and the foreground service. Caller holds `lock`. */
  private fun teardown(ctx: android.content.Context) {
    server?.stop()
    server = null
    ctrl?.stop()
    ctrl = null
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

    return when (val r = parseByteRange(session.headers["range"], fileLen)) {
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
  if (header == null || !header.startsWith("bytes=")) return ByteRange.Full
  val spec = header.removePrefix("bytes=").trim()
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
