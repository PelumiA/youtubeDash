import type { MediaFile } from "./types";
import { joinPath, pathKey } from "./paths";

/** Max files a single apply run may touch in v1; larger sets are paginated. */
export const MAX_FILES_PER_RUN = 1000;

export interface NamingPreset {
  id: string;
  label: string;
  /** Tokens: {date} {slug} {type} {version}. The extension is appended automatically. */
  pattern: string;
  types: string[];
  /** Subfolder per content type when "sort into folders" is on. */
  folders: Record<string, string>;
}

export const PRESETS: NamingPreset[] = [
  {
    id: "default",
    label: "Default (YouTube)",
    pattern: "{date}_{slug}_{type}_v{version}",
    types: ["reel", "talking-head", "thumbnail", "broll", "audio", "photo"],
    folders: {
      reel: "reels",
      "talking-head": "talking-head",
      thumbnail: "thumbnails",
      broll: "broll",
      audio: "audio",
      photo: "photos",
    },
  },
  {
    id: "groovy-gains",
    label: "Groovy Gains",
    pattern: "{date}_{slug}_{type}_v{version}",
    types: ["reel", "talking-head", "carousel", "thumbnail", "broll"],
    folders: {
      reel: "Reels",
      "talking-head": "Reels",
      carousel: "Carousels",
      thumbnail: "Thumbnails",
      broll: "Reels",
    },
  },
];

/** Lowercase, hyphens instead of spaces, accents folded, anything else stripped. */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Best guess at a content type from what the scanner knows; the user can override per row. */
export function guessType(file: MediaFile, preset: NamingPreset): string {
  const has = (t: string) => preset.types.includes(t);
  const pick = (...options: string[]) => options.find(has) ?? preset.types[0];
  const { width: w, height: h } = file;
  switch (file.kind) {
    case "audio":
      return pick("audio", "broll");
    case "photo": {
      const widescreen = w != null && h != null && w >= 1280 && Math.abs(w / h - 16 / 9) < 0.05;
      return widescreen ? pick("thumbnail", "photo") : pick("photo", "carousel", "thumbnail");
    }
    case "video":
      if (w == null || h == null) return pick("broll");
      return h > w ? pick("reel", "broll") : pick("talking-head", "broll");
  }
}

export interface NameFields {
  date: string;
  slug: string;
  type: string;
}

function renderBase(pattern: string, fields: NameFields, version: string): string {
  return pattern
    .replaceAll("{date}", fields.date)
    .replaceAll("{slug}", slugify(fields.slug) || "untitled")
    .replaceAll("{type}", slugify(fields.type) || "file")
    .replaceAll("{version}", version);
}

