//! Safe file operations. The only module allowed to change the user's folders.
//!
//! Guarantees:
//! - Moves only: nothing here deletes or rewrites file contents. "Remove" = archive move.
//! - Never overwrites: a target that exists (and isn't itself being moved away) fails the batch.
//! - All-or-nothing: moves run in two phases via temp names (so swaps and chains are safe);
//!   any failure rolls back every step already taken.
//! - Every applied batch is logged in `rename_ops` and can be undone in reverse order.

use rusqlite::{params, Connection};
use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::db;
use crate::scan::ARCHIVE_DIR;

pub const MAX_OPS_PER_BATCH: usize = 1000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveOp {
    pub file_id: Option<i64>,
    pub old_path: String,
    pub new_path: String,
}

/// Case-insensitive key: Windows and default macOS volumes treat `A.mp4` and `a.mp4` as one file.
fn key(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn batch_id() -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    format!("b{nanos:x}")
}

/// Checks a set of moves without touching disk. Shared by apply and undo.
fn validate(moves: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    if moves.is_empty() {
        return Err("Nothing to apply.".into());
    }
    if moves.len() > MAX_OPS_PER_BATCH {
        return Err(format!("A run is capped at {MAX_OPS_PER_BATCH} files; got {}.", moves.len()));
    }
    let sources: HashSet<String> = moves.iter().map(|(o, _)| key(o)).collect();
    if sources.len() != moves.len() {
        return Err("The same file appears twice in this batch.".into());
    }
    let mut targets = HashSet::new();
    for (old, new) in moves {
        if !old.is_file() {
            return Err(format!("Source is missing or not a file: {}", old.display()));
        }
        if new.file_name().is_none() || new.parent().is_none() {
            return Err(format!("Invalid target path: {}", new.display()));
        }
        if !targets.insert(key(new)) {
            return Err(format!("Two files would be renamed to {}", new.display()));
        }
        // A target may exist only if it is one of the files moving out of the way.
        if new.exists() && !sources.contains(&key(new)) {
            return Err(format!("Refusing to overwrite existing file: {}", new.display()));
        }
    }
    Ok(())
}

/// Runs moves in two phases (old → temp, temp → new) and rolls back on any error.
fn execute(moves: &[(PathBuf, PathBuf)], tag: &str) -> Result<(), String> {
    validate(moves)?;

    let temps: Vec<PathBuf> = moves
        .iter()
        .enumerate()
        .map(|(i, (_, new))| new.parent().unwrap().join(format!(".cdtmp-{tag}-{i}")))
        .collect();

    // Each completed step as (from, to), so rollback can reverse it.
    let mut done: Vec<(PathBuf, PathBuf)> = Vec::with_capacity(moves.len() * 2);
    let rollback = |done: &[(PathBuf, PathBuf)]| {
        for (from, to) in done.iter().rev() {
            let _ = std::fs::rename(to, from);
        }
    };

    for ((old, _), tmp) in moves.iter().zip(&temps) {
        let step = (|| {
            std::fs::create_dir_all(tmp.parent().unwrap())?;
            if tmp.exists() {
                return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "temp name in use"));
            }
            std::fs::rename(old, tmp)
        })();
        if let Err(e) = step {
            rollback(&done);
            return Err(format!("Could not move {}: {e}", old.display()));
        }
        done.push((old.clone(), tmp.clone()));
    }
    for ((_, new), tmp) in moves.iter().zip(&temps) {
        // Every source is now parked, so anything still at `new` belongs to someone else.
        if new.exists() {
            rollback(&done);
            return Err(format!("Refusing to overwrite existing file: {}", new.display()));
        }
        if let Err(e) = std::fs::rename(tmp, new) {
            rollback(&done);
            return Err(format!("Could not move to {}: {e}", new.display()));
        }
        done.push((tmp.clone(), new.clone()));
    }
    Ok(())
}

fn update_media_path(tx: &rusqlite::Transaction, from: &str, to: &Path) -> rusqlite::Result<()> {
    let filename = to.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let dir = to.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let ext = to.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
    tx.execute(
        "UPDATE media_files SET path = ?1, dir = ?2, filename = ?3, ext = ?4 WHERE path = ?5",
        params![to.to_string_lossy(), dir, filename, ext, from],
    )?;
    Ok(())
}

