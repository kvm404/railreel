# RailReel — Claude Code Configuration

RailReel: an **offline, in-sync group movie-watching** app. One host shares a local movie over
their WiFi hotspot; 4–6 friends watch in sync on their own Android phones, with
reactions and chat. No internet, no accounts. See `docs/prd/railreel-v1.md` and
`docs/architecture.md` — read both before non-trivial work.

## Commit & PR rules

- **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:` …) so
  `release-please` can compute semver bumps.
- **Clean commits only.** Never add `Co-Authored-By`, `Generated with`, or any reference to
  Claude/AI in commit messages, PR descriptions, or anywhere in git history.
- One logical change per commit. Branch off `main`; never commit straight to `main` for
  feature work — open a PR.
- The repo is **private for now** (will go public later); keep history portfolio-clean.

## The one architecture rule to never break

RailReel **does not live-stream video**. The host **distributes the file** (HTTP range,
progressive) and then keeps everyone in sync by **aligning clocks** over a WebSocket — each
phone plays its **own local copy**. If a change starts pushing real-time video frames between
phones, stop: that's the wrong direction. See `docs/architecture.md` §5.

## Project layout

- `apps/mobile/` — the Expo / React Native app (host **and** client roles in one app).
  - `src/theme/` — design tokens, palette, typography, motion, ThemeProvider.
  - `src/ui/` — styled primitives.
  - `src/components/` — composite UI.
  - `src/screens/` — Home, CreateSession, JoinSession, Lobby, Player, …
  - `src/hooks/` — hooks bridging UI ↔ services.
  - `src/lib/` — **pure** domain logic (protocol types, clock math, buffer/start-gate
    decisions, drift correction, media-probe rules). Unit-tested with vitest.
  - `src/net/` — host servers (http + ws + mDNS) and client (discovery + download + ws).
  - `src/data/` — local persistence; `src/types/` — shared types.
  - `apps/mobile/modules/` — native modules (mDNS, embedded servers) where no good lib exists.
- `docs/` — PRD (`docs/prd/`) and architecture.

## Tooling

- **bun** is the package manager and workspace runner. Use `bun`, not npm/yarn/pnpm.
- **Expo custom dev client** (`expo-dev-client`) — Expo Go is NOT sufficient (native modules).
- React Native 0.81 / React 19 / Expo SDK 54, **TypeScript strict**.
- **Android-only.** The app is designed exclusively for Android devices.

## Testing

- **vitest**, `bun run test`. Highest-value seams are the **pure functions** in `src/lib/`:
  clock-offset math, start-gate/buffer-floor decisions, drift→seek/rate decisions, and media
  probe rules. Test these against fixtures; grow fixtures whenever a real-device case surprises us.

## UI bar

- The UI must be **WOW** — fully polished, smooth, production-grade. Centralize design in
  `src/theme/tokens.ts`. **Pause and get the user's UI direction before starting any UI build.**

## Working style

- **Human-agentic loop:** when a manual step is required (enable hotspot, connect a phone via
  ADB, grant Android permissions, etc.), tell the user clearly.
- **Codex is the review partner.** Use `codex exec` for plan reviews, PR reviews, and second
  opinions, with a strong role prompt each time.
