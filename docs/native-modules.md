# RailReel — Native Module Strategy (Phase 1 spike)

The networking layer is the riskiest part of RailReel. This doc records the library
research and the decision on what we adopt vs. what thin native modules we write. It
de-risks Phase 1 before we commit to a native build. See `docs/architecture.md` §2.

> Hard reality up front: **mDNS multicast and a real hotspot don't work on emulators.**
> The discovery + data-plane paths must be validated on **physical devices** (a host phone
> with hotspot + 1–2 client phones). Plan device testing accordingly.

## 1. Discovery (mDNS / Android NSD)

| Option | Notes |
| --- | --- |
| **Android NsdManager** (`railreel-host`) | Embedded directly in the native host module via `NsdHelper.kt`. Zero additional external dependencies, handles single-flight resolution queue, and hooks directly into the host lifecycle. |
| **react-native-zeroconf** | Alternative mature library; wraps `NsdManager` on Android. Bundles mDNSResponder. |

**Decision:** use native **Android NSD (`NsdManager`)** inside `railreel-host` (or **react-native-zeroconf** as fallback). Either way mDNS is **best-effort** — the **QR/link join payload** (already built in
`src/lib/protocol/joinPayload.ts`) is the guaranteed path.

**Platform gotchas already handled in `app.json`:** Android `CHANGE_WIFI_MULTICAST_STATE`
(needed to receive multicast — acquire a `MulticastLock` at runtime).

## 2. Data plane — HTTP server with `Range` (host serves the movie)

**Finding:** there is **no off-the-shelf RN library** that serves files with byte-range support.
Raw TCP is available via **react-native-tcp-socket** (`Rapsssito`, mature), but building an
HTTP/1.1 range server in JS and pumping multi-GB to 4–5 clients over the bridge will hit
backpressure/memory limits (codex P1). 

**Decision:** write a **thin native Expo module** for the data plane.
- **Android (Kotlin):** embed **Ktor** (or NanoHTTPD) — both support `Range`. Stream from a
  `FileInputStream`/`FileChannel` with bounded buffers; honor cancellation; expose per-client
  metrics. Ktor can host the WebSocket too (see §3).
- Enforce the **session token** + approved-client check at the server edge before serving bytes.

**Spike shortcut (throwaway):** to validate the end-to-end flow fast, a first prototype *may*
use react-native-tcp-socket in JS — but it is **not** the production data plane; don't let it
calcify.

> **✅ Spike result (2026-06-27, two physical Android phones on a hotspot).** Confirmed
> empirically — see `docs/data-plane-module.md` for the full write-up:
> - Client reached host over the hotspot (no AP isolation). Connectivity works.
> - Clock sync handshake worked through `lib/sync/clock`; **RTT ~44ms** → sub-100ms sync is realistic.
> - `react-native-tcp-socket` runs on the New Architecture via interop (servers bind fine).
> - **JS-bridge data plane caps at ~1.8 Mbps** (16 MB took 70s) — far too slow for video. The
>   bottleneck is the JS bridge, not the WiFi. **→ the production data plane MUST be native.**
> - Host backgrounding (screen sleep) **pauses the JS server** mid-transfer. **→ the host needs a
>   foreground service + keep-awake** (confirms `docs/architecture.md` §9).

## 3. Control plane — WebSocket

- **Client side:** React Native ships a **WebSocket client** built in — no module needed.
- **Host side needs a WebSocket _server_.** Host it inside the **same native module** as the
  data plane (Ktor/NanoHTTPD serves HTTP + WS on Android). One native server process = one port story,
  shared token auth, simpler lifecycle.

## 4. Sync timing

- Expose a **monotonic clock** (`elapsedRealtimeNanos`) and the ability
  to **arm a callback at a future host-time** from native, so scheduled start/resume fires
  precisely (JS timers are too jittery). Small native module; pure decision math already lives
  in `src/lib/sync/clock.ts`.

## 5. Video player (open — decide at Phase 2)

Needs: local playback, **playbackRate** control (for drift nudges), precise **seek** + a
"ready/seek-complete" signal, and a **caching data source** so we never play a partially-written
file. Candidates: `expo-video` (modern Expo player — verify rate + cache hooks), or
`react-native-video` (ExoPlayer with more control, `CacheDataSource` on Android). **Action:**
spike both for rate-change + cached-source support before committing. Tracked, not decided here.

## 6. Spike plan & exit criteria

1. Android NSD (or react-native-zeroconf): host advertises `_railreel._tcp`, a client
   discovers it on **two physical phones** over the host's hotspot.
2. Stand up the native HTTP range server; client pulls a byte range of a large file and
   measures throughput **with multiple clients downloading at once** (validates the aggregate
   model in architecture §4).
3. Open a WS between host and client through the native server; round-trip a `syncPing/syncPong`
   and feed it through `lib/sync/clock.ts`.
4. Confirm Android `MulticastLock`.

**Exit criteria:** on real devices over a hotspot — discovery works (or QR fallback does), a
client downloads at usable aggregate throughput, and a token-authenticated WS carries a clock
sample end-to-end.

## 7. Risks to watch

- **AP/client isolation:** some hotspots block client↔client *and* client↔host traffic. Detect
  early; surface a clear error.
- **Background/lock limits** — host must stay foreground (architecture §9).
- **Emulators can't do this** — physical-device testing is mandatory.

---

### Sources
- [react-native-zeroconf (npm)](https://www.npmjs.com/package/react-native-zeroconf) ·
  [GitHub](https://github.com/balthazar/react-native-zeroconf)
- [@inthepocket/react-native-service-discovery](https://www.npmjs.com/package/@inthepocket/react-native-service-discovery)
- [react-native-tcp-socket](https://github.com/Rapsssito/react-native-tcp-socket)
- [React Native networking docs](https://reactnative.dev/docs/network)
