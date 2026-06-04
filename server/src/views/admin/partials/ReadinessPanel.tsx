import type { Video } from "../../../db/schema";
import {
  canReprocess,
  type Readiness,
  type ReadinessIcon,
  type ReadinessItem,
} from "../../../lib/processing/readiness";

const GLYPH: Record<ReadinessIcon, string> = {
  ready: "✅",
  missing: "❌",
  pending: "⏳",
  na: "—",
};

// The post-processing tab: the reprocess controls (global re-run / from-HLS
// rebuild / data-loss notice) on top, then a per-artifact status table — rows
// in pipeline order, each with its status icon and a dependency-aware "↻"
// regenerate button.
export function ReadinessPanel({
  video,
  readiness,
  notice,
}: {
  video: Video;
  readiness: Readiness;
  notice?: string;
}) {
  const reprocessable = canReprocess(video);
  const { dataLoss, canRebuildSource } = readiness.reprocess;
  const edited = Boolean(video.lastEditedAt);

  // Confirmation copy — edited videos warn that reprocessing discards the edit.
  const rerunConfirm = edited
    ? "This is an edited video — re-running post-processing will DISCARD the edit and rebuild from the original recording. Continue?"
    : "Re-run post-processing for this video?";
  const rebuildConfirm = edited
    ? "This is an edited video — rebuilding from HLS will DISCARD the edit and regenerate everything from the original recording. Continue?"
    : "Re-stitch source.mp4 from HLS and regenerate everything?";

  return (
    <div class="readiness" id="readiness-panel">
      {notice && <p class="readiness-notice">{notice}</p>}
      {edited && reprocessable && !dataLoss && (
        <p class="readiness-edit-warning">
          ⚠ This is an edited video. Re-running post-processing will discard the edit and rebuild
          from the original recording.
        </p>
      )}
      {reprocessable &&
        (dataLoss ? (
          <p class="readiness-dataloss">
            ⚠ This video can&rsquo;t be rebuilt from the server — its HLS segments are gone and
            there&rsquo;s no valid <code>source.mp4</code>.
          </p>
        ) : (
          <div class="readiness-actions">
            <form
              method="post"
              action={`/admin/videos/${video.id}/reprocess`}
              hx-confirm={rerunConfirm}
            >
              <button type="submit" class="btn btn--sm">
                Re-run post-processing
              </button>
            </form>
            {canRebuildSource && video.source === "recorded" && (
              <form
                method="post"
                action={`/admin/videos/${video.id}/reprocess`}
                hx-confirm={rebuildConfirm}
              >
                <input type="hidden" name="rebuild" value="hls" />
                <button type="submit" class="btn btn--sm">
                  Rebuild from HLS
                </button>
              </form>
            )}
          </div>
        ))}

      <table class="readiness-table">
        <tbody>
          {readiness.items.map((item) => (
            <ReadinessRow video={video} item={item} reprocessable={reprocessable} edited={edited} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReadinessRow({
  video,
  item,
  reprocessable,
  edited,
}: {
  video: Video;
  item: ReadinessItem;
  reprocessable: boolean;
  edited: boolean;
}) {
  // Offer a per-artifact regenerate when the step is regenerable, source is
  // valid (encoded in item.regenerable), the video is reprocessable, and it
  // isn't already mid-generation. Hidden for edited videos: a single-artifact
  // regen from the full source would mismatch the edited active file, so an
  // edited video is only reprocessed via the global (edit-resetting) controls.
  const showRegen = reprocessable && item.regenerable && item.icon !== "pending" && !edited;
  return (
    <tr class={`readiness-row readiness-row--${item.icon}`}>
      <td class="readiness-cell-glyph" aria-hidden="true">
        {GLYPH[item.icon]}
      </td>
      <td class="readiness-cell-label">{item.label}</td>
      <td class="readiness-cell-action">
        {showRegen && (
          <form
            method="post"
            action={`/admin/videos/${video.id}/reprocess/${item.kind}`}
            hx-confirm={`Regenerate ${item.label.toLowerCase()} from source.mp4?`}
          >
            <button
              type="submit"
              class="btn btn--xs"
              title={`Regenerate ${item.label.toLowerCase()}`}
            >
              ↻
            </button>
          </form>
        )}
      </td>
    </tr>
  );
}
