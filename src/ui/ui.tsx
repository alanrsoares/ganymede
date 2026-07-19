// Declarative chrome (HUD, control panel, scoreboard) built with React,
// styled with Tailwind utilities. The canvas + render loop stay imperative in
// main.ts; this module only owns the reactive DOM around them. HUD lines are
// Signals the loop writes each frame — each memoized leaf subscribes to
// exactly the field(s) it renders, so a per-frame `score.val =` re-renders
// only that leaf (matching the granularity of the original VanJS bound
// nodes, ported 1:1 from ui.ts).

import {
  type CSSProperties,
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { AstryxRoot } from "~/astryx";
import { hullSilhouettePath } from "~/hull/silhouette";
import { type Signal, signal, useSignal } from "~/ui/signal";
import type { LightCycle } from "~/world";
import { carriesMissiles } from "~/world/tuning";
import { rgbCss } from "./shipStats";

// Sonic-Wings-style life stock: a row of little hull-silhouette icons in the
// pilot's colour, one per remaining life, with a "×N" overflow past MAX.
const MAX_LIFE_ICONS = 6;
// Fallback silhouette (a delta) when there's no pilot to read a hull from.
const FALLBACK_HULL = "M12 2 L21 21 L12 16.5 L3 21 Z";

const ShipIcon = ({ color, hull }: { color: string; hull: string }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d={hull}
      fill={color}
      style={{ filter: `drop-shadow(0 0 2px ${color})` }}
    />
  </svg>
);

const LivesStrip = memo(function LivesStrip({
  lives,
  ship,
}: {
  lives: Signal<number | null>;
  ship: Signal<LightCycle | null>;
}) {
  const livesVal = useSignal(lives);
  const shipVal = useSignal(ship);
  const n = livesVal ?? 0;
  const color = shipVal ? rgbCss(shipVal.color) : "#3fd8ff";
  const hull = shipVal ? hullSilhouettePath(shipVal.archetype) : FALLBACK_HULL;
  return (
    <div
      className={`mt-1.5 items-center gap-1 ${livesVal == null ? "hidden" : "flex"}`}
    >
      <div className="flex items-center gap-1">
        {Array.from({ length: Math.min(n, MAX_LIFE_ICONS) }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length lives strip, icon position is the identity
          <ShipIcon key={i} color={color} hull={hull} />
        ))}
        {n > MAX_LIFE_ICONS ? (
          <span
            className="ml-0.5 text-[11px] font-semibold tabular-nums"
            style={{ color }}
          >
            ×{n}
          </span>
        ) : null}
      </div>
    </div>
  );
});

export interface UiConfig {
  /** Teams for the scoreboard: display name + CSS color. */
  teams: readonly { name: string; css: string }[];
  onTempo: (v: number) => void; // sim generations per second
  onReinforce: (v: number) => void; // reinforcement spawn rate
}

/** Reactive handles the render loop writes into. */
export interface Ui {
  status: Signal<string>;
  score: Signal<Readonly<Record<string, number>>>;
  counts: Signal<Readonly<Record<string, number>>>; // living ships per team
  hpOn: Signal<boolean>;
  banner: Signal<string>; // center win/draw banner ("" = hidden)
  activeTeamCount: Signal<number>; // scoreboard shows only the first N teams
  hudTitle: Signal<string>; // HUD heading — "Autobattle" / "Arcade"
  arcadeLives: Signal<number | null>; // life stock strip (null = not arcade)
  showError: (message: string) => void;
  controlledShip: Signal<LightCycle | null>;
  // Hide/show the persistent chrome (HUD, scoreboard, controls) — used to keep
  // the welcome splash clean. Errors stay visible regardless.
  setChromeHidden: (hidden: boolean) => void;
  // Hide the sim-tuning knobs (tempo/reinforce). In arcade these are fixed by
  // the wave phase, so the player doesn't get to tune them.
  setSimKnobsHidden: (hidden: boolean) => void;
}

