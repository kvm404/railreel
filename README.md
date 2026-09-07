<div align="center">

<img src="docs/assets/railreel-hero-banner.jpg" alt="RailReel — The Offline Night Train Cinema" width="100%" />

# 🎬 RailReel

**A private movie theater that travels with you.**  
Watch movies together with friends in perfect frame-accurate sync — with **zero internet**.

[![Latest Release](https://img.shields.io/github/v/release/kvm404/railreel?color=FFB266&label=Latest%20Release)](https://github.com/kvm404/railreel/releases/tag/v0.1.0)
[![Download APK](https://img.shields.io/badge/Download-Android%20APK-57D2E6?logo=android&logoColor=white)](https://github.com/kvm404/railreel/releases/download/v0.1.0/RailReel-v0.1.0.apk)
[![License: MIT](https://img.shields.io/badge/License-MIT-amber.svg)](LICENSE)

</div>

---

## What is RailReel?

Picture this: you and your friends are on a 6-hour train ride or road trip. Cell service drops to zero. Everyone is bored, but one friend has a movie saved on their phone.

Crowding 4 people around a single 6-inch screen with the speaker blaring is uncomfortable for you and annoying to everyone around you.

**RailReel turns your trip into a private screening room:**

1. One person hosts the movie.
2. Friends connect to the host's portable Wi-Fi hotspot.
3. The movie transfers directly between phones over the local network.
4. Everyone puts on their own headphones, watches on their own screen, and stays **locked in sync**.

When the host pauses, it pauses for everyone. If someone misses a dialogue, they can request a quick rewind. Floating emoji reactions and group chat let you share the moment together — all without a single byte of internet data.

---

## 📥 Download & Install

RailReel is free, open source, and works on Android devices (Android 10+).

👉 **[Download RailReel v0.1.0 (APK)](https://github.com/kvm404/railreel/releases/download/v0.1.0/RailReel-v0.1.0.apk)**  
*(You can also find all versions and release notes on the [Releases page](https://github.com/kvm404/railreel/releases).)*

### Quick 3-Step Setup:
1. **Download** the `.apk` file directly on your Android phone.
2. **Install** the package (if prompted, enable *"Install unknown apps"* for your browser or file manager).
3. **Open the app** — no sign-up, no login, and no email required.

---

## 🚂 How a Movie Session Works

### 1. Pick & Host
The host opens RailReel, chooses a local video file from their phone (MP4), and can optionally attach a `.srt` subtitle file.

### 2. Connect Your Friends
The host turns on their phone's personal hotspot. Friends connect their Wi-Fi to the hotspot, open RailReel, and scan the host's on-screen QR code (or tap the room name via auto-discovery) to join.

### 3. The Departure Lounge
Everyone enters the lobby where glowing rings show each friend's download progress. Once ready, the host taps **Start Show**.

### 4. Watch Together in Sync
The movie starts simultaneously for the whole cabin. When the host plays, pauses, or seeks, every connected phone stays locked to the same second.

### 5. Reactions, Chat & Playback Requests
- **Floating Reactions**: Tap emoji reactions that drift across everyone's screen in real time.
- **In-Movie Chat**: Chat with your friends without leaving the player.
- **Playback Requests**: Want a quick snack break? Tap *"Request Pause"* or *"Rewind 15s"*. The host gets a simple on-screen prompt to allow it with one tap.

### 6. Clean Up When Done
Once the credits roll or you leave the session, a single tap deletes the downloaded movie file from your phone so your storage is reclaimed immediately.

---

## 💡 Good to Know

- **Does it use any mobile data or internet?**  
  None. The hotspot is purely a local Wi-Fi link between devices. You can be in airplane mode in the middle of a desert and it will work.
- **What video formats work best?**  
  Standard DRM-free MP4 files (H.264 video with AAC audio) work smoothly on virtually all Android phones.
- **Can I bring subtitles?**  
  Yes! Just select a standard `.srt` subtitle file alongside the video when hosting, and captions will sync across every phone.
- **How many people can watch together?**  
  RailReel is tailored for comfortable small groups of 4 to 6 people traveling together.

---

## 🛠 For Developers

RailReel achieves tight synchronization by aligning **device clocks rather than streaming heavy video pixels**:
- High-speed local HTTP data plane built in Kotlin with RFC 7233 byte-range support.
- Microsecond-level NTP clock alignment over a low-latency local WebSocket control channel.
- Continuous drift compensation using bounded playback-rate nudges (0.95×–1.05×) so audio never clips or stutters.
- Progressive local streaming proxy allowing playback to begin before the file finishes downloading.

Want to learn more about the architecture or contribute? Read the technical deep dive in [`docs/architecture.md`](docs/architecture.md).

### Building from Source:
```bash
bun install
bun run mobile:start      # start the Expo development server
bun run mobile:android    # compile and run on a connected Android device
bun run test              # run full Vitest unit test suite
```

---

<div align="center">
Built as an open-source project. Born on a train. 🚆
</div>
