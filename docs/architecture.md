# RailReel — Technical Architecture

This document describes the *how*, as implemented. For the *what/why* see
[`docs/prd/railreel-v1.md`](prd/railreel-v1.md).

> **The one rule: sync clocks, not pixels.** RailReel never live-streams video between phones.
> The host *distributes the file once* per guest (HTTP, byte ranges, resumable) and then keeps
> everyone together by *aligning clocks* over a WebSocket — each phone plays its **own local
> copy**. Anything that starts pushing real-time frames between phones is the wrong direction.

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
│  NsdHelper (Android NSD) → service "_railreel._tcp" + TXT record   │
│  Data plane  (NanoHTTPD)   → serves the movie file, HTTP Range     │
│  CtrlServer  (NanoWSD)     → control, sync clock, chat, reactions  │
│  Foreground service        → keeps the process + WiFi/CPU awake    │
└───────────────────────────────────────────────────────────────────┘
        ▲ join hotspot              ▲ discover + connect
┌───────┴────────┐          ┌───────┴────────┐
│  Guest phone   │   ...    │  Guest phone   │   (×3–5)
│  NSD browser   │          │  HTTP download │
│  WS client     │          │  ProxyServer → │
│                │          │  expo-video    │
└────────────────┘          └────────────────┘
```

All native pieces live in one local Expo module, `apps/mobile/modules/railreel-host`
(Kotlin, Android only): `RailReelHostModule` (data plane + module surface), `CtrlServer`,
`ProxyServer`, `NsdHelper`, `RailReelHostService`.

- **Transport:** the host's WiFi hotspot puts everyone on one LAN. The OS will not let an app
  toggle the hotspot, so onboarding *guides* the host to enable it manually.
- **Discovery (three ways in):** (1) mDNS via Android `NsdManager` for tap-to-join, (2) a QR code
  and (3) a `railreel://join?...` invite link (tapped, or pasted). Discovery is **best-effort**
  because Android NSD is async and lifecycle-sensitive; the QR/link is the guaranteed path. Both
  carry the host IP, ports, session id and the **session token**. (A bare 4-letter code can't
  resolve the host's IP offline — it is only a human confirmation, never transport or auth.)
- **Control plane (`CtrlServer`):** a WebSocket server on the host. Small JSON messages (see §6).
  A connection must present the session token (`?tk=`). The NTP-style clock handshake
  (`syncPing`/`syncPong`) is answered **in native code** with `elapsedRealtimeNanos` so it never
  crosses the JS bridge.
- **Data plane:** a **native** NanoHTTPD server serving the movie with `Range` support (206/416,
  `HEAD`, `Accept-Ranges`), bounded buffers and cancellation — *not* a JS-bridge server (the
  spike measured ~1.8 Mbps through the bridge). It requires the session token **and** a
  per-guest download grant the host has approved, and answers `HEAD` only to approved grants too.
- **Client playback proxy (`ProxyServer`):** a localhost-only (`127.0.0.1`) HTTP server on each
  guest that serves the *still-downloading* file to the player. See §7.
- **Host liveness:** `RailReelHostService` is a `dataSync` foreground service with WiFi and
  wake locks and an ongoing notification (the wake lock is bounded at 6 h; Android 15's `dataSync` foreground-service timeout stops the service when it fires).
- **Version gate:** every join payload, mDNS record and invite carries `PROTOCOL_VERSION`
  (currently **2**). Mismatched phones refuse the join up front with an "update both phones to
  the same version" message instead of half-working.
- **Cleartext LAN:** `http://` and `ws://` to a LAN IP are blocked by default on release builds,
  so the `plugins/withCleartextTraffic` config plugin enables cleartext. There is no TLS (see §10).

> Native modules are why RailReel needs an Expo **custom dev client**, not Expo Go. The module
> is local (no community library fit the data plane), and any change to it needs an APK rebuild;
> CI compiles its Kotlin on every PR that touches native code.

## 3. Session lifecycle

```
Host: pick movie → probe + validate codecs (rejected here, before any server starts)
      → create session → enable hotspot → start servers → advertise mDNS / show QR
Guest: join hotspot → discover / scan / open invite → send `join` (requests to join)
Host: approve (or deny) each person
Guest: enter lobby → reuse a kept copy (fingerprint match) or download (HTTP range)
Host: lobby shows per-guest readiness → "Start Show" when the gate passes (§4)
All: player opens PAUSED → host presses Play → synchronized playback (§5) + chat/reactions
Any guest: drop → reconnect → resync clock + resume the download where it stopped
Host: end session → cleanup (guests choose Delete or Keep & Leave)
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
- Guests send `heartbeat`s (progress, `bufferedAheadSec`, `downloadMbps`, `stalled`) over the WS.
- If any in-show guest falls under the floor (≈15 s) or reports a sustained player stall, the host
  broadcasts `state` with `isPlaying: false` (the UI shows who the room is waiting on).
- It resumes only when the laggard recovers to the release mark (≈30 s, strictly above the floor)
  — the gap prevents pause/resume flapping. The gate only auto-resumes a pause *it* caused, never
  a manual host pause.
- A guest that joins late is admitted to a running show only when it has a playable source and
  enough buffer (`canJoinShow`): a progressive source needs a fast-start file, otherwise the
  guest waits for 100%. While the room is held, the host can tap **"Play without {name}"**
  (`playWithout()` in the Player) to override the hold until that guest recovers.

The decisions are pure functions in `lib/sync/startGate.ts` (start gate: 60 s lead + 60 s finish
margin; buffer floor: pause below 15 s, release at 30 s; catch-up lead 30 s) so the constants are
tunable from real-device fixtures. Coverage is judged pessimistically for VBR files, and byte
progress is capped below 100% until the download's size (and, when available, fingerprint) are validated.

## 5. Sync protocol (clock alignment)

**Clock offset (NTP-style).** Each guest periodically does:
```
guest  →  {t1}                    (guest send time)
host   →  {t1, t2, t3}            (host recv, host send — stamped natively)
guest     t4 = now
offset = ((t2 - t1) + (t3 - t4)) / 2      // = hostTime − guestTime
rtt    =  (t4 - t1) - (t3 - t2)
```
The offset is taken from the lowest-RTT samples (`lib/sync/clock.ts`). All timestamps come from a
**monotonic** clock, never `Date.now()`. The host's `t2`/`t3` are taken at the native socket edge
with `elapsedRealtimeNanos`; the guest's `t1`/`t4` are taken in JS callbacks, so guest-side bridge
jitter is part of the error budget. (The spike measured RTT ~44 ms over a hotspot.)

**Playback state.** The host is the source of truth:
```
PlaybackState { positionSec, rate, isPlaying, hostMonotonicMs, ended? }
```
A guest computes the target position as
`target = positionSec + (isPlaying ? (hostNowMs − hostMonotonicMs) / 1000 × rate : 0)` (host time derived
via the offset) and corrects local drift (`lib/sync/playback.ts`):

| Drift | Action |
| --- | --- |
| within ~120 ms | hold (rate 1) |
| 120 ms – 0.5 s | inaudible rate trim, at most **±5%** |
| 0.5 s – 1.2 s | assertive catch-up rate, at most **±15%** |
| beyond 1.2 s | hard seek, leading by the device's measured seek latency so it lands on target |

**Actuation.** The host plays, pauses and seeks immediately and broadcasts the new `state`; each
guest drift-corrects toward it. There is **no scheduled (future-timestamp) resume and no
seek-complete ACK** today: the `resume { atHostMonotonicMs }` message exists in the protocol but
is unused, and `ready` is sent when a guest's download completes, not after seeks. Scheduled
resume with ready-ACKs is future work and would tighten the start. Guests only hold the room (`stalled`) after their player has been continuously not-ready for a
grace period (~1.2 s), so brief decoder blips and drift-seeks don't freeze everyone.

**What this achieves.** *Perceived* sync, not frame accuracy. On test devices we measured roughly
**50–80 ms steady-state drift**; player latencies and JS-side timestamps mean it varies by phone.
Each viewer is on their own headphones, so moment-to-moment togetherness (for reactions and chat)
matters more than lip-sync perfection across phones.

## 6. Control & messaging (WebSocket)

Control, chat, reactions and sync share one WS. TS types live in `lib/protocol/messages.ts`
(`PROTOCOL_VERSION = 2`); `parseClientMsg` / `parseServerMsg` check the JSON structure and message discriminants, and handlers validate the payload fields they use. `syncPing` is answered natively and `syncPong` is handled directly in `syncClient.ts`, outside those parsers.

```ts
// host → guests
type ServerMsg =
  | { t: 'welcome'; sessionId; media; you }
  | { t: 'state'; state: PlaybackState }
  | { t: 'pause'; reason: 'host' | 'waiting'; who? }   // defined, currently unused
  | { t: 'resume'; atHostMonotonicMs }           // defined, currently unused
  | { t: 'roster'; participants; media? }          // media.subtitle = { name, sizeBytes, rev }
  | { t: 'requestDecision'; id; approved }          // join approval / denial
  | { t: 'chat' | 'reaction'; from; fromId?; …; at }
  | { t: 'syncPong'; t1; t2; t3 }
  | { t: 'subtitle'; name; content }
  | { t: 'playbackRequestDecision'; requestId; requesterId; approved; action; seconds? }
  | { t: 'ended'; reason: 'host-left' | 'host-ended' }

// guest → host
type ClientMsg =
  | { t: 'join'; id; name; token; grant }
  | { t: 'heartbeat'; id; grant; progress; bufferedAheadSec; downloadMbps; positionSec; stalled?; inShow?; decodeOk? }
  | { t: 'ready'; id; grant; positionSec }
  | { t: 'playbackRequest'; id; grant; requestId; action: 'pause' | 'rewind'; seconds? }
  | { t: 'subtitleRequest'; id; grant; rev }        // pull the subtitle body when `rev` differs
  | { t: 'chat'; id; grant; text } | { t: 'reaction'; id; grant; emoji }
  | { t: 'leave'; id; grant } | { t: 'syncPing'; t1 }
```

- **Host-only control:** guests never mutate playback. They send a `playbackRequest` (pause or
  rewind 15 s); the host's prompt decides and the resulting `state` is broadcast. A request
  expires on the guest after 12 s and is released on reconnect.
- **Hub topology:** the host relays chat and reactions to everyone (including the sender, so the
  host's echo is the single ordering). It stamps the sender's *name* and its own clock; there is
  no guest-to-guest mesh.
- **Subtitles:** the host attaches a validated `.srt` and broadcasts the body once. The limit is 2,000,000 UTF-8 bytes for the body and 120 characters for the name, enforced on both host and guest.
  The roster carries only `{ name, sizeBytes, rev }`; a guest whose revision differs (just
  approved, reconnected, or the file was replaced) pulls it with `subtitleRequest`, and
  recomputes the revision from what it received.
- **Identity is connection-bound** (§10): a participant `id` is only honored on the native
  connection that proved it.

## 7. Media pipeline

- **Validate before hosting.** The native probe reports the *real* container and track mimes.
  `lib/media/compat.ts` accepts only **H.264 (`video/avc`) video, with AAC (`audio/mp4a-latm`)
  audio or no audio at all, in an MP4 or MOV (QuickTime) container**. It inspects the first video
  and first audio track, and rejects everything else *before the servers start*, with the
  exact sentence the host sees (what was found, plus a HandBrake "Fast 1080p30" hint). Remux and
  transcoding are out of scope: they break on real files (MKV with AC-3/DTS, multi-audio,
  Annex B, VFR, edit lists, 2× temporary storage). Guests additionally check *their* decoder
  against the real codec and frame size and warn when it can't keep up.
- **Preflight** (`lib/media/preflight.ts`): guests check free space (movie + 200 MB) before
  downloading, the host sees a battery warning (< 30% while discharging) *while hosting*, and
  guests warn when their decoder can't handle the frame size. None of these block server startup.
- **Integrity.** The host serves the size and a content fingerprint (`media.hash`: the first and
  last 1 MiB plus the size, not a full-file hash). Guests validate status and size, and compare
  the fingerprint when one is available and the download is complete (skipped during progressive
  playback or when the host supplies none).
- **Distribution.** Guests download with Range requests straight to disk, in the app's cache
  storage. Transfers **resume**: a hotspot drop continues with `Range: bytes=N-` into the same
  file (only a 206 with the exact final size is accepted), a per-transfer watchdog aborts a
  transfer silent for 8 s, and retries back off (1–15 s) for up to **six automatic retries per failure streak**, after the initial
  attempt. The budget resets on success, a manual retry, or once at least 4 MiB has been retained.
- **Progressive playback never points the player at a partially-written file.** `ProxyServer`
  binds `127.0.0.1` on the guest and serves the file *while it grows*, declaring the **final size**
  up front. A read that catches the download edge simply blocks until more bytes land, which
  `expo-video` (ExoPlayer) treats as a slow network, so normal buffering and our stall reporting
  apply; if nothing arrives for 30 s the socket errors and player retry takes over. This requires
  a **fast-start** file (`moov` before `mdat`, detected by the host); otherwise the guest plays a
  complete local file after a full pre-cache.
- **Player.** `expo-video` (ExoPlayer on Android) is the player. It provides rate control and
  seek-ready signals; the Player screen reconciles its native state with the room's.
- **Kept copies.** A completed download writes a small record (fingerprint, size, title). On a
  later approval, a kept copy is reused when the size matches and a fresh fingerprint equals the
  host's `media.hash` — no transfer. A startup sweep removes everything else.

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
                drift correction, media compat rules (unit-tested with vitest)
  net/          client-side network glue (discovery, download, ws); the host servers
                (http + ws + mDNS) are native, in modules/railreel-host
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

- **Warnings:** the host sees a battery warning while hosting, and guests check free storage
  before downloading; nothing blocks startup, so the UX is honest rather than gated.
- **Keep-awake** on while hosting; encourage the host to stay plugged in.
- **Honest UX:** if the host switches away from the app during the show, the room **pauses for
  everyone** (the session stays up via the foreground service) and resumes only when the host
  returns and presses Play. If the host kills the app, the phone shuts down, or the hotspot drops,
  the session ends. No background-hosting reliability promise.
- Clients handle host disappearance gracefully (clear "host left — session ended" state).

## 10. Security model (v1)

RailReel is built for **a small, trusted group on a private hotspot**. The model is deliberately
simple and is stated here as it is, not as a stronger promise.

- **The session token is public to the hotspot, by design.** It is generated per session (128-bit,
  rotated every session) and is published in the mDNS TXT record (`t`) so tap-to-join works
  without a QR scan. It is also in the QR/link. So **anyone on the hotspot can open a control
  socket and *request* to join**. The token only means "you may talk to this host".
- **The host approves each person.** A new `join` stays *pending*. The host sees the request and
  approves or denies it. Only on approval does the host authorize that guest's **download grant**
  (a secret the guest mints itself, 128-bit) on the data plane and mark its connection approved.
- **Bytes go only to approved grants.** The HTTP data plane requires the token **and** an approved
  grant (`HEAD` included, so an unapproved peer learns nothing, not even the size).
- **Room traffic goes only to approved, connection-bound guests.** `broadcast` reaches only
  connections JS marked approved. A pending requester receives only direct replies (its own `requestDecision`, and `syncPong`
  answers to its clock pings) and lifecycle notices (`ended`). It never sees roster, chat, reactions,
  subtitles or playback state.
- **Identity is bound to the connection, not trusted from frames.** Native assigns every accepted
  socket an opaque `connId`, and JS binds a participant to the connection that proved it (a valid
  `join`, or a grant-proven reconnect). A connection speaks for exactly one participant; a frame
  claiming another `id` is dropped; a `join` for an existing id must present the same grant (no
  hijack); a close only affects the participant bound to that connection. Approval is handled
  with tickets that deny/leave/reset invalidate, so a stale async approval cannot re-approve.
- **The host control plane is bounded.** Inbound guest-to-host frames are capped (64 KiB per frame/message, 64 fragments)
  and rate-limited *before* NanoWSD allocates the payload; outbound writes go through a bounded
  per-socket queue with its own writer thread and a watchdog, so a peer that stops reading only
  stalls itself. Admission is capped per remote IP (3) and overall (24), and when full the oldest
  *unapproved* socket makes way, so pending requesters can't lock out approved guests.
- **Integrity.** Movie metadata carries size and a fingerprint; guests verify what they received.

**Limits (accepted for v1).** Both secrets are bearer tokens over plaintext HTTP/WS on the LAN.
This stops someone merely on the hotspot from pulling the movie or joining the room unapproved. It
does **not** defend against a LAN sniffer who can observe and replay an approved guest's traffic,
or against a host who approves the wrong person. Don't run it on a network you don't trust.

## 11. Known limits & remaining device validation

- Aggregate hotspot throughput with 4–6 simultaneous downloads varies a lot by phone; the start
  gate adapts, but the 60 s / 15 s / 30 s constants are still tuned from real-device runs.
- Some hotspots enable AP/client isolation, so guests can't reach the host at all; the app can
  only surface a clear "can't reach host" state.
- The host phone is the infrastructure (§9): screen-off hosting is not supported (with the screen
  off the SoftAP stops serving clients), so the host must stay on screen.
- Guest-side timestamps are taken in JS; very slow phones show more drift (see §5).
- There is no scheduled resume / seek-complete ACK yet (§5); sync relies on drift correction.
- Long soak testing (full 2 h movie, lock/call/background, reconnect) is ongoing.

## Appendix: design history

An early design review (2026-06) shaped several decisions that remain in force: the
aggregate-throughput correction (§4), monotonic clocks (§5), a caching proxy instead of partial-file playback (§7), a native data plane (§2), and the
host-as-single-point-of-failure stance (§9). A later pre-release audit corrected the docs on the
trust model (§10), media validation (§7) and sync claims (§5).
