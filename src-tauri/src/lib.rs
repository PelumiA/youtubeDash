mod ai;
mod db;
mod fsops;
mod ideas;
mod scan;
mod sections;
mod thumbs;
mod tools;

use rusqlite::Connection;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

struct AppState {
    db: Mutex<Connection>,
    /// App-owned copies of captured idea screenshots.
    idea_images: PathBuf,
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
async fn scan_folder(app: AppHandle, state: State<'_, AppState>, root: String) -> CmdResult<ScanResponse> {
    let root = normalize_root(&root);
    let path = PathBuf::from(&root);
    // Let the webview play media from this folder (and only folders the user has scanned).
    app.asset_protocol_scope().allow_directory(&path, true).map_err(err)?;
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
fn list_sections(state: State<'_, AppState>, media_file_id: i64) -> CmdResult<Vec<sections::Section>> {
    let conn = state.db.lock().map_err(err)?;
    sections::list(&conn, media_file_id).map_err(err)
}

#[tauri::command]
fn section_counts(state: State<'_, AppState>, root: String) -> CmdResult<HashMap<i64, i64>> {
    let conn = state.db.lock().map_err(err)?;
    Ok(sections::counts_under(&conn, &normalize_root(&root)).map_err(err)?.into_iter().collect())
}

#[tauri::command]
fn save_section(state: State<'_, AppState>, section: sections::Section) -> CmdResult<sections::Section> {
    let conn = state.db.lock().map_err(err)?;
    sections::save(&conn, &section)
}

/// Removes the section; its export (if any) is archived, never deleted. Returns the archive batch.
#[tauri::command]
fn delete_section(state: State<'_, AppState>, root: String, section_id: i64) -> CmdResult<Option<String>> {
    let mut conn = state.db.lock().map_err(err)?;
    sections::delete(&mut conn, Path::new(&normalize_root(&root)), section_id)
}

#[tauri::command]
async fn analyze_clip(path: String, noise_db: f64, min_silence_s: f64, scenes: bool, scene_threshold: f64) -> CmdResult<sections::CutAnalysis> {
    tauri::async_runtime::spawn_blocking(move || sections::analyze(Path::new(&path), noise_db, min_silence_s, scenes, scene_threshold))
        .await
        .map_err(err)?
}

#[tauri::command]
async fn clip_keyframes(path: String) -> CmdResult<Vec<f64>> {
    tauri::async_runtime::spawn_blocking(move || sections::keyframes(Path::new(&path))).await.map_err(err)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolStatus {
    ffmpeg: Option<String>,
    ffprobe: Option<String>,
}

#[tauri::command]
fn tool_status() -> ToolStatus {
    ToolStatus {
        ffmpeg: tools::ffmpeg().map(|p| p.to_string_lossy().to_string()),
        ffprobe: tools::ffprobe().map(|p| p.to_string_lossy().to_string()),
    }
}

/// Exports sections as separate files into `<root>/_sections/<clip>/`. A section that was
/// exported before has its previous file archived first. The source clip is only read.
#[tauri::command]
async fn export_sections(state: State<'_, AppState>, root: String, media_file_id: i64, section_ids: Vec<i64>) -> CmdResult<Vec<sections::ExportResult>> {
    let root = PathBuf::from(normalize_root(&root));
    let (source, all, chosen) = {
        let mut conn = state.db.lock().map_err(err)?;
        let media = db::get_media(&conn, &[media_file_id]).map_err(err)?.pop().ok_or("Clip not found.")?;
        let all = sections::list(&conn, media_file_id).map_err(err)?;
        let chosen: Vec<sections::Section> = all.iter().filter(|s| s.id.is_some_and(|id| section_ids.contains(&id))).cloned().collect();
        for s in &chosen {
            sections::archive_export(&mut conn, &root, s)?;
            sections::set_exported(&conn, s.id.unwrap(), None).map_err(err)?;
        }
        (PathBuf::from(media.path), all, chosen)
    };
    let out_dir = sections::export_dir(&root, &source);
    let results = tauri::async_runtime::spawn_blocking(move || -> CmdResult<Vec<sections::ExportResult>> {
        let (has_video, _) = sections::stream_types(&source)?;
        let keys = if has_video { sections::keyframes(&source)? } else { Vec::new() };
        Ok(chosen
            .iter()
            .map(|s| {
                // Number by position in the whole clip so file order matches the timeline.
                let index = all.iter().position(|x| x.id == s.id).unwrap_or(0);
                let id = s.id.unwrap();
                match sections::export_one(&source, s, index, &out_dir, has_video, &keys) {
                    Ok((path, mode)) => sections::ExportResult { section_id: id, path: Some(path.to_string_lossy().to_string()), mode: Some(mode), error: None },
                    Err(e) => sections::ExportResult { section_id: id, path: None, mode: None, error: Some(e) },
                }
            })
            .collect())
    })
    .await
    .map_err(err)??;
    let conn = state.db.lock().map_err(err)?;
    for r in &results {
        if let Some(p) = &r.path {
            sections::set_exported(&conn, r.section_id, Some(p)).map_err(err)?;
        }
    }
    Ok(results)
}

#[tauri::command]
fn list_projects(state: State<'_, AppState>) -> CmdResult<Vec<thumbs::Project>> {
    let conn = state.db.lock().map_err(err)?;
    thumbs::list_projects(&conn).map_err(err)
}

#[tauri::command]
fn create_project(state: State<'_, AppState>, title: String) -> CmdResult<thumbs::Project> {
    let conn = state.db.lock().map_err(err)?;
    thumbs::create_project(&conn, &title)
}

#[tauri::command]
fn list_thumbnails(state: State<'_, AppState>, project_id: i64) -> CmdResult<Vec<thumbs::Thumbnail>> {
    let conn = state.db.lock().map_err(err)?;
    thumbs::list_thumbnails(&conn, project_id).map_err(err)
}

#[tauri::command]
fn add_thumbnails(state: State<'_, AppState>, project_id: i64, paths: Vec<String>, platform: String) -> CmdResult<Vec<thumbs::Thumbnail>> {
    let conn = state.db.lock().map_err(err)?;
    thumbs::add_thumbnails(&conn, project_id, &paths, &platform)
}

/// Raw bytes of a registered candidate, for decoding in the webview (no canvas taint, no
/// broad file access: only images added to a test can be read).
#[tauri::command]
fn read_thumbnail(state: State<'_, AppState>, thumbnail_id: i64) -> CmdResult<tauri::ipc::Response> {
    let conn = state.db.lock().map_err(err)?;
    thumbs::read_candidate(&conn, thumbnail_id).map(tauri::ipc::Response::new)
}

#[tauri::command]
fn save_thumbnail_score(state: State<'_, AppState>, thumbnail_id: i64, platform: String, score_total: f64, breakdown_json: String) -> CmdResult<()> {
    let conn = state.db.lock().map_err(err)?;
    thumbs::save_score(&conn, thumbnail_id, &platform, score_total, &breakdown_json).map_err(err)
}

#[tauri::command]
fn rename_thumbnail(state: State<'_, AppState>, thumbnail_id: i64, label: String) -> CmdResult<()> {
    let conn = state.db.lock().map_err(err)?;
    thumbs::set_label(&conn, thumbnail_id, &label).map_err(err)
}

#[tauri::command]
fn remove_thumbnail(state: State<'_, AppState>, thumbnail_id: i64) -> CmdResult<()> {
    let conn = state.db.lock().map_err(err)?;
    thumbs::remove_thumbnail(&conn, thumbnail_id).map_err(err)
}

#[tauri::command]
fn set_winner(state: State<'_, AppState>, project_id: i64, thumbnail_id: Option<i64>) -> CmdResult<()> {
    let conn = state.db.lock().map_err(err)?;
    thumbs::set_winner(&conn, project_id, thumbnail_id)
}

#[tauri::command]
fn get_setting(state: State<'_, AppState>, key: String) -> CmdResult<Option<String>> {
    let conn = state.db.lock().map_err(err)?;
    thumbs::get_setting(&conn, &key).map_err(err)
}

#[tauri::command]
fn set_setting(state: State<'_, AppState>, key: String, value: String) -> CmdResult<()> {
    let conn = state.db.lock().map_err(err)?;
    thumbs::set_setting(&conn, &key, &value).map_err(err)
}

#[tauri::command]
fn ai_status() -> ai::AiStatus {
    ai::status()
}

#[tauri::command]
fn set_api_key(key: String) -> CmdResult<ai::AiStatus> {
    ai::set_key(&key)?;
    Ok(ai::status())
}

#[tauri::command]
fn clear_api_key() -> CmdResult<ai::AiStatus> {
    ai::clear_key()?;
    Ok(ai::status())
}

/// AI hook critique for one candidate. `image_base64` is a JPEG the frontend renders at the
/// platform's upload size. Cached per image fingerprint + platform + title.
#[tauri::command]
async fn critique_thumbnail(state: State<'_, AppState>, thumbnail_id: i64, image_base64: String, platform: String, title: String) -> CmdResult<ai::Critique> {
    let hash = {
        let conn = state.db.lock().map_err(err)?;
        let t = thumbs::get_thumbnail(&conn, thumbnail_id).map_err(err)?.ok_or("Thumbnail not found.")?;
        let hash = t.file_hash.unwrap_or_default();
        if let Some(c) = ai::cached(&conn, &hash, &platform, &title) {
            return Ok(c);
        }
        hash
    };
    let (p, t) = (platform.clone(), title.clone());
    let critique = tauri::async_runtime::spawn_blocking(move || ai::request_critique(&image_base64, &p, &t)).await.map_err(err)??;
    let conn = state.db.lock().map_err(err)?;
    ai::store(&conn, &hash, &platform, &title, &critique).map_err(err)?;
    Ok(critique)
}

/// New inbox idea. `image_base64` is the raw image file (screenshot, upload or drop); the
/// frontend has already run OCR on it locally.
#[tauri::command]
fn capture_idea(state: State<'_, AppState>, raw_text: String, ocr_text: Option<String>, image_base64: Option<String>, source: String) -> CmdResult<ideas::Idea> {
    use base64::Engine;
    let image = image_base64.map(|b| base64::engine::general_purpose::STANDARD.decode(b).map_err(|_| "The image data was corrupted.".to_string())).transpose()?;
    let conn = state.db.lock().map_err(err)?;
    ideas::capture(&conn, &state.idea_images, &raw_text, ocr_text.as_deref(), image.as_deref(), &source)
}

#[tauri::command]
fn list_ideas(state: State<'_, AppState>, query: String, status: Option<String>) -> CmdResult<Vec<ideas::Idea>> {
    let conn = state.db.lock().map_err(err)?;
    ideas::list(&conn, &query, status.as_deref())
}

#[tauri::command]
fn update_idea(state: State<'_, AppState>, idea_id: i64, patch: ideas::IdeaPatch) -> CmdResult<ideas::Idea> {
    let conn = state.db.lock().map_err(err)?;
    ideas::update(&conn, idea_id, &patch)
}

#[tauri::command]
fn set_idea_status(state: State<'_, AppState>, idea_id: i64, status: String) -> CmdResult<ideas::Idea> {
    let conn = state.db.lock().map_err(err)?;
    ideas::set_status(&conn, idea_id, &status)
}

#[tauri::command]
fn read_idea_image(state: State<'_, AppState>, idea_id: i64) -> CmdResult<tauri::ipc::Response> {
    let conn = state.db.lock().map_err(err)?;
    ideas::read_image(&conn, idea_id).map(tauri::ipc::Response::new)
}

/// Claude suggestion (category, title, tags) from the idea's text only. Stored on the idea as
/// a suggestion; nothing is applied until the user confirms.
#[tauri::command]
async fn categorize_idea(state: State<'_, AppState>, idea_id: i64, taxonomy: Vec<String>) -> CmdResult<ideas::Idea> {
    let text = {
        let conn = state.db.lock().map_err(err)?;
        let text = ideas::get(&conn, idea_id)?.full_text();
        if let Some(s) = ai::cached_suggestion(&conn, &text, &taxonomy) {
            return ideas::update(&conn, idea_id, &ideas::IdeaPatch { suggestion: Some(s), ..Default::default() });
        }
        text
    };
    let (t, tax) = (text.clone(), taxonomy.clone());
    let suggestion = tauri::async_runtime::spawn_blocking(move || ai::request_categorization(&t, &tax)).await.map_err(err)??;
    let conn = state.db.lock().map_err(err)?;
    ai::store_suggestion(&conn, &text, &taxonomy, &suggestion).map_err(err)?;
    ideas::update(&conn, idea_id, &ideas::IdeaPatch { suggestion: Some(suggestion), ..Default::default() })
}

/// Dry run of the project folder for the confirmation dialog.
#[tauri::command]
fn preview_scaffold(state: State<'_, AppState>, request: ideas::ScaffoldRequest) -> CmdResult<ideas::ScaffoldPlan> {
    let conn = state.db.lock().map_err(err)?;
    ideas::plan(&conn, &request)
}

#[tauri::command]
fn scaffold_idea(state: State<'_, AppState>, request: ideas::ScaffoldRequest) -> CmdResult<thumbs::Project> {
    let mut conn = state.db.lock().map_err(err)?;
    ideas::scaffold(&mut conn, &request)
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
            app.manage(AppState { db: Mutex::new(conn), idea_images: dir.join("idea-images") });
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
            list_sections,
            section_counts,
            save_section,
            delete_section,
            analyze_clip,
            clip_keyframes,
            export_sections,
            tool_status,
            list_projects,
            create_project,
            list_thumbnails,
            add_thumbnails,
            read_thumbnail,
            save_thumbnail_score,
            rename_thumbnail,
            remove_thumbnail,
            set_winner,
            get_setting,
            set_setting,
            ai_status,
            set_api_key,
            clear_api_key,
            critique_thumbnail,
            capture_idea,
            list_ideas,
            update_idea,
            set_idea_status,
            read_idea_image,
            categorize_idea,
            preview_scaffold,
            scaffold_idea,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
