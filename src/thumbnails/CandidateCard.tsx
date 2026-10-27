import { useState } from "react";
import { Badge, Button } from "../app/ui";
import type { PlatformSpec } from "./platforms";
import type { Breakdown, DimensionId, Score } from "./score";

export interface CandidateView {
  id: number;
  label: string;
  path: string;
  imageUrl: string | null;
  breakdown: Breakdown | null;
  score: Score | null;
  status: "loading" | "analyzing" | "ready" | "error";
  error: string | null;
  aiBusy: boolean;
}

interface Props {
  c: CandidateView;
  spec: PlatformSpec;
  title: string;
  isWinner: boolean;
  leads: Set<DimensionId>;
  onPickWinner: () => void;
  onRemove: () => void;
  onRename: (label: string) => void;
  onOverride: (dim: DimensionId, value: number | null) => void;
  onCritique: () => void;
}

export default function CandidateCard({ c, spec, title, isWinner, leads, onPickWinner, onRemove, onRename, onOverride, onCritique }: Props) {
  const [label, setLabel] = useState(c.label);
  const [layers, setLayers] = useState({ zones: true, text: true, subject: false });
  const [editing, setEditing] = useState<DimensionId | null>(null);
  const b = c.breakdown;
  const s = c.score;

  return (
    <article className={`flex min-w-0 flex-col rounded-lg border bg-panel ${isWinner ? "border-ok ring-2 ring-ok/40" : "border-line"}`}>
      <header className="flex items-start justify-between gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <input
            className="w-full truncate rounded border border-transparent bg-transparent px-1 text-sm font-semibold hover:border-line focus:border-line"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => label.trim() && label !== c.label && onRename(label.trim())}
            aria-label="Candidate name"
          />
          <p className="truncate px-1 text-[11px] text-muted" title={c.path}>{c.path}</p>
        </div>
        <div className="text-right">
          {s ? (
            <>
              <div className="text-2xl font-semibold tabular-nums leading-none">{s.total.toFixed(0)}</div>
              <div className="text-[10px] text-muted">{s.outOf < 100 ? `${s.points.toFixed(1)} / ${s.outOf} pts` : "out of 100"}</div>
            </>
          ) : (
            <span className="text-xs text-muted">{c.status === "error" ? "error" : "scoring…"}</span>
          )}
        </div>
      </header>

      <div className="relative bg-black">
        {c.imageUrl && (
          <div className="relative mx-auto" style={{ aspectRatio: String(spec.aspect), maxHeight: spec.aspect < 1 ? 420 : undefined }}>
            <img src={c.imageUrl} alt={c.label} className="h-full w-full object-cover" />
            {b && <Overlay b={b} spec={spec} layers={layers} />}
          </div>
        )}
        {c.status !== "ready" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-sm text-white">
            {c.status === "error" ? c.error : c.status === "loading" ? "Loading…" : "Reading text and scoring…"}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-1.5 text-[11px] text-muted">
        {(["zones", "text", "subject"] as const).map((k) => (
          <label key={k} className="flex items-center gap-1">
            <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers((l) => ({ ...l, [k]: e.target.checked }))} />
            {k === "zones" ? "UI overlays" : k === "text" ? "Text found" : "Main subject"}
          </label>
        ))}
      </div>

      {b && b.warnings.length > 0 && (
        <ul className="space-y-1 border-b border-line bg-warn/10 px-3 py-2 text-xs text-warn">
          {b.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}

      {c.imageUrl && <FeedPreviews url={c.imageUrl} spec={spec} title={title || "Your video title goes here"} />}

      {s && (
        <ul className="divide-y divide-line">
          {s.dims.map((d) => (
            <li key={d.id} className="px-3 py-2">
              <div className="flex items-center gap-2 text-xs">
                <span className="w-28 shrink-0 font-medium">
                  {d.label}
                  {leads.has(d.id) && <span className="ml-1 text-ok" title="Best of the candidates on this dimension">★</span>}
                </span>
                <div className="h-1.5 flex-1 overflow-hidden rounded bg-sunken">
                  {d.fraction != null && <div className={`h-full rounded ${d.overridden ? "bg-warn" : "bg-accent"}`} style={{ width: `${d.fraction * 100}%` }} />}
                </div>
                <span className="w-16 text-right tabular-nums text-muted">{d.points == null ? "n/a" : `${d.points.toFixed(1)}/${d.weight}`}</span>
                <button className="text-[10px] text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => setEditing(editing === d.id ? null : d.id)} disabled={d.heuristic == null && !d.overridden}>
                  {d.overridden ? "edited" : "adjust"}
                </button>
              </div>
              {editing === d.id && (
                <div className="mt-1.5 flex items-center gap-2 text-xs">
                  <input type="range" min={0} max={100} value={Math.round((d.fraction ?? 0) * 100)} onChange={(e) => onOverride(d.id, Number(e.target.value) / 100)} className="flex-1" aria-label={`Override ${d.label}`} />
                  <span className="w-10 tabular-nums">{Math.round((d.fraction ?? 0) * 100)}%</span>
                  {d.overridden && <Button variant="ghost" className="!px-1.5 !py-0.5 text-xs" onClick={() => onOverride(d.id, null)}>Reset to {Math.round((d.heuristic ?? 0) * 100)}%</Button>}
                </div>
              )}
              <ul className="mt-1 space-y-0.5 text-[11px] leading-snug text-muted">
                {d.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
              {d.id === "hook" && !b?.ai && (
                <Button className="mt-1.5 !py-1 text-xs" onClick={onCritique} disabled={c.aiBusy || c.status !== "ready"}>
                  {c.aiBusy ? "Asking Claude…" : "Get AI critique"}
                </Button>
              )}
              {d.id === "hook" && b?.ai && <p className="mt-1 text-[10px] text-muted">Advisory · {b.ai.model}{b.ai.cached ? " · cached" : ""}</p>}
            </li>
          ))}
        </ul>
      )}

      <footer className="mt-auto flex items-center justify-between gap-2 border-t border-line px-3 py-2">
        {isWinner ? <Badge tone="ok">Winner</Badge> : <Button variant="primary" className="!py-1 text-xs" onClick={onPickWinner} disabled={!s}>Pick as winner</Button>}
        <Button variant="ghost" className="!py-1 text-xs" onClick={onRemove} title="Removes it from this test. The image file is not deleted.">Remove</Button>
      </footer>
    </article>
  );
}

function Overlay({ b, spec, layers }: { b: Breakdown; spec: PlatformSpec; layers: { zones: boolean; text: boolean; subject: boolean } }) {
  const { width: W, height: H } = b.analysisSize;
  const hit = new Set(b.collisions.map((c) => c.zoneId));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none" aria-hidden>
      {layers.zones &&
        spec.zones.map((z) => (
          <g key={z.id}>
            <rect x={z.rect.x * W} y={z.rect.y * H} width={z.rect.w * W} height={z.rect.h * H} fill={hit.has(z.id) ? "rgba(229,62,62,0.45)" : "rgba(0,0,0,0.35)"} stroke={hit.has(z.id) ? "#ff4d4d" : "rgba(255,255,255,0.7)"} strokeDasharray="4 3" strokeWidth={1.2} />
            {z.id === "duration" && <text x={(z.rect.x + z.rect.w / 2) * W} y={(z.rect.y + z.rect.h * 0.62) * H} fill="#fff" fontSize={H * 0.05} textAnchor="middle" fontFamily="sans-serif">12:34</text>}
          </g>
        ))}
      {layers.text &&
        b.textBoxes.map((t, i) => (
          <rect key={i} x={t.x} y={t.y} width={t.w} height={t.h} fill="none" stroke={t.contrast >= 4.5 ? "#4fb47c" : t.contrast >= 3 ? "#d9a441" : "#ef6b6b"} strokeWidth={1.5} />
        ))}
      {layers.subject && b.subjectBox && <rect x={b.subjectBox.x} y={b.subjectBox.y} width={b.subjectBox.w} height={b.subjectBox.h} fill="none" stroke="#5b9cff" strokeWidth={1.5} strokeDasharray="6 3" />}
    </svg>
  );
}

function FeedPreviews({ url, spec, title }: { url: string; spec: PlatformSpec; title: string }) {
  return (
    <div className="flex items-end gap-3 overflow-x-auto border-b border-line bg-sunken px-3 py-3">
      {spec.previews.map((p) =>
        spec.id === "youtube" ? (
          <figure key={p.label} className="shrink-0" style={{ width: p.width }}>
            <div className="relative overflow-hidden rounded-md" style={{ aspectRatio: "16 / 9" }}>
              <img src={url} alt="" className="h-full w-full object-cover" />
              <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 text-[10px] font-medium text-white">12:34</span>
            </div>
            {p.width >= 200 ? (
              <figcaption className="mt-1.5 flex gap-2">
                <span className="mt-0.5 h-6 w-6 shrink-0 rounded-full bg-line" />
                <span className="min-w-0">
                  <span className="line-clamp-2 text-[12px] font-semibold leading-tight">{title}</span>
                  <span className="block text-[10px] text-muted">Your channel · 1.2K views</span>
                </span>
              </figcaption>
            ) : (
              <figcaption className="mt-1 line-clamp-2 text-[10px] font-semibold leading-tight">{title}</figcaption>
            )}
            <p className="mt-0.5 text-[9px] uppercase tracking-wide text-muted">{p.label}</p>
          </figure>
        ) : (
          <figure key={p.label} className="shrink-0" style={{ width: p.width }}>
            <div className="relative overflow-hidden rounded-md" style={{ aspectRatio: p.label.includes("grid") ? "3 / 4" : "9 / 16" }}>
              <img src={url} alt="" className="h-full w-full object-cover" />
              {!p.label.includes("grid") && (
                <>
                  <span className="absolute bottom-[12%] right-1.5 flex flex-col gap-2">
                    {[0, 1, 2].map((i) => <span key={i} className="h-4 w-4 rounded-full bg-white/80" />)}
                  </span>
                  <span className="absolute bottom-2 left-2 right-10 text-[9px] leading-tight text-white drop-shadow">
                    <b>@yourhandle</b> {title}
                  </span>
                </>
              )}
            </div>
            <p className="mt-1 text-[9px] uppercase tracking-wide text-muted">{p.label}</p>
          </figure>
        ),
      )}
    </div>
  );
}
