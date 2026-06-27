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

  override fun definition() = ModuleDefinition {
    Name("RailReelHost")

    AsyncFunction("start") { fileUri: String, port: Int, token: String ->
      if (token.isBlank()) throw CodedException("Session token must not be empty")
      val file = File(fileUri.removePrefix("file://"))
      if (!file.exists() || !file.canRead()) {
        throw CodedException("File not found or unreadable: ${file.path}")
      }
      synchronized(lock) {
        server?.stop()
        server = null
        val s = FileServer(port, file, token)
        try {
          s.start(NanoHTTPD.SOCKET_READ_TIMEOUT, true) // daemon listener thread
        } catch (e: Exception) {
          runCatching { s.stop() }
          throw CodedException("Failed to start server: ${e.message}")
        }
        server = s
        s.listeningPort
      }
    }

    AsyncFunction("stop") {
      synchronized(lock) {
        server?.stop()
        server = null
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
        server?.stop()
        server = null
      }
    }
  }
}

private class FileServer(
  port: Int,
  private val file: File,
  private val token: String,
) : NanoHTTPD(port) {
  private val etag = "\"${file.lastModified()}-${file.length()}\""

  override fun serve(session: IHTTPSession): Response {
    if (session.method != Method.GET && session.method != Method.HEAD) {
      return newFixedLengthResponse(Response.Status.METHOD_NOT_ALLOWED, TEXT, "method not allowed")
    }
    // Token gate (query param ?tk= — works from fetch/expo-file-system without custom headers).
    if (session.parameters["tk"]?.firstOrNull() != token) {
      return newFixedLengthResponse(Response.Status.FORBIDDEN, TEXT, "forbidden")
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