/// Applies a batch and writes its undo log. Returns the batch id.
pub fn apply(conn: &mut Connection, ops: &[MoveOp], kind: &str) -> Result<String, String> {
    let moves: Vec<(PathBuf, PathBuf)> =
        ops.iter().map(|o| (PathBuf::from(&o.old_path), PathBuf::from(&o.new_path))).collect();
    let batch = batch_id();
    execute(&moves, &batch)?;

    let logged = (|| -> rusqlite::Result<()> {
        let tx = conn.transaction()?;
        let applied_at = db::now();
        for (seq, (op, (_, new))) in ops.iter().zip(&moves).enumerate() {
            tx.execute(
                "INSERT INTO rename_ops (batch_id, seq, kind, media_file_id, old_path, new_path, applied_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![batch, seq as i64, kind, op.file_id, op.old_path, new.to_string_lossy(), applied_at],
            )?;
        }
        // Two passes so a swap (a→b, b→a) never trips the UNIQUE(path) constraint.
        for (seq, op) in ops.iter().enumerate() {
            tx.execute(
                "UPDATE media_files SET path = ?1 WHERE path = ?2",
                params![format!("pending://{batch}/{seq}"), op.old_path],
            )?;
        }
        for (seq, (_, new)) in moves.iter().enumerate() {
            update_media_path(&tx, &format!("pending://{batch}/{seq}"), new)?;
        }
        tx.commit()
    })();

    if let Err(e) = logged {
        // Without a log row the change couldn't be undone, so put the files back.
        let reverse: Vec<_> = moves.iter().map(|(o, n)| (n.clone(), o.clone())).collect();
        let restored = execute(&reverse, &format!("{batch}r"));
        return Err(match restored {
            Ok(()) => format!("Could not write the undo log ({e}); all files were restored."),
            Err(r) => format!("Could not write the undo log ({e}) and restoring failed: {r}"),
        });
    }
    Ok(batch)
}

/// Restores every move in a batch, newest first. Returns how many files were restored.
pub fn undo(conn: &mut Connection, batch: &str) -> Result<usize, String> {
    let rows: Vec<(i64, String, String)> = (|| {
        let mut stmt = conn.prepare(
            "SELECT id, old_path, new_path FROM rename_ops
             WHERE batch_id = ?1 AND undone_at IS NULL ORDER BY seq DESC",
        )?;
        let rows = stmt.query_map(params![batch], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })()
    .map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Err("This batch has already been undone (or does not exist).".into());
    }

    let moves: Vec<(PathBuf, PathBuf)> =
        rows.iter().map(|(_, old, new)| (PathBuf::from(new), PathBuf::from(old))).collect();
    execute(&moves, &format!("{batch}u"))?;

    let logged = (|| -> rusqlite::Result<()> {
        let tx = conn.transaction()?;
        let undone_at = db::now();
        for (seq, (id, _, new)) in rows.iter().enumerate() {
            tx.execute("UPDATE rename_ops SET undone_at = ?1 WHERE id = ?2", params![undone_at, id])?;
            tx.execute(
                "UPDATE media_files SET path = ?1 WHERE path = ?2",
                params![format!("undo://{batch}/{seq}"), new],
            )?;
        }
        for (seq, (_, old, _)) in rows.iter().enumerate() {
            update_media_path(&tx, &format!("undo://{batch}/{seq}"), Path::new(old))?;
        }
        tx.commit()
    })();
    logged.map_err(|e| format!("Files were restored but the log could not be updated: {e}"))?;
    Ok(rows.len())
}

/// Where an archived file goes: `<root>/_archive/<timestamp>/<path relative to root>`.
pub fn archive_target(root: &Path, file: &Path, stamp: &str) -> Result<PathBuf, String> {
    let rel = file
        .strip_prefix(root)
        .map_err(|_| format!("{} is not inside {}", file.display(), root.display()))?;
    Ok(root.join(ARCHIVE_DIR).join(stamp).join(rel))
}

pub fn archive_stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d_%H%M%S").to_string()
}

