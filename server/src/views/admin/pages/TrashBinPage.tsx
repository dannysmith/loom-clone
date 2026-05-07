import type { Video } from "../../../db/schema";
import { AdminLayout } from "../../layouts/AdminLayout";
import { VideoCard } from "../components/VideoCard";

type Props = {
  videos: Video[];
  diskSizes: Record<string, number>;
  view: string;
};

export function TrashBinPage({ videos, diskSizes, view }: Props) {
  return (
    <AdminLayout title="Trash" activePage="trash">
      <div class="page-header">
        <h1>Trash</h1>
      </div>

      {videos.length === 0 ? (
        <p class="empty-state">Trash is empty.</p>
      ) : (
        <div id="video-list" data-view={view}>
          <div class="video-list-items">
            {videos.map((v) => (
              <VideoCard video={v} mode="trash" diskSize={diskSizes[v.id]} />
            ))}
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
