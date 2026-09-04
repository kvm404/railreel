# RailReel — Technical Architecture

This document captures the *how*. For the *what/why* see [`docs/prd/railreel-v1.md`](prd/railreel-v1.md).

## 1. Roles

- **Host** — owns the movie file, enables the hotspot, runs the local servers, holds the
  master playback clock and controls. One host per session.
- **Client** — joins over the host's hotspot, downloads + plays a local copy, follows the
  host's clock, can send requests/chat/reactions. Up to ~5 clients.

There is no server beyond the host's phone. Everything is on the LAN.

## 2. Network stack

```
┌─────────────────────────── Host phone ───────────────────────────┐
│  WiFi hotspot (enabled manually by the user)                       │
│  mDNS/Bonjour advertiser   → service "_railreel._tcp"              │
│  HTTP server (range)       → serves the movie file                 │
│  WebSocket server          → control, sync clock, chat, reactions  │
└───────────────────────────────────────────────────────────────────┘
        ▲ join hotspot              ▲ discover + connect
┌───────┴───────┐           ┌───────┴───────┐
│  Client phone │   ...      │  Client phone │   (×3–5)
│  mDNS browser │           │  HTTP download│
│  WS client    │           │  local player │
└───────────────┘           └───────────────┘
```

- **Transport:** the host's WiFi hotspot puts everyone on one LAN. The OS will not let an app
  toggle the hotspot, so onboarding *guides* the host to enable it manually.
- **Discovery:** mDNS via Android `NSD` for the tap-to-join *convenience* path. It is
  **best-effort**: Android NSD is async/lifecycle-sensitive.
  **Robust fallback = QR code / link** encoding `host-ip`, ports, session id, and the **secret
  join token**. (A bare 4-digit code can't resolve the host's IP offline — it's only a human
  confirmation, never transport or auth.)
- **Control plane:** a WebSocket server on the host. Small JSON messages (see §6). **The
  session token is required to connect.**
- **Data plane:** a **native** HTTP server (Kotlin) serving the movie with `Range`
  support, bounded buffers, per-client throttling, cancellation, and `sendfile`-style reads —
  *not* a JS-bridge server (multi-GB range reads to 4–5 clients would drown the bridge). Byte
  serving requires the token and an approved client; supports resume after drops.

> Native modules required (hence Expo **custom dev client**, not Expo Go): mDNS advertise/
> browse, the embedded HTTP + WebSocket servers (data plane in native code), and likely native
> timing for sync actuation. Investigate community modules first (e.g. react-native-zeroconf,
> react-native-tcp-socket); but the data plane and sync timing should be thin native modules we
> control.

## 3. Session lifecycle

```
Host: pick movie → validate/probe codec → create event → enable hotspot → advertise mDNS
Client: join hotspot → discover event → request to join
Host: approve client
Client: enter lobby → download begins (HTTP range) → buffer fills
Host: lobby shows per-client readiness (% / "ready") → start when gate passes (§4)
All: synchronized playback (§5) with chat/reactions
Any client: drop → reconnect → resync to host clock + resume download
Host: end session → cleanup
```

## 4. Buffering & start/stall control

The danger is a client whose download can't keep up. **Crucial correction:** the host serves a
*separate copy per client*, so demand is **aggregate = N × bitrate**, not one stream. A phone
hotspot at ~30–50 Mbps serving five 8–10 Mbps copies is at its ceiling — the buffer does *not*
automatically run ahead for high bitrate × big groups. The gate is throughput-aware and may
choose full pre-cache.

**Adaptive start gate** (when can the host press play?)
- Every client reports: `bufferedAheadSec` and a measured `downloadMbps` (under *simultaneous*
  download, i.e. real aggregate conditions).
- Progressive start is allowed only if, for *all* clients, the download finishes before the
  playhead reaches the download edge:
  `remainingBytes / clientMbps < remainingPlayTimeSec − MARGIN` **and**
  `bufferedAheadSec ≥ START_LEAD` (≈60s).
- Otherwise → **full pre-cache before play** (download everything first, show ETA), and/or cap
  supported bitrate by group size. The lobby explains the wait. No silent over-promise.

