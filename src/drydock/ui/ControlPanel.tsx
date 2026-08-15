// Left panel: scene controls — ship class, team tint, tilt, view toggles,
// keyboard shortcuts and the class lore card. Pure astryx components over
// the store.

import { Kbd } from "@astryxdesign/core/Kbd";
import { Slider } from "@astryxdesign/core/Slider";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import type { ReactElement } from "react";
import {
  hulls,
  setCls,
  setDesign,
  setTeam,
  setTiltDeg,
  toggleBank,
  toggleMono,
  togglePause,
  toggleSpin,
  view,
} from "~/drydock/store";
import { SHIP_CLASSES, type ShipClass } from "~/hull/catalog";
import { hullSilhouettePath } from "~/hull/silhouette";
import { TEAMS } from "~/world/types";

const ArchetypeGlyph = ({
  cls,
  isSelected,
}: {
  cls: ShipClass;
  isSelected: boolean;
}) => (
  <svg
    viewBox="0 0 24 24"
    className="h-4 w-4 shrink-0 transition-colors"
    fill="none"
    strokeLinejoin="round"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path
      d={hullSilhouettePath(cls)}
      fill={isSelected ? "var(--color-accent)" : "rgba(255, 255, 255, 0.25)"}
      stroke={isSelected ? "var(--color-accent)" : "rgba(255, 255, 255, 0.6)"}
      strokeWidth="1.6"
    />
  </svg>
);

const GEAR: Record<ShipClass, { title: string; desc: string }> = {
  scout: {
    title: "scout · lamprey",
    desc: "speed 1.3× · recon · shredder bolts · cyclopean eye, barbed spine",
  },
  fighter: {
    title: "fighter · ossuary",
    desc: "cadence 1.39× · L5 arc lightning · bone-blade wings, tusk barrels",
  },
  heavy: {
    title: "heavy · leviathan",
    desc: "hp 1.5× · rammer/carrier · mine barnacles · eye is off-centre. it watches",
  },
  interceptor: {
    title: "interceptor · stinger",
    desc: "speed 1.12× · seeking missiles L3+ · egg-sac polyps about to hatch",
  },
};

const SHORTCUTS: Array<[keys: string, action: string]> = [
  ["1", "ship class (1–4)"],
  ["d", "design mode"],
  ["space", "pause"],
  ["m", "mono tint"],
  ["b", "bank sweep"],
  ["c", "collapse control deck"],
  ["escape", "exit design"],
];

// Design-mode transforms live in gizmo.ts — they need the projected gizmo frame.
const DESIGN_SHORTCUTS: Array<[keys: string, action: string]> = [
  ["w", "gizmo move mode"],
  ["r", "gizmo scale mode"],
  ["shift+left", "nudge part in view plane (any arrow)"],
  ["shift+alt+up", "nudge part depth · z (up/down)"],
];

const SectionLabel = ({
  index,
  children,
}: {
  index: string;
  children: string;
}): ReactElement => (
  <div className="control-section-label">
    <span className="control-section-index">{index}</span>
    <span>{children}</span>
  </div>
);

const StatusRail = (): ReactElement => (
  <div className="status-rail" aria-live="polite">
    <span className="status-rail__live">
      <span className={`status-dot${view.paused ? " is-paused" : ""}`} />
      {view.paused ? "paused" : "live preview"}
    </span>
    <span>{hulls[view.cls].parts.length} parts</span>
    <span>{view.design ? "design mode" : "inspection"}</span>
  </div>
);

const ClassPicker = (): ReactElement => (
  <div className="class-grid">
    {SHIP_CLASSES.map((cls, i) => {
      const selected = view.cls === cls;
      const callsign = GEAR[cls].title.split(" · ")[1];
      return (
        <button
          key={cls}
          type="button"
          className={`class-card${selected ? " is-selected" : ""}`}
          aria-pressed={selected}
          onClick={() => setCls(cls)}
        >
          <span className="class-card__topline">
            <span className="class-card__glyph">
              <ArchetypeGlyph cls={cls} isSelected={selected} />
            </span>
            <span className="class-card__index">0{i + 1}</span>
          </span>
          <span className="class-card__name">{cls}</span>
          <span className="class-card__callsign">{callsign}</span>
        </button>
      );
    })}
  </div>
);

