// Code tab: live catalog.ts-style TS snippet of the working hull (the plan's
// paste-back path) plus the JSON clipboard round-trip for saving/sharing
// whole hulls between sessions.

import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { HStack } from "@astryxdesign/core/Stack";
import { useToast } from "@astryxdesign/core/Toast";
import type { ReactElement } from "react";
import { hullToCatalogTs } from "~/drydock/codegen";
import { exportHull, hulls, importHull, view } from "~/drydock/store";

export const CodePreview = (): ReactElement => {
  const toast = useToast();
  return (
    <>
      <CodeBlock
        code={hullToCatalogTs(view.cls, hulls[view.cls])}
        language="ts"
        title={`${view.cls} — catalog paste-back`}
        size="sm"
        width="100%"
        onCopy={() => toast({ body: "TS snippet copied" })}
      />
      <HStack gap={1}>
        <Button
          label="export json"
          size="sm"
          variant="secondary"
          tooltip="whole hull as JSON — importable below"
          onClick={() =>
            exportHull().then((msg) =>
              toast({
                body: msg,
                type: msg.startsWith("copied") ? "info" : "error",
              }),
            )
          }
        />
        <Button
          label="import json"
          size="sm"
          variant="secondary"
          tooltip="replace this hull from clipboard JSON"
          onClick={() =>
            importHull().then((msg) =>
              toast({
                body: msg,
                type: msg.startsWith("imported") ? "info" : "error",
              }),
            )
          }
        />
      </HStack>
    </>
  );
};
