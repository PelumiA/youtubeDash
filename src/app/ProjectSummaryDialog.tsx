import { useEffect, useState } from "react";
import { api } from "../db/api";
import { DEFAULT_WEIGHTS, type Weights } from "../thumbnails/score";
import { localDate } from "../ideas/taxonomy";
import { buildProjectSummary } from "./projectSummary";
import { SETTINGS, getJson } from "./settings";
import { Button } from "./ui";

/** Preview of a project's Markdown summary, with copy and save (save asks where, via the OS dialog). */
export default function ProjectSummaryDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [projects, thumbnails, ideas, weights, videoTitle] = await Promise.all([
        api.listProjects(),
        api.listThumbnails(projectId),
        api.listIdeas("", "project"),
        getJson<Weights>(SETTINGS.weights, DEFAULT_WEIGHTS),
        api.getSetting(`thumbnails.title.${projectId}`),
      ]);
      const project = projects.find((p) => p.id === projectId);
      if (!project) throw new Error("Project not found.");
      setMarkdown(
        buildProjectSummary({
          project,
          thumbnails,
          idea: ideas.find((i) => i.projectId === projectId) ?? null,
          weights: { ...DEFAULT_WEIGHTS, ...weights },
          videoTitle,
          date: localDate(),
        }),
      );
    })().catch((e) => setMsg(String(e)));
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(markdown!);
      setMsg("Copied to the clipboard.");
    } catch (e) {
      setMsg(`Could not copy: ${e}`);
    }
  }

  async function save() {
    try {
      const path = await api.saveProjectSummary(projectId, markdown!);
      if (path) setMsg(`Saved to ${path}`);
    } catch (e) {
      setMsg(String(e));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Project summary">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-line bg-panel shadow-xl">
        <div className="border-b border-line px-5 py-3 font-semibold">Project summary</div>
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-5 py-4 font-mono text-xs leading-relaxed">{markdown ?? "Building…"}</pre>
        <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
          <span className="min-w-0 truncate text-xs text-muted" title={msg ?? ""}>{msg ?? "Markdown. Saving asks where to put the file."}</span>
          <span className="flex shrink-0 gap-2">
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button onClick={copy} disabled={!markdown}>Copy</Button>
            <Button variant="primary" onClick={save} disabled={!markdown}>Save…</Button>
          </span>
        </div>
      </div>
    </div>
  );
}
