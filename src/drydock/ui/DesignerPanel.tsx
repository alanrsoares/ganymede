// Right panel: the hull designer, tabbed — parts (list + property editor),
// engines, motion (articulation) and code (TS paste-back + JSON round-trip).
// Structural ops go through store actions; field edits mutate the hull draft
// directly and re-bake via touchHull.

import { useImperativeAlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Item } from "@astryxdesign/core/Item";
import { VStack } from "@astryxdesign/core/Stack";
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
        label="reset stock"
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
    <div className="part-browser">
      <div className="browser-heading">
        <span>hull components</span>
        <span>{parts.length} total</span>
      </div>
      <VStack gap={0} className="part-list">
        {parts.map((part, i) => (
          <Item
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
            key={i}
            density="compact"
            label={`${String(i + 1).padStart(2, "0")} · ${part.prim.kind}`}
            description={partMeta(part)}
            isSelected={i === sel.part}
            onClick={() => selectPart(i)}
          />
        ))}
      </VStack>
    </div>
  );
};

const PartOps = (): ReactElement => {
  const parts = hulls[view.cls].parts;
  return (
    <div className="part-actions">
      <Button label="+ add part" size="sm" onClick={addPart} />
      <Button label="clone" size="sm" variant="secondary" onClick={dupPart} />
      <Button
        label="delete"
        size="sm"
        variant="destructive"
        isDisabled={parts.length <= 1}
        tooltip="a hull keeps at least one part"
        onClick={delPart}
      />
    </div>
  );
};

const DesignerStats = (): ReactElement => {
  const hull = hulls[view.cls];
  return (
    <div className="designer-stats">
      <div>
        <span className="designer-stat__value">{hull.parts.length}</span>
        <span className="designer-stat__label">parts</span>
      </div>
      <div>
        <span className="designer-stat__value">{hull.engines.length}</span>
        <span className="designer-stat__label">engines</span>
      </div>
      <div>
        <span className="designer-stat__value designer-stat__live">●</span>
        <span className="designer-stat__label">rebake live</span>
      </div>
    </div>
  );
};

const SelectedPart = ({ part }: { part?: PartDef }): ReactElement | null => {
  if (!part) return null;
  return (
    <div className="selected-part">
      <div className="selected-part__index">
        {String(sel.part + 1).padStart(2, "0")}
      </div>
      <div className="selected-part__copy">
        <span className="selected-part__eyebrow">selected component</span>
        <strong>{part.prim.kind} assembly</strong>
        <small>{partMeta(part) || "unassigned finish"}</small>
      </div>
      <span className="selected-part__chevron" aria-hidden="true">
        ⌄
      </span>
    </div>
  );
};

const TAB_CONTEXT: Record<string, string> = {
  parts: "Select a component to tune its silhouette.",
  engines: "Place the plume anchors behind the hull.",
  motion: "Shape the spine wave without rebuilding the mesh.",
  code: "Copy the working recipe back into the catalog.",
};

const DesignerTabContent = ({
  tab,
  part,
}: {
  tab: string;
  part?: PartDef;
}): ReactElement => {
  switch (tab) {
    case "parts":
      return (
        <>
          <PartList />
          <SelectedPart part={part} />
          <PartOps />
          {part && <PartControls key={`${view.cls}:${sel.part}`} part={part} />}
        </>
      );
    case "engines":
      return <EngineList />;
    case "motion":
      return <ArticulationControls key={view.cls} />;
    case "code":
      return <CodePreview />;
    default:
      return <Text type="supporting">No editor selected.</Text>;
  }
};

export const DesignerPanel = (): ReactElement => {
  const hull = hulls[view.cls];
  const part = hull.parts[Math.min(sel.part, hull.parts.length - 1)];
  const [tab, setTab] = useState("parts");
  return (
    <div className="designer-shell">
      <header className="designer-header">
        <div className="drydock-eyebrow">
          <span className="eyebrow-mark" aria-hidden="true" />
          assembly bay / design mode
        </div>
        <div className="designer-title-row">
          <div>
            <Text
              type="label"
              as="p"
              color="accent"
              weight="semibold"
              className="designer-title"
            >
              hull designer
            </Text>
            <p className="designer-subtitle">{view.cls} / live working copy</p>
          </div>
          <Badge label={view.cls} variant="green" />
        </div>
      </header>

      <DesignerStats />

      <div className="designer-actions">
        {undoSlot ? (
          <Button
            label={
              undoSlot.label === "redo" ? "redo" : `undo ${undoSlot.label}`
            }
            size="sm"
            onClick={undo}
          />
        ) : (
          <span className="no-undo">no pending changes</span>
        )}
        <ResetButton />
      </div>

      <div className="designer-tabs">
        <TabList value={tab} onChange={setTab} size="sm" layout="fill">
          <Tab value="parts" label={`parts · ${hull.parts.length}`} />
          <Tab value="engines" label={`engines · ${hull.engines.length}`} />
          <Tab value="motion" label="motion" />
          <Tab value="code" label="code" />
        </TabList>
      </div>

      <div className="tab-context">{TAB_CONTEXT[tab]}</div>
      <DesignerTabContent tab={tab} part={part} />
    </div>
  );
};
