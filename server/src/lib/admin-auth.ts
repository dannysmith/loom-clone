import { createHash } from "crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { touchAdminTokenLastUsed, verifyAdminToken } from "./admin-tokens";

// ---------- Config ----------

export interface AdminConfig {
  username: string;
  password: string;
  sessionSecret: string;
}

// Returns null when admin auth is not configured (dev mode).
export function getAdminConfig(): AdminConfig | null {
  const password = Bun.env.ADMIN_PASSWORD;
  if (!password) return null;

  const sessionSecret = Bun.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error("SESSION_SECRET env var is required when ADMIN_PASSWORD is set");
  }

  return {
    username: Bun.env.ADMIN_USERNAME ?? "admin",
    password,
    sessionSecret,
  };
}

// ---------- Credentials ----------

// Constant-time comparison via SHA-256: always compares 32 bytes regardless
// of input length. Overkill at single-user scale but costs nothing.
function safeCompare(a: string, b: string): boolean {
  const h1 = createHash("sha256").update(a).digest();
  const h2 = createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(h1, h2);
}

export function verifyCredentials(
  config: AdminConfig,
  username: string,
  password: string,
): boolean {
  return safeCompare(username, config.username) && safeCompare(password, config.password);
}

// ---------- Sessions ----------

const COOKIE_NAME = "lc_session";
const SESSION_MAX_AGE = 14 * 24 * 60 * 60; // 2 weeks in seconds

interface SessionPayload {
  u: string; // username
  exp: number; // expiry (epoch ms)
}

export async function createSession(c: Context, config: AdminConfig): Promise<void> {
  const payload: SessionPayload = {
    u: config.username,
    exp: Date.now() + SESSION_MAX_AGE * 1000,
  };
  await setSignedCookie(c, COOKIE_NAME, JSON.stringify(payload), config.sessionSecret, {
    httpOnly: true,
    secure: isSecureContext(c),
    sameSite: "Lax",
    path: "/admin",
    maxAge: SESSION_MAX_AGE,
  });
}

export async function getSession(c: Context, secret: string): Promise<string | null> {
  const raw = await getSignedCookie(c, secret, COOKIE_NAME);
  if (!raw) return null;

  try {
    const payload = JSON.parse(raw) as SessionPayload;
    if (!payload.u || !payload.exp) return null;
    if (Date.now() > payload.exp) return null;
    return payload.u;
  } catch {
    return null;
  }
}

export function clearSession(c: Context): void {
  deleteCookie(c, COOKIE_NAME, { path: "/admin" });
}

function isSecureContext(c: Context): boolean {
  // Don't set Secure flag on localhost — browsers won't send it back.
  const host = c.req.header("host") ?? "";
  return !host.startsWith("localhost") && !host.startsWith("127.0.0.1");
}

// ---------- Middleware ----------

export type AdminAuthMethod = "session" | "bearer";

// Protects admin routes. Accepts either a valid session cookie or a valid
// `lca_` admin bearer token. HTML requests (no Authorization header) get
// redirected to login; programmatic requests (with Authorization) get 401.
// Sets `c.set("adminAuthMethod", ...)` so downstream middleware (e.g. CSRF)
// can distinguish cookie-based from bearer-based auth.
export function requireAdmin(): MiddlewareHandler {
  return async (c, next) => {
    const config = getAdminConfig();

    // Dev mode: no auth configured, everything passes through.
    if (!config) return next();

    // 1. Check session cookie
    const user = await getSession(c, config.sessionSecret);
    if (user) {
      c.set("adminAuthMethod", "session" as AdminAuthMethod);
      return next();
    }

    // 2. Check admin bearer token
    const authHeader = c.req.header("authorization");
    if (authHeader) {
      const match = /^Bearer (.*)$/i.exec(authHeader);
      const token = match?.[1]?.trim();
      if (token) {
        const adminToken = await verifyAdminToken(token);
        if (adminToken) {
          touchAdminTokenLastUsed(adminToken.id).catch((err: unknown) => {
            console.error(`[admin-auth] touchLastUsed failed for token ${adminToken.id}:`, err);
          });
          c.set("adminAuthMethod", "bearer" as AdminAuthMethod);
          return next();
        }
      }
      // Had an Authorization header but it was invalid — return 401.
      return c.json({ error: "Invalid or revoked admin token", code: "INVALID_ADMIN_TOKEN" }, 401);
    }

    // 3. No valid auth — redirect to login
    return c.redirect("/admin/login");
  };
}
