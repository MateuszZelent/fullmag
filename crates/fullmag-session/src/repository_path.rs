//! Portable repository names and containment checks shared by all persistence writers.
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

/// A stored identifier is exactly one portable component, never a path.
pub fn validate_store_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 200
        || !id.is_ascii()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        || id == "."
        || id == ".."
        || id.ends_with('.')
    {
        bail!("invalid repository identifier `{id}`");
    }
    let stem = id
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || (stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        bail!("reserved repository identifier `{id}`");
    }
    Ok(())
}

pub fn validate_relative_path(path: &str) -> Result<()> {
    if path.is_empty() || path.contains('\\') || path.starts_with('/') || path.ends_with('/') {
        bail!("unsafe repository path `{path}`");
    }
    for component in path.split('/') {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.len() > 255
            || component.ends_with([' ', '.'])
            || component
                .chars()
                .any(|c| c.is_control() || "<>:\"|?*".contains(c))
        {
            bail!("unsafe repository path `{path}`");
        }
        let stem = component
            .split('.')
            .next()
            .unwrap_or_default()
            .trim_end_matches(' ')
            .to_ascii_uppercase();
        if matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(*prefix)
                .is_some_and(|suffix| matches!(suffix, "¹" | "²" | "³"))
        }) || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            bail!("reserved repository path `{path}`");
        }
    }
    Ok(())
}

pub(crate) fn reject_link(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            #[cfg(windows)]
            let reparse = {
                use std::os::windows::fs::MetadataExt;
                metadata.file_attributes() & 0x400 != 0
            };
            #[cfg(not(windows))]
            let reparse = false;
            if metadata.file_type().is_symlink() || reparse {
                bail!(
                    "repository symlink/reparse point is not permitted: {}",
                    path.display()
                );
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).with_context(|| format!("checking {}", path.display())),
    }
    Ok(())
}

/// Resolve a name below a trusted root, rejecting existing links at every level.
/// The repository must not be writable by untrusted local processes.
pub fn checked_path(root: &Path, relative: &str) -> Result<PathBuf> {
    validate_relative_path(relative)?;
    reject_link(root)?;
    let canonical_root = fs::canonicalize(root)?;
    let mut path = root.to_path_buf();
    for component in relative.split('/') {
        path.push(component);
        reject_link(&path)?;
        if path.exists() && !fs::canonicalize(&path)?.starts_with(&canonical_root) {
            bail!("repository path escapes root: {}", path.display());
        }
    }
    Ok(path)
}

pub(crate) fn create_parent(root: &Path, relative: &str) -> Result<PathBuf> {
    checked_path(root, relative)?;
    let mut directory = root.to_path_buf();
    let components: Vec<_> = relative.split('/').collect();
    for component in &components[..components.len() - 1] {
        let child = directory.join(component);
        if !child.exists() {
            fs::create_dir(&child)?;
            crate::durability::sync_directory(&directory)?;
        }
        reject_link(&child)?;
        directory = child;
    }
    checked_path(root, relative)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_project_names_preserve_spaces_and_unicode() {
        assert!(validate_relative_path("project/siatka próbna.json").is_ok());
        assert!(validate_relative_path("project/assets/My mesh.vtu").is_ok());
        assert!(validate_relative_path("project/assets/CON.json").is_err());
    }

    #[test]
    fn identifiers_cannot_select_a_path_or_windows_alias() {
        for id in [
            "",
            ".",
            "..",
            "../escape",
            "/absolute",
            "C:drive",
            "a\\b",
            "NUL",
            "con.json",
            "COM1",
            "trailing.",
            "trailing ",
        ] {
            assert!(validate_store_id(id).is_err(), "{id}");
        }
        for id in ["session-1", "cp-000012", "model.v1", "a_b"] {
            validate_store_id(id).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn existing_link_cannot_redirect_a_write() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("store");
        let outside = directory.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("project")).unwrap();
        assert!(create_parent(&root, "project/escape.json").is_err());
        assert!(!outside.join("escape.json").exists());
    }

    #[cfg(windows)]
    #[test]
    fn existing_junction_cannot_redirect_a_write() {
        use std::process::Command;

        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("store");
        let outside = directory.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        let junction = root.join("project");

        // Junctions do not require the symlink privilege.  Pass each path as
        // an argument so this fixture never builds an interpolated shell path.
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .status()
            .unwrap();
        if !status.success() {
            let _ = fs::remove_dir(&junction);
            panic!("mklink /J failed with status {status:?}");
        }

        let rejected = create_parent(&root, "project/escape.json");
        let target_was_not_modified = !outside.join("escape.json").exists();
        // A junction is removed as a directory entry.  Never recurse through
        // it, because the target is deliberately outside the repository.
        fs::remove_dir(&junction).unwrap();

        assert!(rejected.is_err());
        assert!(target_was_not_modified);
        assert!(outside.is_dir());
    }
}
