// Cache-busting for static assets. At startup, hashes all public static
// file contents to produce a version string. Templates use `staticUrl()`
// to append `?v=<hash>` — the URL changes whenever any file changes, so
// the CDN (BunnyCDN) and browsers cache aggressively with `immutable`.
//
// CSS files with `@import` get their import URLs rewritten at startup to
// include the version hash, so CDN-cached sub-files are busted too.

import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";

export const PUBLIC_ROOT = resolve(import.meta.dir, "..", "..", "public");

// Admin-only files bypass CDN cache via Edge Rule — exclude from hash
const CDN_BYPASS = new Set(["styles/admin.css", "js/admin.js"]);

function collectFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectFiles(full));
    } else {
      result.push(full);
    }
  }
  return result.sort();
}

function computeVersion(): string {
  const hash = createHash("sha256");
  for (const file of collectFiles(PUBLIC_ROOT)) {
    const rel = relative(PUBLIC_ROOT, file);
    if (!CDN_BYPASS.has(rel)) {
      hash.update(readFileSync(file));
    }
  }
  return hash.digest("hex").slice(0, 8);
}

export const STATIC_VERSION = computeVersion();

/** Versioned `/static/…` URL for use in HTML templates. */
export function staticUrl(path: string): string {
  return `/static/${path}?v=${STATIC_VERSION}`;
}

// --- CSS @import rewriting ---

const rewrittenCss = new Map<string, string>();

const stylesDir = join(PUBLIC_ROOT, "styles");
for (const file of collectFiles(stylesDir)) {
  const rel = relative(PUBLIC_ROOT, file);
  if (CDN_BYPASS.has(rel) || !file.endsWith(".css")) continue;
  const content = readFileSync(file, "utf-8");
  if (content.includes("@import url(")) {
    rewrittenCss.set(
      rel,
      content.replace(/@import url\("\.\/(.+?)"\)/g, `@import url("./$1?v=${STATIC_VERSION}")`),
    );
  }
}

/** Precomputed CSS with rewritten @import URLs, or undefined if no rewriting needed. */
export function getRewrittenCss(relativePath: string): string | undefined {
  return rewrittenCss.get(relativePath);
}
