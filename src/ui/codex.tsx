// Ship Codex: a toggle-able full-screen reference for the four class
// archetypes. Unlike the hover inspector (shipCard.ts, which needs a live ship
// under the cursor), this browses all classes at once — comparative stat bars,
// a selectable rank, the rock-paper-scissors counter web, and the shared
// L1→L5 progression tree. Built on the Astryx design system (Dialog shell,
// SegmentedControl rank picker, ProgressBar stat meters, Badge chips, Card
// class tiles) so it re-skins with the theme and matches the other menus. The
// only bespoke art kept as raw SVG: the schematic hull glyphs and the counter
// web diagram. Reads its flavor, stats and traits from the shipStats.ts read
// model, so this view and the hover card can never drift.

import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { IconButton } from "@astryxdesign/core/IconButton";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { AstryxRoot } from "~/astryx";
import { hullSilhouettePath } from "~/hull/silhouette";
import { ARCHETYPES, type Archetype, MAX_LEVEL } from "~/world";
import {
  ARCHETYPE_INFO,
  COUNTERED_BY,
  COUNTERS,
  statsFor,
  TIERS,
} from "./shipStats";

// The codex is team-neutral, so each class gets its own signature accent (the
// hover card tints by team color instead). Chosen to echo each role: green
// runner, cyan backbone, amber tank, pink hunter. `CLASS_TINT` drives the raw
// SVG art; `CLASS_VARIANT` maps the same identity onto Astryx's semantic Card /
// Badge color variants (they ship green/cyan/orange/pink out of the box).
const CLASS_TINT: Record<Archetype, string> = {
  scout: "#7cff9e",
  fighter: "#3fd8ff",
  heavy: "#ffb545",
  interceptor: "#ff6fae",
};

const cap = (a: string) => a[0].toUpperCase() + a.slice(1);

type ClassVariant = "green" | "cyan" | "orange" | "pink";
const CLASS_VARIANT: Record<Archetype, ClassVariant> = {
  scout: "green",
  fighter: "cyan",
  heavy: "orange",
  interceptor: "pink",
};

// --- Store bridge -----------------------------------------------------------
// The imperative game loop reads `isOpen()` synchronously (to freeze the sim)
// and drives visibility (`toggle`/`close`/`setHidden`), while React subscribes
// via `useSyncExternalStore`. Two flags: `open` (panel up) and `hidden` (opener
// chrome suppressed under the welcome splash). Mirrors the drydock store.
interface CodexStore {
  getOpen: () => boolean;
  getHidden: () => boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setHidden: (hidden: boolean) => void;
  subscribe: (cb: () => void) => () => void;
}

