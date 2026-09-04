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

## 2. v1 = FULL PRE-CACHE (this is what keeps the client native-free)

**Important scoping decision (per codex review):** the "client needs no custom native code" claim
holds **only for full pre-cache** — download the whole movie, *then* play a complete local file.
For **progressive** playback (playing while still downloading) the client *would* need native
player-cache plumbing (such as ExoPlayer `CacheDataSource`), because you
must never point a player at a partially-written file (see `architecture.md` §7).

So **v1 ships full pre-cache** (the lobby's readiness rings already fit this: everyone downloads
to 100%, then Start). **Progressive playback is a later phase** that adds a client-side native
player cache. With pre-cache, the client stays native-free:

- **Download:** the client pulls the movie with **`expo-file-system`** — a *native*, resumable,
  progress-reporting HTTP download straight to disk. In **SDK 56 use the new `File`/`DownloadTask`
  API** (the legacy `createDownloadResumable` moved to `expo-file-system/legacy`). Full native
  speed, no bridge bottleneck.
- **Control/sync:** the client uses React Native's **built-in WebSocket client** for the tiny
  control channel (play/pause/seek, clock ping/pong, chat, reactions).
- **Caveat:** clients must stay in-app with **keep-awake on** during download (an Expo-only
  download has no client foreground service); if we later allow locking the screen mid-download,
  that needs a client-side service too.

So the only thing we must build natively for v1 is the **host server**. That's the big de-risk.

## 2a. Cleartext LAN config (required before M1 works on a real build)

`http://<hotspot-ip>` and `ws://<hotspot-ip>` are **blocked by default** on release/standalone
builds. Must add:
- **Android:** `usesCleartextTraffic` (or a network-security-config allowing cleartext to the
  dynamic LAN IP range) via `app.json` `expo.android`.
Test **both** the `expo-file-system` download and the RN WebSocket over `http`/`ws` (the spike
used raw sockets, which bypassed this).

```
HOST (custom native module)            CLIENT (no custom native)
  HTTP server + Range  ─────bytes────▶  expo-file-system download → disk
  WebSocket server     ◀───control───▶  RN WebSocket client
  foreground service (keep-alive)        RN UI + lib/* logic
```

## 3. The host module: `railreel-host` (Expo native module)

Local Expo module under `apps/mobile/modules/railreel-host` (Android only).

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
- **HTTP server (swappable engine):** start with **NanoHTTPD** (single dep, `Range`, simple),
  streaming from a seekable source with bounded buffers + cancellation. Keep the engine behind an
  interface so we can swap to **Ktor** if we want one HTTP+WS stack / better lifecycle. Acceptance
  bar before committing to NanoHTTPD: **4–5 simultaneous clients, a real movie-sized file,
  sustained aggregate Mbps, no heap growth.**
- **Range compliance is not just "supports Range":** must do correct `206`, `416`,
  `Content-Range`, `Accept-Ranges`, `Content-Length`, **`HEAD`**, cancellation, and a stable
  validator (`ETag`/`Last-Modified`) — Android download resume is picky about validators.
  **Add a range-compliance check before any throughput number counts.**
- **File source:** the picked movie is typically a **`content://` URI** (Storage Access
  Framework), not a filesystem path. Stream ranges from a **seekable `ParcelFileDescriptor`/SAF**
  source, OR import-copy into app storage *with a free-space preflight* (copy doubles storage).
  The native API takes a **URI + access mode**, not a bare path.
- **Foreground service:** a started **foreground** `Service` with
  `foregroundServiceType="dataSync"` + `FOREGROUND_SERVICE_DATA_SYNC`, a `WifiLock`
  (`WIFI_MODE_FULL_HIGH_PERF`) and partial `WakeLock`, an ongoing notification (handle
  notification-permission UX, user-stop, and battery/thermal). Start it **while the app is
  foregrounded**. Note: Android 14/15 do **not** guarantee unlimited background — the realistic
  promise is "survives screen-off during an active session," not true background hosting.
- **WebSocket:** NanoHTTPD has `NanoWSD`, or Ktor, or a tiny WS in the service. Prefer **one port
  for HTTP + WS** (simpler QR/auth/firewall). Decide in M3.
