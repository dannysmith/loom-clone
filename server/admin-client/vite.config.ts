import { resolve } from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The admin client: every React app served inside the admin panel. One entry
// per app, all built into `../public/admin-client/` (gitignored — the
// Dockerfile builds it at deploy time). The public viewer's player bundle is
// a deliberately separate package; see docs/developer/admin-client.md.
export default defineConfig({
  plugins: [react()],
  base: "/static/admin-client/",
  build: {
    outDir: "../public/admin-client",
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: {
        editor: resolve(__dirname, "editor.html"),
        cover: resolve(__dirname, "cover.html"),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/admin": "http://localhost:3000",
      "/static": "http://localhost:3000",
    },
  },
});
