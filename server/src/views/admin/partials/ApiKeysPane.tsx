import type { AdminToken, ApiKey } from "../../../db/schema";
import { formatDate } from "../../../lib/format";

type KeyLike = ApiKey | AdminToken;

type Props = {
  recordingKeys: ApiKey[];
  adminTokens: AdminToken[];
  newRecordingToken?: string;
  newAdminToken?: string;
};

export function ApiKeysPane({
  recordingKeys,
  adminTokens,
  newRecordingToken,
  newAdminToken,
}: Props) {
  return (
    <div id="keys-pane">
      <KeySection
        title="Recording API Keys"
        description="Bearer tokens for the macOS recording app (lck_ prefix). Used to authenticate segment uploads and video creation."
        keys={recordingKeys}
        newToken={newRecordingToken}
        createAction="/admin/settings/keys/recording"
        revokePrefix="/admin/settings/keys/recording"
        placeholder="Key name (e.g. MacBook Pro)"
      />

      <KeySection
        title="Admin API Tokens"
        description="Bearer tokens for admin API access (lca_ prefix). Used for scripting, automation, and programmatic admin operations."
        keys={adminTokens}
        newToken={newAdminToken}
        createAction="/admin/settings/keys/admin"
        revokePrefix="/admin/settings/keys/admin"
        placeholder="Token name (e.g. backup script)"
      />
    </div>
  );
}

function KeySection({
  title,
  description,
  keys,
  newToken,
  createAction,
  revokePrefix,
  placeholder,
}: {
  title: string;
  description: string;
  keys: KeyLike[];
  newToken?: string;
  createAction: string;
  revokePrefix: string;
  placeholder: string;
}) {
  return (
    <div class="keys-section">
      <h3 class="keys-section-title">{title}</h3>
      <p class="keys-section-description">{description}</p>

      <div class="keys-create">
        <form
          hx-post={createAction}
          hx-target="#keys-pane"
          hx-swap="outerHTML"
          class="keys-create-form"
        >
          <input class="input" type="text" name="name" placeholder={placeholder} required />
          <button type="submit" class="btn btn--primary">
            Create
          </button>
        </form>
      </div>

      {newToken && (
        <div class="keys-new-token">
          <p>
            <strong>New key created.</strong> Copy it now — it won't be shown again.
          </p>
          <code class="keys-token-value">{newToken}</code>
        </div>
      )}

      {keys.length === 0 ? (
        <p class="empty-state">No keys yet.</p>
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
            <KeyRow apiKey={k} revokePrefix={revokePrefix} />
          ))}
        </div>
      )}
    </div>
  );
}

function KeyRow({ apiKey: k, revokePrefix }: { apiKey: KeyLike; revokePrefix: string }) {
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
            hx-post={`${revokePrefix}/${k.id}/revoke`}
            hx-target="#keys-pane"
            hx-swap="outerHTML"
            hx-confirm={`Revoke "${k.name}"? This cannot be undone.`}
          >
            Revoke
          </button>
        )}
      </span>
    </div>
  );
}
