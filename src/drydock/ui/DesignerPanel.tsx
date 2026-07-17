// Right panel: the hull designer. Part list + structural ops + property
// editor for the selected part, engine anchors, clipboard round-trip and the
// one-deep undo. Structural ops go through store actions; field edits mutate
// the hull draft directly and re-bake via touchHull.

import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { type ReactElement, useRef, useState } from "react";
import {
  addPart,
  delPart,
  dupPart,
  exportHull,
  hulls,
  importHull,
  resetClass,
  sel,
  selectPart,
  undo,
  undoSlot,
  view,
} from "~/drydock/store";
import { EngineList } from "./EngineControls";
import { PartControls } from "./PartControls";

/** Transient status label on a button, restoring after a beat. */
const useFlash = (base: string): [string, (msg: string) => void] => {
  const [label, setLabel] = useState(base);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flash = (msg: string): void => {
    setLabel(msg);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setLabel(base), 1600);
  };
  return [label, flash];
};

/** Two-step reset: first press arms (destructive styling), second commits. */
const ResetButton = (): ReactElement => {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return (
    <Button
      label={armed ? "reset — sure?" : "reset class"}
      size="sm"
      variant={armed ? "destructive" : "secondary"}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          timer.current = setTimeout(() => setArmed(false), 2500);
          return;
        }
        clearTimeout(timer.current);
        setArmed(false);
        resetClass();
      }}
    />
  );
};

const PartList = (): ReactElement => {
  const parts = hulls[view.cls].parts;
  return (
    <div className="toggle-row">
      {parts.map((part, i) => (
        <ToggleButton
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
          key={i}
          label={`${i}·${part.prim.kind}`}
          size="sm"
          isPressed={i === sel.part}
          onPressedChange={() => selectPart(i)}
        />
      ))}
    </div>
  );
};

const PartOps = (): ReactElement => {
  const parts = hulls[view.cls].parts;
  return (
    <div className="toggle-row">
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
    </div>
  );
};

const ClipboardOps = (): ReactElement => {
  const [exportLabel, flashExport] = useFlash("export → clipboard");
  const [importLabel, flashImport] = useFlash("import ← clipboard");
  return (
    <div className="toggle-row">
      <Button
        label={exportLabel}
        size="sm"
        onClick={() => exportHull().then(flashExport)}
      />
      <Button
        label={importLabel}
        size="sm"
        onClick={() => importHull().then(flashImport)}
      />
    </div>
  );
};

export const DesignerPanel = (): ReactElement => {
  const hull = hulls[view.cls];
  const part = hull.parts[Math.min(sel.part, hull.parts.length - 1)];
  return (
    <VStack gap={3}>
      <Text type="label" as="p" color="accent" weight="semibold">
        hull designer — {view.cls}
      </Text>
      <div className="toggle-row">
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
      </div>
      <PartList />
      <PartOps />
      {part && <PartControls key={`${view.cls}:${sel.part}`} part={part} />}
      <Divider label="engines" variant="strong" />
      <EngineList />
      <ClipboardOps />
    </VStack>
  );
};