- Permissions: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`, `WAKE_LOCK`, `POST_NOTIFICATIONS`
  (+ the WiFi/multicast perms already in `app.json`).

### 3.3 JS API (the Expo module surface)
```ts
// fileUri = content:// (SAF) or file://; accessMode tells the server how to open it.
// port 0 = let the OS pick; the resolved port is returned and encoded into the QR/mDNS TXT.
RailReelHost.start({ fileUri, accessMode, token, approvedClientIds, port }): Promise<{ port }>
RailReelHost.stop(): Promise<void>
RailReelHost.setApprovedClients(ids: string[]): void
// events: 'clientConnected' | 'bytesServed' | 'wsMessage' | 'error'
```
- **Token auth from M1** (even as a stub): require the session token as a **query param or
  first-message** (don't rely on custom WS headers — RN/browsers can't always set them). Bytes
  served only to approved clients.
- **Port handling:** bind `0` or retry on conflict; return the actual port; never assume a fixed one.

## 4. Discovery
- mDNS via Android NSD (`NsdManager` / `railreel-host`) or `react-native-zeroconf` (both
  Android-first). **The QR / `railreel://join` link is the guaranteed path** and
  is already implemented (`lib/protocol/joinPayload`). mDNS is convenience, not a dependency.

## 5. Milestones (each ends in a verifiable on-device check)

0. **M0 — Cleartext + scaffold.** Add cleartext config (§2a); scaffold `railreel-host`; confirm an
   RN WebSocket + an `expo-file-system` download both work over `http`/`ws` to a trivial native
   endpoint. (Unblocks everything; tiny.)
1. **M1 — Native HTTP range server (the make-or-break).**
   - **M1a:** serve a real movie-sized file from a `content://` source; **single client** downloads
     via `expo-file-system`; pass the **range-compliance** check (206/416/Content-Range/HEAD/ETag,
     pause→resume, app-restart resume, final size matches); carry a **stub token**.
   - **M1b:** **4–5 simultaneous clients** download at once; record **sustained aggregate Mbps** +
     heap stability. *Only this number decides if NanoHTTPD stays.* (Target: ≫1.8 Mbps.)
2. **M2 — Host stays alive (DONE 2026-06-28).** Foreground service (`dataSync`) + WiFi/wake locks
   + ongoing notification, plus `expo-keep-awake` while hosting.
   **Empirical finding:** with the host's screen OFF the **hotspot/SoftAP stops serving clients**
   (client got timeout / connection-reset), even though the foreground service kept the process
   alive (`isForeground=true` throughout). The WiFi-lock only governs *client* WiFi; Android has no
   API to keep a SoftAP awake through sleep. Screen ON → 52 Mbps; screen OFF → unreachable. So
   **screen-off hosting is not supported** — the host must keep its screen on (keep-awake), which
   `architecture.md §9` already required. The foreground service still earns its place: it keeps
   the server process from being frozen if the host briefly switches apps (screen on), and shows
   the "hosting" notification.
3. **M3 — Control + sync plane.** WS (shared port) for clock sync + play/pause/seek; lock two
   phones together using `lib/sync`. If JS-timestamped WS can't hold sub-100ms, add a small
   **native monotonic-timing** helper (client + host).
4. **M4 — Security hardening.** Promote the stub token to high-entropy; approved-client gating on
   HTTP + WS; rate-limit pairing; integrity via **size/mtime/ETag** (compute a strong file hash
   async/at-completion, not a blocking multi-GB hash before the lobby).
5. **M5 — Wire to UI.** Replace mock data in Create/Join/Lobby with live host/client services;
   real readiness (full pre-cache to 100% → Start). Free-space preflight; store session files in
   **cache / no-backup** storage with a cleanup policy.
6. **M6 — Discovery + polish.** mDNS auto-discovery (QR/link stays the guaranteed path);
   reconnection; error/empty states.
7. **Later — Progressive playback** (client-side native player cache), once
   Android pre-cache is proven end-to-end.

## 6. Notes / risks
- Each native change = a dev-client rebuild (~2–11 min) → keep native surface small, iterate the
  JS around it.
- Throughput target: comfortably exceed `N × bitrate` for the group; if a host/hotspot can't,
  fall back to **full pre-cache before play** (already in the architecture).
- Build for **both ABIs** (`armeabi-v7a,arm64-v8a`) so older 32-bit phones can join (learned the
  hard way in the spike).
- **Storage:** clients write session files to **cache / no-backup** storage (not backed-up
  Documents); free-space preflight before download; cleanup policy after the session.
- **Hashing:** don't block the lobby on hashing a multi-GB file — serve by size/mtime/`ETag`,
  compute any strong hash asynchronously / at completion if the product truly needs it.
- **One port** for HTTP + WS where possible (simpler QR, auth, firewall/cleartext testing).
- The throwaway spike lives on branch `spike/networking` for reference; not merged to `main`.
