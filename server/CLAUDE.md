# Server — AI Agent Notes

Hono + Bun app. Receives HLS segments from the macOS recorder, assembles playlists, generates MP4 derivatives via ffmpeg, and serves the viewer page. See `docs/developer/streaming-and-healing.md` at the repo root for how segments flow client → server.

## Scripts

All scripts run from `server/`:

- `bun run dev` — hot-reload dev server on `http://localhost:3000`. Do NOT start this unless explicitly asked.
- `bun test` — run the full test suite (Bun's built-in runner, bun:test APIs)
- `bun run test:watch` — re-run tests on file changes
- `bun run check` — Biome lint + format check (read-only)
- `bun run check:fix` — auto-fix lint + format issues
- `bun run lint` / `bun run lint:fix` — lint only
- `bun run format` / `bun run format:check` — format only
- `bun run typecheck` — `tsc --noEmit`

Before finishing a change, run `bun run check && bun run typecheck && bun test`.

## Testing

Tests live in `__tests__/` directories co-located with the modules they test. Follow the patterns in the existing tests — notably the `setupTestEnv`/`teardownTestEnv` helpers in `src/test-utils.ts` for per-test filesystem isolation.

Preferences:
- Prefer real filesystem over mocks (tests are fast and catch integration bugs).
- Routes: integration-style tests using `app.request(path, init)`.
- ffmpeg-dependent tests: gate on `Bun.which("ffmpeg") !== null` via `test.skipIf`.
- Test-only helpers go on the module they test, prefixed with `_` (e.g. `_resetForTests`, `_inFlightPromise`).

## Style

- Path imports use `"path"` / `"fs/promises"` (not `"node:..."`) — Bun accepts both; keep consistent with existing files.
- `noUncheckedIndexedAccess` is on. Array/record access gives `T | undefined` — destructure with defaults or guard explicitly.

## Gotchas

- **Module-level `await`** in `index.ts` calls `loadAllVideos()` at import. The `createApp()` factory is the side-effect-free entry for tests — do not import `index.ts` from tests.
- **`DATA_DIR = "data"`** is relative. Tests depend on this. When deployment comes it'll likely become env-configurable; until then, don't hard-code absolute paths.
- **Segment filename allowlist** in `routes/videos.ts` (`/^(init\.mp4|seg_\d+\.m4s)$/`) is the real path-traversal defense. Don't weaken it without understanding why it exists.
- **Derivatives are fire-and-forget.** `scheduleDerivatives(id)` returns immediately; the `/complete` response never waits on ffmpeg. Tests use `_inFlightPromise(id)` to await completion.
