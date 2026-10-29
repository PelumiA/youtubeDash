import { useEffect, useMemo, useRef, useState } from "react";
import { api, inDesktopApp, mediaUrl } from "../db/api";
import { Badge, Button, ConfirmDialog, Panel } from "../app/ui";
import { basename } from "./paths";
import {
  SECTION_TAGS,
  buildChapters,
  formatPrecise,
  formatTimestamp,
  isOnKeyframe,
  parseTimestamp,
  sectionsFromMarkers,
  snapToKeyframe,
  type ClipSection,
  type CutAnalysis,
} from "./sections";
import type { MediaFile } from "./types";

const SECTION_COLORS = ["#e5533d", "#2563eb", "#16a34a", "#d97706", "#7c3aed", "#db2777", "#0891b2"];

interface Props {
  file: MediaFile;
  root: string;
  onBack: () => void;
  onNotice: (text: string, batchId?: string) => void;
}

/**
 * Breaks a long clip into labeled sections: manual markers, silence/scene suggestions,
 * then export as separate files. The user confirms every section; the source is only read.
 */
export default function ClipEditor({ file, root, onBack, onNotice }: Props) {
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [duration, setDuration] = useState(file.durationS ?? 0);
  const [t, setT] = useState(0);
  const [markers, setMarkers] = useState<number[]>([]);
  const [analysis, setAnalysis] = useState<CutAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [keyframes, setKeyframes] = useState<number[]>([]);
  const [snap, setSnap] = useState(true);
  const [sections, setSections] = useState<ClipSection[]>([]);
  const [toExport, setToExport] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [noiseDb, setNoiseDb] = useState(-35);
  const [minSilenceS, setMinSilenceS] = useState(0.7);
  const [withScenes, setWithScenes] = useState(false);
  const [confirm, setConfirm] = useState<null | { kind: "replace" } | { kind: "export" } | { kind: "delete"; section: ClipSection }>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const isVideo = file.kind === "video";
  const src = mediaUrl(file.path);

  useEffect(() => {
    api.listSections(file.id).then(setSections, (e) => setError(String(e)));
    if (isVideo) api.clipKeyframes(file.path).then(setKeyframes, () => setKeyframes([]));
  }, [file.id, file.path, isVideo]);

  const snapT = (x: number) => (snap && keyframes.length ? snapToKeyframe(x, keyframes) : x);

  function seek(x: number) {
    const clamped = Math.min(Math.max(0, x), duration || x);
    setT(clamped);
    if (mediaRef.current) mediaRef.current.currentTime = clamped;
  }

  function addMarker(at: number) {
    const m = Math.round(snapT(at) * 1000) / 1000;
    setMarkers((ms) => (ms.some((x) => Math.abs(x - m) < 0.25) ? ms : [...ms, m].sort((a, b) => a - b)));
  }

  // "M" drops a marker at the playhead, unless the user is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key.toLowerCase() === "m" && !e.ctrlKey && !e.metaKey && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
        e.preventDefault();
        addMarker(mediaRef.current?.currentTime ?? t);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function analyze() {
    setAnalyzing(true);
    setError(null);
    try {
      setAnalysis(await api.analyzeClip(file.path, { noiseDb, minSilenceS, scenes: withScenes && isVideo, sceneThreshold: 0.4 }));
    } catch (e) {
      setError(String(e));
    } finally {
      setAnalyzing(false);
    }
  }

  async function createFromMarkers() {
    setBusy(true);
    try {
      let archived: string | null = null;
      for (const s of sections) archived = (await api.deleteSection(root, s.id!)) ?? archived;
      const fresh = sectionsFromMarkers(markers, duration, file.id);
      const saved: ClipSection[] = [];
      for (const s of fresh) saved.push(await api.saveSection(s));
      setSections(saved);
      setToExport(new Set(saved.map((s) => s.id!)));
      setMarkers([]);
      if (archived) onNotice("Previous section exports were moved to _archive/.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  async function addSectionAtPlayhead() {
    const start = snapT(t);
    const next = [...markers, ...sections.map((s) => s.startS)].filter((x) => x > start + 1).sort((a, b) => a - b)[0];
    const end = Math.min(next ?? start + 30, duration);
    if (end <= start) return;
    try {
      const saved = await api.saveSection({ id: null, mediaFileId: file.id, startS: start, endS: end, label: `Section ${sections.length + 1}`, tags: [], notes: "", exportedPath: null });
      setSections((ss) => [...ss, saved].sort((a, b) => a.startS - b.startS));
    } catch (e) {
      setError(String(e));
    }
  }

  async function update(section: ClipSection, patch: Partial<ClipSection>) {
    const next = { ...section, ...patch };
    setSections((ss) => ss.map((s) => (s.id === section.id ? next : s)));
    try {
      const saved = await api.saveSection(next);
      setSections((ss) => ss.map((s) => (s.id === saved.id ? saved : s)).sort((a, b) => a.startS - b.startS));
    } catch (e) {
      setError(String(e));
      setSections((ss) => ss.map((s) => (s.id === section.id ? section : s)));
    }
  }

  async function remove(section: ClipSection) {
    setBusy(true);
    try {
      const batch = await api.deleteSection(root, section.id!);
      setSections((ss) => ss.filter((s) => s.id !== section.id));
      if (batch) onNotice(`Deleted "${section.label}". Its export was moved to _archive/.`, batch);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  async function exportSelected() {
    setBusy(true);
    setError(null);
    try {
      const results = await api.exportSections(root, file.id, [...toExport]);
      setSections(await api.listSections(file.id));
      const ok = results.filter((r) => r.path);
      const failed = results.filter((r) => r.error);
      onNotice(`Exported ${ok.length} section${ok.length === 1 ? "" : "s"} to _sections/. The source clip was not modified.`);
      if (failed.length) setError(failed.map((r) => r.error).join("\n"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  const chapters = useMemo(() => buildChapters(sections, duration), [sections, duration]);
  const exportList = sections.filter((s) => s.id != null && toExport.has(s.id));
  const encodeCount = isVideo ? exportList.filter((s) => !isOnKeyframe(s.startS, keyframes)).length : 0;
  const stem = file.filename.replace(/\.[^.]+$/, "");

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <button onClick={onBack} className="text-xs text-muted hover:text-ink">← Back to library</button>
          <h1 className="truncate text-xl font-semibold" title={file.path}>{file.filename}</h1>
          <p className="text-xs text-muted">
            {formatTimestamp(duration)} · {file.kind}
            {isVideo && keyframes.length > 0 && ` · ${keyframes.length} keyframes`}
            {" · "}the source is never cut or modified
          </p>
        </div>
      </div>

      {error && <div className="whitespace-pre-wrap rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}

      <Panel>
        {src ? (
          isVideo ? (
            <video ref={mediaRef} src={src} controls className="max-h-[42vh] w-full rounded-t-lg bg-black" onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onLoadedMetadata={(e) => setDuration((d) => d || e.currentTarget.duration)} />
          ) : (
            <audio ref={mediaRef} src={src} controls className="w-full p-3" onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onLoadedMetadata={(e) => setDuration((d) => d || e.currentTarget.duration)} />
          )
        ) : (
          <div className="flex h-40 items-center justify-center rounded-t-lg bg-sunken text-sm text-muted">
            {inDesktopApp ? "Preview unavailable" : "Video preview runs in the desktop app. Click the timeline to move the playhead."}
          </div>
        )}
        <div className="space-y-3 p-4">
          <Timeline duration={duration} t={t} sections={sections} markers={markers} analysis={analysis} onSeek={seek} onAcceptSuggestion={addMarker} onRemoveMarker={(m) => setMarkers((ms) => ms.filter((x) => x !== m))} />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => addMarker(t)}>Add marker at {formatPrecise(snapT(t))} <kbd className="ml-1 rounded bg-black/15 px-1 text-[10px]">M</kbd></Button>
            <Button onClick={addSectionAtPlayhead} disabled={!duration}>Add section here</Button>
            {isVideo && (
              <label className="flex items-center gap-1.5 text-xs text-muted" title="Markers on keyframes export by stream copy: fast and lossless">
                <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} disabled={!keyframes.length} /> Snap to keyframes
              </label>
            )}
            <span className="mx-1 h-5 w-px bg-line" />
            <label className="text-xs text-muted">
              Silence below
              <input type="number" className="mx-1 w-14 rounded border border-line bg-panel px-1 py-0.5 text-xs text-ink" value={noiseDb} onChange={(e) => setNoiseDb(Number(e.target.value))} step={1} max={0} />
              dB for
              <input type="number" className="mx-1 w-12 rounded border border-line bg-panel px-1 py-0.5 text-xs text-ink" value={minSilenceS} onChange={(e) => setMinSilenceS(Number(e.target.value))} step={0.1} min={0.1} />s
            </label>
            {isVideo && (
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" checked={withScenes} onChange={(e) => setWithScenes(e.target.checked)} /> + scene changes
              </label>
            )}
            <Button onClick={analyze} disabled={analyzing}>{analyzing ? "Analyzing…" : "Detect cut points"}</Button>
          </div>
          {analysis && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              Found {analysis.silences.length} pauses{isVideo && withScenes && ` and ${analysis.scenes.length} scene changes`}. Suggestions are dashed on the timeline; click one to turn it into a marker.
              <Button variant="ghost" onClick={() => analysis.suggestions.concat(analysis.scenes).forEach(addMarker)} disabled={!analysis.suggestions.length && !analysis.scenes.length}>Accept all</Button>
            </div>
          )}
          {markers.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-sunken px-3 py-2 text-xs">
              <span className="text-muted">{markers.length} marker{markers.length === 1 ? "" : "s"}:</span>
              {markers.map((m) => (
                <button key={m} onClick={() => setMarkers((ms) => ms.filter((x) => x !== m))} className="rounded bg-panel px-1.5 py-0.5 font-mono hover:line-through" title="Remove marker">{formatPrecise(m)}</button>
              ))}
              <span className="ml-auto flex gap-2">
                <Button variant="ghost" onClick={() => setMarkers([])}>Clear</Button>
                <Button variant="primary" disabled={busy || !duration} onClick={() => (sections.length ? setConfirm({ kind: "replace" }) : createFromMarkers())}>
                  Split into {markers.filter((m) => m > 0.5 && m < duration - 0.5).length + 1} sections
                </Button>
              </span>
            </div>
          )}
        </div>
      </Panel>

      <Panel
        title={<span className="flex items-center gap-2">Sections <Badge>{sections.length}</Badge></span>}
        actions={
          <Button variant="primary" disabled={exportList.length === 0 || busy} onClick={() => setConfirm({ kind: "export" })}>
            Export {exportList.length} section{exportList.length === 1 ? "" : "s"}…
          </Button>
        }
      >
        {sections.length === 0 && <p className="px-4 py-6 text-sm text-muted">No sections yet. Drop markers while previewing (press M), or detect cut points, then split.</p>}
        <ul className="divide-y divide-line">
          {sections.map((s, i) => (
            <SectionRow
              key={s.id}
              section={s}
              color={SECTION_COLORS[i % SECTION_COLORS.length]}
              duration={duration}
              fastCopy={!isVideo || isOnKeyframe(s.startS, keyframes)}
              selected={toExport.has(s.id!)}
              onSelect={(on) => setToExport((set) => { const n = new Set(set); if (on) n.add(s.id!); else n.delete(s.id!); return n; })}
              onPlay={() => { seek(s.startS); mediaRef.current?.play(); }}
              onChange={(patch) => update(s, patch)}
              onDelete={() => (s.exportedPath ? setConfirm({ kind: "delete", section: s }) : remove(s))}
            />
          ))}
        </ul>
      </Panel>

      {sections.length > 0 && (
        <Panel
          title="YouTube chapters"
          actions={
            <Button onClick={() => navigator.clipboard.writeText(chapters.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
              {copied ? "Copied" : "Copy"}
            </Button>
          }
        >
          <div className="space-y-2 p-4">
            <textarea readOnly value={chapters.text} rows={Math.min(12, chapters.text.split("\n").length + 1)} className="w-full rounded-md border border-line bg-sunken p-2 font-mono text-xs" />
            {chapters.warnings.map((w) => <p key={w} className="text-xs text-warn">{w}</p>)}
          </div>
        </Panel>
      )}

      {confirm?.kind === "replace" && (
        <ConfirmDialog title={`Replace ${sections.length} existing sections?`} confirmLabel="Replace sections" onConfirm={createFromMarkers} onCancel={() => setConfirm(null)} busy={busy}>
          <p>The current sections will be replaced by sections split at your markers.</p>
          <p className="text-muted">Any exported files from the old sections are moved to _archive/, not deleted. The source clip is untouched.</p>
        </ConfirmDialog>
      )}
      {confirm?.kind === "export" && (
        <ConfirmDialog title={`Export ${exportList.length} sections?`} confirmLabel="Export" onConfirm={exportSelected} onCancel={() => setConfirm(null)} busy={busy}>
          <p>Each section becomes a new file in <code className="font-mono text-xs">{basename(root)}/_sections/{stem}/</code>. The source clip is read only. It is never cut or changed.</p>
          {isVideo && (
            <p className="text-muted">
              {exportList.length - encodeCount} start on a keyframe and are stream-copied (fast, lossless).
              {encodeCount > 0 && ` ${encodeCount} start between keyframes and will be re-encoded to H.264 for a frame-accurate cut (slower). Turn on "Snap to keyframes" to avoid that.`}
            </p>
          )}
          {exportList.some((s) => s.exportedPath) && <p className="text-muted">Sections exported before will have their old file moved to _archive/.</p>}
        </ConfirmDialog>
      )}
      {confirm?.kind === "delete" && (
        <ConfirmDialog title={`Delete "${confirm.section.label}"?`} confirmLabel="Delete section" onConfirm={() => remove(confirm.section)} onCancel={() => setConfirm(null)} busy={busy}>
          <p>The section is removed. Its exported file is moved to _archive/ (undoable from History). The source clip is untouched.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function Timeline({
  duration,
  t,
  sections,
  markers,
  analysis,
  onSeek,
  onAcceptSuggestion,
  onRemoveMarker,
}: {
  duration: number;
  t: number;
  sections: ClipSection[];
  markers: number[];
  analysis: CutAnalysis | null;
  onSeek: (t: number) => void;
  onAcceptSuggestion: (t: number) => void;
  onRemoveMarker: (t: number) => void;
}) {
  const pct = (x: number) => `${duration ? (x / duration) * 100 : 0}%`;
  const ticks = duration ? [0, 0.25, 0.5, 0.75, 1].map((f) => f * duration) : [];
  return (
    <div className="select-none">
      <div
        className="relative h-16 cursor-pointer overflow-hidden rounded-md border border-line bg-sunken"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek(((e.clientX - r.left) / r.width) * duration);
        }}
        role="slider"
        aria-label="Clip timeline"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={t}
      >
        {sections.map((s, i) => (
          <div key={s.id ?? i} className="absolute top-0 h-9 overflow-hidden border-r border-panel px-1 text-[10px] font-medium leading-9 text-white" style={{ left: pct(s.startS), width: pct(s.endS - s.startS), background: SECTION_COLORS[i % SECTION_COLORS.length] }} title={`${s.label} (${formatPrecise(s.startS)}–${formatPrecise(s.endS)})`}>
            {s.label}
          </div>
        ))}
        {analysis?.silences.map((s, i) => (
          <div key={`sil${i}`} className="absolute bottom-0 h-3 bg-muted/40" style={{ left: pct(s.startS), width: pct(Math.max(s.endS - s.startS, duration / 800)) }} title={`Pause ${formatPrecise(s.startS)}–${formatPrecise(s.endS)}`} />
        ))}
        {analysis?.scenes.map((x, i) => (
          <div key={`sc${i}`} className="absolute bottom-3 h-2 w-0.5 bg-ink/50" style={{ left: pct(x) }} title={`Scene change ${formatPrecise(x)}`} />
        ))}
        {analysis?.suggestions.map((x, i) => (
          <button key={`sg${i}`} className="absolute top-0 h-full w-2 -translate-x-1/2 border-x border-dashed border-accent/0 hover:bg-accent/20" style={{ left: pct(x) }} onClick={(e) => { e.stopPropagation(); onAcceptSuggestion(x); }} title={`Suggested cut ${formatPrecise(x)}. Click to add a marker.`}>
            <span className="absolute left-1/2 top-0 h-full border-l-2 border-dashed border-accent/70" />
          </button>
        ))}
        {markers.map((m) => (
          <button key={m} className="absolute top-0 h-full w-2 -translate-x-1/2" style={{ left: pct(m) }} onClick={(e) => { e.stopPropagation(); onRemoveMarker(m); }} title={`Marker ${formatPrecise(m)}. Click to remove.`}>
            <span className="absolute left-1/2 top-0 h-full border-l-2 border-accent" />
            <span className="absolute -top-0.5 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-accent" />
          </button>
        ))}
        <div className="pointer-events-none absolute top-0 h-full w-px bg-ink" style={{ left: pct(t) }} />
      </div>
      <div className="relative mt-1 h-4 text-[10px] tabular-nums text-muted">
        {ticks.map((x, i) => (
          <span key={i} className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full" style={{ left: pct(x) }}>{formatTimestamp(x)}</span>
        ))}
      </div>
    </div>
  );
}

function SectionRow({
  section: s,
  color,
  duration,
  fastCopy,
  selected,
  onSelect,
  onPlay,
  onChange,
  onDelete,
}: {
  section: ClipSection;
  color: string;
  duration: number;
  fastCopy: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onPlay: () => void;
  onChange: (patch: Partial<ClipSection>) => void;
  onDelete: () => void;
}) {
  const [label, setLabel] = useState(s.label);
  const [start, setStart] = useState(formatPrecise(s.startS));
  const [end, setEnd] = useState(formatPrecise(s.endS));
  const [notes, setNotes] = useState(s.notes);
  useEffect(() => { setLabel(s.label); setStart(formatPrecise(s.startS)); setEnd(formatPrecise(s.endS)); setNotes(s.notes); }, [s]);

  function commitTime(which: "startS" | "endS", text: string) {
    const v = parseTimestamp(text);
    if (v == null || v > duration + 0.01) {
      setStart(formatPrecise(s.startS));
      setEnd(formatPrecise(s.endS));
      return;
    }
    if (Math.abs(v - s[which]) > 0.01) onChange({ [which]: v });
  }

  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3">
      <input type="checkbox" className="mt-2" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Export ${s.label}`} />
      <span className="mt-2 h-3 w-3 shrink-0 rounded-sm" style={{ background: color }} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <input className="w-56 rounded border border-line bg-panel px-2 py-1 text-sm font-medium" value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => label !== s.label && onChange({ label })} aria-label="Section label" />
          <input className="w-20 rounded border border-line bg-panel px-1.5 py-1 font-mono text-xs" value={start} onChange={(e) => setStart(e.target.value)} onBlur={(e) => commitTime("startS", e.target.value)} aria-label="Start" />
          <span className="text-muted">→</span>
          <input className="w-20 rounded border border-line bg-panel px-1.5 py-1 font-mono text-xs" value={end} onChange={(e) => setEnd(e.target.value)} onBlur={(e) => commitTime("endS", e.target.value)} aria-label="End" />
          <span className="text-xs tabular-nums text-muted">{formatTimestamp(s.endS - s.startS)}</span>
          <Badge tone={fastCopy ? "ok" : "warn"}>{fastCopy ? "lossless copy" : "re-encode"}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {SECTION_TAGS.map((tag) => {
            const on = s.tags.includes(tag);
            return (
              <button key={tag} onClick={() => onChange({ tags: on ? s.tags.filter((x) => x !== tag) : [...s.tags, tag] })} className={`rounded px-1.5 py-0.5 text-[11px] ${on ? "bg-accent text-accent-ink" : "bg-sunken text-muted hover:text-ink"}`}>
                {tag}
              </button>
            );
          })}
          <input className="ml-2 min-w-40 flex-1 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-xs hover:border-line focus:border-line" placeholder="Notes…" value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== s.notes && onChange({ notes })} />
        </div>
        {s.exportedPath && <p className="truncate font-mono text-[11px] text-ok" title={s.exportedPath}>✓ {basename(s.exportedPath)}</p>}
      </div>
      <div className="flex gap-1">
        <Button variant="ghost" onClick={onPlay} aria-label={`Play ${s.label}`}>▶</Button>
        <Button variant="ghost" onClick={onDelete} aria-label={`Delete ${s.label}`}>✕</Button>
      </div>
    </li>
  );
}
