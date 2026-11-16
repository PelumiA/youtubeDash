//! Long-clip sections: cut-point detection (ffmpeg silencedetect / scene change), section
//! storage, and export. The source clip is only ever read; exports are new files written to
//! `<root>/_sections/<clip>/` via a temp name, and never overwrite anything.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::fsops::{self, MoveOp};
use crate::scan::SECTIONS_DIR;
use crate::tools;

/// A start this close to a keyframe can be stream-copied without losing frames.
pub const KEYFRAME_TOLERANCE_S: f64 = 0.05;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: Option<i64>,
    pub media_file_id: i64,
    pub start_s: f64,
    pub end_s: f64,
    pub label: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub exported_path: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub start_s: f64,
    pub end_s: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutAnalysis {
    pub silences: Vec<Span>,
    pub scenes: Vec<f64>,
    /// Suggested cut points (middle of each silence). Suggestions only: the user confirms.
    pub suggestions: Vec<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ExportMode {
    /// Stream copy: no re-encode, no quality loss. Used when the start sits on a keyframe.
    Copy,
    /// Frame-accurate re-encode (H.264/AAC in .mp4) for starts between keyframes.
    Encode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub section_id: i64,
    pub path: Option<String>,
    pub mode: Option<ExportMode>,
    pub error: Option<String>,
}

// ---------- storage ----------

fn row(r: &rusqlite::Row) -> rusqlite::Result<Section> {
    let tags: String = r.get(6)?;
    Ok(Section {
        id: r.get(0)?,
        media_file_id: r.get(1)?,
        start_s: r.get(2)?,
        end_s: r.get(3)?,
        label: r.get(4)?,
        notes: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        exported_path: r.get(7)?,
    })
}

const COLUMNS: &str = "id, media_file_id, start_s, end_s, label, notes, tags, exported_path";

pub fn list(conn: &Connection, media_file_id: i64) -> rusqlite::Result<Vec<Section>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM clip_sections WHERE media_file_id = ?1 ORDER BY start_s, id"))?;
    let rows = stmt.query_map(params![media_file_id], row)?;
    rows.collect()
}

pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Option<Section>> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM clip_sections WHERE id = ?1"), params![id], row).optional()
}

pub fn counts_under(conn: &Connection, root: &str) -> rusqlite::Result<Vec<(i64, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT s.media_file_id, COUNT(*) FROM clip_sections s JOIN media_files m ON m.id = s.media_file_id
         WHERE m.path = ?1 OR substr(m.path, 1, length(?1) + 1) IN (?1 || '\\', ?1 || '/')
         GROUP BY s.media_file_id",
    )?;
    let rows = stmt.query_map(params![root], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

pub fn save(conn: &Connection, s: &Section) -> Result<Section, String> {
    if !(s.start_s.is_finite() && s.end_s.is_finite()) || s.start_s < 0.0 || s.end_s <= s.start_s {
        return Err(format!("A section must end after it starts ({:.2}s → {:.2}s).", s.start_s, s.end_s));
    }
    let label = if s.label.trim().is_empty() { "Untitled".to_string() } else { s.label.trim().to_string() };
    let tags = serde_json::to_string(&s.tags).expect("tags serialize");
    let id = match s.id {
        Some(id) => {
            conn.execute(
                "UPDATE clip_sections SET start_s = ?1, end_s = ?2, label = ?3, notes = ?4, tags = ?5 WHERE id = ?6",
                params![s.start_s, s.end_s, label, s.notes, tags, id],
            )
            .map_err(|e| e.to_string())?;
            id
        }
        None => {
            conn.execute(
                "INSERT INTO clip_sections (media_file_id, start_s, end_s, label, notes, tags) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![s.media_file_id, s.start_s, s.end_s, label, s.notes, tags],
            )
            .map_err(|e| e.to_string())?;
            conn.last_insert_rowid()
        }
    };
    get(conn, id).map_err(|e| e.to_string())?.ok_or_else(|| "Section vanished after save.".into())
}

/// Moves a section's previous export into `_archive/` (undoable). Never touches the source clip.
pub fn archive_export(conn: &mut Connection, root: &Path, s: &Section) -> Result<Option<String>, String> {
    let Some(exported) = s.exported_path.as_deref().map(PathBuf::from).filter(|p| p.is_file()) else {
        return Ok(None);
    };
    let target = fsops::archive_target(root, &exported, &fsops::archive_stamp())?;
    let op = MoveOp { file_id: None, old_path: exported.to_string_lossy().to_string(), new_path: target.to_string_lossy().to_string() };
    fsops::apply(conn, &[op], "archive").map(Some)
}

/// Deletes a section. Its export (if any) is archived, not deleted; the source is untouched.
pub fn delete(conn: &mut Connection, root: &Path, id: i64) -> Result<Option<String>, String> {
    let s = get(conn, id).map_err(|e| e.to_string())?.ok_or("Section not found.")?;
    let batch = archive_export(conn, root, &s)?;
    conn.execute("DELETE FROM clip_sections WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    Ok(batch)
}

pub fn set_exported(conn: &Connection, id: i64, path: Option<&str>) -> rusqlite::Result<()> {
    conn.execute("UPDATE clip_sections SET exported_path = ?1 WHERE id = ?2", params![path, id])?;
    Ok(())
}

// ---------- detection ----------

fn ffmpeg() -> Result<&'static Path, String> {
    let hint = if cfg!(windows) { "winget install Gyan.FFmpeg" } else if cfg!(target_os = "macos") { "brew install ffmpeg" } else { "your package manager" };
    tools::ffmpeg().ok_or_else(|| format!("ffmpeg was not found. Install it ({hint}) and restart the app."))
}

fn ffprobe() -> Result<&'static Path, String> {
    tools::ffprobe().ok_or_else(|| "ffprobe was not found. Install ffmpeg and restart the app.".into())
}