**Group buffer floor with hysteresis** (during playback)
- Clients send `bufferedAheadSec` heartbeats ~3–5×/sec over the WS.
- If any client `< CRITICAL_LEAD` (≈15s): host broadcasts `pause(reason: waiting, who)`.
- Resume only when the laggard recovers `≥ RESUME_LEAD` (≈30s, strictly > critical) **and**
  ACKs ready — the gap prevents pause/resume flapping. Enforce a `MIN_PAUSE` duration too.
- A persistently slow client → host decision: **keep waiting** or **continue without them**
  (strike/evict). The evicted client rejoins in **catch-up mode** (downloads/seeks to target +
  lead, then re-locks). One bad device can't hold the group hostage.

Constants (`START_LEAD`, `MARGIN`, `CRITICAL_LEAD`, `RESUME_LEAD`, `MIN_PAUSE`, strike counts)
live in one config module so they're tunable from real-device testing.

## 5. Sync protocol (clock alignment)

**Clock offset (NTP-style).** Each client periodically does:
```
client →  {t1}                    (client send time)
host   →  {t1, t2, t3}            (host recv, host send)
client    t4 = now
offset = ((t2 - t1) + (t3 - t4)) / 2      // = hostTime − clientTime
rtt    =  (t4 - t1) - (t3 - t2)
```
Keep the offset from the lowest-RTT samples. **All of `t1..t4` must come from a MONOTONIC clock
(`elapsedRealtimeNanos` on Android) — never
`Date.now()`**, which jumps with NTP/user changes. Timestamp at the native socket edge, not in
JS, to avoid bridge jitter. (The pure math in `lib/sync/clock.ts` is clock-source agnostic; the
*caller* must feed it monotonic values.)

**Playback state.** The host is the source of truth:
```
PlaybackState { positionSec, rate, isPlaying, hostTimestamp }
```
A client computes target as
`target = positionSec + (isPlaying ? (hostNow - hostTimestamp) : 0)` (converted via offset),
and corrects:
- drift `< ~50ms` → hold.
- `~50ms ≤ drift < ~250ms` → small bounded `playbackRate` nudge (PLL-style, imperceptible).
- drift `≥ ~250ms` (sustained) or discontinuity → hard `seek` to target.

**Actuation is the hard part (not the math).** `play()`/`seek()`/decoder-ready latencies on
ExoPlayer can exceed 100ms, so:
- **Schedule** start/resume for a *future host time* and have each client arm locally → all fire
  together rather than "resume now" racing the network.
- Require **"seek-complete / ready" ACKs** from clients before the group resumes after a seek.
- Keep rate nudges small and bounded to avoid oscillation; hard-seek only on sustained error.
- This timing likely lives in a **native module**, not JS.

**Target:** tight *perceived* sync (~sub-100ms). Each viewer is on their own headphones, so
cross-phone lip-sync perfection isn't required — moment-to-moment togetherness (for reactions/
chat) is.

## 6. Control & messaging (WebSocket)

All control/chat/sync share the WS. Indicative message shapes (TS types live in `lib/protocol`):

```ts
// host → clients
type ServerMsg =
  | { t: 'state'; state: PlaybackState }
  | { t: 'pause'; reason: 'host' | 'waiting'; who?: string }
  | { t: 'resume' }
  | { t: 'roster'; clients: ClientInfo[] }
  | { t: 'requestDecision'; id: string; approved: boolean }
  | { t: 'chat'; from: string; text: string; at: number }
  | { t: 'reaction'; from: string; emoji: string; at: number }
  | { t: 'syncPong'; t1: number; t2: number; t3: number }

// client → host
type ClientMsg =
  | { t: 'join'; name: string }
  | { t: 'heartbeat'; bufferedAheadSec: number; downloadMbps: number; positionSec: number }
  | { t: 'request'; id: string; action: 'pause' | 'resume' | 'seek'; arg?: number }
  | { t: 'chat'; text: string }
  | { t: 'reaction'; emoji: string }
  | { t: 'syncPing'; t1: number }
```

- **Host-only control:** clients never mutate playback directly; they send `request`, the host
  decides and broadcasts the resulting `state`.
- **Reactions/chat:** host relays to all (host is the hub; no client-to-client mesh in v1).

## 7. Media pipeline (v1)

