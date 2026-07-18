// Spine articulation tuner: the hull's swim parameters (ship.wgsl
// spineDeform). Values ride per-instance, so slider drags update the swarm
// live with no pipeline rebuild; the inspector shows the wave outside design
// mode (design freezes to rest pose for exact part picking). Export puts the
// block on the clipboard with the rest of the hull for the catalog paste-back.

import { VStack } from "@astryxdesign/core/Stack";
import type { ReactElement } from "react";
import { hulls, view } from "~/drydock/store";
import { SliderField } from "./fields";

export const ArticulationControls = (): ReactElement => {
  const a = hulls[view.cls].articulation;
  return (
    <VStack gap={1}>
      <SliderField
        label="wave amp"
        min={0}
        max={0.3}
        step={0.005}
        value={a.amp}
        onChange={(v) => {
          a.amp = v;
        }}
      />
      <SliderField
        label="wave freq"
        min={1}
        max={8}
        step={0.1}
        value={a.freq}
        onChange={(v) => {
          a.freq = v;
        }}
      />
      <SliderField
        label="wave speed"
        min={0}
        max={3}
        step={0.05}
        value={a.speed}
        onChange={(v) => {
          a.speed = v;
        }}
      />
      <SliderField
        label="head stiff y"
        min={-0.5}
        max={0.9}
        step={0.05}
        value={a.headStiff}
        onChange={(v) => {
          a.headStiff = v;
        }}
      />
      <SliderField
        label="segment len (0 = smooth)"
        min={0}
        max={0.6}
        step={0.05}
        value={a.segLen}
        onChange={(v) => {
          a.segLen = v;
        }}
      />
    </VStack>
  );
};
