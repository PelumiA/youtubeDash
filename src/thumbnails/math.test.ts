import { describe, expect, it } from "vitest";
import { contrastRatio, deltaE, redGreenOnly, relativeLuminance, rgbToLab } from "./color";
import { coveredFraction, intersectionArea, PLATFORMS } from "./platforms";
import { coverResize } from "./raster";
import { linesFromWords, type OcrWord } from "./ocr";
import { measureTextContrast, otsu } from "./heuristics";
import { DEFAULT_WEIGHTS, explainWinner, leaders, score, withAi, type Breakdown } from "./score";

describe("WCAG contrast", () => {
  it("matches reference values", () => {
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 6);
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 6);
    expect(contrastRatio([10, 20, 30], [10, 20, 30])).toBe(1);
    // #767676 on white is the classic minimum AA gray: 4.54:1.
    expect(contrastRatio([0x76, 0x76, 0x76], [255, 255, 255])).toBeCloseTo(4.54, 2);
    // Order doesn't matter.
    expect(contrastRatio([255, 255, 255], [0x76, 0x76, 0x76])).toBeCloseTo(4.54, 2);
  });
});

describe("Lab and color-vision checks", () => {
  it("computes Lab and ΔE", () => {
    const white = rgbToLab([255, 255, 255]);
    expect(white[0]).toBeCloseTo(100, 1);
    expect(Math.abs(white[1])).toBeLessThan(0.5);
    expect(deltaE(white, white)).toBe(0);
    expect(deltaE(rgbToLab([0, 0, 0]), white)).toBeCloseTo(100, 0);
  });
  it("flags red vs green of similar brightness, not black vs white", () => {
    expect(redGreenOnly([200, 60, 50], [90, 140, 50]).flagged).toBe(true);
    expect(redGreenOnly([0, 0, 0], [255, 255, 255]).flagged).toBe(false);
    expect(redGreenOnly([30, 60, 200], [240, 200, 40]).flagged).toBe(false); // blue/yellow survives
  });
});

describe("safe-zone geometry", () => {
  it("measures overlap", () => {
    const a = { x: 0, y: 0, w: 1, h: 1 };
    expect(intersectionArea(a, { x: 0.5, y: 0.5, w: 1, h: 1 })).toBeCloseTo(0.25);
    expect(intersectionArea(a, { x: 2, y: 2, w: 1, h: 1 })).toBe(0);
    expect(coveredFraction({ x: 0.9, y: 0.9, w: 0.1, h: 0.1 }, PLATFORMS.youtube.zones[0].rect)).toBeCloseTo(1, 9);
    expect(coveredFraction({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, PLATFORMS.youtube.zones[0].rect)).toBe(0);
  });
  it("puts the YouTube duration badge bottom-right and the Instagram rail on the right", () => {
    const badge = PLATFORMS.youtube.zones.find((z) => z.id === "duration")!.rect;
    expect(badge.x + badge.w).toBeCloseTo(1);
    expect(badge.y + badge.h).toBeCloseTo(1);
    const rail = PLATFORMS.instagram.zones.find((z) => z.id === "rail")!.rect;
    expect(rail.x).toBeGreaterThan(0.8);
    // Grid crop zones together hide the area outside the middle 3:4.
    const crop = PLATFORMS.instagram.zones.filter((z) => z.id.startsWith("grid")).reduce((s, z) => s + z.rect.h, 0);
    expect(1 - crop).toBeCloseTo((9 / 16) / (3 / 4), 5);
  });
});

describe("coverResize", () => {
  it("center-crops to aspect and averages", () => {
    // 4×2 image: columns black, white, white, black → crop to 2×2 center = white columns.
    const px = [0, 255, 255, 0, 0, 255, 255, 0];
    const data = new Uint8ClampedArray(px.flatMap((v) => [v, v, v, 255]));
    const out = coverResize({ width: 4, height: 2, data }, 1, 1);
    expect(out.data[0]).toBe(255);
    const half = coverResize({ width: 4, height: 2, data }, 2, 1);
    expect([half.data[0], half.data[4]]).toEqual([128, 128]);
  });
});

describe("text measurement", () => {
  it("finds the split and the contrast inside a text box", () => {
    expect(otsu([0.1, 0.1, 0.1, 0.9, 0.9])).toBeGreaterThan(0.1);
    expect(otsu([0.1, 0.1, 0.1, 0.9, 0.9])).toBeLessThanOrEqual(0.9);
    // 10×10 black box with a 3-px white stripe: text = white (minority), bg = black.
    const data = new Uint8ClampedArray(400);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
      const v = x >= 4 && x < 7 ? 255 : 0;
      data.set([v, v, v, 255], (y * 10 + x) * 4);
    }
    const m = measureTextContrast({ width: 10, height: 10, data }, { x: 0, y: 0, w: 10, h: 10 });
    expect(m.contrast).toBeCloseTo(21, 3);
    expect(m.fg).toEqual([255, 255, 255]);
  });
  it("groups OCR words into lines and drops junk", () => {
    const w = (text: string, x0: number, y0: number, x1: number, y1: number, confidence = 90): OcrWord => ({ text, confidence, bbox: { x0, y0, x1, y1 } });
    const lines = linesFromWords(
      [w("DAY", 220, 100, 320, 160), w("LEG", 100, 102, 200, 160), w("FIXED", 100, 200, 300, 270), w("~", 500, 500, 510, 510), w("ghost", 600, 100, 700, 160, 20), w("x", 0, 0, 2, 2)],
      0.5,
    );
    expect(lines.map((l) => l.text)).toEqual(["LEG DAY", "FIXED"]);
    expect(lines[0]).toMatchObject({ x: 50, y: 50, w: 110, h: 30 });
  });
});

