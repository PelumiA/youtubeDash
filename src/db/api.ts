/**
 * Typed bridge to the Rust commands. Outside the desktop shell (plain `npm run dev` in a
 * browser) calls are routed to an in-memory demo backend so the UI can still be explored.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { BatchSummary, MediaFile, MoveOp, ScanResult } from "../library/types";
import { demoInvoke } from "./demoBackend";

export interface DashboardSummary {
  filesIndexed: number;
  batchesApplied: number;
  ideasInInbox: number;
  projectsActive: number;
  recentBatches: BatchSummary[];
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
};

export async function pickFolder(): Promise<string | null> {
  if (!inDesktopApp) return "C:\\Demo\\Leg Day Shoot";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "Choose a media folder" });
  return typeof picked === "string" ? picked : null;
}
