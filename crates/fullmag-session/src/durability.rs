//! File publication barriers. Power-loss qualification is platform-specific.
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// The publication reached the destination rename, but the post-rename
/// directory barrier did not complete. The caller must treat the outcome as
/// unknown and reconcile the destination before retrying.
#[derive(Debug)]
pub struct PublicationUncertain {
    destination: PathBuf,
    cause: anyhow::Error,
}

/// A private store's writer release could not be confirmed before rename.
/// Preserve the staging root for controlled recovery; no publication occurred.
#[derive(Debug)]
pub struct WriterReleaseUnconfirmed {
    staging: PathBuf,
    cause: anyhow::Error,
}
impl std::fmt::Display for WriterReleaseUnconfirmed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "writer release for {} is unconfirmed: {}", self.staging.display(), self.cause)
    }
}
impl std::error::Error for WriterReleaseUnconfirmed {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause.root_cause()) }
}

impl PublicationUncertain {
    pub(crate) fn new(destination: PathBuf, cause: anyhow::Error) -> Self {
        Self { destination, cause }
    }

    pub fn destination(&self) -> &Path {
        &self.destination
    }
}

impl std::fmt::Display for PublicationUncertain {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "publication of {} is uncertain after rename: {}",
            self.destination.display(),
            self.cause
        )
    }
}

impl std::error::Error for PublicationUncertain {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.cause.root_cause())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectorySyncCapability {
    Available,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerLossCapability {
    /// No power-loss qualification is implied by the file barriers alone.
    Unverified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DurabilityCapability {
    pub file_sync: bool,
    pub directory_sync: DirectorySyncCapability,
    pub power_loss: PowerLossCapability,
}

/// Report the barriers available on this build's platform. A successful
/// `sync_all` or directory sync is not itself a power-loss qualification.
pub const fn durability_capability() -> DurabilityCapability {
    DurabilityCapability {
        file_sync: true,
        directory_sync: if cfg!(unix) {
            DirectorySyncCapability::Available
        } else {
            DirectorySyncCapability::Unavailable
        },
        power_loss: PowerLossCapability::Unverified,
    }
}

#[cfg(test)]
thread_local! {
    static FAIL_PUBLICATION_AFTER: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
    static FAIL_DIRECTORY_BARRIER_FOR: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn fail_publication_after(successful_publications: usize) {
    FAIL_PUBLICATION_AFTER.with(|value| value.set(Some(successful_publications)));
}

/// Inject a directory-barrier failure for one exact destination after its
/// rename.  This is a test-only fault model: it exercises the uncertainty
/// contract without claiming to reproduce an actual power loss.
#[cfg(test)]
pub(crate) fn fail_directory_barrier_for(destination: &Path) {
    FAIL_DIRECTORY_BARRIER_FOR.with(|value| {
        *value.borrow_mut() = Some(destination.to_path_buf());
    });
}

#[cfg(test)]
fn take_directory_barrier_failure(destination: &Path) -> bool {
    FAIL_DIRECTORY_BARRIER_FOR.with(|value| {
        let matches = value
            .borrow()
            .as_deref()
            .is_some_and(|expected| expected == destination);
        if matches {
            *value.borrow_mut() = None;
        }
        matches
    })
}

#[cfg(test)]
fn consume_publication_failpoint() -> Result<()> {
    FAIL_PUBLICATION_AFTER.with(|value| -> Result<()> {
        match value.get() {
            Some(0) => {
                value.set(None);
                anyhow::bail!("injected interruption before publication")
            }
            Some(count) => value.set(Some(count - 1)),
            None => {}
        }
        Ok(())
    })
}

#[cfg(not(test))]
fn consume_publication_failpoint() -> Result<()> {
    Ok(())
}

pub(crate) fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    // Windows does not expose a portable directory fsync through std::fs.
    // File data is synced, but directory power-loss durability is NOT VERIFIED.
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Re-establish the available durability barriers for an already visible
/// immutable record. Call only while holding its store writer lease and after
/// verifying exact payload identity. Visibility alone is not confirmation.
pub(crate) fn confirm_publication(dest: &Path) -> Result<()> {
    let result = (|| {
        File::options()
            .read(true)
            .write(true)
            .open(dest)?
            .sync_all()?;
        let parent = dest
            .parent()
            .context("publication has no parent directory")?;
        sync_directory(parent)?;
        #[cfg(test)]
        if take_directory_barrier_failure(dest) {
            anyhow::bail!("injected directory barrier failure during confirmation");
        }
        Ok(())
    })();
    result.map_err(|error| anyhow::Error::new(PublicationUncertain::new(dest.to_path_buf(), error)))
}

/// Unique, exclusive staging beside the target; no shared `.part` pathname.
///
/// This is the data publication path and therefore consumes the test fault
/// injector. Owner metadata uses `atomic_write_owner`, which deliberately does
/// not consume that data-only failpoint.
pub(crate) fn atomic_write(dest: &Path, data: &[u8]) -> Result<()> {
    atomic_write_impl(dest, true, |file| {
        file.write_all(data)?;
        Ok(())
    })
}

/// Publish writer-owner metadata atomically without consuming data fault
/// injection. The lock descriptor itself is never replaced by this function.
pub(crate) fn atomic_write_owner(dest: &Path, data: &[u8]) -> Result<()> {
    atomic_write_impl(dest, false, |file| {
        file.write_all(data)?;
        Ok(())
    })
}

/// Publish a source file after verifying its complete content identity.
///
/// The source is copied into the same uniquely-owned sibling staging file as
/// byte writes.  The copy helper hashes and length-checks the source before
/// this function reaches the rename, so a failed verification cannot replace
/// the previous destination generation.
pub(crate) fn atomic_write_verified_file(
    dest: &Path,
    source: &Path,
    expected_hash: &str,
    expected_length: u64,
) -> Result<()> {
    crate::repository_path::reject_link(source)?;
    atomic_write_impl(dest, true, |file| {
        crate::cas::copy_verified_file(source, expected_hash, expected_length, file)
    })
}

fn atomic_write_impl(
    dest: &Path,
    consume_data_failpoint: bool,
    write_data: impl FnOnce(&mut File) -> Result<()>,
) -> Result<()> {
    let parent = dest
        .parent()
        .context("publication has no parent directory")?;
    let temporary = parent.join(format!(".{}.part", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = File::create_new(&temporary)?;
        write_data(&mut file)?;
        file.sync_all()?;
        drop(file);
        if consume_data_failpoint {
            consume_publication_failpoint()?;
        }
        fs::rename(&temporary, dest).with_context(|| format!("publishing {}", dest.display()))?;
        let barrier = sync_directory(parent);
        #[cfg(test)]
        if take_directory_barrier_failure(dest) {
            let cause = barrier
                .err()
                .unwrap_or_else(|| anyhow::anyhow!("injected directory barrier failure"));
            return Err(anyhow::Error::new(PublicationUncertain::new(
                dest.to_path_buf(),
                cause,
            )));
        }
        barrier.map_err(|error| {
            anyhow::Error::new(PublicationUncertain::new(dest.to_path_buf(), error))
        })
    })();
    if result.is_err() {
        // Only our uniquely-owned unpublished staging file may be removed.
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(target_os = "linux")]
fn rename_directory_noreplace(staging: &Path, destination: &Path) -> Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let staging = CString::new(staging.as_os_str().as_bytes())
        .context("directory staging path contains an embedded NUL")?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .context("directory destination path contains an embedded NUL")?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            staging.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error()).with_context(|| {
            format!(
                "publishing directory {} without replacing an existing destination",
                destination.to_string_lossy()
            )
        });
    }
    Ok(())
}

#[cfg(windows)]
fn rename_directory_noreplace(staging: &Path, destination: &Path) -> Result<()> {
    use std::{ffi::OsStr, iter::once, os::windows::ffi::OsStrExt};

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }

