//! Folder scan: walks a root, inventories media files and reads cheap metadata.
//! Read-only — nothing in this module writes to the user's folders.

use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};
use walkdir::WalkDir;

use crate::tools;

/// Folders the scanner never descends into: our own archive and hidden/system folders.
pub const ARCHIVE_DIR: &str = "_archive";
/// Where section exports land; skipped by the scanner so exports show under their source clip.
pub const SECTIONS_DIR: &str = "_sections";
pub const MAX_SCAN_FILES: usize = 10_000;
const FINGERPRINT_CHUNK: u64 = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedFile {
    pub path: String,
    pub dir: String,
    pub filename: String,
    pub ext: String,
    pub kind: String,
    pub size_bytes: u64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_s: Option<f64>,
    pub created_at: Option<String>,
    pub captured_date: String,
    pub file_hash: String,
}

pub struct ScanOutput {
    pub files: Vec<ScannedFile>,
    pub truncated: bool,
    pub skipped: usize,
    pub elapsed_ms: u128,
}

pub fn kind_for_ext(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "mp4" | "mov" | "m4v" | "mkv" | "avi" | "webm" | "mts" | "m2ts" | "wmv" => Some("video"),
        "jpg" | "jpeg" | "png" | "heic" | "heif" | "webp" | "gif" | "tif" | "tiff" | "bmp" | "dng" | "cr2"
        | "cr3" | "nef" | "arw" => Some("photo"),
        "mp3" | "wav" | "m4a" | "aac" | "flac" | "ogg" | "aif" | "aiff" | "opus" => Some("audio"),
        _ => None,
    }
}

fn is_skipped_dir(name: &str) -> bool {
    name == ARCHIVE_DIR || name == SECTIONS_DIR || name.starts_with('.') || name == "$RECYCLE.BIN" || name == "node_modules"
}

/// Walks `root` and inventories media files, reading metadata on all cores.
pub fn scan_dir(root: &Path, limit: usize) -> std::io::Result<ScanOutput> {
    let started = Instant::now();
    if !root.is_dir() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "not a folder"));
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut skipped = 0usize;
    let mut truncated = false;
    let walker = WalkDir::new(root).follow_links(false).into_iter().filter_entry(|e| {
        e.depth() == 0 || !(e.file_type().is_dir() && is_skipped_dir(&e.file_name().to_string_lossy()))
    });
    for entry in walker {
        let Ok(entry) = entry else {
            skipped += 1;
            continue;
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        // Our own in-flight temp names from an interrupted apply.
        if name.starts_with(".cdtmp-") {
            continue;
        }
        let ext = entry.path().extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
        if kind_for_ext(&ext).is_none() {
            continue;
        }
        if candidates.len() >= limit {
            truncated = true;
            break;
        }
        candidates.push(entry.into_path());
    }

    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(16);
    let chunk = candidates.len().div_ceil(threads).max(1);
    let mut files: Vec<ScannedFile> = Vec::with_capacity(candidates.len());
    let mut failed = 0usize;
    std::thread::scope(|s| {
        let handles: Vec<_> = candidates
            .chunks(chunk)
            .map(|paths| s.spawn(move || paths.iter().map(|p| inspect(p)).collect::<Vec<_>>()))
            .collect();
        for h in handles {
            for r in h.join().expect("scan worker panicked") {
                match r {
                    Ok(f) => files.push(f),
                    Err(_) => failed += 1,
                }
            }
        }
    });
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(ScanOutput { files, truncated, skipped: skipped + failed, elapsed_ms: started.elapsed().as_millis() })
}

