// Resolves the asset URLs for the Vite-built entry points under
// `server/public/`. Two independent builds live there with opposite commit
// policies (see `docs/developer/admin-client.md`):
//
//   admin-client/  the admin React apps (editor, cover tool) — gitignored,
//                  built at deploy time, with an opt-in dev-server mode
//   player/        the self-hosted Vidstack bundle — committed to git
//
// Both return structured `EntryAssets`; turning those into `<link>`/`<script>`
// tags is the views' job, not this module's.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { PUBLIC_ROOT } from "./static-assets";

type ManifestEntry = { file: string; css?: string[] };
type Manifest = Record<string, ManifestEntry>;

/** Resolved URLs for one built entry point. */
export type EntryAssets = {
  js: string;
  css: string[];
  /** Vite's HMR client. Dev mode only, and must load before `js`. */
  devClient?: string;
};

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf-8")) as Manifest;
}

// --- Player (self-hosted Vidstack) ---
//
// Unlike the admin client, `public/player/` is a committed build artefact with
// no dev-server mode — a missing manifest is a hard error, not a fall-through.
// URLs are Vite content-hashed filenames, deliberately NOT `staticUrl()`:
// STATIC_VERSION hashes all of `public/`, so a CSS tweak elsewhere would
// otherwise bust the ~300 KB player bundle.

let playerCache: EntryAssets | null = null;

export function playerAssets(): EntryAssets {
  if (playerCache) return playerCache;

  const manifestPath = join(PUBLIC_ROOT, "player", ".vite", "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      "Player manifest missing. Run `bun run player:build` in server/ (the output in public/player/ is committed — this should never happen on a clean checkout).",
    );
  }
  const entry = readManifest(manifestPath)["src/player.ts"];
  if (!entry?.file) {
    throw new Error('Player manifest is missing the "src/player.ts" entry.');
  }
  playerCache = {
    js: `/static/player/${entry.file}`,
    css: (entry.css ?? []).map((f) => `/static/player/${f}`),
  };
  return playerCache;
}

// --- Admin client (editor + cover tool) ---

// One record per Vite entry: the manifest key (which is the HTML entry's path,
// matching `rollupOptions.input` in admin-client/vite.config.ts) and the source
// module the dev server serves in its place.
const ADMIN_CLIENT_ENTRIES = {
  editor: { html: "editor.html", module: "src/editor/main.tsx" },
  cover: { html: "cover.html", module: "src/cover/main.tsx" },
} as const;

export type AdminClientEntry = keyof typeof ADMIN_CLIENT_ENTRIES;

const DEV_ORIGIN = "http://localhost:5173/static/admin-client";

const DEFAULT_MANIFEST_PATH = join(PUBLIC_ROOT, "admin-client", ".vite", "manifest.json");
let manifestPath = DEFAULT_MANIFEST_PATH;
const adminClientCache = new Map<AdminClientEntry, EntryAssets>();

/**
 * Test-only: point the admin-client manifest lookup elsewhere and drop the
 * cached results (null restores the default path).
 */
export function _setAdminClientManifestPathForTests(path: string | null): void {
  manifestPath = path ?? DEFAULT_MANIFEST_PATH;
  adminClientCache.clear();
}

export function adminClientAssets(entry: AdminClientEntry): EntryAssets {
  // Dev mode is an explicit opt-in (ADMIN_CLIENT_DEV=1), not a file-presence
  // check. The old `existsSync(manifest)` heuristic failed in both directions:
  // a missing production build silently served localhost:5173 script tags (a
  // blank page with no error), and a stale local build disabled HMR forever.
  //
  // Deliberately uncached: there's no manifest read to save, and a cached dev
  // result would outlive a change to the env var.
  if (Bun.env.ADMIN_CLIENT_DEV === "1") {
    return {
      js: `${DEV_ORIGIN}/${ADMIN_CLIENT_ENTRIES[entry].module}`,
      css: [],
      devClient: `${DEV_ORIGIN}/@vite/client`,
    };
  }

  const cached = adminClientCache.get(entry);
  if (cached) return cached;

  if (!existsSync(manifestPath)) {
    throw new Error(
      "Admin client manifest missing at public/admin-client/.vite/manifest.json. " +
        "Run `bun run admin-client:build` in server/, or set ADMIN_CLIENT_DEV=1 and " +
        "start the Vite dev server (`bun run admin-client:dev`) for HMR.",
    );
  }
  const key = ADMIN_CLIENT_ENTRIES[entry].html;
  const found = readManifest(manifestPath)[key];
  if (!found?.file) {
    throw new Error(
      `Vite manifest is missing entry "${key}". Run \`bun run admin-client:build\` in server/.`,
    );
  }
  const assets: EntryAssets = {
    js: `/static/admin-client/${found.file}`,
    css: (found.css ?? []).map((f) => `/static/admin-client/${f}`),
  };
  adminClientCache.set(entry, assets);
  return assets;
}
