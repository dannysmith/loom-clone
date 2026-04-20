import { createApp } from "./app";
import { initDb } from "./db/client";

await initDb();
console.log("[db] ready at data/app.db");

const app = createApp();

// Bind to loopback by default — bearer tokens travel in plaintext over
// HTTP locally, so don't expose them on the LAN. Override with HOST=0.0.0.0
// only after task-x3 lands HTTPS termination in front of the server.
const port = Number(Bun.env.PORT ?? 3000);
const hostname = Bun.env.HOST ?? "127.0.0.1";

console.log(`[server] listening on http://${hostname}:${port}`);

export default {
  port,
  hostname,
  fetch: app.fetch,
};
