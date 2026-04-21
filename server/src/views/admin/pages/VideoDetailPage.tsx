import { AdminLayout } from "../../layouts/AdminLayout";

export function VideoDetailPage({ id }: { id: string }) {
  return (
    <AdminLayout title={`Video ${id}`}>
      <div class="page-header">
        <h1>Video Detail</h1>
      </div>
      <p class="empty-state">
        Video <code>{id}</code> — Phase 5 builds the detail view here.
      </p>
    </AdminLayout>
  );
}
