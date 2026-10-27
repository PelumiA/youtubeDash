mod db;
mod fsops;
mod scan;

use rusqlite::Connection;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};

struct AppState {
    db: Mutex<Connection>,
}

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Drop trailing separators so prefix matching in SQL is consistent (`C:\media\` → `C:\media`),
/// but keep drive roots like `C:\` intact.
fn normalize_root(root: &str) -> String {
    let trimmed = root.trim_end_matches(['\\', '/']);
    if trimmed.is_empty() || trimmed.ends_with(':') {
        root.to_string()
    } else {
        trimmed.to_string()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResponse {
    root: String,
    files: Vec<db::MediaRow>,
    truncated: bool,
    skipped: usize,
    ffprobe_available: bool,
    elapsed_ms: u128,
}

#[tauri::command]
async fn scan_folder(state: State<'_, AppState>, root: String) -> CmdResult<ScanResponse> {
    let root = normalize_root(&root);
    let path = PathBuf::from(&root);
    let out = tauri::async_runtime::spawn_blocking(move || scan::scan_dir(&path, scan::MAX_SCAN_FILES))
        .await
        .map_err(err)?
        .map_err(err)?;
    let mut conn = state.db.lock().map_err(err)?;
    let files = db::sync_scan(&mut conn, &root, &out.files).map_err(err)?;
    Ok(ScanResponse {
        root,
        files,
        truncated: out.truncated,
        skipped: out.skipped,
        ffprobe_available: scan::ffprobe_available(),
        elapsed_ms: out.elapsed_ms,
    })
}

#[tauri::command]
fn list_inventory(state: State<'_, AppState>, root: String) -> CmdResult<Vec<db::MediaRow>> {
    let conn = state.db.lock().map_err(err)?;
    db::list_under(&conn, &normalize_root(&root)).map_err(err)
}

/// Current file names in each folder, so the dry-run planner can avoid collisions.
/// Folders that don't exist yet report no names.
#[tauri::command]
fn list_dir_names(dirs: Vec<String>) -> CmdResult<HashMap<String, Vec<String>>> {
    Ok(dirs
        .into_iter()
        .map(|d| {
            let names = std::fs::read_dir(&d)
                .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).collect())
                .unwrap_or_default();
            (d, names)
        })
        .collect())
}

#[tauri::command]
fn apply_moves(state: State<'_, AppState>, ops: Vec<fsops::MoveOp>) -> CmdResult<String> {
    let mut conn = state.db.lock().map_err(err)?;
    fsops::apply(&mut conn, &ops, "rename")
}

#[tauri::command]
fn undo_batch(state: State<'_, AppState>, batch_id: String) -> CmdResult<usize> {
    let mut conn = state.db.lock().map_err(err)?;
    fsops::undo(&mut conn, &batch_id)
}

#[tauri::command]
fn list_batches(state: State<'_, AppState>) -> CmdResult<Vec<db::BatchSummary>> {
    let conn = state.db.lock().map_err(err)?;
    db::list_batches(&conn, 50).map_err(err)
}

#[tauri::command]
fn set_tags(state: State<'_, AppState>, file_id: i64, tags: Vec<String>) -> CmdResult<()> {
    let conn = state.db.lock().map_err(err)?;
    db::set_tags(&conn, file_id, &tags).map_err(err)
}

/// Archive destinations for a set of files, for the confirmation preview.
#[tauri::command]
fn preview_archive(root: String, paths: Vec<String>) -> CmdResult<Vec<String>> {
    let root = PathBuf::from(normalize_root(&root));
    let stamp = fsops::archive_stamp();
    paths
        .iter()
        .map(|p| fsops::archive_target(&root, Path::new(p), &stamp).map(|t| t.to_string_lossy().to_string()))
        .collect()
}

#[tauri::command]
fn archive_files(state: State<'_, AppState>, root: String, file_ids: Vec<i64>) -> CmdResult<String> {
    let mut conn = state.db.lock().map_err(err)?;
    let rows = db::get_media(&conn, &file_ids).map_err(err)?;
    let files: Vec<(i64, String)> = rows.into_iter().map(|r| (r.id, r.path)).collect();
    fsops::archive(&mut conn, Path::new(&normalize_root(&root)), &files)
}

/// Duplicate groups under `root`: fingerprint matches confirmed by a full content hash.
/// Review only — nothing is removed unless the user archives it.
#[tauri::command]
async fn find_duplicates(state: State<'_, AppState>, root: String) -> CmdResult<Vec<Vec<db::MediaRow>>> {
    let rows = {
        let conn = state.db.lock().map_err(err)?;
        db::list_under(&conn, &normalize_root(&root)).map_err(err)?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut by_fp: BTreeMap<String, Vec<db::MediaRow>> = BTreeMap::new();
        for r in rows {
            by_fp.entry(r.file_hash.clone()).or_default().push(r);
        }
        let mut groups = Vec::new();
        for (_, candidates) in by_fp.into_iter().filter(|(_, v)| v.len() > 1) {
            let mut by_full: BTreeMap<String, Vec<db::MediaRow>> = BTreeMap::new();
            for r in candidates {
                if let Ok(h) = scan::full_hash(Path::new(&r.path)) {
                    by_full.entry(h).or_default().push(r);
                }
            }
            groups.extend(by_full.into_values().filter(|v| v.len() > 1));
        }
        groups
    })
    .await
    .map_err(err)
}

#[tauri::command]
fn dashboard_summary(state: State<'_, AppState>) -> CmdResult<db::DashboardSummary> {
    let conn = state.db.lock().map_err(err)?;
    db::dashboard_summary(&conn).map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = db::open(&dir.join("creator-dashboard.db"))?;
            app.manage(AppState { db: Mutex::new(conn) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            list_inventory,
            list_dir_names,
            apply_moves,
            undo_batch,
            list_batches,
            set_tags,
            preview_archive,
            archive_files,
            find_duplicates,
            dashboard_summary,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
