// Left panel: scene controls — ship class, team tint, tilt, view toggles,
// keyboard shortcuts and the class lore card. Pure astryx components over
// the store.

import { Kbd } from "@astryxdesign/core/Kbd";
import { Section } from "@astryxdesign/core/Section";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Slider } from "@astryxdesign/core/Slider";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import type { ReactElement } from "react";
import {
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
import { TEAMS } from "~/world/types";

const GEAR: Record<ShipClass, { title: string; desc: string }> = {
  scout: {
    title: "scout — lamprey",
    desc: "speed 1.3× · recon · shredder bolts · cyclopean eye, barbed spine",
  },
  fighter: {
    title: "fighter — ossuary",
    desc: "cadence 1.39× · L5 arc lightning · bone-blade wings, tusk barrels",
  },
  heavy: {
    title: "heavy — leviathan",
    desc: "hp 1.5× · rammer/carrier · mine barnacles · eye is off-centre. it watches",
  },
  interceptor: {
    title: "interceptor — stinger",
    desc: "speed 1.12× · seeking missiles L3+ · egg-sac polyps about to hatch",
  },
};

const SHORTCUTS: Array<[keys: string, action: string]> = [
  ["1", "ship class (1–4)"],
  ["d", "design mode"],
  ["space", "pause"],
  ["m", "mono tint"],
  ["b", "bank sweep"],
  ["escape", "exit design"],
];

const TeamSwatches = (): ReactElement => (
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
    <ToggleButton
      label="design"
      size="sm"
      isPressed={view.design}
      onPressedChange={setDesign}
    />
  </div>
);

const Shortcuts = (): ReactElement => (
  <VStack gap={1}>
    {SHORTCUTS.map(([keys, action]) => (
      <HStack key={keys} gap={2} vAlign="center">
        <Kbd keys={keys} />
        <Text type="supporting">{action}</Text>
      </HStack>
    ))}
    <Text type="supporting" display="block">
      drag hull to orbit — x yaw · y pitch
    </Text>
  </VStack>
);

export const ControlPanel = (): ReactElement => {
  const gear = GEAR[view.cls];
  return (
    <VStack gap={3}>
      <Text type="label" as="p" color="accent" weight="semibold">
        Drydock — hull concept
      </Text>
      <SegmentedControl
        label="ship class"
        size="sm"
        layout="fill"
        value={view.cls}
        onChange={(v) => setCls(v as ShipClass)}
      >
        {SHIP_CLASSES.map((cls) => (
          <SegmentedControlItem key={cls} value={cls} label={cls} />
        ))}
      </SegmentedControl>
      <TeamSwatches />
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
      <ViewToggles />
      <Section variant="muted" padding={2}>
        <Text type="label" weight="semibold" display="block">
          {gear.title}
        </Text>
        <Text type="supporting" display="block">
          {gear.desc}
        </Text>
      </Section>
      <Shortcuts />
    </VStack>
  );
};
