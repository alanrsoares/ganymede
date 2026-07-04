import index from "./index.html";

const server = Bun.serve({
  port: 3000,
  routes: {
    "/": index,
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`Circuit visualizer running at ${server.url}`);
