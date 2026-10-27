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
| 1 | Media library organizer | **Built**: scan, naming presets, dry-run diff, apply + undo, tags, duplicates, long-clip sections + chapters. Not yet tried on a real media folder. Transcript (Whisper) segmentation not started |
| 2 | Thumbnail tester | Not started (gated on Phase 1 done) |
| 3 | Idea organizer | Not started |
| 4 | Polish (settings, search, onboarding) | Not started |

## Requirements

- Node 20+ and npm
- Rust (stable) via [rustup](https://rustup.rs). On Windows also the MSVC C++ Build Tools
- ffmpeg/ffprobe for video metadata and clip sections (`winget install Gyan.FFmpeg`, `brew install ffmpeg`).
  The app also looks in winget/Homebrew/Chocolatey locations, or set `CREATOR_DASHBOARD_FFMPEG_DIR`.

## Run

```bash
npm install
npm run tauri dev      # desktop app, works on real folders
npm run dev            # browser-only UI preview against in-memory demo data
```

## Test

```bash
npm test                              # rename engine (collisions, special chars, idempotency, perf)
cd src-tauri && cargo test            # scan, apply/undo byte-identical restore, rollback, archive, tags,
                                      # and a generated 30-min clip: silence detection, section export, source unchanged
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
  fsops.rs    the only code that moves files: two-phase moves, rollback, undo log, archive
  sections.rs long-clip sections: silence/scene detection, keyframes, export to _sections/
  tools.rs    locates ffmpeg/ffprobe
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

## Long-clip sections

Open a video or audio file from the inventory ("Split…"). Drop markers while previewing (press
**M**), or run **Detect cut points**: ffmpeg finds pauses (and optionally scene changes) and
shows them as dashed suggestions. Only the markers you accept become cuts. You then split
the clip, then label, tag and annotate each section.

Export writes each section as a new file to `<folder>/_sections/<clip>/NN_<label>.<ext>`:

- A section that starts on a keyframe is **stream-copied** (fast, lossless). "Snap to
  keyframes" (on by default) keeps markers on keyframes.
- A section that starts between keyframes is **re-encoded** (H.264/AAC .mp4) for a
  frame-accurate cut.
- The source clip is only ever read. Exports never overwrite existing files.
- Deleting or re-exporting a section moves its old export to `_archive/`.

The YouTube chapters panel builds a paste-ready `0:00 …` list from the sections and warns
when YouTube's rules aren't met (start at 0:00, at least 3 chapters, each at least 10 s).
