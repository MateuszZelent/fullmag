//! Immutable run intent and submission identity.
//!
//! This module is the application boundary for P3-B.  It accepts a complete
//! snapshot and requested execution together; it never reads the current UI
//! session, resolves a missing mesh later, or starts a solver.  The ledger in
//! this file is deliberately in-memory.  A repository/coordinator adapter must
//! persist the accepted record before acknowledging a durable submit.

use crate::project::{ProjectEnvelope, ProjectId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub const RUN_SPEC_SCHEMA: &str = "run_spec.v1";
pub const RUN_INTENT_SCHEMA: &str = "run_intent.v1";

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RunId(String);

impl RunId {
    pub fn new() -> Self {
        Self(format!("run-{}", Uuid::new_v4().simple()))
    }

    pub fn parse(value: impl Into<String>) -> Result<Self, RunSpecError> {
        let value = value.into();
        require_identifier(&value, "run_id")?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for RunId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct StudyId(String);

impl StudyId {
    pub fn parse(value: impl Into<String>) -> Result<Self, RunSpecError> {
        let value = value.into();
        require_identifier(&value, "study_id")?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectSnapshot {
    pub project_id: ProjectId,
    pub definition_revision: u64,
    /// SHA-256 of the exact immutable definition bytes accepted by Submit.
    pub definition_sha256: String,
}

impl ProjectSnapshot {
    pub fn from_envelope(envelope: &ProjectEnvelope) -> Result<Self, RunSpecError> {
        envelope
            .validate_for_save()
            .map_err(|error| RunSpecError::Invalid(format!("invalid project definition: {error}")))?;
        Ok(Self {
            project_id: envelope.definition.project_id.clone(),
            definition_revision: envelope.definition.revision,
            definition_sha256: format!(
                "{:x}",
                Sha256::digest(envelope.raw_definition.raw_bytes())
            ),
        })
    }

    pub fn verify_envelope(&self, envelope: &ProjectEnvelope) -> Result<(), RunSpecError> {
        self.validate()?;
        if self != &Self::from_envelope(envelope)? {
            return Err(RunSpecError::Invalid(
                "run snapshot does not match the exact project definition bytes".into(),
            ));
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<(), RunSpecError> {
        validate_sha256(&self.definition_sha256, "definition_sha256")
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudyReference {
    pub study_id: StudyId,
    /// Schema version and digest of the exact typed study plan.
    pub plan_version: String,
    pub plan_sha256: String,
}

impl StudyReference {
    pub fn validate(&self) -> Result<(), RunSpecError> {
        require_identifier(self.study_id.as_str(), "study_id")?;
        require_identifier(&self.plan_version, "plan_version")?;
        validate_sha256(&self.plan_sha256, "study.plan_sha256")
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestedExecution {
    pub backend: String,
    pub device: String,
    pub precision: String,
    pub mode: String,
}

impl RequestedExecution {
    pub fn validate(&self) -> Result<(), RunSpecError> {
        require_one_of(&self.backend, "backend", &["auto", "fdm", "fem", "hybrid"])?;
        require_one_of(&self.device, "device", &["auto", "cpu", "gpu"])?;
        require_one_of(&self.precision, "precision", &["single", "double"])?;
        require_one_of(&self.mode, "mode", &["strict", "extended", "hybrid"])
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunDependency {
    AuthoredInitialState {
        reference: String,
    },
    PinnedArtifact {
        artifact_id: String,
        content_sha256: String,
    },
    StepOutput {
        study_id: StudyId,
        step_id: String,
        port: String,
        case_id: String,
    },
    ExplicitContinuation {
        run_id: RunId,
    },
}

impl RunDependency {
    fn validate(&self) -> Result<(), RunSpecError> {
        match self {
            Self::AuthoredInitialState { reference } => {
                require_identifier(reference, "dependency.reference")
            }
            Self::PinnedArtifact {
                artifact_id,
                content_sha256,
            } => {
                require_identifier(artifact_id, "dependency.artifact_id")?;
                validate_sha256(content_sha256, "dependency.content_sha256")
            }
            Self::StepOutput {
                study_id,
                step_id,
                port,
                case_id,
            } => {
                require_identifier(study_id.as_str(), "dependency.study_id")?;
                require_identifier(step_id, "dependency.step_id")?;
                require_identifier(port, "dependency.port")?;
                require_identifier(case_id, "dependency.case_id")
            }
            Self::ExplicitContinuation { run_id } => {
                require_identifier(run_id.as_str(), "dependency.run_id")
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunSpecification {
    pub schema_version: String,
    pub run_id: RunId,
    pub snapshot: ProjectSnapshot,
    pub study: StudyReference,
    /// Digest of the exact StudyProblemCatalog resolved for this run.
    pub study_catalog_sha256: String,
    /// Parameter values are captured at Submit and cannot be filled from UI
    /// state after acceptance.
    pub parameters: Value,
    pub seeds: BTreeMap<String, u64>,
    pub dependencies: Vec<RunDependency>,
    pub immutable_assets: Vec<ImmutableAssetReference>,
    pub requested_execution: RequestedExecution,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImmutableAssetReference {
    pub asset_id: String,
    pub content_sha256: String,
}

impl RunSpecification {
    pub fn new(
        snapshot: ProjectSnapshot,
        study: StudyReference,
        study_catalog_sha256: String,
        parameters: Value,
        requested_execution: RequestedExecution,
    ) -> Self {
        Self {
            schema_version: RUN_SPEC_SCHEMA.to_string(),
            run_id: RunId::default(),
            snapshot,
            study,
            study_catalog_sha256,
            parameters,
            seeds: BTreeMap::new(),
            dependencies: Vec::new(),
            immutable_assets: Vec::new(),
            requested_execution,
        }
    }

    pub fn validate(&self) -> Result<(), RunSpecError> {
        if self.schema_version != RUN_SPEC_SCHEMA {
            return Err(RunSpecError::Invalid(format!(
                "schema_version must be {RUN_SPEC_SCHEMA}"
            )));
        }
        require_identifier(self.run_id.as_str(), "run_id")?;
        self.snapshot.validate()?;
        self.study.validate()?;
        validate_sha256(&self.study_catalog_sha256, "study_catalog_sha256")?;
        self.requested_execution.validate()?;
        validate_json(&self.parameters, "parameters")?;

        for (name, value) in &self.seeds {
            require_identifier(name, "seed name")?;
            if name.starts_with("_") {
                return Err(RunSpecError::Invalid(format!(
                    "seed name `{name}` is reserved"
                )));
            }
            let _ = value;
        }
        for dependency in &self.dependencies {
            dependency.validate()?;
        }
        let mut asset_ids = BTreeSet::new();
        for asset in &self.immutable_assets {
            require_identifier(&asset.asset_id, "asset_id")?;
            if !asset_ids.insert(asset.asset_id.as_str()) {
                return Err(RunSpecError::Invalid(format!(
                    "duplicate immutable asset `{}`",
                    asset.asset_id
                )));
            }
            validate_sha256(&asset.content_sha256, "asset.content_sha256")?;
        }
        Ok(())
    }

    /// Hash the complete accepted intent, including the captured snapshot.
    pub fn fingerprint(&self) -> Result<String, RunSpecError> {
        self.validate()?;
        let value = serde_json::to_value(self)
            .map_err(|error| RunSpecError::Invalid(format!("serialize run spec: {error}")))?;
        Ok(format!(
            "{:x}",
            Sha256::digest(canonical_json_bytes(&value))
        ))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunIntent {
    pub schema_version: String,
    pub idempotency_key: String,
    pub specification: RunSpecification,
}

impl RunIntent {
    pub fn new(idempotency_key: impl Into<String>, specification: RunSpecification) -> Self {
        Self {
            schema_version: RUN_INTENT_SCHEMA.to_string(),
            idempotency_key: idempotency_key.into(),
            specification,
        }
    }

    pub fn validate(&self) -> Result<(), RunSpecError> {
        if self.schema_version != RUN_INTENT_SCHEMA {
            return Err(RunSpecError::Invalid(format!(
                "schema_version must be {RUN_INTENT_SCHEMA}"
            )));
        }
        require_identifier(&self.idempotency_key, "idempotency_key")?;
        self.specification.validate()
    }

    pub fn payload_fingerprint(&self) -> Result<String, RunSpecError> {
        self.validate()?;
        self.specification.fingerprint()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SubmitDisposition {
    Accepted,
    Replayed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubmitReceipt {
    pub disposition: SubmitDisposition,
    pub run_id: RunId,
    pub payload_fingerprint: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RunSpecError {
    Invalid(String),
    IdempotencyConflict {
        key: String,
        accepted_fingerprint: String,
        received_fingerprint: String,
    },
}

impl std::fmt::Display for RunSpecError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => formatter.write_str(message),
            Self::IdempotencyConflict { key, .. } => {
                write!(
                    formatter,
                    "idempotency key `{key}` was already accepted for another payload"
                )
            }
        }
    }
}

impl std::error::Error for RunSpecError {}

/// A process-local acceptance ledger used by adapters before durable storage
/// is introduced.  It proves the conflict/replay contract but is not a durable
/// run catalog and must never be reported as recovery evidence.
#[derive(Clone, Debug, Default)]
pub struct RunIntentLedger {
    accepted: BTreeMap<String, SubmitReceipt>,
}

impl RunIntentLedger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn accept(&mut self, intent: RunIntent) -> Result<SubmitReceipt, RunSpecError> {
        let fingerprint = intent.payload_fingerprint()?;
        if let Some(existing) = self.accepted.get(&intent.idempotency_key) {
            if existing.payload_fingerprint == fingerprint {
                return Ok(SubmitReceipt {
                    disposition: SubmitDisposition::Replayed,
                    run_id: existing.run_id.clone(),
                    payload_fingerprint: fingerprint,
                });
            }
            return Err(RunSpecError::IdempotencyConflict {
                key: intent.idempotency_key,
                accepted_fingerprint: existing.payload_fingerprint.clone(),
                received_fingerprint: fingerprint,
            });
        }

        let receipt = SubmitReceipt {
            disposition: SubmitDisposition::Accepted,
            run_id: intent.specification.run_id.clone(),
            payload_fingerprint: fingerprint,
        };
        self.accepted
            .insert(intent.idempotency_key, receipt.clone());
        Ok(receipt)
    }

    pub fn get(&self, idempotency_key: &str) -> Option<&SubmitReceipt> {
        self.accepted.get(idempotency_key)
    }
}

fn require_identifier(value: &str, field: &str) -> Result<(), RunSpecError> {
    if value.trim().is_empty()
        || value.len() > 256
        || value.chars().any(|character| {
            character.is_control() || matches!(character, '/' | '\\' | '\n' | '\r' | '\t')
        })
    {
        return Err(RunSpecError::Invalid(format!(
            "{field} must be a non-empty portable identifier"
        )));
    }
    Ok(())
}

fn require_one_of(value: &str, field: &str, allowed: &[&str]) -> Result<(), RunSpecError> {
    if allowed.iter().any(|candidate| candidate == &value) {
        Ok(())
    } else {
        Err(RunSpecError::Invalid(format!(
            "{field} `{value}` is unsupported; expected one of {}",
            allowed.join(", ")
        )))
    }
}

fn validate_sha256(value: &str, field: &str) -> Result<(), RunSpecError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(RunSpecError::Invalid(format!(
            "{field} must be a lowercase 64-character SHA-256 digest"
        )));
    }
    Ok(())
}

fn validate_json(value: &Value, field: &str) -> Result<(), RunSpecError> {
    if value.is_null() {
        return Err(RunSpecError::Invalid(format!(
            "{field} must be a JSON value, not null"
        )));
    }
    Ok(())
}

pub(crate) fn canonical_json_bytes(value: &Value) -> Vec<u8> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
            serde_json::to_vec(value).expect("JSON scalar is serializable")
        }
        Value::Array(values) => {
            let mut output = Vec::from([b'[']);
            for (index, item) in values.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                output.extend(canonical_json_bytes(item));
            }
            output.push(b']');
            output
        }
        Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            let mut output = Vec::from([b'{']);
            for (index, (key, item)) in entries.into_iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                output.extend(serde_json::to_vec(key).expect("JSON key is serializable"));
                output.push(b':');
                output.extend(canonical_json_bytes(item));
            }
            output.push(b'}');
            output
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot() -> ProjectSnapshot {
        ProjectSnapshot {
            project_id: ProjectId::parse("project-test").unwrap(),
            definition_revision: 7,
            definition_sha256: "a".repeat(64),
        }
    }

    fn specification() -> RunSpecification {
        RunSpecification::new(
            snapshot(),
            StudyReference {
                study_id: StudyId::parse("study-main").unwrap(),
                plan_version: "study_plan.v1".into(),
                plan_sha256: "b".repeat(64),
            },
            "c".repeat(64),
            json!({"alpha": 0.01, "name": "fixture"}),
            RequestedExecution {
                backend: "fdm".into(),
                device: "cpu".into(),
                precision: "double".into(),
                mode: "strict".into(),
            },
        )
    }

    #[test]
    fn run_spec_fingerprint_binds_snapshot_and_dependencies() {
        let mut spec = specification();
        let first = spec.fingerprint().unwrap();
        spec.snapshot.definition_revision += 1;
        assert_ne!(first, spec.fingerprint().unwrap());
        let mut spec = specification();
        let first = spec.fingerprint().unwrap();
        spec.study.plan_sha256 = "c".repeat(64);
        assert_ne!(first, spec.fingerprint().unwrap());
        let mut spec = specification();
        let first = spec.fingerprint().unwrap();
        spec.study_catalog_sha256 = "d".repeat(64);
        assert_ne!(first, spec.fingerprint().unwrap());
    }

    #[test]
    fn project_snapshot_binds_exact_definition_bytes() {
        let mut envelope = ProjectEnvelope::blank(ProjectId::parse("project-test").unwrap(), "Test")
            .unwrap();
        let snapshot = ProjectSnapshot::from_envelope(&envelope).unwrap();
        snapshot.verify_envelope(&envelope).unwrap();
        envelope.definition.revision += 1;
        envelope.rewrite_known_fields().unwrap();
        assert!(snapshot.verify_envelope(&envelope).is_err());
    }

    #[test]
    fn ledger_replays_same_payload_and_rejects_conflicting_payload() {
        let mut ledger = RunIntentLedger::new();
        let intent = RunIntent::new("intent-1", specification());
        let first = ledger.accept(intent.clone()).unwrap();
        assert_eq!(first.disposition, SubmitDisposition::Accepted);
        let replay = ledger.accept(intent).unwrap();
        assert_eq!(replay.disposition, SubmitDisposition::Replayed);

        let mut changed = specification();
        changed.parameters = json!({"alpha": 0.02});
        let error = ledger
            .accept(RunIntent::new("intent-1", changed))
            .unwrap_err();
        assert!(matches!(error, RunSpecError::IdempotencyConflict { .. }));
    }
}
