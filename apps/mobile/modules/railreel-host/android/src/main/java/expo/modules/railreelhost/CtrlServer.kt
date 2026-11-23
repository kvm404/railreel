package expo.modules.railreelhost

import android.os.SystemClock
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoWSD
import org.json.JSONObject
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * WebSocket control plane for the host. Carries clock sync + play/pause/seek/chat/reactions.
 *
 * The NTP-style clock handshake is answered HERE in native code using a MONOTONIC clock
 * (SystemClock.elapsedRealtimeNanos), which is more accurate than JS timers — `syncPing` never
 * crosses the bridge. Everything else is forwarded to JS via `onEvent`. Token-gated via ?tk=.
 * See docs/data-plane-module.md (M3).
 *
 * Hardening (the session token is in the mDNS TXT record, so any phone on the hotspot can open a
 * socket — treat every peer as untrusted until the host approves it):
 *  - Every accepted connection gets an opaque native `connId`; every event to JS carries it, and
 *    JS binds a participant to the connection that proved it. Identity is never read from frames
 *    here.
 *  - Inbound frames pass through [FrameGuardInputStream], which rejects an oversized declared
 *    length BEFORE NanoWSD allocates the payload (NanoWSD 2.3.1 trusts it up to 2 GiB), caps
 *    reassembled fragments, and rate-limits frames. JS-bound messages are rate-limited too.
 *  - Outbound frames go through a bounded per-socket queue drained by that socket's own writer
 *    thread, so a peer that stops reading can only stall itself. A watchdog force-closes the TCP
 *    socket of a writer stuck mid-frame — without touching NanoWSD's send monitor, which the
 *    stuck writer holds (its close() would block on that same monitor).
 *  - `broadcast` reaches only connections JS marked approved; a pending requester gets nothing
 *    but what JS sends it directly (`sendTo`, e.g. its requestDecision).
 */