- On import, **probe** the file. v1 accepts **only already-compatible H.264 + AAC MP4** with a
  valid `moov`/fragment layout. **Container remux and transcoding are deferred** — "non-MP4 but
  compatible codecs → remux" sounds simple but breaks on real files: MKV with AC3/DTS, multiple
  audio tracks / subtitles, H.264 Annex B → AVCC, unsupported profiles/levels, VFR, edit lists,
  huge files, and 2× temporary storage. Reject non-conforming files with a clear message.
- **Progressive playback must not point the player at a partially-written file.** A growing
  file with a changing length/index is unreliable across players. Instead feed playback through
  a **caching source**: ExoPlayer `CacheDataSource` on Android (or a localhost proxy) — the
  player requests ranges, the cache layer satisfies them from disk or fetches-and-stores. The
  fully-downloaded file is persisted separately.
- For **full pre-cache** mode the file is complete before play, so a plain local file URL is fine.

## 8. App architecture (client app, both roles)

Mirrors the layering proven in the reference project, our own way:

```
apps/mobile/src/
  theme/        design tokens, palette, typography, motion, ThemeProvider
  ui/           styled primitives (Text, Button, Surface, PressableScale, …)
  components/   composite UI (lobby cards, player chrome, chat, reactions)
  screens/      Home, CreateSession, JoinSession, Lobby, Player, …
  hooks/        React hooks bridging UI ↔ services
  lib/          PURE logic — protocol types, clock math, buffer/gate decisions,
                media probe rules, sync controller (unit-tested with vitest)
  net/          host server (http+ws+mDNS) and client (discovery+download+ws)
  data/         any local persistence (recent sessions, settings)
  types/        shared TS types
apps/mobile/modules/   native modules (mDNS, embedded servers) as needed
```

**Testing seam:** keep clock math, buffer/start-gate decisions, drift correction, and media
probe rules as **pure functions** in `lib/`, tested against fixtures — same philosophy as the
reference project's SMS-parser corpus.

## 9. Host as single point of failure (explicit v1 stance)

The host phone *is* the infrastructure. v1 does **not** try to survive the host
backgrounding / locking / getting a call / OS-killing the app / hotspot toggling off /
battery or thermal shutdown. Instead:

- **Preflight:** check battery %, thermal state, and free storage before allowing hosting;
  warn/refuse if marginal.
- **Keep-awake** on while hosting; encourage the host to stay plugged in.
- **Honest UX:** "Your session ends if you leave the app or turn off the hotspot." No
  background-hosting reliability promise.
- Clients handle host disappearance gracefully (clear "host left — session ended" state).

## 10. Security model (v1)

- On session create, generate a **high-entropy session secret** (token).
- The token is distributed *only* via the QR/link or to approved clients — never broadcast.
- **Both** the WS control plane and the HTTP data plane require the token; the data plane
  additionally serves bytes only to clients the host has **approved**. Rate-limit pairing.
- Movie metadata includes **file hash + size** so clients verify integrity of what they got.
- Rotate the secret per session. Result: being on the hotspot is not enough to pull the movie.

## 11. Open technical questions (to validate on-device)

- Best Android libs for mDNS; confirm we own the native data-plane (HTTP range) + sync
  timing modules rather than relying on JS-bridge servers.
- Real **aggregate** hotspot throughput with 4–6 clients downloading simultaneously on
  representative phones; tune §4 constants and the progressive-vs-pre-cache threshold.
- Android background-audio/networking limits while screen is on.
- Caching-player-source approach (ExoPlayer `CacheDataSource` / local proxy) and how seek interacts
  with a partially-cached asset.
- AP/client isolation on some hotspots (can clients reach the host's server at all?).
- Real-device **soak testing** (full 2h movie on Android, lock/call/background, reconnect).

## Appendix: design review (codex, 2026-06-27)

This architecture was reviewed by codex (principal-engineer role). Key findings folded in:
aggregate-throughput correction (§4), monotonic clocks + scheduled-resume/ready-ACK actuation
(§5), caching player source instead of partial-file playback (§7), native data plane + token
auth (§2, §10), tightened media scope (§7), buffer-floor hysteresis + evict (§4), host-as-SPOF
constraints (§9). Verdict: the core "distribute bytes once, sync state not pixels" direction is
sound; the risks are mobile-platform edges and optimistic constants — addressed above.
