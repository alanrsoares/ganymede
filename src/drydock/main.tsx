// Drydock entry: mount the React designer chrome, wire global shortcuts,
// boot the WebGPU scene. GPU failure surfaces through the store so the UI
// can swap to an error screen.

import "@astryxdesign/core/astryx.css";
import { createRoot } from "react-dom/client";
import { App } from "~/drydock/ui/App";
import { startAgentBridge } from "./agent-bridge";
import { wireKeys } from "./keys";
import { startScene } from "./scene";
import { setGpuError } from "./store";

const canvas = document.getElementById("gpu-canvas") as HTMLCanvasElement;
const uiRoot = document.getElementById("ui-root") as HTMLElement;

createRoot(uiRoot).render(<App />);
wireKeys();
startScene(canvas).catch((err) => {
  setGpuError(err instanceof Error ? err.message : String(err));
});
startAgentBridge(canvas);
