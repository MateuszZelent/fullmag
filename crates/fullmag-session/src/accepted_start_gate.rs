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
const LIVE_RELEASE_SCHEMA: &str = "accepted_run_start_release.v2";
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

/// HTTP request identity stored at the same durable boundary as live Compute.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveComputeRequestReceipt {
    pub key_sha256: String,
    pub request_sha256: String,
    pub command_id: String,
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_intent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_target: Option<Value>,
}

impl LiveComputeRequestReceipt {
    pub fn validate(&self) -> Result<()> {
        validate_digest(&self.key_sha256)?;
        validate_digest(&self.request_sha256)?;
        validate_store_id(&self.command_id)?;
        if self.command_kind.as_deref().is_some_and(|kind| !matches!(kind, "solve" | "run" | "relax")) {
            bail!("invalid live Compute command kind");
        }
        if self.requested_target.as_ref().is_some_and(|target| {
            target.get("kind").and_then(Value::as_str).is_none()
        }) {
            bail!("invalid live Compute requested target");
        }
        Ok(())
    }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_request: Option<LiveComputeRequestReceipt>,
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
    accepted_run_start_policy_is_manual(value)
}

/// Decode the shared optional RunSpec policy without changing its start grant.
/// Scheduler and worker must accept the same closed set of modes and fields.
pub fn accepted_run_start_policy_is_manual(value: &Value) -> Result<bool> {
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
        if let Some(receipt) = &self.live_request {
            receipt.validate()?;
        }
        let schema = if self.live_request.is_some() { LIVE_RELEASE_SCHEMA } else { RELEASE_SCHEMA };
        if self.schema_version != schema
            || self.run_id != intent.run_id
            || self.specification_sha256 != intent.payload_sha256
            || !manual_policy(intent)?
        {
            bail!("accepted run start release differs from its immutable manual RunSpec");
        }
        if let Some(value) = intent.specification.pointer("/parameters/live_workspace/request_receipt") {
            let expected: LiveComputeRequestReceipt = serde_json::from_value(value.clone())
                .context("parse immutable direct Compute request receipt")?;
            expected.validate()?;
            if self.live_request.as_ref() != Some(&expected) {
                bail!("accepted run start release differs from its immutable direct Compute request receipt");
            }
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
        if self.read_start_release_for_intent(&intent)?.is_none() {
            return Ok(false);
        }
        // Confirm immutable publication under a stable fence. Inspection may
        // already hold a shared reader, while queue/claim paths own WRITER.
        // Reusing either avoids promoting a read into a writer or touching its
        // owner record. A concurrent publisher keeps the reader out until done.
        let _read = if self.writer.current_thread_has_lease()? {
            None
        } else {
            Some(self.read_transaction()?)
        };
        let intent = self.read_run_intent(run_id)?
            .context("accepted start gate lost its immutable run intent")?;
        let Some(release) = self.read_start_release_for_intent(&intent)? else {
            return Ok(false);
        };
        let intent_path = checked_path(self.root(), &format!("runs/{run_id}/run_intent.json"))?;
        if self.read_run_intent_bytes_unlocked(run_id)? != super::serialize_run_intent(&intent)? {
            bail!("accepted start intent differs from its exact canonical record");
        }
        let relative = format!("runs/{run_id}/start_release.json");
        let release_path = checked_path(self.root(), &relative)?;
        if read_bounded_regular_file(self.root(), &relative, MAX_RELEASE_BYTES)?
            != serde_json::to_vec_pretty(&release)?
        {
            bail!("accepted start release differs from its exact canonical record");
        }
        crate::durability::confirm_publication(&intent_path)?;
        crate::durability::confirm_publication(&release_path)?;
        Ok(true)
    }

    /// Read the immutable start grant without changing run readiness.
    pub fn read_accepted_run_start_release(
        &self,
        run_id: &str,
    ) -> Result<Option<AcceptedRunStartRelease>> {
        let intent = self
            .read_run_intent(run_id)?
            .context("accepted start release requires its immutable run intent")?;
        self.read_start_release_for_intent(&intent)
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
        self.release_accepted_run_start_inner(run_id, expected_specification_sha256, request_id, None)
    }

    pub fn release_accepted_run_start_for_live_request(
        &self,
        run_id: &str,
        expected_specification_sha256: &str,
        request_id: &str,
        live_request: &LiveComputeRequestReceipt,
    ) -> Result<AcceptedRunStartRelease> {
        live_request.validate()?;
        self.release_accepted_run_start_inner(
            run_id, expected_specification_sha256, request_id, Some(live_request),
        )
    }

    fn release_accepted_run_start_inner(
        &self,
        run_id: &str,
        expected_specification_sha256: &str,
        request_id: &str,
        live_request: Option<&LiveComputeRequestReceipt>,
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
        // A visible RunIntent left by an uncertain rename is insufficient to
        // authorize execution. Re-establish its exact durable publication while
        // this same writer lease prevents replacement or concurrent release.
        self.confirm_run_intent_publication(&intent)?;
        if let Some(existing) = self.read_start_release_for_intent(&intent)? {
            if let Some(receipt) = live_request {
                if existing.request_id != request_id || existing.live_request.as_ref() != Some(receipt) {
                    bail!("accepted run start was released by a different request");
                }
            }
            let path = checked_path(self.root(), &format!("runs/{run_id}/start_release.json"))?;
            crate::durability::confirm_publication(&path)?;
            return Ok(existing);
        }
        // The immutable cancellation is written before its catalog revision.
        // Even a partial replacement must keep the old run held.
        if !self.list_task_cancellation_intents(run_id)?.is_empty() {
            bail!("cannot release an accepted start with pre-claim cancellation intents");
        }
        self.ensure_development_admission_open_unlocked()?;
        let release = AcceptedRunStartRelease {
            schema_version: if live_request.is_some() { LIVE_RELEASE_SCHEMA } else { RELEASE_SCHEMA }.into(),
            run_id: run_id.into(),
            specification_sha256: expected_specification_sha256.into(),
            request_id: request_id.into(),
            released_at: Utc::now(),
            live_request: live_request.cloned(),
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

    #[test]
    fn shared_start_policy_accepts_both_modes_and_rejects_unknown_contracts() {
        for (mode, manual) in [("manual", true), ("automatic", false)] {
            let value = serde_json::json!({"schema_version": POLICY_SCHEMA, "mode": mode});
            assert_eq!(accepted_run_start_policy_is_manual(&value).unwrap(), manual);
        }
        for value in [
            serde_json::json!({"schema_version": POLICY_SCHEMA, "mode": "other"}),
            serde_json::json!({"schema_version": "unknown", "mode": "automatic"}),
            serde_json::json!({"schema_version": POLICY_SCHEMA, "mode": "manual", "grant": true}),
            serde_json::json!({"schema_version": POLICY_SCHEMA}),
            serde_json::Value::Null,
        ] {
            assert!(accepted_run_start_policy_is_manual(&value).is_err());
        }
    }

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
    fn accepted_start_gate_rejects_persistently_uncertain_release_until_confirmed() {
        let (_directory, store, intent) = fixture(manual());
        let path = store.root().join("runs/run-held/start_release.json");
        // Both publisher barriers and the scheduler gate's next barrier fail.
        crate::durability::fail_directory_barriers_for(&path, 3);
        let error = store.release_accepted_run_start("run-held", &intent.payload_sha256, "compute-first").unwrap_err();
        assert!(error.is::<crate::PublicationUncertain>());
        assert!(path.exists(), "the uncertain grant is visible after rename");
        let error = store.accepted_run_start_permitted("run-held").unwrap_err();
        assert!(error.is::<crate::PublicationUncertain>());
        assert!(store.read_run_catalog("run-held").unwrap().is_none());
        assert!(store.accepted_run_start_permitted("run-held").unwrap());
    }

    #[test]
    fn accepted_start_gate_confirmation_reuses_shared_reader_without_owner_writes() {
        let (_directory, store, intent) = fixture(manual());
        store.release_accepted_run_start("run-held", &intent.payload_sha256, "compute-first").unwrap();
        let owner = store.root().join("WRITER.owner.json");
        let before = std::fs::read(&owner).unwrap();
        let _read = store.read_transaction().unwrap();
        assert!(store.accepted_run_start_permitted("run-held").unwrap());
        assert_eq!(std::fs::read(&owner).unwrap(), before);
    }

    #[test]
    fn accepted_start_gate_never_releases_an_unconfirmed_run_intent() {
        let (_directory, store, intent) = fixture(manual());
        let path = store.root().join("runs/run-held/run_intent.json");
        crate::durability::fail_directory_barrier_for(&path);
        let error = store.release_accepted_run_start("run-held", &intent.payload_sha256, "compute-first").unwrap_err();
        assert!(error.is::<crate::PublicationUncertain>());
        assert!(!store.root().join("runs/run-held/start_release.json").exists());
        assert!(!store.accepted_run_start_permitted("run-held").unwrap());
        store.release_accepted_run_start("run-held", &intent.payload_sha256, "compute-first").unwrap();
        assert!(store.accepted_run_start_permitted("run-held").unwrap());
    }

    #[test]
    fn accepted_start_gate_replay_confirms_its_existing_release() {
        let (_directory, store, intent) = fixture(manual());
        let first = store.release_accepted_run_start("run-held", &intent.payload_sha256, "compute-first").unwrap();
        let path = store.root().join("runs/run-held/start_release.json");
        crate::durability::fail_directory_barrier_for(&path);
        let error = store.release_accepted_run_start("run-held", &intent.payload_sha256, "compute-first").unwrap_err();
        assert!(error.is::<crate::PublicationUncertain>());
        let replay = store.release_accepted_run_start("run-held", &intent.payload_sha256, "compute-first").unwrap();
        assert_eq!(replay, first);
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
    fn accepted_start_gate_requires_the_exact_immutable_direct_compute_receipt() {
        let receipt = LiveComputeRequestReceipt {
            key_sha256: "a".repeat(64),
            request_sha256: "b".repeat(64),
            command_id: "compute-stage-a".into(),
            request_id: Some("trace-stage-a".into()),
            command_kind: Some("relax".into()),
            client_intent_id: Some("stage-a-intent".into()),
            requested_target: Some(json!({"kind": "stage_id", "stage_id": "stage-a"})),
        };
        let mut parameters = manual();
        parameters["live_workspace"] = json!({"request_receipt": receipt});
        let (directory, store, intent) = fixture(parameters);
        let mut other = receipt.clone();
        other.request_sha256 = "c".repeat(64);
        other.command_id = "compute-whole-study".into();
        other.requested_target = Some(json!({"kind": "study"}));
        assert!(store.release_accepted_run_start_for_live_request(
            "run-held", &intent.payload_sha256, "request-whole-study", &other,
        ).is_err());
        assert!(store.release_accepted_run_start(
            "run-held", &intent.payload_sha256, "request-without-receipt",
        ).is_err());
        let path = store.root().join("runs/run-held/start_release.json");
        assert!(!path.exists());
        assert!(!store.accepted_run_start_permitted("run-held").unwrap());
        let grant = store.release_accepted_run_start_for_live_request(
            "run-held", &intent.payload_sha256, "request-stage-a", &receipt,
        ).unwrap();
        assert_eq!(grant.live_request.as_ref(), Some(&receipt));
        drop(store);
        let store = SessionStore::open_existing(directory.path()).unwrap();
        assert!(store.accepted_run_start_permitted("run-held").unwrap());
        // The shared gate must also reject an already-visible foreign grant.
        let mut foreign_grant = grant;
        foreign_grant.live_request = Some(other);
        std::fs::write(&path, serde_json::to_vec_pretty(&foreign_grant).unwrap()).unwrap();
        assert!(store.accepted_run_start_permitted("run-held").is_err());
    }

    #[test]
    fn accepted_start_gate_retains_live_compute_receipt_with_the_original_grant() {
        let (directory, store, intent) = fixture(manual());
        let receipt = LiveComputeRequestReceipt {
            key_sha256: "a".repeat(64),
            request_sha256: "b".repeat(64),
            command_id: "compute-first".into(),
            request_id: Some("trace-first".into()),
            command_kind: Some("solve".into()),
            client_intent_id: Some("compute-intent".into()),
            requested_target: Some(serde_json::json!({"kind": "study"})),
        };
        let grant = store.release_accepted_run_start_for_live_request(
            "run-held", &intent.payload_sha256, "compute-first", &receipt,
        ).unwrap();
        assert_eq!(grant.live_request.as_ref(), Some(&receipt));
        drop(store);
        let reopened = SessionStore::open_existing(directory.path()).unwrap();
        assert_eq!(
            reopened.read_accepted_run_start_release("run-held").unwrap(),
            Some(grant),
        );
        let changed = LiveComputeRequestReceipt { request_sha256: "c".repeat(64), ..receipt };
        assert!(reopened.release_accepted_run_start_for_live_request(
            "run-held", &intent.payload_sha256, "compute-first", &changed,
        ).is_err());
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
