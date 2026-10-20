//! A durable explicit-start grant for prepared accepted runs.
//!
//! Preparation may proceed while a manual run waits. Compute admission must
//! read the immutable policy carried by the accepted RunSpec and the exact
//! release bound to that specification; queue omission alone is not a gate.

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::SessionStore;
use crate::repository_path::{
    checked_path, create_parent, read_bounded_regular_file, validate_store_id,
};
use crate::types::FmsRunIntent;

pub const ACCEPTED_RUN_START_POLICY_KEY: &str = "fullmag.accepted_run_start";
const POLICY_SCHEMA: &str = "accepted_run_start_policy.v1";
const RELEASE_SCHEMA: &str = "accepted_run_start_release.v1";
const MAX_RELEASE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct StartPolicy {
    schema_version: String,
    mode: StartMode,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum StartMode {
    Automatic,
    Manual,
}

/// Immutable evidence that the operator released this exact accepted run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedRunStartRelease {
    pub schema_version: String,
    pub run_id: String,
    pub specification_sha256: String,
    pub request_id: String,
    pub released_at: DateTime<Utc>,
}

fn manual_policy(intent: &FmsRunIntent) -> Result<bool> {
    intent.validate()?;
    let Some(value) = intent
        .specification
        .get("parameters")
        .and_then(Value::as_object)
        .and_then(|parameters| parameters.get(ACCEPTED_RUN_START_POLICY_KEY))
    else {
        // Compatibility: accepted runs predating this optional policy keep
        // their existing automatic scheduling semantics.
        return Ok(false);
    };
    let policy: StartPolicy =
        serde_json::from_value(value.clone()).context("invalid accepted run start policy")?;
    if policy.schema_version != POLICY_SCHEMA {
        bail!("unsupported accepted run start policy schema");
    }
    Ok(matches!(policy.mode, StartMode::Manual))
}

fn validate_digest(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("start release requires the exact lowercase specification SHA-256");
    }
    Ok(())
}

impl AcceptedRunStartRelease {
    pub(crate) fn validate_for(&self, intent: &FmsRunIntent) -> Result<()> {
        validate_store_id(&self.run_id)?;
        validate_store_id(&self.request_id)?;
        validate_digest(&self.specification_sha256)?;
        if self.schema_version != RELEASE_SCHEMA
            || self.run_id != intent.run_id
            || self.specification_sha256 != intent.payload_sha256
            || !manual_policy(intent)?
        {
            bail!("accepted run start release differs from its immutable manual RunSpec");
        }
        Ok(())
    }
}

impl SessionStore {
    /// Missing release keeps a manual run held, including after API restart.
    /// This read never changes task readiness or preparation ownership.
    pub fn accepted_run_start_permitted(&self, run_id: &str) -> Result<bool> {
        let intent = self
            .read_run_intent(run_id)?
            .context("accepted start gate requires its immutable run intent")?;
        if !manual_policy(&intent)? {
            return Ok(true);
        }
        Ok(self.read_start_release_for_intent(&intent)?.is_some())
    }

