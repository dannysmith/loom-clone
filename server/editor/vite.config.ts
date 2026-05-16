import { resolve } from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "/static/editor/",
  build: {
    outDir: "../public/editor",
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: {
        editor: resolve(__dirname, "index.html"),
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
