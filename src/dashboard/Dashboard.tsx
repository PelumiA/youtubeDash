import { useEffect, useState } from "react";
import { api, type DashboardSummary, type Project } from "../db/api";
import type { Navigate } from "../app/App";
import ProjectSummaryDialog from "../app/ProjectSummaryDialog";
import { Badge, Button, Panel } from "../app/ui";

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}

/** Home is a launcher, not a fourth feature: counts and shortcuts only. */
export default function Dashboard({ onNavigate }: { onNavigate: Navigate }) {
  const [summaryFor, setSummaryFor] = useState<number | null>(null);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.dashboardSummary().then(setSummary, (e) => setError(String(e)));
    api.listProjects().then(setProjects, () => setProjects([]));
  }, []);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <h1 className="text-xl font-semibold">Home</h1>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Files indexed" value={summary?.filesIndexed ?? "—"} />
        <Stat label="Organize runs (active)" value={summary?.batchesApplied ?? "—"} />
        <Stat label="Projects in progress" value={summary?.projectsActive ?? "—"} />
        <Stat label="Ideas in inbox" value={summary?.ideasInInbox ?? "—"} />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Recently organized" actions={<Button variant="ghost" onClick={() => onNavigate("library")}>Open library →</Button>}>
          {summary && summary.recentBatches.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted">Nothing organized yet. Scan a folder to get started.</p>
          )}
          <ul className="divide-y divide-line">
            {summary?.recentBatches.map((b) => (
              <li key={b.batchId} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span>
                  {b.kind === "archive" ? "Archived" : "Renamed"} {b.opCount} file{b.opCount === 1 ? "" : "s"}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {b.undoneAt && <Badge>undone</Badge>}
                  {new Date(b.appliedAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Projects" actions={<Button variant="ghost" onClick={() => onNavigate("thumbnails")}>Thumbnail tester →</Button>}>
          {projects.length === 0 && <p className="px-4 py-6 text-sm text-muted">No projects yet. Turn an idea into one, or create one in the thumbnail tester.</p>}
          <ul className="divide-y divide-line">
            {projects.slice(0, 6).map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium">{p.title}</span>
                    {p.category && <Badge tone="accent">{p.category}</Badge>}
                  </span>
                  <span className="text-xs text-muted">
                    {p.thumbnailCount ? `${p.thumbnailCount} thumbnail${p.thumbnailCount === 1 ? "" : "s"} tested` : "No thumbnail test yet"}
                    {p.bestScore != null && ` · best ${p.bestScore.toFixed(0)}`}
                    {p.lastTestedAt && ` · ${new Date(p.lastTestedAt).toLocaleDateString()}`}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {p.winnerThumbnailId ? <Badge tone="ok">winner picked</Badge> : p.thumbnailCount ? <Badge tone="warn">pick a winner</Badge> : null}
                  <Button variant="ghost" onClick={() => setSummaryFor(p.id)} title="Export a Markdown summary">Summary</Button>
                  <Button onClick={() => onNavigate("thumbnails", { projectId: p.id })}>Continue</Button>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Modules">
          <ul className="divide-y divide-line text-sm">
            <li className="flex items-center justify-between px-4 py-3">
              <span>Media library organizer</span>
              <Button variant="primary" onClick={() => onNavigate("library")}>Continue</Button>
            </li>
            <li className="flex items-center justify-between px-4 py-3">
              <span>Thumbnail tester</span>
              <Button variant="primary" onClick={() => onNavigate("thumbnails")}>Continue</Button>
            </li>
            <li className="flex items-center justify-between px-4 py-3">
              <span>
                Idea organizer
                {summary && summary.ideasInInbox > 0 && <span className="ml-2 text-xs text-muted">{summary.ideasInInbox} waiting in the inbox</span>}
              </span>
              <Button variant="primary" onClick={() => onNavigate("ideas")}>Continue</Button>
            </li>
          </ul>
        </Panel>
      </div>
      {summaryFor != null && <ProjectSummaryDialog projectId={summaryFor} onClose={() => setSummaryFor(null)} />}
    </div>
  );
}
