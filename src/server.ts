import drydock from "./drydock.html";
import index from "./index.html";

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/": index,
    "/drydock": drydock,
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
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`Ganymede running at ${server.url}`);
