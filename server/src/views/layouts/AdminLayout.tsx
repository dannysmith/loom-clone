import type { Child, PropsWithChildren } from "hono/jsx";
import { RootLayout } from "./RootLayout";

type Props = PropsWithChildren<{
  title: string;
  head?: Child;
}>;

// Admin shell stub. Phase 6 (task-x5) fleshes out nav, breadcrumbs, etc.
export function AdminLayout({ title, head, children }: Props) {
  return (
    <RootLayout
      title={title}
      head={
        <>
          <link rel="stylesheet" href="/static/styles/admin.css" />
          {head}
        </>
      }
      bodyClass="admin"
    >
      <header class="admin-header">
        <a href="/admin" class="admin-brand">
          Loom Clone Admin
        </a>
      </header>
      <main class="admin-main">{children}</main>
    </RootLayout>
  );
}
