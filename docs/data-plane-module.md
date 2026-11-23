# RailReel — Native Data-Plane Module (`railreel-host`)

> **Status: shipped.** This document began as the Phase 2 scoping note written after the
> networking spike (2026-06-27). The spike-era decisions below are kept as **history**, each
> marked with what actually shipped. For the current design read `docs/architecture.md`
> (§2 network stack, §7 media pipeline, §10 security).

## 1. What the spike told us (historical)

Two physical Android phones on a hotspot:

| Measured | Result | Implication |
| --- | --- | --- |
| Client → host over hotspot | connected, no AP isolation | the core idea works on real hardware |
| Clock sync (NTP via `lib/sync/clock`) | RTT ~44 ms | tight perceived sync is realistic |
| `react-native-tcp-socket` on New Arch | binds via interop | usable, but not for bulk data |
| **JS-bridge file transfer** | **~1.8 Mbps** (16 MB / 70 s) | too slow for video, so the host data plane had to be native |
| Host screen sleep during transfer | JS paused, transfer stalled | host needs a foreground service + keep-awake |
| Host screen OFF with hotspot | SoftAP stops serving clients | screen-off hosting is **not supported**; the host keeps its screen on |

## 2. What shipped

The module lives at `apps/mobile/modules/railreel-host` (local Expo module, Kotlin, Android only):

| Piece | File | Role |
| --- | --- | --- |
| Data plane | `RailReelHostModule.kt` (NanoHTTPD 2.3.1) | Serves the movie with `Range` (206/416, `HEAD`, `Accept-Ranges`), from a `content://` or file source. Requires the session token **and** an approved per-guest grant. Also probes media (container, codecs, fast-start layout) and fingerprints the file. |
| Control plane | `CtrlServer.kt` (NanoWSD) | WebSocket on its own port. Answers the NTP-style `syncPing` natively with a monotonic clock, binds every connection to an opaque `connId`, bounds and rate-limits frames, queues outbound writes per socket, and only broadcasts to connections JS marked approved. |
| Discovery | `NsdHelper.kt` | Android `NsdManager`: advertises `_railreel._tcp` with a TXT record (`v`, `t` token, `s`, `h`, `c`, `n`) and browses for it, with a single-flight resolve queue. |
| Keep-alive | `RailReelHostService.kt` | `dataSync` foreground service, WiFi + wake locks, ongoing notification, 6 h safety cap. |
| Guest proxy | `ProxyServer.kt` | Localhost-only server on each guest that serves the still-growing download to the player (see `architecture.md` §7). |

The TS wrapper is `modules/railreel-host/src/RailReelHostModule.ts`. The HTTP and WS servers use
separate ports; both are returned by the module and encoded in the QR/link/TXT record.

### Decisions, as resolved

- **v1 is NOT "full pre-cache only".** The spike-era plan shipped pre-cache first and deferred
  progressive playback. Progressive playback is implemented: guests download with HTTP Range
  and play a *fast-start* file through `ProxyServer` while it downloads; non-fast-start files
  fall back to a full pre-cache. The start gate (`lib/sync/startGate.ts`) picks the mode.
- **Guest download** uses `expo-file-system` (legacy resumable download), with resume via
  `Range: bytes=N-`, a silence watchdog and bounded retries. The guest *does* have a custom
  native component (the proxy), unlike the original "native-free client" plan.
- **Engine:** NanoHTTPD (not Ktor), plus NanoWSD for the WebSocket server. It was kept behind
  the module surface so it could be swapped, but there has been no need.
- **Ports:** HTTP and WS are separate (the "one port" idea was dropped; NanoWSD is a distinct server).
- **Integrity:** a content fingerprint (`media.hash`) computed natively in 1 MiB chunks, plus
  size, validated by the guest before a download counts as complete.
- **Security:** token + approved grant on the data plane; connection-bound identity and
  approved-only broadcasts on the control plane (`architecture.md` §10).
- **Cleartext** LAN traffic is enabled by the `plugins/withCleartextTraffic` config plugin.
- **Permissions** in `app.json`: `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`,
  `CHANGE_WIFI_MULTICAST_STATE`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`,
  `WAKE_LOCK`, `POST_NOTIFICATIONS`, `CAMERA` (QR scanning).

## 3. Original milestone plan (historical)

1. **M1a/M1b — Native HTTP range server**, single client then 4-5 simultaneous clients.
2. **M2 — Host stays alive** (foreground service, locks, notification; the screen-off finding above).
3. **M3 — Control + sync plane** (WS, clock sync, play/pause/seek).
4. **M4 — Security hardening** (high-entropy token, approved-client gating, integrity).
5. **M5 — Wire to UI** (live host/guest services, storage preflight, cache cleanup).
6. **M6 — Discovery + polish** (mDNS, QR/link, reconnection, error states).
7. **Later — progressive playback.**

All of these are done. The security and control-plane hardening landed after the first
implementation (bounded frames, non-blocking broadcast, per-IP admission limits, approval tickets).

## 4. Notes that still apply

- Each native change needs an **APK rebuild** (a dev-client rebuild locally, ~2-11 min), so keep
  the native surface small and iterate in the JS around it. CI compiles the Kotlin on any PR that
  touches native paths.
- **Both ABIs.** Releases are universal APKs containing `arm64-v8a` and `armeabi-v7a`, so older
  32-bit phones can join. Learned the hard way in the spike.
- **Storage:** guests write to cache storage, with a free-space preflight and a cleanup policy
  (delete, or "Keep & Leave" with fingerprint reuse).
- **Throughput:** demand is `N x bitrate`, so the start gate may require a full pre-cache.
- **Physical devices only.** Emulators can't do hotspots or mDNS multicast.
