# RailReel — Product Requirements (v1)

> A private movie theater that travels with you. Watch a movie together, in sync,
> on everyone's own phone — with **no internet**.

## 1. Problem

When friends travel together (especially on trains), watching a movie together is
basically impossible:

- Mobile networks are too weak/expensive to stream.
- Crowding 3–4 people around one phone is uncomfortable, and the speaker disturbs others.

So shared, on-the-go movie watching doesn't happen — even though the desire clearly does.

## 2. Solution

One person (the **host**) already has a movie file on their phone. Friends connect to the
host's **WiFi hotspot** (no internet). The app distributes the movie to each phone and then
keeps everyone's playback **perfectly in sync**, each on their own screen and headphones —
with live reactions and chat so it still feels like watching *together*.

## 3. Target users & scale

- Groups of **4–6 people** in one session.
- Friends with **Android** devices (the application is Android-only).
- Travel contexts: trains, planes, road trips, hostels, anywhere with no/poor internet.

## 4. Core experience

1. **Host** picks a local movie and creates a **session/event**.
2. Friends on the host's hotspot **see the event** and **request to join**; the host
   **approves** each person.
3. A **lobby** shows each person getting ready (download/buffer progress) before start.
4. The host presses play; **everyone plays in sync**, each on their own screen + headphones.
5. **Host holds master controls** (play/pause/seek). Participants can **send requests**
   ("can we pause?", "rewind that part") that the host can allow.
6. **Floating emoji reactions** fly over the video; a **group chat** runs alongside.

## 5. The defining technical decision: sync clocks, don't stream pixels

We do **not** live-stream video from host to clients. Instead:

- **Hybrid / progressive distribution.** When a session starts, the host serves the movie
  file to each client over HTTP (range requests). Playback can **start before the transfer
  finishes** (play the downloaded head, keep buffering ahead).
- During playback, **each phone plays its own local copy.** The host only sends tiny
  **sync messages** (play / pause / seek / clock heartbeat) over a WebSocket.

Why: stalls depend on whether download throughput keeps up with playback, not on real-time
streaming. **Important (corrected):** the host sends a *separate* copy to each client, so the
demand is **aggregate = N × bitrate**, not a single stream. A 1080p ~8–10 Mbps movie to 5
clients needs ~40–50 Mbps of usable hotspot throughput — which is at/near the ceiling of many
phone hotspots. So:

- For **moderate bitrate / smaller groups** (e.g. 720p ~3 Mbps × 4 clients ≈ 12 Mbps), the
  buffer comfortably runs ahead and progressive start is great.
- For **high bitrate × full groups**, the safe path is **full pre-cache before play** (and/or
  capping supported bitrate by group size). The app measures real throughput with everyone
  connected and chooses progressive-start vs. pre-cache accordingly, showing an ETA.

This still fixes the real-world risks, with honest framing:

| Risk | How this design handles it |
| --- | --- |
| Hotspot bandwidth | Transfer is decoupled from frame timing; for high bitrate × big groups we pre-cache before play and surface an ETA rather than promising real-time. |
| Host battery/heat | Host isn't transcoding or re-encoding; it serves bytes (native data plane) + sends clock pings. Host must stay foreground/awake/charged (see §8). |
| Sync precision | Sync is clock alignment, not pixel delivery → tight *perceived* sync (target ~sub-100ms), actuated with scheduled start + ready-ACKs (see architecture §5). |

See [`docs/architecture.md`](../architecture.md) for the full networking, sync, and buffering design.

## 6. v1 scope (decided)

**In scope**

