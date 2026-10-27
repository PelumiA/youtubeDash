/**
 * Typed bridge to the Rust commands. Outside the desktop shell (plain `npm run dev` in a
 * browser) calls are routed to an in-memory demo backend so the UI can still be explored.
 */
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import type { BatchSummary, MediaFile, MoveOp, ScanResult } from "../library/types";
import type { ClipSection, CutAnalysis, ExportResult } from "../library/sections";
import type { AiCritique } from "../thumbnails/score";
import { demoInvoke } from "./demoBackend";

export interface DashboardSummary {
  filesIndexed: number;
  batchesApplied: number;
  ideasInInbox: number;
  projectsActive: number;
  recentBatches: BatchSummary[];
}

export interface Project {
  id: number;
  title: string;
  slug: string;
  status: string;
  createdAt: string;
  folderPath: string | null;
  winnerThumbnailId: number | null;
  thumbnailCount: number;
  bestScore: number | null;
  lastTestedAt: string | null;
}

export interface ThumbnailRow {
  id: number;
  projectId: number;
  path: string;
  label: string;
  platform: "youtube" | "instagram";
  fileHash: string | null;
  scoreTotal: number | null;
  breakdownJson: string | null;
  createdAt: string;
}

export interface AiStatus {
  configured: boolean;
  source: "env" | "keychain" | null;
  model: string;
}

export const inDesktopApp = isTauri();

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return inDesktopApp ? invoke<T>(cmd, args) : demoInvoke<T>(cmd, args ?? {});
}

export const api = {
  scanFolder: (root: string) => call<ScanResult>("scan_folder", { root }),
  listInventory: (root: string) => call<MediaFile[]>("list_inventory", { root }),
  listDirNames: (dirs: string[]) => call<Record<string, string[]>>("list_dir_names", { dirs }),
  applyMoves: (ops: MoveOp[]) => call<string>("apply_moves", { ops }),
  undoBatch: (batchId: string) => call<number>("undo_batch", { batchId }),
  listBatches: () => call<BatchSummary[]>("list_batches"),
  setTags: (fileId: number, tags: string[]) => call<void>("set_tags", { fileId, tags }),
  previewArchive: (root: string, paths: string[]) => call<string[]>("preview_archive", { root, paths }),
  archiveFiles: (root: string, fileIds: number[]) => call<string>("archive_files", { root, fileIds }),
  findDuplicates: (root: string) => call<MediaFile[][]>("find_duplicates", { root }),
  dashboardSummary: () => call<DashboardSummary>("dashboard_summary"),
  toolStatus: () => call<{ ffmpeg: string | null; ffprobe: string | null }>("tool_status"),
  listSections: (mediaFileId: number) => call<ClipSection[]>("list_sections", { mediaFileId }),
  sectionCounts: (root: string) => call<Record<string, number>>("section_counts", { root }),
  saveSection: (section: ClipSection) => call<ClipSection>("save_section", { section }),
  /** Returns the archive batch id when an export was moved to `_archive/`. */
  deleteSection: (root: string, sectionId: number) => call<string | null>("delete_section", { root, sectionId }),
  analyzeClip: (path: string, opts: { noiseDb: number; minSilenceS: number; scenes: boolean; sceneThreshold: number }) =>
    call<CutAnalysis>("analyze_clip", { path, ...opts }),
  clipKeyframes: (path: string) => call<number[]>("clip_keyframes", { path }),
  exportSections: (root: string, mediaFileId: number, sectionIds: number[]) =>
    call<ExportResult[]>("export_sections", { root, mediaFileId, sectionIds }),
  listProjects: () => call<Project[]>("list_projects"),
  createProject: (title: string) => call<Project>("create_project", { title }),
  listThumbnails: (projectId: number) => call<ThumbnailRow[]>("list_thumbnails", { projectId }),
  addThumbnails: (projectId: number, paths: string[], platform: string) => call<ThumbnailRow[]>("add_thumbnails", { projectId, paths, platform }),
  readThumbnail: (thumbnailId: number) => call<ArrayBuffer>("read_thumbnail", { thumbnailId }),
  saveThumbnailScore: (thumbnailId: number, platform: string, scoreTotal: number, breakdownJson: string) =>
    call<void>("save_thumbnail_score", { thumbnailId, platform, scoreTotal, breakdownJson }),
  renameThumbnail: (thumbnailId: number, label: string) => call<void>("rename_thumbnail", { thumbnailId, label }),
  removeThumbnail: (thumbnailId: number) => call<void>("remove_thumbnail", { thumbnailId }),
  setWinner: (projectId: number, thumbnailId: number | null) => call<void>("set_winner", { projectId, thumbnailId }),
  getSetting: (key: string) => call<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) => call<void>("set_setting", { key, value }),
  aiStatus: () => call<AiStatus>("ai_status"),
  setApiKey: (key: string) => call<AiStatus>("set_api_key", { key }),
  clearApiKey: () => call<AiStatus>("clear_api_key"),
  critiqueThumbnail: (thumbnailId: number, imageBase64: string, platform: string, title: string) =>
    call<AiCritique>("critique_thumbnail", { thumbnailId, imageBase64, platform, title }),
};

export async function pickImages(): Promise<string[]> {
  if (!inDesktopApp) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: true,
    title: "Choose thumbnail candidates",
    filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"] }],
  });
  return Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
}

/** Playable URL for a local file (desktop only; the folder must have been scanned). */
export function mediaUrl(path: string): string | null {
  return inDesktopApp ? convertFileSrc(path) : null;
}

export async function pickFolder(): Promise<string | null> {
  if (!inDesktopApp) return "C:\\Demo\\Leg Day Shoot";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "Choose a media folder" });
  return typeof picked === "string" ? picked : null;
}
