import type { Video } from "../../../db/schema";
import { AdminLayout } from "../../layouts/AdminLayout";
import { VideoCard } from "../components/VideoCard";

type Props = {
  videos: Video[];
  view: string;
};

export function TrashBinPage({ videos, view }: Props) {
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
              <VideoCard video={v} mode="trash" />
            ))}
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