const HUD_LIVE = "mt-1 text-[12px] text-[#a9e8d6]";
const CYAN = "#3fd8ff";

interface KnobRange {
  min: number;
  max: number;
  step: number;
  value: number;
}

const HudTitle = memo(function HudTitle({ title }: { title: Signal<string> }) {
  const val = useSignal(title);
  return (
    <h1 className="text-[14px] font-semibold uppercase tracking-[0.08em] text-[#d3f5e9]">
      {val}
    </h1>
  );
});

const HudStatus = memo(function HudStatus({
  status,
}: {
  status: Signal<string>;
}) {
  const val = useSignal(status);
  return <p className={HUD_LIVE}>{val}</p>;
});

const Hud = ({
  title,
  status,
  arcadeLives,
  controlledShip,
}: {
  title: Signal<string>;
  status: Signal<string>;
  arcadeLives: Signal<number | null>;
  controlledShip: Signal<LightCycle | null>;
}) => (
  <div className="hud-status pointer-events-none absolute right-4 top-4 max-w-[430px] text-left font-mono [text-shadow:0_0_8px_#04070a]">
    <HudTitle title={title} />
    <HudStatus status={status} />
    <LivesStrip lives={arcadeLives} ship={controlledShip} />
  </div>
);

const GRID = "grid grid-cols-[auto_1fr_auto] items-center gap-x-2.5 gap-y-1.5";

// A labelled range with a live value readout. `shown` is purely local render
// state (the readout text) — never written from outside, so it stays a plain
// useState instead of a Signal.
const Knob = ({
  id,
  text,
  attrs,
  on,
  format,
  accent,
}: {
  id: string;
  text: string;
  attrs: KnobRange;
  on: (v: number) => void;
  format: (v: number) => string;
  accent: string;
}) => {
  const [shown, setShown] = useState(() => format(attrs.value));
  return (
    <>
      <label
        htmlFor={id}
        className="justify-self-end tracking-[0.04em] opacity-[0.85]"
      >
        {text}
      </label>
      <input
        id={id}
        type="range"
        min={attrs.min}
        max={attrs.max}
        step={attrs.step}
        defaultValue={attrs.value}
        aria-valuetext={shown}
        className="w-[128px] cursor-pointer rounded-full outline-none [touch-action:manipulation] [-webkit-tap-highlight-color:transparent] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[#040a0e]"
        style={
          {
            accentColor: accent,
            "--tw-ring-color": accent,
          } as CSSProperties
        }
        onInput={(e) => {
          const v = Number((e.target as HTMLInputElement).value);
          setShown(format(v));
          on(v);
        }}
      />
      <span className="min-w-[54px] text-right tabular-nums opacity-70">
        {shown}
      </span>
    </>
  );
};

// A labelled on/off switch sharing the knob grid (label | switch | status).
// Reads exactly one field (`state`), so a hpOn.val flip re-renders only this
// leaf.
const Toggle = memo(function Toggle({
  id,
  text,
  state,
  accent,
}: {
  id: string;
  text: string;
  state: Signal<boolean>;
  accent: string;
}) {
  const val = useSignal(state);
  return (
    <>
      <label
        htmlFor={id}
        className="justify-self-end tracking-[0.04em] opacity-[0.85]"
      >
        {text}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={val}
        className={`w-[128px] cursor-pointer rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] [touch-action:manipulation] transition-colors ${val ? "text-[#040a0e]" : "text-[#8fe6ff] opacity-70"}`}
        style={
          val
            ? { background: accent, borderColor: accent }
            : { borderColor: `${accent}66` }
        }
        onClick={() => {
          state.val = !state.val;
        }}
      >
        {val ? "shown" : "hidden"}
      </button>
      <span className="min-w-[54px] text-right tabular-nums opacity-70">
        {val ? "on" : "off"}
      </span>
    </>
  );
});

