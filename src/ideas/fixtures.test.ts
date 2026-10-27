/**
 * Idea organizer happy path, scripted without an API key: screenshot → local OCR → offline
 * suggestion → user confirms → project folder planned and created (demo backend).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { afterAll, describe, expect, it } from "vitest";
import type { Raster } from "../thumbnails/heuristics";
import { ocrWorker, terminateOcr } from "../thumbnails/ocr";
import { demoInvoke } from "../db/demoBackend";
import type { Idea, ScaffoldPlan } from "../db/api";
import type { Project } from "../db/api";
import { readText } from "./ocrImage";
import { DEFAULT_TAXONOMY, TAXONOMY_PRESETS, suggestLocally } from "./taxonomy";

const fixturePath = fileURLToPath(new URL("./fixtures/idea-screenshot.png", import.meta.url));
const langPath = fileURLToPath(new URL("../../node_modules/@tesseract.js-data/eng/4.0.0_best_int", import.meta.url));
const encode = (r: Raster) => {
  const png = new PNG({ width: r.width, height: r.height });
  png.data = Buffer.from(r.data);
  return PNG.sync.write(png);
};

let ocrText: string | null = null;
async function screenshotText() {
  if (ocrText == null) {
    const png = PNG.sync.read(readFileSync(fixturePath));
    ocrText = await readText(await ocrWorker({ langPath }), { width: png.width, height: png.height, data: png.data }, encode);
  }
  return ocrText;
}

afterAll(terminateOcr);

describe("idea screenshot fixture", () => {
  it("reads the dark-mode post text locally", async () => {
    const text = await screenshotText();
    expect(text).toMatch(/3 squat mistakes that are killing/i);
    expect(text).toMatch(/talking head/i);
  }, 60_000);

  it("suggests a category, title and tags offline", async () => {
    const text = await screenshotText();
    const s = suggestLocally(text, DEFAULT_TAXONOMY.categories);
    expect(s.category).toBe("tutorial");
    expect(s.title).toBe("3 squat mistakes that are killing your leg day");
    expect(s.tags).toContain("squat");
    expect(s.reason).toMatch(/how to/);
    const groovy = TAXONOMY_PRESETS.find((t) => t.presetId === "groovy-gains")!;
    expect(suggestLocally(text, groovy.categories).category).toBe("talking-head");
  }, 60_000);

  it("becomes a structured project folder once the category is confirmed", async () => {
    const text = await screenshotText();
    const bytes = readFileSync(fixturePath).toString("base64");
    const idea = await demoInvoke<Idea>("capture_idea", { rawText: "", ocrText: text, imageBase64: bytes, source: "clipboard" });
    expect(idea.status).toBe("inbox");
    const s = suggestLocally(text, DEFAULT_TAXONOMY.categories);
    const request = { ideaId: idea.id, projectsDir: "C:\\Demo\\Projects", title: s.title, category: s.category, tags: s.tags, date: "2026-10-27", footer: "" };
    const plan = await demoInvoke<ScaffoldPlan>("preview_scaffold", { request });
    expect(plan.folder).toBe("C:\\Demo\\Projects\\2026-10-27_3-squat-mistakes-that-are-killing-your-leg-day");
    expect(plan.entries).toEqual(["brief.md", "script.md", "assets/", "assets/idea-screenshot.png", "thumbnails/"]);
    expect(plan.brief).toContain("**Category:** tutorial");
    const project = await demoInvoke<Project>("scaffold_idea", { request });
    expect(project.folderPath).toBe(plan.folder);
    expect(project.category).toBe("tutorial");
    const [after] = await demoInvoke<Idea[]>("list_ideas", { query: "squat mistakes", status: "project" });
    expect(after.id).toBe(idea.id);
    await expect(demoInvoke("scaffold_idea", { request })).rejects.toThrow(/already a project/);
  }, 60_000);
});