/// Runs ffmpeg for analysis and returns its stderr (where filters log their findings).
fn run_analysis(input_opts: &[&str], input: &Path, output_opts: &[&str]) -> Result<String, String> {
    let out = tools::command(ffmpeg()?)
        .args(["-hide_banner", "-nostdin", "-nostats"])
        .args(input_opts)
        .arg("-i")
        .arg(input)
        .args(output_opts)
        .args(["-f", "null", "-"])
        .output()
        .map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if !out.status.success() {
        return Err(format!("ffmpeg failed: {}", stderr.lines().last().unwrap_or("unknown error")));
    }
    Ok(stderr)
}

fn number_after(line: &str, key: &str) -> Option<f64> {
    let rest = &line[line.find(key)? + key.len()..];
    let token: String = rest.trim_start().chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-').collect();
    token.parse().ok()
}

pub fn parse_silences(stderr: &str) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut open: Option<f64> = None;
    for line in stderr.lines().filter(|l| l.contains("silencedetect")) {
        if let Some(t) = number_after(line, "silence_start:") {
            open = Some(t.max(0.0));
        } else if let (Some(start), Some(end)) = (open, number_after(line, "silence_end:")) {
            spans.push(Span { start_s: start, end_s: end });
            open = None;
        }
    }
    spans
}

pub fn detect_silence(path: &Path, noise_db: f64, min_silence_s: f64) -> Result<Vec<Span>, String> {
    let filter = format!("silencedetect=noise={noise_db}dB:d={min_silence_s}");
    let stderr = run_analysis(&[], path, &["-vn", "-af", &filter])?;
    Ok(parse_silences(&stderr))
}

pub fn parse_scenes(stderr: &str) -> Vec<f64> {
    stderr.lines().filter(|l| l.contains("showinfo")).filter_map(|l| number_after(l, "pts_time:")).collect()
}

/// Scene changes, compared on keyframes only (fast on long clips, and keyframes are the
/// points that stream-copy cleanly anyway).
pub fn detect_scenes(path: &Path, threshold: f64) -> Result<Vec<f64>, String> {
    let filter = format!("scale=160:-2,select='gt(scene,{threshold})',showinfo");
    let stderr = run_analysis(&["-skip_frame", "nokey"], path, &["-an", "-vf", &filter])?;
    Ok(parse_scenes(&stderr))
}

