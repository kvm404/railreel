// Expo SDK 56 ignores `expo.android.usesCleartextTraffic` in app.json, so a fresh
// `expo prebuild` emits a main manifest without it (only the debug overlay sets it).
// Release builds then block ws:// and http:// to the host and the 127.0.0.1 playback
// proxy. RailReel is LAN-only (no TLS on a hotspot), so opt the main <application> in.
const { withAndroidManifest } = require('expo/config-plugins')

module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0]
    if (!app) throw new Error('withCleartextTraffic: AndroidManifest has no <application>')
    app.$['android:usesCleartextTraffic'] = 'true'
    return cfg
  })
}
