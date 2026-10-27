//! SQLite schema and queries. SQLite is the source of truth for tags, scores and the undo log.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;

use crate::scan::ScannedFile;

const SCHEMA: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  slug        TEXT NOT NULL,
  category    TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL,
  folder_path TEXT
);

CREATE TABLE IF NOT EXISTS media_files (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER REFERENCES projects(id),
  path          TEXT NOT NULL UNIQUE,
  dir           TEXT NOT NULL,
  filename      TEXT NOT NULL,
  ext           TEXT NOT NULL,
  kind          TEXT NOT NULL,
  type          TEXT,
  size_bytes    INTEGER NOT NULL,
  duration_s    REAL,
  width         INTEGER,
  height        INTEGER,
  created_at    TEXT,
  captured_date TEXT NOT NULL,
  file_hash     TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  scanned_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS media_files_hash ON media_files(file_hash);

CREATE TABLE IF NOT EXISTS clip_sections (
  id            INTEGER PRIMARY KEY,
  media_file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  start_s       REAL NOT NULL,
  end_s         REAL NOT NULL,
  label         TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  notes         TEXT,
  exported_path TEXT
);

-- The undo log. One row per move; rows sharing a batch_id were applied together and are
-- undone together in reverse seq order.
CREATE TABLE IF NOT EXISTS rename_ops (
  id            INTEGER PRIMARY KEY,
  batch_id      TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'rename',
  media_file_id INTEGER,
  old_path      TEXT NOT NULL,
  new_path      TEXT NOT NULL,
  applied_at    TEXT NOT NULL,
  undone_at     TEXT
);
CREATE INDEX IF NOT EXISTS rename_ops_batch ON rename_ops(batch_id);

CREATE TABLE IF NOT EXISTS thumbnails (
  id                   INTEGER PRIMARY KEY,
  project_id           INTEGER REFERENCES projects(id),
  path                 TEXT NOT NULL,
  score_total          REAL,
  score_breakdown_json TEXT,
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ideas (
  id         INTEGER PRIMARY KEY,
  raw_text   TEXT,
  ocr_text   TEXT,
  category   TEXT,
  project_id INTEGER REFERENCES projects(id),
  status     TEXT NOT NULL DEFAULT 'inbox',
  created_at TEXT NOT NULL
);
"#;

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    migrate(&conn)?;
    Ok(conn)
}

/// Ordered schema changes on top of SCHEMA; `PRAGMA user_version` records how many ran.
const MIGRATIONS: &[&str] = &[
    // 1 — Phase 2: thumbnail tester.
    "ALTER TABLE projects ADD COLUMN winner_thumbnail_id INTEGER;
     ALTER TABLE thumbnails ADD COLUMN platform TEXT NOT NULL DEFAULT 'youtube';
     ALTER TABLE thumbnails ADD COLUMN file_hash TEXT;
     ALTER TABLE thumbnails ADD COLUMN label TEXT;
     CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS ai_cache (cache_key TEXT PRIMARY KEY, response TEXT NOT NULL, created_at TEXT NOT NULL);",
    // 2 — Phase 3: idea organizer.
    "ALTER TABLE ideas ADD COLUMN title TEXT;
     ALTER TABLE ideas ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
     ALTER TABLE ideas ADD COLUMN image_path TEXT;
     ALTER TABLE ideas ADD COLUMN source TEXT NOT NULL DEFAULT 'text';
     ALTER TABLE ideas ADD COLUMN suggestion_json TEXT;
     ALTER TABLE ideas ADD COLUMN updated_at TEXT;
     CREATE INDEX IF NOT EXISTS ideas_status ON ideas(status);",
];

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA)?;
    let version: usize = conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? as usize;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version) {
        if let Err(e) = conn.execute_batch(&format!("BEGIN; {sql} PRAGMA user_version = {}; COMMIT;", i + 1)) {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    Ok(())
}

pub fn now() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRow {
    pub id: i64,
    pub path: String,
    pub dir: String,
    pub filename: String,
    pub ext: String,
    pub kind: String,
    pub size_bytes: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_s: Option<f64>,
    pub captured_date: String,
    pub file_hash: String,
    pub tags: Vec<String>,
}

const MEDIA_COLUMNS: &str =
    "id, path, dir, filename, ext, kind, size_bytes, width, height, duration_s, captured_date, file_hash, tags";

fn media_row(r: &rusqlite::Row) -> rusqlite::Result<MediaRow> {
    let tags: String = r.get(12)?;
    Ok(MediaRow {
        id: r.get(0)?,
        path: r.get(1)?,
        dir: r.get(2)?,
        filename: r.get(3)?,
        ext: r.get(4)?,
        kind: r.get(5)?,
        size_bytes: r.get(6)?,
        width: r.get(7)?,
        height: r.get(8)?,
        duration_s: r.get(9)?,
        captured_date: r.get(10)?,
        file_hash: r.get(11)?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
    })
}

/// True if `path` is `root` itself or inside it. Plain prefix compare on the stored string,
/// with a separator check so `C:\media2` is not "inside" `C:\media`.
fn under_root_sql() -> &'static str {
    "(path = ?1 OR substr(path, 1, length(?1) + 1) IN (?1 || '\\', ?1 || '/'))"
}