/// Middle of each silence, skipping cuts too close to the start or to the previous cut.
pub fn suggest_cuts(silences: &[Span], min_gap_s: f64) -> Vec<f64> {
    let mut cuts: Vec<f64> = Vec::new();
    for s in silences {
        let mid = ((s.start_s + s.end_s) / 2.0 * 100.0).round() / 100.0;
        if mid < min_gap_s || cuts.last().is_some_and(|last| mid - last < min_gap_s) {
            continue;
        }
        cuts.push(mid);
    }
    cuts
}

pub fn analyze(path: &Path, noise_db: f64, min_silence_s: f64, scenes: bool, scene_threshold: f64) -> Result<CutAnalysis, String> {
    let (has_video, has_audio) = stream_types(path)?;
    let silences = if has_audio { detect_silence(path, noise_db, min_silence_s)? } else { Vec::new() };
    let scenes = if scenes && has_video { detect_scenes(path, scene_threshold)? } else { Vec::new() };
    let suggestions = suggest_cuts(&silences, 5.0);
    Ok(CutAnalysis { silences, scenes, suggestions })
}

/// (has video, has audio) — cover-art "video" streams in audio files don't count.
pub fn stream_types(path: &Path) -> Result<(bool, bool), String> {
    let out = tools::command(ffprobe()?)
        .args(["-v", "error", "-show_entries", "stream=codec_type:stream_disposition=attached_pic", "-of", "csv=p=0"])
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let video = text.lines().any(|l| l.starts_with("video") && !l.ends_with(",1"));
    let audio = text.lines().any(|l| l.starts_with("audio"));
    Ok((video, audio))
}

/// Keyframe timestamps of the first video stream, read from packet flags (no decoding).
pub fn keyframes(path: &Path) -> Result<Vec<f64>, String> {
    let out = tools::command(ffprobe()?)
        .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0"])
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    let mut keys: Vec<f64> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let (t, flags) = l.split_once(',')?;
            flags.contains('K').then(|| t.trim().parse().ok()).flatten()
        })
        .collect();
    keys.sort_by(|a, b| a.total_cmp(b));
    keys.dedup();
    Ok(keys)
}

// ---------- export ----------

fn slug(label: &str) -> String {
    let s: String = label
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if s.is_empty() { "section".into() } else { s.chars().take(60).collect() }
}

pub fn export_dir(root: &Path, source: &Path) -> PathBuf {
    let stem = source.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "clip".into());
    root.join(SECTIONS_DIR).join(stem)
}

fn free_name(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{base}.{ext}"));
    if !first.exists() {
        return first;
    }
    (2..).map(|n| dir.join(format!("{base}-{n}.{ext}"))).find(|p| !p.exists()).expect("unbounded")
}

pub fn choose_mode(start_s: f64, has_video: bool, keyframes: &[f64]) -> ExportMode {
    if !has_video || keyframes.iter().any(|k| (k - start_s).abs() <= KEYFRAME_TOLERANCE_S) {
        ExportMode::Copy
    } else {
        ExportMode::Encode
    }
}

