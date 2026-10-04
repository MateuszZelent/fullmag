//! Durable admission fencing for an explicitly owned development restart.
//!
//! WRITER is held only while checking idle state and publishing/removing the
//! marker. The marker survives process loss and has no implicit expiry.

use std::collections::BTreeSet;
use std::fs;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::SessionStore;
use crate::durability::{atomic_write, confirm_publication, sync_directory};
use crate::repository_path::{
    checked_path, create_parent, read_bounded_regular_file, reject_link, validate_store_id,
};
use crate::types::{FmsPreparationResourceLease, FmsResourceLease};

const FENCE_SCHEMA: &str = "fullmag.development-admission-fence.v1";
const FENCE_PATH: &str = "development/ADMISSION-FENCE.json";
const MAX_FENCE_BYTES: usize = 4096;

/// Full owner-bound record required for an explicit release. Neither age nor
/// process identity is evidence that another owner may remove this record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DevelopmentAdmissionFence {
    pub schema: String,
    pub owner_token: String,
    pub nonce: String,
    pub created_at: DateTime<Utc>,
}

impl DevelopmentAdmissionFence {
    pub(super) fn validate(&self) -> Result<()> {
        if self.schema != FENCE_SCHEMA {
            bail!("unsupported development admission fence schema");
        }
        validate_token(&self.owner_token)?;
        validate_token(&self.nonce)
    }
}

fn validate_token(token: &str) -> Result<()> {
    if token.len() > 128 {
        bail!("development admission fence token exceeds its byte budget");
    }
    validate_store_id(token).context("invalid development admission fence token")
}

impl SessionStore {
    /// Observe the strict durable marker without creating store data. Callers
    /// must compare the complete record with their received drain proof.
    pub fn read_development_idle_fence(&self) -> Result<Option<DevelopmentAdmissionFence>> {
        self.read_development_admission_fence_unlocked()
    }

    /// Atomically establish a persistent fence only after the entire store is
    /// idle. Replaying the same owner and nonce still rechecks global idleness.
    pub fn acquire_development_idle_fence(
        &self,
        owner_token: &str,
        nonce: &str,
    ) -> Result<DevelopmentAdmissionFence> {
        validate_token(owner_token)?;
        validate_token(nonce)?;
        let _writer = self.write_transaction()?;
        let existing = self.read_development_admission_fence_unlocked()?;
        if let Some(record) = &existing {
            if record.owner_token != owner_token || record.nonce != nonce {
                bail!("development admission fence is owned by another request");
            }
        }
        self.ensure_development_global_idle_unlocked()?;
        if let Some(record) = existing {
            // Recover an earlier publication whose directory barrier returned
            // an uncertain outcome without treating mere visibility as proof.
            confirm_publication(&checked_path(&self.root, FENCE_PATH)?)?;
            return Ok(record);
        }
        let record = DevelopmentAdmissionFence {
            schema: FENCE_SCHEMA.into(),
            owner_token: owner_token.into(),
            nonce: nonce.into(),
            created_at: Utc::now(),
        };
        let path = create_parent(&self.root, FENCE_PATH)?;
        atomic_write(&path, &serde_json::to_vec_pretty(&record)?)?;
        Ok(record)
    }

    /// Release only an exact full-record match; an absent or corrupt marker
    /// remains an error rather than an inferred successful release.
    pub fn release_development_idle_fence(
        &self,
        expected: &DevelopmentAdmissionFence,
    ) -> Result<()> {
        let _writer = self.write_transaction()?;
        super::development_commit::ensure_handoff_commit_absent_unlocked(self)?;
        expected.validate()?;
        let current = self
            .read_development_admission_fence_unlocked()?
            .context("development admission fence is absent")?;
        if &current != expected {
            bail!("development admission fence release owner/record mismatch");
        }
        let path = checked_path(&self.root, FENCE_PATH)?;
        fs::remove_file(&path)?;
        sync_directory(
            path.parent()
                .context("development fence parent is absent")?,
        )
    }

    /// Call only with WRITER held at an admission boundary. Terminal completion
    /// and lease release must remain possible while a fence exists.
    pub(super) fn ensure_development_admission_open_unlocked(&self) -> Result<()> {
        if self.read_development_admission_fence_unlocked()?.is_some() {
            bail!("development admission fence is closed");
        }
        Ok(())
    }

