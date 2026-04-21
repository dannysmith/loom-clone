import { raw } from "hono/html";
import type { Child, PropsWithChildren } from "hono/jsx";

type ActivePage = "dashboard" | "settings" | "trash";

type Props = PropsWithChildren<{
  title: string;
  activePage?: ActivePage;
  head?: Child;
}>;

const NAV_ITEMS: Array<{ page: ActivePage; href: string; label: string }> = [
  { page: "dashboard", href: "/admin", label: "Dashboard" },
  { page: "settings", href: "/admin/settings", label: "Settings" },
  { page: "trash", href: "/admin/trash", label: "Trash" },
];

// Full admin shell with sidebar nav. hx-boost on <body> gives SPA-like
// navigation — HTMX fetches the full page and swaps the entire <body>,
// so nav active states update on every navigation without fragment logic.
export function AdminLayout({ title, activePage, head, children }: Props) {
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>{title} · Admin</title>
          <link rel="stylesheet" href="/static/styles/app.css" />
          <link rel="stylesheet" href="/static/styles/admin.css" />
          {head}
        </head>
        <body class="admin" hx-boost="true">
          <aside class="admin-sidebar">
            <a href="/admin" class="admin-brand">
              Loom Clone
            </a>
            <nav class="admin-nav">
              {NAV_ITEMS.map((item) => (
                <a
                  href={item.href}
                  class="admin-nav-link"
                  {...(activePage === item.page ? { "aria-current": "page" } : {})}
                >
                  {item.label}
                </a>
              ))}
            </nav>
            <form method="post" action="/admin/logout" class="admin-sidebar-footer">
              <button type="submit" class="admin-nav-link admin-logout-btn">
                Log out
              </button>
            </form>
          </aside>
          <main class="admin-main">{children}</main>
          <script
            src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.8/dist/htmx.min.js"
            integrity="sha384-/TgkGk7p307TH7EXJDuUlgG3Ce1UVolAOFopFekQkkXihi5u/6OCvVKyz1W+idaz"
            crossorigin="anonymous"
          />
          <script src="/static/js/admin.js" />
        </body>
      </html>
    </>
  );
}