class CtrlServer(
  port: Int,
  private val token: String,
  /** type ∈ {"open","close","message"}; payload is the text frame for "message", else null. */
  private val onEvent: (type: String, connId: String, payload: String?) -> Unit,
) : NanoWSD(port) {

  private val sockets = ConcurrentHashMap<String, CtrlSocket>()
  private val connSeq = AtomicLong(0)
  // Random per server instance so a connection id from a previous session can never collide with
  // one from this session in JS's bindings.
  private val connPrefix = UUID.randomUUID().toString().substring(0, 8)
  @Volatile private var stopped = false

  private val watchdog: ScheduledExecutorService =
    Executors.newSingleThreadScheduledExecutor { r ->
      Thread(r, "railreel-ws-watchdog").apply { isDaemon = true }
    }

  init {
    watchdog.scheduleWithFixedDelay({ sweepStuckWriters() }, WATCHDOG_MS, WATCHDOG_MS, TimeUnit.MILLISECONDS)
  }

  // Remember which TCP socket each handler thread serves, so openWebSocket (which runs on that
  // same thread) can hand the socket to the WebSocket for a monitor-free force-close.
  override fun createClientHandler(finalAccept: Socket, inputStream: InputStream): NanoHTTPD.ClientHandler =
    super.createClientHandler(finalAccept, SocketTaggingInputStream(inputStream, finalAccept))

  override fun openWebSocket(handshake: IHTTPSession): WebSocket = CtrlSocket(handshake, handlerSocket.get())

  /** Queue a text frame for every APPROVED connection. Never blocks (see class doc). */
  fun broadcast(text: String) {
    if (stopped) return
    for (c in sockets.values) {
      if (c.approved) c.enqueue(text)
    }
  }

  /** Queue a text frame for one connection, approved or not. False if it is gone. */
  fun sendTo(connId: String, text: String): Boolean = !stopped && (sockets[connId]?.enqueue(text) ?: false)

  /** Let a connection receive broadcasts (JS calls this once it bound an approved guest to it). */
  fun approveConnection(connId: String): Boolean {
    val c = sockets[connId] ?: return false
    c.approved = true
    return true
  }

  /** Stop broadcasting to a connection and close it after anything already queued is sent. */
  fun dropConnection(connId: String): Boolean {
    val c = sockets[connId] ?: return false
    c.approved = false
    c.enqueue(CloseSignal)
    return true
  }

  override fun stop() {
    stopped = true
    runCatching { watchdog.shutdownNow() }
    for (c in sockets.values.toList()) c.forceClose()
    super.stop()
  }

  private fun sweepStuckWriters() {
    try {
      val now = SystemClock.elapsedRealtime()
      for (c in sockets.values) c.checkStuck(now)
    } catch (e: Exception) {
      // Never let one bad sweep cancel the schedule.
    }
  }

  /** Marker queued by dropConnection: close gracefully once earlier frames are flushed. */
  private object CloseSignal

  private inner class CtrlSocket(
    private val handshake: IHTTPSession,
    /** The raw TCP socket (null only if the handler thread wasn't tagged — then streams are closed). */
    private val tcp: Socket?,
  ) : WebSocket(GuardedSession(handshake, FrameGuardInputStream(handshake.inputStream))) {
    val connId: String = "$connPrefix-${connSeq.incrementAndGet()}"

    /** JS approved the guest bound to this connection: it receives broadcasts. */
    @Volatile var approved = false

    // True once the socket passed the token gate and was registered. Guards against emitting a
    // phantom "close" for a connection that was never accepted (NanoWSD still runs onClose after
    // we reject an unauthorized upgrade).
    @Volatile private var accepted = false
    private val closedEmitted = AtomicBoolean(false)
    private val outbox = LinkedBlockingQueue<Any>(OUTBOX_CAPACITY)
    private val messageBudget = TokenBucket(MESSAGE_BURST, MESSAGE_PER_SEC)
    @Volatile private var writer: Thread? = null
    /** elapsedRealtime when the writer began the frame it is on now; 0 while idle. */
    @Volatile private var writeStartedAt = 0L
    /** elapsedRealtime when a graceful close was sent; the peer gets CLOSE_GRACE_MS to finish it. */
    @Volatile private var closeRequestedAt = 0L

    fun enqueue(item: Any): Boolean {
      if (!accepted || closedEmitted.get()) return false
      if (outbox.offer(item)) return true
      // A peer that let OUTBOX_CAPACITY frames pile up isn't reading — cut it loose.
      forceClose()
      return false
    }

    fun checkStuck(now: Long) {
      val w = writeStartedAt
      val c = closeRequestedAt
      if ((w != 0L && now - w > WRITE_TIMEOUT_MS) || (c != 0L && now - c > CLOSE_GRACE_MS)) forceClose()
    }

    /**
     * Tear the connection down from any thread WITHOUT taking this WebSocket's monitor (a writer
     * blocked in sendFrame holds it). Closing the TCP socket unblocks that writer and the reader.
     */
    fun forceClose() {
      approved = false
      writer?.interrupt()
      runCatching { tcp?.close() }
      runCatching { getHandshakeRequest().getInputStream().close() } // the frame guard → socket input
      emitCloseOnce()
    }

    private fun emitCloseOnce() {
      if (accepted && closedEmitted.compareAndSet(false, true)) {
        approved = false
        sockets.remove(connId, this)
        writer?.interrupt()
        outbox.clear()
        onEvent("close", connId, null)
      }
    }

    private fun writeLoop() {
      try {
        while (true) {
          val item = outbox.take()
          writeStartedAt = SystemClock.elapsedRealtime()
          if (item === CloseSignal) {
            closeRequestedAt = writeStartedAt
            close(WebSocketFrame.CloseCode.NormalClosure, "closed by host", false)
            writeStartedAt = 0L
            return
          }
          send(item as String)
          writeStartedAt = 0L
        }
      } catch (e: InterruptedException) {
        // forceClose()/close: exit quietly.
      } catch (e: Exception) {
        forceClose()
      }
    }

    override fun onOpen() {
      if (handshake.parameters["tk"]?.firstOrNull() != token) {
        runCatching { close(WebSocketFrame.CloseCode.PolicyViolation, "unauthorized", false) }
        return
      }
      val admitted = synchronized(sockets) {
        if (stopped || sockets.size >= MAX_CONNECTIONS) {
          false
        } else {
          accepted = true
          sockets[connId] = this
          true
        }
      }
      if (!admitted) {
        runCatching { close(WebSocketFrame.CloseCode.PolicyViolation, "busy", false) }
        return
      }
      val w = Thread({ writeLoop() }, "railreel-ws-writer-$connId").apply { isDaemon = true }
      writer = w
      w.start()
      // stop() may have force-closed us before `writer` was set — don't leave it parked forever.
      if (closedEmitted.get()) w.interrupt()
      onEvent("open", connId, null)
    }

    override fun onClose(code: WebSocketFrame.CloseCode?, reason: String?, initiatedByRemote: Boolean) {
      emitCloseOnce()
    }

    override fun onMessage(message: WebSocketFrame) {
      val recvMs = nowMs() // capture receipt time immediately (monotonic)
      if (message.opCode != WebSocketFrame.OpCode.Text) return
      val text = message.textPayload ?: return
      val obj = runCatching { JSONObject(text) }.getOrNull() ?: return
      if (obj.optString("t") == "syncPing") {
        // Answer the clock handshake natively for accuracy. Only reply to a well-formed ping
        // (finite t1) so a malformed frame can't produce a NaN sample on the client. Sent inline
        // (not via the outbox) and t3 is stamped while holding the send monitor, so queueing
        // behind a broadcast can't skew the sample.
        val t1 = obj.opt("t1")
        if (t1 is Number && t1.toDouble().isFinite()) {
          val pong = JSONObject()
            .put("t", "syncPong")
            .put("t1", t1)
            .put("t2", recvMs)
          runCatching {
            synchronized(this@CtrlSocket) { // the same monitor NanoWSD's sendFrame takes
              pong.put("t3", nowMs())
              send(pong.toString())
            }
          }
        }
        return
      }
      // Over budget: drop. A real client stays far below it (beats ~3/s + chat/reactions).
      if (!messageBudget.tryTake()) return
      onEvent("message", connId, text)
    }

    override fun onPong(pong: WebSocketFrame?) {}

    override fun onException(exception: IOException?) {
      emitCloseOnce()
    }
  }

  companion object {
    /** Largest frame payload, and largest reassembled message, a client may send. */
    const val MAX_FRAME_BYTES = 64 * 1024
    const val MAX_MESSAGE_BYTES = 64 * 1024
    /** Fragments per message (zero-length continuations would otherwise pile up unbounded). */
    const val MAX_FRAGMENTS = 64
    /** Inbound frames (incl. sync pings), per connection: exceeding this closes the socket. */
    const val FRAME_BURST = 200.0
    const val FRAME_PER_SEC = 50.0
    /** Messages forwarded to JS, per connection: excess is dropped. */
    const val MESSAGE_BURST = 60.0
    const val MESSAGE_PER_SEC = 20.0
    /** Concurrent accepted sockets (4–6 guests, plus reconnect overlap before a stale one times out). */
    const val MAX_CONNECTIONS = 24
    /** Frames queued per socket before it is considered dead. */
    const val OUTBOX_CAPACITY = 256
    /** A single frame write taking longer than this means the peer stopped reading. */
    const val WRITE_TIMEOUT_MS = 10_000L
    const val CLOSE_GRACE_MS = 3_000L
    const val WATCHDOG_MS = 500L

    private val handlerSocket = ThreadLocal<Socket?>()

    /** Monotonic milliseconds (includes deep sleep); never wall-clock. */
    private fun nowMs(): Double = SystemClock.elapsedRealtimeNanos() / 1_000_000.0
  }

  /**
   * Wraps the raw socket stream NanoHTTPD hands each connection's handler thread. On first read
   * (which happens on that thread, before serve()/openWebSocket) it records the socket in a
   * thread-local. NanoHTTPD's DefaultAsyncRunner gives every connection its own thread.
   */
  private class SocketTaggingInputStream(input: InputStream, private val socket: Socket) : FilterInputStream(input) {
    private var tagged = false

    private fun tag() {
      if (!tagged) {
        tagged = true
        handlerSocket.set(socket)
      }
    }

    override fun read(): Int {
      tag()
      return super.read()
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
      tag()
      return super.read(b, off, len)
    }
  }
}

