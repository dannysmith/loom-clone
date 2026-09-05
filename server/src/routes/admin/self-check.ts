import { Hono } from "hono";
import { runSelfCheck } from "../../lib/self-check";
import type { AdminEnv } from "./helpers";

// GET /admin/self-check — machine-readable health report. 200 + JSON when
// everything is fine, 503 + the failure list when not. A host cron curls this
// daily through the public origin URL (so one request exercises Caddy, TLS,
// the container, and the app together) and forwards the verdict to
// healthchecks.io. See docs/developer/operations.md for the wiring and the
// per-alert runbook. Auth is the standard admin gate (session or lca_ bearer),
// applied at the mount.
const selfCheck = new Hono<AdminEnv>();

selfCheck.get("/", async (c) => {
  const report = await runSelfCheck();
  return c.json(report, report.healthy ? 200 : 503);
});

export default selfCheck;