/// Reads one file's metadata. Never modifies the file.
pub fn inspect(path: &Path) -> std::io::Result<ScannedFile> {
    let meta = std::fs::metadata(path)?;
    let ext = path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
    let kind = kind_for_ext(&ext).unwrap_or("video");
    let created: Option<SystemTime> = meta.created().ok().or_else(|| meta.modified().ok());
    let created_local = created.map(chrono::DateTime::<chrono::Local>::from);

    let mut width = None;
    let mut height = None;
    let mut duration_s = None;
    let mut captured: Option<String> = None;
    match kind {
        "photo" => {
            if let Ok(size) = imagesize::size(path) {
                width = Some(size.width as i64);
                height = Some(size.height as i64);
            }
            captured = exif_date(path);
        }
        _ => {
            if let Some(probe) = ffprobe(path) {
                width = probe.width;
                height = probe.height;
                duration_s = probe.duration_s;
                captured = probe.creation_date;
            }
        }
    }
    let captured_date = captured
        .or_else(|| created_local.map(|d| d.format("%Y-%m-%d").to_string()))
        .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());

    Ok(ScannedFile {
        path: path.to_string_lossy().to_string(),
        dir: path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        filename: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        ext,
        kind: kind.to_string(),
        size_bytes: meta.len(),
        width,
        height,
        duration_s,
        created_at: created_local.map(|d| d.to_rfc3339()),
        captured_date,
        file_hash: fingerprint(path, meta.len())?,
    })
}

/// Fast fingerprint: size + first and last 64 KiB. Good enough to find duplicate *candidates*
/// in multi-GB video folders without reading everything; `full_hash` confirms them.
pub fn fingerprint(path: &Path, len: u64) -> std::io::Result<String> {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&len.to_le_bytes());
    let mut f = File::open(path)?;
    let mut buf = vec![0u8; FINGERPRINT_CHUNK as usize];
    let n = read_up_to(&mut f, &mut buf)?;
    hasher.update(&buf[..n]);
    if len > 2 * FINGERPRINT_CHUNK {
        f.seek(SeekFrom::End(-(FINGERPRINT_CHUNK as i64)))?;
        let n = read_up_to(&mut f, &mut buf)?;
        hasher.update(&buf[..n]);
    }
    Ok(format!("fp:{}", hasher.finalize().to_hex()))
}

pub fn full_hash(path: &Path) -> std::io::Result<String> {
    let mut hasher = blake3::Hasher::new();
    let mut reader = BufReader::with_capacity(1 << 20, File::open(path)?);
    std::io::copy(&mut reader, &mut hasher)?;
    Ok(hasher.finalize().to_hex().to_string())
}

fn read_up_to(f: &mut File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut total = 0;
    while total < buf.len() {
        match f.read(&mut buf[total..])? {
            0 => break,
            n => total += n,
        }
    }
    Ok(total)
}

fn exif_date(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let exif = exif::Reader::new().read_from_container(&mut BufReader::new(file)).ok()?;
    let field = exif
        .get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)
        .or_else(|| exif.get_field(exif::Tag::DateTime, exif::In::PRIMARY))?;
    // EXIF format is "YYYY:MM:DD HH:MM:SS".
    let raw = field.display_value().to_string();
    let date = raw.get(0..10)?.replace(':', "-");
    chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").ok().map(|d| d.to_string())
}

struct Probe {
    width: Option<i64>,
    height: Option<i64>,
    duration_s: Option<f64>,
    creation_date: Option<String>,
}

pub fn ffprobe_available() -> bool {
    tools::ffprobe().is_some()
}

/// Video/audio metadata via ffprobe when it is on PATH. Optional: without it, files still
/// scan and sort, just without duration/resolution.
fn ffprobe(path: &Path) -> Option<Probe> {
    let out = tools::command(tools::ffprobe()?)
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let video = json["streams"].as_array()?.iter().find(|s| s["codec_type"] == "video");
    let (mut width, mut height) = (video.and_then(|v| v["width"].as_i64()), video.and_then(|v| v["height"].as_i64()));
    // Phones store portrait video as landscape + a rotation tag.
    let rotation = video
        .and_then(|v| v["tags"]["rotate"].as_str().and_then(|r| r.parse::<i64>().ok()))
        .or_else(|| {
            video.and_then(|v| v["side_data_list"].as_array()).and_then(|l| l.iter().find_map(|d| d["rotation"].as_i64()))
        })
        .unwrap_or(0);
    if rotation.abs() % 180 == 90 {
        std::mem::swap(&mut width, &mut height);
    }
    let duration_s = json["format"]["duration"].as_str().and_then(|d| d.parse().ok());
    let creation_date = json["format"]["tags"]["creation_time"]
        .as_str()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string());
    Some(Probe { width, height, duration_s, creation_date })
}