// Score-gain feedback: a "+N" that pops on a team's row when it scores. The
// sim hands us a fresh score object each tick, so this effect fires per tick
// (not per frame); each bump self-clears after the pop animation. Mirrors the
// van.derive original 1:1, just subscribing to the score Signal instead of
// being tracked automatically.
type ScoreBump = Signal<Readonly<Record<string, number>>>;

// Clear one team's bump after the scorePop animation window (van's setTimeout 1:1).
const scheduleBumpClear = (bump: ScoreBump, name: string) => {
  setTimeout(() => {
    const b = { ...bump.val };
    delete b[name];
    bump.val = b;
  }, 1000);
};

// One score-notification pass: diff vs previous, stamp positive deltas, schedule clears.
const applyScoreBump = (
  score: ScoreBump,
  teams: readonly { name: string }[],
  prevScore: Record<string, number>,
  bump: ScoreBump,
): Record<string, number> => {
  const s = score.val;
  const next = { ...bump.val };
  let changed = false;
  for (const t of teams) {
    const delta = (s[t.name] ?? 0) - (prevScore[t.name] ?? 0);
    if (delta > 0) {
      next[t.name] = delta;
      changed = true;
      scheduleBumpClear(bump, t.name);
    }
  }
  if (changed) bump.val = next;
  return { ...s };
};

const useScoreBump = (
  score: ScoreBump,
  teams: readonly { name: string }[],
): ScoreBump => {
  const bump = useMemo(() => signal<Readonly<Record<string, number>>>({}), []);
  const prevScoreRef = useRef<Record<string, number>>({});
  useEffect(
    () =>
      score.subscribe(() => {
        prevScoreRef.current = applyScoreBump(
          score,
          teams,
          prevScoreRef.current,
          bump,
        );
      }),
    [score, teams, bump],
  );
  return bump;
};

// The scorePop keyframe animation is shared by the scoreboard bump and the
// win/draw banner; inject it once as a global stylesheet rule.
const injectScorePopStyle = () => {
  const popStyle = document.createElement("style");
  popStyle.textContent =
    "@keyframes scorePop{0%{opacity:0;transform:translateY(4px) scale(.8)}15%{opacity:1;transform:translateY(0) scale(1.15)}100%{opacity:0;transform:translateY(-12px) scale(1)}}";
  document.head.appendChild(popStyle);
};

// Sim-tuning knobs (tempo/reinforce). Hidden in arcade — there the stage/wave
// sets tempo and spawns, so the player never tunes them. Reads exactly one
// field (`simKnobsHidden`).
const SimKnobs = memo(function SimKnobs({
  cfg,
  simKnobsHidden,
}: {
  cfg: UiConfig;
  simKnobsHidden: Signal<boolean>;
}) {
  const hidden = useSignal(simKnobsHidden);
  return (
    <div className={hidden ? "hidden" : GRID}>
      <Knob
        id="k-tempo"
        text="tempo"
        attrs={{ min: 10, max: 90, step: 1, value: 45 }}
        on={cfg.onTempo}
        format={(v) => `${v} gen/s`}
        accent={CYAN}
      />
      <Knob
        id="k-reinforce"
        text="reinforce"
        attrs={{ min: 0, max: 10, step: 1, value: 3 }}
        on={cfg.onReinforce}
        format={(v) => (v === 0 ? "off" : `${v}/rate`)}
        accent={CYAN}
      />
    </div>
  );
});

