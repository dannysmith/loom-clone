import { createApp } from "./app";
import { initDb } from "./db/client";
import { getAdminConfig } from "./lib/admin-auth";
import { cleanupStaleFiles, markStalledRecordingsIncomplete } from "./lib/cleanup";

await initDb();
console.log("[db] ready at data/app.db");

// Validate admin config eagerly so a misconfigured production deployment
// fails at startup rather than silently leaving /admin/* unprotected.
// In dev (NODE_ENV unset/!=production) this is a no-op when unset.
getAdminConfig();

const app = createApp();

// Bind to loopback by default — bearer tokens travel in plaintext over
// HTTP locally, so don't expose them on the LAN. Override with HOST=0.0.0.0
// only after task-x3 lands HTTPS termination in front of the server.
const port = Number(Bun.env.PORT ?? 3000);
const hostname = Bun.env.HOST ?? "127.0.0.1";

console.log(`[server] listening on http://${hostname}:${port}`);

// Daily maintenance: remove HLS segments/thumbnail candidates for videos that
// have been `ready` for >10 days, and mark recordings with no segment activity
// for >4h as `incomplete`. First run 60s after startup (avoids competing with
// in-flight derivative generation), then every 24h.
const runMaintenance = async () => {
  await cleanupStaleFiles().catch((err) => console.error("[cleanup] failed:", err));
  await markStalledRecordingsIncomplete().catch((err) =>
    console.error("[cleanup] incomplete sweep failed:", err),
  );
};
setTimeout(() => {
  runMaintenance();
  setInterval(runMaintenance, 24 * 60 * 60 * 1000);
}, 60_000);

export default {
  port,
  hostname,
  fetch: app.fetch,
  maxRequestBodySize: 1024 * 1024 * 1024, // 1 GB (Bun defaults to 128 MB)
};
