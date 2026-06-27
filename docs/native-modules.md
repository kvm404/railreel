# RailReel — Native Module Strategy (Phase 1 spike)

The networking layer is the riskiest part of RailReel. This doc records the library
research and the decision on what we adopt vs. what thin native modules we write. It
de-risks Phase 1 before we commit to a native build. See `docs/architecture.md` §2.

> Hard reality up front: **mDNS multicast and a real hotspot don't work on emulators.**
> The discovery + data-plane paths must be validated on **physical devices** (a host phone
> with hotspot + 1–2 client phones). Plan device testing accordingly.

## 1. Discovery (mDNS / Bonjour)

| Option | Notes |
| --- | --- |
| **react-native-zeroconf** | Mature, widely used; wraps `NsdManager` (Android) / `NSNetServiceBrowser` (iOS). Recent versions are Android 15 / 16KB-page compatible with a bundled mDNSResponder. The safe default. |
| **expo-bonjour** | Newer, Expo-first (config-plugin friendly). Attractive for our Expo dev-client setup if it's solid. |
| @inthepocket/react-native-service-discovery | Similar NSD/Bonjour wrapper; less active. |

**Decision:** start with **react-native-zeroconf** (proven, Android-15 ready). Evaluate
`expo-bonjour` as a cleaner Expo integration during the spike; switch only if it's clearly
better. Either way mDNS is **best-effort** — the **QR/link join payload** (already built in
`src/lib/protocol/joinPayload.ts`) is the guaranteed path.

**Platform gotchas already handled in `app.json`:** iOS `NSBonjourServices = ["_railreel._tcp"]`
+ `NSLocalNetworkUsageDescription`; Android `CHANGE_WIFI_MULTICAST_STATE` (needed to receive
multicast — acquire a `MulticastLock` at runtime).

## 2. Data plane — HTTP server with `Range` (host serves the movie)

**Finding:** there is **no off-the-shelf RN library** that serves files with byte-range support.
Raw TCP is available via **react-native-tcp-socket** (`Rapsssito`, mature), but building an
HTTP/1.1 range server in JS and pumping multi-GB to 4–5 clients over the bridge will hit
backpressure/memory limits (codex P1). 

**Decision:** write a **thin native Expo module** for the data plane.
- **Android (Kotlin):** embed **Ktor** (or NanoHTTPD) — both support `Range`. Stream from a
  `FileInputStream`/`FileChannel` with bounded buffers; honor cancellation; expose per-client
  metrics. Ktor can host the WebSocket too (see §3).
- **iOS (Swift):** **GCDWebServer** (battle-tested, range support) or `Network.framework`
  `NWListener`. Stream via `FileHandle` with bounded reads.
- Enforce the **session token** + approved-client check at the server edge before serving bytes.

**Spike shortcut (throwaway):** to validate the end-to-end flow fast, a first prototype *may*
use react-native-tcp-socket in JS — but it is **not** the production data plane; don't let it
calcify.

## 3. Control plane — WebSocket

- **Client side:** React Native ships a **WebSocket client** built in — no module needed.
- **Host side needs a WebSocket _server_.** Host it inside the **same native module** as the
  data plane (Ktor serves HTTP + WS on Android; on iOS use `Network.framework` or a Swift WS
  lib). One native server process = one port story, shared token auth, simpler lifecycle.

## 4. Sync timing

- Expose a **monotonic clock** (`CACurrentMediaTime` / `elapsedRealtimeNanos`) and the ability
  to **arm a callback at a future host-time** from native, so scheduled start/resume fires
  precisely (JS timers are too jittery). Small native module; pure decision math already lives
  in `src/lib/sync/clock.ts`.

## 5. Video player (open — decide at Phase 2)

Needs: local playback, **playbackRate** control (for drift nudges), precise **seek** + a
"ready/seek-complete" signal, and a **caching data source** so we never play a partially-written
file. Candidates: `expo-video` (modern Expo player — verify rate + cache hooks), or
`react-native-video` (ExoPlayer/AVPlayer with more control, `CacheDataSource` on Android,
resource-loader on iOS). **Action:** spike both for rate-change + cached-source support before
committing. Tracked, not decided here.

## 6. Spike plan & exit criteria

1. Add react-native-zeroconf (or expo-bonjour); host advertises `_railreel._tcp`, a client
   discovers it on **two physical phones** over the host's hotspot.
2. Stand up the native HTTP range server; client pulls a byte range of a large file and
   measures throughput **with multiple clients downloading at once** (validates the aggregate
   model in architecture §4).
3. Open a WS between host and client through the native server; round-trip a `syncPing/syncPong`
   and feed it through `lib/sync/clock.ts`.
4. Confirm iOS Local Network permission flow and Android `MulticastLock`.

**Exit criteria:** on real devices over a hotspot — discovery works (or QR fallback does), a
client downloads at usable aggregate throughput, and a token-authenticated WS carries a clock
sample end-to-end.

## 7. Risks to watch

- **AP/client isolation:** some hotspots block client↔client *and* client↔host traffic. Detect
  early; surface a clear error.
- **iOS Local Network permission denial** blocks mDNS *and* local sockets until granted.
- **Background/lock limits** (esp. iOS) — host must stay foreground (architecture §9).
- **Emulators can't do this** — physical-device testing is mandatory.

---

### Sources
- [react-native-zeroconf (npm)](https://www.npmjs.com/package/react-native-zeroconf) ·
  [GitHub](https://github.com/balthazar/react-native-zeroconf)
- [@inthepocket/react-native-service-discovery](https://www.npmjs.com/package/@inthepocket/react-native-service-discovery)
- [expo-bonjour](https://github.com/likeSo/expo-bonjour)
- [react-native-tcp-socket](https://github.com/Rapsssito/react-native-tcp-socket)
- [React Native networking docs](https://reactnative.dev/docs/network)