const Controls = ({
  cfg,
  hpOn,
  simKnobsHidden,
}: {
  cfg: UiConfig;
  hpOn: Signal<boolean>;
  simKnobsHidden: Signal<boolean>;
}) => {
  const [controlsOpen, setControlsOpen] = useState(true);
  return (
    <div className="hud-controls absolute bottom-4 left-4 rounded-lg border border-[#3fd8ff]/25 bg-[#040a0e]/75 px-3.5 py-3 font-mono text-[11px] text-[#8fe6ff] [touch-action:manipulation] backdrop-blur-[4px]">
      <div
        className={`flex items-center justify-between gap-3 ${controlsOpen ? "mb-2" : ""}`}
      >
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#d3f5e9]">
          controls
        </span>
        <button
          type="button"
          className="cursor-pointer rounded border border-[#3fd8ff]/30 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-[#8fe6ff] transition-colors hover:bg-[#3fd8ff]/10"
          aria-expanded={controlsOpen}
          aria-controls="controls-body"
          onClick={() => setControlsOpen((o) => !o)}
        >
          {controlsOpen ? "▾" : "▸"}
        </button>
      </div>
      <div
        id="controls-body"
        className={controlsOpen ? "flex flex-col gap-y-1.5" : "hidden"}
      >
        <SimKnobs cfg={cfg} simKnobsHidden={simKnobsHidden} />
        <div className={GRID}>
          <Toggle id="k-hp" text="hp bars" state={hpOn} accent={CYAN} />
        </div>
      </div>
    </div>
  );
};

const ErrorBox = memo(function ErrorBox({ error }: { error: Signal<string> }) {
  const val = useSignal(error);
  return (
    <div
      className={`absolute inset-0 place-items-center p-6 text-center text-[14px] text-[#f0a0a0] ${
        val ? "grid" : "hidden"
      }`}
    >
      {val}
    </div>
  );
});

type Team = { name: string; css: string };

// Team-tinted fill that grows with the team's share of the leader's score, so
// the row itself reads as a bar — relative standings without a separate gauge.
const RowFill = ({ css, frac }: { css: string; frac: number }) => (
  <div
    className="pointer-events-none absolute inset-y-0 left-0 rounded"
    style={{
      width: `${(frac * 100).toFixed(1)}%`,
      background: `linear-gradient(90deg,${css}33,${css}08)`,
    }}
  />
);

// Left cluster: rank · dot · name · living-ship count (count turns red at 0).
const RowLeft = ({
  t,
  rank,
  n,
  dead,
}: {
  t: Team;
  rank: number;
  n: number;
  dead: boolean;
}) => (
  <span className="relative flex items-center gap-1.5">
    <span className="w-3 text-right text-[9px] tabular-nums opacity-40">
      {rank + 1}
    </span>
    <span
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{ background: t.css, boxShadow: `0 0 6px ${t.css}` }}
    />
    <span className="uppercase tracking-[0.12em]" style={{ color: t.css }}>
      {t.name}
    </span>
    <span
      className={`tabular-nums text-[9px] ${dead ? "text-[#ff8a8a] opacity-90" : "opacity-55"}`}
    >
      ×{n}
    </span>
  </span>
);

// Right cluster: floating "+N" bump when a team just scored, plus the total
// (leader's total is brighter and larger).
const RowRight = ({
  val,
  bump,
  leader,
}: {
  val: number;
  bump: number | undefined;
  leader: boolean;
}) => (
  <span className="relative flex items-center gap-1.5">
    {bump ? (
      <span
        className="tabular-nums font-bold text-[#7fe6a2]"
        style={{
          animation: "scorePop 1s ease-out forwards",
          textShadow: "0 0 6px #2c7d5f",
        }}
      >
        +{bump}
      </span>
    ) : null}
    <span
      className={`tabular-nums font-bold ${leader ? "text-[13px] text-[#ffe9a6] [text-shadow:0_0_8px_#ffb83f66]" : "text-[#ffe08a]"}`}
    >
      {val}
    </span>
  </span>
);

