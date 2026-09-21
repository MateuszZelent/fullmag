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

pub(crate) fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    // Windows does not expose a portable directory fsync through std::fs.
    // File data is synced, but directory power-loss durability is NOT VERIFIED.
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Unique, exclusive staging beside the target; no shared `.part` pathname.
///
/// This is the data publication path and therefore consumes the test fault
/// injector. Owner metadata uses `atomic_write_owner`, which deliberately does
/// not consume that data-only failpoint.
pub(crate) fn atomic_write(dest: &Path, data: &[u8]) -> Result<()> {
    atomic_write_impl(dest, data, true)
}

/// Publish writer-owner metadata atomically without consuming data fault
/// injection. The lock descriptor itself is never replaced by this function.
pub(crate) fn atomic_write_owner(dest: &Path, data: &[u8]) -> Result<()> {
    atomic_write_impl(dest, data, false)
}

fn atomic_write_impl(dest: &Path, data: &[u8], consume_data_failpoint: bool) -> Result<()> {
    let parent = dest
        .parent()
        .context("publication has no parent directory")?;
    let temporary = parent.join(format!(".{}.part", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = File::create_new(&temporary)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        if consume_data_failpoint {
            #[cfg(test)]
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
            })?;
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
