/** Default tag palette. Tags live in SQLite; colors are display-only. Editable in Settings (Phase 4). */
export const TAG_PALETTE: Array<{ id: string; color: string }> = [
  { id: "to-edit", color: "#d97706" },
  { id: "ready", color: "#16a34a" },
  { id: "posted", color: "#2563eb" },
  { id: "broll", color: "#7c3aed" },
  { id: "thumbnail", color: "#db2777" },
  { id: "archive", color: "#6b7280" },
];

export function tagColor(id: string): string {
  return TAG_PALETTE.find((t) => t.id === id)?.color ?? "#6b7280";
}