/** The handshake session with its input stream swapped for the frame guard (NanoWSD reads frames from it). */
private class GuardedSession(
  delegate: NanoHTTPD.IHTTPSession,
  private val guarded: InputStream,
) : NanoHTTPD.IHTTPSession by delegate {
  override fun getInputStream(): InputStream = guarded
}

/**
 * Parses the same WebSocket frame headers NanoWSD's `WebSocketFrame.read` is consuming, byte for
 * byte, and throws as soon as a declared length is over the limit — i.e. while NanoWSD is still
 * in readPayloadInfo, before readPayload allocates `new byte[length]`. Payload reads are clamped
 * to the current frame so the parser never loses sync; header bytes are handed out one at a time
 * (NanoWSD reads them that way anyway). Only NanoWSD's reader thread calls read().
 */
internal class FrameGuardInputStream(
  input: InputStream,
  private val maxFrameBytes: Int = CtrlServer.MAX_FRAME_BYTES,
  private val maxMessageBytes: Int = CtrlServer.MAX_MESSAGE_BYTES,
  private val maxFragments: Int = CtrlServer.MAX_FRAGMENTS,
  private val frameBudget: TokenBucket = TokenBucket(CtrlServer.FRAME_BURST, CtrlServer.FRAME_PER_SEC),
) : FilterInputStream(input) {
  private var phase = HEAD
  private var opcode = 0
  private var masked = false
  private var extLeft = 0
  private var length = 0L
  private var maskLeft = 0
  private var payloadLeft = 0L
  private var messageBytes = 0L
  private var fragments = 0

  override fun read(): Int {
    val b = super.read()
    if (b < 0) return b
    if (phase == PAYLOAD) {
      if (--payloadLeft == 0L) phase = HEAD
    } else {
      header(b)
    }
    return b
  }

  override fun read(b: ByteArray, off: Int, len: Int): Int {
    if (len == 0) return 0
    if (phase != PAYLOAD) {
      val one = read()
      if (one < 0) return -1
      b[off] = one.toByte()
      return 1
    }
    val n = super.read(b, off, minOf(len.toLong(), payloadLeft).toInt())
    if (n > 0) {
      payloadLeft -= n
      if (payloadLeft == 0L) phase = HEAD
    }
    return n
  }

  override fun skip(n: Long): Long = throw IOException("skip unsupported on a framed stream")

  override fun markSupported(): Boolean = false

  private fun header(b: Int) {
    when (phase) {
      HEAD -> {
        if (!frameBudget.tryTake()) tooMuch(NanoWSD.WebSocketFrame.CloseCode.PolicyViolation, "frame rate exceeded")
        opcode = b and 0x0F
        phase = LEN7
      }
      LEN7 -> {
        masked = (b and 0x80) != 0
        when (val l = b and 0x7F) {
          126 -> { extLeft = 2; length = 0L; phase = LEN_EXT }
          127 -> { extLeft = 8; length = 0L; phase = LEN_EXT }
          else -> { length = l.toLong(); lengthKnown() }
        }
      }
      LEN_EXT -> {
        length = (length shl 8) or b.toLong()
        // Fail on the first byte that pushes it over (also before a 64-bit length can overflow).
        if (length > maxFrameBytes) tooBig()
        if (--extLeft == 0) lengthKnown()
      }
      MASK -> {
        if (--maskLeft == 0) phase = if (payloadLeft == 0L) HEAD else PAYLOAD
      }
    }
  }

  private fun lengthKnown() {
    if (length > maxFrameBytes) tooBig()
    if (opcode < 0x8) { // data frame (text/binary/continuation); control frames are ≤125 B anyway
      if (opcode != 0x0) {
        messageBytes = 0L
        fragments = 0
      }
      messageBytes += length
      fragments++
      if (messageBytes > maxMessageBytes || fragments > maxFragments) tooBig()
    }
    payloadLeft = length
    if (masked) {
      maskLeft = 4
      phase = MASK
    } else {
      phase = if (payloadLeft == 0L) HEAD else PAYLOAD
    }
  }

  private fun tooBig(): Nothing = tooMuch(NanoWSD.WebSocketFrame.CloseCode.MessageTooBig, "message too big")

  private fun tooMuch(code: NanoWSD.WebSocketFrame.CloseCode, reason: String): Nothing =
    throw NanoWSD.WebSocketException(code, reason)

  private companion object {
    const val HEAD = 0
    const val LEN7 = 1
    const val LEN_EXT = 2
    const val MASK = 3
    const val PAYLOAD = 4
  }
}

/** Plain token bucket on the monotonic clock. */
internal class TokenBucket(private val capacity: Double, private val perSec: Double) {
  private var tokens = capacity
  private var last = SystemClock.elapsedRealtime()

  @Synchronized
  fun tryTake(): Boolean {
    val now = SystemClock.elapsedRealtime()
    tokens = minOf(capacity, tokens + (now - last) * perSec / 1000.0)
    last = now
    if (tokens < 1.0) return false
    tokens -= 1.0
    return true
  }
}
