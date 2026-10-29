//! Locates the external ffmpeg/ffprobe binaries. GUI apps often don't inherit the shell PATH
//! (and winget only updates PATH for new sessions), so common install locations are searched too.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// Optional override: a folder containing ffmpeg and ffprobe.
pub const DIR_ENV: &str = "CREATOR_DASHBOARD_FFMPEG_DIR";

pub fn ffmpeg() -> Option<&'static Path> {
    static P: OnceLock<Option<PathBuf>> = OnceLock::new();
    P.get_or_init(|| locate("ffmpeg")).as_deref()
}

pub fn ffprobe() -> Option<&'static Path> {
    static P: OnceLock<Option<PathBuf>> = OnceLock::new();
    P.get_or_init(|| locate("ffprobe")).as_deref()
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn locate(name: &str) -> Option<PathBuf> {
    let file = exe(name);
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(d) = std::env::var_os(DIR_ENV) {
        dirs.push(PathBuf::from(d));
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let winget = PathBuf::from(local).join("Microsoft").join("WinGet");
            dirs.push(winget.join("Links"));
            // winget's Gyan.FFmpeg package: Packages\Gyan.FFmpeg_*\ffmpeg-*\bin
            if let Ok(pkgs) = std::fs::read_dir(winget.join("Packages")) {
                for pkg in pkgs.flatten().filter(|e| e.file_name().to_string_lossy().to_lowercase().contains("ffmpeg")) {
                    if let Ok(inner) = std::fs::read_dir(pkg.path()) {
                        dirs.extend(inner.flatten().map(|e| e.path().join("bin")));
                    }
                }
            }
        }
        dirs.push(PathBuf::from(r"C:\ffmpeg\bin"));
        if let Some(pd) = std::env::var_os("ProgramData") {
            dirs.push(PathBuf::from(pd).join("chocolatey").join("bin"));
        }
    } else {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    }
    dirs.into_iter().map(|d| d.join(&file)).find(|p| works(p))
}

fn works(p: &Path) -> bool {
    if !p.is_file() {
        return false;
    }
    let mut cmd = Command::new(p);
    cmd.arg("-version");
    hide_console(&mut cmd);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

/// A command for an external tool that never flashes a console window on Windows.
pub fn command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    hide_console(&mut cmd);
    cmd
}

#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}
