// Drydock UI root: astryx gothic theme over the floating panels. The WebGPU
// canvas lives outside React (scene.ts owns it); panels overlay it.

import type { ReactElement } from "react";
import { AstryxRoot } from "~/astryx";
import { toggleControlDeck, view } from "~/drydock/store";
import { ControlPanel } from "./ControlPanel";
import { DesignerPanel } from "./DesignerPanel";
import { useDrydock } from "./hooks";

export const App = (): ReactElement => {
  useDrydock();
  const leftCollapsed = view.controlDeckCollapsed;
  return view.gpuError ? (
    <div className="err">
      WebGPU is required for the drydock: {view.gpuError}
    </div>
  ) : (
    <AstryxRoot>
      <div
        className={`panel panel-left${leftCollapsed ? " is-collapsed" : ""}`}
      >
        <button
          type="button"
          className="panel-collapse-toggle"
          aria-label={
            leftCollapsed ? "expand control deck" : "collapse control deck"
          }
          aria-expanded={!leftCollapsed}
          onClick={toggleControlDeck}
        >
          <span aria-hidden="true">‹</span>
        </button>
        {!leftCollapsed && <ControlPanel />}
      </div>
      {view.design && (
        <div className="panel panel-right">
          <DesignerPanel />
        </div>
      )}
    </AstryxRoot>
  );
};