    fn read_start_release_for_intent(
        &self,
        intent: &FmsRunIntent,
    ) -> Result<Option<AcceptedRunStartRelease>> {
        let relative = format!("runs/{}/start_release.json", intent.run_id);
        let path = checked_path(self.root(), &relative)?;
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).context("inspect accepted run start release"),
            Ok(_) => {}
        }
        let bytes = read_bounded_regular_file(self.root(), &relative, MAX_RELEASE_BYTES)?;
        let release: AcceptedRunStartRelease =
            serde_json::from_slice(&bytes).context("parse accepted run start release")?;
        release.validate_for(intent)?;
        Ok(Some(release))
    }

    /// Release once under WRITER after the caller has checked live session,
    /// epoch, scene revision and explicit Compute intent. Replays return the
    /// original grant and never replace its author or timestamp.
    pub fn release_accepted_run_start(
        &self,
        run_id: &str,
        expected_specification_sha256: &str,
        request_id: &str,
    ) -> Result<AcceptedRunStartRelease> {
        validate_store_id(run_id)?;
        validate_store_id(request_id)?;
        validate_digest(expected_specification_sha256)?;
        let _writer = self.write_transaction()?;
        let intent = self
            .read_run_intent(run_id)?
            .context("start release requires its accepted run intent")?;
        if expected_specification_sha256 != intent.payload_sha256 || !manual_policy(&intent)? {
            bail!("start release does not match an immutable manual RunSpec");
        }
        if let Some(existing) = self.read_start_release_for_intent(&intent)? {
            return Ok(existing);
        }
        self.ensure_development_admission_open_unlocked()?;
        let release = AcceptedRunStartRelease {
            schema_version: RELEASE_SCHEMA.into(),
            run_id: run_id.into(),
            specification_sha256: expected_specification_sha256.into(),
            request_id: request_id.into(),
            released_at: Utc::now(),
        };
        release.validate_for(&intent)?;
        let path = create_parent(self.root(), &format!("runs/{run_id}/start_release.json"))?;
        super::atomic_write_confirmed(&path, &serde_json::to_vec_pretty(&release)?)?;
        Ok(release)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(policy: Value) -> (tempfile::TempDir, SessionStore, FmsRunIntent) {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let intent = FmsRunIntent::new(
            "run-held",
            "intent-held",
            json!({
                "run_id":"run-held", "parameters": policy,
            }),
        );
        store.commit_run_intent(&intent).unwrap();
        (directory, store, intent)
    }

    fn manual() -> Value {
        json!({(ACCEPTED_RUN_START_POLICY_KEY):{"schema_version":POLICY_SCHEMA,"mode":"manual"}})
    }

    #[test]
    fn accepted_start_gate_holds_manual_run_without_mutating_preparation() {
        let (_directory, store, _intent) = fixture(manual());
        assert!(!store.accepted_run_start_permitted("run-held").unwrap());
        assert!(!store
            .root()
            .join("runs/run-held/start_release.json")
            .exists());
        assert!(store.read_run_catalog("run-held").unwrap().is_none());
    }

    #[test]
    fn accepted_start_gate_preserves_ordinary_automatic_runs() {
        let (_directory, store, _intent) = fixture(json!({"user_parameter":42}));
        assert!(store.accepted_run_start_permitted("run-held").unwrap());
    }

    #[test]
    fn accepted_start_gate_release_is_exact_immutable_and_survives_reopen() {
        let (directory, store, intent) = fixture(manual());
        let released = store
            .release_accepted_run_start("run-held", &intent.payload_sha256, "compute-first")
            .unwrap();
        assert!(store.accepted_run_start_permitted("run-held").unwrap());
        let replay = store
            .release_accepted_run_start("run-held", &intent.payload_sha256, "compute-retry")
            .unwrap();
        assert_eq!(released, replay);
        drop(store);
        let reopened = SessionStore::open_existing(directory.path()).unwrap();
        assert!(reopened.accepted_run_start_permitted("run-held").unwrap());
    }

    #[test]
    fn accepted_start_gate_rejects_other_specification_without_grant() {
        let (_directory, store, _intent) = fixture(manual());
        assert!(store
            .release_accepted_run_start("run-held", &"0".repeat(64), "compute-wrong")
            .is_err());
        assert!(!store.accepted_run_start_permitted("run-held").unwrap());
    }

    #[test]
    fn accepted_start_gate_rejects_malformed_policy_without_auto_fallback() {
        let (_directory, store, _intent) = fixture(
            json!({(ACCEPTED_RUN_START_POLICY_KEY):{"schema_version":POLICY_SCHEMA,"mode":"unknown"}}),
        );
        assert!(store.accepted_run_start_permitted("run-held").is_err());
    }

    #[test]
    fn accepted_start_gate_is_rooted_and_typed_in_store_and_archive_graphs() {
        let (_directory, store, intent) = fixture(manual());
        let release = store
            .release_accepted_run_start("run-held", &intent.payload_sha256, "compute-first")
            .unwrap();
        let relative = "runs/run-held/start_release.json";
        let report = crate::reachability::walk_store_root(
            store.root(),
            crate::reachability::ReachabilityMode::Gc,
        )
        .unwrap();
        assert!(report.file_refs.contains(relative));
        let mut documents = std::collections::HashMap::from([
            (
                "runs/run-held/run_intent.json".into(),
                serde_json::to_vec(&intent).unwrap(),
            ),
            (relative.into(), serde_json::to_vec(&release).unwrap()),
        ]);
        let report = crate::reachability::walk_archive_documents(
            &documents,
            crate::reachability::ReachabilityMode::Restore,
        )
        .unwrap();
        assert!(report.file_refs.contains(relative));
        documents.remove("runs/run-held/run_intent.json");
        assert!(crate::reachability::walk_archive_documents(
            &documents,
            crate::reachability::ReachabilityMode::Restore
        )
        .is_err());
    }

    #[test]
    fn accepted_start_gate_rejects_tampered_or_foreign_release() {
        let (_directory, store, intent) = fixture(manual());
        let mut release = store
            .release_accepted_run_start("run-held", &intent.payload_sha256, "compute-first")
            .unwrap();
        release.run_id = "run-other".into();
        std::fs::write(
            store.root().join("runs/run-held/start_release.json"),
            serde_json::to_vec(&release).unwrap(),
        )
        .unwrap();
        assert!(store.accepted_run_start_permitted("run-held").is_err());
    }
}
