//! State directory resolution and file identity (spec sections 2 and 3.1).

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use crate::error::{Result, WorkspaceError};

/// File name of the database inside the state directory.
pub const DATABASE_FILE_NAME: &str = "workspace.db";

/// The per-user Fullmag state directory.
///
/// `FULLMAG_STATE_DIR` replaces the platform default (tests, portable
/// installs, CI): Windows `%APPDATA%\Fullmag`, macOS
/// `~/Library/Application Support/Fullmag`, Linux `$XDG_DATA_HOME/fullmag`
/// else `~/.local/share/fullmag`. The directory is not created here.
pub fn state_dir() -> Result<PathBuf> {
    state_dir_from(|name| std::env::var_os(name))
}

/// Default location of `workspace.db`.
pub fn default_database_path() -> Result<PathBuf> {
    Ok(state_dir()?.join(DATABASE_FILE_NAME))
}

/// [`state_dir`] with an injectable environment, so tests need not mutate the
/// process environment.
pub fn state_dir_from(env: impl Fn(&str) -> Option<OsString>) -> Result<PathBuf> {
    let non_empty = |name: &str| env(name).filter(|value| !value.is_empty());
    if let Some(explicit) = non_empty("FULLMAG_STATE_DIR") {
        return Ok(PathBuf::from(explicit));
    }
    if cfg!(windows) {
        if let Some(appdata) = non_empty("APPDATA") {
            return Ok(PathBuf::from(appdata).join("Fullmag"));
        }
        if let Some(profile) = non_empty("USERPROFILE") {
            return Ok(PathBuf::from(profile)
                .join("AppData")
                .join("Roaming")
                .join("Fullmag"));
        }
        return Err(WorkspaceError::NoStateDir);
    }
    if cfg!(target_os = "macos") {
        return non_empty("HOME")
            .map(|home| {
                PathBuf::from(home)
                    .join("Library")
                    .join("Application Support")
                    .join("Fullmag")
            })
            .ok_or(WorkspaceError::NoStateDir);
    }
    // XDG: a relative XDG_DATA_HOME is invalid and must be ignored.
    if let Some(data_home) = non_empty("XDG_DATA_HOME").map(PathBuf::from) {
        if data_home.is_absolute() {
            return Ok(data_home.join("fullmag"));
        }
    }
    non_empty("HOME")
        .map(|home| {
            PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("fullmag")
        })
        .ok_or(WorkspaceError::NoStateDir)
}

/// Resolved identity of a file: the absolute path as last seen and the
/// normalised key that decides whether two spellings are the same item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub path: String,
    pub key: String,
}

/// Whether path identity ignores case on this platform (Windows, macOS).
pub const CASE_INSENSITIVE_PATHS: bool = cfg!(any(windows, target_os = "macos"));

/// Resolve `path` to its [`Identity`].
///
/// The path is made absolute and lexically normalised; the longest existing
/// ancestor is canonicalised (symlinks resolved), so the identity is stable for
/// files that do not exist (yet, or any more). The key is case-folded on
/// Windows and macOS.
pub fn identity(path: &Path) -> Result<Identity> {
    if path.as_os_str().is_empty() {
        return Err(WorkspaceError::Invalid("empty path".into()));
    }
    let absolute = std::path::absolute(path)?;
    let normalised = lexically_normalise(&absolute);
    let resolved = canonicalise_existing_prefix(&normalised);
    let text = resolved.to_string_lossy().into_owned();
    let key = if CASE_INSENSITIVE_PATHS {
        text.to_lowercase()
    } else {
        text.clone()
    };
    Ok(Identity { path: text, key })
}

fn lexically_normalise(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                // Never pop the root or a prefix.
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn canonicalise_existing_prefix(path: &Path) -> PathBuf {
    let mut tail: Vec<OsString> = Vec::new();
    let mut probe = path.to_path_buf();
    loop {
        if let Ok(real) = std::fs::canonicalize(&probe) {
            let mut base = strip_verbatim(real);
            for part in tail.iter().rev() {
                base.push(part);
            }
            return base;
        }
        match (probe.file_name().map(OsString::from), probe.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name);
                probe = parent.to_path_buf();
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// `\\?\C:\x` becomes `C:\x` and `\\?\UNC\srv\share` becomes `\\srv\share`;
/// other verbatim forms are left alone.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    if !cfg!(windows) {
        return path;
    }
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
            return PathBuf::from(rest.to_string());
        }
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<OsString> {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| OsString::from(value))
        }
    }

    #[test]
    fn explicit_state_dir_wins() {
        let dir = state_dir_from(env_of(&[("FULLMAG_STATE_DIR", "/tmp/fm"), ("HOME", "/h")]));
        assert_eq!(dir.unwrap(), PathBuf::from("/tmp/fm"));
    }

    #[test]
    fn empty_override_is_ignored() {
        let result = state_dir_from(env_of(&[("FULLMAG_STATE_DIR", "")]));
        // Without any other variable there is no state directory.
        assert!(matches!(result, Err(WorkspaceError::NoStateDir)));
    }

    #[cfg(windows)]
    #[test]
    fn windows_default_is_appdata() {
        let dir = state_dir_from(env_of(&[("APPDATA", r"C:\Users\x\AppData\Roaming")]));
        assert_eq!(
            dir.unwrap(),
            PathBuf::from(r"C:\Users\x\AppData\Roaming\Fullmag")
        );
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn linux_defaults_follow_xdg() {
        let dir = state_dir_from(env_of(&[("XDG_DATA_HOME", "/x/data"), ("HOME", "/h")]));
        assert_eq!(dir.unwrap(), PathBuf::from("/x/data/fullmag"));
        let dir = state_dir_from(env_of(&[("XDG_DATA_HOME", "rel"), ("HOME", "/h")]));
        assert_eq!(dir.unwrap(), PathBuf::from("/h/.local/share/fullmag"));
    }

    #[test]
    fn dot_segments_do_not_change_identity() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.py");
        std::fs::write(&file, "x = 1\n").unwrap();
        let direct = identity(&file).unwrap();
        let roundabout =
            identity(&dir.path().join("sub").join("..").join(".").join("a.py")).unwrap();
        assert_eq!(direct, roundabout);
    }

    #[test]
    fn missing_files_keep_a_stable_identity() {
        let dir = tempfile::tempdir().unwrap();
        let a = identity(&dir.path().join("nope").join("x.fms")).unwrap();
        let b = identity(
            &dir.path()
                .join("nope")
                .join("..")
                .join("nope")
                .join("x.fms"),
        )
        .unwrap();
        assert_eq!(a, b);
    }
}
