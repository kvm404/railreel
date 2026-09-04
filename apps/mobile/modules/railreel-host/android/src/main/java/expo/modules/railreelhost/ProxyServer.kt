package expo.modules.railreelhost

import fi.iki.elonen.NanoHTTPD
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.RandomAccessFile

/**
 * Client-side playback proxy: serves the movie file WHILE IT IS STILL DOWNLOADING, so the player
 * never opens a partially-written file directly (docs/architecture.md §4, PRD §6). Bound to
 * 127.0.0.1 only — it exists purely so ExoPlayer has an HTTP source it can range-request.
 *
 * The trick: responses declare the FINAL size (`expectedBytes`, known from the host's
 * Content-Length) even though the file on disk is still growing. A read that catches up with the
 * download edge simply blocks until more bytes land — to ExoPlayer that is indistinguishable from
 * a slow network, so it buffers/rebuffers with its normal machinery and our stall reporting
 * (stallReport → room hold) does the rest.
 */
class ProxyServer(
  private val file: File,
  private val expectedBytes: Long,
) : NanoHTTPD("127.0.0.1", 0) {

  @Volatile private var stopped = false

  override fun stop() {
    stopped = true // unblock any reader sleeping at the download edge
    super.stop()
  }

  override fun serve(session: IHTTPSession): Response {
    if (session.method != Method.GET && session.method != Method.HEAD) {
      return newFixedLengthResponse(Response.Status.METHOD_NOT_ALLOWED, TEXT, "method not allowed")
    }

    if (session.method == Method.HEAD) {
      return newFixedLengthResponse(Response.Status.OK, MIME, "").apply {
        addHeader("Accept-Ranges", "bytes")
        addHeader("Content-Length", expectedBytes.toString())
      }
    }

    val rangeHeader = session.headers["range"] ?: session.headers.entries.firstOrNull { it.key.equals("range", ignoreCase = true) }?.value
    return when (val r = parseByteRange(rangeHeader, expectedBytes)) {
      ByteRange.Full -> newFixedLengthResponse(Response.Status.OK, MIME, GrowingFileInputStream(0, expectedBytes), expectedBytes).apply {
        addHeader("Accept-Ranges", "bytes")
      }
      ByteRange.Unsatisfiable -> newFixedLengthResponse(Response.Status.RANGE_NOT_SATISFIABLE, TEXT, "").apply {
        addHeader("Content-Range", "bytes */$expectedBytes")
      }
      is ByteRange.Partial -> {
        val contentLen = r.end - r.start + 1
        newFixedLengthResponse(Response.Status.PARTIAL_CONTENT, MIME, GrowingFileInputStream(r.start, r.end + 1), contentLen).apply {
          addHeader("Accept-Ranges", "bytes")
          addHeader("Content-Range", "bytes ${r.start}-${r.end}/$expectedBytes")
        }
      }
    }
  }

  /**
   * Reads [start, endExclusive) of a file that is still being written. At the download edge it
   * waits for more bytes (the download writes in place), giving up only if nothing arrives for
   * EDGE_STALL_TIMEOUT_MS (download died) or the proxy is stopped — then the socket errors and
   * ExoPlayer's own retry/stall handling takes over.
   *
   * Reads are strictly sequential, so the fd is positioned once at open; growth checks go through
   * the open fd's length() (no per-poll path re-stat).
   */
  private inner class GrowingFileInputStream(
    start: Long,
    private val endExclusive: Long,
  ) : InputStream() {
    private var pos = start
    @Volatile private var closed = false
    private var raf: RandomAccessFile? = null

    override fun read(): Int {
      val one = ByteArray(1)
      val n = read(one, 0, 1)
      return if (n <= 0) -1 else one[0].toInt() and 0xff
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
      if (len == 0) return 0
      if (stopped || closed) throw IOException("stream closed")
      if (pos >= endExclusive) return -1
      var waitedMs = 0L
      while (!stopped && !closed) {
        // The file may not exist yet (download about to create it): open lazily, position once.
        val r = synchronized(this) {
          if (closed) return@synchronized null
          raf ?: if (file.exists()) RandomAccessFile(file, "r").also { it.seek(pos); raf = it } else null
        }
        if (closed || stopped) throw IOException("stream closed")
        if (r != null) {
          val available = r.length() - pos
          if (available > 0) {
            val want = minOf(len.toLong(), available, endExclusive - pos).toInt()
            val n = r.read(b, off, want)
            if (n > 0) {
              pos += n
              return n
            }
          }
        }
        if (waitedMs >= EDGE_STALL_TIMEOUT_MS) throw IOException("download edge stalled")
        try {
          Thread.sleep(EDGE_POLL_MS)
        } catch (e: InterruptedException) {
          Thread.currentThread().interrupt()
          throw IOException("stream interrupted", e)
        }
        waitedMs += EDGE_POLL_MS
      }
      throw IOException(if (closed) "stream closed" else "proxy stopped")
    }

    override fun close() {
      closed = true
      synchronized(this) {
        raf?.close()
        raf = null
      }
      super.close()
    }
  }

  private companion object {
    private const val MIME = "video/mp4"
    private const val TEXT = "text/plain"
    private const val EDGE_POLL_MS = 100L

    /** No new bytes for this long = the download is dead, not slow; error the read out. */
    private const val EDGE_STALL_TIMEOUT_MS = 30_000L
  }
}
