// Property editor for the selected hull part, grouped into collapsible
// sections: shape (primitive + taper + segmentation), transform
// (pos/scale/rot) and look (color + mirror). Fields mutate the part in
// place; SliderField/Selector handlers trigger the debounced re-bake.

import { Collapsible, CollapsibleGroup } from "@astryxdesign/core/Collapsible";
import { Selector } from "@astryxdesign/core/Selector";
import { VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import type { ReactElement } from "react";
import { defaultPrim, touchHull } from "~/drydock/store";
import { PALETTE_KEYS, type PartDef, type PrimDef } from "~/hull/catalog";
import { SliderField, Vec3Fields } from "./fields";

const TaperFields = ({ prim }: { prim: PrimDef }): ReactElement | null => {
  if (prim.kind === "slab") {
    return (
      <>
        <SliderField
          label="taper.x"
          min={0.02}
          max={1}
          step={0.01}
          value={prim.tx}
          onChange={(v) => {
            prim.tx = v;
          }}
        />
        <SliderField
          label="taper.z"
          min={0.02}
          max={1}
          step={0.01}
          value={prim.tz}
          onChange={(v) => {
            prim.tz = v;
          }}
        />
        <SliderField
          label="bevel"
          min={0}
          max={0.24}
          step={0.01}
          value={prim.bevel ?? 0}
          onChange={(v) => {
            prim.bevel = v;
          }}
        />
      </>
    );
  }
  if (prim.kind === "hex") {
    return (
      <SliderField
        label="taper"
        min={0.02}
        max={1}
        step={0.01}
        value={prim.taper}
        onChange={(v) => {
          prim.taper = v;
        }}
      />
    );
  }
  return null;
};

const RotationFields = ({ part }: { part: PartDef }): ReactElement => {
  part.rot ??= [0, 0, 0];
  const rot = part.rot;
  return (
    <>
      {(["x", "y", "z"] as const).map((axis, i) => (
        <SliderField
          key={axis}
          label={`rot.${axis}°`}
          min={-180}
          max={180}
          step={1}
          value={Math.round((rot[i] * 180) / Math.PI)}
          onChange={(v) => {
            rot[i] = (v * Math.PI) / 180;
          }}
        />
      ))}
    </>
  );
};

export const PartControls = ({ part }: { part: PartDef }): ReactElement => (
  <CollapsibleGroup
    type="multiple"
    defaultValue={["shape", "transform", "look"]}
    hasDividers
  >
    <Collapsible trigger="shape" value="shape">
      <VStack gap={1}>
        <Selector
          label="primitive"
          options={["slab", "hex", "orb"]}
          value={part.prim.kind}
          onChange={(kind) => {
            if (!kind) return;
            part.prim = defaultPrim(kind);
            touchHull();
          }}
        />
        <TaperFields prim={part.prim} />
        {part.prim.kind !== "orb" && (
          <SliderField
            label="segments (1 = solid)"
            min={1}
            max={9}
            step={1}
            value={part.seg ?? 1}
            onChange={(v) => {
              part.seg = v;
            }}
          />
        )}
      </VStack>
    </Collapsible>
    <Collapsible trigger="transform" value="transform">
      <VStack gap={1}>
        <Vec3Fields label="pos" min={-1.6} max={1.6} vec={part.pos} />
        <Vec3Fields label="scale" min={0.02} max={2.5} vec={part.scale} />
        <RotationFields part={part} />
      </VStack>
    </Collapsible>
    <Collapsible trigger="look" value="look">
      <VStack gap={1}>
        <Selector
          label="color"
          options={PALETTE_KEYS as unknown as string[]}
          value={part.color}
          onChange={(v) => {
            if (!v) return;
            part.color = v as PartDef["color"];
            touchHull();
          }}
        />
        <Switch
          label="mirror x"
          value={!!part.mirror}
          onChange={(checked) => {
            part.mirror = checked;
            touchHull();
          }}
        />
      </VStack>
    </Collapsible>
  </CollapsibleGroup>
);
