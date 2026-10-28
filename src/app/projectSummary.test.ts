import { describe, expect, it } from "vitest";
import type { Idea, Project, ThumbnailRow } from "../db/api";
import { DEFAULT_WEIGHTS, type Breakdown } from "../thumbnails/score";
import { buildProjectSummary } from "./projectSummary";

const project: Project = {
  id: 7, title: "Leg day, fixed", slug: "leg-day-fixed", category: "tutorial", status: "active", createdAt: "2026-10-27T09:00:00",
  folderPath: "C:\\Projects\\2026-10-27_leg-day-fixed", winnerThumbnailId: 2, thumbnailCount: 2, bestScore: 90, lastTestedAt: null,
};

const breakdown = (fractions: number[], extra: Partial<Breakdown> = {}): string =>
  JSON.stringify({
    version: 1, platform: "youtube", source: { width: 1280, height: 720 }, analysisSize: { width: 640, height: 360 }, warnings: [],
    dims: ["readability", "subject", "safeZones", "color", "hook"].map((id, i) => ({ id, fraction: fractions[i] ?? null, notes: i === 0 ? ["Headline 7.1:1 contrast."] : [] })),
    textBoxes: [], subjectBox: null, collisions: [], overrides: {}, ai: null, aiError: null, ...extra,
  });

const thumb = (id: number, label: string, json: string | null): ThumbnailRow => ({
  id, projectId: 7, path: `C:\\t\\${label}.png`, label, platform: "youtube", fileHash: null, scoreTotal: null, breakdownJson: json, createdAt: "2026-10-27T10:00:00",
});

const idea: Idea = {
  id: 1, title: "Leg day, fixed", rawText: "Fix | the squat", ocrText: "line one\n\nline two", category: "tutorial", tags: ["squat", "legs"], hasImage: true, source: "clipboard",
  status: "project", projectId: 7, projectFolder: null, suggestion: null, createdAt: "2026-10-26T08:00:00", updatedAt: null,
};

describe("project summary", () => {
  it("covers project, idea, scores, winner and reasoning", () => {
    const md = buildProjectSummary({
      project, idea, weights: DEFAULT_WEIGHTS, videoTitle: "I fixed my leg day", date: "2026-10-28",
      thumbnails: [thumb(1, "busy", breakdown([0.5, 0.5, 0.5, 0.5])), thumb(2, "clean | v2", breakdown([1, 0.9, 1, 0.8], { overrides: { color: 0.9 } }))],
    });
    expect(md).toMatch(/^# Leg day, fixed\n/);
    expect(md).toContain("- **Category:** tutorial");
    expect(md).toContain("- **Tags:** squat, legs");
    expect(md).toContain("`C:\\Projects\\2026-10-27_leg-day-fixed`");
    expect(md).toContain("Captured 2026-10-26 from a screenshot.");
    expect(md).toContain("> line one\n>\n> line two");
    // Sorted by score, escaped pipes, winner star, hand-set marker, hook unavailable.
    const rows = md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Candidate"));
    expect(rows[0]).toMatch(/^\| clean \\\| v2 ★ \| 96 \(of 90 pts\) \| 30\.0\/30 \| 22\.5\/25 \| 20\.0\/20 \| 13\.5\/15\* \| n\/a \|$/);
    expect(rows[1]).toMatch(/^\| busy \| 50/);
    expect(md).toContain("set by hand");
    expect(md).toContain("**Winner:** clean | v2 (picked by you).");
    expect(md).toMatch(/Why the top score leads: clean \| v2 leads busy by 45\.6 points/);
    expect(md).toContain("- Text readability: Headline 7.1:1 contrast.");
  });

  it("handles projects without tests or scores", () => {
    const base = { project: { ...project, winnerThumbnailId: null, folderPath: null, category: null }, idea: null, weights: DEFAULT_WEIGHTS, date: "2026-10-28" };
    const none = buildProjectSummary({ ...base, thumbnails: [] });
    expect(none).toContain("No thumbnails tested yet.");
    expect(none).not.toContain("Category");
    expect(buildProjectSummary({ ...base, thumbnails: [thumb(1, "a", null)] })).toContain("1 candidate added but not scored yet");
    const one = buildProjectSummary({ ...base, thumbnails: [thumb(1, "a", breakdown([1, 1, 1, 1]))] });
    expect(one).toContain("**Winner:** not picked yet.");
    expect(one).not.toContain("Why the top score leads");
    expect(buildProjectSummary({ ...base, thumbnails: [thumb(1, "a", breakdown([1, 1, 1, 1])), thumb(2, "b", null)] })).toContain("1 more candidate isn't scored yet.");
  });
});
