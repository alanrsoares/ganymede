// Shared numeric field rows for the designer: slider for exploration plus an
// exact-entry number input (the Figma/Blender pattern). Callers pass a
// mutating `onChange`; the field clamps and triggers the hull re-bake.

import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Slider } from "@astryxdesign/core/Slider";
import { HStack, StackItem } from "@astryxdesign/core/Stack";
import type { CSSProperties, ReactElement } from "react";
import { beginEdit, touchHull } from "~/drydock/store";

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
    // Before the mutation, or the snapshot captures the new value. A whole
    // drag's worth of ticks coalesces into one undo step.
    beginEdit(label);
    onChange(Math.min(max, Math.max(min, v)));
    touchHull();
  };
  return (
    <HStack gap={1} vAlign="center" className="numeric-field">
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

export interface KnobFieldProps {
  marker: string;
  label: string;
  title?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit?: string;
  onChange: (value: number) => void;
}

export const KnobField = ({
  marker,
  label,
  title,
  min,
  max,
  step,
  value,
  unit,
  onChange,
}: KnobFieldProps): ReactElement => {
  const set = (next: number): void => {
    if (Number.isNaN(next)) return;
    beginEdit(label);
    onChange(Math.min(max, Math.max(min, next)));
    touchHull();
  };
  const ratio = (value - min) / (max - min);
  const angle = -135 + ratio * 270;
  const knobStyle = { "--knob-angle": `${angle}deg` } as CSSProperties;

  return (
    <div className="axis-knob" style={knobStyle}>
      <div className="axis-knob__heading">
        <span className="axis-knob__title">{title ?? marker}</span>
        <span className="axis-knob__badge">{marker}</span>
      </div>
      <div className="axis-knob__visual">
        <div className="axis-knob__dial">
          <span className="axis-knob__needle" />
        </div>
        <input
          className="axis-knob__range"
          type="range"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => set(Number(event.target.value))}
        />
      </div>
      <div className="axis-knob__meta">
        <div className="axis-knob__number">
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
          {unit && <span className="axis-knob__unit">{unit}</span>}
        </div>
      </div>
    </div>
  );
};

export interface AxisKnobFieldsProps {
  label: string;
  values: [number, number, number];
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (index: number, value: number) => void;
}

export const AxisKnobFields = ({
  label,
  values,
  min,
  max,
  step,
  unit,
  onChange,
}: AxisKnobFieldsProps): ReactElement => (
  <div className="axis-group">
    <div className="axis-group__heading">
      <span>{label}</span>
      <span>drag dial or type exact</span>
    </div>
    <div className="axis-grid">
      {AXES.map((axis, i) => (
        <KnobField
          key={axis}
          marker={axis}
          label={label}
          min={min}
          max={max}
          step={step}
          value={values[i]}
          unit={unit}
          title={`${axis} axis`}
          onChange={(value) => onChange(i, value)}
        />
      ))}
    </div>
  </div>
);

export interface ScalarKnobDefinition {
  id: string;
  marker: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit?: string;
  onChange: (value: number) => void;
}

export const ScalarKnobFields = ({
  fields,
}: {
  fields: ScalarKnobDefinition[];
}): ReactElement => (
  <div className={`shape-knob-grid${fields.length === 1 ? " is-single" : ""}`}>
    {fields.map((field) => (
      <KnobField
        key={field.id}
        marker={field.marker}
        label={field.label}
        title={field.label}
        min={field.min}
        max={field.max}
        step={field.step}
        value={field.value}
        unit={field.unit}
        onChange={field.onChange}
      />
    ))}
  </div>
);

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
  <AxisKnobFields
    label={label}
    values={vec}
    min={min}
    max={max}
    step={0.01}
    onChange={(i, value) => {
      vec[i] = value;
    }}
  />
);
