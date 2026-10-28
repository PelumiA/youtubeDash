//! Global search across everything the app knows: indexed media, clip sections, projects and
//! ideas. Read-only; results are capped per kind so the palette stays fast.

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::db::{self, MediaRow};
use crate::ideas::{self, Idea};
use crate::thumbs::{self, Project};

pub const PER_KIND: usize = 8;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionHit {
    pub id: i64,
    pub media_file_id: i64,
    pub label: String,
    pub start_s: f64,
    pub end_s: f64,
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub files: Vec<MediaRow>,
    pub sections: Vec<SectionHit>,
    pub projects: Vec<Project>,
    pub ideas: Vec<Idea>,
}

/// `%query%` for a LIKE ... ESCAPE '\' clause, with the user's wildcards taken literally.
pub fn like_pattern(query: &str) -> String {
    format!("%{}%", query.trim().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))
}

pub fn search(conn: &Connection, query: &str) -> Result<SearchResults, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(SearchResults { files: vec![], sections: vec![], projects: vec![], ideas: vec![] });
    }
    let like = like_pattern(q);
    let e = |e: rusqlite::Error| e.to_string();

    let files = db::search_media(conn, &like, PER_KIND).map_err(e)?;

    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.media_file_id, s.label, s.start_s, s.end_s, m.path FROM clip_sections s
             JOIN media_files m ON m.id = s.media_file_id
             WHERE (s.label || ' ' || s.tags || ' ' || COALESCE(s.notes, '')) LIKE ?1 ESCAPE '\\'
             ORDER BY m.path, s.start_s LIMIT ?2",
        )
        .map_err(e)?;
    let sections = stmt
        .query_map(params![like, PER_KIND as i64], |r| {
            Ok(SectionHit { id: r.get(0)?, media_file_id: r.get(1)?, label: r.get(2)?, start_s: r.get(3)?, end_s: r.get(4)?, file_path: r.get(5)? })
        })
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)?;

    let projects = thumbs::list_projects(conn)
        .map_err(e)?
        .into_iter()
        .filter(|p| {
            let hay = format!("{} {} {}", p.title, p.category.as_deref().unwrap_or(""), p.folder_path.as_deref().unwrap_or("")).to_lowercase();
            hay.contains(&q.to_lowercase())
        })
        .take(PER_KIND)
        .collect();

    let mut ideas = ideas::list(conn, q, None)?;
    ideas.truncate(PER_KIND);

    Ok(SearchResults { files, sections, projects, ideas })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::ScannedFile;

    fn file(name: &str) -> ScannedFile {
        ScannedFile {
            path: format!("C:\\media\\{name}"),
            dir: "C:\\media".into(),
            filename: name.into(),
            ext: name.rsplit('.').next().unwrap().into(),
            kind: "video".into(),
            size_bytes: 1,
            width: None,
            height: None,
            duration_s: Some(10.0),
            created_at: None,
            captured_date: "2026-10-27".into(),
            file_hash: format!("fp:{name}"),
        }
    }

    #[test]
    fn finds_each_kind_and_treats_wildcards_literally() {
        let tmp = tempfile::tempdir().unwrap();
        let mut c = Connection::open_in_memory().unwrap();
        db::migrate(&c).unwrap();
        let rows = db::sync_scan(&mut c, "C:\\media", &[file("squat_broll.mp4"), file("100%_real.mov"), file("vlog.mp4")]).unwrap();
        let id = |name: &str| rows.iter().find(|r| r.filename == name).unwrap().id;
        db::set_tags(&c, id("vlog.mp4"), &["squat".into()]).unwrap();
        c.execute("INSERT INTO clip_sections (media_file_id, start_s, end_s, label) VALUES (?1, 0, 5, 'Squat intro')", params![id("squat_broll.mp4")]).unwrap();
        thumbs::create_project(&c, "Squat fixes").unwrap();
        ideas::capture(&c, tmp.path(), "Squat mistakes reel", None, None, "text").unwrap();

        let r = search(&c, "SQUAT").unwrap();
        assert_eq!(r.files.len(), 2, "by name and by tag");
        assert_eq!(r.sections.len(), 1);
        assert!(r.sections[0].file_path.ends_with("squat_broll.mp4"));
        assert_eq!(r.projects.len(), 1);
        assert_eq!(r.ideas.len(), 1);
        assert_eq!(search(&c, "100%").unwrap().files.len(), 1);
        assert_eq!(search(&c, "_").unwrap().files.len(), 2, "underscore is literal");
        assert!(search(&c, "  ").unwrap().files.is_empty());
    }
}
