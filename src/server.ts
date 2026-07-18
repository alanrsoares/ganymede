import type { ServerWebSocket } from "bun";
import drydock from "./drydock.html";
import index from "./index.html";

// --- drydock agent bridge -----------------------------------------------------
// The live drydock tab connects over WebSocket (agent-bridge.ts); external
// processes POST {cmd,args} to /api/agent, which relays to the tab and returns
// its reply. The server is a dumb pipe — command semantics live in the tab.
// Dev tooling only (bun run web); never part of the game build.

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let tab: ServerWebSocket<unknown> | null = null;
const pending = new Map<string, Pending>();
const AGENT_TIMEOUT_MS = 20_000;

const relay = (cmd: string, args: unknown): Promise<unknown> => {
  if (!tab) {
    return Promise.reject(
      new Error("no drydock tab connected — open /drydock"),
    );
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("drydock tab timed out"));
    }, AGENT_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    tab?.send(JSON.stringify({ id, cmd, args }));
  });
};

const settle = (raw: string): void => {
  const msg = JSON.parse(raw) as {
    id: string;
    result?: unknown;
    error?: string;
  };
  const p = pending.get(msg.id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error));
  else p.resolve(msg.result);
};

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/": index,
    "/drydock": drydock,
    "/agent-ws": (req, srv) =>
      srv.upgrade(req)
        ? undefined
        : new Response("expected websocket", { status: 426 }),
    "/api/agent": {
      POST: async (req) => {
        try {
          const { cmd, args } = (await req.json()) as {
            cmd?: string;
            args?: unknown;
          };
          return !cmd
            ? Response.json({ error: "missing cmd" }, { status: 400 })
            : Response.json({ result: await relay(cmd, args) });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          return Response.json({ error }, { status: 502 });
        }
      },
    },
    "/assets/*": (req) => {
      const url = new URL(req.url);
      const filePath = import.meta.dir + url.pathname;
      return new Response(Bun.file(filePath), {
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      });
    },
  },
  websocket: {
    open(ws) {
      tab = ws;
    },
    close(ws) {
      if (tab === ws) tab = null;
    },
    message(_ws, raw) {
      try {
        settle(typeof raw === "string" ? raw : raw.toString());
      } catch {
        // malformed reply — ignore; the pending request will time out
      }
    },
  },
  development: {
    hmr: true,
    console: true,
  },
});

const serverUpMsg = `Game: ${server.url}\nDesigner: ${server.url}drydock`;

console.log(serverUpMsg);
