//! First-run helpers. Starter folders are create-only: existing folders (and anything in
//! them) are left exactly as they are.

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StarterFolder {
    pub name: String,
    /// "created" or "exists"
    pub status: String,
}

/// A single folder name: no separators, no `.`/`..`, nothing Windows rejects.
fn valid_name(name: &str) -> bool {
    let n = name.trim();
    !n.is_empty() && n != "." && n != ".." && n.len() <= 100 && !n.ends_with('.') && !n.chars().any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control())
}

/// What `create` would do, without touching the disk.
pub fn plan(root: &Path, names: &[String]) -> Result<Vec<StarterFolder>, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a folder.", root.display()));
    }
    names
        .iter()
        .map(|n| {
            if !valid_name(n) {
                return Err(format!("\"{n}\" isn't a valid folder name."));
            }
            let exists = root.join(n.trim()).exists();
            Ok(StarterFolder { name: n.trim().to_string(), status: if exists { "exists" } else { "missing" }.into() })
        })
        .collect()
}

pub fn create(root: &Path, names: &[String]) -> Result<Vec<StarterFolder>, String> {
    let planned = plan(root, names)?;
    planned
        .into_iter()
        .map(|f| {
            if f.status == "exists" {
                return Ok(f);
            }
            match std::fs::create_dir(root.join(&f.name)) {
                Ok(()) => Ok(StarterFolder { status: "created".into(), ..f }),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(StarterFolder { status: "exists".into(), ..f }),
                Err(e) => Err(format!("Could not create {}: {e}", f.name)),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_only_missing_folders_and_validates_names() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("Reels")).unwrap();
        std::fs::write(tmp.path().join("Reels").join("keep.mp4"), b"x").unwrap();
        let names: Vec<String> = ["Reels", "Carousels", "Thumbnails", "Ideas"].map(String::from).to_vec();
        let p = plan(tmp.path(), &names).unwrap();
        assert_eq!(p[0].status, "exists");
        assert_eq!(p[1].status, "missing");
        assert!(!tmp.path().join("Carousels").exists(), "planning writes nothing");
        let out = create(tmp.path(), &names).unwrap();
        assert_eq!(out.iter().map(|f| f.status.as_str()).collect::<Vec<_>>(), ["exists", "created", "created", "created"]);
        assert!(tmp.path().join("Reels").join("keep.mp4").exists());
        for bad in ["../x", "a/b", "C:", "..", "", "con?"] {
            assert!(plan(tmp.path(), &[bad.to_string()]).is_err(), "{bad}");
        }
        assert!(plan(&tmp.path().join("missing"), &names).is_err());
    }
}
