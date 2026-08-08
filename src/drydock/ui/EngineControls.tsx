// Engine anchor editor: per-engine x/y/width sliders plus add/remove. Plumes
// re-bake live through the same touchHull path as part edits.

import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { ReactElement } from "react";
import { addEngine, delEngine, hulls, view } from "~/drydock/store";
import type { EngineAnchor } from "~/hull/catalog";
import { SliderField } from "./fields";

const EngineRow = ({
  eng,
  index,
  removable,
}: {
  eng: EngineAnchor;
  index: number;
  removable: boolean;
}): ReactElement => (
  <div className="engine-card">
    <HStack gap={1} vAlign="center">
      <StackItem size="fill">
        <div className="engine-card__title">
          <Text type="label">engine {index + 1}</Text>
          <span>plume anchor</span>
        </div>
      </StackItem>
      {removable && (
        <IconButton
          label={`remove engine ${index + 1}`}
          icon={<span aria-hidden="true">✕</span>}
          size="sm"
          variant="ghost"
          onClick={() => delEngine(index)}
        />
      )}
    </HStack>
    <SliderField
      label={`engine ${index + 1} x`}
      min={-1.2}
      max={1.2}
      step={0.01}
      value={eng.pos[0]}
      onChange={(v) => {
        eng.pos[0] = v;
      }}
    />
    <SliderField
      label={`engine ${index + 1} y`}
      min={-1.8}
      max={1.8}
      step={0.01}
      value={eng.pos[1]}
      onChange={(v) => {
        eng.pos[1] = v;
      }}
    />
    <SliderField
      label={`engine ${index + 1} width`}
      min={0.03}
      max={0.4}
      step={0.01}
      value={eng.w}
      onChange={(v) => {
        eng.w = v;
      }}
    />
  </div>
);

export const EngineList = (): ReactElement => {
  const engines = hulls[view.cls].engines;
  return (
    <div className="engine-list">
      <div className="editor-note">
        Anchors are measured from the hull center. Move them until the exhaust
        clears the silhouette.
      </div>
      <VStack gap={2}>
        {engines.map((eng, i) => (
          <EngineRow
            // biome-ignore lint/suspicious/noArrayIndexKey: engines are positional
            key={i}
            eng={eng}
            index={i}
            removable={engines.length > 1}
          />
        ))}
      </VStack>
      <div className="engine-actions">
        <Button label="+ add engine anchor" size="sm" onClick={addEngine} />
      </div>
    </div>
  );
};
