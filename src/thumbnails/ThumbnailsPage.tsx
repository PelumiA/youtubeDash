import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, inDesktopApp, pickImages, type AiStatus, type Project, type ThumbnailRow } from "../db/api";
import { Badge, Button, ConfirmDialog, Panel } from "../app/ui";
import ApiKeyField from "../app/ApiKeyField";
import { joinPath } from "../library/paths";
import CandidateCard, { type CandidateView } from "./CandidateCard";
import { analyzeBytes, critiqueJpegBase64, decode } from "./browserAnalyze";
import type { Raster } from "./heuristics";
import { PLATFORMS, type PlatformId } from "./platforms";
import { DEFAULT_WEIGHTS, DIMENSIONS, explainWinner, leaders, score, withAi, type Breakdown, type DimensionId, type Weights } from "./score";

const WEIGHTS_KEY = "thumbnails.weights";
const titleKey = (projectId: number) => `thumbnails.title.${projectId}`;
const platformKey = (projectId: number) => `thumbnails.platform.${projectId}`;

export default function ThumbnailsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [platform, setPlatform] = useState<PlatformId>("youtube");
  const [videoTitle, setVideoTitle] = useState("");
  const [weights, setWeights] = useState<Weights>(DEFAULT_WEIGHTS);
  const [cands, setCands] = useState<CandidateView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [consent, setConsent] = useState<null | { ids: number[] }>(null);
  const [consented, setConsented] = useState(false);
  const rasters = useRef(new Map<number, Raster>());
  const bytes = useRef(new Map<number, ArrayBuffer>());
  const loadSeq = useRef(0);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const spec = PLATFORMS[platform];

  const refreshProjects = useCallback(async () => {
    const list = await api.listProjects();
    setProjects(list);
    return list;
  }, []);

  useEffect(() => {
    (async () => {
      const list = await refreshProjects();
      if (list.length) setProjectId((id) => id ?? list[0].id);
      const w = await api.getSetting(WEIGHTS_KEY);
      if (w) setWeights({ ...DEFAULT_WEIGHTS, ...JSON.parse(w) });
      setAi(await api.aiStatus());
    })().catch((e) => setError(String(e)));
  }, [refreshProjects]);

  const update = (id: number, patch: Partial<CandidateView>) => setCands((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const persist = useCallback(
    async (id: number, b: Breakdown, w: Weights = weights) => {
      const s = score(b, w);
      update(id, { breakdown: b, score: s });
      await api.saveThumbnailScore(id, b.platform, s.total, JSON.stringify(b));
    },
    [weights],
  );

  const analyze = useCallback(
    async (row: ThumbnailRow, plat: PlatformId, seq: number) => {
      update(row.id, { status: "analyzing" });
      try {
        const buf = bytes.current.get(row.id) ?? (await api.readThumbnail(row.id));
        const { breakdown, raster } = await analyzeBytes(buf, plat);
        if (seq !== loadSeq.current) return;
        rasters.current.set(row.id, raster);
        await persist(row.id, breakdown);
        update(row.id, { status: "ready" });
      } catch (e) {
        update(row.id, { status: "error", error: String(e) });
      }
    },
    [persist],
  );

  /** Loads a project's candidates; reuses stored breakdowns for this platform, scores the rest one by one. */
  const load = useCallback(
    async (pid: number, plat: PlatformId, forceRescore = false) => {
      const seq = ++loadSeq.current;
      setError(null);
      const rows = await api.listThumbnails(pid);
      for (const c of cands) if (c.imageUrl) URL.revokeObjectURL(c.imageUrl);
      setCands(rows.map((r) => ({ id: r.id, label: r.label, path: r.path, imageUrl: null, breakdown: null, score: null, status: "loading", error: null, aiBusy: false })));
      const todo: ThumbnailRow[] = [];
      for (const r of rows) {
        try {
          const buf = await api.readThumbnail(r.id);
          bytes.current.set(r.id, buf);
          if (seq !== loadSeq.current) return;
          const imageUrl = URL.createObjectURL(new Blob([buf]));
          const stored: Breakdown | null = r.breakdownJson ? JSON.parse(r.breakdownJson) : null;
          if (!forceRescore && stored?.version === 1 && stored.platform === plat) {
            update(r.id, { imageUrl, breakdown: stored, score: score(stored, weights), status: "ready" });
          } else {
            update(r.id, { imageUrl });
            todo.push(r);
          }
        } catch (e) {
          update(r.id, { status: "error", error: String(e) });
        }
      }
      for (const r of todo) await analyze(r, plat, seq);
      if (seq === loadSeq.current) refreshProjects();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [analyze, weights],
  );

  useEffect(() => {
    if (projectId == null) return;
    (async () => {
      const [t, p] = await Promise.all([api.getSetting(titleKey(projectId)), api.getSetting(platformKey(projectId))]);
      setVideoTitle(t ?? "");
      const plat = (p as PlatformId) ?? "youtube";
      setPlatform(plat);
      await load(projectId, plat);
    })().catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function createProject() {
    try {
      const p = await api.createProject(newTitle);
      setNewTitle("");
      await refreshProjects();
      setProjectId(p.id);
    } catch (e) {
      setError(String(e));
    }
  }

  async function switchPlatform(p: PlatformId) {
    if (projectId == null || p === platform) return;
    setPlatform(p);
    await api.setSetting(platformKey(projectId), p);
    await load(projectId, p, true);
  }

  async function addCandidates() {
    if (projectId == null) return;
    try {
      const paths = await pickImages(project?.folderPath ? joinPath(project.folderPath, "thumbnails") : undefined);
      if (!paths.length) return;
      await api.addThumbnails(projectId, paths, platform);
      await load(projectId, platform);
    } catch (e) {
      setError(String(e));
    }
  }

  async function changeWeights(w: Weights) {
    setWeights(w);
    await api.setSetting(WEIGHTS_KEY, JSON.stringify(w));
    for (const c of cands) if (c.breakdown) await persist(c.id, c.breakdown, w);
    refreshProjects();
  }

  async function override(c: CandidateView, dim: DimensionId, value: number | null) {
    if (!c.breakdown) return;
    const overrides = { ...c.breakdown.overrides };
    if (value == null) delete overrides[dim];
    else overrides[dim] = value;
    await persist(c.id, { ...c.breakdown, overrides });
  }

  async function runCritique(ids: number[]) {
    setConsent(null);
    setConsented(true);
    for (const id of ids) {
      const c = cands.find((x) => x.id === id);
      if (!c?.breakdown) continue;
      update(id, { aiBusy: true });
      try {
        const raster = rasters.current.get(id) ?? (await decode(bytes.current.get(id) ?? (await api.readThumbnail(id))));
        rasters.current.set(id, raster);
        const critique = await api.critiqueThumbnail(id, await critiqueJpegBase64(raster, platform), platform, videoTitle);
        await persist(id, withAi(c.breakdown, critique, null));
      } catch (e) {
        await persist(id, withAi(c.breakdown, null, String(e)));
      } finally {
        update(id, { aiBusy: false });
      }
    }
    refreshProjects();
  }

  function requestCritique(ids: number[]) {
    if (!ai?.configured) {
      for (const id of ids) {
        const c = cands.find((x) => x.id === id);
        if (c?.breakdown) persist(id, withAi(c.breakdown, null, "no API key set. Add one under Scoring settings. The other four dimensions still score offline."));
      }
      return;
    }
    if (consented) runCritique(ids);
    else setConsent({ ids });
  }

  async function pickWinner(id: number | null) {
    if (projectId == null) return;
    await api.setWinner(projectId, id);
    await refreshProjects();
  }

  async function remove(c: CandidateView) {
    await api.removeThumbnail(c.id);
    if (c.imageUrl) URL.revokeObjectURL(c.imageUrl);
    setCands((cs) => cs.filter((x) => x.id !== c.id));
    refreshProjects();
  }

  const scored = cands.filter((c) => c.score).map((c) => ({ id: c.id, name: c.label, score: c.score! }));
  const lead = useMemo(() => leaders(scored), [cands]); // eslint-disable-line react-hooks/exhaustive-deps
  const why = useMemo(() => explainWinner(scored), [cands]); // eslint-disable-line react-hooks/exhaustive-deps
  const busy = cands.some((c) => c.status === "analyzing" || c.status === "loading");

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Thumbnail tester</h1>
          <p className="text-xs text-muted">Scores are explained and adjustable. Text, subject, safe-zone and color checks run on this machine. The AI hook critique only runs when you ask.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className="rounded-md border border-line bg-panel px-2 py-1.5 text-sm" value={projectId ?? ""} onChange={(e) => setProjectId(Number(e.target.value))} aria-label="Project">
            {projects.length === 0 && <option value="">No projects yet</option>}
            {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
          <input className="w-44 rounded-md border border-line bg-panel px-2 py-1.5 text-sm" placeholder="New project title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createProject()} />
          <Button onClick={createProject} disabled={!newTitle.trim()}>Create</Button>
        </div>
      </div>

      {error && <div className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}

      {project && (
        <Panel>
          <div className="flex flex-wrap items-end gap-4 px-4 py-3">
            <div className="text-xs text-muted">
              Platform
              <div className="mt-1 flex rounded-md border border-line p-0.5">
                {(Object.keys(PLATFORMS) as PlatformId[]).map((p) => (
                  <button key={p} onClick={() => switchPlatform(p)} disabled={busy} className={`rounded px-2.5 py-1 text-sm ${platform === p ? "bg-accent text-accent-ink" : "text-ink hover:bg-sunken"}`}>
                    {PLATFORMS[p].label}
                  </button>
                ))}
              </div>
            </div>
            <label className="min-w-64 flex-1 text-xs text-muted">
              Video title (shown in previews, and sent with the AI critique)
              <input className="mt-1 block w-full rounded-md border border-line bg-panel px-2 py-1.5 text-sm text-ink" value={videoTitle} onChange={(e) => setVideoTitle(e.target.value)} onBlur={() => projectId != null && api.setSetting(titleKey(projectId), videoTitle)} placeholder="I fixed my leg day in 3 moves" />
            </label>
            <div className="flex gap-2">
              <Button onClick={addCandidates} disabled={cands.length >= 4 || !inDesktopApp} title={inDesktopApp ? "" : "Adding images needs the desktop app"}>Add candidates ({cands.length}/4)</Button>
              <Button onClick={() => requestCritique(cands.filter((c) => c.breakdown && !c.breakdown.ai).map((c) => c.id))} disabled={busy || !cands.some((c) => c.breakdown && !c.breakdown.ai)}>
                AI critique all
              </Button>
            </div>
          </div>
        </Panel>
      )}

      {!project && projects.length === 0 && (
        <Panel title="Start a test">
          <p className="px-4 py-6 text-sm text-muted">Create a project above, then add 2–4 thumbnail candidates to compare.</p>
        </Panel>
      )}

      {project && cands.length === 0 && (
        <Panel>
          <p className="px-4 py-8 text-center text-sm text-muted">Add 2–4 candidate images to compare. Images are read in place: nothing is copied or changed.</p>
        </Panel>
      )}

      {cands.length > 0 && (
        <div className={`grid gap-4 ${platform === "instagram" ? "grid-cols-[repeat(auto-fill,minmax(300px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(380px,1fr))]"}`}>
          {cands.map((c) => (
            <CandidateCard
              key={`${c.id}-${platform}`}
              c={c}
              spec={spec}
              title={videoTitle}
              isWinner={project?.winnerThumbnailId === c.id}
              leads={new Set(DIMENSIONS.map((d) => d.id).filter((d) => lead[d]?.includes(c.id)))}
              onPickWinner={() => pickWinner(c.id)}
              onRemove={() => remove(c)}
              onRename={(label) => api.renameThumbnail(c.id, label).then(() => update(c.id, { label }))}
              onOverride={(dim, v) => override(c, dim, v)}
              onCritique={() => requestCritique([c.id])}
            />
          ))}
        </div>
      )}

      {scored.length >= 2 && (
        <Panel title="Comparison" actions={project?.winnerThumbnailId ? <Button variant="ghost" onClick={() => pickWinner(null)}>Clear winner</Button> : null}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-sunken text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Dimension</th>
                  {scored.map((c) => (
                    <th key={c.id} className="px-4 py-2 font-medium">
                      {c.name} {project?.winnerThumbnailId === c.id && <Badge tone="ok">winner</Badge>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line tabular-nums">
                {DIMENSIONS.map((d) => (
                  <tr key={d.id}>
                    <td className="px-4 py-2 text-xs">{d.label} <span className="text-muted">({weights[d.id]})</span></td>
                    {scored.map((c) => {
                      const dim = c.score.dims.find((x) => x.id === d.id)!;
                      const best = lead[d.id]?.includes(c.id);
                      return (
                        <td key={c.id} className={`px-4 py-2 ${best ? "font-semibold text-ok" : ""}`}>
                          {dim.points == null ? <span className="text-muted">n/a</span> : dim.points.toFixed(1)}
                          {dim.overridden && <span className="ml-1 text-[10px] text-warn">edited</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr className="bg-sunken font-semibold">
                  <td className="px-4 py-2 text-xs">Score (0–100)</td>
                  {scored.map((c) => <td key={c.id} className="px-4 py-2">{c.score.total.toFixed(1)}</td>)}
                </tr>
              </tbody>
            </table>
          </div>
          {why && <p className="border-t border-line px-4 py-3 text-sm"><span className="font-medium">Why: </span>{why.text}</p>}
        </Panel>
      )}

      <ScoringSettings weights={weights} onWeights={changeWeights} ai={ai} onAi={setAi} />

      {consent && (
        <ConfirmDialog title="Send to Claude for critique?" confirmLabel="Send" onConfirm={() => runCritique(consent.ids)} onCancel={() => setConsent(null)}>
          <p>
            {consent.ids.length === 1 ? "This thumbnail" : `${consent.ids.length} thumbnails`} will be sent to Anthropic's API ({ai?.model}) as {spec.width}×{spec.height} JPEG
            {videoTitle.trim() ? <>, with the title "{videoTitle.trim()}"</> : null}. Nothing else leaves this computer.
          </p>
          <p className="text-muted">Each critique is a single API call billed to your key, and is cached so the same image isn't sent twice. You won't be asked again this session.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function ScoringSettings({ weights, onWeights, ai, onAi }: { weights: Weights; onWeights: (w: Weights) => void; ai: AiStatus | null; onAi: (s: AiStatus) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(weights);
  useEffect(() => setDraft(weights), [weights]);
  const total = Object.values(draft).reduce((a, b) => a + b, 0);

  return (
    <Panel title={<button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2">{open ? "▾" : "▸"} Scoring settings</button>} actions={ai && <Badge tone={ai.configured ? "ok" : "muted"}>{ai.configured ? `AI on (${ai.source === "env" ? "ANTHROPIC_API_KEY" : "keychain"})` : "AI off: heuristics only"}</Badge>}>
      {open && (
        <div className="grid gap-6 px-4 py-4 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Weights (points)</h3>
            {DIMENSIONS.map((d) => (
              <label key={d.id} className="flex items-center gap-3 py-1 text-sm">
                <span className="w-36">{d.label}</span>
                <input type="range" min={0} max={50} value={draft[d.id]} onChange={(e) => setDraft({ ...draft, [d.id]: Number(e.target.value) })} className="flex-1" />
                <span className="w-8 text-right tabular-nums">{draft[d.id]}</span>
              </label>
            ))}
            <p className="mt-1 text-xs text-muted">Total {total} points. Scores are shown out of 100 over the dimensions that are available.</p>
            <div className="mt-2 flex gap-2">
              <Button variant="primary" onClick={() => onWeights(draft)} disabled={JSON.stringify(draft) === JSON.stringify(weights) || total === 0}>Apply weights</Button>
              <Button variant="ghost" onClick={() => setDraft(DEFAULT_WEIGHTS)}>Defaults (30/25/20/15/10)</Button>
            </div>
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">AI critique (hook / curiosity)</h3>
            <ApiKeyField ai={ai} onAi={onAi} offlineNote="Without a key the other four dimensions still score offline." />
          </div>
        </div>
      )}
    </Panel>
  );
}
