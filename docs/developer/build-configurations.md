# Build Configurations (Debug vs Release)

The macOS app uses `#if DEBUG` / `#else` compile-time branching to fully isolate development from production. Running from Xcode (Debug) and running an installed release build use completely separate storage, so they never interfere with each other.

## What's separated

| Concern | Debug (Xcode) | Release (~/Applications) |
| --- | --- | --- |
| Server URL default | `http://127.0.0.1:3000` | Empty — must be configured (or set by install script) |
| UserDefaults suite | `is.danny.loomclone.debug` | `is.danny.loomclone` |
| Keychain service | `is.danny.loomclone.debug.apikey` | `is.danny.loomclone.apikey` |
| Local recordings | `~/Library/Application Support/LoomClone-Debug/recordings/` | `~/Library/Application Support/LoomClone/recordings/` |

All of this lives in `AppEnvironment.swift`. The bundle ID (`is.danny.loomclone`) is the same for both — isolation is achieved via named suites and service identifiers, not separate bundle IDs.

## Implications

- **API keys are per-environment.** You'll have a dev key (for your local server) and a prod key (for `v.danny.is`). Each is stored in its own Keychain entry.
- **UserDefaults don't overlap.** Changing the server URL in a debug build doesn't affect the release build's settings, and vice versa.
- **Recordings are physically separate.** The HealAgent only scans recordings from its own environment, so it won't try to heal debug recordings against the production server.
- **Keychain and UserDefaults persist across rebuilds.** Reinstalling the app doesn't lose your API key or server URL — only explicitly clearing them (via Settings or `security delete-generic-password`) removes them.

## Building a production release locally

Run the install script from the repo root:

```bash
app/scripts/install-prod.sh
```

This builds a Release configuration, copies it to `/Applications/LoomClone.app`, and ensures the server URL is set to `https://v.danny.is` in the release UserDefaults. The API key persists in the Keychain from previous runs — set it once via the app's Settings and it stays there across reinstalls.

## Day-to-day development

For normal development, just run from Xcode (Debug config) or `cd app && make build`. This hits your local server at `localhost:3000`. You don't need Docker running — bare `bun run dev` in `server/` is the fastest iteration loop.

The Docker setup (see [Deployment](deployment.md)) is for verifying the containerised server works and for production deployment. It's not part of the normal dev workflow.
