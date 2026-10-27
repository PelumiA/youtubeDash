export type MediaKind = "video" | "photo" | "audio";

/** A file as inventoried by the Rust scanner (`scan_folder`). */
export interface MediaFile {
  id: number;
  path: string;
  dir: string;
  filename: string;
  ext: string;
  kind: MediaKind;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationS: number | null;
  /** Local calendar date the media was captured (EXIF) or created, `YYYY-MM-DD`. */
  capturedDate: string;
  fileHash: string;
  tags: string[];
}

export interface ScanResult {
  root: string;
  files: MediaFile[];
  truncated: boolean;
  skipped: number;
  ffprobeAvailable: boolean;
  elapsedMs: number;
}

/** One move handed to the Rust side; every applied move becomes a `rename_ops` row. */
export interface MoveOp {
  fileId: number | null;
  oldPath: string;
  newPath: string;
}

export interface BatchSummary {
  batchId: string;
  kind: "rename" | "archive";
  opCount: number;
  appliedAt: string;
  undoneAt: string | null;
}
