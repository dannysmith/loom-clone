import { AdminLayout } from "../../layouts/AdminLayout";

export function TrashBinPage() {
  return (
    <AdminLayout title="Trash" activePage="trash">
      <div class="page-header">
        <h1>Trash</h1>
      </div>
      <p class="empty-state">Phase 7 builds the trash bin here.</p>
    </AdminLayout>
  );
}
