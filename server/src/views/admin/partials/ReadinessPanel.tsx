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

  return (
    <div class="readiness" id="readiness-panel">
      {notice && <p class="readiness-notice">{notice}</p>}
      {reprocessable &&
        (dataLoss ? (
          <p class="readiness-dataloss">
            ⚠ This video can&rsquo;t be rebuilt from the server — its HLS segments are gone and
            there&rsquo;s no valid <code>source.mp4</code>.
          </p>
        ) : (
          <div class="readiness-actions">
            <form method="post" action={`/admin/videos/${video.id}/reprocess`}>
              <button type="submit" class="btn btn--sm">
                Re-run post-processing
              </button>
            </form>
            {canRebuildSource && video.source === "recorded" && (
              <form
                method="post"
                action={`/admin/videos/${video.id}/reprocess`}
                hx-confirm="Re-stitch source.mp4 from HLS and regenerate everything?"
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
            <ReadinessRow video={video} item={item} reprocessable={reprocessable} />
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
}: {
  video: Video;
  item: ReadinessItem;
  reprocessable: boolean;
}) {
  // Offer a per-artifact regenerate when the step is regenerable, source is
  // valid (encoded in item.regenerable), the video is reprocessable, and it
  // isn't already mid-generation.
  const showRegen = reprocessable && item.regenerable && item.icon !== "pending";
  return (
    <tr class={`readiness-row readiness-row--${item.icon}`}>
      <td class="readiness-cell-glyph" aria-hidden="true">
        {GLYPH[item.icon]}
      </td>
      <td class="readiness-cell-label">{item.label}</td>
      <td class="readiness-cell-action">
        {showRegen && (
          <form method="post" action={`/admin/videos/${video.id}/reprocess/${item.kind}`}>
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
