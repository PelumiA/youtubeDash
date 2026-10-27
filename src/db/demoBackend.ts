/**
 * In-memory stand-in for the Rust commands, used only when the UI runs in a plain browser.
 * Mirrors the real semantics closely enough to click through the flow: moves are logged
 * and undoable, overwrites are refused, archive is a move. It never touches real files.
 */
import type { BatchSummary, MediaFile, MoveOp } from "../library/types";
import type { ClipSection } from "../library/sections";
import type { Project, ThumbnailRow } from "./api";
import strongUrl from "../thumbnails/fixtures/strong.png?url";
import clutteredUrl from "../thumbnails/fixtures/cluttered.png?url";
import lowContrastUrl from "../thumbnails/fixtures/low-contrast.png?url";
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
  { id: 1, title: "Leg day, fixed", slug: "leg-day-fixed", status: "active", createdAt: "2026-10-26T10:00:00", folderPath: null, winnerThumbnailId: null, thumbnailCount: 3, bestScore: null, lastTestedAt: null },
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
    const p: Project = { id: projects.length + 1, title: title.trim(), slug: title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), status: "active", createdAt: new Date().toISOString(), folderPath: null, winnerThumbnailId: null, thumbnailCount: 0, bestScore: null, lastTestedAt: null };
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
  dashboard_summary: () => ({
    filesIndexed: visible().length,
    batchesApplied: new Set(log.filter((o) => !o.undoneAt).map((o) => o.batchId)).size,
    ideasInInbox: 0,
    projectsActive: 0,
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
