/**
 * In-memory stand-in for the Rust commands, used only when the UI runs in a plain browser.
 * Mirrors the real semantics closely enough to click through the flow: moves are logged
 * and undoable, overwrites are refused, archive is a move. It never touches real files.
 */
import type { BatchSummary, MediaFile, MoveOp } from "../library/types";
import type { ClipSection } from "../library/sections";
import type { Idea, IdeaPatch, Project, ScaffoldRequest, ThumbnailRow } from "./api";
import { suggestLocally } from "../ideas/taxonomy";
import strongUrl from "../thumbnails/fixtures/strong.png?url";
import clutteredUrl from "../thumbnails/fixtures/cluttered.png?url";
import lowContrastUrl from "../thumbnails/fixtures/low-contrast.png?url";
import ideaShotUrl from "../ideas/fixtures/idea-screenshot.png?url";
import { basename, dirname, joinPath, pathKey } from "../library/paths";

const ROOT = "C:\\Demo\\Leg Day Shoot";

const seed: Array<[string, Partial<MediaFile>]> = [
  ["IMG_4410.MOV", { kind: "video", width: 1080, height: 1920, durationS: 42.5 }],
  ["IMG_4411.MOV", { kind: "video", width: 1080, height: 1920, durationS: 18.2 }],
  ["A001_talking head FINAL.mp4", { kind: "video", width: 3840, height: 2160, durationS: 1843 }],
  ["broll squat rack.mp4", { kind: "video", width: 1920, height: 1080, durationS: 12 }],
  ["broll squat rack copy.mp4", { kind: "video", width: 1920, height: 1080, durationS: 12 }],
  ["thumb idea 1.png", { kind: "photo", width: 1280, height: 720 }],
  ["thumb idea 2.png", { kind: "photo", width: 1280, height: 720 }],
  ["carousel slide 1.jpg", { kind: "photo", width: 1080, height: 1350 }],
  ["Voice Memo 12.m4a", { kind: "audio", durationS: 95 }],
  ["intro music.wav", { kind: "audio", durationS: 31 }],
];

let nextId = 1;
const files: MediaFile[] = seed.map(([name, meta], i) => ({
  id: nextId++,
  path: joinPath(ROOT, name),
  dir: ROOT,
  filename: name,
  ext: name.split(".").pop() ?? "",
  kind: "video",
  sizeBytes: 1_000_000 * (i + 1) * 37,
  width: null,
  height: null,
  durationS: null,
  capturedDate: i < 5 ? "2026-10-24" : "2026-10-25",
  // The "copy" shares a hash with its original so the duplicates view has something to show.
  fileHash: name.includes("squat rack") ? "fp:dup" : `fp:${i}`,
  tags: [],
  ...meta,
}));

interface LoggedOp extends MoveOp {
  batchId: string;
  kind: "rename" | "archive";
  appliedAt: string;
  undoneAt: string | null;
}
const log: LoggedOp[] = [];

let nextSectionId = 1;
const sections: ClipSection[] = [];

const projects: Project[] = [
  { id: 1, title: "Leg day, fixed", slug: "leg-day-fixed", category: null, status: "active", createdAt: "2026-10-26T10:00:00", folderPath: null, winnerThumbnailId: null, thumbnailCount: 3, bestScore: null, lastTestedAt: null },
];
const fixtureUrls: Record<string, string> = { "strong.png": strongUrl, "cluttered.png": clutteredUrl, "low-contrast.png": lowContrastUrl };
let nextThumbId = 1;
const thumbnails: ThumbnailRow[] = Object.keys(fixtureUrls).map((name) => ({
  id: nextThumbId++,
  projectId: 1,
  path: joinPath("C:\\Demo\\Thumbnails", name),
  label: name.replace(".png", ""),
  platform: "youtube",
  fileHash: `fp:${name}`,
  scoreTotal: null,
  breakdownJson: null,
  createdAt: "2026-10-26T10:00:00",
}));
const settings: Record<string, string> = {};
let demoKey = false;

