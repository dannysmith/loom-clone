# Auth

One-page tour of how the macOS app authenticates to the server. Single-user project; a bearer token is the right primitive.

## The model in one paragraph

The server issues long-lived API keys. The macOS app stores one in the system Keychain and sends it as `Authorization: Bearer <token>` on every call to `/api/videos/*`. The server stores only the SHA-256 hash of each token; plaintext is shown once at creation and never recoverable. Keys can be named (for human readability), listed, and revoked. Everything else on the server — `/api/health`, `/v/:slug`, `/data/*`, `/static/*`, `/admin` — is open.

## Token format

```
lck_<43 chars of base64url>
```

- `lck_` — "loom-clone key" — is a public prefix so a leaked token is visibly identifiable in logs or screenshots, and trivially grep-able by secret scanners.
- The body is 32 random bytes (256 bits of entropy) from `crypto.getRandomValues`, encoded base64url.

## Server

**Schema** (`server/src/db/schema.ts`): `api_keys(id, name, hashed_token, created_at, last_used_at, revoked_at)`. `hashed_token` is uniquely indexed.

**Key lib** (`server/src/lib/api-keys.ts`): `createApiKey`, `verifyApiKey`, `listApiKeys`, `revokeApiKey`, `touchLastUsed`. SHA-256 hash of the plaintext is looked up by indexed equality — no byte-by-byte constant-time comparison. For 256-bit random tokens the practical timing leak is negligible; revisit if auth rate-limiting is ever added.

**Middleware** (`server/src/lib/auth.ts`): `requireApiKey()` is a Hono middleware. On a bad/missing/revoked token it returns `401` with `WWW-Authenticate: Bearer realm="loom-clone"`. On success it fire-and-forgets `touchLastUsed(id)` and stashes `apiKeyId` on the Hono context (typed via `AuthVariables`).

**Mount point** (`server/src/app.ts`): `app.use("/api/videos/*", requireApiKey())`. Placed at the mount-point rather than inside the `videos` sub-app so that sub-app stays auth-agnostic and tests can exercise routes directly via `videos.request(...)`.

**CLI** (`server/scripts/keys.ts`):

```bash
bun run keys:create "macbook"   # prints the token ONCE
bun run keys:list
bun run keys:revoke <id>        # idempotent
```

## macOS

**Keychain wrapper** (`app/LoomClone/Helpers/APIKeyStore.swift`): `read() -> String?`, `write(_:) throws`, `delete() throws`. Uses `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — readable in the background after first unlock, not synced via iCloud Keychain.

**HTTP client** (`app/LoomClone/Pipeline/APIClient.swift`): thin facade over `URLSession`. Owns the base URL and the auth header injection. `authorizedRequest(path:)` attaches `Authorization: Bearer <token>`; throws `.missingAPIKey` if nothing is stored. `send` and `upload` throw `.unauthorized` on 401 so callers don't repeat that check.

**Observable surface** (`app/LoomClone/Helpers/APIKeyStatus.swift`): `@Observable` singleton with `hasKey: Bool`. SwiftUI views bind to it; `refresh()` is called after any write/delete and when the popover opens. The Keychain has no notification mechanism, so this is a cache that must be refreshed on known-mutation boundaries.

**Settings UI** (`app/LoomClone/UI/SettingsView.swift`): standard SwiftUI `Settings` scene (Cmd+,). Single field, Save, Clear. The popover also shows an "Open Settings" link when no key is configured, and the Record button is gated on both server reachability AND a stored key.

## Lifecycle

1. Start the server (`bun run dev`).
2. Create a key: `bun run keys:create "macbook"`.
3. Copy the `lck_…` token, open the app's Settings (Cmd+, or the in-popover Settings… link), paste, Save.
4. Record. Every API call now carries the token.
5. If the key needs rotating: `bun run keys:revoke <id>` then `keys:create` a new one; paste it back into Settings.

## What's not here, and why

- **Password hashing (bcrypt/argon2)** — wrong tool for high-entropy tokens; would slow verification for no security gain.
- **Rate limiting on auth failures** — single-user scale, not worth the complexity until the first abuse event (which in practice would be never).
- **Per-key scopes / read-only keys** — YAGNI for a single user.
- **Token refresh / expiry** — long-lived tokens with manual rotation are fine at this scale.
- **HTTPS enforcement** — a task-x3 (deploy) concern. Plaintext bearer over HTTP is acceptable on localhost only. Before `HOST` moves off `127.0.0.1`, HTTPS must be in place (bearer tokens over plain HTTP are trivially interceptable).
- **Admin panel auth** — Phase 6 concern, different mechanism (sessions, not API keys). Deliberately not conflated.
