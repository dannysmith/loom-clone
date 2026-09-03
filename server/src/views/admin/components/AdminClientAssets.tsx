import { type AdminClientEntry, adminClientAssets } from "../../../lib/vite-manifest";

// <head> tags for one admin-client Vite entry. In dev mode (ADMIN_CLIENT_DEV=1)
// this is the HMR client plus the source module; otherwise it's the hashed
// bundle and its stylesheet, resolved from the Vite manifest.
export function AdminClientAssets({ entry }: { entry: AdminClientEntry }) {
  const { js, css, devClient } = adminClientAssets(entry);
  return (
    <>
      {css.map((href) => (
        <link rel="stylesheet" href={href} />
      ))}
      {devClient && <script type="module" src={devClient} />}
      <script type="module" src={js} />
    </>
  );
}