// A single scoreboard row, doubling as a relative-score bar. Leader (rank 0
// with points) gets a colour edge accent; eliminated teams (0 ships) dim out.
const TeamRow = ({
  t,
  s,
  b,
  c,
  rank,
  maxScore,
}: {
  t: Team;
  s: Readonly<Record<string, number>>;
  b: Readonly<Record<string, number>>;
  c: Readonly<Record<string, number>>;
  rank: number;
  maxScore: number;
}) => {
  const n = c[t.name] ?? 0;
  const val = s[t.name] ?? 0;
  const dead = n === 0;
  const leader = rank === 0 && val > 0;
  return (
    <div
      className={`relative flex items-center justify-between gap-3 overflow-hidden rounded px-1.5 py-1 ${dead ? "opacity-40" : ""}`}
      style={leader ? { boxShadow: `inset 2px 0 0 ${t.css}` } : undefined}
    >
      <RowFill css={t.css} frac={maxScore > 0 ? val / maxScore : 0} />
      <RowLeft t={t} rank={rank} n={n} dead={dead} />
      <RowRight val={val} bump={b[t.name]} leader={leader} />
    </div>
  );
};

// Per-team scoreboard rows, sorted by score (leader on top), scoped to the
// active teams (first N — the match may run fewer than the full roster). Van
// bundled score/bump/counts/activeTeamCount into a single derive here (the
// same bound node), so this leaf reads all four — no special-casing.
const ScoreRows = memo(function ScoreRows({
  teams,
  score,
  bump,
  counts,
  activeTeamCount,
}: {
  teams: readonly Team[];
  score: Signal<Readonly<Record<string, number>>>;
  bump: Signal<Readonly<Record<string, number>>>;
  counts: Signal<Readonly<Record<string, number>>>;
  activeTeamCount: Signal<number>;
}) {
  const s = useSignal(score);
  const b = useSignal(bump);
  const c = useSignal(counts);
  const activeCount = useSignal(activeTeamCount);
  const ranked = teams
    .slice(0, activeCount)
    .sort((a, b2) => (s[b2.name] ?? 0) - (s[a.name] ?? 0));
  const maxScore = ranked.reduce((m, t) => Math.max(m, s[t.name] ?? 0), 0);
  return (
    <div className="flex flex-col gap-1">
      {ranked.map((t, i) => (
        <TeamRow
          key={t.name}
          t={t}
          s={s}
          b={b}
          c={c}
          rank={i}
          maxScore={maxScore}
        />
      ))}
    </div>
  );
});

const ScoreBox = ({
  cfg,
  score,
  bump,
  counts,
  activeTeamCount,
}: {
  cfg: UiConfig;
  score: Signal<Readonly<Record<string, number>>>;
  bump: Signal<Readonly<Record<string, number>>>;
  counts: Signal<Readonly<Record<string, number>>>;
  activeTeamCount: Signal<number>;
}) => {
  const [scoreOpen, setScoreOpen] = useState(true);
  return (
    <div className="hud-score absolute left-1/2 top-3 min-w-[216px] -translate-x-1/2 rounded-lg border border-[#3fd8ff]/20 bg-[#040a0e]/70 px-2.5 py-2 font-mono text-[11px] [text-shadow:0_0_8px_#04070a] backdrop-blur-[3px]">
      <div
        className={`flex items-center justify-between gap-3 ${scoreOpen ? "mb-1" : ""}`}
      >
        <span className="text-[9px] font-semibold uppercase tracking-[0.32em] text-[#7fc4b1]">
          scoreboard
        </span>
        <button
          type="button"
          aria-label="Toggle scoreboard"
          className="cursor-pointer rounded border border-[#3fd8ff]/30 px-2 py-1 text-[10px] leading-none uppercase tracking-[0.1em] text-[#8fe6ff] transition-colors hover:bg-[#3fd8ff]/10 [touch-action:manipulation]"
          aria-expanded={scoreOpen}
          onClick={() => setScoreOpen((o) => !o)}
        >
          {scoreOpen ? "▾" : "▸"}
        </button>
      </div>
      {scoreOpen ? (
        <ScoreRows
          teams={cfg.teams}
          score={score}
          bump={bump}
          counts={counts}
          activeTeamCount={activeTeamCount}
        />
      ) : (
        <div />
      )}
    </div>
  );
};

