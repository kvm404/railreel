# Contributing to RailReel

Thanks for helping out. RailReel is an offline, in-sync group movie app for Android. Read
[`README.md`](README.md) and [`docs/architecture.md`](docs/architecture.md) first, especially the
one rule: **sync clocks, not pixels**. Changes that push real-time video frames between phones are
out of scope.

## Setup

You need:

- [bun](https://bun.sh) **1.3.5** (package manager and workspace runner; no npm/yarn/pnpm)
- Node.js **20.19.4 or newer** in the 20 line, JDK **17**, the Android SDK (`ANDROID_HOME` set)
- A **physical Android device** (USB debugging). Hotspots and mDNS don't work on emulators.

RailReel uses native modules, so it runs in a custom **Expo dev client**. Expo Go won't work.

```bash
bun install
bun run mobile:android   # build + install the dev client on your device (first run is slow)
bun run mobile:start     # start Metro for the dev client
```

## Checks

Run these from the repo root before every push. CI runs the same:

```bash
bun run lint && bun run typecheck && bun run test
```

Put decision logic in pure functions under `apps/mobile/src/lib/` and cover it with vitest tests in
`apps/mobile/src/test/` (clock math, start gate, drift correction, media rules, protocol parsing).
When a real-device case surprises you, add a fixture for it.

## Commits and pull requests

- Use **Conventional Commits** (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `ci:`).
  release-please computes version bumps and the changelog from them, so the type matters.
  Mark breaking changes with `!` or a `BREAKING CHANGE:` footer.
- One logical change per commit. Branch off `main`; never commit straight to `main`.
- Open a PR against `main` with a short summary, what changed, how you tested it, and what a human
  should verify on a phone. Keep the history clean: no stray fixup commits left in the PR.
- Comments should explain *why*, not *what*. Use the design tokens in `src/theme/tokens.ts`
  rather than hardcoded colors, and respect reduce-motion and accessibility labels for UI work.

## Native changes

Anything under `apps/mobile/modules/` (Kotlin), `apps/mobile/plugins/`, `app.json`, or native
dependencies needs an **APK rebuild** (`bun run mobile:android`); Fast Refresh does not reload
native code. Don't commit generated `apps/mobile/android/` output.

CI has a **native (Android compile)** job that runs `expo prebuild` and compiles the Kotlin of the
`railreel-host` module whenever those paths change, so a broken manifest, plugin, dependency or
Kotlin file fails the PR instead of the release build. A green native job is required for native PRs.

## Device testing checklist (two phones)

Unit tests can't cover hotspots, decoders or the Android lifecycle. For anything touching
networking, sync, playback or the host module, test on **two physical phones** (one host, one guest):

1. Install the same build on both. Host: enable the hotspot. Guest: join its Wi-Fi.
2. Host picks an H.264 + AAC MP4 (a silent H.264 file is also accepted) (also try an HEVC or MKV file: it must be rejected with a hint).
3. Guest joins by mDNS tap, QR scan and the invite link. Confirm the host sees a **request** and the
   guest gets nothing until the host **approves** (deny once to check the dead-end screen).
4. Lobby: download progress shows and reaches ready. Try a fast-start and a non-fast-start file.
5. Host taps **Start Show**, then presses **Play** in the player. Both phones start together.
6. Pause, resume and seek from the host; confirm the guest follows with no visible drift. Request a
   pause and a rewind from the guest; the host's prompt allows or denies it.
7. Chat, reactions and (if testing subtitles) toggle an `.srt` on the guest.
8. Resilience: turn the hotspot off for ~10 s mid-download, then on (the download resumes, not
   restarts); background and return to the app; leave with **Keep & Leave** and rejoin the same movie
   (no re-download).
9. Version gate: a phone speaking a different protocol version (`PROTOCOL_VERSION`) refuses to join with the "update both phones" message.
10. Add a third phone and check that late-join and the buffer-floor "waiting for a friend" pause work.

Note the phone models and Android versions you tested in the PR.

## Releases

Releases are automated with **release-please**:

1. Merge Conventional-Commit PRs into `main`. release-please keeps a **release PR** open with the
   version bump (root `package.json`, `apps/mobile/package.json`, `app.json`) and changelog.
2. Merging the release PR creates the tag (`vX.Y.Z`) and a draft GitHub release.
3. The **`build-apk`** workflow is then called: it checks that the tag matches the versions in the
   repo, runs lint/typecheck/test, runs `expo prebuild`, builds the **universal release APK**
   (arm64-v8a + armeabi-v7a), signs and verifies it, attaches `RailReel-vX.Y.Z.apk` to the release
   and publishes it. You can also run it manually for an existing tag (`workflow_dispatch`).

APK signing uses four repository secrets, which must be **all set or all unset**:
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
If none are set the APK is debug-signed and a warning is emitted; don't distribute that as an
official release. The Android `versionCode` is derived from the tag
(`major * 10000 + minor * 100 + patch`), so keep minor and patch below 100. Assets on a published
release are never overwritten.
