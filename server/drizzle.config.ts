import { defineConfig } from "drizzle-kit";

// Path is relative to the server/ directory where drizzle-kit is invoked.
// The same file is used in-process at runtime (see src/db/client.ts) and
// also by `bun run db:migrate` when applying migrations from the CLI.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: "./data/app.db",
  },
});