// Center win/draw banner, shown when `banner` is non-empty.
const Banner = memo(function Banner({ banner }: { banner: Signal<string> }) {
  const val = useSignal(banner);
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 top-1/3 text-center font-mono ${
        val ? "block" : "hidden"
      }`}
    >
      <span
        className="inline-block rounded-xl border border-[#3fd8ff]/40 bg-[#040a0e]/80 px-8 py-4 text-[28px] font-bold uppercase tracking-[0.2em] text-[#d3f5e9] [text-shadow:0_0_16px_#3fd8ff] backdrop-blur-[4px]"
        style={{ animation: "scorePop 0.5s ease-out" }}
      >
        {val}
      </span>
    </div>
  );
});

const ManualHeader = ({ s }: { s: LightCycle }) => {
  const archetypeLabel = s.archetype.toUpperCase();
  const levelLabel = `L${s.level}`;
  return (
    <div className="flex justify-between items-center border-b border-[#ffb83f]/20 pb-1">
      <span className="font-bold text-[12px] uppercase text-[#ffc66d]">
        🎮 CONTROL: {archetypeLabel} {levelLabel}
      </span>
    </div>
  );
};

const ManualStats = ({ s }: { s: LightCycle }) => {
  const hpPercent = Math.round((s.hp / s.maxHp) * 100);
  const shieldPercent =
    s.maxShield > 0 ? Math.round((s.shield / s.maxShield) * 100) : 0;
  const fuelPercent = Math.round((s.fuel / s.maxFuel) * 100);
  const ammoMines = s.mines;
  return (
    <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] opacity-90">
      <span>
        HULL: {s.hp.toFixed(1)}/{s.maxHp} ({hpPercent}%)
      </span>
      <span>
        SHIELD: {s.shield.toFixed(1)}/{s.maxShield} ({shieldPercent}%)
      </span>
      <span>
        FUEL: {Math.round(s.fuel)}/{s.maxFuel} ({fuelPercent}%)
      </span>
      <span>
        MINES: {ammoMines}/{s.maxMines}
      </span>
    </div>
  );
};

const ActionRow = ({
  keyLabel,
  label,
  status,
}: {
  keyLabel: string;
  label: string;
  status: string;
}) => (
  <div className="flex justify-between items-center">
    <span className="text-[#ffd866]">
      [{keyLabel}] {label}
    </span>
    <span className="opacity-75">{status}</span>
  </div>
);

const ManualActions = ({ s }: { s: LightCycle }) => {
  const bulletStatus =
    s.fireCooldown <= 0 ? "Ready" : `Reloading (${Math.ceil(s.fireCooldown)}g)`;
  const mineStatus = s.mines > 0 ? `Ready (${s.mines})` : "No Ammo";
  const missileStatus =
    s.level >= 3 || carriesMissiles(s.archetype)
      ? s.fuel > 150
        ? "Ready (150 F)"
        : "Low Fuel"
      : "Requires L3";
  const boostStatus = s.fuel > 200 ? "Ready (200 F)" : "Low Fuel";
  const shieldStatus = s.fuel > 300 ? "Ready (300 F)" : "Low Fuel";
  const cloakStatus = s.fuel > 400 ? "Ready (400 F)" : "Low Fuel";
  const fieldStatus = s.fuel > 300 ? "Ready (300 F)" : "Low Fuel";

  return (
    <div className="mt-1 flex flex-col gap-1 border-t border-[#ffb83f]/10 pt-1.5">
      <div className="text-[9px] uppercase tracking-wider text-[#ffb83f]/60 font-semibold">
        quick actions
      </div>
      <ActionRow keyLabel="Space" label="Fire Blasters" status={bulletStatus} />
      <ActionRow keyLabel="2" label="Drop Mine" status={mineStatus} />
      <ActionRow keyLabel="3" label="Homing Missile" status={missileStatus} />
      <ActionRow keyLabel="4" label="Nitro Boost" status={boostStatus} />
      <ActionRow keyLabel="5" label="Shield Recharge" status={shieldStatus} />
      <ActionRow keyLabel="6" label="Cloak Device" status={cloakStatus} />
      <ActionRow keyLabel="7" label="Force Field" status={fieldStatus} />
      <div className="text-[9px] italic opacity-60 text-center mt-1.5">
        WASD/ARROWS to move. Click empty space to exit.
      </div>
    </div>
  );
};

// Manual control HUD panel shown when a ship is under player control. Reads
// exactly one field (`controlledShip`) — van's original derive read the same
// single state.
const ManualPanel = memo(function ManualPanel({
  controlledShip,
}: {
  controlledShip: Signal<LightCycle | null>;
}) {
  const s = useSignal(controlledShip);
  return (
    <div
      className={`hud-manual absolute bottom-4 right-4 rounded-lg border border-[#ffb83f]/20 bg-[#040a0e]/85 px-4 py-3 font-mono text-[11px] text-[#ffe08a] backdrop-blur-[4px] transition-opacity duration-200 ${s ? "opacity-100 block" : "opacity-0 hidden"}`}
      style={{
        width: 270,
        boxShadow: "0 0 15px rgba(255, 184, 63, 0.15)",
        pointerEvents: "none",
      }}
    >
      {s ? (
        <div className="flex flex-col gap-1.5">
          <ManualHeader s={s} />
          <ManualStats s={s} />
          <ManualActions s={s} />
        </div>
      ) : (
        <div />
      )}
    </div>
  );
});

