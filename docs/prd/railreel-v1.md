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
- **Mixed iOS + Android** friend groups (both platforms are first-class).
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

Why: stalls depend on whether download throughput exceeds the video bitrate, not on real-time
streaming. Over a phone hotspot, throughput (~30–50 Mbps) is ~5× a typical movie bitrate
(~5–10 Mbps), so the buffer runs *ahead* of playback. This fixes the three real-world risks:

| Risk | How this design handles it |
| --- | --- |
| Hotspot bandwidth | ~Zero network during playback; transfer happens once, up front. |
| Host battery/heat | Host isn't transcoding/streaming during the movie — just sending clock pings. |
| Sync precision | Sync is clock alignment, not pixel delivery → sub-100ms achievable. |

See [`docs/architecture.md`](../architecture.md) for the full networking, sync, and buffering design.

## 6. v1 scope (decided)

**In scope**

- Manual hotspot onboarding (guided — apps can't toggle hotspot on iOS/Android).
- mDNS/Bonjour discovery for **tap-to-join**, with a 4-digit code fallback.
- Event create → request-to-join → **host approves each person** → readiness lobby.
- HTTP range-based progressive file transfer (host → clients).
- Local playback with **adaptive start gate** + **group buffer floor / auto-pause** (§7).
- NTP-style clock sync, **sub-100ms** target.
- **Host-only controls**; participants send requests to host (no delegation in v1).
- **Floating emoji reactions** over the video + group chat.
- Media: **H.264 (AVC) + AAC in MP4 only**; remux container when codecs are fine; clearly
  reject incompatible files (no on-device transcoding in v1).
- Reconnection: a dropped client rejoins and resyncs to the host's timestamp.
- iOS + Android.

**Out of scope (later versions)**

- Subtitles (bundled SRT) — *planned next*.
- On-device transcoding / companion pre-trip converter.
- Control delegation (host handing the remote to a friend).
- More than ~6 participants.
- Any cloud/account/online features.

## 7. Buffering & sync behavior (the "never ruin it" rules)

Not a flat preload. Two mechanisms:

1. **Adaptive start gate** — start only when *every* client has buffered ~60s ahead **and**
   measured download rate comfortably exceeds the video bitrate. Clears in seconds on a good
   hotspot; waits longer (with a friendly reason) only for marginal connections.
2. **Group buffer floor** — the host polls each client's "seconds buffered ahead of playhead"
   a few times per second. If any client drops below ~15s, the host **auto-pauses everyone**
   ("Waiting for {name}…") and **auto-resumes** on recovery. The group stays locked together.

## 8. Constraints & non-functional requirements

- **Fully offline.** Only a local WiFi/hotspot link between phones. No internet, no accounts.
- **DRM-free files only.** Only movies the host legitimately owns as plain files; encrypted
  store downloads (Netflix/Prime) can't be shared — surfaced clearly in-app.
- **Cross-platform parity.** Host and client roles work on both iOS and Android.
- **Polished, production-grade UX.** This is a portfolio-grade, open-source app — invest in
  edge cases (reconnection, errors, empty/loading states) and a genuinely impressive UI.
- **Storage:** clients need ~1–4 GB free for the local movie copy; surface this up front.

## 9. Success criteria (v1)

- A host + 3–5 mixed-OS clients on a hotspot complete the full flow: discover → join →
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
