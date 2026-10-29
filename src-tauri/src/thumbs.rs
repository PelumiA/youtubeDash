//! Projects, thumbnail candidates and app settings. Scoring happens in the frontend; this
//! module stores candidates, their breakdowns and the chosen winner. Candidate images are
//! referenced in place: adding or removing one never copies, moves or deletes the file.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;

use crate::db;
use crate::scan;

pub const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "bmp"];
pub const MAX_CANDIDATES: usize = 4;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: i64,
    pub title: String,
    pub slug: String,
    pub category: Option<String>,
    pub status: String,
    pub created_at: String,
    pub folder_path: Option<String>,
    pub winner_thumbnail_id: Option<i64>,
    pub thumbnail_count: i64,
    pub best_score: Option<f64>,
    pub last_tested_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thumbnail {
    pub id: i64,
    pub project_id: i64,
    pub path: String,
    pub label: String,
    pub platform: String,
    pub file_hash: Option<String>,
    pub score_total: Option<f64>,
    pub breakdown_json: Option<String>,
    pub created_at: String,
}

pub fn slugify(title: &str) -> String {
    let s = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if s.is_empty() { "untitled".into() } else { s }
}

const PROJECT_SELECT: &str = "SELECT p.id, p.title, p.slug, p.category, p.status, p.created_at, p.folder_path, p.winner_thumbnail_id,
        (SELECT COUNT(*) FROM thumbnails t WHERE t.project_id = p.id),
        (SELECT MAX(score_total) FROM thumbnails t WHERE t.project_id = p.id),
        (SELECT MAX(created_at) FROM thumbnails t WHERE t.project_id = p.id)
     FROM projects p";

fn project_row(r: &rusqlite::Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: r.get(0)?,
        title: r.get(1)?,
        slug: r.get(2)?,
        category: r.get(3)?,
        status: r.get(4)?,
        created_at: r.get(5)?,
        folder_path: r.get(6)?,
        winner_thumbnail_id: r.get(7)?,
        thumbnail_count: r.get(8)?,
        best_score: r.get(9)?,
        last_tested_at: r.get(10)?,
    })
}

pub fn list_projects(conn: &Connection) -> rusqlite::Result<Vec<Project>> {
    let mut stmt = conn.prepare(&format!("{PROJECT_SELECT} ORDER BY p.created_at DESC, p.id DESC"))?;
    let rows = stmt.query_map([], project_row)?;
    rows.collect()
}

pub fn get_project(conn: &Connection, id: i64) -> rusqlite::Result<Option<Project>> {
    conn.query_row(&format!("{PROJECT_SELECT} WHERE p.id = ?1"), params![id], project_row).optional()
}

pub fn create_project(conn: &Connection, title: &str) -> Result<Project, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("Give the project a title.".into());
    }
    conn.execute(
        "INSERT INTO projects (title, slug, status, created_at) VALUES (?1, ?2, 'active', ?3)",
        params![title, slugify(title), db::now()],
    )
    .map_err(|e| e.to_string())?;
    get_project(conn, conn.last_insert_rowid()).map_err(|e| e.to_string())?.ok_or_else(|| "Project vanished.".into())
}

const THUMB_COLUMNS: &str = "id, project_id, path, COALESCE(label, ''), platform, file_hash, score_total, score_breakdown_json, created_at";

fn thumb_row(r: &rusqlite::Row) -> rusqlite::Result<Thumbnail> {
    Ok(Thumbnail {
        id: r.get(0)?,
        project_id: r.get(1)?,
        path: r.get(2)?,
        label: r.get(3)?,
        platform: r.get(4)?,
        file_hash: r.get(5)?,
        score_total: r.get(6)?,
        breakdown_json: r.get(7)?,
        created_at: r.get(8)?,
    })
}

pub fn list_thumbnails(conn: &Connection, project_id: i64) -> rusqlite::Result<Vec<Thumbnail>> {
    let mut stmt = conn.prepare(&format!("SELECT {THUMB_COLUMNS} FROM thumbnails WHERE project_id = ?1 ORDER BY id"))?;
    let rows = stmt.query_map(params![project_id], thumb_row)?;
    rows.collect()
}

pub fn get_thumbnail(conn: &Connection, id: i64) -> rusqlite::Result<Option<Thumbnail>> {
    conn.query_row(&format!("SELECT {THUMB_COLUMNS} FROM thumbnails WHERE id = ?1"), params![id], thumb_row).optional()
}

fn is_image(path: &Path) -> bool {
    path.extension().map(|e| IMAGE_EXTS.contains(&e.to_string_lossy().to_lowercase().as_str())).unwrap_or(false)
}

/// Registers candidate images for a project (by reference). Re-adding the same image is a no-op.
pub fn add_thumbnails(conn: &Connection, project_id: i64, paths: &[String], platform: &str) -> Result<Vec<Thumbnail>, String> {
    let existing = list_thumbnails(conn, project_id).map_err(|e| e.to_string())?;
    let mut seen: Vec<(String, String)> = existing.iter().map(|t| (t.path.clone(), t.file_hash.clone().unwrap_or_default())).collect();
    for p in paths {
        let path = Path::new(p);
        if !is_image(path) {
            return Err(format!("{} is not a supported image (JPG, PNG, WebP, GIF, BMP).", path.display()));
        }
        let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let hash = scan::fingerprint(path, meta.len()).map_err(|e| e.to_string())?;
        if seen.iter().any(|(sp, sh)| *sh == hash || sp == p) {
            continue;
        }
        if seen.len() >= MAX_CANDIDATES {
            return Err(format!("A test compares up to {MAX_CANDIDATES} candidates. Remove one first."));
        }
        let label = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        conn.execute(
            "INSERT INTO thumbnails (project_id, path, label, platform, file_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![project_id, p, label, platform, hash, db::now()],
        )
        .map_err(|e| e.to_string())?;
        seen.push((p.clone(), hash));
    }
    list_thumbnails(conn, project_id).map_err(|e| e.to_string())
}