const HelpRow = ({ keys, action }: { keys: string; action: string }) => (
  <div className="flex justify-between items-start gap-4 text-[10px]">
    <span className="text-[#8fe6ff]/80 font-bold whitespace-nowrap">
      {keys}
    </span>
    <span className="text-[#d3f5e9]/70 text-right">{action}</span>
  </div>
);

const HelpSection = ({
  title,
  rows,
}: {
  title: string;
  rows: { keys: string; action: string }[];
}) => (
  <div className="flex flex-col gap-1">
    <div className="text-[9px] uppercase tracking-wider text-[#3fd8ff]/60 font-semibold border-b border-[#3fd8ff]/10 pb-0.5 mb-0.5">
      {title}
    </div>
    {rows.map((r) => (
      <HelpRow key={r.keys} keys={r.keys} action={r.action} />
    ))}
  </div>
);

const ControlsInfoPanel = () => {
  const [open, setOpen] = useState(false);

  return (
    <div
      className="hud-guide absolute top-12 left-4 rounded-lg border border-[#3fd8ff]/20 bg-[#040a0e]/75 px-3 py-2 font-mono text-[11px] backdrop-blur-[4px]"
      style={{ boxShadow: "0 0 15px rgba(63, 216, 255, 0.1)", zIndex: 10 }}
    >
      <div className="flex items-center justify-between gap-4">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#d3f5e9]">
          ⌨️ GUIDE
        </span>
        <button
          type="button"
          className="cursor-pointer rounded border border-[#3fd8ff]/30 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-[#8fe6ff] transition-colors hover:bg-[#3fd8ff]/10"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "▾" : "▸"}
        </button>
      </div>
      <div
        className={`${open ? "flex" : "hidden"} flex-col gap-3 mt-2 border-t border-[#3fd8ff]/20 pt-2`}
        style={{ width: 230 }}
      >
        <HelpSection
          title="Flight Controls"
          rows={[
            { keys: "WASD / Arrows", action: "Steer Ship" },
            { keys: "Space", action: "Fire Blasters" },
            { keys: "1 - 7", action: "Quick Actions" },
          ]}
        />
        <HelpSection
          title="General Hotkeys"
          rows={[
            { keys: "C", action: "Toggle Codex" },
            { keys: "H", action: "Toggle HP Bars" },
            { keys: "Z / X", action: "Reinforcements" },
          ]}
        />
        <HelpSection
          title="Mouse Actions"
          rows={[
            { keys: "Click Ship", action: "Manual Control" },
            { keys: "Click Void", action: "Spawn / Exit" },
            { keys: "Shift+Click", action: "Rally Beacon" },
          ]}
        />
      </div>
    </div>
  );
};

