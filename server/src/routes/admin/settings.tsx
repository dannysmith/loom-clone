import { Hono } from "hono";
import { createAdminToken, listAdminTokens, revokeAdminToken } from "../../lib/admin-tokens";
import { createApiKey, listApiKeys, revokeApiKey } from "../../lib/api-keys";
import { ConflictError, ValidationError } from "../../lib/store";
import { createTag, deleteTag, getTag, listTags, updateTag } from "../../lib/tags";
import { GeneralPane, SettingsPage } from "../../views/admin/pages/SettingsPage";
import { ApiKeysPane } from "../../views/admin/partials/ApiKeysPane";
import { TagEditRow, TagRow, TagsPane } from "../../views/admin/partials/TagsPane";
import type { AdminEnv } from "./helpers";

const settings = new Hono<AdminEnv>();

settings.get("/", (c) =>
  c.html(
    <SettingsPage activeTab="general">
      <GeneralPane />
    </SettingsPage>,
  ),
);

// --- Tags ---

settings.get("/tags", async (c) => {
  const tags = await listTags();
  return c.html(
    <SettingsPage activeTab="tags">
      <TagsPane tags={tags} />
    </SettingsPage>,
  );
});

settings.post("/tags", async (c) => {
  const body = await c.req.parseBody();
  const name = String(body.name ?? "").trim();
  const color = String(body.color ?? "gray");
  if (name) {
    await createTag(name, color as Parameters<typeof createTag>[1]);
  }
  const tags = await listTags();
  return c.html(<TagsPane tags={tags} />);
});

settings.get("/tags/:id/edit", async (c) => {
  const tag = await getTag(Number(c.req.param("id")));
  if (!tag) return c.text("Tag not found", 404);
  return c.html(<TagEditRow tag={tag} />);
});

settings.get("/tags/:id/display", async (c) => {
  const tag = await getTag(Number(c.req.param("id")));
  if (!tag) return c.text("Tag not found", 404);
  return c.html(<TagRow tag={tag} />);
});

settings.patch("/tags/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();

  const patch: Parameters<typeof updateTag>[1] = {};
  if (body.name !== undefined) patch.name = String(body.name).trim();
  if (body.color !== undefined) {
    patch.color = String(body.color) as Parameters<typeof updateTag>[1]["color"];
  }
  if (body.visibility !== undefined) {
    patch.visibility = String(body.visibility) as Parameters<typeof updateTag>[1]["visibility"];
  }
  if (body.slug !== undefined) {
    const slug = String(body.slug).trim();
    patch.slug = slug.length > 0 ? slug : null;
  }
  if (body.description !== undefined) {
    const desc = String(body.description).trim();
    patch.description = desc.length > 0 ? desc : null;
  }

  try {
    await updateTag(id, patch);
  } catch (err) {
    if (err instanceof ValidationError || err instanceof ConflictError) {
      const existing = await getTag(id);
      if (!existing) return c.text("Tag not found", 404);
      return c.html(<TagEditRow tag={existing} error={err.message} />);
    }
    throw err;
  }

  const tag = await getTag(id);
  if (!tag) return c.text("Tag not found", 404);
  return c.html(<TagRow tag={tag} />);
});

settings.delete("/tags/:id", async (c) => {
  await deleteTag(Number(c.req.param("id")));
  const tags = await listTags();
  return c.html(<TagsPane tags={tags} />);
});

// --- API Keys ---

async function renderKeysPane(opts?: { newRecordingToken?: string; newAdminToken?: string }) {
  const [recordingKeys, adminTokens] = await Promise.all([listApiKeys(), listAdminTokens()]);
  return (
    <ApiKeysPane
      recordingKeys={recordingKeys}
      adminTokens={adminTokens}
      newRecordingToken={opts?.newRecordingToken}
      newAdminToken={opts?.newAdminToken}
    />
  );
}

settings.get("/keys", async (c) =>
  c.html(<SettingsPage activeTab="keys">{await renderKeysPane()}</SettingsPage>),
);

// Recording API keys (lck_)
settings.post("/keys/recording", async (c) => {
  const name = String((await c.req.parseBody()).name ?? "").trim();
  let newRecordingToken: string | undefined;
  if (name) newRecordingToken = (await createApiKey(name)).plaintext;
  return c.html(await renderKeysPane({ newRecordingToken }));
});

settings.post("/keys/recording/:id/revoke", async (c) => {
  await revokeApiKey(c.req.param("id"));
  return c.html(await renderKeysPane());
});

// Admin API tokens (lca_)
settings.post("/keys/admin", async (c) => {
  const name = String((await c.req.parseBody()).name ?? "").trim();
  let newAdminToken: string | undefined;
  if (name) newAdminToken = (await createAdminToken(name)).plaintext;
  return c.html(await renderKeysPane({ newAdminToken }));
});

settings.post("/keys/admin/:id/revoke", async (c) => {
  await revokeAdminToken(c.req.param("id"));
  return c.html(await renderKeysPane());
});

export default settings;
