/**
 * In-memory stand-in for the Rust commands, used only when the UI runs in a plain browser.
 * Mirrors the real semantics closely enough to click through the flow: moves are logged
 * and undoable, overwrites are refused, archive is a move. It never touches real files.
 */
import type { BatchSummary, MediaFile, MoveOp } from "../library/types";
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
  // Return copies so React state never aliases the demo store.
  return structuredClone(handler(args)) as T;
}