export function renderFilename(pattern: string, fields: NameFields, version: number, ext: string): string {
  const base = renderBase(pattern, fields, String(version).padStart(2, "0"));
  return ext ? `${base}.${ext.toLowerCase()}` : base;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `filename` already follows the pattern for these fields (any version number). */
export function conformsTo(pattern: string, fields: NameFields, ext: string, filename: string): boolean {
  const marker = "\u0000VERSION\u0000";
  const base = escapeRegExp(renderBase(pattern, fields, marker)).replace(escapeRegExp(marker), "\\d{2,}");
  const suffix = ext ? `\\.${escapeRegExp(ext.toLowerCase())}` : "";
  return new RegExp(`^${base}${suffix}$`).test(filename);
}

export interface PlanInput {
  file: MediaFile;
  fields: NameFields;
  targetDir: string;
}

export interface PlannedOp {
  fileId: number;
  oldPath: string;
  newPath: string;
  newFilename: string;
  /** "unchanged" rows are shown in the diff but never sent to the apply step. */
  status: "rename" | "unchanged";
  /** Version was bumped past v01 to avoid a collision. */
  bumped: boolean;
}

/**
 * Pure dry-run planner. Never touches disk: `existingNames(dir)` reports what is already in
 * each target folder so the plan can bump versions instead of ever overwriting.
 *
 * Idempotent: files that already conform to the pattern keep their names, so planning the
 * output of a previous apply yields only "unchanged" rows.
 */
export function planRenames(
  inputs: PlanInput[],
  pattern: string,
  existingNames: (dir: string) => Iterable<string>,
): PlannedOp[] {
  if (!pattern.includes("{version}")) {
    throw new Error("Naming pattern must include {version} so collisions can be bumped instead of overwritten.");
  }
  if (inputs.length > MAX_FILES_PER_RUN) {
    throw new Error(`A run is capped at ${MAX_FILES_PER_RUN} files; got ${inputs.length}. Plan in pages.`);
  }

  const inPlan = new Set(inputs.map((i) => pathKey(i.file.path)));
  const occupied = new Set<string>();
  for (const dir of new Set(inputs.map((i) => i.targetDir))) {
    for (const name of existingNames(dir)) {
      const key = pathKey(joinPath(dir, name));
      // Files being renamed vacate their current names, so they don't block anyone.
      if (!inPlan.has(key)) occupied.add(key);
    }
  }

  const result = new Array<PlannedOp>(inputs.length);

  // Pass 1: already-conforming files reserve their current name first.
  inputs.forEach((input, i) => {
    const { file, fields, targetDir } = input;
    const sameDir = pathKey(file.dir) === pathKey(targetDir);
    const key = pathKey(file.path);
    if (sameDir && !occupied.has(key) && conformsTo(pattern, fields, file.ext, file.filename)) {
      occupied.add(key);
      result[i] = {
        fileId: file.id,
        oldPath: file.path,
        newPath: file.path,
        newFilename: file.filename,
        status: "unchanged",
        bumped: false,
      };
    }
  });

  // Pass 2: everyone else takes the lowest free version. Versions below the last one handed
  // out for a base name are all taken, so resume there instead of rescanning from v01.
  const nextVersion = new Map<string, number>();
  inputs.forEach((input, i) => {
    if (result[i]) return;
    const { file, fields, targetDir } = input;
    const baseKey = pathKey(joinPath(targetDir, renderFilename(pattern, fields, 0, file.ext)));
    let version = nextVersion.get(baseKey) ?? 1;
    let name = renderFilename(pattern, fields, version, file.ext);
    while (occupied.has(pathKey(joinPath(targetDir, name)))) {
      version += 1;
      name = renderFilename(pattern, fields, version, file.ext);
    }
    const newPath = joinPath(targetDir, name);
    occupied.add(pathKey(newPath));
    nextVersion.set(baseKey, version + 1);
    result[i] = {
      fileId: file.id,
      oldPath: file.path,
      newPath,
      newFilename: name,
      // A case-only change is still a rename.
      status: newPath === file.path ? "unchanged" : "rename",
      bumped: version > 1,
    };
  });

  return result;
}

// ---- Custom naming presets (edited under Settings) ----

const TOKENS = ["{date}", "{slug}", "{type}", "{version}"];

/** Problems with a custom preset, or [] when it can be used. */
export function validatePreset(p: NamingPreset): string[] {
  const problems: string[] = [];
  if (!p.label.trim()) problems.push("Give the preset a name.");
  if (!p.pattern.includes("{version}")) problems.push("The pattern must include {version}, so clashes get a new version instead of overwriting.");
  const unknown = (p.pattern.match(/\{[^}]*\}/g) ?? []).filter((t) => !TOKENS.includes(t));
  if (unknown.length) problems.push(`Unknown token${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. Use ${TOKENS.join(" ")}.`);
  if (/[\\/:*?"<>|]/.test(p.pattern.replace(/\{[^}]*\}/g, ""))) problems.push('The pattern can\'t contain \\ / : * ? " < > |');
  if (!p.types.length) problems.push("Add at least one content type.");
  for (const folder of Object.values(p.folders)) {
    if (!folder || /[\\/:*?"<>|]/.test(folder) || folder === "." || folder === "..") problems.push(`"${folder}" isn't a valid folder name.`);
  }
  return problems;
}

/** "reel: Reels" lines → types and their sort folders (a type without a folder sorts into its own name). */
export function parseTypeLines(text: string): { types: string[]; folders: Record<string, string> } {
  const types: string[] = [];
  const folders: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const [rawType, ...rest] = line.split(":");
    const type = slugify(rawType ?? "");
    if (!type || types.includes(type)) continue;
    types.push(type);
    folders[type] = rest.join(":").trim() || type;
  }
  return { types, folders };
}

export function typeLines(p: NamingPreset): string {
  return p.types.map((t) => `${t}: ${p.folders[t] ?? t}`).join("\n");
}

export function allPresets(custom: NamingPreset[]): NamingPreset[] {
  return [...PRESETS, ...custom.filter((c) => !PRESETS.some((p) => p.id === c.id))];
}
