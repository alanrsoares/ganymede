// Drydock UI root: astryx gothic theme over the floating panels. The WebGPU
// canvas lives outside React (scene.ts owns it); panels overlay it.

import type { ReactElement } from "react";
import { AstryxRoot } from "~/astryx";
import { view } from "~/drydock/store";
import { ControlPanel } from "./ControlPanel";
import { DesignerPanel } from "./DesignerPanel";
import { useDrydock } from "./hooks";

export const App = (): ReactElement => {
  useDrydock();
  return view.gpuError ? (
    <div className="err">Drydock needs WebGPU: {view.gpuError}</div>
  ) : (
    <AstryxRoot>
      <div className="panel panel-left">
        <ControlPanel />
      </div>
      {view.design && (
        <div className="panel panel-right">
          <DesignerPanel />
        </div>
      )}
    </AstryxRoot>
  );
};
