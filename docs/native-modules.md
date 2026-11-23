# RailReel — Native Module Strategy

> **Status: decisions made and shipped.** This began as the Phase 1 spike note (library research
> before committing to a native build). The research is kept as **history**; the "Shipped" lines
> say what RailReel actually uses. See `docs/architecture.md` §2 and `docs/data-plane-module.md`.

> Hard reality: **mDNS multicast and a real hotspot don't work on emulators.** Discovery and
> the data plane must be validated on **physical devices** (a host with hotspot + 1-2 guests).

## 1. Discovery (mDNS / Android NSD)

Options considered: Android `NsdManager` directly, or `react-native-zeroconf` (wraps `NsdManager`).

**Shipped:** `NsdHelper.kt` inside the local `railreel-host` module (Android NSD, no extra
dependency, single-flight resolve queue). mDNS is **best-effort**; the QR code / `railreel://`
invite link (`lib/protocol/joinPayload.ts`, `lib/links/invite.ts`) is the guaranteed path. The
manifest declares `CHANGE_WIFI_MULTICAST_STATE`.

## 2. Data plane: HTTP server with `Range`

**Finding (history):** no off-the-shelf RN library serves files with byte ranges, and pumping
multi-GB to several guests through a JS-bridge server hits backpressure limits. The spike measured
~1.8 Mbps through the bridge.

**Shipped:** a thin native Expo module with an embedded **NanoHTTPD** server (not Ktor),
streaming from the picked file with bounded buffers and cancellation, enforcing the session token
and an approved per-guest grant at the server edge. A throwaway `react-native-tcp-socket`
prototype was only ever a spike shortcut and is not in the app.

> **Spike result (2026-06-27, two phones on a hotspot).** Client reached the host (no AP
> isolation); clock sync RTT ~44 ms; `react-native-tcp-socket` runs on the New Architecture via
> interop; the JS-bridge data plane caps at ~1.8 Mbps; host screen sleep pauses the JS server. These
> drove the native data plane and the host foreground service.

## 3. Control plane: WebSocket

Guests use React Native's built-in WebSocket client.

**Shipped:** the host side is **`CtrlServer.kt`** (NanoWSD) in the same native module, token-gated,
with connection-bound identity, bounded frames and per-socket outbound queues
(`architecture.md` §10). It runs on its own port, separate from the HTTP data plane.

## 4. Sync timing

**Shipped:** the NTP-style `syncPing`/`syncPong` is answered natively in `CtrlServer` with
`SystemClock.elapsedRealtimeNanos`, so the host-side timestamps never cross the bridge. The pure
math is in `src/lib/sync/clock.ts` and drift correction in `src/lib/sync/playback.ts`. Guest-side
timestamps are still taken in JS. There is no separate "arm a native callback" timing module, and no scheduled resume: the host
plays and broadcasts `state` immediately and each guest drift-corrects toward it.

## 5. Video player

**Shipped:** **`expo-video`** (ExoPlayer on Android). It provides `playbackRate`, seek, and
ready/stall signals. For progressive playback the player is pointed at **`ProxyServer.kt`**, a
localhost proxy that serves the still-downloading file, rather than at a partial file or a custom
ExoPlayer `CacheDataSource`. `react-native-video` was considered and not needed.

## 6. Other native pieces

- **`RailReelHostService.kt`:** `dataSync` foreground service + WiFi/wake locks so the host keeps
  serving while the screen is on and the app is briefly backgrounded.
- **`plugins/withCleartextTraffic.js`:** Expo config plugin allowing cleartext HTTP/WS to the LAN.
- **`expo-camera`:** QR scanning. **`expo-keep-awake`:** keeps the screen on while hosting.

## 7. Spike plan (historical)

1. NSD host advertise / guest discover on two phones.
2. Native HTTP range server with several simultaneous downloads.
3. WS round-trip of `syncPing/syncPong` through `lib/sync/clock.ts`.
4. Android `MulticastLock`.

Exit criteria (met): discovery works or QR does, guests download at usable aggregate throughput,
and a token-authenticated WS carries a clock sample end to end.

## 8. Risks that still apply

- **AP/client isolation** on some hotspots blocks guest-to-host traffic; the app surfaces a clear error.
- **Background/lock limits:** the host must stay foreground with the screen on (`architecture.md` §9).
- **Emulators can't do this:** physical-device testing is mandatory.
- Any change to `apps/mobile/modules/` needs an APK rebuild and is compiled by CI.
