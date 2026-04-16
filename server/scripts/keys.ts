#!/usr/bin/env bun
/**
 * Tiny CLI for API key management. Run via the package.json scripts:
 *   bun run keys:create "macbook M2 Pro"
 *   bun run keys:list
 *   bun run keys:revoke <id>
 *
 * The plaintext token is printed exactly once on `create` and never
 * retrievable afterwards. Hashes are what land in the DB.
 */
import { initDb } from "../src/db/client";
import { createApiKey, listApiKeys, revokeApiKey } from "../src/lib/api-keys";

const USAGE = `Usage:
  bun run keys:create <name>
  bun run keys:list
  bun run keys:revoke <id>`;

async function main(): Promise<number> {
  await initDb();

  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "create": {
      const name = args[0]?.trim() ?? "";
      if (!name) {
        console.error("Missing <name>.\n");
        console.error(USAGE);
        return 2;
      }
      const { id, plaintext } = await createApiKey(name);
      console.log(`Created API key "${name}" (${id}).`);
      console.log("");
      console.log("Token (shown ONCE — store it now):");
      console.log("");
      console.log(`  ${plaintext}`);
      console.log("");
      return 0;
    }

    case "list": {
      const keys = await listApiKeys();
      if (keys.length === 0) {
        console.log("(no keys)");
        return 0;
      }
      // Plain text output, not JSON, because the typical caller is a human
      // at a terminal. JSON output can come later if a script ever needs it.
      for (const k of keys) {
        const status = k.revokedAt ? `revoked ${k.revokedAt}` : "active";
        const lastUsed = k.lastUsedAt ?? "never";
        console.log(`${k.id}  ${status.padEnd(28)}  last_used=${lastUsed}  ${k.name}`);
      }
      return 0;
    }

    case "revoke": {
      const [id] = args;
      if (!id) {
        console.error("Missing <id>.\n");
        console.error(USAGE);
        return 2;
      }
      const changed = await revokeApiKey(id);
      console.log(changed ? `Revoked ${id}.` : `${id} not found or already revoked.`);
      return 0;
    }

    default: {
      console.error(USAGE);
      return cmd ? 2 : 0;
    }
  }
}

const code = await main();
process.exit(code);
