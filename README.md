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
| 2 | Thumbnail tester | **Built**: offline heuristic scoring with local OCR, YouTube + Instagram cover overlays, previews, comparison, winner, adjustable weights/overrides, opt-in Claude critique. Not yet tried with your own thumbnails or a live API key |
| 3 | Idea organizer | **Built**: text / screenshot / paste / drop capture, local OCR, offline + opt-in Claude categorization, confirm-then-scaffold project folders, inbox + search. Not yet tried with a live API key |
| 4 | Polish | **Built**: first-run setup, Settings page, custom naming presets, global search (Ctrl+K), keyboard shortcuts, project summary export |

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
npm test                              # rename engine, sections/chapters, contrast/safe-zone math, scoring,
                                      # the thumbnail fixture pack scored with real local OCR, and the
                                      # idea happy path: screenshot → OCR → suggestion → project folder
cd src-tauri && cargo test            # scan, apply/undo byte-identical restore, rollback, archive, tags,
                                      # a generated 30-min clip: silence detection, section export, source unchanged,
                                      # and idea capture/search/scaffolding (never reuses an existing folder)
```

## Layout

```
src/
  app/        shell, navigation, shared UI, search palette, shortcuts, first-run setup,
              settings keys, project summary (projectSummary.ts)
  settings/   Settings page
  dashboard/  home launcher
  library/    Module 1 UI + pure rename engine (renameEngine.ts)
  thumbnails/ Module 2: heuristics.ts (pure scoring), ocr.ts (local Tesseract), score.ts (weights,
              overrides, why-won), platforms.ts (overlay zones), fixtures/ (test thumbnails)
  ideas/      Module 3: taxonomy.ts (presets, offline suggestion), ocrImage.ts (screenshot OCR prep),
              fixtures/ (test screenshot)
  db/         typed bridge to Rust commands + browser demo backend
src-tauri/src/
  scan.rs     read-only folder scan, metadata, fingerprints
  fsops.rs    the only code that moves files: two-phase moves, rollback, undo log, archive
  sections.rs long-clip sections: silence/scene detection, keyframes, export to _sections/
  tools.rs    locates ffmpeg/ffprobe
  thumbs.rs   projects, thumbnail candidates (referenced in place), settings
  ideas.rs    idea inbox, search, project folder scaffolding (create-only)
  search.rs   global search across files, clip sections, projects and ideas
  setup.rs    first-run starter folders (create-only)
  ai.rs       Claude calls (thumbnail critique, idea categorization): raw HTTP, key from env or
              OS keychain, cached
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

## Thumbnail tester

Add 2–4 candidates to a project, then pick YouTube 16:9 or Instagram cover 9:16. Each
candidate is scored out of 100. The default weights are listed below, and you can change them
under Scoring settings:

| Dimension | Points | How |
|---|---|---|
| Text readability | 30 | Local OCR (Tesseract, two passes: global + adaptive threshold) finds text lines. WCAG contrast of the text color vs. its background, headline height at the size viewers see it (320 px wide on YouTube), word count |
| Subject clarity | 25 | Saliency grid (color distance + edges), largest salient region: size, dominance, number of competing elements |
| Safe zones | 20 | Overlap of text and the main subject with platform overlays: YouTube duration badge, hover buttons, progress bar. Instagram: like/comment/share rail, caption area, profile-grid 3:4 crop |
| Color & contrast | 15 | Tonal spread, saturation, subject/background separation, red/green-only color-blind check |
| Hook / curiosity | 10 | Claude (`claude-opus-5-5`) vision critique. Advisory, and only runs when you ask |

- **Deterministic.** The first four dimensions run offline and give the same score for the
  same image (decode, resize and OCR are pinned). The fixture tests check this.
- **Explained and overridable.** Every dimension shows its notes. Any dimension can be set
  by hand, and the measured value stays visible.
- **Offline fallback.** Without an API key or network, the hook shows "unavailable" and the
  score is out of the remaining 90 points.
- **AI privacy.** Before anything is sent you confirm: the image (as a JPEG at upload size)
  and the video title. The key lives in the OS keychain (or `ANTHROPIC_API_KEY`) and stays
  in the Rust backend. Results are cached per image + platform + title. Requests opt in to
  server-side refusal fallback (`fallbacks: "default"`).
- **Files untouched.** Candidate images are referenced in place. Adding or removing one
  never copies, moves or deletes the file.

OCR assets (`public/tesseract`, ~15 MB) are copied from `node_modules` by `npm run dev`/`build`.
To regenerate the test fixtures, run `node scripts/make-thumbnail-fixtures.mjs`.

## Idea organizer

Capture an idea by typing it, pasting a screenshot (Ctrl+V anywhere on the page), choosing an
image, or dropping one on the window. Screenshots are copied into the app's data folder, so
the idea survives the original being cleaned up, and their text is read locally (dark-mode
screenshots are inverted and small ones upscaled first). You can correct the OCR text inline.

Each idea gets a suggestion of category, working title and tags:

- **Offline, always.** A keyword match picks the category and says which words matched; the
  first real sentence becomes the title (app chrome like handles, timestamps and like counts is
  skipped); hashtags and frequent topic words become tags.
- **Claude, when you ask.** With an API key, "Ask Claude" sends the idea's text (typed and OCR'd,
  not the image) and your category list. After you confirm once, new ideas that session get
  Claude's suggestion automatically. The category is constrained to your list. Cached per text
  + categories.

A suggestion is never applied silently over your edits. Creating the project is a separate,
confirmed step that shows the category, the folder and a preview of `brief.md`:

```
<Projects folder>/<YYYY-MM-DD>_<slug>/
  brief.md        title, category, tags, dates, idea text, screenshot text, brief footer
  script.md       stub: hook, setup, main points, payoff, call to action
  assets/         idea-screenshot.<ext> when the idea came from an image
  thumbnails/     the thumbnail tester's file picker opens here for this project
```

Scaffolding never writes into an existing folder (a name clash gets `-2`) and never
overwrites a file. The project also appears in the thumbnail tester and on Home. Categories
come from a preset (Default, or Groovy Gains with its brief CTA footer) and are editable under
Idea settings. Ideas are archived, never deleted.

To regenerate the test screenshot, run `node scripts/make-idea-fixtures.mjs`.

## Everyday use

- **First run** asks for a preset pack (Default or Groovy Gains: naming preset, idea
  categories, brief footer), your media folder (optionally creating the pack's starter folders;
  only missing ones are made), a Projects folder, the default thumbnail platform and, optionally,
  an API key. Every step can be skipped; run it again from Settings.
- **Settings** holds everything in one place: media folder, default naming preset and your own
  presets (validated: `{version}` is required so clashes bump instead of overwriting; no path
  characters), default platform and scoring weights, Projects folder and categories, the API key.
- **Search** (`Ctrl+K`, or Search… in the sidebar) finds indexed files (by name, folder or tag),
  clip sections, projects and ideas, and opens the exact item: a file is highlighted in the
  library, a section opens its clip, a project opens in the thumbnail tester.
- **Shortcuts:** `Ctrl+1`–`4` switch modules, `Ctrl+,` opens Settings, `Ctrl+Shift+N` captures an
  idea, `/` searches ideas, `?` lists them all, `Esc` closes dialogs (`⌘` on macOS).
- **Project summary** (Home, thumbnail tester, or a converted idea): a Markdown page with the
  project, its idea, the thumbnail scores per dimension, the winner and why it leads, and the AI
  critique if one was run. Copy it, or save it where you choose (the system dialog asks before
  replacing a file).
