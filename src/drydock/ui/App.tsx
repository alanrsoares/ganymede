// Drydock UI root: astryx gothic theme over the floating panels. The WebGPU
// canvas lives outside React (scene.ts owns it); panels overlay it.

import { Theme } from "@astryxdesign/core/theme";
import { gothicTheme } from "@astryxdesign/theme-gothic/built";
import type { ReactElement } from "react";
import { view } from "~/drydock/store";
import { ControlPanel } from "./ControlPanel";
import { DesignerPanel } from "./DesignerPanel";
import { useDrydock } from "./hooks";

export const App = (): ReactElement => {
  useDrydock();
  return view.gpuError ? (
    <div className="err">Drydock needs WebGPU: {view.gpuError}</div>
  ) : (
    <Theme theme={gothicTheme} mode="dark">
      <div className="panel panel-left">
        <ControlPanel />
      </div>
      {view.design && (
        <div className="panel panel-right">
          <DesignerPanel />
        </div>
      )}
    </Theme>
  );
};
