package expo.modules.railreelhost

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Foreground service that keeps the host process alive + the CPU/WiFi awake while sharing, so
 * the NanoHTTPD transfer keeps running with the screen off (the spike stalled because a
 * backgrounded app's work was paused). See docs/architecture.md §9 and docs/data-plane-module.md.
 *
 * The HTTP server itself lives in RailReelHostModule (native NanoHTTPD threads in the same
 * process); this service just prevents the OS from freezing/killing that process.
 */
class RailReelHostService : Service() {
  private var wifiLock: WifiManager.WifiLock? = null
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIF_ID, notification)
    }
    acquireLocks()
    return START_NOT_STICKY
  }

  private fun acquireLocks() {
    val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "railreel:wifi").apply {
      setReferenceCounted(false)
      acquire()
    }
    val power = applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "railreel:wake").apply {
      setReferenceCounted(false)
      acquire(MAX_SESSION_MS)
    }
  }

  private fun releaseLocks() {
    runCatching { if (wifiLock?.isHeld == true) wifiLock?.release() }
    runCatching { if (wakeLock?.isHeld == true) wakeLock?.release() }
    wifiLock = null
    wakeLock = null
  }

  override fun onDestroy() {
    releaseLocks()
    super.onDestroy()
  }

  private fun buildNotification(): Notification {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "RailReel hosting", NotificationManager.IMPORTANCE_LOW),
      )
    }
    @Suppress("DEPRECATION")
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      Notification.Builder(this)
    }
    return builder
      .setContentTitle("RailReel is hosting")
      .setContentText("Sharing your movie with the cabin")
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setOngoing(true)
      .build()
  }

  companion object {
    private const val CHANNEL_ID = "railreel_host"
    private const val NOTIF_ID = 4242
    private const val MAX_SESSION_MS = 6L * 60L * 60L * 1000L // 6h safety cap

    fun start(context: Context) {
      val intent = Intent(context, RailReelHostService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, RailReelHostService::class.java))
    }
  }
}
