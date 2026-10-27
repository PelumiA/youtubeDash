/**
 * Fixture pack: three generated thumbnails scored end to end with real (local) OCR.
 * Expected ordering on readability, and overall: strong > cluttered > low-contrast.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { afterAll, describe, expect, it } from "vitest";
import type { Raster } from "./heuristics";
import { detectText, ocrWorker, terminateOcr } from "./ocr";
import { analyzeImage } from "./pipeline";
import { DEFAULT_WEIGHTS, score, type Breakdown } from "./score";

const fixture = (name: string): Raster => {
  const png = PNG.sync.read(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));
  return { width: png.width, height: png.height, data: png.data };
};

const langPath = fileURLToPath(new URL("../../node_modules/@tesseract.js-data/eng/4.0.0_best_int", import.meta.url));

async function findText(r: Raster) {
  const png = new PNG({ width: r.width, height: r.height });
  png.data = Buffer.from(r.data);
  return detectText(await ocrWorker({ langPath }), PNG.sync.write(png), 1);
}

const results = new Map<string, Breakdown>();
async function run(name: string) {
  if (!results.has(name)) results.set(name, await analyzeImage(fixture(name), "youtube", findText));
  return results.get(name)!;
}
const dim = (b: Breakdown, id: string) => b.dims.find((d) => d.id === id)!.fraction!;

afterAll(terminateOcr);

describe("thumbnail fixture pack", () => {
  it("reads the headline of the strong thumbnail", async () => {
    const strong = await run("strong.png");
    const text = strong.textBoxes.map((t) => t.text).join(" ");
    expect(text).toMatch(/LEG/);
    expect(text).toMatch(/FIXED/);
    expect(strong.textBoxes[0].contrast).toBeGreaterThan(7);
    expect(strong.collisions).toEqual([]);
  }, 60_000);

  it("orders readability strong > cluttered > low-contrast", async () => {
    const [s, c, l] = await Promise.all(["strong.png", "cluttered.png", "low-contrast.png"].map(run));
    expect(dim(s, "readability")).toBeGreaterThan(dim(c, "readability"));
    expect(dim(c, "readability")).toBeGreaterThan(dim(l, "readability"));
  }, 120_000);

  it("orders the overall heuristic score the same way", async () => {
    const [s, c, l] = await Promise.all(["strong.png", "cluttered.png", "low-contrast.png"].map(run));
    const total = (b: Breakdown) => score(b, DEFAULT_WEIGHTS).total;
    expect(total(s)).toBeGreaterThan(total(c));
    expect(total(c)).toBeGreaterThan(total(l));
    // The hook dimension stays unavailable offline instead of blocking the score.
    expect(score(s, DEFAULT_WEIGHTS).outOf).toBe(90);
  }, 120_000);

  it("flags clutter and the text under the duration badge", async () => {
    const c = await run("cluttered.png");
    expect(dim(c, "subject")).toBeLessThan(dim(await run("strong.png"), "subject"));
    expect(c.collisions.some((x) => x.zoneId === "duration")).toBe(true);
  }, 60_000);

  it("is deterministic across runs", async () => {
    const again = await analyzeImage(fixture("strong.png"), "youtube", findText);
    expect(JSON.stringify(again)).toBe(JSON.stringify(await run("strong.png")));
  }, 60_000);
});
