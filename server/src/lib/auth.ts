import type { MiddlewareHandler } from "hono";
import { touchLastUsed, verifyApiKey } from "./api-keys";
import type { ErrorCodeValue } from "./errors";

// Variables shape exposed on `c.var` / `c.set` / `c.get` once this
// middleware has run. Routes can `import type { AuthVariables } from "..."`
// and parameterise their `Hono<{ Variables: AuthVariables }>` to get
// strongly-typed access to the authenticated key id.
export type AuthVariables = {
  apiKeyId: string;
};

// RFC 6750 §3: the WWW-Authenticate value on a 401 must state the scheme
// and may include a realm. No `error=` because that's only required when
// responding to a request that did carry a bearer token.
const WWW_AUTHENTICATE = 'Bearer realm="loom-clone"';

function unauthorized(message: string, code: ErrorCodeValue): Response {
  // Never echo the presented token back — that's an information leak vector
  // if the 401 lands in a log aggregator the caller doesn't control.
  return new Response(JSON.stringify({ error: message, code }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": WWW_AUTHENTICATE,
    },
  });
}

// Middleware that gates downstream routes on a valid API key. Returns 401
// (not 403) for missing/invalid/revoked tokens — the caller is unknown
// until we successfully authenticate them, so "unauthorized" is accurate.
// `touchLastUsed` fires asynchronously; we don't block the response on it.
export function requireApiKey(): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const header = c.req.header("authorization");
    if (!header) return unauthorized("Missing Authorization header", "MISSING_AUTH_HEADER");

    // Case-insensitive scheme match per RFC 7235 §2.1 ("Bearer" is a
    // token; schemes are case-insensitive). Strict " " separator keeps
    // the parse simple; no need to accept tab etc.
    const match = /^Bearer (.*)$/i.exec(header);
    if (!match) return unauthorized("Malformed Authorization header", "MALFORMED_AUTH_HEADER");
    const token = match[1]?.trim();
    if (!token) return unauthorized("Empty bearer token", "EMPTY_BEARER_TOKEN");

    const key = await verifyApiKey(token);
    if (!key) return unauthorized("Invalid or revoked API key", "INVALID_API_KEY");

    // Fire-and-forget; surfaces in logs if it rejects but never blocks
    // the caller. A failed write here should not 500 an upload.
    touchLastUsed(key.id).catch((err: unknown) => {
      console.error(`[auth] touchLastUsed failed for key ${key.id}:`, err);
    });

    // Stash the authenticated key id on the context for future auditing
    // (event log, admin UI). Routes that care can read it; most won't.
    c.set("apiKeyId", key.id);
    await next();
  };
}
