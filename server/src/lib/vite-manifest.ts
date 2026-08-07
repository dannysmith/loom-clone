// Loads the script/CSS tags for Vite-built entry points under
// `server/public/`. Normally the Vite manifest is present and we read the
// hashed asset filenames from it; with `EDITOR_DEV=1` set, the editor
// entries point at the Vite dev server (HMR) instead.
//
// `entryName` is the manifest key — e.g. `"index.html"` or `"cover.html"` —
// which matches the per-entry `rollupOptions.input` map in vite.config.ts.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { PUBLIC_ROOT } from "./static-assets";

type ManifestEntry = { file: string; css?: string[] };
type Manifest = Record<string, ManifestEntry>;

// --- Player (self-hosted Vidstack) ---
//
// Unlike the editor, `public/player/` is a committed build artefact with no
// dev-server mode — a missing manifest is a hard error, not a fall-through.
// URLs are Vite content-hashed filenames, deliberately NOT `staticUrl()`:
// STATIC_VERSION hashes all of `public/`, so a CSS tweak elsewhere would
// otherwise bust the ~300 KB player bundle.

export type PlayerAssets = { js: string; css: string[] };

let playerAssetsCache: PlayerAssets | null = null;

export function playerAssets(): PlayerAssets {
  if (playerAssetsCache) return playerAssetsCache;

  const manifestPath = join(PUBLIC_ROOT, "player", ".vite", "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      "Player manifest missing. Run `bun run player:build` in server/ (the output in public/player/ is committed — this should never happen on a clean checkout).",
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
  const entry = manifest["src/player.ts"];
  if (!entry?.file) {
    throw new Error('Player manifest is missing the "src/player.ts" entry.');
  }
  playerAssetsCache = {
    js: `/static/player/${entry.file}`,
    css: (entry.css ?? []).map((f) => `/static/player/${f}`),
  };
  return playerAssetsCache;
}

// --- Editor ---

const DEFAULT_EDITOR_MANIFEST = join(PUBLIC_ROOT, "editor", ".vite", "manifest.json");
let editorManifestPath = DEFAULT_EDITOR_MANIFEST;

/** Test-only: point the editor manifest lookup elsewhere (null restores the default). */
export function _setEditorManifestPathForTests(path: string | null): void {
  editorManifestPath = path ?? DEFAULT_EDITOR_MANIFEST;
}

export function loadEntryAssets(entryName: string): { scripts: string } {
  // Dev mode is an explicit opt-in (EDITOR_DEV=1), not a file-presence check.
  // The old `existsSync(manifest)` heuristic failed in both directions: a
  // missing production build silently served localhost:5173 script tags (a
  // blank page with no error), and a stale local build disabled HMR forever.
  if (Bun.env.EDITOR_DEV === "1") {
    // Load from the Vite dev server for HMR. The entry filename maps to its
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

  if (!existsSync(editorManifestPath)) {
    throw new Error(
      "Editor manifest missing at public/editor/.vite/manifest.json. " +
        "Run `bun run editor:build` in server/, or set EDITOR_DEV=1 and start " +
        "the Vite dev server (`bun run editor:dev`) for HMR.",
    );
  }
  const manifest = JSON.parse(readFileSync(editorManifestPath, "utf-8")) as Manifest;
  const entry = manifest[entryName];
  if (!entry?.file) {
    throw new Error(
      `Vite manifest is missing entry "${entryName}". Run \`bun run editor:build\` in server/.`,
    );
  }
  const css = (entry.css ?? [])
    .map((f) => `<link rel="stylesheet" href="/static/editor/${f}">`)
    .join("\n    ");
  const script = `<script type="module" src="/static/editor/${entry.file}"></script>`;
  return { scripts: `${css}\n    ${script}` };
}
