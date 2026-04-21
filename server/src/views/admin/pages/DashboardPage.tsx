import { AdminLayout } from "../../layouts/AdminLayout";

export function DashboardPage() {
  return (
    <AdminLayout title="Dashboard" activePage="dashboard">
      <div class="page-header">
        <h1>Dashboard</h1>
      </div>
      <p class="empty-state">No videos yet. Phase 3 builds the video list here.</p>
    </AdminLayout>
  );
}
