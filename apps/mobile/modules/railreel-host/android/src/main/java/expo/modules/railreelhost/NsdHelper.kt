package expo.modules.railreelhost

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo

/**
 * mDNS (Android NSD) for tap-to-join: the host ADVERTISES its session on `_railreel._tcp` and
 * guests DISCOVER nearby cabins without typing anything (PRD §6 — the QR/link stays as the
 * robust fallback; the 4-letter code becomes a human confirmation, not transport).
 *
 * NsdManager quirks handled here: resolveService() only tolerates ONE in-flight resolve (a
 * second gets FAILURE_ALREADY_ACTIVE), so found services go through a sequential queue; and all
 * listener callbacks arrive on binder threads — the caller hops to the JS thread in its emitter.
 */
class NsdHelper(
  private val ctx: Context,
  /** (event, payload) — "found" carries host/port/txt, "lost" the service name. */
  private val emit: (String, Map<String, Any?>) -> Unit,
) {
  private val nsd: NsdManager = ctx.getSystemService(Context.NSD_SERVICE) as NsdManager
  private val lock = Any()

  private var registration: NsdManager.RegistrationListener? = null
  private var discovery: NsdManager.DiscoveryListener? = null
  private val resolveQueue = ArrayDeque<NsdServiceInfo>()
  private var resolving = false

  // ── host: advertise ─────────────────────────────────────────────────────────
  fun advertise(name: String, port: Int, txt: Map<String, String>) {
    synchronized(lock) {
      stopAdvertiseLocked()
      val info = NsdServiceInfo().apply {
        serviceName = name
        serviceType = SERVICE_TYPE
        setPort(port)
        txt.forEach { (k, v) -> setAttribute(k, v) }
      }
      val listener = object : NsdManager.RegistrationListener {
        override fun onServiceRegistered(i: NsdServiceInfo) {}
        override fun onRegistrationFailed(i: NsdServiceInfo, error: Int) {}
        override fun onServiceUnregistered(i: NsdServiceInfo) {}
        override fun onUnregistrationFailed(i: NsdServiceInfo, error: Int) {}
      }
      nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
      registration = listener
    }
  }

  fun stopAdvertise() = synchronized(lock) { stopAdvertiseLocked() }

  private fun stopAdvertiseLocked() {
    registration?.let { runCatching { nsd.unregisterService(it) } }
    registration = null
  }

  // ── guest: discover ─────────────────────────────────────────────────────────
  fun startDiscovery() {
    synchronized(lock) {
      stopDiscoveryLocked()
      val listener = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(type: String) {}
        override fun onStartDiscoveryFailed(type: String, error: Int) {}
        override fun onStopDiscoveryFailed(type: String, error: Int) {}
        override fun onDiscoveryStopped(type: String) {}
        override fun onServiceFound(info: NsdServiceInfo) {
          if (info.serviceType.trimEnd('.') != SERVICE_TYPE.trimEnd('.')) return
          synchronized(lock) {
            resolveQueue.addLast(info)
            drainResolveQueueLocked()
          }
        }
        override fun onServiceLost(info: NsdServiceInfo) {
          emit("lost", mapOf("name" to info.serviceName))
        }
      }
      nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
      discovery = listener
    }
  }

  fun stopDiscovery() {
    synchronized(lock) {
      stopDiscoveryLocked()
      resolveQueue.clear()
    }
  }

  private fun stopDiscoveryLocked() {
    discovery?.let { runCatching { nsd.stopServiceDiscovery(it) } }
    discovery = null
  }

  /** One resolve at a time; NsdManager rejects concurrent resolves. Caller holds `lock`. */
  private fun drainResolveQueueLocked() {
    if (resolving || discovery == null) return
    val next = resolveQueue.removeFirstOrNull() ?: return
    resolving = true
    try {
      nsd.resolveService(next, object : NsdManager.ResolveListener {
        override fun onResolveFailed(info: NsdServiceInfo, error: Int) {
          synchronized(lock) {
            resolving = false
            drainResolveQueueLocked()
          }
        }
        override fun onServiceResolved(info: NsdServiceInfo) {
          synchronized(lock) {
            if (discovery != null) {
              val host = info.host?.hostAddress
              if (host != null) {
                val txt = info.attributes.entries.associate { (k, v) -> k to (v?.toString(Charsets.UTF_8) ?: "") }
                emit(
                  "found",
                  mapOf(
                    "name" to info.serviceName,
                    "host" to host,
                    "port" to info.port,
                    "txt" to txt,
                  ),
                )
              }
            }
            resolving = false
            drainResolveQueueLocked()
          }
        }
      })
    } catch (e: Exception) {
      resolving = false
      drainResolveQueueLocked()
    }
  }

  fun teardown() {
    stopAdvertise()
    stopDiscovery()
  }

  private companion object {
    const val SERVICE_TYPE = "_railreel._tcp."
  }
}
