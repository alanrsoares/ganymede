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
  dirtyClasses,
  dupPart,
  hulls,
  isDirty,
  redo,
  redoLabel,
  resetClass,
  revertClass,
  saveHulls,
  sel,
  selectPart,
  undo,
  undoLabel,
  view,
} from "~/drydock/store";
import type { PartDef } from "~/hull/catalog";
import { ArticulationControls } from "./ArticulationControls";
import { CodePreview } from "./CodePreview";
import { EngineList } from "./EngineControls";
import { PartControls } from "./PartControls";

interface ConfirmButtonProps {
  label: string;
  variant?: "secondary" | "destructive";
  isDisabled?: boolean;
  tooltip?: string;
  title: string;
  description: string;
  actionLabel: string;
  onConfirm: () => void;
}

/** A button that gates a bulk discard behind a confirm dialog. */
const ConfirmButton = ({
  label,
  variant,
  isDisabled,
  tooltip,
  title,
  description,
  actionLabel,
  onConfirm,
}: ConfirmButtonProps): ReactElement => {
  const dialog = useImperativeAlertDialog();
  return (
    <>
      <Button
        label={label}
        size="sm"
        variant={variant}
        isDisabled={isDisabled}
        tooltip={tooltip}
        onClick={() =>
          dialog.show({
            title,
            description,
            actionLabel,
            onAction: () => {
              onConfirm();
              dialog.hide();
            },
          })
        }
      />
      {dialog.element}
    </>
  );
};

/** Save commits every dirty class — the store key holds all four together. */
const saveLabel = (): string => {
  const count = dirtyClasses().length;
  if (count === 0) return "saved";
  return count > 1 ? `save · ${count} hulls` : "save hull";
};

const CommitRow = (): ReactElement => {
  const dirty = isDirty();
  return (
    <div className="designer-commit">
      <Button
        label={saveLabel()}
        size="sm"
        isDisabled={!dirty}
        tooltip="Write the draft to browser storage"
        onClick={saveHulls}
      />
      <ConfirmButton
        label="revert"
        variant="secondary"
        isDisabled={!isDirty(view.cls)}
        tooltip="Discard unsaved changes to this hull"
        title={`Discard ${view.cls} changes?`}
        description="Drops every unsaved edit to this hull and reloads the last saved version. The revert itself stays undoable."
        actionLabel="revert"
        onConfirm={revertClass}
      />
      <span className="designer-commit__state">
        {dirty ? "unsaved changes" : "saved"}
      </span>
    </div>
  );
};

const HistoryRow = (): ReactElement => {
  const undoNext = undoLabel();
  const redoNext = redoLabel();
  return (
    <div className="designer-actions">
      <Button
        label={undoNext ? `undo ${undoNext}` : "undo"}
        size="sm"
        isDisabled={!undoNext}
        tooltip={undoNext ? `Undo ${undoNext}` : "Nothing to undo"}
        onClick={undo}
      />
      <Button
        label={redoNext ? `redo ${redoNext}` : "redo"}
        size="sm"
        isDisabled={!redoNext}
        tooltip={redoNext ? `Redo ${redoNext}` : "Nothing to redo"}
        onClick={redo}
      />
      <ConfirmButton
        label="reset hull"
        variant="secondary"
        title={`Reset ${view.cls} to the original?`}
        description="Loads the original recipe into your draft. Nothing is written until you save."
        actionLabel="reset hull"
        onConfirm={resetClass}
      />
    </div>
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
        <span>hull parts</span>
        <span>{parts.length} parts</span>
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
      <Button label="add part" size="sm" onClick={addPart} />
      <Button
        label="duplicate"
        size="sm"
        variant="secondary"
        onClick={dupPart}
      />
      <Button
        label="delete"
        size="sm"
        variant="destructive"
        isDisabled={parts.length <= 1}
        tooltip="A hull must keep one part"
        onClick={delPart}
      />
    </div>
  );
};

const DesignerStats = (): ReactElement => {
  const hull = hulls[view.cls];
  const dirty = isDirty();
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
      <div role="status">
        <span
          className="designer-stat__value designer-stat__live"
          data-state={dirty ? "dirty" : "clean"}
          aria-hidden="true"
        >
          ●
        </span>
        <span className="designer-stat__label">
          {dirty ? "unsaved" : "saved"}
        </span>
      </div>
    </div>
  );
};

const SelectedPart = ({ part }: { part?: PartDef }): ReactElement | null =>
  !part ? null : (
    <div className="selected-part">
      <div className="selected-part__index">
        {String(sel.part + 1).padStart(2, "0")}
      </div>
      <div className="selected-part__copy">
        <span className="selected-part__eyebrow">selected part</span>
        <strong>{part.prim.kind} assembly</strong>
        <small>{partMeta(part) || "no finish set"}</small>
      </div>
      <span className="selected-part__chevron" aria-hidden="true">
        ⌄
      </span>
    </div>
  );

const TAB_CONTEXT: Record<string, string> = {
  parts: "Select a part to tune its shape.",
  engines: "Place the plume anchors behind the hull.",
  motion: "Tune the spine motion without rebuilding the mesh.",
  code: "Copy this recipe back to the catalog.",
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
          assembly bay / design
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
            <p className="designer-subtitle">
              {view.cls} / {isDirty(view.cls) ? "unsaved draft" : "saved"}
            </p>
          </div>
          <Badge label={view.cls} variant="green" />
        </div>
      </header>

      <DesignerStats />

      <CommitRow />
      <HistoryRow />

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
