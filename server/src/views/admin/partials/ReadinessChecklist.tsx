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

// The post-processing checklist + the reprocess controls (global re-run /
// from-HLS rebuild / per-artifact regenerate), all dependency-aware.
export function ReadinessChecklist({ video, readiness }: { video: Video; readiness: Readiness }) {
  const reprocessable = canReprocess(video);
  const { dataLoss, canRebuildSource } = readiness.reprocess;

  // Server-produced derivatives vs. Mac-sent suggestion items — grouped so the
  // "—" rows on an upload read as "doesn't apply" rather than as gaps.
  const derivatives = readiness.items.filter((i) => i.tier !== "external");
  const suggestions = readiness.items.filter((i) => i.tier === "external");

  return (
    <section class="readiness" id="readiness-section">
      <div class="readiness-header">
        <h3>Processing</h3>
        {readiness.badge && <span class="badge badge--ready">{readiness.badge}</span>}
      </div>

      <ul class="readiness-list">
        {derivatives.map((item) => (
          <ChecklistRow video={video} item={item} reprocessable={reprocessable} />
        ))}
      </ul>

      {suggestions.length > 0 && (
        <>
          <p class="readiness-subhead">Suggestions (from the Mac)</p>
          <ul class="readiness-list">
            {suggestions.map((item) => (
              <ChecklistRow video={video} item={item} reprocessable={reprocessable} />
            ))}
          </ul>
        </>
      )}

      {reprocessable && (
        <div class="readiness-actions">
          {dataLoss ? (
            <p class="readiness-dataloss">
              ⚠ This video can&rsquo;t be rebuilt from the server — its HLS segments are gone and
              there&rsquo;s no valid <code>source.mp4</code>.
            </p>
          ) : (
            <>
              <form method="post" action={`/admin/videos/${video.id}/reprocess`}>
                <button type="submit" class="btn btn--sm">
                  Re-run post-processing
                </button>
              </form>
              {canRebuildSource && (
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
            </>
          )}
        </div>
      )}
    </section>
  );
}

function ChecklistRow({
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
    <li class={`readiness-item readiness-item--${item.icon}`} title={item.tier}>
      <span class="readiness-glyph" aria-hidden="true">
        {GLYPH[item.icon]}
      </span>
      <span class="readiness-label">{item.label}</span>
      {showRegen && (
        <form
          class="readiness-regen"
          method="post"
          action={`/admin/videos/${video.id}/reprocess/${item.kind}`}
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
    </li>
  );
}
