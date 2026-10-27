import { useCallback, useEffect, useMemo, useState } from "react";
import { api, pickFolder } from "../db/api";
import { Badge, Button, ConfirmDialog, Panel, formatBytes, formatDuration } from "../app/ui";
import { MAX_FILES_PER_RUN, PRESETS, guessType, planRenames, slugify, type PlannedOp, type PlanInput } from "./renameEngine";
import { basename, joinPath } from "./paths";
import { TAG_PALETTE, tagColor } from "./tags";
import ClipEditor from "./ClipEditor";
import type { BatchSummary, MediaFile, ScanResult } from "./types";

type Tab = "inventory" | "duplicates" | "history";

export default function LibraryPage() {
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; batchId?: string } | null>(null);
  const [tab, setTab] = useState<Tab>("inventory");

  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [slug, setSlug] = useState("");
  const [sortIntoFolders, setSortIntoFolders] = useState(false);
  const [typeOverrides, setTypeOverrides] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const [plan, setPlan] = useState<PlannedOp[] | null>(null);
  const [planMs, setPlanMs] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [clip, setClip] = useState<MediaFile | null>(null);
  const [sectionCounts, setSectionCounts] = useState<Record<string, number>>({});

  const preset = PRESETS.find((p) => p.id === presetId)!;
  const files = scan?.files ?? [];
  const typeOf = useCallback((f: MediaFile) => typeOverrides[f.id] ?? guessType(f, preset), [typeOverrides, preset]);

  // Any change to the inputs invalidates the dry-run; the user must preview again.
  useEffect(() => setPlan(null), [presetId, slug, sortIntoFolders, typeOverrides, selected, scan]);

  useEffect(() => {
    if (scan && !clip) api.sectionCounts(scan.root).then(setSectionCounts, () => setSectionCounts({}));
  }, [scan, clip]);

  async function runScan(root: string, keepSelection = false) {
    setScanning(true);
    setError(null);
    try {
      const result = await api.scanFolder(root);
      setScan(result);
      if (!keepSelection) {
        setSelected(new Set(result.files.map((f) => f.id)));
        setTypeOverrides({});
        setSlug((s) => s || slugify(basename(result.root)));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }

  async function chooseFolder() {
    const root = await pickFolder();
    if (root) await runScan(root);
  }

  async function preview() {
    if (!scan) return;
    setError(null);
    const chosen = files.filter((f) => selected.has(f.id)).slice(0, MAX_FILES_PER_RUN);
    const inputs: PlanInput[] = chosen.map((f) => {
      const type = typeOf(f);
      const targetDir = sortIntoFolders ? joinPath(scan.root, preset.folders[type] ?? type) : f.dir;
      return { file: f, fields: { date: f.capturedDate, slug, type }, targetDir };
    });
    try {
      const listing = await api.listDirNames([...new Set(inputs.map((i) => i.targetDir))]);
      const t = performance.now();
      const ops = planRenames(inputs, preset.pattern, (dir) => listing[dir] ?? []);
      setPlanMs(performance.now() - t);
      setPlan(ops);
    } catch (e) {
      setError(String(e));
    }
  }

  const changes = useMemo(() => plan?.filter((op) => op.status === "rename") ?? [], [plan]);

  async function apply() {
    if (!scan) return;
    setBusy(true);
    try {
      const batchId = await api.applyMoves(changes.map((op) => ({ fileId: op.fileId, oldPath: op.oldPath, newPath: op.newPath })));
      setConfirming(false);
      setNotice({ text: `Renamed ${changes.length} file${changes.length === 1 ? "" : "s"}.`, batchId });
      await runScan(scan.root, true);
    } catch (e) {
      setConfirming(false);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function undo(batchId: string) {
    if (!scan) return;
    try {
      const n = await api.undoBatch(batchId);
      setNotice({ text: `Undone: ${n} file${n === 1 ? "" : "s"} restored to their original paths.` });
      await runScan(scan.root, true);
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleTag(f: MediaFile, tag: string) {
    const tags = f.tags.includes(tag) ? f.tags.filter((t) => t !== tag) : [...f.tags, tag];
    await api.setTags(f.id, tags);
    setScan((s) => s && { ...s, files: s.files.map((x) => (x.id === f.id ? { ...x, tags } : x)) });
  }

  if (!scan) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Panel title="Media library">
          <div className="space-y-4 px-4 py-8 text-center">
            <p className="text-sm text-muted">
              Pick a folder of videos, photos and audio. Scanning is read-only. Nothing is renamed until you preview the changes and confirm them.
            </p>
            <Button variant="primary" onClick={chooseFolder} disabled={scanning}>
              {scanning ? "Scanning…" : "Choose folder"}
            </Button>
            {error && <p className="text-sm text-danger">{error}</p>}
          </div>
        </Panel>
      </div>
    );
  }

  const noticeBanner = notice && (
    <div className="flex items-center justify-between rounded-md bg-ok/10 px-3 py-2 text-sm text-ok">
      <span>{notice.text}</span>
      <span className="flex gap-2">
        {notice.batchId && <Button onClick={() => undo(notice.batchId!)}>Undo</Button>}
        <Button variant="ghost" onClick={() => setNotice(null)}>Dismiss</Button>
      </span>
    </div>
  );

  if (clip) {
    return (
      <>
        {noticeBanner && <div className="px-6 pt-6">{noticeBanner}</div>}
        <ClipEditor key={clip.id} file={clip} root={scan.root} onBack={() => { setClip(null); setNotice(null); }} onNotice={(text, batchId) => setNotice({ text, batchId })} />
      </>
    );
  }

  const allSelected = selected.size === files.length && files.length > 0;

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold" title={scan.root}>{basename(scan.root) || scan.root}</h1>
          <p className="truncate text-xs text-muted">
            {scan.root} · {files.length} files · scanned in {scan.elapsedMs} ms
            {scan.truncated && " · list truncated, scan a subfolder"}
            {scan.skipped > 0 && ` · ${scan.skipped} unreadable`}
            {!scan.ffprobeAvailable && " · ffprobe not found (no video duration/resolution)"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => runScan(scan.root, true)} disabled={scanning}>{scanning ? "Scanning…" : "Rescan"}</Button>
          <Button onClick={chooseFolder} disabled={scanning}>Change folder</Button>
        </div>
      </div>

      {error && <div className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
      {noticeBanner}

      <Panel title="Naming">
        <div className="flex flex-wrap items-end gap-4 px-4 py-3">
          <label className="text-xs text-muted">
            Preset
            <select className="mt-1 block rounded-md border border-line bg-panel px-2 py-1.5 text-sm text-ink" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <label className="text-xs text-muted">
            Project / topic
            <input className="mt-1 block w-56 rounded-md border border-line bg-panel px-2 py-1.5 text-sm text-ink" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="leg day routine" />
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" checked={sortIntoFolders} onChange={(e) => setSortIntoFolders(e.target.checked)} />
            Sort into type folders
          </label>
          <div className="pb-2 text-xs text-muted">
            Pattern <code className="font-mono text-ink">{preset.pattern}.ext</code> → e.g.{" "}
            <code className="font-mono text-ink">2026-10-27_{slugify(slug) || "untitled"}_{preset.types[0]}_v01.mp4</code>
          </div>
          <div className="ml-auto pb-0.5">
            <Button variant="primary" onClick={preview} disabled={selected.size === 0 || !slugify(slug)}>
              Preview changes ({Math.min(selected.size, MAX_FILES_PER_RUN)})
            </Button>
          </div>
        </div>
        {selected.size > MAX_FILES_PER_RUN && (
          <p className="px-4 pb-3 text-xs text-warn">A run is capped at {MAX_FILES_PER_RUN} files. The first {MAX_FILES_PER_RUN} selected will be planned. Apply, then run again for the rest.</p>
        )}
      </Panel>

      {plan && (
        <Panel
          title={
            <span className="flex items-center gap-2">
              Dry run <Badge tone="accent">{changes.length} to change</Badge>
              <Badge>{plan.length - changes.length} already named</Badge>
              <span className="text-xs font-normal text-muted">planned in {planMs.toFixed(0)} ms · nothing has been written yet</span>
            </span>
          }
          actions={
            <>
              <Button variant="ghost" onClick={() => setPlan(null)}>Discard</Button>
              <Button variant="primary" disabled={changes.length === 0} onClick={() => setConfirming(true)}>Apply {changes.length} changes…</Button>
            </>
          }
        >
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-panel text-left text-xs text-muted">
                <tr><th className="px-4 py-2 font-medium">Current</th><th className="px-2 py-2" /><th className="px-4 py-2 font-medium">New</th></tr>
              </thead>
              <tbody className="divide-y divide-line font-mono text-xs">
                {plan.map((op) => (
                  <tr key={op.fileId} className={op.status === "unchanged" ? "text-muted" : ""}>
                    <td className="px-4 py-1.5 break-all">{relative(op.oldPath, scan.root)}</td>
                    <td className="px-2 text-muted">→</td>
                    <td className="px-4 py-1.5 break-all">
                      {op.status === "unchanged" ? "unchanged" : relative(op.newPath, scan.root)}
                      {op.bumped && <span className="ml-2"><Badge tone="warn">version bumped</Badge></span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <div className="flex gap-1 border-b border-line">
        {(["inventory", "duplicates", "history"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 text-sm capitalize ${tab === t ? "border-accent font-medium" : "border-transparent text-muted hover:text-ink"}`}>
            {t}
          </button>
        ))}
      </div>

      {tab === "inventory" && (
        <Panel>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-sunken text-left text-xs text-muted">
                <tr>
                  <th className="w-8 px-3 py-2">
                    <input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(files.map((f) => f.id)))} />
                  </th>
                  <th className="px-3 py-2 font-medium">File</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Size</th>
                  <th className="px-3 py-2 font-medium">Dimensions</th>
                  <th className="px-3 py-2 font-medium">Duration</th>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Tags</th>
                  <th className="px-3 py-2 font-medium">Sections</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {files.map((f) => (
                  <tr key={f.id} className="hover:bg-sunken/50">
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        aria-label={`Select ${f.filename}`}
                        checked={selected.has(f.id)}
                        onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; })}
                      />
                    </td>
                    <td className="max-w-xs px-3 py-1.5">
                      <div className="truncate font-medium" title={f.path}>{f.filename}</div>
                      <div className="truncate text-xs text-muted">{relative(f.dir, scan.root) || "."} · {f.kind}</div>
                    </td>
                    <td className="px-3 py-1.5">
                      <select
                        className="rounded border border-line bg-panel px-1.5 py-0.5 text-xs"
                        value={typeOf(f)}
                        onChange={(e) => setTypeOverrides((o) => ({ ...o, [f.id]: e.target.value }))}
                      >
                        {preset.types.map((t) => <option key={t}>{t}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-1.5 tabular-nums text-muted">{formatBytes(f.sizeBytes)}</td>
                    <td className="px-3 py-1.5 tabular-nums text-muted">{f.width && f.height ? `${f.width}×${f.height}` : "—"}</td>
                    <td className="px-3 py-1.5 tabular-nums text-muted">{formatDuration(f.durationS)}</td>
                    <td className="px-3 py-1.5 tabular-nums text-muted">{f.capturedDate}</td>
                    <td className="px-3 py-1.5">
                      <TagCell file={f} onToggle={(t) => toggleTag(f, t)} />
                    </td>
                    <td className="px-3 py-1.5">
                      {f.kind !== "photo" && (
                        <Button variant="ghost" className="!px-2 !py-0.5 text-xs" onClick={() => setClip(f)}>
                          {sectionCounts[f.id] ? `${sectionCounts[f.id]} sections` : "Split…"}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {files.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted">No media files found in this folder.</p>}
          </div>
        </Panel>
      )}

      {tab === "duplicates" && <Duplicates root={scan.root} onArchived={(batchId, n) => { setNotice({ text: `Archived ${n} file${n === 1 ? "" : "s"} to _archive/.`, batchId }); runScan(scan.root, true); }} onError={setError} />}
      {tab === "history" && <History onUndo={undo} refreshKey={scan} />}

      {confirming && (
        <ConfirmDialog title={`Rename ${changes.length} files?`} confirmLabel={`Rename ${changes.length} files`} onConfirm={apply} onCancel={() => setConfirming(false)} busy={busy}>
          <p>Files are moved to their new names. Their contents are never changed and nothing is deleted.</p>
          <p className="text-muted">If any file can't be moved, the whole run is rolled back. You can undo this run from History at any time.</p>
          {sortIntoFolders && <p className="text-muted">Missing type folders will be created inside {basename(scan.root)}.</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}

function relative(path: string, root: string): string {
  return path.toLowerCase().startsWith(root.toLowerCase()) ? path.slice(root.length).replace(/^[\\/]/, "") : path;
}

function TagCell({ file, onToggle }: { file: MediaFile; onToggle: (tag: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex flex-wrap items-center gap-1">
      {file.tags.map((t) => (
        <button key={t} onClick={() => onToggle(t)} title="Remove tag" className="rounded px-1.5 py-0.5 text-xs font-medium text-white" style={{ background: tagColor(t) }}>
          {t}
        </button>
      ))}
      <button onClick={() => setOpen((o) => !o)} className="rounded px-1.5 py-0.5 text-xs text-muted hover:bg-sunken" aria-label={`Edit tags for ${file.filename}`}>+</button>
      {open && (
        <div className="absolute right-0 top-6 z-10 w-36 rounded-md border border-line bg-panel p-1 shadow-lg" onMouseLeave={() => setOpen(false)}>
          {TAG_PALETTE.map((t) => (
            <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-sunken">
              <input type="checkbox" checked={file.tags.includes(t.id)} onChange={() => onToggle(t.id)} />
              <span className="h-2 w-2 rounded-full" style={{ background: t.color }} />
              {t.id}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function Duplicates({ root, onArchived, onError }: { root: string; onArchived: (batchId: string, n: number) => void; onError: (e: string) => void }) {
  const [groups, setGroups] = useState<MediaFile[][] | null>(null);
  const [pending, setPending] = useState<{ file: MediaFile; target: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setGroups(null);
    api.findDuplicates(root).then(setGroups, (e) => onError(String(e)));
  }, [root]);

  async function askArchive(file: MediaFile) {
    const [target] = await api.previewArchive(root, [file.path]);
    setPending({ file, target });
  }

  async function confirmArchive() {
    if (!pending) return;
    setBusy(true);
    try {
      const batchId = await api.archiveFiles(root, [pending.file.id]);
      setGroups((g) => g?.map((grp) => grp.filter((f) => f.id !== pending.file.id)).filter((grp) => grp.length > 1) ?? null);
      onArchived(batchId, 1);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  return (
    <Panel title="Duplicates" actions={<span className="text-xs text-muted">Matched by full content hash · review only, nothing is removed automatically</span>}>
      {groups === null && <p className="px-4 py-6 text-sm text-muted">Hashing candidates…</p>}
      {groups?.length === 0 && <p className="px-4 py-6 text-sm text-muted">No duplicates found.</p>}
      <div className="divide-y divide-line">
        {groups?.map((group, i) => (
          <div key={i} className="px-4 py-3">
            <div className="mb-1.5 text-xs text-muted">{group.length} identical copies · {formatBytes(group[0].sizeBytes)} each</div>
            <ul className="space-y-1">
              {group.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate font-mono text-xs" title={f.path}>{relative(f.path, root)}</span>
                  <Button variant="ghost" onClick={() => askArchive(f)}>Archive</Button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {pending && (
        <ConfirmDialog title="Archive this copy?" confirmLabel="Move to archive" onConfirm={confirmArchive} onCancel={() => setPending(null)} busy={busy}>
          <p>The file is moved, not deleted:</p>
          <p className="break-all font-mono text-xs">{relative(pending.file.path, root)}<br />→ {relative(pending.target, root)}</p>
          <p className="text-muted">Undo from History restores it.</p>
        </ConfirmDialog>
      )}
    </Panel>
  );
}

function History({ onUndo, refreshKey }: { onUndo: (batchId: string) => Promise<void>; refreshKey: unknown }) {
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  useEffect(() => {
    api.listBatches().then(setBatches);
  }, [refreshKey]);
  return (
    <Panel title="History" actions={<span className="text-xs text-muted">Every run is logged. Undo restores original paths in reverse order.</span>}>
      {batches.length === 0 && <p className="px-4 py-6 text-sm text-muted">No changes applied yet.</p>}
      <ul className="divide-y divide-line">
        {batches.map((b) => (
          <li key={b.batchId} className="flex items-center justify-between px-4 py-2.5 text-sm">
            <span className="flex items-center gap-2">
              <Badge tone={b.kind === "archive" ? "warn" : "accent"}>{b.kind}</Badge>
              {b.opCount} file{b.opCount === 1 ? "" : "s"}
              <span className="text-xs text-muted">{new Date(b.appliedAt).toLocaleString()}</span>
            </span>
            {b.undoneAt ? <Badge>undone {new Date(b.undoneAt).toLocaleTimeString()}</Badge> : <Button onClick={() => onUndo(b.batchId)}>Undo</Button>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
