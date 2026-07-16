// Shared numeric field rows for the designer: slider for exploration plus an
// exact-entry number input (the Figma/Blender pattern). Callers pass a
// mutating `onChange`; the field clamps and triggers the hull re-bake.

import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Slider } from "@astryxdesign/core/Slider";
import { HStack, StackItem } from "@astryxdesign/core/Stack";
import type { ReactElement } from "react";
import { touchHull } from "../store";

export interface SliderFieldProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}

export const SliderField = ({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: SliderFieldProps): ReactElement => {
  const set = (v: number): void => {
    if (Number.isNaN(v)) return;
    onChange(Math.min(max, Math.max(min, v)));
    touchHull();
  };
  return (
    <HStack gap={1} vAlign="center">
      <StackItem size="fill">
        <Slider
          label={label}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={set}
        />
      </StackItem>
      <div className="num-entry">
        <NumberInput
          label={`${label} exact value`}
          isLabelHidden
          size="sm"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={set}
        />
      </div>
    </HStack>
  );
};

const AXES = ["x", "y", "z"] as const;

export interface Vec3FieldsProps {
  label: string;
  min: number;
  max: number;
  vec: [number, number, number];
}

export const Vec3Fields = ({
  label,
  min,
  max,
  vec,
}: Vec3FieldsProps): ReactElement => (
  <>
    {AXES.map((axis, i) => (
      <SliderField
        key={axis}
        label={`${label}.${axis}`}
        min={min}
        max={max}
        step={0.01}
        value={vec[i]}
        onChange={(v) => {
          vec[i] = v;
        }}
      />
    ))}
  </>
);
