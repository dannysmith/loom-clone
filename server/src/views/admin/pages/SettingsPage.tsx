import { AdminLayout } from "../../layouts/AdminLayout";

export function SettingsPage() {
  return (
    <AdminLayout title="Settings" activePage="settings">
      <div class="page-header">
        <h1>Settings</h1>
      </div>
      <p class="empty-state">Phase 4 builds General, Tags, and API Keys panes here.</p>
    </AdminLayout>
  );
}
