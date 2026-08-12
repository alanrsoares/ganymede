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
import { AxisKnobFields, ScalarKnobFields, Vec3Fields } from "./fields";

const SlabProfile = ({
  prim,
}: {
  prim: Extract<PrimDef, { kind: "slab" }>;
}): ReactElement => (
  <ScalarKnobFields
    fields={[
      {
        id: "taper-x",
        marker: "tx",
        label: "taper x",
        min: 0.02,
        max: 1,
        step: 0.01,
        value: prim.tx,
        onChange: (v) => {
          prim.tx = v;
        },
      },
      {
        id: "taper-z",
        marker: "tz",
        label: "taper z",
        min: 0.02,
        max: 1,
        step: 0.01,
        value: prim.tz,
        onChange: (v) => {
          prim.tz = v;
        },
      },
      {
        id: "bevel",
        marker: "bev",
        label: "bevel",
        min: 0,
        max: 0.24,
        step: 0.01,
        value: prim.bevel ?? 0,
        onChange: (v) => {
          prim.bevel = v;
        },
      },
    ]}
  />
);

const HexProfile = ({
  prim,
}: {
  prim: Extract<PrimDef, { kind: "hex" }>;
}): ReactElement => (
  <ScalarKnobFields
    fields={[
      {
        id: "taper",
        marker: "tap",
        label: "taper",
        min: 0.02,
        max: 1,
        step: 0.01,
        value: prim.taper,
        onChange: (v) => {
          prim.taper = v;
        },
      },
    ]}
  />
);

const TaperFields = ({ prim }: { prim: PrimDef }): ReactElement | null => {
  switch (prim.kind) {
    case "slab":
      return <SlabProfile prim={prim} />;
    case "hex":
      return <HexProfile prim={prim} />;
    case "orb":
      return null;
  }
};

const RotationFields = ({ part }: { part: PartDef }): ReactElement => {
  part.rot ??= [0, 0, 0];
  const rot = part.rot;
  return (
    <AxisKnobFields
      label="rotation"
      values={
        rot.map((value) => Math.round((value * 180) / Math.PI)) as [
          number,
          number,
          number,
        ]
      }
      min={-180}
      max={180}
      step={1}
      unit="°"
      onChange={(i, value) => {
        rot[i] = (value * Math.PI) / 180;
      }}
    />
  );
};

const PrimitivePicker = ({ part }: { part: PartDef }): ReactElement => (
  <div className="primitive-picker">
    {(["slab", "hex", "orb"] as const).map((kind) => (
      <button
        key={kind}
        type="button"
        className={`primitive-card primitive-card--${kind}${
          part.prim.kind === kind ? " is-selected" : ""
        }`}
        aria-pressed={part.prim.kind === kind}
        onClick={() => {
          if (part.prim.kind === kind) return;
          part.prim = defaultPrim(kind);
          touchHull();
        }}
      >
        <span
          className={`primitive-glyph primitive-glyph--${kind}`}
          aria-hidden="true"
        />
        <span className="primitive-card__copy">
          <strong>{kind}</strong>
          <small>
            {kind === "slab" ? "panel" : kind === "hex" ? "faceted" : "volume"}
          </small>
        </span>
      </button>
    ))}
  </div>
);

export const PartControls = ({ part }: { part: PartDef }): ReactElement => (
  <div className="inspector-card">
    <div className="inspector-card__heading">
      <span>part inspector</span>
      <span>updates live</span>
    </div>
    <CollapsibleGroup
      type="multiple"
      defaultValue={["shape", "transform", "look"]}
      hasDividers
    >
      <Collapsible trigger="shape / geometry" value="shape">
        <div className="shape-editor">
          <div className="shape-subhead">
            <span>shape type</span>
            <span>changes the recipe</span>
          </div>
          <PrimitivePicker part={part} />
          <div className="shape-subhead">
            <span>shape profile</span>
            <span>drag or enter a value</span>
          </div>
          <TaperFields prim={part.prim} />
          {part.prim.kind !== "orb" && (
            <ScalarKnobFields
              fields={[
                {
                  id: "segments",
                  marker: "seg",
                  label: "segments (1 = solid)",
                  min: 1,
                  max: 9,
                  step: 1,
                  value: part.seg ?? 1,
                  onChange: (v) => {
                    part.seg = v;
                  },
                },
              ]}
            />
          )}
          {part.prim.kind === "orb" && (
            <div className="shape-empty-note">
              Orbs have no taper or segment controls.
            </div>
          )}
        </div>
      </Collapsible>
      <Collapsible trigger="transform / placement" value="transform">
        <div className="transform-grid">
          <Vec3Fields label="position" min={-1.6} max={1.6} vec={part.pos} />
          <Vec3Fields label="scale" min={0.02} max={2.5} vec={part.scale} />
          <div className="transform-grid__full">
            <RotationFields part={part} />
          </div>
        </div>
      </Collapsible>
      <Collapsible trigger="look / finish" value="look">
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
  </div>
);
