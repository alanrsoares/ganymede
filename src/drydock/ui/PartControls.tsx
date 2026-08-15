// Property editor for the selected hull part, grouped into collapsible
// sections: shape (primitive + taper + segmentation), transform
// (pos/scale/rot) and look (color + mirror). Fields mutate the part in
// place; field and picker handlers trigger the debounced re-bake.

import { Collapsible, CollapsibleGroup } from "@astryxdesign/core/Collapsible";
import { VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import type { ReactElement } from "react";
import { beginEdit, defaultPrim, pushUndo, touchHull } from "~/drydock/store";
import {
  PALETTE,
  PALETTE_KEYS,
  type PartDef,
  type PrimDef,
} from "~/hull/catalog";
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
  // Read through a fallback rather than materialising `part.rot` here: writing
  // to the draft during render marks a hull unsaved just for looking at a part,
  // and stock recipes leave `rot` off entirely.
  const rot = part.rot ?? ([0, 0, 0] as const);
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
        const next = part.rot ?? [0, 0, 0];
        next[i] = (value * Math.PI) / 180;
        part.rot = next;
      }}
    />
  );
};

/**
 * Palette entries are linear values written straight to a non-sRGB swapchain,
 * so a clamped 0–255 conversion is what the hull actually shows. Emissive
 * entries overshoot 1 and bloom in the render — normalise those to their hue so
 * the swatch reads as the bright colour it becomes rather than clipped white.
 */
const swatchCss = (rgb: readonly number[]): string => {
  const peak = Math.max(...rgb, 1);
  const channel = (v: number): number => Math.round((v / peak) * 255);
  return `rgb(${channel(rgb[0])}, ${channel(rgb[1])}, ${channel(rgb[2])})`;
};

const isEmissive = (rgb: readonly number[]): boolean => rgb.some((v) => v > 1);

const ColorPicker = ({ part }: { part: PartDef }): ReactElement => (
  <div className="color-picker">
    <span className="color-picker__label">color</span>
    {/* Real radios rather than buttons: it is a one-of-N choice, and it buys
        arrow-key traversal across the palette for free. */}
    <fieldset className="color-swatches">
      <legend className="drydock-sr-only">part color</legend>
      {PALETTE_KEYS.map((key) => {
        const rgb = PALETTE[key];
        const emissive = isEmissive(rgb);
        return (
          <label
            key={key}
            className="color-swatch"
            title={emissive ? `${key} · glows` : key}
          >
            <input
              type="radio"
              name="part-color"
              className="drydock-sr-only"
              value={key}
              checked={part.color === key}
              onChange={() => {
                // Coalesced, not discrete: arrow-keying across the palette is a
                // sweep, and it should cost one undo step, not one per hue.
                beginEdit("part color");
                part.color = key;
                touchHull();
              }}
            />
            <span
              className={`color-swatch__chip${emissive ? " is-emissive" : ""}`}
              // `color` drives the emissive glow's box-shadow via currentColor.
              style={{ background: swatchCss(rgb), color: swatchCss(rgb) }}
              aria-hidden="true"
            />
            <span className="color-swatch__name">
              {key}
              {emissive ? <span aria-hidden="true"> ✦</span> : null}
            </span>
          </label>
        );
      })}
    </fieldset>
  </div>
);

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
          pushUndo(`part shape ${kind}`);
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
          <ColorPicker part={part} />
          <Switch
            label="mirror x"
            value={!!part.mirror}
            onChange={(checked) => {
              pushUndo("part mirror");
              part.mirror = checked;
              touchHull();
            }}
          />
        </VStack>
      </Collapsible>
    </CollapsibleGroup>
  </div>
);
