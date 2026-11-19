//! Process-local memo of validated accepted Study inputs.
//!
//! Loading an accepted Study decodes and re-hashes its catalog, verifies every
//! pinned asset and lowers the whole Study through the canonical planner. For
//! a FEM study with an inline mesh of about a million elements that is many
//! seconds of CPU, and the resident schedulers did it on every pass, so a FEM
//! run waited for admission indefinitely. The result depends only on the
//! store, the run, its RunSpec fingerprint and the content addresses of the
//! study and catalog objects, so it is reused for an identical key.
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::Result;
use fullmag_authoring::StudyPlan;
use fullmag_plan::{StudyExecutionPlan, StudyProblemCatalog};

/// One run's Study is typically all a process needs; keep one spare entry.
const CAPACITY: usize = 2;

pub(crate) type ValidatedAcceptedStudy = (StudyPlan, StudyProblemCatalog, StudyExecutionPlan);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AcceptedStudyKey {
    store_root: PathBuf,
    run_id: String,
    payload_sha256: String,
    study_ref: String,
    catalog_ref: String,
}

impl AcceptedStudyKey {
    pub(crate) fn new(
        store_root: &Path,
        run_id: &str,
        payload_sha256: &str,
        study_ref: &str,
        catalog_ref: &str,
    ) -> Self {
        Self {
            store_root: store_root.to_path_buf(),
            run_id: run_id.to_owned(),
            payload_sha256: payload_sha256.to_owned(),
            study_ref: study_ref.to_owned(),
            catalog_ref: catalog_ref.to_owned(),
        }
    }
}

type Entries<T> = Vec<(AcceptedStudyKey, Arc<T>)>;

static CACHE: Mutex<Entries<ValidatedAcceptedStudy>> = Mutex::new(Vec::new());

pub(crate) fn get_or_try_insert(
    key: AcceptedStudyKey,
    load: impl FnOnce() -> Result<ValidatedAcceptedStudy>,
) -> Result<Arc<ValidatedAcceptedStudy>> {
    get_or_try_insert_in(&CACHE, key, load)
}

/// The lock is not held while loading: two threads may validate the same
/// key once each, but a slow load never blocks unrelated callers. Failures
/// are not cached.
fn get_or_try_insert_in<T>(
    cache: &Mutex<Entries<T>>,
    key: AcceptedStudyKey,
    load: impl FnOnce() -> Result<T>,
) -> Result<Arc<T>> {
    if let Some(value) = lookup(cache, &key) {
        return Ok(value);
    }
    let value = Arc::new(load()?);
    let mut entries = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    entries.retain(|(existing, _)| existing != &key);
    entries.insert(0, (key, Arc::clone(&value)));
    entries.truncate(CAPACITY);
    Ok(value)
}

fn lookup<T>(cache: &Mutex<Entries<T>>, key: &AcceptedStudyKey) -> Option<Arc<T>> {
    let mut entries = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let index = entries.iter().position(|(existing, _)| existing == key)?;
    let entry = entries.remove(index);
    let value = Arc::clone(&entry.1);
    entries.insert(0, entry);
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(run: &str, payload: &str) -> AcceptedStudyKey {
        AcceptedStudyKey::new(Path::new("/store"), run, payload, "sha256:s", "sha256:c")
    }

    #[test]
    fn reuses_an_identical_key_and_reloads_a_changed_one() {
        let cache = Mutex::new(Vec::new());
        let loads = std::cell::Cell::new(0);
        let load = |value: u32| {
            let loads = &loads;
            move || {
                loads.set(loads.get() + 1);
                Ok(value)
            }
        };
        assert_eq!(
            *get_or_try_insert_in(&cache, key("run-a", "p1"), load(1)).unwrap(),
            1
        );
        assert_eq!(
            *get_or_try_insert_in(&cache, key("run-a", "p1"), load(2)).unwrap(),
            1
        );
        assert_eq!(
            *get_or_try_insert_in(&cache, key("run-a", "p2"), load(3)).unwrap(),
            3
        );
        assert_eq!(loads.get(), 2);
    }

    #[test]
    fn evicts_the_least_recent_entry_and_never_caches_failures() {
        let cache = Mutex::new(Vec::new());
        get_or_try_insert_in(&cache, key("run-a", "p"), || Ok(1)).unwrap();
        get_or_try_insert_in(&cache, key("run-b", "p"), || Ok(2)).unwrap();
        get_or_try_insert_in(&cache, key("run-a", "p"), || Ok(9)).unwrap();
        get_or_try_insert_in(&cache, key("run-c", "p"), || Ok(3)).unwrap();
        assert_eq!(
            *get_or_try_insert_in(&cache, key("run-a", "p"), || Ok(9)).unwrap(),
            1
        );
        assert_eq!(
            *get_or_try_insert_in(&cache, key("run-b", "p"), || Ok(8)).unwrap(),
            8
        );

        assert!(
            get_or_try_insert_in(&cache, key("run-d", "p"), || anyhow::bail!("missing")).is_err()
        );
        assert_eq!(
            *get_or_try_insert_in(&cache, key("run-d", "p"), || Ok(4)).unwrap(),
            4
        );
    }
}
