// Right panel: the hull designer, tabbed — parts (list + property editor),
// engines, motion (articulation) and code (TS paste-back + JSON round-trip).
// Structural ops go through store actions; field edits mutate the hull draft
// directly and re-bake via touchHull.

import { useImperativeAlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Item } from "@astryxdesign/core/Item";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { type ReactElement, useState } from "react";
import {
  addPart,
  delPart,
  dupPart,
  hulls,
  resetClass,
  sel,
  selectPart,
  undo,
  undoSlot,
  view,
} from "~/drydock/store";
import type { PartDef } from "~/hull/catalog";
import { ArticulationControls } from "./ArticulationControls";
import { CodePreview } from "./CodePreview";
import { EngineList } from "./EngineControls";
import { PartControls } from "./PartControls";

const ResetButton = (): ReactElement => {
  const dialog = useImperativeAlertDialog();
  return (
    <>
      <Button
        label="reset class"
        size="sm"
        variant="secondary"
        onClick={() =>
          dialog.show({
            title: `Reset ${view.cls} to stock?`,
            description:
              "Discards this hull's local edits and restores the stock recipe. One undo step is kept.",
            actionLabel: "reset",
            onAction: () => {
              resetClass();
              dialog.hide();
            },
          })
        }
      />
      {dialog.element}
    </>
  );
};

const partMeta = (part: PartDef): string =>
  [
    part.color,
    part.mirror && "mirrored",
    (part.seg ?? 1) > 1 && `seg ${part.seg}`,
  ]
    .filter(Boolean)
    .join(" · ");

const PartList = (): ReactElement => {
  const parts = hulls[view.cls].parts;
  return (
    <VStack gap={0}>
      {parts.map((part, i) => (
        <Item
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
          key={i}
          density="compact"
          label={`${i} · ${part.prim.kind}`}
          description={partMeta(part)}
          isSelected={i === sel.part}
          onClick={() => selectPart(i)}
        />
      ))}
    </VStack>
  );
};

const PartOps = (): ReactElement => {
  const parts = hulls[view.cls].parts;
  return (
    <HStack gap={1}>
      <Button label="+ part" size="sm" onClick={addPart} />
      <Button label="duplicate" size="sm" onClick={dupPart} />
      <Button
        label="delete"
        size="sm"
        variant="destructive"
        isDisabled={parts.length <= 1}
        tooltip="a hull keeps at least one part"
        onClick={delPart}
      />
    </HStack>
  );
};

export const DesignerPanel = (): ReactElement => {
  const hull = hulls[view.cls];
  const part = hull.parts[Math.min(sel.part, hull.parts.length - 1)];
  const [tab, setTab] = useState("parts");
  return (
    <VStack gap={3}>
      <HStack gap={1} vAlign="center">
        <StackItem size="fill">
          <Text type="label" as="p" color="accent" weight="semibold">
            hull designer
          </Text>
        </StackItem>
        <Badge label={view.cls} variant="green" />
      </HStack>
      <HStack gap={1}>
        {undoSlot && (
          <Button
            label={
              undoSlot.label === "redo" ? "redo" : `undo ${undoSlot.label}`
            }
            size="sm"
            onClick={undo}
          />
        )}
        <ResetButton />
      </HStack>
      <TabList value={tab} onChange={setTab} size="sm" layout="fill">
        <Tab value="parts" label="parts" />
        <Tab value="engines" label="engines" />
        <Tab value="motion" label="motion" />
        <Tab value="code" label="code" />
      </TabList>
      {tab === "parts" && (
        <>
          <PartList />
          <PartOps />
          {part && <PartControls key={`${view.cls}:${sel.part}`} part={part} />}
        </>
      )}
      {tab === "engines" && <EngineList />}
      {tab === "motion" && <ArticulationControls key={view.cls} />}
      {tab === "code" && <CodePreview />}
    </VStack>
  );
};
