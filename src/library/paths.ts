/** Path helpers that work on both Windows (`\`) and POSIX (`/`) paths coming from the Rust side. */

export function separatorOf(path: string): "\\" | "/" {
  return path.includes("\\") ? "\\" : "/";
}

export function joinPath(dir: string, ...parts: string[]): string {
  const sep = separatorOf(dir);
  const trimmed = dir.replace(/[\/]+$/, "");
  return [trimmed, ...parts.map((p) => p.replace(/^[\/]+|[\/]+$/g, ""))].join(sep);
}

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i < 0 ? "" : path.slice(0, i);
}

export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return path.slice(i + 1);
}

/** Key for collision checks: Windows and default macOS volumes are case-insensitive. */
export function pathKey(path: string): string {
  return path.replace(/[\/]+/g, "/").replace(/\/$/, "").toLowerCase();
}
