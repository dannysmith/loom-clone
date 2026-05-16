// Loads the script/CSS tags for a Vite-built entry point under
// `server/public/editor/`. In production the Vite manifest is present and
// we read the hashed asset filenames from it; in dev the manifest is absent
// and we point at the Vite dev server (HMR) instead.
//
// `entryName` is the manifest key — e.g. `"index.html"` or `"cover.html"` —
// which matches the per-entry `rollupOptions.input` map in vite.config.ts.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { PUBLIC_ROOT } from "./static-assets";

type ManifestEntry = { file: string; css?: string[] };
type Manifest = Record<string, ManifestEntry>;

export function loadEntryAssets(entryName: string): { scripts: string } {
  const manifestPath = join(PUBLIC_ROOT, "editor", ".vite", "manifest.json");

  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
    const entry = manifest[entryName];
    if (!entry?.file) {
      throw new Error(
        `Vite manifest is missing entry "${entryName}". Run \`bun run build\` in server/editor.`,
      );
    }
    const css = (entry.css ?? [])
      .map((f) => `<link rel="stylesheet" href="/static/editor/${f}">`)
      .join("\n    ");
    const script = `<script type="module" src="/static/editor/${entry.file}"></script>`;
    return { scripts: `${css}\n    ${script}` };
  }

  // Dev: load from Vite dev server for HMR. The entry filename maps to its
  // matching source module — e.g. `index.html` → `src/main.tsx`,
  // `cover.html` → `src/main-cover.tsx`.
  const moduleForEntry: Record<string, string> = {
    "index.html": "src/main.tsx",
    "cover.html": "src/main-cover.tsx",
  };
  const mod = moduleForEntry[entryName] ?? "src/main.tsx";
  const scripts = [
    '<script type="module" src="http://localhost:5173/static/editor/@vite/client"></script>',
    `<script type="module" src="http://localhost:5173/static/editor/${mod}"></script>`,
  ].join("\n    ");
  return { scripts };
}
