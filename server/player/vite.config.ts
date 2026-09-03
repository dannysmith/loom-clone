import { resolve } from "path";
import { defineConfig } from "vite";

// Builds the self-hosted Vidstack player bundle into public/player/, which is
// COMMITTED to git (unlike public/admin-client/) so a deploy never depends on
// the npm registry. Why this stays a package of its own, separate from the
// admin client: docs/developer/admin-client.md.
export default defineConfig({
  base: "/static/player/",
  build: {
    outDir: "../public/player",
    emptyOutDir: true,
    manifest: true,
    // Vidstack ships native class private fields; without this Vite's
    // default browser targets would transpile them and bloat the bundle.
    target: "es2022",
    rollupOptions: {
      input: {
        player: resolve(__dirname, "src/player.ts"),
      },
    },
  },
});
