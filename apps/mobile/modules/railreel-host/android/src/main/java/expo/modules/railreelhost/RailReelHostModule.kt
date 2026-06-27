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
 * v1 scope: serves a file:// path (M1 throughput). content:// (SAF) sources + foreground
 * service come in later milestones.
 */
class RailReelHostModule : Module() {
  private var server: FileServer? = null

  override fun definition() = ModuleDefinition {
    Name("RailReelHost")

    AsyncFunction("start") { fileUri: String, port: Int, token: String ->
      stopServer()
      val path = fileUri.removePrefix("file://")
      val file = File(path)
      if (!file.exists() || !file.canRead()) {
        throw CodedException("File not found or unreadable: $path")
      }
      val s = FileServer(port, file, token)
      // false = keep the server thread alive independent of the request thread
      s.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
      server = s
      return@AsyncFunction s.listeningPort
    }

    AsyncFunction("stop") {
      stopServer()
    }

    // DEV (M1): generate an N-MB test file in cache so we can measure throughput
    // without a media picker. Replaced by real content:// sources in later milestones.
    AsyncFunction("createTestFile") { sizeMb: Int ->
      val dir = appContext.reactContext?.cacheDir ?: throw CodedException("No cache dir")
      val f = File(dir, "railreel-test.bin")
      val buf = ByteArray(1024 * 1024)
      FileOutputStream(f).use { out -> repeat(sizeMb) { out.write(buf) } }
      return@AsyncFunction "file://${f.absolutePath}"
    }

    OnDestroy {
      stopServer()
    }
  }

  private fun stopServer() {
    server?.stop()
    server = null
  }
}

private class FileServer(
  port: Int,
  private val file: File,
  private val token: String,
) : NanoHTTPD(port) {
  private val etag = "\"${file.lastModified()}-${file.length()}\""

  override fun serve(session: IHTTPSession): Response {
    // Token gate (query param ?tk= — works from fetch/expo-file-system without custom headers).
    val tk = session.parameters["tk"]?.firstOrNull()
    if (tk != token) {
      return newFixedLengthResponse(Response.Status.FORBIDDEN, "text/plain", "forbidden")
    }

    val fileLen = file.length()

    // HEAD — advertise size + range support + validator.
    if (session.method == Method.HEAD) {
      val res = newFixedLengthResponse(Response.Status.OK, MIME, "")
      res.addHeader("Accept-Ranges", "bytes")
      res.addHeader("Content-Length", fileLen.toString())
      res.addHeader("ETag", etag)
      return res
    }

    val range = session.headers["range"]
    if (range != null && range.startsWith("bytes=")) {
      val spec = range.removePrefix("bytes=").split("-", limit = 2)
      val start = spec.getOrNull(0)?.takeIf { it.isNotEmpty() }?.toLongOrNull() ?: 0L
      val end = spec.getOrNull(1)?.takeIf { it.isNotEmpty() }?.toLongOrNull() ?: (fileLen - 1)

      if (start < 0 || start >= fileLen) {
        val res = newFixedLengthResponse(Response.Status.RANGE_NOT_SATISFIABLE, "text/plain", "")
        res.addHeader("Content-Range", "bytes */$fileLen")
        return res
      }
      val realEnd = if (end >= fileLen) fileLen - 1 else end
      val contentLen = realEnd - start + 1

      val fis = FileInputStream(file)
      fis.skip(start)
      // NanoHTTPD reads exactly `contentLen` bytes from the stream for the body.
      val res = newFixedLengthResponse(Response.Status.PARTIAL_CONTENT, MIME, fis, contentLen)
      res.addHeader("Accept-Ranges", "bytes")
      res.addHeader("Content-Range", "bytes $start-$realEnd/$fileLen")
      res.addHeader("ETag", etag)
      return res
    }

    // Full file.
    val res = newFixedLengthResponse(Response.Status.OK, MIME, FileInputStream(file), fileLen)
    res.addHeader("Accept-Ranges", "bytes")
    res.addHeader("ETag", etag)
    return res
  }

  companion object {
    private const val MIME = "application/octet-stream"
  }
}
