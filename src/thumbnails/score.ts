/** Turns heuristic results + optional AI critique into an explained, overridable score. */
import type { Collision, HeuristicResult, Raster, TextBox } from "./heuristics";
import type { PlatformId, Rect } from "./platforms";

export type DimensionId = "readability" | "subject" | "safeZones" | "color" | "hook";

export const DIMENSIONS: Array<{ id: DimensionId; label: string; ai?: boolean }> = [
  { id: "readability", label: "Text readability" },
  { id: "subject", label: "Subject clarity" },
  { id: "safeZones", label: "Safe zones" },
  { id: "color", label: "Color & contrast" },
  { id: "hook", label: "Hook / curiosity", ai: true },
];

export type Weights = Record<DimensionId, number>;
export const DEFAULT_WEIGHTS: Weights = { readability: 30, subject: 25, safeZones: 20, color: 15, hook: 10 };

export interface AiCritique {
  model: string;
  hookScore: number; // 0–10
  readsInOneSecond: boolean;
  emotion: string;
  story: string;
  subjectNote: string;
  critique: string[];
  cached?: boolean;
}

export interface DimensionResult {
  id: DimensionId;
  /** 0–1, or null when unavailable (AI offline / not requested). */
  fraction: number | null;
  notes: string[];
}

/** Everything stored for one candidate. Heuristic parts are deterministic for the same image. */
export interface Breakdown {
  version: 1;
  platform: PlatformId;
  source: { width: number; height: number };
  analysisSize: { width: number; height: number };
  warnings: string[];
  dims: DimensionResult[];
  textBoxes: Array<TextBox & { contrast: number }>;
  subjectBox: Rect | null;
  collisions: Collision[];
  /** User overrides per dimension (0–1). The heuristic value stays visible next to it. */
  overrides: Partial<Record<DimensionId, number>>;
  ai: AiCritique | null;
  aiError: string | null;
}

export function buildBreakdown(h: HeuristicResult, platform: PlatformId, raster: Raster, source: { width: number; height: number }, warnings: string[]): Breakdown {
  return {
    version: 1,
    platform,
    source,
    analysisSize: { width: raster.width, height: raster.height },
    warnings,
    dims: [
      { id: "readability", fraction: h.readability.fraction, notes: h.readability.notes },
      { id: "subject", fraction: h.subject.fraction, notes: h.subject.notes },
      { id: "safeZones", fraction: h.safeZones.fraction, notes: h.safeZones.notes },
      { id: "color", fraction: h.color.fraction, notes: h.color.notes },
      { id: "hook", fraction: null, notes: ["AI critique not run yet."] },
    ],
    textBoxes: h.readability.lines.map(({ x, y, w, h: hh, text, confidence, contrast }) => ({ x, y, w, h: hh, text, confidence, contrast })),
    subjectBox: h.subject.box,
    collisions: h.safeZones.collisions,
    overrides: {},
    ai: null,
    aiError: null,
  };
}

export function withAi(b: Breakdown, ai: AiCritique | null, error: string | null): Breakdown {
  const hook: DimensionResult = ai
    ? {
        id: "hook",
        fraction: Math.max(0, Math.min(10, ai.hookScore)) / 10,
        notes: [
          `${ai.readsInOneSecond ? "Story reads in about a second" : "Story does not read in one second"}: ${ai.story}`,
          `Reads as: ${ai.emotion}.`,
          ...ai.critique,
        ],
      }
    : { id: "hook", fraction: null, notes: [error ? `AI critique unavailable: ${error}` : "AI critique not run yet."] };
  return { ...b, ai, aiError: error, dims: b.dims.map((d) => (d.id === "hook" ? hook : d)) };
}

export interface ScoredDimension {
  id: DimensionId;
  label: string;
  weight: number;
  fraction: number | null; // effective (override wins)
  heuristic: number | null;
  overridden: boolean;
  points: number | null;
  notes: string[];
}

export interface Score {
  dims: ScoredDimension[];
  points: number;
  outOf: number;
  /** 0–100 over the dimensions that are available. */
  total: number;
}

export function score(b: Breakdown, weights: Weights): Score {
  const dims = DIMENSIONS.map(({ id, label }) => {
    const d = b.dims.find((x) => x.id === id)!;
    const override = b.overrides[id];
    const fraction = override ?? d.fraction;
    return {
      id,
      label,
      weight: weights[id],
      fraction,
      heuristic: d.fraction,
      overridden: override != null,
      points: fraction == null ? null : fraction * weights[id],
      notes: d.notes,
    };
  });
  const available = dims.filter((d) => d.points != null);
  const points = available.reduce((s, d) => s + d.points!, 0);
  const outOf = available.reduce((s, d) => s + d.weight, 0);
  return { dims, points, outOf, total: outOf ? Math.round((points / outOf) * 1000) / 10 : 0 };
}

export interface Candidate {
  id: number;
  name: string;
  score: Score;
}

/** For each dimension, the candidate id(s) with the most points. Ties highlight all leaders. */
export function leaders(candidates: Candidate[]): Record<DimensionId, number[]> {
  const out = {} as Record<DimensionId, number[]>;
  for (const { id } of DIMENSIONS) {
    const pts = candidates.map((c) => ({ id: c.id, p: c.score.dims.find((d) => d.id === id)!.points }));
    const valid = pts.filter((x) => x.p != null);
    if (valid.length < 2) {
      out[id] = [];
      continue;
    }
    const best = Math.max(...valid.map((x) => x.p!));
    out[id] = valid.every((x) => Math.abs(x.p! - best) < 0.05) ? [] : valid.filter((x) => Math.abs(x.p! - best) < 0.05).map((x) => x.id);
  }
  return out;
}

/** "Why this one won", from the breakdown and not from the bare total. */
export function explainWinner(candidates: Candidate[]): { winnerId: number; text: string } | null {
  if (candidates.length < 2) return null;
  const ranked = [...candidates].sort((a, b) => b.score.total - a.score.total || a.id - b.id);
  const [win, second] = ranked;
  const diffs = win.score.dims
    .map((d) => {
      const o = second.score.dims.find((x) => x.id === d.id)!;
      return { label: d.label.toLowerCase(), delta: d.points != null && o.points != null ? d.points - o.points : 0 };
    })
    .filter((d) => Math.abs(d.delta) >= 0.5)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const gains = diffs.filter((d) => d.delta > 0).slice(0, 2);
  const losses = diffs.filter((d) => d.delta < 0).slice(0, 1);
  const margin = win.score.total - second.score.total;
  if (margin < 1) return { winnerId: win.id, text: `${win.name} and ${second.name} are effectively tied (${win.score.total} vs ${second.score.total}). Pick on taste, or get the AI critique.` };
  const fmt = (d: { label: string; delta: number }) => `${d.label} (${d.delta > 0 ? "+" : ""}${d.delta.toFixed(1)})`;
  let text = `${win.name} leads ${second.name} by ${margin.toFixed(1)} points`;
  if (gains.length) text += `, mostly on ${gains.map(fmt).join(" and ")}`;
  if (losses.length) text += `; it trails on ${fmt(losses[0])}`;
  return { winnerId: win.id, text: `${text}.` };
}
