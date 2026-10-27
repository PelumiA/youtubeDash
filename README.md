# Creator Dashboard

A local-first desktop dashboard for running a YouTube-first content workflow: organize media
folders, test thumbnails, and turn ideas into project folders. Built with Tauri 2 (Rust) +
React + TypeScript + Tailwind, with SQLite as the local store.

Your media never leaves your machine. Nothing on disk changes without a dry-run preview and an
explicit confirmation, every change is logged and undoable, and nothing is ever deleted
(removals are moves into `_archive/`).

## Status

| Phase | Module | State |
|---|---|---|
| 1 | Media library organizer | **In progress**: scan, naming presets, dry-run diff, apply + undo, tags, duplicates done; long-clip sections next (needs ffmpeg) |
| 2 | Thumbnail tester | Not started (gated on Phase 1 done) |
| 3 | Idea organizer | Not started |
| 4 | Polish (settings, search, onboarding) | Not started |

## Requirements

- Node 20+ and npm
- Rust (stable) via [rustup](https://rustup.rs). On Windows also the MSVC C++ Build Tools
- Optional: `ffprobe`/`ffmpeg` on `PATH` for video duration/resolution (and, later, clip sections)

## Run

```bash
npm install
npm run tauri dev      # desktop app, works on real folders
npm run dev            # browser-only UI preview against in-memory demo data
```

## Test

```bash
npm test                              # rename engine (collisions, special chars, idempotency, perf)
cd src-tauri && cargo test            # scan, apply/undo byte-identical restore, rollback, archive, tags
```

## Layout

```
src/
  app/        shell, navigation, shared UI
  dashboard/  home launcher
  library/    Module 1 UI + pure rename engine (renameEngine.ts)
  thumbnails/ Module 2 (placeholder)
  ideas/      Module 3 (placeholder)
  db/         typed bridge to Rust commands + browser demo backend
src-tauri/src/
  scan.rs     read-only folder scan, metadata, fingerprints
  fsops.rs    the only code that changes files: two-phase moves, rollback, undo log, archive
  db.rs       SQLite schema and queries
  lib.rs      Tauri commands
```

## How renames stay safe

1. **Plan (TypeScript, pure):** `planRenames` computes new names from the pattern
   `{date}_{slug}_{type}_v{version}`. It never targets a name that's already taken and bumps
   the version instead. Files that already match the pattern keep their names, so re-running
   is a no-op.
2. **Apply (Rust):** the batch is validated again against the disk (no overwrites, no duplicate
   targets, max 1,000 files). Then every file is parked under a temp name and moved to its final
   name, so swaps and chains work. Any failure rolls back every completed step.
3. **Log:** each move becomes a `rename_ops` row. If the log can't be written, the files are put back.
4. **Undo:** restores a batch in reverse order through the same validated two-phase mover.