describe("scoring", () => {
  const base = (fr: [number, number, number, number]): Breakdown => ({
    version: 1,
    platform: "youtube",
    source: { width: 1280, height: 720 },
    analysisSize: { width: 640, height: 360 },
    warnings: [],
    dims: [
      { id: "readability", fraction: fr[0], notes: [] },
      { id: "subject", fraction: fr[1], notes: [] },
      { id: "safeZones", fraction: fr[2], notes: [] },
      { id: "color", fraction: fr[3], notes: [] },
      { id: "hook", fraction: null, notes: [] },
    ],
    textBoxes: [],
    subjectBox: null,
    collisions: [],
    overrides: {},
    ai: null,
    aiError: null,
  });

  it("scores available dimensions only when the AI is offline", () => {
    const s = score(base([1, 1, 1, 1]), DEFAULT_WEIGHTS);
    expect(s.outOf).toBe(90);
    expect(s.points).toBe(90);
    expect(s.total).toBe(100);
    expect(s.dims.find((d) => d.id === "hook")!.points).toBeNull();
  });

  it("adds the AI hook and honours overrides and weights", () => {
    const b = withAi(base([0.5, 0.5, 0.5, 0.5]), { model: "m", hookScore: 8, readsInOneSecond: true, emotion: "curious", story: "s", subjectNote: "", critique: [] }, null);
    expect(score(b, DEFAULT_WEIGHTS).points).toBeCloseTo(45 + 8);
    const overridden = { ...b, overrides: { readability: 1 } };
    const s = score(overridden, DEFAULT_WEIGHTS);
    expect(s.dims[0]).toMatchObject({ fraction: 1, heuristic: 0.5, overridden: true, points: 30 });
    expect(score(b, { ...DEFAULT_WEIGHTS, readability: 0 }).outOf).toBe(70);
  });

  it("explains the winner from the breakdown", () => {
    const a = { id: 1, name: "A", score: score(base([1, 0.5, 1, 0.5]), DEFAULT_WEIGHTS) };
    const b = { id: 2, name: "B", score: score(base([0.3, 0.7, 1, 0.5]), DEFAULT_WEIGHTS) };
    const why = explainWinner([b, a])!;
    expect(why.winnerId).toBe(1);
    expect(why.text).toMatch(/^A leads B by [\d.]+ points, mostly on text readability \(\+21\.0\); it trails on subject clarity \(-5\.0\)\.$/);
    const lead = leaders([a, b]);
    expect(lead.readability).toEqual([1]);
    expect(lead.subject).toEqual([2]);
    expect(lead.safeZones).toEqual([]); // tie → nobody highlighted
  });
});