/// Replaces the inventory for `root` with a fresh scan. Tags survive because rows are
/// upserted by path; rows for files no longer on disk are dropped (metadata only).
pub fn sync_scan(conn: &mut Connection, root: &str, files: &[ScannedFile]) -> rusqlite::Result<Vec<MediaRow>> {
    let tx = conn.transaction()?;
    // Nanosecond stamp doubles as a scan generation id: anything under root not stamped by
    // this scan has disappeared from disk.
    let scanned_at = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, false);
    {
        let mut upsert = tx.prepare(
            "INSERT INTO media_files
               (path, dir, filename, ext, kind, size_bytes, duration_s, width, height, created_at, captured_date, file_hash, scanned_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(path) DO UPDATE SET
               dir = excluded.dir, filename = excluded.filename, ext = excluded.ext, kind = excluded.kind,
               size_bytes = excluded.size_bytes, duration_s = excluded.duration_s, width = excluded.width,
               height = excluded.height, created_at = excluded.created_at, captured_date = excluded.captured_date,
               file_hash = excluded.file_hash, scanned_at = excluded.scanned_at",
        )?;
        for f in files {
            upsert.execute(params![
                f.path, f.dir, f.filename, f.ext, f.kind, f.size_bytes as i64, f.duration_s, f.width, f.height,
                f.created_at, f.captured_date, f.file_hash, scanned_at
            ])?;
        }
        tx.execute(
            &format!("DELETE FROM media_files WHERE {} AND scanned_at <> ?2", under_root_sql()),
            params![root, scanned_at],
        )?;
    }
    tx.commit()?;
    list_under(conn, root)
}

pub fn list_under(conn: &Connection, root: &str) -> rusqlite::Result<Vec<MediaRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {MEDIA_COLUMNS} FROM media_files WHERE {} ORDER BY path",
        under_root_sql()
    ))?;
    let rows = stmt.query_map(params![root], media_row)?;
    rows.collect()
}

pub fn get_media(conn: &Connection, ids: &[i64]) -> rusqlite::Result<Vec<MediaRow>> {
    let mut stmt = conn.prepare(&format!("SELECT {MEDIA_COLUMNS} FROM media_files WHERE id = ?1"))?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(row) = stmt.query_row(params![id], media_row).optional()? {
            out.push(row);
        }
    }
    Ok(out)
}

pub fn set_tags(conn: &Connection, file_id: i64, tags: &[String]) -> rusqlite::Result<()> {
    let json = serde_json::to_string(tags).expect("tags serialize");
    conn.execute("UPDATE media_files SET tags = ?1 WHERE id = ?2", params![json, file_id])?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchSummary {
    pub batch_id: String,
    pub kind: String,
    pub op_count: i64,
    pub applied_at: String,
    pub undone_at: Option<String>,
}

pub fn list_batches(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<BatchSummary>> {
    let mut stmt = conn.prepare(
        "SELECT batch_id, MIN(kind), COUNT(*), MIN(applied_at), MAX(undone_at)
         FROM rename_ops GROUP BY batch_id ORDER BY MIN(id) DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |r| {
        Ok(BatchSummary {
            batch_id: r.get(0)?,
            kind: r.get(1)?,
            op_count: r.get(2)?,
            applied_at: r.get(3)?,
            undone_at: r.get(4)?,
        })
    })?;
    rows.collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSummary {
    pub files_indexed: i64,
    pub batches_applied: i64,
    pub ideas_in_inbox: i64,
    pub projects_active: i64,
    pub recent_batches: Vec<BatchSummary>,
}

pub fn dashboard_summary(conn: &Connection) -> rusqlite::Result<DashboardSummary> {
    let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0));
    Ok(DashboardSummary {
        files_indexed: count("SELECT COUNT(*) FROM media_files")?,
        batches_applied: count("SELECT COUNT(DISTINCT batch_id) FROM rename_ops WHERE undone_at IS NULL")?,
        ideas_in_inbox: count("SELECT COUNT(*) FROM ideas WHERE status = 'inbox'")?,
        projects_active: count("SELECT COUNT(*) FROM projects WHERE status = 'active'")?,
        recent_batches: list_batches(conn, 5)?,
    })
}