const createCodexStore = (): CodexStore => {
  let open = false;
  let hidden = false;
  const subs = new Set<() => void>();
  const emit = () => {
    for (const cb of subs) cb();
  };
  return {
    getOpen: () => open,
    getHidden: () => hidden,
    open: () => {
      if (!open) {
        open = true;
        emit();
      }
    },
    close: () => {
      if (open) {
        open = false;
        emit();
      }
    },
    toggle: () => {
      open = !open;
      emit();
    },
    setHidden: (h) => {
      hidden = h;
      if (h) open = false;
      emit();
    },
    subscribe: (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
};

// --- Ship glyph badge (raw SVG, kept) ---------------------------------------
// A glyph is a schematic top-down hull (nose up) in a 24×24 viewBox: `hull` is
// the filled silhouette, `detail` the lighter accent strokes. Bracketed by four
// corner ticks in the class tint for a blueprint read.
const CORNERS = [
  "left-0 top-0 border-l border-t",
  "right-0 top-0 border-r border-t",
  "bottom-0 left-0 border-b border-l",
  "bottom-0 right-0 border-b border-r",
];

const GlyphBadge = ({ a, tint }: { a: Archetype; tint: string }) => {
  const hull = useMemo(() => hullSilhouettePath(a), [a]);
  return (
    <div className="relative grid h-11 w-11 shrink-0 place-items-center rounded bg-white/[0.03]">
      {CORNERS.map((edges) => (
        <span
          key={edges}
          className={`absolute h-2 w-2 ${edges}`}
          style={{ borderColor: tint }}
        />
      ))}
      <svg
        viewBox="0 0 24 24"
        className="h-7 w-7"
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d={hull} fill={`${tint}26`} stroke={tint} strokeWidth="1.4" />
      </svg>
    </div>
  );
};

// --- Class card -------------------------------------------------------------
// Segmented telemetry gauge, now an Astryx ProgressBar per axis: `norm` (0..1,
// relative to the strongest class) drives the fill, `text` is the sim-accurate
// readout shown to the right.
const StatBars = ({ a, lvl }: { a: Archetype; lvl: number }) => (
  <VStack gap={1}>
    {statsFor(a, lvl).rows.map((r) => (
      <ProgressBar
        key={r.key}
        label={r.key}
        value={Math.round(r.norm * 100)}
        hasValueLabel
        formatValueLabel={() => r.text}
      />
    ))}
  </VStack>
);

const Traits = ({ a, lvl }: { a: Archetype; lvl: number }) => {
  const traits = statsFor(a, lvl).traits;
  const list = traits.length > 0 ? traits : ["gun only"];
  return (
    <div className="flex flex-wrap gap-1">
      {list.map((t) => (
        <Badge key={t} variant="neutral" label={t} />
      ))}
    </div>
  );
};

// Who this class presses (counters) and who presses it (countered by).
const Matchup = ({ a }: { a: Archetype }) => (
  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
    <Text size="3xs" color="secondary">
      presses
    </Text>
    <Badge variant={CLASS_VARIANT[COUNTERS[a]]} label={COUNTERS[a]} />
    <Text size="3xs" color="secondary">
      wary of
    </Text>
    <Badge variant={CLASS_VARIANT[COUNTERED_BY[a]]} label={COUNTERED_BY[a]} />
  </div>
);

const ClassCard = ({ a, lvl }: { a: Archetype; lvl: number }) => {
  const info = ARCHETYPE_INFO[a];
  const tint = CLASS_TINT[a];
  // Dark tile with a faint class-tinted wash + hairline (echoes the welcome
  // mode buttons: translucent fill, tinted outline). Identity carries on the
  // heading + glyph, so the card sits quiet against the HUD.
  return (
    <Card
      variant="default"
      padding={3}
      style={{ border: `1px solid ${tint}59`, background: `${tint}14` }}
    >
      <VStack gap={2}>
        <HStack gap={2} vAlign="center">
          <GlyphBadge a={a} tint={tint} />
          <VStack gap={0}>
            <Text size="sm" weight="bold" style={{ color: tint }}>
              {info.label}
            </Text>
            <Text
              size="3xs"
              color="secondary"
              className="uppercase tracking-[0.1em]"
            >
              {info.tagline}
            </Text>
          </VStack>
        </HStack>
        <Matchup a={a} />
        <Text size="2xs" color="secondary">
          {info.blurb}
        </Text>
        <StatBars a={a} lvl={lvl} />
        <Traits a={a} lvl={lvl} />
      </VStack>
    </Card>
  );
};

// --- Counter web (raw SVG, kept) --------------------------------------------
// Nodes sit at the corners of a square in cycle order, so every `a → counters(a)`
// arrow runs the same way around the ring. Positions in a 240×188 viewBox.
const NODE_POS: Record<Archetype, readonly [number, number]> = {
  scout: [120, 26],
  interceptor: [214, 94],
  heavy: [120, 162],
  fighter: [26, 94],
};

// Shorten an arrow at both ends so it starts/stops at the node rim, not center.
const arrowSegment = (
  from: readonly [number, number],
  to: readonly [number, number],
) => {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const r = 22; // node radius + gap
  return { x1: x1 + ux * r, y1: y1 + uy * r, x2: x2 - ux * r, y2: y2 - uy * r };
};

const CounterArrow = ({ a }: { a: Archetype }) => {
  const seg = arrowSegment(NODE_POS[a], NODE_POS[COUNTERS[a]]);
  return (
    <line
      x1={seg.x1}
      y1={seg.y1}
      x2={seg.x2}
      y2={seg.y2}
      stroke={`${CLASS_TINT[a]}cc`}
      strokeWidth="1.6"
      markerEnd="url(#codex-arrow)"
    />
  );
};

// HTML node (positioned over the SVG arrow layer) so it can carry an Astryx
// tooltip and click-to-select. Shows the class hull silhouette in its tint; the
// node for the active tab is ringed. Clicking a node selects that class.
const CounterNode = ({
  a,
  active,
  onSelect,
}: {
  a: Archetype;
  active: Archetype;
  onSelect: (a: Archetype) => void;
}) => {
  const [cx, cy] = NODE_POS[a];
  const tint = CLASS_TINT[a];
  const on = active === a;
  return (
    <Tooltip
      placement="above"
      content={`${cap(a)} — presses ${COUNTERS[a]}, wary of ${COUNTERED_BY[a]}`}
    >
      <button
        type="button"
        aria-label={`${cap(a)}: presses ${COUNTERS[a]}, wary of ${COUNTERED_BY[a]}`}
        onClick={() => onSelect(a)}
        className="absolute grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-full transition-transform hover:scale-110"
        style={{
          left: cx,
          top: cy,
          background: `${tint}1f`,
          border: `1px solid ${on ? tint : `${tint}88`}`,
          boxShadow: on ? `0 0 10px -1px ${tint}` : undefined,
        }}
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
          <path
            d={hullSilhouettePath(a)}
            fill={`${tint}3a`}
            stroke={tint}
            strokeWidth="1.4"
          />
        </svg>
      </button>
    </Tooltip>
  );
};

const CounterWeb = ({
  active,
  onSelect,
}: {
  active: Archetype;
  onSelect: (a: Archetype) => void;
}) => (
  <div className="flex flex-col items-center gap-1">
    <Text size="4xs" color="secondary" className="uppercase tracking-[0.28em]">
      counter web
    </Text>
    <div className="relative h-[188px] w-[240px]">
      <svg
        viewBox="0 0 240 188"
        className="absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        <defs>
          <marker
            id="codex-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" fill="#cfeee2aa" />
          </marker>
        </defs>
        {ARCHETYPES.map((a) => (
          <CounterArrow key={`arrow-${a}`} a={a} />
        ))}
      </svg>
      {ARCHETYPES.map((a) => (
        <CounterNode
          key={`node-${a}`}
          a={a}
          active={active}
          onSelect={onSelect}
        />
      ))}
    </div>
    <Text size="3xs" color="secondary">
      arrow → the class it presses
    </Text>
  </div>
);

// --- Progression ladder -----------------------------------------------------
// A vertical timeline: nodes fill with the accent up to the selected rank, the
// current rank glows, and the connecting spine tracks how far you've climbed.
const DIM = "rgba(230, 251, 241, 0.22)"; // unreached rail + hollow node border
const LAST_LEVEL = TIERS[TIERS.length - 1].level;

const TierNode = ({ reached, here }: { reached: boolean; here: boolean }) => (
  <span
    className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
    style={
      reached
        ? {
            background: "var(--color-accent)",
            boxShadow: here ? "0 0 8px var(--color-accent)" : undefined,
          }
        : { border: `1px solid ${DIM}` }
    }
  />
);

const TierRow = ({ t, lvl }: { t: (typeof TIERS)[number]; lvl: number }) => {
  const here = t.level === lvl;
  const reached = t.level <= lvl;
  const isLast = t.level === LAST_LEVEL;
  return (
    <div className="flex gap-3">
      <div className="flex w-3 shrink-0 flex-col items-center">
        <TierNode reached={reached} here={here} />
        {!isLast && (
          <span
            className="w-px flex-1"
            style={{ background: t.level < lvl ? "var(--color-accent)" : DIM }}
          />
        )}
      </div>
      <div
        className={`flex flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 ${isLast ? "" : "pb-3"}`}
      >
        <Text
          size="2xs"
          weight={here ? "bold" : "semibold"}
          style={{
            color: here ? "var(--color-accent)" : undefined,
            opacity: reached ? 1 : 0.5,
          }}
        >
          L{t.level} · {t.title}
        </Text>
        <Text size="3xs" color="secondary">
          {t.note}
        </Text>
        {(t.gated ?? []).map((g) => (
          <Badge
            key={g.archetype}
            variant={CLASS_VARIANT[g.archetype]}
            label={`${g.archetype}: ${g.note}`}
          />
        ))}
      </div>
    </div>
  );
};

const Progression = ({ lvl }: { lvl: number }) => (
  <div className="flex flex-col gap-1">
    <Text size="4xs" color="secondary" className="uppercase tracking-[0.28em]">
      progression — every class shares this ladder
    </Text>
    {TIERS.map((t) => (
      <TierRow key={t.level} t={t} lvl={lvl} />
    ))}
  </div>
);

// --- Rank picker ------------------------------------------------------------
// Click-select only: ←/→ stepping is owned by the panel effect (below), which
// captures arrows before the control's own segment navigation can fire — the
// two would otherwise fight, since the control's roving focus starts on L1
// while selection sits on the current rank.
const RankControl = ({
  lvl,
  setLvl,
}: {
  lvl: number;
  setLvl: (n: number) => void;
}) => (
  <SegmentedControl
    value={String(lvl)}
    onChange={(v) => setLvl(Number(v))}
    label="Rank"
    size="sm"
  >
    {Array.from({ length: MAX_LEVEL }, (_, i) => i + 1).map((n) => (
      <SegmentedControlItem key={n} value={String(n)} label={`L${n}`} />
    ))}
  </SegmentedControl>
);

// --- Class tabs -------------------------------------------------------------
// One tab per archetype (dot in the class tint), selecting the card shown
// below. Arrows are owned by the rank picker, so tabs are click/tap-select.
const ClassTabs = ({
  active,
  onChange,
}: {
  active: Archetype;
  onChange: (a: Archetype) => void;
}) => (
  <TabList
    value={active}
    onChange={(v) => onChange(v as Archetype)}
    layout="fill"
    aria-label="Ship class"
  >
    {ARCHETYPES.map((a) => (
      <Tab
        key={a}
        value={a}
        label={cap(a)}
        icon={
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: CLASS_TINT[a] }}
          />
        }
      />
    ))}
  </TabList>
);

