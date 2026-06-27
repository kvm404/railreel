# RailReel — Design Language: "The Night Train Window"

The visual system. Merged from two independent design explorations. Dark-mode only.
Tokens live in `apps/mobile/src/theme/tokens.ts` — this doc is the *why*; the tokens are the *what*.

## North star

**"A warm cabin rushing through the cold dark — and inside, a theater."**

The brand is a duality: you and your friends are cozy and together (**warm tungsten**) while
the disconnected world streaks past outside (**cold blue-night**). Everything human or
interactive glows amber; the environment is cold glass.

Three motifs, in priority order:

1. **The split-flap departure board** (Solari board) — the signature. Codes, counts, statuses,
   countdowns *flip* into place. Fuses transit + anticipation + the turning of a film reel.
   This is the one element RailReel is remembered by. **Spend the boldness here.**
2. **The night-train window** — motion-blurred light streaks drifting at parallax depths behind
   everything; a cinema vignette; (optional) gyroscopic parallax via device tilt.
3. **Film-strip sprockets** — perforation edges on cards/frames; quiet "this is a strip of
   film" texture, never shouted.

Everything else stays quiet tungsten-on-night so these sing.

## Color

Deep blue-slate night carrying a warm tungsten spine. The cold/warm split *is* the system.

| Token | Hex | Use |
| --- | --- | --- |
| `void` | `#05070C` | deepest layer, behind streaks |
| `base` | `#0A0E16` | primary canvas |
| `raised` | `#121826` | cards ("berths") |
| `overlay` | `#1A2233` | sheets, modals |
| `hairline` | `#28324A` | cool steel 1px borders |
| `text.primary` | `#E9EEF7` | |
| `text.secondary` | `#97A3B8` | |
| `text.tertiary` | `#58647A` | |

**Filament Amber** (warmth, people, primary CTAs): `glow #FFC78A` · `amber #FFB266` ·
`core #FF9B45` · `deep #C76E26`. Text on filled amber = `#1A1206` (deep roast, AA-safe).

**Exterior Cyan** (sync / connection / scanning ONLY — never decorative): `cyan #57D2E6` ·
`deep #2A93A8`. Keeping cyan semantic preserves the warm=human / cold=tech reading.

**Status:** success = amber ignition ("the filament lights"); error/signal-lost `#FF6B5E`
(a warm warning, still in-world).

**Light treatments:** filament glow = radial `amber.glow@40% → transparent` behind CTAs;
window streaks = soft horizontal gradients (cyan + amber, low opacity); cinema vignette =
radial darken to `void` at edges.

## Typography

Transit + cinema voice. All via `@expo-google-fonts`.

- **Display / marquee — `Unbounded`** (600/700): circular signage; logo, hero, countdown. Rare.
- **Body / UI — `Space Grotesk`** (400/500/700): subtle mechanical character; the workhorse.
- **Data / timecode — `Space Mono`** (400/700): codes, timecodes, eyebrows, flap glyphs. Mono =
  departure board + film-slate authenticity. *Data should look like instrumentation.*

| Role | Family / Weight | Size / Line / Tracking |
| --- | --- | --- |
| displayXl (countdown, marquee) | Unbounded 700 | 56 / 60 / −2% |
| displayL (screen hero) | Unbounded 600 | 34 / 38 / −1% |
| title | Space Grotesk 700 | 22 / 28 |
| cardTitle | Space Grotesk 600 | 17 / 22 |
| body | Space Grotesk 400 | 15 / 22 |
| caption | Space Grotesk 500 | 13 / 18 |
| eyebrow | Space Mono 700 | 12 / 16 / +12% · UPPERCASE |
| data | Space Mono 400 | 14 / 18 / +4% |

## Motion

Reanimated 4. Default UI spring `{ stiffness: 200, damping: 22, mass: 1 }`. Expressive
entrances use expo-out `Easing.bezier(0.16, 1, 0.3, 1)`. **All ambient motion stops/simplifies
under reduce-motion.**

- **Split-flap flip (signature):** cell flips top→bottom (rotateX), staggered ~40ms L→R, spring
  `{stiffness:260, damping:18}`; a `selectionAsync` haptic on the final cell. Every state change.
- **Streak ambient:** 3–4 blurred gradient bars looping `translateX` at parallax speeds; high
  intensity on Home, near-still in Player (video is hero).
- **Screen transitions:** horizontal parallax; the streak layer is a *persistent shared element*
  across screens. ~420ms expo-out.
- **Button press:** scale → 0.96 spring, filament glow blooms, `impactAsync(Light)`.
- **Cards appearing:** flip down onto the rail (`translateY(-12)+rotateX(-90→0)`, origin top),
  stagger 60ms, amber underglow pulse + `selectionAsync`.
- **"Everyone's ready" peak:** rings ignite in turn → board flips to **ALL ABOARD** → full-screen
  amber bloom → Start floats up and lights → `notificationAsync(Success)`. The climax.
- **Reactions:** drift up with sinusoidal x-sway, scale-pop, slight rotation, fade at top; 2–3
  decaying ghost trails (projector sparks).
- **Player controls:** ride inside letterbox bars that slide in top & bottom (curtain), ~250ms.

## Signature components

1. **`FlapText`** — the hero. Renders a string as split-flap cells (dark slot, hairline seam,
   Space Mono glyph). Props: `value`, `size`, `cascade`. Powers codes, counts, statuses, LIVE.
2. **`SessionCard`** — departure-board row × ticket stub: avatar in a filament ring, title +
   mono metadata (`DUNE · 2.1GB · 3 aboard`), a `FlapText` status, sprocket edge.
3. **`FilamentRing`** — SVG circular buffer progress drawn as a glowing tungsten filament
   (blurred amber duplicate behind a sharp `amber→core` stroke); **ignites** at 100%.
4. **`WindowAtmosphere`** — ambient backdrop: parallax streaks + vignette (+ optional grain);
   persistent shared element with an `intensity` prop (Home high, Player low).
5. **`InvitePanel`** — QR amber-on-dark inside a film/ticket frame with sprocket edges; join code
   below as large `FlapText`; the "turn on hotspot" step as a glowing toggle.

## Screens (wow moment per screen)

- **Home** — streaks drift; `RAILREEL` flips in letter-by-letter; amber bloom ignites behind
  **Host a session** (amber) above **Join a session** (cyan ghost). Footnote: `NO INTERNET NEEDED`.
- **Create** — movie pick (film-frame thumbnails) → invite panel: join code clatters in,
  hotspot toggle glows when live.
- **Join** — a cyan scan-sweep crosses a live list; found sessions flip onto the rail with haptics.
- **Lobby** — a `FilamentRing` per friend; the 5/5 **ignition sequence**; Start ignites at full.
- **Player** — immersive; tapping the video closes letterbox curtains; amber filament scrubber;
  floating reactions with spark trails; chat as a translucent sheet with mono timestamps.

## "Beyond the limit" (staged)

- **Gyroscopic glass** (ambient, via `expo-sensors`): the window streak planes shift against
  device tilt (far lags, near leads), max ~8px, low-pass filtered, 30fps-capped, off under
  reduce-motion. The phone feels like a pane of glass onto a moving world.
- **Synchronized "lights-down" ritual** (Player/start phase): because the phones are genuinely
  in sync, when the host starts, *every* screen dims and a warm projector beam sweeps at the
  same instant with a shared haptic — a magic beat only this app can do.

## Quality floor

Responsive to small screens; respects reduce-motion; visible focus; AA contrast on text and
controls; haptics are accents, not noise.
