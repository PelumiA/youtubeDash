/** Pure helpers for long-clip sections: markers → sections, keyframe snapping, YouTube chapters. */

export interface ClipSection {
  id: number | null;
  mediaFileId: number;
  startS: number;
  endS: number;
  label: string;
  tags: string[];
  notes: string;
  exportedPath: string | null;
}

export interface CutAnalysis {
  silences: Array<{ startS: number; endS: number }>;
  scenes: number[];
  suggestions: number[];
}

export interface ExportResult {
  sectionId: number;
  path: string | null;
  mode: "copy" | "encode" | null;
  error: string | null;
}

/** Section labels the plan calls out; free text is allowed too. */
export const SECTION_TAGS = ["hook", "teaching-point", "story", "cta", "b-roll", "outtake"];

/** `m:ss`, or `h:mm:ss` from an hour. */
export function formatTimestamp(seconds: number, withHours = seconds >= 3600): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return withHours ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Precise display for editing: `m:ss.t`. */
export function formatPrecise(seconds: number): string {
  const tenths = Math.round(seconds * 10) / 10;
  const whole = Math.floor(tenths);
  return `${formatTimestamp(whole)}.${Math.round((tenths - whole) * 10)}`;
}

/** Parses `90`, `1:30`, `1:30.5` or `1:02:03`; null if malformed. */
export function parseTimestamp(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

/** Splits a clip at the given markers into consecutive sections covering the whole clip. */
export function sectionsFromMarkers(markers: number[], durationS: number, mediaFileId: number): ClipSection[] {
  const cuts = [...new Set(markers.filter((m) => m > 0.5 && m < durationS - 0.5).map((m) => Math.round(m * 1000) / 1000))].sort((a, b) => a - b);
  const bounds = [0, ...cuts, durationS];
  return bounds.slice(0, -1).map((start, i) => ({
    id: null,
    mediaFileId,
    startS: start,
    endS: bounds[i + 1],
    label: `Section ${i + 1}`,
    tags: [],
    notes: "",
    exportedPath: null,
  }));
}

/** Nearest keyframe within `maxDistance` seconds, else the time unchanged. */
export function snapToKeyframe(t: number, keyframes: number[], maxDistance = 2): number {
  let best = t;
  let bestDist = maxDistance;
  for (const k of keyframes) {
    const d = Math.abs(k - t);
    if (d <= bestDist) {
      best = k;
      bestDist = d;
    }
  }
  return best;
}

export function isOnKeyframe(t: number, keyframes: number[], tolerance = 0.05): boolean {
  return keyframes.some((k) => Math.abs(k - t) <= tolerance);
}

export interface Chapters {
  text: string;
  /** Reasons YouTube may ignore the chapter list. */
  warnings: string[];
}

/**
 * YouTube description chapters from sections. YouTube requires the first chapter at 0:00,
 * at least three chapters, and each at least 10 seconds long. An "Intro" chapter is
 * added if the first section starts later than 0:00.
 */
export function buildChapters(sections: Pick<ClipSection, "startS" | "endS" | "label">[], durationS: number): Chapters {
  const sorted = [...sections].sort((a, b) => a.startS - b.startS);
  const entries = sorted.map((s) => ({ start: Math.floor(s.startS), label: s.label.trim() || "Untitled" }));
  if (entries.length === 0 || entries[0].start > 0) entries.unshift({ start: 0, label: "Intro" });
  // Two sections starting in the same second would produce duplicate timestamps.
  const deduped = entries.filter((e, i) => i === 0 || e.start !== entries[i - 1].start);

  const withHours = durationS >= 3600;
  const text = deduped.map((e) => `${formatTimestamp(e.start, withHours)} ${e.label}`).join("\n");

  const warnings: string[] = [];
  if (deduped.length < 3) warnings.push("YouTube needs at least 3 chapters.");
  const short = deduped.filter((e, i) => (deduped[i + 1]?.start ?? durationS) - e.start < 10);
  if (short.length) warnings.push(`Chapters must be at least 10 seconds: ${short.map((e) => e.label).join(", ")}.`);
  if (deduped.length < entries.length) warnings.push("Sections starting in the same second were merged.");
  return { text, warnings };
}