// --- Panel ------------------------------------------------------------------
const CodexPanel = ({ store }: { store: CodexStore }) => {
  const open = useSyncExternalStore(store.subscribe, store.getOpen);
  const [lvl, setLvl] = useState(3);
  const [active, setActive] = useState<Archetype>("fighter");

  // ←/→ cycles rank from anywhere while the codex is up. Captured on `document`
  // (capture phase) so it fires — and is swallowed — before the rank
  // SegmentedControl's own segment navigation, which otherwise double-steps
  // (its roving focus opens on L1, not the selected rank).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      // When a rank pill holds focus, defer to the SegmentedControl's own
      // navigation so its focus ring and selection move together (handling it
      // here too would leave the ring behind on the old pill).
      const el = document.activeElement;
      if (el instanceof HTMLElement && el.getAttribute("role") === "radio")
        return;
      setLvl((n) =>
        Math.min(MAX_LEVEL, Math.max(1, n + (e.key === "ArrowRight" ? 1 : -1))),
      );
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  return (
    <Dialog
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) store.close();
      }}
      width="min(760px, 92vw)"
      maxHeight="90dvh"
      padding={8}
      purpose="info"
      aria-label="Ship codex"
    >
      {/* astryx wraps Dialog children in an overflow-hidden flex column, so the
          codex owns its own scroll: fill the bounded wrapper (flex-1 + min-h-0)
          and scroll the tall content within it. `overflow-y-auto` forces
          overflow-x to clip, so px-1 keeps edge focus rings from being cut. */}
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1">
        <HStack justify="between" vAlign="center" className="flex-wrap gap-3">
          <VStack gap={0}>
            <Heading level={3}>Ship Codex</Heading>
            <Text
              size="3xs"
              color="secondary"
              className="uppercase tracking-[0.2em]"
            >
              4 classes · rock-paper-scissors · ←/→ cycles rank
            </Text>
          </VStack>
          <HStack gap={2} vAlign="center">
            <RankControl lvl={lvl} setLvl={setLvl} />
            <IconButton
              icon="✕"
              label="Close codex"
              variant="ghost"
              size="sm"
              onClick={() => store.close()}
            />
          </HStack>
        </HStack>
        <ClassTabs active={active} onChange={setActive} />
        <div className="flex flex-col gap-4 md:flex-row md:items-start">
          <div className="flex-1">
            <ClassCard a={active} lvl={lvl} />
          </div>
          <CounterWeb active={active} onSelect={setActive} />
        </div>
        <Progression lvl={lvl} />
      </div>
    </Dialog>
  );
};

