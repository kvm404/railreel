package expo.modules.railreelhost

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.exception.CodedException
import fi.iki.elonen.NanoHTTPD
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

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

  override fun definition() = ModuleDefinition {
    Name("RailReelHost")
    Events("onWsOpen", "onWsClose", "onWsMessage")

    AsyncFunction("start") { fileUri: String, httpPort: Int, wsPort: Int, token: String ->
      if (token.isBlank()) throw CodedException("Session token must not be empty")
      val file = File(fileUri.removePrefix("file://"))
      if (!file.exists() || !file.canRead()) {
        throw CodedException("File not found or unreadable: ${file.path}")
      }
      synchronized(lock) {
        val ctx = appContext.reactContext ?: throw CodedException("No app context")
        // Fully tear down any previous session first.
        teardown(ctx)

        val s = FileServer(httpPort, file, token)
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
              "close" -> sendEvent("onWsClose", mapOf<String, Any?>())
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
      }
    }
  }

  /** Stop the HTTP + WS servers and the foreground service. Caller holds `lock`. */
  private fun teardown(ctx: android.content.Context) {
    server?.stop()
    server = null
    ctrl?.stop()
    ctrl = null
    RailReelHostService.stop(ctx)
  }

  private companion object {
    /**
     * Read timeout for an accepted WS control connection. Must be > 2× the client keepalive
     * interval so the socket survives a missed ping. Keepalive is 10s (see syncClient.ts).
     */
    const val WS_SOCKET_READ_TIMEOUT_MS = 30_000

    /**
     * A real grant is base64url of 16 random bytes (22 chars). Accept a small range to allow
     * future sizing, but bound it so a malformed/oversized value can never reach the grant set.
     */
    fun isValidGrant(g: String): Boolean =
      g.length in 16..64 && g.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_' }
  }
}

private class FileServer(
  port: Int,
  private val file: File,
  private val token: String,
) : NanoHTTPD(port) {
  private val etag = "\"${file.lastModified()}-${file.length()}\""

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

    val fileLen = file.length()

    if (session.method == Method.HEAD) {
      return newFixedLengthResponse(Response.Status.OK, MIME, "").apply {
        addHeader("Accept-Ranges", "bytes")
        addHeader("Content-Length", fileLen.toString())
        addHeader("ETag", etag)
      }
    }

    return when (val r = parseRange(session.headers["range"], fileLen)) {
      Range.Full -> newFixedLengthResponse(Response.Status.OK, MIME, FileInputStream(file), fileLen).apply {
        addHeader("Accept-Ranges", "bytes")
        addHeader("ETag", etag)
      }
      Range.Unsatisfiable -> newFixedLengthResponse(Response.Status.RANGE_NOT_SATISFIABLE, TEXT, "").apply {
        addHeader("Content-Range", "bytes */$fileLen")
        addHeader("Accept-Ranges", "bytes")
      }
      is Range.Partial -> {
        val contentLen = r.end - r.start + 1
        val fis = FileInputStream(file)
        try {
          fis.channel.position(r.start) // reliable seek (skip() may short-skip)
        } catch (e: Exception) {
          fis.close()
          throw e
        }
        newFixedLengthResponse(Response.Status.PARTIAL_CONTENT, MIME, fis, contentLen).apply {
          addHeader("Accept-Ranges", "bytes")
          addHeader("Content-Range", "bytes ${r.start}-${r.end}/$fileLen")
          addHeader("ETag", etag)
        }
      }
    }
  }

  private sealed interface Range {
    data object Full : Range
    data object Unsatisfiable : Range
    data class Partial(val start: Long, val end: Long) : Range
  }

  /** Strict single-range parser: supports `bytes=a-b`, `bytes=a-`, suffix `bytes=-n`. */
  private fun parseRange(header: String?, fileLen: Long): Range {
    if (header == null || !header.startsWith("bytes=")) return Range.Full
    val spec = header.removePrefix("bytes=").trim()
    if (spec.contains(",")) return Range.Full // multi-range unsupported → serve full body
    val dash = spec.indexOf('-')
    if (dash < 0) return Range.Full
    val startStr = spec.substring(0, dash).trim()
    val endStr = spec.substring(dash + 1).trim()
    if (fileLen == 0L) return Range.Unsatisfiable

    if (startStr.isEmpty()) {
      // suffix range: last N bytes
      val n = endStr.toLongOrNull() ?: return Range.Full
      if (n <= 0L) return Range.Unsatisfiable
      return Range.Partial(maxOf(0L, fileLen - n), fileLen - 1)
    }
    val start = startStr.toLongOrNull() ?: return Range.Full
    if (start < 0 || start >= fileLen) return Range.Unsatisfiable
    val end = if (endStr.isEmpty()) fileLen - 1 else (endStr.toLongOrNull() ?: return Range.Full)
    val realEnd = minOf(end, fileLen - 1)
    if (realEnd < start) return Range.Unsatisfiable
    return Range.Partial(start, realEnd)
  }

  companion object {
    private const val MIME = "application/octet-stream"
    private const val TEXT = "text/plain"
  }
}
