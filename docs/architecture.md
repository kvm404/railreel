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
- **Discovery:** mDNS/Bonjour — `NSD` on Android, `Bonjour`/`NWBrowser` on iOS — so clients
  see the host as a tappable name. Fallback: host shows a 4-digit code; client enters it to
  resolve `host-ip:port` directly.
- **Control plane:** a WebSocket server on the host. Small JSON messages (see §5).
- **Data plane:** an HTTP server on the host serving the movie with `Range` support so clients
  can stream-to-disk progressively and resume after drops.

> Native modules required (hence Expo **custom dev client**, not Expo Go): mDNS advertise/
> browse, and the embedded HTTP + WebSocket servers. Investigate community modules first
> (e.g. react-native-zeroconf, react-native-tcp-socket / a RN http server lib); wrap or write
> our own thin native module where needed.

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

The danger is a client whose download can't keep up. Throughput on a LAN usually far exceeds
movie bitrate, so the buffer normally runs ahead — the controls below cover the edges.

**Adaptive start gate** (when can the host press play?)
- Every client reports: `bufferedAheadSec` and a measured `downloadMbps`.
- Gate passes when, for *all* clients: `bufferedAheadSec ≥ START_LEAD` (≈60s) **and**
  `downloadMbps ≥ SAFETY × videoBitrateMbps` (SAFETY ≈ 1.2).
- If a client is marginal, the gate holds and the lobby explains why ("building a safe buffer
  for {name}…"). No fixed multi-minute wait when conditions are good.

**Group buffer floor** (during playback)
- Clients send `bufferedAheadSec` heartbeats ~3–5×/sec over the WS.
- If any client `< CRITICAL_LEAD` (≈15s): host broadcasts `pause(reason: waiting, who)`.
  Overlay: "Waiting for {name}…".
- When the lagging client recovers `≥ RESUME_LEAD` (≈30s): host broadcasts `resume`.
- The whole group stays time-locked; nobody silently drifts or stalls alone.

Constants (`START_LEAD`, `SAFETY`, `CRITICAL_LEAD`, `RESUME_LEAD`) live in one config module
so they're tunable from real-device testing.

## 5. Sync protocol (clock alignment)

**Clock offset (NTP-style).** Each client periodically does:
```
client →  {t1}                    (client send time)
host   →  {t1, t2, t3}            (host recv, host send)
client    t4 = now
offset = ((t2 - t1) + (t3 - t4)) / 2
rtt    =  (t4 - t1) - (t3 - t2)
```
Keep the offset from the lowest-RTT samples. Now the client can convert host-time ↔ local-time.

**Playback state.** The host is the source of truth:
```
PlaybackState { positionSec, rate, isPlaying, hostTimestamp }
```
A client computes its target position as
`target = positionSec + (isPlaying ? (hostNow - hostTimestamp) : 0)` (converted via offset),
and corrects:
- drift `< ~250ms` → nudge `playbackRate` slightly (imperceptible catch-up).
- drift `≥ ~250ms` → hard `seek` to target.

**Target:** sub-100ms perceived sync. Each viewer is on their own headphones, so cross-phone
lip-sync perfection isn't required — moment-to-moment togetherness (for reactions/chat) is.

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

- On import, **probe** the file. Accept only **H.264 + AAC**. If the container isn't MP4 but
  codecs are compatible, **remux** to (fragmented) MP4 — fast, no re-encode. Otherwise reject
  with a clear message (transcoding is a later version).
- Fragmented MP4 (fMP4) plays well while still downloading (progressive friendly).
- Player: a single RN video component on each phone playing the local file; the sync layer
  drives its position/rate/play state.

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

## 9. Open technical questions (to validate on-device)

- Best cross-platform native modules for mDNS + embedded HTTP/WS, or do we write thin ones.
- Real hotspot throughput with 4–6 clients on representative phones (tune §4 constants).
- iOS background-audio/networking limits while the screen is on but app backgrounded.
- fMP4 remux on-device performance and which input containers we can remux vs. must reject.
- Local Network permission prompts (iOS) and how they affect the tap-to-join flow.
