# Changelog

## [0.3.0](https://github.com/kvm404/railreel/compare/v0.2.0...v0.3.0) (2026-11-27)


### Features

* host HEVC and MKV, recover blank screens, bring back hidden player controls ([#47](https://github.com/kvm404/railreel/issues/47)) ([436e04c](https://github.com/kvm404/railreel/commit/436e04cfa8c5f5ae0c874b29a92a6e5da80e71db))


### Bug Fixes

* keep sync through sleep, detect a silent host, preserve pitch, guard the subtitle picker, publish the served size ([#49](https://github.com/kvm404/railreel/issues/49)) ([9e6a696](https://github.com/kvm404/railreel/commit/9e6a696f56aea4b3ecbf71153d1ab10892c476e6))

## [0.2.0](https://github.com/kvm404/railreel/compare/v0.1.0...v0.2.0) (2026-11-23)


### Features

* **cache:** implement post-session cache cleanup policy and storage lifecycle management ([f81a902](https://github.com/kvm404/railreel/commit/f81a90243c84d905e88424c18e1c7e0a2d80f303))
* **media:** validate codecs before hosting and check guests against the real codec ([#35](https://github.com/kvm404/railreel/issues/35)) ([d3f0064](https://github.com/kvm404/railreel/commit/d3f00645580d97dcfe5c4b7adb12c225d6bc3623))
* **moderation:** implement follower playback requests, host moderation banner, and room transport sync ([4558063](https://github.com/kvm404/railreel/commit/45580636cb5e1180e2a8d130389a9adef5370123))
* **subtitles:** implement .srt parser, cue sync math, distribution, and caption overlay ([e9ec59a](https://github.com/kvm404/railreel/commit/e9ec59a6cb24699da653a02973b697804afd6fc6))
* **ui:** accessible text, neutral/danger buttons, readiness sequence, join and invite flows ([#36](https://github.com/kvm404/railreel/issues/36)) ([d95bd0a](https://github.com/kvm404/railreel/commit/d95bd0afed1bb3e7485ea95003342e5a951c1756))
* **ui:** honest invite status, actionable join errors, plain cleanup copy and flow polish ([#41](https://github.com/kvm404/railreel/issues/41)) ([b888752](https://github.com/kvm404/railreel/commit/b88875225b83a9983406791db9bed3db41389c46))


### Bug Fixes

* **android:** allow cleartext LAN traffic in release builds ([#31](https://github.com/kvm404/railreel/issues/31)) ([6290f0f](https://github.com/kvm404/railreel/commit/6290f0f3f500a465c3dcfb3f8cd3fef84cffa8f0))
* close release blockers — replay after the end, visible join requests, guest keep-awake, caption budget ([#44](https://github.com/kvm404/railreel/issues/44)) ([ecb1863](https://github.com/kvm404/railreel/commit/ecb1863d402d832ab9c39f4640d0805589f859e9))
* **host:** harden the control plane — bounded frames, non-blocking broadcast, connection-bound identity ([#34](https://github.com/kvm404/railreel/issues/34)) ([c32a674](https://github.com/kvm404/railreel/commit/c32a674885c0908e088ad33b95a4b52d73a51e10))
* **navigation:** route Android back through screen exits and reset the stack on session end ([#33](https://github.com/kvm404/railreel/issues/33)) ([db11d54](https://github.com/kvm404/railreel/commit/db11d54ad759b39588b97d0dc1fe171f4ab96f52))
* **player:** playback correctness, measured overlay budget, live reduce-motion and UI polish ([#43](https://github.com/kvm404/railreel/issues/43)) ([70f1065](https://github.com/kvm404/railreel/commit/70f1065c4e5fddd4cf48d640283c5a8859a31eb3))
* **session:** bound admission, cancellable joins, owned purges and a live invite network ([#42](https://github.com/kvm404/railreel/issues/42)) ([d701526](https://github.com/kvm404/railreel/commit/d701526557355dd918c7dfcaac361192886b260a))
* **session:** send the current playback state to a reconnecting or newly approved guest ([#45](https://github.com/kvm404/railreel/issues/45)) ([71d54a7](https://github.com/kvm404/railreel/commit/71d54a73e9e9b6c1dcdf8162c876d38c60d25e87))
* **transfer:** own, resume and recover the guest movie transfer ([#37](https://github.com/kvm404/railreel/issues/37)) ([fc0a1c9](https://github.com/kvm404/railreel/commit/fc0a1c93170602356b583443edeff9827cfa76f6))