    fn read_development_admission_fence_unlocked(
        &self,
    ) -> Result<Option<DevelopmentAdmissionFence>> {
        let path = checked_path(&self.root, FENCE_PATH)?;
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
            Ok(_) => {}
        }
        let record: DevelopmentAdmissionFence = serde_json::from_slice(&read_bounded_regular_file(
            &self.root,
            FENCE_PATH,
            MAX_FENCE_BYTES,
        )?)
        .context("parsing development admission fence")?;
        record.validate()?;
        Ok(Some(record))
    }

    pub(super) fn ensure_development_global_idle_unlocked(&self) -> Result<()> {
        // Validate all compute and preparation metadata before existing scans
        // read it. Unknown entries, links and unbounded/nonregular files refuse
        // fencing even if they do not belong to a configured scheduler pool.
        let resources = self.scan_development_resource_metadata_unlocked()?;
        if self.active_run_intent_count_unlocked()? != 0 {
            bail!("development restart requires zero active durable run intents");
        }
        if !self.list_active_preparation_resource_leases()?.is_empty() {
            bail!("development restart requires zero active preparation resource leases");
        }
        for resource in resources {
            if self
                .find_active_resource_lease_unlocked(&resource)?
                .is_some()
            {
                bail!("development restart requires zero active compute resource leases");
            }
        }
        Ok(())
    }

    fn scan_development_resource_metadata_unlocked(&self) -> Result<BTreeSet<String>> {
        let runs = checked_path(&self.root, "runs")?;
        let mut resources = BTreeSet::new();
        let entries = match fs::read_dir(&runs) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(resources),
            Err(error) => return Err(error.into()),
        };
        for run in entries {
            let run = run?;
            reject_link(&run.path())?;
            if !run.file_type()?.is_dir() {
                bail!("development fence scan found a non-directory run entry");
            }
            let run_id = run.file_name().into_string().map_err(|_| {
                anyhow::anyhow!("development fence scan found a non-UTF8 run identifier")
            })?;
            validate_store_id(&run_id)?;
            // The existing idle predicate reads intent/catalog documents. Do
            // not let an unusual file type or oversized metadata reach it.
            for document in ["run_intent.json", "run_catalog.json"] {
                let relative = format!("runs/{run_id}/{document}");
                let path = checked_path(&self.root, &relative)?;
                match fs::symlink_metadata(&path) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                    Ok(_) => {}
                }
                let bytes = read_bounded_regular_file(
                    &self.root,
                    &relative,
                    crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
                )?;
                if document == "run_intent.json" {
                    let intent: crate::types::FmsRunIntent = serde_json::from_slice(&bytes)?;
                    intent.validate()?;
                    if intent.run_id != run_id {
                        bail!("development fence run intent path identity mismatch");
                    }
                } else {
                    let catalog: crate::types::FmsRunCatalog = serde_json::from_slice(&bytes)?;
                    catalog.validate()?;
                    if catalog.run_id != run_id {
                        bail!("development fence run catalog path identity mismatch");
                    }
                    // Catalog publication is legal independently of an intent.
                    // Never let an orphan projection evade the idle predicate.
                    if catalog.tasks.is_empty()
                        || catalog.tasks.iter().any(|task| {
                            !matches!(
                                task.lifecycle,
                                crate::types::FmsTaskLifecycle::Succeeded
                                    | crate::types::FmsTaskLifecycle::Failed
                                    | crate::types::FmsTaskLifecycle::Cancelled
                                    | crate::types::FmsTaskLifecycle::Interrupted
                            )
                        })
                    {
                        bail!("development restart requires terminal nonempty run catalogs");
                    }
                }
            }
            for family in ["resource_leases", "preparation_resource_leases"] {
                let relative = format!("runs/{run_id}/{family}");
                let directory = checked_path(&self.root, &relative)?;
                let entries = match fs::read_dir(&directory) {
                    Ok(entries) => entries,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                };
                for resource in entries {
                    let resource = resource?;
                    reject_link(&resource.path())?;
                    if !resource.file_type()?.is_dir() {
                        bail!("development fence scan found a non-directory resource entry");
                    }
                    let resource_id = resource.file_name().into_string().map_err(|_| {
                        anyhow::anyhow!(
                            "development fence scan found a non-UTF8 resource identifier"
                        )
                    })?;
                    validate_store_id(&resource_id)?;
                    if family == "resource_leases" {
                        resources.insert(resource_id.clone());
                    }
                    for entry in fs::read_dir(resource.path())? {
                        let entry = entry?;
                        let filename = entry.file_name().into_string().map_err(|_| {
                            anyhow::anyhow!(
                                "development fence scan found a non-UTF8 lease filename"
                            )
                        })?;
                        let token = filename
                            .strip_suffix(".json")
                            .context("development fence lease filename must end in .json")?;
                        validate_store_id(token)?;
                        let lease_relative = format!("{relative}/{resource_id}/{filename}");
                        let bytes = read_bounded_regular_file(
                            &self.root,
                            &lease_relative,
                            crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
                        )?;
                        let (lease_run, lease_resource, lease_token) =
                            if family == "resource_leases" {
                                let lease: FmsResourceLease = serde_json::from_slice(&bytes)?;
                                lease.validate()?;
                                (lease.run_id, lease.resource_id, lease.lease_token)
                            } else {
                                let lease: FmsPreparationResourceLease =
                                    serde_json::from_slice(&bytes)?;
                                lease.validate()?;
                                (lease.run_id, lease.resource_id, lease.lease_token)
                            };
                        if lease_run != run_id
                            || lease_resource != resource_id
                            || lease_token != token
                        {
                            bail!("development fence lease path identity mismatch");
                        }
                    }
                }
            }
        }
        Ok(resources)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        FmsResourceBudget, FmsResourceKind, FmsResourceLeaseState, FmsRunIntent,
        FMS_RESOURCE_LEASE_SCHEMA,
    };

    #[test]
    fn fence_is_persistent_owner_bound_and_replayable() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let record = store
            .acquire_development_idle_fence("owner-a", "request-a")
            .unwrap();
        assert_eq!(
            store
                .acquire_development_idle_fence("owner-a", "request-a")
                .unwrap(),
            record
        );
        assert!(store
            .acquire_development_idle_fence("owner-b", "request-a")
            .is_err());
        assert!(store
            .acquire_development_idle_fence("owner-a", "request-b")
            .is_err());
        let mut mismatch = record.clone();
        mismatch.created_at += chrono::Duration::seconds(1);
        assert!(store.release_development_idle_fence(&mismatch).is_err());
        drop(store);
        let reopened = SessionStore::open_existing(directory.path()).unwrap();
        assert!(reopened
            .ensure_development_admission_open_unlocked()
            .is_err());
        reopened.release_development_idle_fence(&record).unwrap();
        assert!(reopened
            .ensure_development_admission_open_unlocked()
            .is_ok());
    }

    #[test]
    fn accepted_intent_without_catalog_prevents_fence_and_replay() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let record = store
            .acquire_development_idle_fence("owner", "request")
            .unwrap();
        // Model already-persisted or unexpected work without bypassing the
        // production admission API's guard in this test.
        let intent = FmsRunIntent::new("run-busy", "intent-busy", serde_json::json!({}));
        let path = create_parent(store.root(), "runs/run-busy/run_intent.json").unwrap();
        atomic_write(&path, &serde_json::to_vec(&intent).unwrap()).unwrap();
        assert!(store
            .acquire_development_idle_fence("owner", "request")
            .is_err());
        assert_eq!(
            store.read_development_admission_fence_unlocked().unwrap(),
            Some(record)
        );
    }

    #[test]
    fn compute_lease_outside_any_pool_prevents_fence() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let now = Utc::now();
        let lease = FmsResourceLease {
            schema_version: FMS_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: "outside-pool".into(),
            kind: FmsResourceKind::Cpu,
            budget: FmsResourceBudget {
                cpu_millis: 100,
                memory_bytes: 1,
                gpu_memory_bytes: 0,
                storage_bytes: 1,
            },
            run_id: "run-orphan".into(),
            task_id: "task".into(),
            attempt_id: "attempt".into(),
            ownership_epoch: 1,
            lease_token: "lease".into(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
        };
        let path = create_parent(
            store.root(),
            "runs/run-orphan/resource_leases/outside-pool/lease.json",
        )
        .unwrap();
        atomic_write(&path, &serde_json::to_vec(&lease).unwrap()).unwrap();
        assert!(store
            .acquire_development_idle_fence("owner", "request")
            .is_err());
        assert!(!checked_path(store.root(), FENCE_PATH).unwrap().exists());
    }

    #[test]
    fn orphan_empty_catalog_prevents_fence() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let catalog = crate::types::FmsRunCatalog {
            schema_version: crate::types::FMS_RUN_CATALOG_SCHEMA.into(),
            run_id: "orphan".into(),
            revision: 1,
            updated_at: Utc::now(),
            tasks: vec![],
        };
        store.commit_run_catalog(&catalog).unwrap();
        assert!(store
            .acquire_development_idle_fence("owner", "request")
            .is_err());
        assert!(store.read_development_idle_fence().unwrap().is_none());
    }

    #[test]
    fn corrupt_or_unknown_fence_never_opens_admission() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let path = create_parent(store.root(), FENCE_PATH).unwrap();
        atomic_write(&path, br#"{"schema":"unknown"}"#).unwrap();
        assert!(store.ensure_development_admission_open_unlocked().is_err());
        assert!(store
            .acquire_development_idle_fence("owner", "request")
            .is_err());
        assert_eq!(fs::read(path).unwrap(), br#"{"schema":"unknown"}"#);
    }
}
