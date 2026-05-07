# Auth

How authentication works across the system. Two separate mechanisms serve different purposes: API keys (`lck_`) authenticate the macOS app's recording API calls, and admin auth (sessions + `lca_` tokens) protects the web admin panel.

## API keys (`lck_`) — macOS app → server

### The model in one paragraph

The server issues long-lived API keys. The macOS app stores one in the system Keychain and sends it as `Authorization: Bearer <token>` on every call to `/api/videos/*`. The server stores only the SHA-256 hash of each token; plaintext is shown once at creation and never recoverable. Keys can be named (for human readability), listed, and revoked.

### Token format

```
lck_<43 chars of base64url>
```

- `lck_` — "loom-clone key" — is a public prefix so a leaked token is visibly identifiable in logs or screenshots, and trivially grep-able by secret scanners.
- The body is 32 random bytes (256 bits of entropy) from `crypto.getRandomValues`, encoded base64url.

### Server

**Schema** (`server/src/db/schema.ts`): `api_keys(id, name, hashed_token, created_at, last_used_at, revoked_at)`. `hashed_token` is uniquely indexed.

**Key lib** (`server/src/lib/api-keys.ts`): `createApiKey`, `verifyApiKey`, `listApiKeys`, `revokeApiKey`, `touchLastUsed`. SHA-256 hash of the plaintext is looked up by indexed equality.

**Middleware** (`server/src/lib/auth.ts`): `requireApiKey()` is a Hono middleware. On a bad/missing/revoked token it returns `401` with `WWW-Authenticate: Bearer realm="loom-clone"` and a JSON body following the standard error envelope: `{ error: "<message>", code: "<MACHINE_CODE>" }`. Codes: `MISSING_AUTH_HEADER`, `MALFORMED_AUTH_HEADER`, `EMPTY_BEARER_TOKEN`, `INVALID_API_KEY`. On success it fire-and-forgets `touchLastUsed(id)` and stashes `apiKeyId` on the Hono context (typed via `AuthVariables`).

**Mount point** (`server/src/app.ts`): `app.use("/api/videos/*", requireApiKey())`. Placed at the mount-point rather than inside the `videos` sub-app so that sub-app stays auth-agnostic and tests can exercise routes directly via `videos.request(...)`.

**CLI** (`server/scripts/keys.ts`):

```bash
bun run keys:create "macbook"   # prints the token ONCE
bun run keys:list
bun run keys:revoke <id>        # idempotent
```

### macOS

**Keychain wrapper** (`app/LoomClone/Helpers/APIKeyStore.swift`): `read() -> String?`, `write(_:) throws`, `delete() throws`. Uses `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — readable in the background after first unlock, not synced via iCloud Keychain.

**HTTP client** (`app/LoomClone/Pipeline/APIClient.swift`): thin facade over `URLSession`. Owns the base URL and the auth header injection. `authorizedRequest(path:)` attaches `Authorization: Bearer <token>`; throws `.missingAPIKey` if nothing is stored. `send` and `upload` throw `.unauthorized` on 401 so callers don't repeat that check.

**Observable surface** (`app/LoomClone/Helpers/APIKeyStatus.swift`): `@Observable` singleton with `hasKey: Bool`. SwiftUI views bind to it; `refresh()` is called after any write/delete and when the popover opens. The Keychain has no notification mechanism, so this is a cache that must be refreshed on known-mutation boundaries.

**Settings UI** (`app/LoomClone/UI/SettingsView.swift`): standard SwiftUI `Settings` scene (Cmd+,). Single field, Save, Clear. The popover also shows an "Open Settings" link when no key is configured, and the Record button is gated on both server reachability AND a stored key.

### Lifecycle

1. Start the server (`bun run dev`).
2. Create a key: `bun run keys:create "macbook"`.
3. Copy the `lck_…` token, open the app's Settings (Cmd+, or the in-popover Settings… link), paste, Save.
4. Record. Every API call now carries the token.
5. If the key needs rotating: `bun run keys:revoke <id>` then `keys:create` a new one; paste it back into Settings.

### Scope

Single-user system, so no per-key scopes, refresh flow, or expiry — keys are long-lived and rotated manually via the CLI. Hashing uses SHA-256 rather than a slow KDF; the tokens are 256 bits of random entropy, so a slow hash adds nothing.

## Admin authentication — web panel + programmatic access

The admin panel (`/admin/*`) uses a separate auth system from the recording API. Two methods are supported: cookie-based sessions for the web UI, and admin bearer tokens (`lca_`) for programmatic access (scripts, CI, external tools).

### Configuration

Three environment variables control admin auth (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | *(unset)* | Password for the admin login form. Required in production. |
| `ADMIN_USERNAME` | `admin` | Username for the admin login form. |
| `SESSION_SECRET` | *(unset)* | HMAC key for signing session cookies. Required when `ADMIN_PASSWORD` is set. Generate with `openssl rand -base64 48`. |

**Dev convenience**: when `NODE_ENV` is *not* `production` and `ADMIN_PASSWORD` is unset, `requireAdmin()` passes requests through so you can iterate locally without logging in.

**Production**: `NODE_ENV=production` is set in `docker-compose.prod.yml`. With that set, `getAdminConfig()` throws on startup if `ADMIN_PASSWORD` is missing — the server refuses to boot rather than silently leaving `/admin/*` open. The eager check in `src/index.ts` makes this a fail-fast at boot, not a fail-open at runtime.

### Sessions (web UI)

Login via `POST /admin/login` with username and password. On success, a signed `lc_session` cookie is set with a 2-week expiry. The cookie is `httpOnly`, `SameSite=Lax`, scoped to `/admin`, and `Secure` on non-localhost origins. The session payload contains the username and an expiry timestamp, HMAC-signed with `SESSION_SECRET`.

CSRF protection applies to all cookie-authenticated mutations (POST/PATCH/DELETE). The server checks the `Origin` header against the expected host and rejects mismatches.

### Admin tokens (`lca_`) — programmatic access

Admin bearer tokens provide the same access as a logged-in session, for use cases where cookies aren't practical (scripts, API clients, CI). They use the same SHA-256 hash-and-verify pattern as API keys.

**Token format**: `lca_<43 chars of base64url>` — "loom-clone admin". Same structure as `lck_` tokens but a distinct prefix so the two are immediately distinguishable.

**Lifecycle**: tokens are created and revoked from the admin UI (Settings > API Keys). The plaintext is shown once at creation. `lastUsedAt` is tracked. Bearer-authenticated requests skip CSRF checks (bearer tokens are inherently CSRF-safe).

**Usage**: `Authorization: Bearer lca_...` on any `/admin/*` route. Invalid tokens get a 401 JSON response; requests with no `Authorization` header and no valid session cookie are redirected to the login page.

### Where the code lives

| Concern | File |
|---|---|
| Admin config, sessions, `requireAdmin()` middleware | `src/lib/admin-auth.ts` |
| Admin token CRUD (create, verify, revoke, list) | `src/lib/admin-tokens.ts` |
| CSRF middleware | `src/routes/admin/index.tsx` |
| Login/logout routes | `src/routes/admin/index.tsx` |
| Admin token management UI | Settings > API Keys pane |
