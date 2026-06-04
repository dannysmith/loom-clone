import type { Video } from "../../../db/schema";
import {
  canReprocess,
  type Readiness,
  type ReadinessIcon,
} from "../../../lib/processing/readiness";

const GLYPH: Record<ReadinessIcon, string> = {
  ready: "✅",
  missing: "❌",
  pending: "⏳",
  na: "—",
};

// The post-processing checklist + the global "Re-run post-processing" button.
export function ReadinessChecklist({ video, readiness }: { video: Video; readiness: Readiness }) {
  return (
    <section class="readiness" id="readiness-section">
      <div class="readiness-header">
        <h3>Processing</h3>
        {readiness.badge && <span class="badge badge--ready">{readiness.badge}</span>}
      </div>
      <ul class="readiness-list">
        {readiness.items.map((item) => (
          <li class={`readiness-item readiness-item--${item.icon}`} title={item.tier}>
            <span class="readiness-glyph" aria-hidden="true">
              {GLYPH[item.icon]}
            </span>
            <span class="readiness-label">{item.label}</span>
          </li>
        ))}
      </ul>
      {canReprocess(video) && (
        <form
          class="readiness-reprocess"
          method="post"
          action={`/admin/videos/${video.id}/reprocess`}
          hx-confirm="Re-run post-processing for this video? Steps that already succeeded are skipped."
        >
          <button type="submit" class="btn btn--sm">
            Re-run post-processing
          </button>
        </form>
      )}
    </section>
  );
}
