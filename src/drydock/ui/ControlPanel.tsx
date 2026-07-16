// Left panel: scene controls — ship class, team tint, tilt, view toggles,
// shortcuts and the class lore line. Pure astryx components over the store.

import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Slider } from "@astryxdesign/core/Slider";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import type { ReactElement } from "react";
import { SHIP_CLASSES, type ShipClass } from "../../ship-parts";
import { TEAMS } from "../../world/types";
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
} from "../store";

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

const TeamSwatches = (): ReactElement => (
  <div className="swatch-row">
    {TEAMS.map((team, i) => (
      <button
        key={team.name}
        type="button"
        className={`swatch${i === view.team ? " on" : ""}`}
        style={{
          background: `rgb(${team.rgb.map((c) => Math.round(c * 255)).join(",")})`,
        }}
        aria-label={`team ${team.name}`}
        aria-pressed={i === view.team}
        onClick={() => setTeam(i)}
      />
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
      <Text type="supporting" display="block">
        drag hull to orbit — x yaw · y pitch. keys: 1-4 class · d design · space
        pause · m mono · b bank
      </Text>
      <Text type="supporting" display="block">
        <strong>{gear.title}</strong>
        <br />
        {gear.desc}
      </Text>
    </VStack>
  );
};