/// Exports one section next to its siblings. Writes to a temp name first so a failed or
/// interrupted export never leaves a half-written file under the final name.
pub fn export_one(source: &Path, s: &Section, index: usize, out_dir: &Path, has_video: bool, keyframes: &[f64]) -> Result<(PathBuf, ExportMode), String> {
    if !source.is_file() {
        return Err(format!("Source clip is missing: {}", source.display()));
    }
    std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    let mode = choose_mode(s.start_s, has_video, keyframes);
    let src_ext = source.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_else(|| "mp4".into());
    let ext = match mode {
        ExportMode::Copy => src_ext,
        ExportMode::Encode => "mp4".into(),
    };
    let final_path = free_name(out_dir, &format!("{:02}_{}", index + 1, slug(&s.label)), &ext);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let tmp = out_dir.join(format!(".cdtmp-export-{nanos:x}.{ext}"));

    let start = format!("{:.3}", s.start_s);
    let duration = format!("{:.3}", s.end_s - s.start_s);
    let mut cmd = tools::command(ffmpeg()?);
    cmd.args(["-hide_banner", "-nostdin", "-loglevel", "error", "-n", "-ss", &start]).arg("-i").arg(source);
    cmd.args(["-t", &duration, "-map", "0:v:0?", "-map", "0:a?", "-map_metadata", "0"]);
    match mode {
        ExportMode::Copy => cmd.args(["-c", "copy", "-avoid_negative_ts", "make_zero"]),
        ExportMode::Encode => cmd.args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]),
    };
    let out = cmd.arg(&tmp).output().map_err(|e| e.to_string())?;
    if !out.status.success() || !tmp.is_file() {
        let _ = std::fs::remove_file(&tmp); // our own partial temp file, never user data
        return Err(format!("ffmpeg export failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    if final_path.exists() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Refusing to overwrite {}", final_path.display()));
    }
    std::fs::rename(&tmp, &final_path).map_err(|e| e.to_string())?;
    Ok((final_path, mode))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, scan};
    use std::process::Command;

    #[test]
    fn parses_silencedetect_output() {
        let stderr = "\
[silencedetect @ 0x1] silence_start: 289.987
[silencedetect @ 0x1] silence_end: 300.01 | silence_duration: 10.02
noise
[silencedetect @ 0x1] silence_start: -0.002
[silencedetect @ 0x1] silence_end: 1.5 | silence_duration: 1.5
[silencedetect @ 0x1] silence_start: 1790";
        assert_eq!(
            parse_silences(stderr),
            vec![Span { start_s: 289.987, end_s: 300.01 }, Span { start_s: 0.0, end_s: 1.5 }]
        );
    }

    #[test]
    fn parses_showinfo_output() {
        let stderr = "[Parsed_showinfo_2 @ 0x1] n:   0 pts:  1000 pts_time:10.5    duration: 1\n[Parsed_showinfo_2 @ 0x1] n:   1 pts: 2000 pts_time:42 pos: 5";
        assert_eq!(parse_scenes(stderr), vec![10.5, 42.0]);
    }

    #[test]
    fn suggestions_skip_start_and_close_cuts() {
        let spans = [
            Span { start_s: 0.0, end_s: 1.0 },
            Span { start_s: 10.0, end_s: 12.0 },
            Span { start_s: 13.0, end_s: 14.0 },
            Span { start_s: 60.0, end_s: 61.0 },
        ];
        assert_eq!(suggest_cuts(&spans, 5.0), vec![11.0, 60.5]);
    }

    #[test]
    fn mode_and_slug() {
        assert_eq!(choose_mode(10.0, true, &[0.0, 10.02]), ExportMode::Copy);
        assert_eq!(choose_mode(11.0, true, &[0.0, 10.0]), ExportMode::Encode);
        assert_eq!(choose_mode(11.0, false, &[]), ExportMode::Copy);
        assert_eq!(slug("Hook: Why squats?!"), "hook-why-squats");
        assert_eq!(slug("🔥"), "section");
    }

    #[test]
    fn rejects_inverted_sections() {
        let c = Connection::open_in_memory().unwrap();
        db::migrate(&c).unwrap();
        let s = Section { id: None, media_file_id: 1, start_s: 5.0, end_s: 5.0, label: "x".into(), tags: vec![], notes: String::new(), exported_path: None };
        assert!(save(&c, &s).is_err());
    }

    fn probe_duration(p: &Path) -> f64 {
        let out = tools::command(tools::ffprobe().unwrap())
            .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
            .arg(p)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
    }

    /// The Phase 1 section test: a generated 30-minute clip with a 10 s silence every 5 min
    /// and a keyframe every 10 s. Silence detection finds the gaps, marked ranges export
    /// (stream copy when aligned, re-encode otherwise) to the right lengths, and the source
    /// stays byte-identical.
    #[test]
    fn long_clip_sections_end_to_end() {
        let Some(ffmpeg) = tools::ffmpeg() else {
            eprintln!("SKIPPED: ffmpeg not found");
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let clip = root.join("long take.mp4");
        let status = Command::new(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=5", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000"])
            .args(["-t", "1800", "-af", "volume=enable='between(mod(t,300),290,300)':volume=0"])
            .args(["-c:v", "libx264", "-preset", "ultrafast", "-g", "50", "-keyint_min", "50", "-sc_threshold", "0", "-c:a", "aac", "-shortest"])
            .arg(&clip)
            .status()
            .unwrap();
        assert!(status.success());
        let source_hash = scan::full_hash(&clip).unwrap();

        let analysis = analyze(&clip, -35.0, 2.0, false, 0.4).unwrap();
        // The last gap runs into end-of-stream; some ffmpeg builds don't close it.
        assert!(matches!(analysis.silences.len(), 5 | 6), "{:?}", analysis.silences);
        for (i, s) in analysis.silences.iter().enumerate() {
            let expected = 290.0 + 300.0 * i as f64;
            assert!((s.start_s - expected).abs() < 0.5, "silence {i} starts at {}", s.start_s);
        }
        assert!((analysis.suggestions[0] - 295.0).abs() < 0.5);

        let keys = keyframes(&clip).unwrap();
        assert!(keys.iter().any(|k| (k - 300.0).abs() < 0.01), "keyframe at 300s");

        let (has_video, _) = stream_types(&clip).unwrap();
        let out_dir = export_dir(root, &clip);
        let mk = |start_s: f64, end_s: f64, label: &str| Section { id: Some(1), media_file_id: 1, start_s, end_s, label: label.into(), tags: vec![], notes: String::new(), exported_path: None };
        // Manual markers on keyframes → stream copy.
        let (a, mode_a) = export_one(&clip, &mk(300.0, 600.0, "Teaching point"), 0, &out_dir, has_video, &keys).unwrap();
        // Off-keyframe start → frame-accurate re-encode.
        let (b, mode_b) = export_one(&clip, &mk(123.4, 135.0, "Hook"), 1, &out_dir, has_video, &keys).unwrap();
        assert_eq!(mode_a, ExportMode::Copy);
        assert_eq!(mode_b, ExportMode::Encode);
        assert!(a.ends_with("_sections/long take/01_teaching-point.mp4") || a.ends_with("_sections\\long take\\01_teaching-point.mp4"));
        assert!((probe_duration(&a) - 300.0).abs() < 0.5, "copy export length {}", probe_duration(&a));
        assert!((probe_duration(&b) - 11.6).abs() < 0.3, "encode export length {}", probe_duration(&b));

        // Exporting the same label again never overwrites.
        let (a2, _) = export_one(&clip, &mk(300.0, 600.0, "Teaching point"), 0, &out_dir, has_video, &keys).unwrap();
        assert_ne!(a, a2);

        assert_eq!(scan::full_hash(&clip).unwrap(), source_hash, "source is byte-identical");
        // Exports are hidden from the library scan; only the source is listed.
        let listed = scan::scan_dir(root, scan::MAX_SCAN_FILES).unwrap();
        assert_eq!(listed.files.len(), 1);
    }

    #[test]
    fn deleting_a_section_archives_its_export_and_keeps_the_source() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let clip = root.join("clip.mp4");
        std::fs::write(&clip, b"source bytes").unwrap();
        let export = export_dir(root, &clip).join("01_hook.mp4");
        std::fs::create_dir_all(export.parent().unwrap()).unwrap();
        std::fs::write(&export, b"export bytes").unwrap();

        let mut c = Connection::open_in_memory().unwrap();
        db::migrate(&c).unwrap();
        let out = scan::scan_dir(root, 100).unwrap();
        let rows = db::sync_scan(&mut c, &root.to_string_lossy(), &out.files).unwrap();
        let saved = save(&c, &Section { id: None, media_file_id: rows[0].id, start_s: 0.0, end_s: 5.0, label: "Hook".into(), tags: vec!["hook".into()], notes: String::new(), exported_path: None }).unwrap();
        set_exported(&c, saved.id.unwrap(), Some(&export.to_string_lossy())).unwrap();

        let batch = delete(&mut c, root, saved.id.unwrap()).unwrap();
        assert!(batch.is_some());
        assert!(!export.exists());
        assert_eq!(std::fs::read(&clip).unwrap(), b"source bytes");
        assert!(list(&c, rows[0].id).unwrap().is_empty());
        // The export went to the archive and can be brought back.
        fsops::undo(&mut c, &batch.unwrap()).unwrap();
        assert_eq!(std::fs::read(&export).unwrap(), b"export bytes");
    }
}
