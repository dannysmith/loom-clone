import type { ApiKey } from "../../../db/schema";

export function ApiKeysPane({ keys, newToken }: { keys: ApiKey[]; newToken?: string }) {
  return (
    <div id="keys-pane">
      <div class="keys-create">
        <form
          hx-post="/admin/settings/keys"
          hx-target="#keys-pane"
          hx-swap="outerHTML"
          class="keys-create-form"
        >
          <input
            class="input"
            type="text"
            name="name"
            placeholder="Key name (e.g. MacBook Pro)"
            required
          />
          <button type="submit" class="btn btn--primary">
            Create key
          </button>
        </form>
      </div>

      {newToken && (
        <div class="keys-new-token">
          <p>
            <strong>New API key created.</strong> Copy it now — it won't be shown again.
          </p>
          <code class="keys-token-value">{newToken}</code>
        </div>
      )}

      {keys.length === 0 ? (
        <p class="empty-state">No API keys yet.</p>
      ) : (
        <div class="keys-list">
          <div class="keys-header">
            <span>Name</span>
            <span>Created</span>
            <span>Last used</span>
            <span>Status</span>
            <span />
          </div>
          {keys.map((k) => (
            <KeyRow apiKey={k} />
          ))}
        </div>
      )}
    </div>
  );
}

function KeyRow({ apiKey: k }: { apiKey: ApiKey }) {
  const isRevoked = k.revokedAt !== null;
  return (
    <div class={`key-row ${isRevoked ? "key-row--revoked" : ""}`} id={`key-${k.id}`}>
      <span class="key-name">{k.name}</span>
      <span class="key-date">{formatDate(k.createdAt)}</span>
      <span class="key-date">{k.lastUsedAt ? formatDate(k.lastUsedAt) : "Never"}</span>
      <span>
        {isRevoked ? (
          <span class="badge badge--private">Revoked</span>
        ) : (
          <span class="badge badge--public">Active</span>
        )}
      </span>
      <span>
        {!isRevoked && (
          <button
            type="button"
            class="btn btn--sm btn--danger"
            hx-post={`/admin/settings/keys/${k.id}/revoke`}
            hx-target={`#key-${k.id}`}
            hx-swap="outerHTML"
            hx-confirm={`Revoke key "${k.name}"? This cannot be undone.`}
          >
            Revoke
          </button>
        )}
      </span>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