/// Moves files into the archive (never deletes). Logged and undoable like any batch.
pub fn archive(conn: &mut Connection, root: &Path, files: &[(i64, String)]) -> Result<String, String> {
    let stamp = archive_stamp();
    let ops = files
        .iter()
        .map(|(id, path)| {
            Ok(MoveOp {
                file_id: Some(*id),
                old_path: path.clone(),
                new_path: archive_target(root, Path::new(path), &stamp)?.to_string_lossy().to_string(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    apply(conn, &ops, "archive")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan;
    use std::collections::BTreeMap;
    use std::fs;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        db::migrate(&c).unwrap();
        c
    }

    /// Ten dummy media files of varied sizes/types, some in subfolders.
    fn fixture(dir: &Path) -> Vec<PathBuf> {
        let names = [
            "IMG_0001.MOV", "IMG_0002.mov", "clip final (2).mp4", "Voice Memo 3.m4a", "song.wav",
            "photo 1.JPG", "thumb.png", "sub/b-roll take 1.mp4", "sub/deep/talk.mkv", "sub/cover.webp",
        ];
        names
            .iter()
            .enumerate()
            .map(|(i, n)| {
                let p = dir.join(n);
                fs::create_dir_all(p.parent().unwrap()).unwrap();
                // Distinct, non-trivial contents (one file > 128 KiB to exercise the tail read).
                let len = if i == 0 { 300_000 } else { 1_000 + i * 37 };
                fs::write(&p, (0..len).map(|b| (b * (i + 3)) as u8).collect::<Vec<u8>>()).unwrap();
                p
            })
            .collect()
    }

    /// Relative path → full content hash, for byte-identical comparisons.
    fn snapshot(root: &Path) -> BTreeMap<String, String> {
        walkdir::WalkDir::new(root)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .map(|e| {
                let rel = e.path().strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                (rel, scan::full_hash(e.path()).unwrap())
            })
            .collect()
    }

    fn content_hashes(root: &Path) -> Vec<String> {
        let mut v: Vec<String> = snapshot(root).into_values().collect();
        v.sort();
        v
    }

    fn seed(conn: &mut Connection, root: &Path) -> Vec<db::MediaRow> {
        let out = scan::scan_dir(root, scan::MAX_SCAN_FILES).unwrap();
        db::sync_scan(conn, &root.to_string_lossy(), &out.files).unwrap()
    }

    fn op(row: &db::MediaRow, new_path: PathBuf) -> MoveOp {
        MoveOp { file_id: Some(row.id), old_path: row.path.clone(), new_path: new_path.to_string_lossy().to_string() }
    }

    #[test]
    fn scan_inventories_media_only_and_skips_archive() {
        let tmp = tempfile::tempdir().unwrap();
        fixture(tmp.path());
        fs::write(tmp.path().join("notes.txt"), "x").unwrap();
        fs::create_dir_all(tmp.path().join("_archive/old")).unwrap();
        fs::write(tmp.path().join("_archive/old/a.mp4"), "x").unwrap();
        let out = scan::scan_dir(tmp.path(), scan::MAX_SCAN_FILES).unwrap();
        assert_eq!(out.files.len(), 10);
        assert!(out.files.iter().all(|f| !f.path.contains(ARCHIVE_DIR)));
        let kinds: Vec<_> = out.files.iter().map(|f| f.kind.as_str()).collect();
        assert_eq!(kinds.iter().filter(|k| **k == "audio").count(), 2);
        assert_eq!(kinds.iter().filter(|k| **k == "photo").count(), 3);
    }

    #[test]
    fn apply_then_undo_restores_every_path_byte_identical() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fixture(root);
        let before = snapshot(root);
        let mut c = conn();
        let rows = seed(&mut c, root);

        // Rename everything, sorting some into a new subfolder.
        let ops: Vec<MoveOp> = rows
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let dir = if i % 2 == 0 { root.join("sorted") } else { PathBuf::from(&r.dir) };
                op(r, dir.join(format!("2026-10-27_test_broll_v{:02}.{}", i + 1, r.ext.to_lowercase())))
            })
            .collect();
        let batch = apply(&mut c, &ops, "rename").unwrap();

        let after = snapshot(root);
        assert_eq!(after.len(), before.len(), "no file was lost or created");
        let mut expected: Vec<String> = before.values().cloned().collect();
        expected.sort();
        assert_eq!(content_hashes(root), expected, "contents untouched");
        assert!(after.keys().all(|k| k.contains("2026-10-27_test_broll_v")));
        // Inventory follows the files.
        let paths: HashSet<_> = db::list_under(&c, &root.to_string_lossy()).unwrap().into_iter().map(|r| r.path).collect();
        assert!(ops.iter().all(|o| paths.contains(&o.new_path)));

        assert_eq!(undo(&mut c, &batch).unwrap(), 10);
        assert_eq!(snapshot(root), before, "every path and every byte restored");
        assert!(undo(&mut c, &batch).is_err(), "cannot undo twice");
        let batches = db::list_batches(&c, 10).unwrap();
        assert!(batches[0].undone_at.is_some());
    }

    #[test]
    fn swap_and_case_only_renames_work() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("a.mp4"), "AAA").unwrap();
        fs::write(root.join("b.mp4"), "BBB").unwrap();
        fs::write(root.join("Case.MP4"), "CCC").unwrap();
        let mut c = conn();
        let rows = seed(&mut c, root);
        let by_name = |n: &str| rows.iter().find(|r| r.filename == n).unwrap();
        let ops = vec![
            op(by_name("a.mp4"), root.join("b.mp4")),
            op(by_name("b.mp4"), root.join("a.mp4")),
            op(by_name("Case.MP4"), root.join("case.mp4")),
        ];
        let batch = apply(&mut c, &ops, "rename").unwrap();
        assert_eq!(fs::read_to_string(root.join("a.mp4")).unwrap(), "BBB");
        assert_eq!(fs::read_to_string(root.join("b.mp4")).unwrap(), "AAA");
        let names: Vec<_> = fs::read_dir(root).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert!(names.contains(&"case.mp4".to_string()));
        undo(&mut c, &batch).unwrap();
        assert_eq!(fs::read_to_string(root.join("a.mp4")).unwrap(), "AAA");
        let names: Vec<_> = fs::read_dir(root).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert!(names.contains(&"Case.MP4".to_string()));
    }

    #[test]
    fn refuses_to_overwrite_and_leaves_disk_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fixture(root);
        fs::write(root.join("taken.mp4"), "someone else's file").unwrap();
        let before = snapshot(root);
        let mut c = conn();
        let rows = seed(&mut c, root);
        let victim = rows.iter().find(|r| r.filename == "IMG_0001.MOV").unwrap();
        let other = rows.iter().find(|r| r.filename == "IMG_0002.mov").unwrap();

        let err = apply(&mut c, &[op(victim, root.join("taken.mp4"))], "rename").unwrap_err();
        assert!(err.contains("overwrite"), "{err}");
        let err = apply(&mut c, &[op(victim, root.join("x.mp4")), op(other, root.join("X.MP4"))], "rename").unwrap_err();
        assert!(err.contains("Two files"), "{err}");
        assert_eq!(snapshot(root), before);
        assert!(db::list_batches(&c, 10).unwrap().is_empty(), "failed batches leave no log");
    }

    #[test]
    fn mid_batch_failure_rolls_back_completed_moves() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fixture(root);
        let mut c = conn();
        let rows = seed(&mut c, root);
        let before = snapshot(root);
        // Second target's parent is a *file*, so create_dir_all fails after the first move succeeded.
        fs::write(root.join("blocker"), "file, not a folder").unwrap();
        let mut before_with_blocker = before.clone();
        before_with_blocker.insert("blocker".into(), scan::full_hash(&root.join("blocker")).unwrap());
        let ops = vec![op(&rows[0], root.join("ok.mov")), op(&rows[1], root.join("blocker").join("nope.mov"))];
        assert!(apply(&mut c, &ops, "rename").is_err());
        assert_eq!(snapshot(root), before_with_blocker);
    }

    #[test]
    fn archive_moves_never_deletes_and_is_undoable() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fixture(root);
        let before = snapshot(root);
        let mut c = conn();
        let rows = seed(&mut c, root);
        let target = rows.iter().find(|r| r.filename == "talk.mkv").unwrap();
        let batch = archive(&mut c, root, &[(target.id, target.path.clone())]).unwrap();
        let after = snapshot(root);
        assert_eq!(after.len(), before.len());
        let archived = after.keys().find(|k| k.starts_with("_archive/")).expect("archived copy exists");
        assert!(archived.ends_with("sub/deep/talk.mkv"));
        // A rescan hides the archive, but the file is still on disk.
        assert_eq!(seed(&mut c, root).len(), 9);
        undo(&mut c, &batch).unwrap();
        let restored = snapshot(root);
        assert!(restored.contains_key("sub/deep/talk.mkv"));
        assert_eq!(restored.get("sub/deep/talk.mkv"), before.get("sub/deep/talk.mkv"));
    }

    #[test]
    fn tags_survive_rescan_and_follow_renames() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fixture(root);
        let mut c = conn();
        let rows = seed(&mut c, root);
        db::set_tags(&c, rows[0].id, &["ready".into(), "broll".into()]).unwrap();
        apply(&mut c, &[op(&rows[0], root.join("renamed.mov"))], "rename").unwrap();
        let rescanned = seed(&mut c, root);
        let row = rescanned.iter().find(|r| r.filename == "renamed.mov").unwrap();
        assert_eq!(row.id, rows[0].id);
        assert_eq!(row.tags, vec!["ready", "broll"]);
    }

    #[test]
    fn rejects_oversized_batches() {
        let ops: Vec<(PathBuf, PathBuf)> =
            (0..=MAX_OPS_PER_BATCH).map(|i| (PathBuf::from(format!("/x/{i}")), PathBuf::from(format!("/y/{i}")))).collect();
        assert!(validate(&ops).unwrap_err().contains("capped"));
    }

    #[test]
    fn scans_100_files_quickly() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..100 {
            let ext = ["mp4", "jpg", "wav", "mov"][i % 4];
            fs::write(tmp.path().join(format!("file {i}.{ext}")), vec![i as u8; 4096]).unwrap();
        }
        let out = scan::scan_dir(tmp.path(), scan::MAX_SCAN_FILES).unwrap();
        assert_eq!(out.files.len(), 100);
        assert!(out.elapsed_ms < 10_000, "took {} ms", out.elapsed_ms);
    }
}