    let staging_wide = OsStr::new(staging.as_os_str())
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let destination_wide = OsStr::new(destination.as_os_str())
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let moved = unsafe { MoveFileExW(staging_wide.as_ptr(), destination_wide.as_ptr(), 0) };
    if moved == 0 {
        return Err(std::io::Error::last_os_error()).with_context(|| {
            format!(
                "publishing directory {} without replacing an existing destination",
                destination.display()
            )
        });
    }
    Ok(())
}

#[cfg(not(any(target_os = "linux", windows)))]
fn rename_directory_noreplace(staging: &Path, destination: &Path) -> Result<()> {
    anyhow::bail!(
        "directory publication without replacement is unsupported on this platform: {} -> {}",
        staging.display(),
        destination.display()
    );
}

/// Publish a private directory staging root as a new destination.
///
/// The source and destination must be sibling paths on the same canonical
/// parent.  The destination is create-only: an existing entry is never
/// replaced.  After rename, every error is recoverable evidence of an
/// uncertain publication; this function deliberately never removes either
/// path after the rename. The caller must finish all writes, release writer
/// leases, and close the private staging store before moving its root; writer
/// ownership records must not be updated through the old path after rename.
/// Platform-specific no-replace rename protects against a different publisher
/// racing for the same destination. Unsupported platforms fail closed.
pub fn publish_directory(staging: &Path, destination: &Path) -> Result<()> {
    crate::repository_path::reject_link(staging)?;
    crate::repository_path::reject_link(destination)?;

    let staging_parent = staging
        .parent()
        .context("directory staging path has no parent")?;
    let destination_parent = destination
        .parent()
        .context("directory destination has no parent")?;
    crate::repository_path::reject_link(staging_parent)?;
    crate::repository_path::reject_link(destination_parent)?;

    let staging_parent = fs::canonicalize(staging_parent)
        .with_context(|| format!("canonicalizing staging parent {}", staging_parent.display()))?;
    let destination_parent = fs::canonicalize(destination_parent).with_context(|| {
        format!(
            "canonicalizing destination parent {}",
            destination_parent.display()
        )
    })?;
    if staging_parent != destination_parent {
        anyhow::bail!("directory publication requires one canonical parent");
    }

    let staging_metadata = fs::symlink_metadata(staging)
        .with_context(|| format!("reading directory staging {}", staging.display()))?;
    if !staging_metadata.is_dir() {
        anyhow::bail!("directory staging path is not a directory: {}", staging.display());
    }
    match fs::symlink_metadata(destination) {
        Ok(_) => anyhow::bail!(
            "directory publication destination already exists: {}",
            destination.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    // Writer release errors are logged by Drop; confirm its durable record
    // here so a failed release cannot be hidden by moving the old pathname.
    (|| -> Result<()> {
        let owner_path = crate::repository_path::checked_path(staging, "WRITER.owner.json")?;
        if owner_path.exists() {
            use std::io::Read;
            let mut bytes = Vec::new();
            File::open(&owner_path)?.take(64 * 1024 + 1).read_to_end(&mut bytes)?;
            if bytes.len() > 64 * 1024 { anyhow::bail!("writer owner record exceeds publication metadata budget"); }
            let owner: serde_json::Value = serde_json::from_slice(&bytes)?;
            if owner.get("schema").and_then(|value| value.as_str()) != Some("fullmag.writer.v1")
                || owner.get("released").and_then(|value| value.as_bool()) != Some(true) {
                anyhow::bail!("private directory writer release is not confirmed before publication");
            }
        }
        Ok(())
    })().map_err(|cause| anyhow::Error::new(WriterReleaseUnconfirmed {
        staging: staging.to_path_buf(), cause,
    }))?;
    consume_publication_failpoint()?;
    rename_directory_noreplace(staging, destination)?;

    let barrier = sync_directory(&destination_parent);
    #[cfg(test)]
    if take_directory_barrier_failure(destination) {
        let cause = barrier
            .err()
            .unwrap_or_else(|| anyhow::anyhow!("injected directory barrier failure"));
        return Err(anyhow::Error::new(PublicationUncertain::new(
            destination.to_path_buf(),
            cause,
        )));
    }
    barrier.map_err(|error| {
        anyhow::Error::new(PublicationUncertain::new(destination.to_path_buf(), error))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FmsSessionManifest, SaveProfile, SessionStore};

    #[test]
    fn interrupted_replacement_preserves_previous_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("document.json");
        atomic_write(&path, b"previous").unwrap();
        fail_publication_after(0);
        assert!(atomic_write(&path, b"candidate").is_err());
        assert_eq!(fs::read(path).unwrap(), b"previous");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn owner_publication_does_not_consume_data_failpoint() {
        let directory = tempfile::tempdir().unwrap();
        let owner = directory.path().join("WRITER.owner.json");
        let data = directory.path().join("document.json");

        fail_publication_after(0);
        atomic_write_owner(&owner, br#"{"released":false}"#).unwrap();
        assert_eq!(fs::read(&owner).unwrap(), br#"{"released":false}"#);

        assert!(atomic_write(&data, b"candidate").is_err());
        assert!(!data.exists());
    }

    #[test]
    fn verified_file_publication_rejects_identity_before_replacing_destination() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.bin");
        let destination = directory.path().join("document.bin");
        fs::write(&source, b"candidate bytes").unwrap();
        atomic_write(&destination, b"previous bytes").unwrap();

        assert!(atomic_write_verified_file(
            &destination,
            &source,
            &crate::cas::hex_sha256(b"candidate bytes"),
            u64::try_from(b"candidate bytes".len()).unwrap() - 1,
        )
        .is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"previous bytes");

        assert!(atomic_write_verified_file(
            &destination,
            &source,
            &"0".repeat(64),
            u64::try_from(b"candidate bytes".len()).unwrap(),
        )
        .is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"previous bytes");
        assert!(!fs::read_dir(directory.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.file_name().to_string_lossy().ends_with(".part")));
    }

    #[test]
    fn verified_file_publication_reports_post_rename_barrier_uncertainty() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.bin");
        let destination = directory.path().join("document.bin");
        let data = b"candidate bytes";
        fs::write(&source, data).unwrap();
        fail_directory_barrier_for(&destination);

        let error = atomic_write_verified_file(
            &destination,
            &source,
            &crate::cas::hex_sha256(data),
            u64::try_from(data.len()).unwrap(),
        )
        .unwrap_err();
        assert!(error.downcast_ref::<PublicationUncertain>().is_some());
        assert_eq!(fs::read(&destination).unwrap(), data);
    }

    #[test]
    fn post_rename_directory_barrier_is_publication_uncertain() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("document.json");
        atomic_write(&path, b"previous").unwrap();

        fail_directory_barrier_for(&path);
        let error = atomic_write(&path, b"candidate").unwrap_err();
        let uncertain = error
            .downcast_ref::<PublicationUncertain>()
            .expect("post-rename barrier failure must be typed as uncertain");
        assert_eq!(uncertain.destination(), path.as_path());
        // The rename already happened.  The in-process result is observable,
        // while an actual power loss remains outside this simulated test.
        assert_eq!(fs::read(&path).unwrap(), b"candidate");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn directory_publication_requires_confirmed_private_store_writer_release() {
        let directory = tempfile::tempdir().unwrap();
        let staging = directory.path().join("staging");
        let destination = directory.path().join("published");
        let store = crate::store::SessionStore::open(&staging).unwrap();
        let lease = store.write_transaction().unwrap();
        assert!(publish_directory(&staging, &destination).is_err());
        assert!(staging.exists());
        assert!(!destination.exists());
        drop(lease);
        drop(store);
        publish_directory(&staging, &destination).unwrap();
        let owner: serde_json::Value = serde_json::from_slice(
            &fs::read(destination.join("WRITER.owner.json")).unwrap()).unwrap();
        assert_eq!(owner["released"], true);
    }

    #[test]
    fn directory_publication_reports_post_rename_barrier_uncertainty() {
        let directory = tempfile::tempdir().unwrap();
        let staging = directory.path().join("staging");
        let destination = directory.path().join("published");
        fs::create_dir(&staging).unwrap();
        fs::write(staging.join("payload"), b"payload").unwrap();

        fail_directory_barrier_for(&destination);
        let error = publish_directory(&staging, &destination).unwrap_err();
        let uncertain = error
            .downcast_ref::<PublicationUncertain>()
            .expect("directory barrier failure must be typed as uncertain");
        assert_eq!(uncertain.destination(), destination.as_path());
        assert!(!staging.exists());
        assert_eq!(fs::read(destination.join("payload")).unwrap(), b"payload");
    }

    #[cfg(any(target_os = "linux", windows))]
    #[test]
    fn directory_rename_never_replaces_existing_destination() {
        let directory = tempfile::tempdir().unwrap();
        let staging = directory.path().join("staging");
        let destination = directory.path().join("published");
        fs::create_dir(&staging).unwrap();
        fs::write(staging.join("candidate"), b"candidate").unwrap();
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("existing"), b"existing").unwrap();

        assert!(rename_directory_noreplace(&staging, &destination).is_err());
        assert!(staging.is_dir());
        assert_eq!(fs::read(destination.join("existing")).unwrap(), b"existing");
        assert!(!destination.join("candidate").exists());
    }

    #[test]
    fn current_barrier_uncertainty_keeps_both_manifest_generations() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let first = FmsSessionManifest::new("session-one", "first", SaveProfile::Compact);
        store.commit_session(&first).unwrap();

        let current_path = store.root().join("CURRENT");
        let previous_generation = fs::read_to_string(&current_path).unwrap();
        let previous_manifest = store
            .root()
            .join("manifests")
            .join(format!("{previous_generation}.json"));
        assert!(previous_manifest.is_file());

        let second = FmsSessionManifest::new("session-two", "second", SaveProfile::Compact);
        fail_directory_barrier_for(&current_path);
        let error = store.commit_session(&second).unwrap_err();
        let uncertain = error
            .downcast_ref::<PublicationUncertain>()
            .expect("CURRENT barrier failure must be typed as uncertain");
        assert_eq!(uncertain.destination(), current_path.as_path());

        let current_generation = fs::read_to_string(&current_path).unwrap();
        assert_ne!(current_generation, previous_generation);
        let current_manifest = store
            .root()
            .join("manifests")
            .join(format!("{current_generation}.json"));
        assert!(previous_manifest.is_file());
        assert!(current_manifest.is_file());
        let previous: FmsSessionManifest =
            serde_json::from_slice(&fs::read(previous_manifest).unwrap()).unwrap();
        let current: FmsSessionManifest =
            serde_json::from_slice(&fs::read(current_manifest).unwrap()).unwrap();
        assert_eq!(previous.name, "first");
        assert_eq!(current.name, "second");
    }
}
