import { createHash } from "crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client";
import { type ApiKey, apiKeys } from "../db/schema";

// Visible prefix on every issued token. Two purposes: (a) lets a human
// glance at a string and recognise "this is a loom-clone API key", which
// matters when a token leaks into a log or screenshot, and (b) lets future
// secret-scanning tools (gitleaks etc.) match it cheaply.
const TOKEN_PREFIX = "lck_";
// 32 random bytes = 256 bits of entropy. base64url ≈ 43 chars.
const TOKEN_BYTES = 32;

function nowIso(): string {
  return new Date().toISOString();
}

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  // Bun runs in Node-compatible envs; Buffer.toString("base64url") is
  // reliable here. Avoids manual base64 → base64url conversion.
  const body = Buffer.from(bytes).toString("base64url");
  return `${TOKEN_PREFIX}${body}`;
}

// SHA-256 — not bcrypt/argon2. API keys are high-entropy random tokens, not
// low-entropy passwords; password-hashing functions buy you nothing here
// and just slow down request verification. The threat we're defending
// against is DB exfiltration; sha256 of a 256-bit secret is uncrackable.
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// Note on timing attacks: we look up by indexed hash (`WHERE hashed_token = ?`)
// rather than fetching all rows and constant-time-comparing. With 256 bits
// of entropy per token the info an attacker can extract from byte-level
// comparison timing is negligible in practice — they'd need vastly more
// queries than any rate-limit would allow. If Phase 5 ever adds auth
// rate-limiting we should revisit, but at single-user scale this is fine.

// Returns the plaintext token exactly once. The caller (CLI script) prints
// it to stdout; we never store it. The DB only ever sees the hash.
export async function createApiKey(name: string): Promise<{ id: string; plaintext: string }> {
  const db = getDb();
  const id = crypto.randomUUID();
  const plaintext = generateToken();
  const hashedToken = hashToken(plaintext);
  await db.insert(apiKeys).values({ id, name, hashedToken, createdAt: nowIso() });
  return { id, plaintext };
}

// Lookup by hash, then check it's not revoked. Returns the row or null.
// Caller is responsible for the bearer parsing — this just takes a token.
export async function verifyApiKey(token: string): Promise<ApiKey | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const db = getDb();
  const hashed = hashToken(token);
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.hashedToken, hashed)).limit(1);
  if (!row || row.revokedAt !== null) return null;
  return row;
}

export async function listApiKeys(): Promise<ApiKey[]> {
  const db = getDb();
  return db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt));
}

// Idempotent: revoking an already-revoked key is a no-op (we don't refresh
// `revokedAt`). Returns whether anything actually changed, so the CLI can
// distinguish "ok, done" from "already revoked".
export async function revokeApiKey(id: string): Promise<boolean> {
  const db = getDb();
  const result = await db
    .update(apiKeys)
    .set({ revokedAt: nowIso() })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return result.length > 0;
}

// Fire-and-forget bookkeeping. Failures here must NOT block a request, so
// the middleware swallows the promise. We update unconditionally on every
// successful auth — at single-user scale this is one extra UPDATE per
// request, well within budget.
export async function touchLastUsed(id: string): Promise<void> {
  const db = getDb();
  await db.update(apiKeys).set({ lastUsedAt: nowIso() }).where(eq(apiKeys.id, id));
}
