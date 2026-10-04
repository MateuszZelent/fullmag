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

/// Read bounded operational metadata from a regular file on a supported local FS.
/// The root and its ancestors must remain trusted, as with `checked_path`.
/// Unix nonblocking/no-follow flags prevent a replaced FIFO or final symlink
/// from turning observation into a blocking stream read. Validate the opened
/// handle as well as the path; Windows opens final reparse points themselves.
pub fn read_bounded_regular_file(root: &Path, relative: &str, maximum: usize) -> Result<Vec<u8>> {
    use std::io::Read;

    let limit = maximum
        .checked_add(1)
        .context("metadata byte limit overflow")?;
    crate::writer::require_local_filesystem(root)?;
    let path = checked_path(root, relative)?;
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.is_file() || metadata.len() > maximum as u64 {
        bail!("operational metadata must be a regular file within its byte budget");
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(&path)?;
    let opened = file.metadata()?;
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        opened.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let reparse = false;
    if !opened.is_file() || reparse || opened.len() > maximum as u64 {
        bail!("opened operational metadata is not a bounded regular file");
    }
    let mut bytes = Vec::new();
    file.take(limit as u64).read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        bail!("operational metadata exceeds its byte budget");
    }
    Ok(bytes)
}

/// Create a new directory under a trusted local repository root. Existing
/// leaves are never reused, including after a partially failed initialization.
/// Parent publication uses the platform's available durability barriers.
pub fn create_new_directory(root: &Path, relative: &str) -> Result<PathBuf> {
    crate::writer::require_local_filesystem(root)?;
    let path = create_parent(root, relative)?;
    fs::create_dir(&path)?;
    crate::durability::sync_directory(
        path.parent()
            .context("new repository directory has no parent")?,
    )?;
    checked_path(root, relative)
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
    fn bounded_metadata_reader_preserves_file_and_refuses_directory_or_oversize() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("metadata.json"), b"{}").unwrap();
        assert_eq!(
            read_bounded_regular_file(directory.path(), "metadata.json", 2).unwrap(),
            b"{}"
        );
        assert!(read_bounded_regular_file(directory.path(), "metadata.json", 1).is_err());
        fs::create_dir(directory.path().join("not-a-file")).unwrap();
        assert!(read_bounded_regular_file(directory.path(), "not-a-file", 100).is_err());
        assert_eq!(
            fs::read(directory.path().join("metadata.json")).unwrap(),
            b"{}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn bounded_metadata_reader_refuses_fifo_and_symlink_without_stream_read() {
        use std::os::unix::ffi::OsStrExt;
        let directory = tempfile::tempdir().unwrap();
        let fifo = directory.path().join("metadata.json");
        let fifo_name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) }, 0);
        assert!(read_bounded_regular_file(directory.path(), "metadata.json", 100).is_err());
        fs::write(directory.path().join("regular.json"), b"{}").unwrap();
        std::os::unix::fs::symlink(
            directory.path().join("regular.json"),
            directory.path().join("link.json"),
        )
        .unwrap();
        assert!(read_bounded_regular_file(directory.path(), "link.json", 100).is_err());
    }

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
