<div align="center">

# Ganymede

**A deterministic WebGPU space autobattler.**
Four AI fleets flock, fight, and raid each other's bases around a central
gravity well — or take the stick and fly one ship through escalating waves.

[![Play](https://img.shields.io/badge/▶%20play-live-3fd8ff?style=for-the-badge)](https://alanrsoares.github.io/ganymede/)
&nbsp;
[![Deploy](https://github.com/alanrsoares/ganymede/actions/workflows/deploy.yml/badge.svg)](https://github.com/alanrsoares/ganymede/actions/workflows/deploy.yml)
[![Bun](https://img.shields.io/badge/Bun-1.3-fbf0df?logo=bun&logoColor=black)](https://bun.com)
[![WebGPU](https://img.shields.io/badge/WebGPU-enabled-005a9c)](https://caniuse.com/webgpu)

<img src="docs/hero.png" alt="Ganymede — four AI fleets battling around the central gravity well" width="820" />

</div>

> Needs a WebGPU browser: Chrome/Edge 113+, or Safari 18+.

## Modes

- **Autobattle** — up to 4 AI teams flock and fight to the last base. Tune tempo
  and reinforcement rate live; click a ship to take control, or set a rally point.
- **Arcade** — pilot a single ship, survive escalating enemy waves, chase a high
  score. Pick a hull and a difficulty (Easy / Normal / Hard / Endless); the stage
  sets spawn pressure and lives.

## Controls

| Input | Action |
|-------|--------|
| Click a ship | Take manual control |
| `W` `A` `S` `D` / arrows | Steer the controlled ship |
| `Space` | Boost |
| `1`–`7` | Weapon / ability actions |
| Right-click / Shift-click | Set a team rally point (autobattle) |
| Click empty space | Deselect, or drop a ship |
| `Z` / `X` | Launch reinforcements |
| `H` | Toggle HP bars |
| `M` | Mute / unmute audio |
| `C` | Codex (pauses the game) |

## Ship classes

Four hulls, each on its own stat and weapon path:

| Hull | Class | Role | Weapon |
|:---:|-------|------|--------|
| <img src="docs/hulls/scout.png" alt="Scout hull" width="48" /> | **Scout** | Fastest, fragile; shares base-raid progress with allies | `vulcan` |
| <img src="docs/hulls/fighter.png" alt="Fighter hull" width="48" /> | **Fighter** | Balanced gunner; extra barrel at max level | `vulcan` |
| <img src="docs/hulls/heavy.png" alt="Heavy hull" width="48" /> | **Heavy** | Tank; drops mines and seeking missiles at rank | `proton` |
| <img src="docs/hulls/interceptor.png" alt="Interceptor hull" width="48" /> | **Interceptor** | Nimble; hit-and-run | `plasma` |

Combat runs on a counter-web — each class beats the next:

<p align="center">
  <img src="docs/hulls/scout.png" alt="Scout" width="40" /> →
  <img src="docs/hulls/interceptor.png" alt="Interceptor" width="40" /> →
  <img src="docs/hulls/heavy.png" alt="Heavy" width="40" /> →
  <img src="docs/hulls/fighter.png" alt="Fighter" width="40" /> →
  <img src="docs/hulls/scout.png" alt="Scout" width="40" />
</p>

A ship that counters its target rams harder and presses in; a countered ship
chips lightly and holds off.

## Audio

Sound is driven straight off the pure sim — every combat `Burst` the world
already emits (muzzle, explosion, EMP, …) becomes a voice, so audio needs no
state of its own and stays deterministic. Marquee hits play small pre-baked OGG
samples; the dense cheap ones (muzzle, impact) are synthesised live so a
firefight never thrashes the sample voices. A three-scene synthwave soundtrack
(menu / battle / arcade) crossfades on game state and seam-crossfades its own
loop. The corner **mixer** (🎚️) sets master / music / SFX faders + mute; every
choice persists.

- **SFX** are procedural — regenerate with `bun run scripts/gen-audio.ts`
  (needs `ffmpeg`).
- **Music** tracks are instrumental synthwave rendered offline with
  [ACE-Step](https://github.com/ace-step/ACE-Step), then trimmed to
  `src/assets/audio/music/*.ogg`. `scripts/gen-music.ts` is a dependency-free
  procedural fallback.

## Develop

Requires [Bun](https://bun.com) (≥ 1.3).

```bash
bun install
bun run web        # dev server with HMR at http://localhost:3000
bun test           # sim characterization tests
bun run check      # biome lint + tsc typecheck
bun run hero       # recapture docs/hero.png from a live Autobattle (needs the dev server)
```

## Build & deploy

```bash
bun run build      # bundle (HTML + Tailwind + assets) → dist/
bun run deploy     # build, then force-push dist/ to the gh-pages branch
```

Pushing to `main` also auto-builds and deploys via
[`deploy.yml`](.github/workflows/deploy.yml) (GitHub Pages). `bun run deploy` is
the manual fallback.

## Architecture

The simulation is a pure, seeded, Elm-style state machine — `update(msg, world)`
returns a new immutable `World`; no `Date.now()` or `Math.random()` inside it, so
runs are fully deterministic and testable.

| Path | Responsibility |
|------|----------------|
| `src/world/` | The sim: `update`, per-system tick phases (`tick/*`), steering, tuning, factory |
| `src/overlay/` | Pure view — turns a `World` into GPU instance buffers |
| `src/gpu.ts` | WebGPU renderer (raw WebGPU + `typegpu/data` for buffer layouts) |
| `src/runtime/` | Imperative edges — DOM input and the fixed-timestep loop |

UI chrome is [VanJS](https://vanjs.org); styling is Tailwind v4.