// Hide/show the persistent chrome as one gated subtree. A plain block wrapper
// around absolutely-positioned children occupies no visible space of its own
// (they're out of flow), so this is a no-op on layout when shown and matches
// the original's per-element `style.display = "none"` when hidden. Reads
// exactly one field (`chromeHidden`).
const ChromeGate = memo(function ChromeGate({
  hidden: hiddenSignal,
  children,
}: {
  hidden: Signal<boolean>;
  children: ReactNode;
}) {
  const hidden = useSignal(hiddenSignal);
  return <div style={hidden ? { display: "none" } : undefined}>{children}</div>;
});

const View = ({
  cfg,
  status,
  score,
  error,
  hpOn,
  banner,
  counts,
  activeTeamCount,
  hudTitle,
  arcadeLives,
  controlledShip,
  chromeHidden,
  simKnobsHidden,
}: {
  cfg: UiConfig;
  status: Signal<string>;
  score: Signal<Readonly<Record<string, number>>>;
  error: Signal<string>;
  hpOn: Signal<boolean>;
  banner: Signal<string>;
  counts: Signal<Readonly<Record<string, number>>>;
  activeTeamCount: Signal<number>;
  hudTitle: Signal<string>;
  arcadeLives: Signal<number | null>;
  controlledShip: Signal<LightCycle | null>;
  chromeHidden: Signal<boolean>;
  simKnobsHidden: Signal<boolean>;
}) => {
  const bump = useScoreBump(score, cfg.teams);
  return (
    <>
      <ChromeGate hidden={chromeHidden}>
        <Hud
          title={hudTitle}
          status={status}
          arcadeLives={arcadeLives}
          controlledShip={controlledShip}
        />
        <Controls cfg={cfg} hpOn={hpOn} simKnobsHidden={simKnobsHidden} />
        <ScoreBox
          cfg={cfg}
          score={score}
          bump={bump}
          counts={counts}
          activeTeamCount={activeTeamCount}
        />
        <Banner banner={banner} />
        <ManualPanel controlledShip={controlledShip} />
        <ControlsInfoPanel />
      </ChromeGate>
      <ErrorBox error={error} />
    </>
  );
};

export const mountUi = (cfg: UiConfig): Ui => {
  const status = signal("");
  const score = signal<Readonly<Record<string, number>>>({});
  const error = signal("");
  const hpOn = signal(true);
  const banner = signal("");
  const counts = signal<Readonly<Record<string, number>>>({});
  const activeTeamCount = signal(cfg.teams.length);
  const hudTitle = signal("Autobattle");
  const arcadeLives = signal<number | null>(null);
  const controlledShip = signal<LightCycle | null>(null);
  const chromeHidden = signal(false);
  const simKnobsHidden = signal(false);

  injectScorePopStyle();

  const container = document.createElement("div");
  document.body.appendChild(container);
  createRoot(container).render(
    <AstryxRoot>
      <View
        cfg={cfg}
        status={status}
        score={score}
        error={error}
        hpOn={hpOn}
        banner={banner}
        counts={counts}
        activeTeamCount={activeTeamCount}
        hudTitle={hudTitle}
        arcadeLives={arcadeLives}
        controlledShip={controlledShip}
        chromeHidden={chromeHidden}
        simKnobsHidden={simKnobsHidden}
      />
    </AstryxRoot>,
  );

  return {
    status,
    score,
    counts,
    hpOn,
    banner,
    activeTeamCount,
    hudTitle,
    arcadeLives,
    controlledShip,
    showError: (message) => {
      error.val = message;
    },
    setChromeHidden: (hidden) => {
      chromeHidden.val = hidden;
    },
    setSimKnobsHidden: (hidden) => {
      simKnobsHidden.val = hidden;
    },
  };
};