const TeamSwatches = (): ReactElement => (
  <div className="swatch-control">
    <div className="swatch-row">
      {TEAMS.map((team, i) => (
        <Tooltip key={team.name} content={`team ${team.name}`}>
          <button
            type="button"
            className={`swatch${i === view.team ? " on" : ""}`}
            style={{
              background: `rgb(${team.rgb.map((c) => Math.round(c * 255)).join(",")})`,
            }}
            aria-label={`team ${team.name}`}
            aria-pressed={i === view.team}
            onClick={() => setTeam(i)}
          />
        </Tooltip>
      ))}
    </div>
    <span className="swatch-name">{TEAMS[view.team]?.name ?? "unknown"}</span>
  </div>
);

const ViewToggles = (): ReactElement => (
  <div className="toggle-row">
    <ToggleButton
      label="spin"
      size="sm"
      isPressed={view.spin}
      onPressedChange={toggleSpin}
    />
    <ToggleButton
      label="bank sweep"
      size="sm"
      isPressed={view.bank}
      onPressedChange={toggleBank}
    />
    <ToggleButton
      label="mono tint"
      size="sm"
      isPressed={view.mono}
      onPressedChange={toggleMono}
    />
    <ToggleButton
      label={view.paused ? "resume" : "pause"}
      size="sm"
      isPressed={view.paused}
      onPressedChange={togglePause}
    />
  </div>
);

const DesignLaunch = (): ReactElement => (
  <button
    type="button"
    className={`design-launch${view.design ? " is-active" : ""}`}
    aria-pressed={view.design}
    onClick={() => setDesign(!view.design)}
  >
    <span className="design-launch__mark" aria-hidden="true">
      {view.design ? "●" : "↗"}
    </span>
    <span className="design-launch__copy">
      <strong>{view.design ? "designer open" : "open hull designer"}</strong>
      <small>
        {view.design ? "esc to return to inspection" : "shape, tune, export"}
      </small>
    </span>
    <span className="design-launch__key" aria-hidden="true">
      D
    </span>
  </button>
);

const Shortcuts = (): ReactElement => (
  <details className="shortcut-drawer">
    <summary>
      <span>keymap</span>
      <span className="shortcut-drawer__hint">
        {SHORTCUTS.length + DESIGN_SHORTCUTS.length} shortcuts
      </span>
    </summary>
    <VStack gap={1} className="shortcut-list">
      {SHORTCUTS.map(([keys, action]) => (
        <HStack key={keys} gap={2} vAlign="center">
          <Kbd keys={keys} />
          <Text type="supporting">{action}</Text>
        </HStack>
      ))}
      <div className="shortcut-group__label">design mode</div>
      {DESIGN_SHORTCUTS.map(([keys, action]) => (
        <HStack key={keys} gap={2} vAlign="center">
          <Kbd keys={keys} />
          <Text type="supporting">{action}</Text>
        </HStack>
      ))}
      <Text type="supporting" display="block" className="orbit-note">
        drag hull to orbit · x yaw · y pitch
      </Text>
    </VStack>
  </details>
);

export const ControlPanel = (): ReactElement => {
  const gear = GEAR[view.cls];
  return (
    <div className="control-column">
      <header className="drydock-header">
        <div className="drydock-eyebrow">
          <span className="eyebrow-mark" aria-hidden="true" />
          hull lab
        </div>
        <div className="drydock-title-row">
          <Text
            type="label"
            as="p"
            color="accent"
            weight="semibold"
            className="drydock-title"
          >
            drydock
          </Text>
          <span className="header-code">01 / 02</span>
        </div>
        <p className="drydock-lede">
          Inspect the silhouette. Then make it strange.
        </p>
      </header>

      <StatusRail />
      <DesignLaunch />

      <section className="control-section control-section--class">
        <SectionLabel index="01">hull class</SectionLabel>
        <ClassPicker />
        <div className="class-readout">
          <span className="class-readout__title">{gear.title}</span>
          <span className="class-readout__desc">{gear.desc}</span>
        </div>
      </section>

      <section className="control-section">
        <SectionLabel index="02">presentation</SectionLabel>
        <div className="presentation-grid">
          <div className="presentation-control">
            <span className="field-caption">team tint</span>
            <TeamSwatches />
          </div>
          <div className="presentation-control tilt-control">
            <Slider
              label="tilt"
              min={0}
              max={60}
              step={1}
              value={view.tiltDeg}
              onChange={setTiltDeg}
              formatValue={(v) => `${v}°`}
              valueDisplay="text"
            />
          </div>
        </div>
      </section>

      <section className="control-section">
        <SectionLabel index="03">camera & playback</SectionLabel>
        <ViewToggles />
      </section>

      <Shortcuts />
    </div>
  );
};
