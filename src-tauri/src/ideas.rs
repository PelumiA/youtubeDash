//! Idea inbox and project scaffolding. Ideas are captured as text or images (OCR runs in the
//! webview, locally). A confirmed idea becomes a project folder. Scaffolding only creates new
//! things: it never writes into a folder that already exists and never overwrites a file.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::ai::Suggestion;
use crate::db;
use crate::thumbs;

/// Screenshots are a few MB at most; this only stops accidental huge drops.
pub const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_SLUG_LEN: usize = 60;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Idea {
    pub id: i64,
    pub title: Option<String>,
    pub raw_text: Option<String>,
    pub ocr_text: Option<String>,
    pub category: Option<String>,
    pub tags: Vec<String>,
    pub has_image: bool,
    /// "text", "image" or "clipboard"
    pub source: String,
    /// "inbox", "project" or "archived"
    pub status: String,
    pub project_id: Option<i64>,
    pub project_folder: Option<String>,
    pub suggestion: Option<Suggestion>,
    pub created_at: String,
    pub updated_at: Option<String>,
}

impl Idea {
    /// Everything the idea says, typed and OCR'd, for categorization and the brief.
    pub fn full_text(&self) -> String {
        [self.raw_text.as_deref(), self.ocr_text.as_deref()]
            .into_iter()
            .flatten()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeaPatch {
    pub title: Option<String>,
    pub raw_text: Option<String>,
    pub ocr_text: Option<String>,
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
    pub suggestion: Option<Suggestion>,
}

const IDEA_SELECT: &str = "SELECT i.id, i.title, i.raw_text, i.ocr_text, i.category, i.tags, i.image_path, i.source, i.status,
        i.project_id, p.folder_path, i.suggestion_json, i.created_at, i.updated_at
     FROM ideas i LEFT JOIN projects p ON p.id = i.project_id";

fn idea_row(r: &rusqlite::Row) -> rusqlite::Result<(Idea, Option<String>)> {
    let tags: String = r.get(5)?;
    let image_path: Option<String> = r.get(6)?;
    let suggestion: Option<String> = r.get(11)?;
    Ok((
        Idea {
            id: r.get(0)?,
            title: r.get(1)?,
            raw_text: r.get(2)?,
            ocr_text: r.get(3)?,
            category: r.get(4)?,
            tags: serde_json::from_str(&tags).unwrap_or_default(),
            has_image: image_path.is_some(),
            source: r.get(7)?,
            status: r.get(8)?,
            project_id: r.get(9)?,
            project_folder: r.get(10)?,
            suggestion: suggestion.and_then(|s| serde_json::from_str(&s).ok()),
            created_at: r.get(12)?,
            updated_at: r.get(13)?,
        },
        image_path,
    ))
}

fn get_with_image(conn: &Connection, id: i64) -> Result<(Idea, Option<String>), String> {
    conn.query_row(&format!("{IDEA_SELECT} WHERE i.id = ?1"), params![id], idea_row)
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Idea not found.".into())
}

pub fn get(conn: &Connection, id: i64) -> Result<Idea, String> {
    get_with_image(conn, id).map(|(i, _)| i)
}

fn image_ext(bytes: &[u8]) -> Option<&'static str> {
    use imagesize::ImageType;
    Some(match imagesize::image_type(bytes).ok()? {
        ImageType::Png => "png",
        ImageType::Jpeg => "jpg",
        ImageType::Webp => "webp",
        ImageType::Gif => "gif",
        ImageType::Bmp => "bmp",
        _ => return None,
    })
}

/// Saves a new idea. Images are copied into the app's own `idea-images/` folder (named by
/// content hash), so the idea survives the original screenshot being moved or cleaned up.
pub fn capture(conn: &Connection, images_dir: &Path, raw_text: &str, ocr_text: Option<&str>, image: Option<&[u8]>, source: &str) -> Result<Idea, String> {
    let raw_text = raw_text.trim();
    if raw_text.is_empty() && image.is_none() {
        return Err("Type an idea or add a screenshot first.".into());
    }
    if !["text", "image", "clipboard"].contains(&source) {
        return Err(format!("Unknown idea source {source}."));
    }
    let image_path = match image {
        None => None,
        Some(bytes) => {
            if bytes.len() > MAX_IMAGE_BYTES {
                return Err("That image is over 25 MB. Crop or resize it first.".into());
            }
            let ext = image_ext(bytes).ok_or("That file isn't a supported image (PNG, JPG, WebP, GIF, BMP).")?;
            fs::create_dir_all(images_dir).map_err(|e| e.to_string())?;
            let hash = blake3::hash(bytes).to_hex();
            let path = images_dir.join(format!("{}.{ext}", &hash[..24]));
            if !path.exists() {
                fs::write(&path, bytes).map_err(|e| format!("Could not save the image: {e}"))?;
            }
            Some(path.to_string_lossy().to_string())
        }
    };
    let now = db::now();
    conn.execute(
        "INSERT INTO ideas (raw_text, ocr_text, image_path, source, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'inbox', ?5, ?5)",
        params![(!raw_text.is_empty()).then_some(raw_text), ocr_text.map(str::trim).filter(|s| !s.is_empty()), image_path, source, now],
    )
    .map_err(|e| e.to_string())?;
    get(conn, conn.last_insert_rowid())
}

/// Ideas matching `query` across text, OCR text, title, category, tags and project folder.
pub fn list(conn: &Connection, query: &str, status: Option<&str>) -> Result<Vec<Idea>, String> {
    let like = crate::search::like_pattern(query);
    let mut stmt = conn
        .prepare(&format!(
            "{IDEA_SELECT}
             WHERE (?1 IS NULL OR i.status = ?1)
               AND (COALESCE(i.title, '') || ' ' || COALESCE(i.raw_text, '') || ' ' || COALESCE(i.ocr_text, '') || ' ' ||
                    COALESCE(i.category, '') || ' ' || i.tags || ' ' || COALESCE(p.folder_path, '')) LIKE ?2 ESCAPE '\\'
             ORDER BY i.created_at DESC, i.id DESC LIMIT 500"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![status, like], idea_row).map_err(|e| e.to_string())?;
    rows.map(|r| r.map(|(i, _)| i).map_err(|e| e.to_string())).collect()
}

pub fn update(conn: &Connection, id: i64, patch: &IdeaPatch) -> Result<Idea, String> {
    get(conn, id)?;
    let tags = patch.tags.as_ref().map(|t| {
        let mut clean: Vec<String> = Vec::new();
        for tag in t.iter().map(|s| s.trim().trim_start_matches('#').to_lowercase()).filter(|s| !s.is_empty()) {
            if !clean.contains(&tag) {
                clean.push(tag);
            }
        }
        serde_json::to_string(&clean).expect("serialize")
    });
    let suggestion = patch.suggestion.as_ref().map(|s| serde_json::to_string(s).expect("serialize"));
    conn.execute(
        "UPDATE ideas SET
           title = COALESCE(?1, title), raw_text = COALESCE(?2, raw_text), ocr_text = COALESCE(?3, ocr_text),
           category = COALESCE(?4, category), tags = COALESCE(?5, tags), suggestion_json = COALESCE(?6, suggestion_json),
           updated_at = ?7
         WHERE id = ?8",
        params![
            patch.title.as_deref().map(str::trim),
            patch.raw_text.as_deref(),
            patch.ocr_text.as_deref(),
            patch.category.as_deref().map(str::trim),
            tags,
            suggestion,
            db::now(),
            id
        ],
    )
    .map_err(|e| e.to_string())?;
    get(conn, id)
}

/// Archive or restore. Ideas are never deleted; a converted idea stays linked to its project.
pub fn set_status(conn: &Connection, id: i64, status: &str) -> Result<Idea, String> {
    let idea = get(conn, id)?;
    if !["inbox", "archived"].contains(&status) {
        return Err(format!("Can't set an idea to {status}."));
    }
    if idea.status == "project" {
        return Err("This idea is already a project.".into());
    }
    conn.execute("UPDATE ideas SET status = ?1, updated_at = ?2 WHERE id = ?3", params![status, db::now(), id]).map_err(|e| e.to_string())?;
    get(conn, id)
}

pub fn read_image(conn: &Connection, id: i64) -> Result<Vec<u8>, String> {
    let (_, path) = get_with_image(conn, id)?;
    let path = path.ok_or("This idea has no image.")?;
    fs::read(&path).map_err(|e| format!("Could not read the idea image: {e}"))
}

// ---- Scaffolding -----------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldRequest {
    pub idea_id: i64,
    /// The user's Projects folder; created if missing.
    pub projects_dir: String,
    pub title: String,
    pub category: String,
    pub tags: Vec<String>,
    /// YYYY-MM-DD, the folder's date prefix (the user's local "today").
    pub date: String,
    /// Optional closing line for every brief (e.g. the Groovy Gains CTA).
    #[serde(default)]
    pub footer: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldPlan {
    pub folder: String,
    /// Paths relative to `folder`, folders ending in `/`.
    pub entries: Vec<String>,
    pub brief: String,
    pub script: String,
}

fn screenshot_name(image_path: &str) -> String {
    let ext = Path::new(image_path).extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_else(|| "png".into());
    format!("idea-screenshot.{ext}")
}

pub fn brief_md(idea: &Idea, req: &ScaffoldRequest, screenshot: Option<&str>) -> String {
    let mut s = format!("# {}\n\n", req.title.trim());
    s += &format!("- **Category:** {}\n", req.category.trim());
    s += &format!("- **Tags:** {}\n", if req.tags.is_empty() { "none".to_string() } else { req.tags.join(", ") });
    s += &format!("- **Captured:** {}\n", idea.created_at.get(..10).unwrap_or(&idea.created_at));
    s += &format!("- **Project created:** {}\n", req.date);
    if let Some(text) = idea.raw_text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        s += &format!("\n## Idea\n\n{text}\n");
    }
    if let Some(text) = idea.ocr_text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        s += &format!("\n## Text from the screenshot\n\n{text}\n");
    }
    if let Some(name) = screenshot {
        s += &format!("\n![Screenshot](assets/{name})\n");
    }
    if !req.footer.trim().is_empty() {
        s += &format!("\n---\n\n{}\n", req.footer.trim());
    }
    s
}

pub fn script_md(title: &str) -> String {
    format!("# {} — script\n\n## Hook (first 5 seconds)\n\n\n## Setup\n\n\n## Main points\n\n1. \n2. \n3. \n\n## Payoff\n\n\n## Call to action\n\n", title.trim())
}

fn validate(req: &ScaffoldRequest) -> Result<(), String> {
    if req.title.trim().is_empty() {
        return Err("Give the project a title.".into());
    }
    if req.category.trim().is_empty() {
        return Err("Confirm a category first.".into());
    }
    if chrono::NaiveDate::parse_from_str(&req.date, "%Y-%m-%d").is_err() {
        return Err(format!("Bad date {}.", req.date));
    }
    if !Path::new(&req.projects_dir).is_absolute() {
        return Err("Choose a Projects folder first.".into());
    }
    Ok(())
}

/// `<projects>/<date>_<slug>`, with `-2`, `-3`… when that name is already taken on disk.
fn free_folder(projects_dir: &Path, date: &str, title: &str) -> PathBuf {
    let slug: String = thumbs::slugify(title).chars().take(MAX_SLUG_LEN).collect();
    let base = format!("{date}_{}", slug.trim_end_matches('-'));
    (1..)
        .map(|n| projects_dir.join(if n == 1 { base.clone() } else { format!("{base}-{n}") }))
        .find(|p| !p.exists())
        .expect("unbounded")
}

/// The dry run: what `scaffold` would create, including the brief's contents.
pub fn plan(conn: &Connection, req: &ScaffoldRequest) -> Result<ScaffoldPlan, String> {
    validate(req)?;
    let (idea, image) = get_with_image(conn, req.idea_id)?;
    let shot = image.as_deref().map(screenshot_name);
    let mut entries = vec!["brief.md".to_string(), "script.md".into(), "assets/".into()];
    if let Some(name) = &shot {
        entries.push(format!("assets/{name}"));
    }
    entries.push("thumbnails/".into());
    Ok(ScaffoldPlan {
        folder: free_folder(Path::new(&req.projects_dir), &req.date, &req.title).to_string_lossy().to_string(),
        entries,
        brief: brief_md(&idea, req, shot.as_deref()),
        script: script_md(&req.title),
    })
}

fn write_new(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    fs::OpenOptions::new().write(true).create_new(true).open(path)?.write_all(contents)
}

/// Creates the project folder and record, and marks the idea as converted.
pub fn scaffold(conn: &mut Connection, req: &ScaffoldRequest) -> Result<thumbs::Project, String> {
    let (idea, image) = get_with_image(conn, req.idea_id)?;
    if idea.status != "inbox" {
        return Err(if idea.status == "project" { "This idea is already a project." } else { "Restore this idea to the inbox first." }.into());
    }
    let plan = plan(conn, req)?;
    let folder = PathBuf::from(&plan.folder);
    fs::create_dir_all(&req.projects_dir).map_err(|e| format!("Could not create {}: {e}", req.projects_dir))?;
    // create_dir (not _all) fails if the folder appeared since the plan: never write into one.
    fs::create_dir(&folder).map_err(|e| format!("Could not create {}: {e}", folder.display()))?;
    let made = (|| -> std::io::Result<()> {
        fs::create_dir(folder.join("assets"))?;
        fs::create_dir(folder.join("thumbnails"))?;
        write_new(&folder.join("brief.md"), plan.brief.as_bytes())?;
        write_new(&folder.join("script.md"), plan.script.as_bytes())?;
        if let Some(src) = &image {
            write_new(&folder.join("assets").join(screenshot_name(src)), &fs::read(src)?)?;
        }
        Ok(())
    })();
    if let Err(e) = made {
        // Only the folder this call just created (and its new contents) is removed.
        let _ = fs::remove_dir_all(&folder);
        return Err(format!("Could not scaffold the project: {e}"));
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = db::now();
    let tags = serde_json::to_string(&req.tags).expect("serialize");
    tx.execute(
        "INSERT INTO projects (title, slug, category, status, created_at, folder_path) VALUES (?1, ?2, ?3, 'active', ?4, ?5)",
        params![req.title.trim(), thumbs::slugify(&req.title), req.category.trim(), now, plan.folder],
    )
    .map_err(|e| e.to_string())?;
    let project_id = tx.last_insert_rowid();
    tx.execute(
        "UPDATE ideas SET status = 'project', project_id = ?1, title = ?2, category = ?3, tags = ?4, updated_at = ?5 WHERE id = ?6",
        params![project_id, req.title.trim(), req.category.trim(), tags, now, req.idea_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    thumbs::get_project(conn, project_id).map_err(|e| e.to_string())?.ok_or_else(|| "Project vanished.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1F, 0x15, 0xC4, 0x89, 0, 0, 0, 0x0D, 0x49,
        0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        db::migrate(&c).unwrap();
        c
    }

    fn req(idea_id: i64, dir: &Path) -> ScaffoldRequest {
        ScaffoldRequest {
            idea_id,
            projects_dir: dir.join("Projects").to_string_lossy().to_string(),
            title: "3 Squat Mistakes Killing Your Leg Day".into(),
            category: "talking-head".into(),
            tags: vec!["squat".into(), "legs".into()],
            date: "2026-10-27".into(),
            footer: "CTA: Comment GROOVY and I'll DM you my free 4-week starter plan.".into(),
        }
    }

    #[test]
    fn capture_validates_and_stores_images_by_content() {
        let tmp = tempfile::tempdir().unwrap();
        let c = conn();
        assert!(capture(&c, tmp.path(), "  ", None, None, "text").is_err());
        assert!(capture(&c, tmp.path(), "", None, Some(b"not an image"), "image").is_err());
        let a = capture(&c, tmp.path(), "", Some("OCR words"), Some(PNG_1X1), "clipboard").unwrap();
        let b = capture(&c, tmp.path(), "same shot again", None, Some(PNG_1X1), "image").unwrap();
        assert!(a.has_image && a.status == "inbox" && a.raw_text.is_none());
        assert_eq!(read_image(&c, a.id).unwrap(), PNG_1X1);
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1, "same bytes stored once");
        assert_eq!(b.full_text(), "same shot again");
        assert_eq!(a.full_text(), "OCR words");
    }

    #[test]
    fn search_update_and_archive() {
        let tmp = tempfile::tempdir().unwrap();
        let c = conn();
        let a = capture(&c, tmp.path(), "Hip thrust 100% form guide", None, None, "text").unwrap();
        capture(&c, tmp.path(), "Morning vlog", None, None, "text").unwrap();
        update(&c, a.id, &IdeaPatch { tags: Some(vec!["#Glutes".into(), "glutes".into(), " ".into()]), category: Some("tutorial".into()), ..Default::default() }).unwrap();
        assert_eq!(get(&c, a.id).unwrap().tags, vec!["glutes"]);
        assert_eq!(list(&c, "GLUTES", None).unwrap().len(), 1);
        assert_eq!(list(&c, "100%", None).unwrap().len(), 1, "LIKE wildcards are literal");
        assert_eq!(list(&c, "", Some("inbox")).unwrap().len(), 2);
        set_status(&c, a.id, "archived").unwrap();
        assert_eq!(list(&c, "", Some("inbox")).unwrap().len(), 1);
        assert_eq!(list(&c, "", Some("archived")).unwrap().len(), 1);
        assert!(set_status(&c, a.id, "project").is_err());
        // A partial patch leaves other fields alone.
        update(&c, a.id, &IdeaPatch { title: Some("Hip thrusts".into()), ..Default::default() }).unwrap();
        assert_eq!(get(&c, a.id).unwrap().category.as_deref(), Some("tutorial"));
    }

    #[test]
    fn scaffold_creates_the_structure_and_links_the_idea() {
        let tmp = tempfile::tempdir().unwrap();
        let mut c = conn();
        let idea = capture(&c, &tmp.path().join("store"), "Film the 3 mistakes", Some("squat mistakes"), Some(PNG_1X1), "clipboard").unwrap();
        let r = req(idea.id, tmp.path());
        let p = plan(&c, &r).unwrap();
        assert!(p.folder.ends_with("2026-10-27_3-squat-mistakes-killing-your-leg-day"), "{}", p.folder);
        assert!(!Path::new(&p.folder).exists(), "planning writes nothing");

        let project = scaffold(&mut c, &r).unwrap();
        let folder = PathBuf::from(project.folder_path.clone().unwrap());
        assert_eq!(project.category.as_deref(), Some("talking-head"));
        for e in ["brief.md", "script.md", "assets", "thumbnails", "assets/idea-screenshot.png"] {
            assert!(folder.join(e).exists(), "{e}");
        }
        let brief = fs::read_to_string(folder.join("brief.md")).unwrap();
        assert!(brief.starts_with("# 3 Squat Mistakes Killing Your Leg Day"));
        assert!(brief.contains("**Category:** talking-head") && brief.contains("squat, legs") && brief.contains("Comment GROOVY"));
        assert!(brief.contains("Film the 3 mistakes") && brief.contains("squat mistakes") && brief.contains("assets/idea-screenshot.png"));
        let after = get(&c, idea.id).unwrap();
        assert_eq!((after.status.as_str(), after.project_id), ("project", Some(project.id)));
        assert_eq!(after.project_folder.as_deref(), project.folder_path.as_deref());
        assert!(scaffold(&mut c, &r).unwrap_err().contains("already a project"));
    }

    #[test]
    fn scaffold_never_reuses_an_existing_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let mut c = conn();
        let r = req(capture(&c, tmp.path(), "idea", None, None, "text").unwrap().id, tmp.path());
        let taken = Path::new(&r.projects_dir).join("2026-10-27_3-squat-mistakes-killing-your-leg-day");
        fs::create_dir_all(&taken).unwrap();
        fs::write(taken.join("brief.md"), "mine").unwrap();
        let project = scaffold(&mut c, &r).unwrap();
        assert!(project.folder_path.unwrap().ends_with("-2"));
        assert_eq!(fs::read_to_string(taken.join("brief.md")).unwrap(), "mine", "existing folder untouched");
    }

    #[test]
    fn scaffold_validates_before_touching_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let mut c = conn();
        let id = capture(&c, tmp.path(), "idea", None, None, "text").unwrap().id;
        for bad in [
            ScaffoldRequest { category: " ".into(), ..req(id, tmp.path()) },
            ScaffoldRequest { title: "".into(), ..req(id, tmp.path()) },
            ScaffoldRequest { date: "27/10/2026".into(), ..req(id, tmp.path()) },
            ScaffoldRequest { projects_dir: "Projects".into(), ..req(id, tmp.path()) },
        ] {
            assert!(scaffold(&mut c, &bad).is_err());
        }
        assert!(!tmp.path().join("Projects").exists());
        set_status(&c, id, "archived").unwrap();
        assert!(scaffold(&mut c, &req(id, tmp.path())).unwrap_err().contains("Restore"));
    }
}
