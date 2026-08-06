import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { _setEditorManifestPathForTests, loadEntryAssets } from "../vite-manifest";

const originalEditorDev = Bun.env.EDITOR_DEV;

afterEach(() => {
  if (originalEditorDev === undefined) {
    delete Bun.env.EDITOR_DEV;
  } else {
    Bun.env.EDITOR_DEV = originalEditorDev;
  }
  _setEditorManifestPathForTests(null);
});

describe("loadEntryAssets", () => {
  test("EDITOR_DEV=1 serves Vite dev-server tags, ignoring any built manifest", () => {
    Bun.env.EDITOR_DEV = "1";
    // Point at a nonexistent manifest to prove the flag alone decides.
    _setEditorManifestPathForTests("/nonexistent/manifest.json");

    const { scripts } = loadEntryAssets("index.html");
    expect(scripts).toContain("http://localhost:5173/static/editor/@vite/client");
    expect(scripts).toContain("http://localhost:5173/static/editor/src/main.tsx");

    const cover = loadEntryAssets("cover.html");
    expect(cover.scripts).toContain("http://localhost:5173/static/editor/src/main-cover.tsx");
  });

  test("without EDITOR_DEV, a missing manifest throws instead of silently serving dev tags", () => {
    delete Bun.env.EDITOR_DEV;
    _setEditorManifestPathForTests("/nonexistent/manifest.json");

    expect(() => loadEntryAssets("index.html")).toThrow("Editor manifest missing");
  });

  test("without EDITOR_DEV, a present manifest resolves hashed asset tags", () => {
    delete Bun.env.EDITOR_DEV;
    const dir = mkdtempSync(join(tmpdir(), "vite-manifest-test-"));
    try {
      const manifestPath = join(dir, "manifest.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          "index.html": { file: "assets/editor-abc123.js", css: ["assets/editor-abc123.css"] },
        }),
      );
      _setEditorManifestPathForTests(manifestPath);

      const { scripts } = loadEntryAssets("index.html");
      expect(scripts).toContain('src="/static/editor/assets/editor-abc123.js"');
      expect(scripts).toContain('href="/static/editor/assets/editor-abc123.css"');

      // An entry the manifest doesn't know about is still an error.
      expect(() => loadEntryAssets("missing.html")).toThrow('missing entry "missing.html"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
