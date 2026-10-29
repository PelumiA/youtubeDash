import { describe, expect, it } from "vitest";
import { PRESETS, allPresets, conformsTo, guessType, parseTypeLines, planRenames, slugify, typeLines, validatePreset, type PlanInput } from "./renameEngine";
import { basename, dirname, pathKey } from "./paths";
import type { MediaFile } from "./types";

const PATTERN = PRESETS[0].pattern;
let nextId = 1;

function file(path: string, overrides: Partial<MediaFile> = {}): MediaFile {
  const filename = basename(path);
  const dot = filename.lastIndexOf(".");
  return {
    id: nextId++,
    path,
    dir: dirname(path),
    filename,
    ext: dot > 0 ? filename.slice(dot + 1) : "",
    kind: "video",
    sizeBytes: 1,
    width: 1920,
    height: 1080,
    durationS: 10,
    capturedDate: "2026-10-27",
    fileHash: "x",
    tags: [],
    ...overrides,
  };
}

/** In-memory folder listing that `applyPlan` mutates, standing in for the real disk. */
function fakeDisk(paths: string[]) {
  const all = new Set(paths);
  return {
    all,
    names: (dir: string) =>
      [...all].filter((p) => pathKey(dirname(p)) === pathKey(dir)).map((p) => basename(p)),
  };
}

function inputs(files: MediaFile[], slug = "Leg Day", type = "talking-head"): PlanInput[] {
  return files.map((f) => ({ file: f, fields: { date: f.capturedDate, slug, type }, targetDir: f.dir }));
}

describe("slugify", () => {
  it("lowercases, hyphenates and strips special characters", () => {
    expect(slugify("  My Leg-Day  Vlog!! (FINAL) ")).toBe("my-leg-day-vlog-final");
    expect(slugify("Crème brûlée & café")).toBe("creme-brulee-cafe");
    expect(slugify("a/b\\c:d*e?f\"g<h>i|j")).toBe("a-b-c-d-e-f-g-h-i-j");
    expect(slugify("🔥🔥")).toBe("");
  });
});

