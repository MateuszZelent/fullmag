//! A source locator becomes usable only after its read-only backing bytes match.
//! This is separate from execution input identity and grants no Compute authority.

use std::{fs, io::Read, path::{Path, PathBuf}};

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
pub(super) const SOURCE_ROOT: &str = "/opt/fullmag/source";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceOrigin {
    schema: String,
    source_relative: String,
    source_sha256: String,
    source_size_bytes: u64,
}

/// Constructed only by checking the pinned bytes under the selected source mount.
/// In particular, a deserialized path can never directly enter the live manifest.
#[derive(Debug)]
pub(crate) struct VerifiedSourceOrigin {
    script_path: PathBuf,
}

impl VerifiedSourceOrigin {
    pub(crate) fn script_path(&self) -> &Path {
        &self.script_path
    }
}

fn same_file(before: &fs::Metadata, after: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        before.dev() == after.dev() && before.ino() == after.ino()
            && before.nlink() == 1 && after.nlink() == 1
            && before.len() == after.len()
            && before.mtime() == after.mtime() && before.mtime_nsec() == after.mtime_nsec()
            && before.ctime() == after.ctime() && before.ctime_nsec() == after.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        before.is_file() && after.is_file() && before.len() == after.len()
            && before.modified().ok() == after.modified().ok()
    }
}

pub(in crate::development_accepted_restore) fn verify_optional(
    root: &Path, value: Option<&Value>,
) -> Result<Option<VerifiedSourceOrigin>> {
    let Some(value) = value else { return Ok(None) };
    let origin: SourceOrigin = serde_json::from_value(value.clone())
        .context("terminal source origin has an invalid closed shape")?;
    if origin.schema != "fullmag.selected-script-origin.v1"
        || origin.source_size_bytes == 0 || origin.source_size_bytes > MAX_SOURCE_BYTES
        || origin.source_relative.len() > 1024
    {
        bail!("terminal source origin schema, path or byte budget differs");
    }
    super::validate_digest(&origin.source_sha256, "terminal source origin")?;
    // This source mount may be a supported Windows 9p checkout. Unlike durable
    // SessionStore metadata, reading it must not require a local filesystem.
    let path = fullmag_session::repository_path::checked_path(root, &origin.source_relative)?;
    let before = fs::symlink_metadata(&path)?;
    if !before.is_file() || before.len() != origin.source_size_bytes {
        bail!("terminal source origin is not the pinned regular file");
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let mut file = options.open(&path)?;
    let opened = file.metadata()?;
    if !opened.is_file() || !same_file(&before, &opened) {
        bail!("terminal source origin changed while opening");
    }
    let mut hasher = Sha256::new();
    let mut read_bytes = 0_u64;
    let mut buffer = [0_u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 { break }
        read_bytes = read_bytes.checked_add(count as u64).context("source byte count overflow")?;
        if read_bytes > origin.source_size_bytes {
            bail!("terminal source origin grew while reading");
        }
        hasher.update(&buffer[..count]);
    }
    // The bind mount is read only to the application. As with checked_path,
    // cooperating host edits must remain quiesced during this observation.
    let checked = fullmag_session::repository_path::checked_path(root, &origin.source_relative)?;
    if read_bytes != origin.source_size_bytes
        || format!("{:x}", hasher.finalize()) != origin.source_sha256
        || !same_file(&opened, &file.metadata()?)
        || !same_file(&opened, &fs::symlink_metadata(&checked)?)
    {
        bail!("terminal source origin backing bytes changed or differ from their pin");
    }
    Ok(Some(VerifiedSourceOrigin { script_path: checked }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> (tempfile::TempDir, serde_json::Value) {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("examples")).unwrap();
        let bytes = b"# source origin fixture\n";
        std::fs::write(root.path().join("examples/model.py"), bytes).unwrap();
        let dto = json!({
            "schema": "fullmag.selected-script-origin.v1",
            "source_relative": "examples/model.py",
            "source_sha256": fullmag_session::hex_sha256(bytes),
            "source_size_bytes": bytes.len(),
        });
        (root, dto)
    }

    #[test]
    fn legacy_absence_remains_absent_and_valid_origin_is_read_only() {
        let (root, dto) = fixture();
        assert!(verify_optional(root.path(), None).unwrap().is_none());
        let before = std::fs::read(root.path().join("examples/model.py")).unwrap();
        let origin = verify_optional(root.path(), Some(&dto)).unwrap().unwrap();
        assert_eq!(origin.script_path(), root.path().join("examples/model.py"));
        assert_eq!(std::fs::read(origin.script_path()).unwrap(), before);
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn claimed_origin_rejects_changed_bytes_and_closed_shape_violations() {
        let (root, dto) = fixture();
        for (key, value) in [
            ("schema", json!("other")),
            ("source_relative", json!("../model.py")),
            ("source_relative", json!("examples//model.py")),
            ("source_relative", json!("examples/CON.py")),
            ("source_sha256", json!("A".repeat(64))),
            ("source_sha256", json!("0".repeat(64))),
            ("source_size_bytes", json!(0)),
            ("source_size_bytes", json!(true)),
            ("source_size_bytes", json!(64 * 1024 * 1024 + 1)),
            ("source_size_bytes", json!(1)),
            ("untrusted_script_path", json!("/outside.py")),
        ] {
            let mut changed = dto.clone();
            changed[key] = value;
            assert!(verify_optional(root.path(), Some(&changed)).is_err(), "{key}: {changed}");
        }
        assert!(verify_optional(root.path(), Some(&serde_json::Value::Null)).is_err());
        std::fs::write(root.path().join("examples/model.py"), b"# changed source\n").unwrap();
        assert!(verify_optional(root.path(), Some(&dto)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn origin_rejects_component_links_leaf_links_hard_links_and_fifo() {
        use std::os::unix::fs::symlink;
        let (root, dto) = fixture();
        let path = root.path().join("examples/model.py");
        let retained = root.path().join("retained.py");
        std::fs::rename(&path, &retained).unwrap();
        symlink(&retained, &path).unwrap();
        assert!(verify_optional(root.path(), Some(&dto)).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::hard_link(&retained, &path).unwrap();
        assert!(verify_optional(root.path(), Some(&dto)).is_err());
        std::fs::remove_file(&path).unwrap();
        let fifo = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(verify_optional(root.path(), Some(&dto)).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(root.path().join("examples")).unwrap();
        symlink(root.path(), root.path().join("examples")).unwrap();
        assert!(verify_optional(root.path(), Some(&dto)).is_err());
    }
}