let nextIdeaId = 1;
const idea = (patch: Partial<Idea>): Idea => ({
  id: nextIdeaId++, title: null, rawText: null, ocrText: null, category: null, tags: [], hasImage: false, source: "text",
  status: "inbox", projectId: null, projectFolder: null, suggestion: null, createdAt: "2026-10-26T09:00:00", updatedAt: null, ...patch,
});
const ideas: Idea[] = [
  idea({ rawText: "Remake the \"stop doing lunges like this\" reel that went viral last week, but with the fix at the end.", createdAt: "2026-10-25T18:20:00" }),
  idea({
    source: "clipboard", hasImage: true, createdAt: "2026-10-26T08:05:00",
    ocrText: "3 squat mistakes that are killing\nyour leg day (and how to fix each\none).\n\nFilm it as a quick talking head\nwith the squat rack behind me.\n\n2.4K likes 318 replies",
  }),
];
/** Idea images: the seeded screenshot is a fixture URL, captured ones are kept in memory. */
const ideaImages = new Map<number, string | ArrayBuffer>([[2, ideaShotUrl]]);
const usedFolders = new Set<string>();

const slugify = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";

function demoPlan(req: ScaffoldRequest) {
  const i = ideas.find((x) => x.id === req.ideaId);
  if (!i) throw new Error("Idea not found.");
  if (!req.title.trim()) throw new Error("Give the project a title.");
  if (!req.category.trim()) throw new Error("Confirm a category first.");
  if (!req.projectsDir) throw new Error("Choose a Projects folder first.");
  const base = joinPath(req.projectsDir, `${req.date}_${slugify(req.title).slice(0, 60).replace(/-+$/, "")}`);
  let folder = base;
  for (let n = 2; usedFolders.has(pathKey(folder)); n++) folder = `${base}-${n}`;
  const shot = i.hasImage ? "idea-screenshot.png" : null;
  let brief = `# ${req.title.trim()}\n\n- **Category:** ${req.category}\n- **Tags:** ${req.tags.length ? req.tags.join(", ") : "none"}\n- **Captured:** ${i.createdAt.slice(0, 10)}\n- **Project created:** ${req.date}\n`;
  if (i.rawText?.trim()) brief += `\n## Idea\n\n${i.rawText.trim()}\n`;
  if (i.ocrText?.trim()) brief += `\n## Text from the screenshot\n\n${i.ocrText.trim()}\n`;
  if (shot) brief += `\n![Screenshot](assets/${shot})\n`;
  if (req.footer.trim()) brief += `\n---\n\n${req.footer.trim()}\n`;
  const script = `# ${req.title.trim()} — script\n\n## Hook (first 5 seconds)\n\n\n## Setup\n\n\n## Main points\n\n1. \n2. \n3. \n\n## Payoff\n\n\n## Call to action\n\n`;
  return { folder, entries: ["brief.md", "script.md", "assets/", ...(shot ? [`assets/${shot}`] : []), "thumbnails/"], brief, script };
}

const ideaView = (i: Idea): Idea => ({ ...i, projectFolder: projects.find((p) => p.id === i.projectId)?.folderPath ?? null });

const projectView = (p: Project): Project => {
  const mine = thumbnails.filter((t) => t.projectId === p.id);
  const scores = mine.map((t) => t.scoreTotal).filter((x): x is number => x != null);
  return { ...p, thumbnailCount: mine.length, bestScore: scores.length ? Math.max(...scores) : null, lastTestedAt: mine.length ? mine[mine.length - 1].createdAt : null };
};

const visible = () => files.filter((f) => !pathKey(f.path).includes("/_archive/"));

function move(ops: MoveOp[], kind: "rename" | "archive"): string {
  const sources = new Set(ops.map((o) => pathKey(o.oldPath)));
  for (const op of ops) {
    const clash = files.find((f) => pathKey(f.path) === pathKey(op.newPath) && !sources.has(pathKey(f.path)));
    if (clash) throw new Error(`Refusing to overwrite existing file: ${op.newPath}`);
  }
  const batchId = `demo-${Date.now().toString(36)}`;
  for (const op of ops) {
    const f = files.find((x) => x.path === op.oldPath)!;
    Object.assign(f, { path: op.newPath, dir: dirname(op.newPath), filename: basename(op.newPath) });
    log.push({ ...op, batchId, kind, appliedAt: new Date().toISOString(), undoneAt: null });
  }
  return batchId;
}

