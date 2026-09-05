import type { Child } from "hono/jsx";
import { formatFileSize } from "../../../lib/files";
import { formatDateTime } from "../../../lib/format";
import type { SelfCheckReport } from "../../../lib/self-check";
import { AdminLayout } from "../../layouts/AdminLayout";

type SettingsTab = "general" | "tags" | "keys";

type Props = {
  activeTab: SettingsTab;
  children: Child;
};

const TABS: Array<{ id: SettingsTab; href: string; label: string }> = [
  { id: "general", href: "/admin/settings", label: "General" },
  { id: "tags", href: "/admin/settings/tags", label: "Tags" },
  { id: "keys", href: "/admin/settings/keys", label: "API Keys" },
];

export function SettingsPage({ activeTab, children }: Props) {
  return (
    <AdminLayout title="Settings" activePage="settings">
      <div class="page-header">
        <h1>Settings</h1>
      </div>

      <div class="settings-tabs">
        {TABS.map((tab) => (
          <a href={tab.href} class={`settings-tab ${activeTab === tab.id ? "active" : ""}`}>
            {tab.label}
          </a>
        ))}
      </div>

      <div class="settings-pane">{children}</div>
    </AdminLayout>
  );
}

// The system health + stats view, fed by the same collector the daily
// self-check cron reports to healthchecks.io (lib/self-check.ts). Rows that
// only exist inside the production container are hidden when their data
// isn't available: container memory is null outside a container (local dev),
// and the last-backup marker only exists on the VPS where backup.sh writes it.
export function GeneralPane({ report }: { report: SelfCheckReport }) {
  const { stats } = report;
  const usedBytes = stats.disk.totalBytes - stats.disk.freeBytes;
  return (
    <div>
      <div class="system-section">
        <h3 class="system-section-title">Health</h3>
        {report.healthy ? (
          <p class="system-health-ok">All checks passing</p>
        ) : (
          <ul class="system-failures">
            {report.failures.map((f) => (
              <li>{f}</li>
            ))}
          </ul>
        )}
      </div>

      <div class="system-section">
        <h3 class="system-section-title">Storage &amp; resources</h3>
        <dl class="system-stats">
          <div class="system-stat">
            <dt>Data volume</dt>
            <dd>
              {formatFileSize(usedBytes)} used of {formatFileSize(stats.disk.totalBytes)} (
              {formatFileSize(stats.disk.freeBytes)} free)
            </dd>
          </div>
          <div class="system-stat">
            <dt>Video data</dt>
            <dd>{formatFileSize(stats.dataDirBytes)}</dd>
          </div>
          {stats.memory && (
            <div class="system-stat">
              <dt>Container memory</dt>
              <dd>
                {formatFileSize(stats.memory.currentBytes)}
                {stats.memory.limitBytes
                  ? ` of ${formatFileSize(stats.memory.limitBytes)} limit`
                  : " (no limit)"}
              </dd>
            </div>
          )}
          <div class="system-stat">
            <dt>Last backup</dt>
            <dd>{stats.lastBackupAt ? formatDateTime(stats.lastBackupAt) : "Not recorded yet"}</dd>
          </div>
        </dl>
        <p class="system-note">
          The same data the daily self-check reports to healthchecks.io — see{" "}
          <code>docs/developer/operations.md</code>.
        </p>
      </div>
    </div>
  );
}