pub fn save_score(conn: &Connection, id: i64, platform: &str, score_total: f64, breakdown_json: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE thumbnails SET platform = ?1, score_total = ?2, score_breakdown_json = ?3 WHERE id = ?4",
        params![platform, score_total, breakdown_json, id],
    )?;
    Ok(())
}

pub fn set_label(conn: &Connection, id: i64, label: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE thumbnails SET label = ?1 WHERE id = ?2", params![label.trim(), id])?;
    Ok(())
}

/// Removes a candidate from the test. The image file itself is not touched.
pub fn remove_thumbnail(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE projects SET winner_thumbnail_id = NULL WHERE winner_thumbnail_id = ?1", params![id])?;
    conn.execute("DELETE FROM thumbnails WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn set_winner(conn: &Connection, project_id: i64, thumbnail_id: Option<i64>) -> Result<(), String> {
    if let Some(t) = thumbnail_id {
        let thumb = get_thumbnail(conn, t).map_err(|e| e.to_string())?.ok_or("Thumbnail not found.")?;
        if thumb.project_id != project_id {
            return Err("That thumbnail belongs to another project.".into());
        }
    }
    conn.execute("UPDATE projects SET winner_thumbnail_id = ?1 WHERE id = ?2", params![thumbnail_id, project_id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Reads a registered candidate's bytes. Only images added to a test can be read this way.
pub fn read_candidate(conn: &Connection, id: i64) -> Result<Vec<u8>, String> {
    let t = get_thumbnail(conn, id).map_err(|e| e.to_string())?.ok_or("Thumbnail not found.")?;
    std::fs::read(&t.path).map_err(|e| format!("Could not read {}: {e}", t.path))
}

pub fn get_setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0)).optional()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        db::migrate(&c).unwrap();
        c
    }

    #[test]
    fn migrations_are_idempotent_and_versioned() {
        let c = conn();
        db::migrate(&c).unwrap();
        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 2);
    }

    #[test]
    fn candidates_are_referenced_capped_and_deduplicated() {
        let tmp = tempfile::tempdir().unwrap();
        let c = conn();
        let p = create_project(&c, "  Leg Day: Fixed! ").unwrap();
        assert_eq!(p.slug, "leg-day-fixed");
        let mk = |name: &str, bytes: &[u8]| {
            let path = tmp.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            path.to_string_lossy().to_string()
        };
        let a = mk("a.png", b"aaa");
        let a_copy = mk("a copy.png", b"aaa");
        let paths: Vec<String> = vec![a.clone(), a_copy, mk("b.jpg", b"b"), mk("c.webp", b"c"), mk("d.png", b"d"), mk("e.png", b"e")];
        assert!(add_thumbnails(&c, p.id, &paths[..1], "youtube").is_ok());
        // Same bytes under another name are skipped; the fifth distinct image exceeds the cap.
        let err = add_thumbnails(&c, p.id, &paths, "youtube").unwrap_err();
        assert!(err.contains("up to 4"), "{err}");
        assert_eq!(list_thumbnails(&c, p.id).unwrap().len(), 4);
        assert!(add_thumbnails(&c, p.id, &[mk("notes.txt", b"x")], "youtube").is_err());

        let first = list_thumbnails(&c, p.id).unwrap()[0].id;
        set_winner(&c, p.id, Some(first)).unwrap();
        assert_eq!(get_project(&c, p.id).unwrap().unwrap().winner_thumbnail_id, Some(first));
        remove_thumbnail(&c, first).unwrap();
        assert_eq!(get_project(&c, p.id).unwrap().unwrap().winner_thumbnail_id, None, "winner cleared");
        assert!(Path::new(&a).exists(), "removing a candidate never touches the file");
    }

    #[test]
    fn winner_must_belong_to_the_project() {
        let tmp = tempfile::tempdir().unwrap();
        let c = conn();
        let p1 = create_project(&c, "One").unwrap();
        let p2 = create_project(&c, "Two").unwrap();
        let img = tmp.path().join("x.png");
        std::fs::write(&img, b"x").unwrap();
        let t = add_thumbnails(&c, p1.id, &[img.to_string_lossy().to_string()], "youtube").unwrap()[0].id;
        assert!(set_winner(&c, p2.id, Some(t)).is_err());
    }

    #[test]
    fn settings_round_trip() {
        let c = conn();
        assert_eq!(get_setting(&c, "weights").unwrap(), None);
        set_setting(&c, "weights", "{\"a\":1}").unwrap();
        set_setting(&c, "weights", "{\"a\":2}").unwrap();
        assert_eq!(get_setting(&c, "weights").unwrap().as_deref(), Some("{\"a\":2}"));
    }
}