describe("planRenames", () => {
  it("renders the default pattern", () => {
    const f = file("C:\\media\\IMG 0001.MOV");
    const [op] = planRenames(inputs([f]), PATTERN, () => ["IMG 0001.MOV"]);
    expect(op.newPath).toBe("C:\\media\\2026-10-27_leg-day_talking-head_v01.mov");
    expect(op.status).toBe("rename");
    expect(op.bumped).toBe(false);
  });

  it("falls back to placeholders when slug or type sanitise to nothing", () => {
    const f = file("/m/a.mp4");
    const [op] = planRenames(inputs([f], "!!!", "???"), PATTERN, () => []);
    expect(op.newFilename).toBe("2026-10-27_untitled_file_v01.mp4");
  });

  it("bumps versions within a batch instead of colliding", () => {
    const files = [file("/m/a.mp4"), file("/m/b.mp4"), file("/m/c.mp4")];
    const ops = planRenames(inputs(files), PATTERN, () => ["a.mp4", "b.mp4", "c.mp4"]);
    expect(ops.map((o) => o.newFilename)).toEqual([
      "2026-10-27_leg-day_talking-head_v01.mp4",
      "2026-10-27_leg-day_talking-head_v02.mp4",
      "2026-10-27_leg-day_talking-head_v03.mp4",
    ]);
    expect(ops.map((o) => o.bumped)).toEqual([false, true, true]);
  });

  it("never targets a name held by a file outside the plan", () => {
    const f = file("/m/new.mp4");
    const existing = ["new.mp4", "2026-10-27_leg-day_talking-head_v01.mp4", "2026-10-27_leg-day_talking-head_v02.MP4"];
    const [op] = planRenames(inputs([f]), PATTERN, () => existing);
    expect(op.newFilename).toBe("2026-10-27_leg-day_talking-head_v03.mp4");
  });

  it("treats names case-insensitively for collision checks", () => {
    const f = file("/m/new.mp4");
    const [op] = planRenames(inputs([f]), PATTERN, () => ["2026-10-27_LEG-DAY_talking-head_v01.mp4"]);
    expect(op.newFilename).toBe("2026-10-27_leg-day_talking-head_v02.mp4");
  });

  it("is idempotent: re-planning applied output changes nothing", () => {
    const disk = fakeDisk(["/m/zz.mp4", "/m/aa.mp4", "/m/2026-10-27_leg-day_talking-head_v02.mp4"]);
    const files = [...disk.all].map((p) => file(p));
    const first = planRenames(inputs(files), PATTERN, disk.names);
    for (const op of first) {
      disk.all.delete(op.oldPath);
      disk.all.add(op.newPath);
    }
    const renamed = first.map((op) => file(op.newPath));
    const second = planRenames(inputs(renamed), PATTERN, disk.names);
    expect(second.every((op) => op.status === "unchanged")).toBe(true);
  });

  it("keeps already-conforming files ahead of newcomers", () => {
    // The conforming file sits later in the list but must not be bumped by the newcomer.
    const files = [file("/m/raw.mp4"), file("/m/2026-10-27_leg-day_talking-head_v01.mp4")];
    const ops = planRenames(inputs(files), PATTERN, () => files.map((f) => f.filename));
    expect(ops[1].status).toBe("unchanged");
    expect(ops[0].newFilename).toBe("2026-10-27_leg-day_talking-head_v02.mp4");
  });

  it("treats a case-only difference as a rename", () => {
    const f = file("/m/2026-10-27_leg-day_talking-head_v01.MP4");
    const [op] = planRenames(inputs([f]), PATTERN, () => [f.filename]);
    expect(op.status).toBe("rename");
    expect(op.newFilename).toBe("2026-10-27_leg-day_talking-head_v01.mp4");
  });

  it("sorts into a different target folder and checks collisions there", () => {
    const f = file("/m/a.png", { kind: "photo" });
    const plan: PlanInput[] = [{ file: f, fields: { date: "2026-10-27", slug: "x", type: "thumbnail" }, targetDir: "/m/thumbnails" }];
    const [op] = planRenames(plan, PATTERN, (dir) => (dir === "/m/thumbnails" ? ["2026-10-27_x_thumbnail_v01.png"] : ["a.png"]));
    expect(op.newPath).toBe("/m/thumbnails/2026-10-27_x_thumbnail_v02.png");
  });

  it("rejects patterns without {version} and oversized runs", () => {
    expect(() => planRenames([], "{date}_{slug}", () => [])).toThrow(/version/);
    const many = Array.from({ length: 1001 }, (_, i) => file(`/m/${i}.mp4`));
    expect(() => planRenames(inputs(many), PATTERN, () => [])).toThrow(/capped/);
  });

  it("plans 1,000 files quickly", () => {
    const many = Array.from({ length: 1000 }, (_, i) => file(`/m/${i}.mp4`));
    const t = performance.now();
    planRenames(inputs(many), PATTERN, () => many.map((f) => f.filename));
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe("conformsTo", () => {
  it("matches any version number but nothing else", () => {
    const fields = { date: "2026-10-27", slug: "leg day", type: "reel" };
    expect(conformsTo(PATTERN, fields, "MP4", "2026-10-27_leg-day_reel_v07.mp4")).toBe(true);
    expect(conformsTo(PATTERN, fields, "mp4", "2026-10-27_leg-day_reel_v123.mp4")).toBe(true);
    expect(conformsTo(PATTERN, fields, "mp4", "2026-10-27_leg-day_reel_v7.mp4")).toBe(false);
    expect(conformsTo(PATTERN, fields, "mp4", "2026-10-27_leg-day_broll_v01.mp4")).toBe(false);
  });
});

describe("guessType", () => {
  const [yt, groovy] = PRESETS;
  it("maps media shape to a content type", () => {
    expect(guessType(file("/a.mp4", { width: 1080, height: 1920 }), yt)).toBe("reel");
    expect(guessType(file("/a.mp4"), yt)).toBe("talking-head");
    expect(guessType(file("/a.mp4", { width: null, height: null }), yt)).toBe("broll");
    expect(guessType(file("/a.wav", { kind: "audio" }), yt)).toBe("audio");
    expect(guessType(file("/a.png", { kind: "photo", width: 1280, height: 720 }), yt)).toBe("thumbnail");
    expect(guessType(file("/a.jpg", { kind: "photo", width: 3000, height: 4000 }), yt)).toBe("photo");
  });
  it("respects the preset's type list", () => {
    expect(guessType(file("/a.jpg", { kind: "photo", width: 1080, height: 1350 }), groovy)).toBe("carousel");
    expect(guessType(file("/a.wav", { kind: "audio" }), groovy)).toBe("broll");
  });
});

describe("custom naming presets", () => {
  const base = { id: "custom-x", label: "Mine", pattern: "{date}-{slug}-{type}-v{version}", types: ["reel"], folders: { reel: "Reels" } };

  it("accepts a valid preset and rejects unsafe or unbumpable ones", () => {
    expect(validatePreset(base)).toEqual([]);
    expect(validatePreset({ ...base, pattern: "{date}_{slug}" }).join()).toMatch(/\{version\}/);
    expect(validatePreset({ ...base, pattern: "{date}/{slug}_v{version}" }).join()).toMatch(/can't contain/);
    expect(validatePreset({ ...base, pattern: "{date}\\{slug}_v{version}" }).join()).toMatch(/can't contain/);
    expect(validatePreset({ ...base, folders: { reel: "Reels\\Sub" } }).join()).toMatch(/valid folder/);
    expect(validatePreset({ ...base, pattern: "{when}_v{version}" }).join()).toMatch(/Unknown token \{when\}/);
    expect(validatePreset({ ...base, folders: { reel: "../up" } }).join()).toMatch(/valid folder/);
    expect(validatePreset({ ...base, label: " ", types: [] })).toHaveLength(2);
  });

  it("round-trips type lines", () => {
    const parsed = parseTypeLines("Reel: Reels\ntalking head\n\nreel: dup\ncarousel: Carousels/Slides");
    expect(parsed.types).toEqual(["reel", "talking-head", "carousel"]);
    expect(parsed.folders).toEqual({ reel: "Reels", "talking-head": "talking-head", carousel: "Carousels/Slides" });
    expect(validatePreset({ ...base, ...parsed }).join()).toMatch(/Carousels\/Slides/);
    expect(typeLines({ ...base, types: ["reel", "broll"], folders: { reel: "Reels" } })).toBe("reel: Reels\nbroll: broll");
  });

  it("lists built-ins first and ignores custom presets that shadow them", () => {
    const ids = allPresets([base, { ...base, id: "default" }]).map((p) => p.id);
    expect(ids).toEqual(["default", "groovy-gains", "custom-x"]);
  });
});
