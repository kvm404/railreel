# RailReel — Native Data-Plane Module (Phase 2 networking scope)

Scopes the real offline networking layer, informed by the **spike** (two Android phones on a
hotspot, 2026-06-27). See `docs/architecture.md` and `docs/native-modules.md`.

## 1. What the spike told us

| Measured | Result | Implication |
| --- | --- | --- |
| Client → host over hotspot | ✅ connected, no AP isolation | the core idea works on real hardware |
| Clock sync (NTP via `lib/sync/clock`) | ✅ RTT ~44ms | sub-100ms playback sync is realistic |
| `react-native-tcp-socket` on New Arch | ✅ binds via interop | usable for the small control channel |
| **JS-bridge file transfer** | ❌ **~1.8 Mbps** (16 MB / 70s) | **too slow for video → host data plane must be native** |
| Host screen sleep during transfer | ❌ JS paused, transfer stalled | **host needs a foreground service + keep-awake** |

## 2. The key simplification: only the HOST needs custom native code

The client side does **not** need a custom native module:

- **Download:** the client pulls the movie with **`expo-file-system`** (`createDownloadResumable`)
  — a *native*, resumable, progress-reporting HTTP download straight to disk, with `Range`
  support. Full native speed, no bridge bottleneck, already New-Arch compatible.
- **Control/sync:** the client uses React Native's **built-in WebSocket client** for the tiny
  control channel (play/pause/seek, clock ping/pong, chat, reactions).

So the only thing we must build natively is the **host server**. That's a big de-risk.

```
HOST (custom native module)            CLIENT (no custom native)
  HTTP server + Range  ─────bytes────▶  expo-file-system download → disk
  WebSocket server     ◀───control───▶  RN WebSocket client
  foreground service (keep-alive)        RN UI + lib/* logic
```

## 3. The host module: `railreel-host` (Expo native module)

Local Expo module under `apps/mobile/modules/railreel-host`. **Android first** (both your test
phones are Android; iOS port follows once proven).

### 3.1 Responsibilities
1. **HTTP/1.1 server with `Range`** serving the selected movie file (and a small metadata
   endpoint: size, hash, codec).
2. **WebSocket server** for the control plane (or reuse the proven `tcp-socket` line protocol if
   WS server proves fiddly — decide in M3).
3. **Foreground service + keep-awake** so the OS never pauses it mid-session (with an ongoing
   "RailReel is hosting" notification).
4. **Token auth + approved-client gating** at the server edge (serve bytes only to approved
   clients carrying the session token).

### 3.2 Android (Kotlin) approach
- **HTTP server:** **NanoHTTPD** (single dependency, supports `Range`, dead simple) for v1.
  Serve from `RandomAccessFile`/`FileChannel` with bounded buffers; honor cancellation. (Upgrade
  to Ktor/`sendfile` only if NanoHTTPD throughput is insufficient — the spike says even modest
  native throughput will dwarf 1.8 Mbps.)
- **Foreground service:** a started+foreground `Service` holding the server + a `WifiLock`
  (`WIFI_MODE_FULL_HIGH_PERF`) and a partial `WakeLock`; ongoing notification.
- **WebSocket:** NanoHTTPD has `NanoWSD`, or run a tiny WS within the service. Decide in M3.
- Permissions: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC` (Android 14+), `WAKE_LOCK`
  (+ the WiFi/multicast perms already in `app.json`).

### 3.3 iOS (Swift) approach — after Android
- **HTTP server:** GCDWebServer (mature, `Range`) or `Network.framework` `NWListener`.
- **Keep-alive:** iOS won't allow reliable background hosting — v1 keeps the host **foreground**
  (screen on, app open), per `architecture.md` §9. `UIBackgroundModes: audio` is already set.

### 3.4 JS API (the Expo module surface)
```ts
RailReelHost.start({ filePath, token, approvedClientIds, httpPort, wsPort }): Promise<{ httpPort; wsPort }>
RailReelHost.stop(): Promise<void>
RailReelHost.setApprovedClients(ids: string[]): void
// events: 'clientConnected' | 'bytesServed' | 'wsMessage' | 'error'
```

## 4. Discovery
- mDNS via `react-native-zeroconf` or `expo-bonjour` (both likely "untested on New Arch" —
  validate, fall back to interop). **The QR / `railreel://join` link is the guaranteed path** and
  is already implemented (`lib/protocol/joinPayload`). mDNS is convenience, not a dependency.

## 5. Milestones (each ends in a verifiable on-device check)

1. **M1 — Native HTTP range server.** Scaffold `railreel-host`; serve a real file; client
   downloads with `expo-file-system`; **measure throughput** (target: ≫1.8 Mbps; expect tens of
   Mbps). *This is the make-or-break number — do it first.*
2. **M2 — Survive backgrounding.** Add the foreground service + WiFi/wake locks; verify a
   transfer completes with the host screen off.
3. **M3 — Control plane.** WS (or tcp-socket) for clock sync + play/pause/seek; lock two phones'
   playback together using the existing `lib/sync` math.
4. **M4 — Security.** Session token + approved-client gating on HTTP and control.
5. **M5 — Wire to UI.** Replace the mock data in Create/Join/Lobby with the live host/client
   services; real readiness in the lobby.
6. **M6 — Discovery + polish.** mDNS auto-discovery; reconnection; error states.
7. **iOS port** once Android is proven end-to-end.

## 6. Notes / risks
- Each native change = a dev-client rebuild (~2–11 min) → keep native surface small, iterate the
  JS around it.
- Throughput target: comfortably exceed `N × bitrate` for the group; if a host/hotspot can't,
  fall back to **full pre-cache before play** (already in the architecture).
- Build for **both ABIs** (`armeabi-v7a,arm64-v8a`) so older 32-bit phones can join (learned the
  hard way in the spike).
- The throwaway spike lives on branch `spike/networking` for reference; not merged to `main`.
