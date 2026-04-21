import type { Child } from "hono/jsx";
import { AdminLayout } from "../../layouts/AdminLayout";

type SettingsTab = "general" | "tags" | "keys";

type Props = {
  activeTab: SettingsTab;
  children: Child;
};

const TABS: Array<{ id: SettingsTab; href: string; label: string }> = [
  { id: "general", href: "/admin/settings", label: "General" },
  { id: "tags", href: "/admin/settings/tags", label: "Tags" },
  { id: "keys", href: "/admin/settings/keys", label: "API Keys" },
];

export function SettingsPage({ activeTab, children }: Props) {
  return (
    <AdminLayout title="Settings" activePage="settings">
      <div class="page-header">
        <h1>Settings</h1>
      </div>

      <div class="settings-tabs">
        {TABS.map((tab) => (
          <a href={tab.href} class={`settings-tab ${activeTab === tab.id ? "active" : ""}`}>
            {tab.label}
          </a>
        ))}
      </div>

      <div class="settings-pane">{children}</div>
    </AdminLayout>
  );
}

export function GeneralPane() {
  return (
    <p class="empty-state">
      No configurable settings yet. This section will grow as the system evolves.
    </p>
  );
}
