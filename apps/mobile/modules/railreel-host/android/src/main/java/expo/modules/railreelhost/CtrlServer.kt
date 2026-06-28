package expo.modules.railreelhost

import android.os.SystemClock
import fi.iki.elonen.NanoWSD
import org.json.JSONObject
import java.io.IOException
import java.util.Collections

/**
 * WebSocket control plane for the host. Carries clock sync + play/pause/seek/chat/reactions.
 *
 * The NTP-style clock handshake is answered HERE in native code using a MONOTONIC clock
 * (SystemClock.elapsedRealtimeNanos), which is more accurate than JS timers — `syncPing` never
 * crosses the bridge. Everything else is forwarded to JS via `onEvent` and the host broadcasts
 * state with `broadcast()`. Token-gated via ?tk=. See docs/data-plane-module.md (M3).
 */
class CtrlServer(
  port: Int,
  private val token: String,
  /** type ∈ {"open","close","message"}; payload is the text frame for "message". */
  private val onEvent: (type: String, payload: String?) -> Unit,
) : NanoWSD(port) {

  private val clients = Collections.synchronizedSet(mutableSetOf<WebSocket>())

  override fun openWebSocket(handshake: IHTTPSession): WebSocket = CtrlSocket(handshake)

  /** Send a text frame to every connected client. Prune any whose send fails. */
  fun broadcast(text: String) {
    // Snapshot under the lock, then write outside it so a slow client can't block the others.
    val snapshot = synchronized(clients) { clients.toList() }
    val dead = snapshot.filter { c -> runCatching { c.send(text) }.isFailure }
    if (dead.isNotEmpty()) synchronized(clients) { clients.removeAll(dead.toSet()) }
  }

  private inner class CtrlSocket(private val handshake: IHTTPSession) : WebSocket(handshake) {
    // True once the socket passed the token gate and was added to `clients`. Guards against
    // emitting a phantom "close" for a connection that was never accepted (NanoWSD still runs
    // onClose after we reject an unauthorized upgrade).
    private var accepted = false

    override fun onOpen() {
      if (handshake.parameters["tk"]?.firstOrNull() != token) {
        runCatching { close(WebSocketFrame.CloseCode.PolicyViolation, "unauthorized", false) }
        return
      }
      accepted = true
      clients.add(this)
      onEvent("open", null)
    }

    override fun onClose(code: WebSocketFrame.CloseCode?, reason: String?, initiatedByRemote: Boolean) {
      clients.remove(this)
      if (accepted) onEvent("close", null)
    }

    override fun onMessage(message: WebSocketFrame) {
      val recvMs = nowMs() // capture receipt time immediately (monotonic)
      val text = message.textPayload ?: return
      val obj = runCatching { JSONObject(text) }.getOrNull()
      if (obj?.optString("t") == "syncPing") {
        // Answer the clock handshake natively for accuracy. Only reply to a well-formed ping
        // (finite t1) so a malformed frame can't produce a NaN sample on the client.
        val t1 = obj.opt("t1")
        if (t1 is Number && t1.toDouble().isFinite()) {
          val pong = JSONObject()
            .put("t", "syncPong")
            .put("t1", t1)
            .put("t2", recvMs)
            .put("t3", nowMs())
          runCatching { send(pong.toString()) }
        }
        return
      }
      onEvent("message", text)
    }

    override fun onPong(pong: WebSocketFrame?) {}

    override fun onException(exception: IOException?) {
      clients.remove(this)
    }
  }

  companion object {
    /** Monotonic milliseconds (includes deep sleep); never wall-clock. */
    private fun nowMs(): Double = SystemClock.elapsedRealtimeNanos() / 1_000_000.0
  }
}
