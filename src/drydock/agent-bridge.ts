// Drydock agent bridge: the live tab's end of the external control surface.
// Connects to the dev server's /agent-ws relay and answers commands an
// external process sends via POST /api/agent — the same store actions the UI
// drives, plus a screenshot of the live WebGPU canvas so a vision agent can
// close the design loop. Dev-only (localhost); a no-op anywhere else.

import { SHIP_CLASSES, type ShipClass } from "~/hull/catalog";
import type { HullOp } from "./ops";
import {
  applyOps,
  hulls,
  resetClass,
  sel,
  selectPart,
  setCls,
  setDesign,
  undo,
  view,
} from "./store";

/** Current class summary — the reply shape for every state-changing command. */
const snapshot = () => ({
  cls: view.cls,
  classes: SHIP_CLASSES,
  design: view.design,
  partCount: hulls[view.cls].parts.length,
  engineCount: hulls[view.cls].engines.length,
  selected: sel.part,
  hull: hulls[view.cls],
});

const isClass = (c: unknown): c is ShipClass =>
  SHIP_CLASSES.includes(c as ShipClass);

/** Grab the current frame. requestAnimationFrame aligns capture with a fresh
 * paint so the WebGPU canvas isn't read mid-present (blank). */
const screenshot = (canvas: HTMLCanvasElement): Promise<{ dataUrl: string }> =>
  new Promise((res) =>
    requestAnimationFrame(() =>
      res({ dataUrl: canvas.toDataURL("image/png") }),
    ),
  );

type Args = Record<string, unknown>;
type Command = (args: Args, canvas: HTMLCanvasElement) => unknown;

const COMMANDS: Record<string, Command> = {
  getState: () => snapshot(),
  getAll: () => hulls,
  listClasses: () => SHIP_CLASSES,
  setClass: ({ cls }) => {
    if (!isClass(cls)) throw new Error(`unknown class: ${String(cls)}`);
    setCls(cls);
    return snapshot();
  },
  selectPart: ({ index }) => {
    selectPart(Number(index) || 0);
    return snapshot();
  },
  applyOps: ({ ops }) => {
    if (!Array.isArray(ops)) throw new Error("applyOps needs an ops array");
    return { applied: applyOps(ops as HullOp[], "agent"), ...snapshot() };
  },
  reset: () => {
    resetClass();
    return snapshot();
  },
  undo: () => {
    undo();
    return snapshot();
  },
  setDesign: ({ on }) => {
    setDesign(!!on);
    return snapshot();
  },
  screenshot: (_args, canvas) => screenshot(canvas),
};

interface Request {
  id: string;
  cmd: string;
  args?: Args;
}

const handle = async (
  req: Request,
  canvas: HTMLCanvasElement,
): Promise<unknown> => {
  const command = COMMANDS[req.cmd];
  if (!command) throw new Error(`unknown cmd: ${req.cmd}`);
  return await command(req.args ?? {}, canvas);
};

/** Connect to the relay and serve commands. Auto-reconnects; only runs on the
 * dev host (the relay only exists under `bun run web`). */
export const startAgentBridge = (canvas: HTMLCanvasElement): void => {
  const { hostname, host } = location;
  if (hostname !== "localhost" && hostname !== "127.0.0.1") return;

  const connect = (): void => {
    const ws = new WebSocket(`ws://${host}/agent-ws`);
    ws.onmessage = async (e) => {
      let id = "";
      try {
        const req = JSON.parse(e.data) as Request;
        id = req.id;
        ws.send(JSON.stringify({ id, result: await handle(req, canvas) }));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        ws.send(JSON.stringify({ id, error }));
      }
    };
    ws.onclose = () => setTimeout(connect, 1500);
    ws.onerror = () => ws.close();
  };
  connect();
};
