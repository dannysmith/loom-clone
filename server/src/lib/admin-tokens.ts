import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client";
import { type AdminToken, adminTokens } from "../db/schema";
import { hashToken } from "./api-keys";

// Admin token prefix — distinct from the `lck_` recording API keys.
// Lets humans and secret-scanners instantly tell the two apart.
const TOKEN_PREFIX = "lca_";
const TOKEN_BYTES = 32;

function nowIso(): string {
  return new Date().toISOString();
}

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  const body = Buffer.from(bytes).toString("base64url");
  return `${TOKEN_PREFIX}${body}`;
}

export async function createAdminToken(name: string): Promise<{ id: string; plaintext: string }> {
  const db = getDb();
  const id = crypto.randomUUID();
  const plaintext = generateToken();
  const hashedToken = hashToken(plaintext);
  await db.insert(adminTokens).values({ id, name, hashedToken, createdAt: nowIso() });
  return { id, plaintext };
}

export async function verifyAdminToken(token: string): Promise<AdminToken | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const db = getDb();
  const hashed = hashToken(token);
  const [row] = await db
    .select()
    .from(adminTokens)
    .where(eq(adminTokens.hashedToken, hashed))
    .limit(1);
  if (!row || row.revokedAt !== null) return null;
  return row;
}

export async function listAdminTokens(): Promise<AdminToken[]> {
  return getDb().select().from(adminTokens).orderBy(desc(adminTokens.createdAt));
}

export async function revokeAdminToken(id: string): Promise<boolean> {
  const result = await getDb()
    .update(adminTokens)
    .set({ revokedAt: nowIso() })
    .where(and(eq(adminTokens.id, id), isNull(adminTokens.revokedAt)))
    .returning({ id: adminTokens.id });
  return result.length > 0;
}

export async function touchAdminTokenLastUsed(id: string): Promise<void> {
  await getDb().update(adminTokens).set({ lastUsedAt: nowIso() }).where(eq(adminTokens.id, id));
}