// --- Opener -----------------------------------------------------------------
// Always-visible opener, tucked in the free top-left corner (HUD is top-right,
// scoreboard top-center, controls bottom-left). Hidden while the codex is open
// or the welcome splash owns the screen. Keeps the `hud-codex-open` hook the
// mobile reflow CSS targets.
const CodexOpener = ({ store }: { store: CodexStore }) => {
  const open = useSyncExternalStore(store.subscribe, store.getOpen);
  const hidden = useSyncExternalStore(store.subscribe, store.getHidden);
  return open || hidden ? null : (
    <Button
      variant="secondary"
      size="sm"
      label="◈ Ships (C)"
      onClick={() => store.open()}
      className="hud-codex-open fixed left-4 top-4 z-30"
    />
  );
};

export interface Codex {
  toggle: () => void;
  hide: () => void;
  isOpen: () => boolean;
  // Hide the always-visible opener (and close the panel) — keeps the welcome
  // splash clean; revealed once the player launches.
  setChromeHidden: (hidden: boolean) => void;
}

export const mountCodex = (): Codex => {
  const store = createCodexStore();
  const container = document.createElement("div");
  document.body.appendChild(container);
  createRoot(container).render(
    <AstryxRoot>
      <CodexOpener store={store} />
      <CodexPanel store={store} />
    </AstryxRoot>,
  );
  return {
    toggle: () => store.toggle(),
    hide: () => store.close(),
    isOpen: () => store.getOpen(),
    setChromeHidden: (h) => store.setHidden(h),
  };
};