- Manual hotspot onboarding (guided — apps can't toggle hotspot on Android).
- **Discovery:** mDNS/Bonjour for tap-to-join convenience; **robust fallback is a QR code /
  link** that encodes host IP + ports + session id + a **secret join token** (a 4-digit code
  alone can't resolve the host's IP offline, so it's only a human confirmation, not transport).
- Event create → request-to-join → **host approves each person** → readiness lobby.
- **Native** HTTP data-plane server with `Range` support (not a JS-bridge server) → file
  transfer; **all WS + HTTP access requires the session token**, bytes served only to approved
  clients.
- Local playback fed through a **caching player source** (ExoPlayer `CacheDataSource` or a
  local proxy) — never point the player at a partially-written file.
- **Adaptive start gate** (aggregate-throughput aware) + **group buffer floor with hysteresis
  & a host "continue without client" / evict option** (§7).
- Clock sync from **monotonic** clocks; resume actuated by **scheduling a future host time +
  ready-ACKs**; tight perceived sync (~sub-100ms target), likely with native timing help.
- **Host-only controls**; participants send requests to host (no delegation in v1).
- **Floating emoji reactions** over the video + group chat.
- Media: **already-compatible H.264 (AVC) + AAC MP4 only**, with a verified `moov`/fragment
  layout. Container remux and any transcoding are **deferred** (too many edge cases for v1:
  MKV+AC3/DTS, multi-track, Annex B, VFR, edit lists, storage). Reject others with a clear msg.
- **Preflight checks:** measure real aggregate throughput with all clients connected; host
  battery/thermal/storage check; pick progressive-start vs. full pre-cache accordingly.
- Reconnection: a dropped client rejoins and resyncs to the host's timestamp.
- Android.

**Out of scope (later versions)**

- Subtitles (bundled SRT) — *planned next*.
- On-device transcoding / companion pre-trip converter.
- Control delegation (host handing the remote to a friend).
- More than ~6 participants.
- Any cloud/account/online features.

## 7. Buffering & sync behavior (the "never ruin it" rules)

Not a flat preload. Two mechanisms:

1. **Adaptive start gate** — start only when *every* client has buffered ~60s ahead **and**
   the **aggregate** measured throughput will let the slowest client finish before playback
   catches the download edge: `remainingBytes / clientMbps < remainingPlayTime − margin`. If
   that doesn't hold for high-bitrate × big groups, switch to **full pre-cache before play**
   (show ETA). Clears in seconds on a good hotspot; waits (with a friendly reason) otherwise.
2. **Group buffer floor (with hysteresis)** — the host polls each client's "seconds buffered
   ahead" a few times per second. If any client drops below ~15s, the host **auto-pauses
   everyone** ("Waiting for {name}…"); it **auto-resumes** only after the laggard recovers to a
   higher mark (~30s) and ACKs ready — hysteresis prevents pause/resume flapping. A persistently
   slow client triggers a host choice: **keep waiting** or **continue without them** (they
   rejoin in catch-up mode once they reach target + lead). One bad device can't hold the group
   hostage indefinitely.

## 8. Constraints & non-functional requirements

- **Fully offline.** Only a local WiFi/hotspot link between phones. No internet, no accounts.
- **DRM-free files only.** Only movies the host legitimately owns as plain files; encrypted
  store downloads (Netflix/Prime) can't be shared — surfaced clearly in-app.
- **Android focus.** Both host and client roles work on Android.
- **Host is the session's lifeline (explicit v1 constraint).** While hosting, the host phone
  must stay **foreground, awake (keep-awake on), powered enough, and on the hotspot**. The app
  does a battery/thermal/storage preflight and states clearly: *if the host leaves/locks/kills
  the app or the hotspot drops, the session ends.* No background-hosting reliability promise.
- **Security.** Each session has a high-entropy secret; WS control and HTTP byte-serving both
  require it, and bytes go only to host-approved clients. Anyone merely on the hotspot can't
  pull the movie. Include file hash/size metadata so clients verify integrity.
- **Polished, production-grade UX.** This is a portfolio-grade, open-source app — invest in
  edge cases (reconnection, errors, empty/loading states) and a genuinely impressive UI.
- **Storage:** clients need ~1–4 GB free for the local movie copy; surface this up front.

## 9. Success criteria (v1)

- A host + 3–5 Android clients on a hotspot complete the full flow: discover → join →
  approve → lobby → synced playback to the end of a movie.
- Perceived sync stays tight (no client visibly ahead/behind during normal playback).
- A client can drop and rejoin mid-movie and resync automatically.
- No mid-movie stalls under normal hotspot conditions; weak clients trigger graceful
  group auto-pause rather than desync.

## 10. Phased delivery

| Phase | Theme | Outcome |
| --- | --- | --- |
| **0** | Foundation | Monorepo, Expo dev-client app, CI, design tokens, app shell. |
| **1** | Connect | Hotspot onboarding, mDNS discovery, event create/join/approve, lobby. |
| **2** | Transfer + play | HTTP range transfer, local player, progressive buffering. |
| **3** | Sync | Clock handshake, host controls, start gate + buffer floor, auto-pause. |
| **4** | Social | Group chat, floating reactions, request-to-host actions. |
| **5** | Polish | Reconnection, error/empty states, full WOW UI pass, docs for OSS. |

UI design direction is captured separately and confirmed with the user **before** the UI
build begins.
