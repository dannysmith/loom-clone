import { raw } from "hono/html";
import type { Child, PropsWithChildren } from "hono/jsx";
import { IconDashboard, IconSettings, IconTrash } from "../admin/components/Icons";

type ActivePage = "dashboard" | "settings" | "trash";

type Props = PropsWithChildren<{
  title: string;
  activePage?: ActivePage;
  head?: Child;
}>;

function navIcon(page: ActivePage, size: number) {
  switch (page) {
    case "dashboard":
      return <IconDashboard size={size} />;
    case "settings":
      return <IconSettings size={size} />;
    case "trash":
      return <IconTrash size={size} />;
  }
}

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
        <body class="admin" hx-boost="true" hx-ext="head-support">
          <aside class="admin-sidebar">
            <a href="/admin" class="admin-brand" title="Dashboard">
              LC
            </a>
            <nav class="admin-nav">
              {NAV_ITEMS.map((item) => (
                <a
                  href={item.href}
                  class="admin-nav-link"
                  title={item.label}
                  {...(activePage === item.page ? { "aria-current": "page" } : {})}
                >
                  {navIcon(item.page, 20)}
                </a>
              ))}
            </nav>
            <form method="post" action="/admin/logout" class="admin-sidebar-footer">
              <button type="submit" class="admin-nav-link admin-logout-btn" title="Log out">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" x2="9" y1="12" y2="12" />
                </svg>
              </button>
            </form>
          </aside>
          <main class="admin-main">{children}</main>
          <script
            src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.8/dist/htmx.min.js"
            integrity="sha384-/TgkGk7p307TH7EXJDuUlgG3Ce1UVolAOFopFekQkkXihi5u/6OCvVKyz1W+idaz"
            crossorigin="anonymous"
          />
          <script src="https://cdn.jsdelivr.net/npm/htmx-ext-head-support@2.0.3/head-support.min.js" />
          <script src="/static/js/admin.js" />
        </body>
      </html>
    </>
  );
}
