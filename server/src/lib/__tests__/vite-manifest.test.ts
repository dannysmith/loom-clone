import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { _setAdminClientManifestPathForTests, adminClientAssets } from "../vite-manifest";

const originalDevFlag = Bun.env.ADMIN_CLIENT_DEV;

afterEach(() => {
  if (originalDevFlag === undefined) {
    delete Bun.env.ADMIN_CLIENT_DEV;
  } else {
    Bun.env.ADMIN_CLIENT_DEV = originalDevFlag;
  }
  // Also drops anything the test cached.
  _setAdminClientManifestPathForTests(null);
});

describe("adminClientAssets", () => {
  test("ADMIN_CLIENT_DEV=1 serves Vite dev-server URLs, ignoring any built manifest", () => {
    Bun.env.ADMIN_CLIENT_DEV = "1";
    // Point at a nonexistent manifest to prove the flag alone decides.
    _setAdminClientManifestPathForTests("/nonexistent/manifest.json");

    const editor = adminClientAssets("editor");
    expect(editor.devClient).toBe("http://localhost:5173/static/admin-client/@vite/client");
    expect(editor.js).toBe("http://localhost:5173/static/admin-client/src/editor/main.tsx");
    expect(editor.css).toEqual([]);

    const cover = adminClientAssets("cover");
    expect(cover.js).toBe("http://localhost:5173/static/admin-client/src/cover/main.tsx");
  });

  test("without the flag, a missing manifest throws instead of silently serving dev URLs", () => {
    delete Bun.env.ADMIN_CLIENT_DEV;
    _setAdminClientManifestPathForTests("/nonexistent/manifest.json");

    expect(() => adminClientAssets("editor")).toThrow("Admin client manifest missing");
  });

  test("without the flag, a present manifest resolves hashed asset URLs", () => {
    delete Bun.env.ADMIN_CLIENT_DEV;
    const dir = mkdtempSync(join(tmpdir(), "vite-manifest-test-"));
    try {
      const manifestPath = join(dir, "manifest.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          "editor.html": { file: "assets/editor-abc123.js", css: ["assets/editor-abc123.css"] },
        }),
      );
      _setAdminClientManifestPathForTests(manifestPath);

      const editor = adminClientAssets("editor");
      expect(editor.js).toBe("/static/admin-client/assets/editor-abc123.js");
      expect(editor.css).toEqual(["/static/admin-client/assets/editor-abc123.css"]);
      expect(editor.devClient).toBeUndefined();

      // Cached: deleting the manifest doesn't change the answer for an entry
      // already resolved, but an entry the build didn't emit is still an error.
      rmSync(manifestPath);
      expect(adminClientAssets("editor").js).toBe("/static/admin-client/assets/editor-abc123.js");
      expect(() => adminClientAssets("cover")).toThrow("Admin client manifest missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a manifest without the requested entry names the entry and the build command", () => {
    delete Bun.env.ADMIN_CLIENT_DEV;
    const dir = mkdtempSync(join(tmpdir(), "vite-manifest-test-"));
    try {
      const manifestPath = join(dir, "manifest.json");
      writeFileSync(manifestPath, JSON.stringify({ "editor.html": { file: "assets/e.js" } }));
      _setAdminClientManifestPathForTests(manifestPath);

      expect(() => adminClientAssets("cover")).toThrow('missing entry "cover.html"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