const handlers: Record<string, (args: any) => unknown> = {
  scan_folder: () => ({ root: ROOT, files: visible(), truncated: false, skipped: 0, ffprobeAvailable: false, elapsedMs: 3 }),
  list_inventory: () => visible(),
  list_dir_names: ({ dirs }: { dirs: string[] }) =>
    Object.fromEntries(dirs.map((d) => [d, files.filter((f) => pathKey(f.dir) === pathKey(d)).map((f) => f.filename)])),
  apply_moves: ({ ops }: { ops: MoveOp[] }) => move(ops, "rename"),
  undo_batch: ({ batchId }: { batchId: string }) => {
    const ops = log.filter((o) => o.batchId === batchId && !o.undoneAt).reverse();
    if (!ops.length) throw new Error("This batch has already been undone (or does not exist).");
    for (const op of ops) {
      const f = files.find((x) => x.path === op.newPath)!;
      Object.assign(f, { path: op.oldPath, dir: dirname(op.oldPath), filename: basename(op.oldPath) });
      op.undoneAt = new Date().toISOString();
    }
    return ops.length;
  },
  list_batches: (): BatchSummary[] => {
    const ids = [...new Set(log.map((o) => o.batchId))].reverse();
    return ids.map((batchId) => {
      const ops = log.filter((o) => o.batchId === batchId);
      return { batchId, kind: ops[0].kind, opCount: ops.length, appliedAt: ops[0].appliedAt, undoneAt: ops[0].undoneAt };
    });
  },
  set_tags: ({ fileId, tags }: { fileId: number; tags: string[] }) => {
    files.find((f) => f.id === fileId)!.tags = tags;
  },
  preview_archive: ({ paths }: { paths: string[] }) => paths.map((p) => joinPath(ROOT, "_archive", "2026-10-27_120000", basename(p))),
  archive_files: ({ fileIds }: { fileIds: number[] }) =>
    move(
      fileIds.map((id) => {
        const f = files.find((x) => x.id === id)!;
        return { fileId: id, oldPath: f.path, newPath: joinPath(ROOT, "_archive", "2026-10-27_120000", f.filename) };
      }),
      "archive",
    ),
  find_duplicates: () => {
    const groups = new Map<string, MediaFile[]>();
    for (const f of visible()) groups.set(f.fileHash, [...(groups.get(f.fileHash) ?? []), f]);
    return [...groups.values()].filter((g) => g.length > 1);
  },
  tool_status: () => ({ ffmpeg: "demo", ffprobe: "demo" }),
  list_sections: ({ mediaFileId }: { mediaFileId: number }) =>
    sections.filter((s) => s.mediaFileId === mediaFileId).sort((a, b) => a.startS - b.startS),
  section_counts: () => {
    const counts: Record<string, number> = {};
    for (const s of sections) counts[s.mediaFileId] = (counts[s.mediaFileId] ?? 0) + 1;
    return counts;
  },
  save_section: ({ section }: { section: ClipSection }) => {
    if (!(section.endS > section.startS)) throw new Error("A section must end after it starts.");
    const existing = sections.find((s) => s.id === section.id);
    if (existing) return Object.assign(existing, section);
    const created = { ...section, id: nextSectionId++ };
    sections.push(created);
    return created;
  },
  delete_section: ({ sectionId }: { sectionId: number }) => {
    const i = sections.findIndex((s) => s.id === sectionId);
    const had = sections[i]?.exportedPath;
    sections.splice(i, 1);
    return had ? `demo-archive-${sectionId}` : null;
  },
  // Fake but plausible: a pause roughly every sixth of the clip, keyframes every 2 s.
  analyze_clip: ({ path, scenes }: { path: string; scenes: boolean }) => {
    const d = files.find((f) => f.path === path)?.durationS ?? 600;
    const silences = [1, 2, 3, 4, 5].map((i) => ({ startS: (d * i) / 6 - 0.8, endS: (d * i) / 6 + 0.6 }));
    return {
      silences,
      scenes: scenes ? [1, 2, 3].map((i) => Math.round((d * i) / 4)) : [],
      suggestions: silences.map((s) => Math.round(((s.startS + s.endS) / 2) * 100) / 100),
    };
  },
  clip_keyframes: ({ path }: { path: string }) => {
    const d = files.find((f) => f.path === path)?.durationS ?? 600;
    return Array.from({ length: Math.floor(d / 2) + 1 }, (_, i) => i * 2);
  },
  export_sections: ({ mediaFileId, sectionIds }: { mediaFileId: number; sectionIds: number[] }) => {
    const clip = files.find((f) => f.id === mediaFileId)!;
    const stem = clip.filename.replace(/\.[^.]+$/, "");
    return sectionIds.map((id) => {
      const s = sections.find((x) => x.id === id)!;
      const idx = sections.filter((x) => x.mediaFileId === mediaFileId).sort((a, b) => a.startS - b.startS).indexOf(s);
      const name = `${String(idx + 1).padStart(2, "0")}_${s.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.mp4`;
      s.exportedPath = joinPath(ROOT, "_sections", stem, name);
      return { sectionId: id, path: s.exportedPath, mode: s.startS % 2 === 0 ? "copy" : "encode", error: null };
    });
  },
  list_projects: () => projects.map(projectView),
  create_project: ({ title }: { title: string }) => {
    if (!title.trim()) throw new Error("Give the project a title.");
    const p: Project = { id: Math.max(0, ...projects.map((x) => x.id)) + 1, title: title.trim(), slug: slugify(title), category: null, status: "active", createdAt: new Date().toISOString(), folderPath: null, winnerThumbnailId: null, thumbnailCount: 0, bestScore: null, lastTestedAt: null };
    projects.unshift(p);
    return projectView(p);
  },
  list_thumbnails: ({ projectId }: { projectId: number }) => thumbnails.filter((t) => t.projectId === projectId),
  add_thumbnails: () => {
    throw new Error("Adding images needs the desktop app. The demo project already has three candidates.");
  },
  read_thumbnail: async ({ thumbnailId }: { thumbnailId: number }) => {
    const t = thumbnails.find((x) => x.id === thumbnailId)!;
    const name = Object.keys(fixtureUrls).find((n) => t.path.endsWith(n))!;
    return (await fetch(fixtureUrls[name])).arrayBuffer();
  },
  save_thumbnail_score: ({ thumbnailId, platform, scoreTotal, breakdownJson }: { thumbnailId: number; platform: "youtube" | "instagram"; scoreTotal: number; breakdownJson: string }) => {
    Object.assign(thumbnails.find((t) => t.id === thumbnailId)!, { platform, scoreTotal, breakdownJson });
  },
  rename_thumbnail: ({ thumbnailId, label }: { thumbnailId: number; label: string }) => {
    thumbnails.find((t) => t.id === thumbnailId)!.label = label;
  },
  remove_thumbnail: ({ thumbnailId }: { thumbnailId: number }) => {
    thumbnails.splice(thumbnails.findIndex((t) => t.id === thumbnailId), 1);
    for (const p of projects) if (p.winnerThumbnailId === thumbnailId) p.winnerThumbnailId = null;
  },
  set_winner: ({ projectId, thumbnailId }: { projectId: number; thumbnailId: number | null }) => {
    projects.find((p) => p.id === projectId)!.winnerThumbnailId = thumbnailId;
  },
  get_setting: ({ key }: { key: string }) => settings[key] ?? null,
  set_setting: ({ key, value }: { key: string; value: string }) => {
    settings[key] = value;
  },
  ai_status: () => ({ configured: demoKey, source: demoKey ? "keychain" : null, model: "claude-opus-5-5" }),
  set_api_key: ({ key }: { key: string }) => {
    if (!key.startsWith("sk-ant-")) throw new Error("That doesn't look like an Anthropic API key (they start with sk-ant-).");
    demoKey = true;
    return handlers.ai_status({});
  },
  clear_api_key: () => {
    demoKey = false;
    return handlers.ai_status({});
  },
  // Canned critique so the flow can be clicked through; the real one calls Claude from Rust.
  critique_thumbnail: ({ thumbnailId }: { thumbnailId: number }) => {
    if (!demoKey) throw new Error("No API key set. Add one under Scoring settings to enable the AI critique.");
    const t = thumbnails.find((x) => x.id === thumbnailId)!;
    const strong = t.path.endsWith("strong.png");
    return {
      model: "claude-opus-5-5 (demo)",
      hookScore: strong ? 7 : t.path.endsWith("cluttered.png") ? 4 : 3,
      readsInOneSecond: strong,
      emotion: strong ? "confident relief" : "confusion",
      story: strong ? "Someone found the fix for a bad leg day." : "Hard to tell what the video is about.",
      subjectNote: strong ? "The face is the clear focal point." : "No single subject stands out.",
      critique: strong
        ? ["Show the problem being fixed: a before/after split would add curiosity.", "The smile undersells the payoff; a surprised face would raise stakes."]
        : ["Cut to one subject and one short phrase.", "Remove the background pattern so the face can carry the frame."],
      cached: false,
    };
  },
  capture_idea: ({ rawText, ocrText, imageBase64, source }: { rawText: string; ocrText: string | null; imageBase64: string | null; source: Idea["source"] }) => {
    if (!rawText.trim() && !imageBase64) throw new Error("Type an idea or add a screenshot first.");
    const now = new Date().toISOString();
    const created = idea({ rawText: rawText.trim() || null, ocrText: ocrText?.trim() || null, hasImage: !!imageBase64, source, createdAt: now, updatedAt: now });
    if (imageBase64) ideaImages.set(created.id, Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0)).buffer);
    ideas.push(created);
    return ideaView(created);
  },
  list_ideas: ({ query, status }: { query: string; status: Idea["status"] | null }) => {
    const q = query.trim().toLowerCase();
    return ideas
      .map(ideaView)
      .filter((i) => (!status || i.status === status) && [i.title, i.rawText, i.ocrText, i.category, i.tags.join(" "), i.projectFolder].join(" ").toLowerCase().includes(q))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  },
  update_idea: ({ ideaId, patch }: { ideaId: number; patch: IdeaPatch }) => {
    const i = ideas.find((x) => x.id === ideaId);
    if (!i) throw new Error("Idea not found.");
    const defined: Partial<Idea> = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== null));
    if (defined.tags) defined.tags = [...new Set(defined.tags.map((t) => t.trim().replace(/^#/, "").toLowerCase()).filter(Boolean))];
    Object.assign(i, defined, { updatedAt: new Date().toISOString() });
    return ideaView(i);
  },
  set_idea_status: ({ ideaId, status }: { ideaId: number; status: "inbox" | "archived" }) => {
    const i = ideas.find((x) => x.id === ideaId)!;
    if (i.status === "project") throw new Error("This idea is already a project.");
    i.status = status;
    return ideaView(i);
  },
  read_idea_image: async ({ ideaId }: { ideaId: number }) => {
    const img = ideaImages.get(ideaId);
    if (!img) throw new Error("This idea has no image.");
    return typeof img === "string" ? (await fetch(img)).arrayBuffer() : img;
  },
  // Canned "Claude" suggestion (the keyword suggestion relabelled) so the flow can be clicked through.
  categorize_idea: ({ ideaId, taxonomy }: { ideaId: number; taxonomy: string[] }) => {
    if (!demoKey) throw new Error("No API key set. Add an Anthropic API key in settings to use Claude.");
    const i = ideas.find((x) => x.id === ideaId)!;
    const local = suggestLocally([i.rawText, i.ocrText].filter(Boolean).join("\n\n"), taxonomy);
    i.suggestion = { ...local, source: "ai", model: "claude-opus-5-5 (demo)", reason: null };
    return ideaView(i);
  },
  preview_scaffold: ({ request }: { request: ScaffoldRequest }) => demoPlan(request),
  scaffold_idea: ({ request }: { request: ScaffoldRequest }) => {
    const i = ideas.find((x) => x.id === request.ideaId);
    if (i?.status === "project") throw new Error("This idea is already a project.");
    if (i?.status === "archived") throw new Error("Restore this idea to the inbox first.");
    const plan = demoPlan(request);
    usedFolders.add(pathKey(plan.folder));
    const p: Project = { id: Math.max(0, ...projects.map((x) => x.id)) + 1, title: request.title.trim(), slug: slugify(request.title), category: request.category, status: "active", createdAt: new Date().toISOString(), folderPath: plan.folder, winnerThumbnailId: null, thumbnailCount: 0, bestScore: null, lastTestedAt: null };
    projects.unshift(p);
    Object.assign(i!, { status: "project", projectId: p.id, title: p.title, category: request.category, tags: request.tags });
    return projectView(p);
  },
  dashboard_summary: () => ({
    filesIndexed: visible().length,
    batchesApplied: new Set(log.filter((o) => !o.undoneAt).map((o) => o.batchId)).size,
    ideasInInbox: ideas.filter((i) => i.status === "inbox").length,
    projectsActive: projects.filter((p) => p.status === "active").length,
    recentBatches: handlers.list_batches({}) as BatchSummary[],
  }),
};

export async function demoInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const handler = handlers[cmd];
  if (!handler) throw new Error(`Demo backend has no command "${cmd}"`);
  const out = await handler(args);
  // Return copies so React state never aliases the demo store.
  return (out instanceof ArrayBuffer ? out : structuredClone(out)) as T;
}
