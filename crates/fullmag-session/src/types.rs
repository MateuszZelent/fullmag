//! Core types for the Fullmag session persistence system.
//!
//! These types define the logical snapshot of a simulation session,
//! used for both the internal `SessionStore` and the portable `.fms` file format.

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use utoipa::ToSchema;

// ── Save profiles ──────────────────────────────────────────────────────

/// Which elements to include when saving a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SaveProfile {
    /// Script + scene + UI; no solver data.
    Compact,
    /// Compact + mesh + primary fields + scalar rows + selected artifacts.
    Solved,
    /// Solved + exact checkpoint (integrator, RNG, backend state).
    Resume,
    /// Resume + all artifacts + all checkpoints + full field history.
    Archive,
    /// Internal: minimal fast snapshot for crash recovery.
    Recovery,
}

// ── Restore classes ────────────────────────────────────────────────────

/// What level of session restoration is possible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RestoreClass {
    /// Bitwise-identical continuation from checkpoint.
    ExactResume,
    /// Compatible state but runtime may differ; no bitwise guarantee.
    LogicalResume,
    /// Saved primary fields used as initial condition for a new run.
    InitialConditionImport,
    /// Project / UI / script only; solver must re-run from scratch.
    ConfigOnly,
}

// ── Session manifest ───────────────────────────────────────────────────

/// Top-level manifest written as `manifest/session.json` in the `.fms` archive.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FmsSessionManifest {
    /// Always `"fullmag.session.v1"`.
    pub format: String,
    /// Unique session identifier.
    pub session_id: String,
    /// Human-readable session name.
    pub name: String,
    /// Which save profile was used.
    pub profile: SaveProfile,
    /// Fullmag version that created this file.
    pub created_by_version: String,
    /// When the session was created.
    pub created_at: DateTime<Utc>,
    /// When this save was made.
    pub saved_at: DateTime<Utc>,
    /// Optional description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// References to run manifests.
    pub run_refs: Vec<String>,
    /// Reference to workspace manifest.
    pub workspace_ref: String,
    /// Reference to export profile.
    pub export_profile_ref: String,
}

impl FmsSessionManifest {
    pub fn new(
        session_id: impl Into<String>,
        name: impl Into<String>,
        profile: SaveProfile,
    ) -> Self {
        let now = Utc::now();
        Self {
            format: "fullmag.session.v1".into(),
            session_id: session_id.into(),
            name: name.into(),
            profile,
            created_by_version: env!("CARGO_PKG_VERSION").into(),
            created_at: now,
            saved_at: now,
            description: None,
            run_refs: Vec::new(),
            workspace_ref: "manifest/workspace.json".into(),
            export_profile_ref: "manifest/export_profile.json".into(),
        }
    }
}

// ── Workspace manifest ─────────────────────────────────────────────────

/// Workspace layout metadata, written as `manifest/workspace.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FmsWorkspaceManifest {
    pub workspace_id: String,
    pub problem_name: String,
    /// Paths (within the archive) holding project sources.
    pub project_ref: String,
    /// Canonical Python source retained as archive provenance.
    pub script_ref: String,
    /// SHA-256 of the exact raw bytes at `script_ref`.
    pub script_sha256: String,
    /// Reference to UI state.
    pub ui_state_ref: String,
    /// Reference to scene document.
    pub scene_document_ref: String,
    /// Reference to script builder state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script_builder_ref: Option<String>,
    /// Reference to model builder graph.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_builder_graph_ref: Option<String>,
    /// Reference to the asset index.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_index_ref: Option<String>,
}

// ── Export profile ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FmsExportProfile {
    pub profile: SaveProfile,
    pub include_fields: FieldCapturePolicy,
    pub include_artifacts: ArtifactPolicy,
    pub include_meshes: bool,
    pub include_logs: bool,
    pub include_source_files: bool,
    pub compression: CompressionProfile,
}

impl FmsExportProfile {
    pub fn for_profile(profile: SaveProfile) -> Self {
        match profile {
            SaveProfile::Compact => Self {
                profile,
                include_fields: FieldCapturePolicy::None,
                include_artifacts: ArtifactPolicy::None,
                include_meshes: false,
                include_logs: false,
                include_source_files: true,
                compression: CompressionProfile::Balanced,
            },
            SaveProfile::Solved => Self {
                profile,
                include_fields: FieldCapturePolicy::PrimaryOnly,
                include_artifacts: ArtifactPolicy::Selected,
                include_meshes: true,
                include_logs: true,
                include_source_files: true,
                compression: CompressionProfile::Balanced,
            },
            SaveProfile::Resume => Self {
                profile,
                include_fields: FieldCapturePolicy::RequiredForResume,
                include_artifacts: ArtifactPolicy::Selected,
                include_meshes: true,
                include_logs: true,
                include_source_files: true,
                compression: CompressionProfile::Balanced,
            },
            SaveProfile::Archive => Self {
                profile,
                include_fields: FieldCapturePolicy::AllRegistered,
                include_artifacts: ArtifactPolicy::All,
                include_meshes: true,
                include_logs: true,
                include_source_files: true,
                compression: CompressionProfile::Smallest,
            },
            SaveProfile::Recovery => Self {
                profile,
                include_fields: FieldCapturePolicy::RequiredForResume,
                include_artifacts: ArtifactPolicy::None,
                include_meshes: true,
                include_logs: false,
                include_source_files: false,
                compression: CompressionProfile::Speed,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldCapturePolicy {
    None,
    PrimaryOnly,
    RequiredForResume,
    CurrentCached,
    AllRegistered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactPolicy {
    None,
    IndexOnly,
    Selected,
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CompressionProfile {
    Speed,
    Balanced,
    Smallest,
}

// ── Run manifest ───────────────────────────────────────────────────────

/// Schema version for the durable accepted-submit journal entry.
pub const FMS_RUN_INTENT_SCHEMA: &str = "run_intent.v1";

/// Immutable accepted run intent, written as
/// `runs/<run_id>/run_intent.json` before Submit acknowledges the request.
///
/// The specification is stored inline so the accepted payload has one atomic
/// publication boundary.  It remains an untyped JSON value at the session
/// layer; the application layer owns the stricter RunSpecification contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsRunIntent {
    pub schema_version: String,
    pub run_id: String,
    pub idempotency_key: String,
    pub payload_sha256: String,
    pub accepted_at: DateTime<Utc>,
    pub specification: Value,
    /// CAS object containing the exact project definition bytes accepted by Submit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition_object_ref: Option<String>,
    /// CAS object containing canonical bytes of the accepted typed StudyPlan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub study_object_ref: Option<String>,
    /// CAS object containing the immutable per-step ProblemIR catalog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub study_catalog_object_ref: Option<String>,
    /// Exact immutable asset ID to CAS object mapping accepted by Submit.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub asset_object_refs: BTreeMap<String, String>,
}

impl FmsRunIntent {
    pub fn new(
        run_id: impl Into<String>,
        idempotency_key: impl Into<String>,
        specification: Value,
    ) -> Self {
        let payload_sha256 = canonical_json_sha256(&specification);
        Self {
            schema_version: FMS_RUN_INTENT_SCHEMA.into(),
            run_id: run_id.into(),
            idempotency_key: idempotency_key.into(),
            payload_sha256,
            accepted_at: Utc::now(),
            specification,
            definition_object_ref: None,
            study_object_ref: None,
            study_catalog_object_ref: None,
            asset_object_refs: BTreeMap::new(),
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_RUN_INTENT_SCHEMA {
            bail!("unsupported run intent schema `{}`", self.schema_version);
        }
        crate::repository_path::validate_store_id(&self.run_id)?;
        crate::repository_path::validate_store_id(&self.idempotency_key)?;
        validate_sha256(&self.payload_sha256, "payload_sha256")?;
        if self.specification.is_null() {
            bail!("run intent specification must not be null");
        }
        if let Some(specification_run_id) = self.specification.get("run_id") {
            if specification_run_id.as_str() != Some(self.run_id.as_str()) {
                bail!("run intent specification run_id does not match its envelope");
            }
        }
        if let Some(object_ref) = self.definition_object_ref.as_deref() {
            validate_sha256(object_ref, "definition_object_ref")?;
            if self
                .specification
                .pointer("/snapshot/definition_sha256")
                .and_then(Value::as_str)
                != Some(object_ref)
            {
                bail!("run intent definition object does not match snapshot digest");
            }
        }
        if let Some(object_ref) = self.study_object_ref.as_deref() {
            validate_sha256(object_ref, "study_object_ref")?;
            if self
                .specification
                .pointer("/study/plan_sha256")
                .and_then(Value::as_str)
                != Some(object_ref)
            {
                bail!("run intent study object does not match plan digest");
            }
        }
        if let Some(object_ref) = self.study_catalog_object_ref.as_deref() {
            validate_sha256(object_ref, "study_catalog_object_ref")?;
            if self
                .specification
                .get("study_catalog_sha256")
                .and_then(Value::as_str)
                != Some(object_ref)
            {
                bail!("run intent study catalog object does not match catalog digest");
            }
        }
        if !self.asset_object_refs.is_empty()
            || self.definition_object_ref.is_some()
            || self.study_object_ref.is_some()
            || self.study_catalog_object_ref.is_some()
        {
            let assets = self
                .specification
                .get("immutable_assets")
                .and_then(Value::as_array)
                .context("run intent asset objects require immutable_assets")?;
            if assets.len() != self.asset_object_refs.len() {
                bail!("run intent asset object count differs from immutable_assets");
            }
            let mut seen = BTreeSet::new();
            for asset in assets {
                let asset_id = asset
                    .get("asset_id")
                    .and_then(Value::as_str)
                    .context("run intent asset has no asset_id")?;
                let content_sha256 = asset
                    .get("content_sha256")
                    .and_then(Value::as_str)
                    .context("run intent asset has no content_sha256")?;
                if !seen.insert(asset_id)
                    || self.asset_object_refs.get(asset_id).map(String::as_str)
                        != Some(content_sha256)
                {
                    bail!("run intent asset object does not match immutable asset reference");
                }
                validate_sha256(content_sha256, "asset_object_ref")?;
            }
        }
        let actual = canonical_json_sha256(&self.specification);
        if actual != self.payload_sha256 {
            bail!(
                "run intent payload digest mismatch: expected {}, got {}",
                self.payload_sha256,
                actual
            );
        }
        Ok(())
    }
}

/// Result of publishing a durable accepted intent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunIntentCommitDisposition {
    Accepted,
    Replayed { run_id: String },
}

/// Schema version for the durable preparation receipt bound to one run.
pub const FMS_PREPARATION_RECEIPT_SCHEMA: &str = "preparation_receipt.v1";
/// Schema for an immutable preparation publication scoped to one study task.
pub const FMS_TASK_PREPARATION_RECEIPT_SCHEMA: &str = "task_preparation_receipt.v1";

/// Durable, opaque publication of an application preparation receipt.
///
/// The application layer validates the complete `PreparationReceipt` before it
/// crosses this boundary.  The session layer keeps the exact JSON payload and
/// its digest so a restart can verify that the published plan/certificate set
/// was not replaced by another draft.  The run id is part of the path and the
/// record is immutable after the first accepted publication.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsPreparationReceipt {
    pub schema_version: String,
    pub preparation_id: String,
    pub run_id: String,
    /// Canonical `sha256:<hex>` fingerprint of the embedded preparation plan.
    pub plan_fingerprint: String,
    /// Bare lowercase SHA-256 of `payload` canonical JSON bytes.
    pub payload_sha256: String,
    pub payload: Value,
    pub created_at: DateTime<Utc>,
}

impl FmsPreparationReceipt {
    pub fn new(
        preparation_id: impl Into<String>,
        run_id: impl Into<String>,
        plan_fingerprint: impl Into<String>,
        payload: Value,
    ) -> Self {
        Self {
            schema_version: FMS_PREPARATION_RECEIPT_SCHEMA.into(),
            preparation_id: preparation_id.into(),
            run_id: run_id.into(),
            plan_fingerprint: plan_fingerprint.into(),
            payload_sha256: canonical_json_sha256(&payload),
            payload,
            created_at: Utc::now(),
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_PREPARATION_RECEIPT_SCHEMA {
            bail!(
                "unsupported preparation receipt schema `{}`",
                self.schema_version
            );
        }
        for (value, field) in [
            (self.preparation_id.as_str(), "preparation_id"),
            (self.run_id.as_str(), "run_id"),
        ] {
            crate::repository_path::validate_store_id(value)
                .with_context(|| format!("invalid preparation receipt {field}"))?;
        }
        validate_prefixed_sha256(&self.plan_fingerprint, "plan_fingerprint")?;
        if self.payload.is_null() {
            bail!("preparation receipt payload must not be null");
        }
        validate_sha256(&self.payload_sha256, "payload_sha256")?;
        let actual = canonical_json_sha256(&self.payload);
        if actual != self.payload_sha256 {
            bail!(
                "preparation receipt payload digest mismatch: expected {}, got {}",
                self.payload_sha256,
                actual
            );
        }
        let payload_schema = self
            .payload
            .get("schema_version")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                anyhow::anyhow!("preparation receipt payload must contain schema_version")
            })?;
        if payload_schema != FMS_PREPARATION_RECEIPT_SCHEMA {
            bail!("preparation receipt payload has unsupported schema `{payload_schema}`");
        }
        let payload_preparation_id = self
            .payload
            .get("preparation_id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                anyhow::anyhow!("preparation receipt payload must contain preparation_id")
            })?;
        if payload_preparation_id != self.preparation_id {
            bail!("preparation receipt payload preparation_id does not match its envelope");
        }
        let payload_plan_fingerprint = self
            .payload
            .get("plan_fingerprint")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                anyhow::anyhow!("preparation receipt payload must contain plan_fingerprint")
            })?;
        if payload_plan_fingerprint != self.plan_fingerprint {
            bail!("preparation receipt payload plan_fingerprint does not match its envelope");
        }
        Ok(())
    }

    /// Compare the immutable publication identity and payload while ignoring
    /// the publication timestamp assigned by each retry attempt.
    ///
    /// A retried materialization request creates a fresh envelope timestamp,
    /// but it is still the same accepted preparation when every durable
    /// identity and payload field matches. The timestamp is observational
    /// metadata and must not turn an otherwise idempotent replay into an
    /// immutable-replacement conflict.
    pub fn same_immutable_payload(&self, other: &Self) -> bool {
        self.schema_version == other.schema_version
            && self.preparation_id == other.preparation_id
            && self.run_id == other.run_id
            && self.plan_fingerprint == other.plan_fingerprint
            && self.payload_sha256 == other.payload_sha256
            && self.payload == other.payload
    }
}

/// Stable task identity derived from an accepted run and its study step.
/// The step id is logical data and is never interpolated into a store path.
pub fn task_id_for_study_step(run_id: &str, step_id: &str) -> Result<String> {
    crate::repository_path::validate_store_id(run_id).context("invalid task run_id")?;
    validate_study_step_id(step_id)?;
    Ok(format!(
        "task-{}",
        crate::hex_sha256(format!("{run_id}\0{step_id}").as_bytes())
    ))
}

/// Immutable accepted-run preparation receipt, stored one per task.
///
/// `payload` is the complete application receipt. The session layer verifies
/// its digest and the repeated run/step/source identity before publication;
/// application and runtime-control remain responsible for validating the
/// full preparation plan and certificates against the accepted ProblemIR.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsTaskPreparationReceipt {
    pub schema_version: String,
    pub run_id: String,
    pub task_id: String,
    pub step_id: String,
    pub input_fingerprint: String,
    pub preparation_id: String,
    /// Canonical `sha256:<hex>` fingerprint of the embedded preparation plan.
    pub plan_fingerprint: String,
    /// Bare lowercase SHA-256 of `payload` canonical JSON bytes.
    pub payload_sha256: String,
    pub payload: Value,
    pub created_at: DateTime<Utc>,
}

impl FmsTaskPreparationReceipt {
    pub fn new(
        run_id: impl Into<String>,
        step_id: impl Into<String>,
        input_fingerprint: impl Into<String>,
        preparation_id: impl Into<String>,
        plan_fingerprint: impl Into<String>,
        payload: Value,
    ) -> Result<Self> {
        let run_id = run_id.into();
        let step_id = step_id.into();
        let receipt = Self {
            task_id: task_id_for_study_step(&run_id, &step_id)?,
            run_id,
            step_id,
            input_fingerprint: input_fingerprint.into(),
            preparation_id: preparation_id.into(),
            plan_fingerprint: plan_fingerprint.into(),
            payload_sha256: canonical_json_sha256(&payload),
            payload,
            schema_version: FMS_TASK_PREPARATION_RECEIPT_SCHEMA.into(),
            created_at: Utc::now(),
        };
        receipt.validate()?;
        Ok(receipt)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_TASK_PREPARATION_RECEIPT_SCHEMA {
            bail!(
                "unsupported task preparation receipt schema `{}`",
                self.schema_version
            );
        }
        crate::repository_path::validate_store_id(&self.run_id)
            .context("invalid task preparation receipt run_id")?;
        crate::repository_path::validate_store_id(&self.task_id)
            .context("invalid task preparation receipt task_id")?;
        validate_study_step_id(&self.step_id)?;
        if task_id_for_study_step(&self.run_id, &self.step_id)? != self.task_id {
            bail!("task preparation receipt identity does not match run_id and step_id");
        }
        crate::repository_path::validate_store_id(&self.preparation_id)
            .context("invalid task preparation receipt preparation_id")?;
        if self.preparation_id != format!("prep-{}", self.task_id) {
            bail!("task preparation receipt preparation_id is not deterministic for its task");
        }
        for (value, field) in [(self.input_fingerprint.as_str(), "input_fingerprint")] {
            validate_sha256(value, field)?;
        }
        validate_prefixed_sha256(&self.plan_fingerprint, "plan_fingerprint")?;
        if self.payload.is_null() {
            bail!("task preparation receipt payload must not be null");
        }
        validate_sha256(&self.payload_sha256, "payload_sha256")?;
        let actual = canonical_json_sha256(&self.payload);
        if actual != self.payload_sha256 {
            bail!(
                "task preparation receipt payload digest mismatch: expected {}, got {}",
                self.payload_sha256,
                actual
            );
        }
        self.validate_payload_identity()?;
        Ok(())
    }

    fn validate_payload_identity(&self) -> Result<()> {
        let payload = &self.payload;
        if payload["schema_version"] != FMS_PREPARATION_RECEIPT_SCHEMA
            || payload["preparation_id"].as_str() != Some(self.preparation_id.as_str())
            || payload["plan_fingerprint"].as_str() != Some(self.plan_fingerprint.as_str())
        {
            bail!("task preparation receipt payload identity does not match its envelope");
        }
        let plan = payload
            .get("plan")
            .and_then(Value::as_object)
            .context("task preparation receipt payload must contain a plan object")?;
        if plan.get("schema_version").and_then(Value::as_str) != Some("preparation_plan.v2")
            || plan.contains_key("scene_revision")
        {
            bail!("task preparation receipt must contain an accepted-run v2 plan");
        }
        let source = plan
            .get("source")
            .and_then(Value::as_object)
            .context("accepted-run preparation plan source is missing")?;
        let accepted_source = payload
            .get("accepted_run_source")
            .and_then(Value::as_object)
            .context("accepted-run preparation receipt source is missing")?;
        let problem_fingerprint = plan
            .get("problem_fingerprint")
            .and_then(Value::as_str)
            .context("accepted-run preparation plan ProblemIR fingerprint is missing")?;
        for value in [
            source
                .get("specification_fingerprint")
                .and_then(Value::as_str)
                .context("accepted-run plan specification fingerprint is missing")?,
            accepted_source
                .get("specification_fingerprint")
                .and_then(Value::as_str)
                .context("accepted-run receipt specification fingerprint is missing")?,
            problem_fingerprint,
            accepted_source
                .get("problem_fingerprint")
                .and_then(Value::as_str)
                .context("accepted-run receipt ProblemIR fingerprint is missing")?,
        ] {
            validate_prefixed_sha256(value, "accepted-run preparation fingerprint")?;
        }
        if source.get("kind").and_then(Value::as_str) != Some("accepted_run_step")
            || source.get("run_id").and_then(Value::as_str) != Some(self.run_id.as_str())
            || source.get("step_id").and_then(Value::as_str) != Some(self.step_id.as_str())
            || accepted_source
                .get("schema_version")
                .and_then(Value::as_str)
                != Some("accepted_run_preparation_source.v1")
            || accepted_source.get("run_id").and_then(Value::as_str) != Some(self.run_id.as_str())
            || accepted_source.get("step_id").and_then(Value::as_str) != Some(self.step_id.as_str())
            || source.get("specification_fingerprint")
                != accepted_source.get("specification_fingerprint")
            || Some(problem_fingerprint)
                != accepted_source
                    .get("problem_fingerprint")
                    .and_then(Value::as_str)
        {
            bail!("task preparation receipt source identity does not match its envelope");
        }
        Ok(())
    }

    pub fn relative_path(&self) -> Result<String> {
        self.validate()?;
        Ok(format!(
            "runs/{}/task_preparation_receipts/{}.json",
            self.run_id, self.task_id
        ))
    }

    pub fn validate_for_catalog(&self, catalog: &FmsRunCatalog) -> Result<()> {
        self.validate()?;
        catalog.validate()?;
        if catalog.run_id != self.run_id {
            bail!("task preparation receipt run_id does not match run catalog");
        }
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == self.task_id)
            .context("task preparation receipt task is missing from the run catalog")?;
        if task.input_fingerprint != self.input_fingerprint {
            bail!("task preparation receipt input fingerprint does not match run catalog");
        }
        Ok(())
    }

    pub fn validate_for_run_intent(&self, intent: &FmsRunIntent) -> Result<()> {
        self.validate()?;
        intent.validate()?;
        if intent.run_id != self.run_id {
            bail!("task preparation receipt run_id does not match accepted run intent");
        }
        if intent.specification.get("run_id").and_then(Value::as_str) != Some(self.run_id.as_str())
        {
            bail!("accepted RunSpec run_id does not match task preparation receipt");
        }
        let expected = format!("sha256:{}", canonical_json_sha256(&intent.specification));
        let actual = self.payload["accepted_run_source"]["specification_fingerprint"]
            .as_str()
            .context("accepted run specification fingerprint is missing")?;
        if actual != expected {
            bail!("task preparation receipt does not match accepted RunSpec fingerprint");
        }
        Ok(())
    }

    pub fn same_immutable_payload(&self, other: &Self) -> bool {
        self.schema_version == other.schema_version
            && self.run_id == other.run_id
            && self.task_id == other.task_id
            && self.step_id == other.step_id
            && self.input_fingerprint == other.input_fingerprint
            && self.preparation_id == other.preparation_id
            && self.plan_fingerprint == other.plan_fingerprint
            && self.payload_sha256 == other.payload_sha256
            && self.payload == other.payload
    }
}

fn validate_study_step_id(value: &str) -> Result<()> {
    if value.trim().is_empty()
        || value.len() > 256
        || value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
    {
        bail!("invalid portable study step identifier");
    }
    Ok(())
}

/// Result of publishing a preparation receipt.  Replays are accepted only
/// when the complete immutable payload is byte-for-byte equivalent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreparationReceiptCommitDisposition {
    Accepted,
    Replayed,
}

/// Schema version for the minimal durable task catalog.
pub const FMS_RUN_CATALOG_SCHEMA: &str = "run_catalog.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FmsTaskLifecycle {
    Accepted,
    Queued,
    Preparing,
    Running,
    Stopping,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum FmsTaskReadiness {
    Ready,
    Blocked { reason: String },
}

impl Default for FmsTaskReadiness {
    fn default() -> Self {
        Self::Ready
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FmsObservationState {
    Live,
    Stale,
    Disconnected,
    Reconciling,
}

/// Last journal sequence projected for one task attempt and ownership epoch.
/// The coordinator journal remains authoritative; this watermark detects
/// missing history and permits repair when the catalog is behind.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsCoordinatorWatermark {
    pub command_sequence: u64,
    pub event_sequence: u64,
}

/// Durable proof that an empty journal belongs to a newly admitted stream.
/// The initial application checkpoint is content-hashed and must have zero
/// command/event sequences; runtime-control validates its typed claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsCoordinatorGenesis {
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub ownership_epoch: u64,
    pub lease_token: String,
    pub lease_heartbeat_sequence: u64,
    pub checkpoint_sha256: String,
    pub checkpoint: Value,
}

impl FmsCoordinatorGenesis {
    pub fn new(
        run_id: impl Into<String>,
        task_id: impl Into<String>,
        attempt_id: impl Into<String>,
        ownership_epoch: u64,
        lease_token: impl Into<String>,
        lease_heartbeat_sequence: u64,
        checkpoint: Value,
    ) -> Result<Self> {
        let genesis = Self {
            run_id: run_id.into(),
            task_id: task_id.into(),
            attempt_id: attempt_id.into(),
            ownership_epoch,
            lease_token: lease_token.into(),
            lease_heartbeat_sequence,
            checkpoint_sha256: canonical_json_sha256(&checkpoint),
            checkpoint,
        };
        genesis.validate_payload()?;
        Ok(genesis)
    }

    fn validate_payload(&self) -> Result<()> {
        crate::repository_path::validate_store_id(&self.run_id)?;
        crate::repository_path::validate_store_id(&self.task_id)?;
        crate::repository_path::validate_store_id(&self.attempt_id)?;
        crate::repository_path::validate_store_id(&self.lease_token)?;
        if self.ownership_epoch == 0 {
            bail!("coordinator genesis ownership_epoch must be greater than zero");
        }
        validate_sha256(
            &self.checkpoint_sha256,
            "coordinator genesis checkpoint_sha256",
        )?;
        if canonical_json_sha256(&self.checkpoint) != self.checkpoint_sha256 {
            bail!("coordinator genesis checkpoint hash mismatch");
        }
        if self
            .checkpoint
            .get("schema_version")
            .and_then(Value::as_str)
            != Some("coordinator_checkpoint.v1")
        {
            bail!("unsupported coordinator genesis checkpoint schema");
        }
        if self
            .checkpoint
            .get("command_sequence")
            .and_then(Value::as_u64)
            != Some(0)
            || self
                .checkpoint
                .get("event_sequence")
                .and_then(Value::as_u64)
                != Some(0)
        {
            bail!("coordinator genesis checkpoint must have zero command/event sequences");
        }
        let claim = self
            .checkpoint
            .get("claim")
            .context("coordinator genesis checkpoint has no claim")?;
        let lease = claim
            .get("lease")
            .context("coordinator genesis claim has no lease")?;
        if claim.get("run_id").and_then(Value::as_str) != Some(self.run_id.as_str())
            || claim.get("task_id").and_then(Value::as_str) != Some(self.task_id.as_str())
            || claim.get("attempt_id").and_then(Value::as_str) != Some(self.attempt_id.as_str())
            || claim.get("ownership_epoch").and_then(Value::as_u64) != Some(self.ownership_epoch)
            || lease.get("lease_token").and_then(Value::as_str) != Some(self.lease_token.as_str())
            || lease.get("heartbeat_sequence").and_then(Value::as_u64)
                != Some(self.lease_heartbeat_sequence)
        {
            bail!("coordinator genesis metadata differs from its checkpoint claim");
        }
        let task = self
            .checkpoint
            .get("task")
            .context("coordinator genesis checkpoint has no task")?;
        if task.get("run_id").and_then(Value::as_str) != Some(self.run_id.as_str())
            || task.get("task_id").and_then(Value::as_str) != Some(self.task_id.as_str())
            || task.get("attempt_id").and_then(Value::as_str) != Some(self.attempt_id.as_str())
            || task.get("ownership_epoch").and_then(Value::as_u64) != Some(self.ownership_epoch)
        {
            bail!("coordinator genesis metadata differs from its checkpoint task");
        }
        Ok(())
    }

    pub(crate) fn validate_for_task(&self, run_id: &str, task: &FmsTaskCatalogEntry) -> Result<()> {
        self.validate_payload()?;
        if self.run_id != run_id
            || self.task_id != task.task_id
            || task.ownership_epoch != Some(self.ownership_epoch)
            || task
                .attempt_id
                .as_deref()
                .is_some_and(|attempt_id| attempt_id != self.attempt_id.as_str())
        {
            bail!("coordinator genesis does not match the task attempt/epoch");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoordinatorGenesisCommitDisposition {
    Accepted,
    Replayed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FmsTaskCatalogEntry {
    pub task_id: String,
    pub input_fingerprint: String,
    pub lifecycle: FmsTaskLifecycle,
    #[serde(default)]
    pub readiness: FmsTaskReadiness,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation: Option<FmsObservationState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ownership_epoch: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_input_fingerprint: Option<String>,
    #[serde(default)]
    pub artifact_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinator_watermark: Option<FmsCoordinatorWatermark>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinator_genesis: Option<FmsCoordinatorGenesis>,
}

impl FmsTaskCatalogEntry {
    fn validate(&self, run_id: &str) -> Result<()> {
        crate::repository_path::validate_store_id(&self.task_id)?;
        validate_sha256(&self.input_fingerprint, "input_fingerprint")?;
        match (&self.attempt_id, self.ownership_epoch) {
            (Some(attempt_id), Some(epoch)) => {
                crate::repository_path::validate_store_id(attempt_id)?;
                if epoch == 0 {
                    bail!("ownership_epoch must be greater than zero");
                }
            }
            // A retried task keeps its last ownership epoch as a monotonic
            // fence while it waits for a fresh attempt to be claimed.
            (None, Some(epoch)) => {
                if epoch == 0 {
                    bail!("ownership_epoch must be greater than zero");
                }
            }
            (None, None) => {}
            _ => bail!("attempt_id and ownership_epoch must be provided together"),
        }
        if self.coordinator_watermark.is_some() && self.ownership_epoch.is_none() {
            bail!("coordinator watermark requires a durable ownership epoch");
        }
        if let Some(genesis) = &self.coordinator_genesis {
            genesis.validate_for_task(run_id, self)?;
            if self.coordinator_watermark.is_none() {
                bail!("coordinator genesis requires a catalog watermark");
            }
        }
        if let Some(fingerprint) = &self.resolved_input_fingerprint {
            validate_sha256(fingerprint, "resolved_input_fingerprint")?;
        }
        for artifact_id in &self.artifact_ids {
            crate::repository_path::validate_store_id(artifact_id)?;
        }
        if let Some(resource_id) = &self.resource_id {
            crate::repository_path::validate_store_id(resource_id)?;
        }
        if let FmsTaskReadiness::Blocked { reason } = &self.readiness {
            if reason.trim().is_empty() {
                bail!("blocked task requires a reason");
            }
        }
        Ok(())
    }
}

/// Monotonic durable snapshot of task identity and catalog references for one
/// run.  Worker leases and output publication are separate records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsRunCatalog {
    pub schema_version: String,
    pub run_id: String,
    pub revision: u64,
    pub updated_at: DateTime<Utc>,
    pub tasks: Vec<FmsTaskCatalogEntry>,
}

impl FmsRunCatalog {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_RUN_CATALOG_SCHEMA {
            bail!("unsupported run catalog schema `{}`", self.schema_version);
        }
        crate::repository_path::validate_store_id(&self.run_id)?;
        if self.revision == 0 {
            bail!("run catalog revision must be greater than zero");
        }
        let mut task_ids = std::collections::BTreeSet::new();
        for task in &self.tasks {
            task.validate(&self.run_id)?;
            if !task_ids.insert(task.task_id.as_str()) {
                bail!("duplicate task_id `{}` in run catalog", task.task_id);
            }
        }
        Ok(())
    }
}

/// Schema version for a durable coordinator retry decision.
pub const FMS_RETRY_DECISION_SCHEMA: &str = "retry_decision.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FmsRetryTrigger {
    CoordinatorRestart,
    WorkerDisconnected,
    LeaseLost,
    ResourceUnavailable,
    InvalidOutput,
    ExplicitOperatorRequest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FmsRetryAction {
    Retry,
    DoNotRetry,
    AwaitReconciliation,
}

/// An immutable decision recorded after task reconciliation.
///
/// The decision is fenced to the attempt that was observed.  Recording it is
/// deliberately separate from creating the next attempt: a coordinator may
/// replay the decision after a crash, but a stale worker cannot use it to
/// publish under a later ownership epoch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsRetryDecision {
    pub schema_version: String,
    pub decision_id: String,
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub ownership_epoch: u64,
    pub trigger: FmsRetryTrigger,
    pub action: FmsRetryAction,
    pub reason: String,
    pub created_at: DateTime<Utc>,
}

impl FmsRetryDecision {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_RETRY_DECISION_SCHEMA {
            bail!(
                "unsupported retry decision schema `{}`",
                self.schema_version
            );
        }
        for (value, field) in [
            (self.decision_id.as_str(), "decision_id"),
            (self.run_id.as_str(), "run_id"),
            (self.task_id.as_str(), "task_id"),
            (self.attempt_id.as_str(), "attempt_id"),
        ] {
            crate::repository_path::validate_store_id(value)
                .with_context(|| format!("invalid retry decision {field}"))?;
        }
        if self.ownership_epoch == 0 {
            bail!("retry decision ownership_epoch must be greater than zero");
        }
        if self.reason.trim().is_empty() {
            bail!("retry decision reason must not be empty");
        }
        Ok(())
    }

    pub fn validate_for_task(&self, task: &FmsTaskCatalogEntry) -> Result<()> {
        self.validate()?;
        if task.task_id != self.task_id
            || task.attempt_id.as_deref() != Some(self.attempt_id.as_str())
            || task.ownership_epoch != Some(self.ownership_epoch)
        {
            bail!("retry decision ownership fence does not match the run catalog");
        }
        match self.action {
            FmsRetryAction::Retry => {
                if !matches!(
                    task.lifecycle,
                    FmsTaskLifecycle::Failed | FmsTaskLifecycle::Interrupted
                ) {
                    bail!("retry action requires a failed or interrupted task");
                }
            }
            FmsRetryAction::DoNotRetry => {
                if !matches!(
                    task.lifecycle,
                    FmsTaskLifecycle::Succeeded
                        | FmsTaskLifecycle::Failed
                        | FmsTaskLifecycle::Cancelled
                        | FmsTaskLifecycle::Interrupted
                ) {
                    bail!("do_not_retry requires a terminal task");
                }
            }
            FmsRetryAction::AwaitReconciliation => {}
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryDecisionCommitDisposition {
    Accepted,
    Replayed,
}

/// Result of applying a durable retry decision to the run catalog.
///
/// `Replayed` means the decision was already persisted and the requested
/// catalog transition is already visible (or a newer ownership epoch has
/// superseded the observed attempt).  It is safe for a coordinator to return
/// this result after a crash between the journal write and catalog publish.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryDecisionApplyDisposition {
    Applied,
    Replayed,
}

/// Schema version for the durable coordinator message journal.
pub const FMS_COORDINATOR_JOURNAL_SCHEMA: &str = "coordinator_journal.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FmsCoordinatorJournalDirection {
    Command,
    Event,
}

impl FmsCoordinatorJournalDirection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Event => "event",
        }
    }
}

/// Durable, claim-fenced envelope for a worker command or event.
///
/// The session layer intentionally stores the payload as JSON so it can
/// recover a coordinator stream without owning the worker transport types.
/// The application protocol remains responsible for decoding and semantic
/// validation of that payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsCoordinatorJournalEntry {
    pub schema_version: String,
    pub entry_id: String,
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub ownership_epoch: u64,
    pub lease_token: String,
    pub direction: FmsCoordinatorJournalDirection,
    pub sequence: u64,
    pub terminal: bool,
    pub payload_sha256: String,
    pub payload: Value,
    pub created_at: DateTime<Utc>,
}

impl FmsCoordinatorJournalEntry {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_COORDINATOR_JOURNAL_SCHEMA {
            bail!(
                "unsupported coordinator journal schema `{}`",
                self.schema_version
            );
        }
        for (value, field) in [
            (self.entry_id.as_str(), "entry_id"),
            (self.run_id.as_str(), "run_id"),
            (self.task_id.as_str(), "task_id"),
            (self.attempt_id.as_str(), "attempt_id"),
            (self.lease_token.as_str(), "lease_token"),
        ] {
            crate::repository_path::validate_store_id(value)
                .with_context(|| format!("invalid coordinator journal {field}"))?;
        }
        if self.ownership_epoch == 0 {
            bail!("coordinator journal ownership_epoch must be greater than zero");
        }
        if self.sequence == 0 {
            bail!("coordinator journal sequence must be greater than zero");
        }
        if self.direction == FmsCoordinatorJournalDirection::Command && self.terminal {
            bail!("coordinator commands cannot be terminal journal entries");
        }
        if self.payload.is_null() {
            bail!("coordinator journal payload must not be null");
        }
        validate_sha256(&self.payload_sha256, "payload_sha256")?;
        let actual = canonical_json_sha256(&self.payload);
        if actual != self.payload_sha256 {
            bail!(
                "coordinator journal payload digest mismatch: expected {}, got {}",
                self.payload_sha256,
                actual
            );
        }
        Ok(())
    }

    pub fn validate_for_task(&self, task: &FmsTaskCatalogEntry) -> Result<()> {
        self.validate()?;
        if task.task_id != self.task_id
            || task.attempt_id.as_deref() != Some(self.attempt_id.as_str())
            || task.ownership_epoch != Some(self.ownership_epoch)
        {
            bail!("coordinator journal ownership fence does not match the run catalog");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoordinatorJournalCommitDisposition {
    Accepted,
    Replayed,
}

pub const FMS_ARTIFACT_CATALOG_SCHEMA: &str = "artifact_catalog.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FmsArtifactStatus {
    Published,
    Unavailable,
    Failed,
}

/// Study output identity attached to one artifact produced by a task.
///
/// The containing artifact catalog supplies the run identity; the task id is
/// checked against `step_id` so a producer cannot publish another step's port.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsStudyArtifactOutput {
    pub step_id: String,
    pub port_id: String,
    pub case_id: String,
}

impl FmsStudyArtifactOutput {
    fn validate(&self) -> Result<()> {
        validate_study_step_id(&self.step_id)?;
        crate::repository_path::validate_store_id(&self.port_id)?;
        crate::repository_path::validate_store_id(&self.case_id)?;
        Ok(())
    }
}

pub const FMS_STUDY_OUTPUT_MANIFEST_SCHEMA: &str = "study_output_manifest.v1";

/// Versioned type/codec references for the exact study outputs of one attempt.
/// The manifest is stored as a normal CAS-backed artifact catalog entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsStudyOutputManifest {
    pub schema_version: String,
    pub run_id: String,
    pub task_id: String,
    pub step_id: String,
    pub attempt_id: String,
    pub ownership_epoch: u64,
    pub outputs: Vec<FmsStudyOutputManifestEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsStudyOutputManifestEntry {
    pub port_id: String,
    pub case_id: String,
    pub data_kind: String,
    pub codec_id: String,
    pub codec_version: String,
    pub artifact_id: String,
    pub object_ref: String,
    pub content_sha256: String,
}

impl FmsStudyOutputManifest {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_STUDY_OUTPUT_MANIFEST_SCHEMA {
            bail!(
                "unsupported study output manifest schema `{}`",
                self.schema_version
            );
        }
        crate::repository_path::validate_store_id(&self.run_id)?;
        crate::repository_path::validate_store_id(&self.task_id)?;
        validate_study_step_id(&self.step_id)?;
        crate::repository_path::validate_store_id(&self.attempt_id)?;
        if self.ownership_epoch == 0 {
            bail!("study output manifest ownership_epoch must be greater than zero");
        }
        let expected_task_id = task_id_for_study_step(&self.run_id, &self.step_id)?;
        if self.task_id != expected_task_id {
            bail!("study output manifest task does not match its run and step");
        }

        let mut outputs = std::collections::BTreeSet::new();
        let mut artifact_ids = std::collections::BTreeSet::new();
        for output in &self.outputs {
            crate::repository_path::validate_store_id(&output.port_id)?;
            crate::repository_path::validate_store_id(&output.case_id)?;
            crate::repository_path::validate_store_id(&output.data_kind)?;
            crate::repository_path::validate_store_id(&output.codec_id)?;
            crate::repository_path::validate_store_id(&output.codec_version)?;
            crate::repository_path::validate_store_id(&output.artifact_id)?;
            validate_sha256(&output.object_ref, "study output object_ref")?;
            validate_sha256(&output.content_sha256, "study output content_sha256")?;
            if output.object_ref != output.content_sha256 {
                bail!("study output manifest CAS reference and content digest differ");
            }
            if !outputs.insert((output.port_id.as_str(), output.case_id.as_str())) {
                bail!("study output manifest contains a duplicate port/case entry");
            }
            if !artifact_ids.insert(output.artifact_id.as_str()) {
                bail!("study output manifest contains a duplicate artifact id");
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FmsArtifactCatalogEntry {
    pub artifact_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub ownership_epoch: u64,
    pub logical_path: String,
    pub artifact_type: String,
    pub content_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_ref: Option<String>,
    pub status: FmsArtifactStatus,
    pub required: bool,
    /// Optional for legacy artifacts. New study outputs must identify the
    /// exact producing step, output port, and case before StepOutput dispatch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub study_output: Option<FmsStudyArtifactOutput>,
}

impl FmsArtifactCatalogEntry {
    fn validate(&self) -> Result<()> {
        crate::repository_path::validate_store_id(&self.artifact_id)?;
        crate::repository_path::validate_store_id(&self.task_id)?;
        crate::repository_path::validate_store_id(&self.attempt_id)?;
        if self.ownership_epoch == 0 {
            bail!("artifact ownership_epoch must be greater than zero");
        }
        crate::repository_path::validate_relative_path(&self.logical_path)?;
        crate::repository_path::validate_store_id(&self.artifact_type)?;
        validate_sha256(&self.content_sha256, "content_sha256")?;
        if let Some(object_ref) = &self.object_ref {
            validate_sha256(object_ref, "object_ref")?;
        }
        if let Some(output) = &self.study_output {
            output.validate()?;
            if self.status != FmsArtifactStatus::Published {
                bail!("study output lineage requires a published artifact");
            }
        }
        Ok(())
    }
}

/// Immutable publication catalog for outputs owned by task attempts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsArtifactCatalog {
    pub schema_version: String,
    pub run_id: String,
    pub revision: u64,
    pub updated_at: DateTime<Utc>,
    pub entries: Vec<FmsArtifactCatalogEntry>,
}

impl FmsArtifactCatalog {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_ARTIFACT_CATALOG_SCHEMA {
            bail!(
                "unsupported artifact catalog schema `{}`",
                self.schema_version
            );
        }
        crate::repository_path::validate_store_id(&self.run_id)?;
        if self.revision == 0 {
            bail!("artifact catalog revision must be greater than zero");
        }
        let mut artifact_ids = std::collections::BTreeSet::new();
        let mut logical_paths = std::collections::BTreeSet::new();
        let mut study_outputs = std::collections::BTreeSet::new();
        for entry in &self.entries {
            entry.validate()?;
            if let Some(output) = &entry.study_output {
                let expected_task_id = task_id_for_study_step(&self.run_id, &output.step_id)?;
                if entry.task_id != expected_task_id {
                    bail!(
                        "study output `{}/{}/{}` is not owned by its producing step task",
                        output.step_id,
                        output.port_id,
                        output.case_id
                    );
                }
                let output_identity = (
                    entry.task_id.as_str(),
                    entry.attempt_id.as_str(),
                    entry.ownership_epoch,
                    output,
                );
                if !study_outputs.insert(output_identity) {
                    bail!(
                        "duplicate study output identity `{}/{}/{}` for attempt `{}`",
                        output.step_id,
                        output.port_id,
                        output.case_id,
                        entry.attempt_id
                    );
                }
            }
            if !artifact_ids.insert(entry.artifact_id.as_str()) {
                bail!("duplicate artifact_id `{}` in catalog", entry.artifact_id);
            }
            if !logical_paths.insert(entry.logical_path.as_str()) {
                bail!("duplicate logical_path `{}` in catalog", entry.logical_path);
            }
        }
        Ok(())
    }
}

/// Schema version for the durable resource lease record.
pub const FMS_RESOURCE_LEASE_SCHEMA: &str = "resource_lease.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FmsResourceKind {
    Cpu,
    Gpu,
    Storage,
    Meshing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsResourceBudget {
    pub cpu_millis: u64,
    pub memory_bytes: u64,
    pub gpu_memory_bytes: u64,
    pub storage_bytes: u64,
}

impl FmsResourceBudget {
    fn validate(&self) -> Result<()> {
        if self.cpu_millis == 0
            && self.memory_bytes == 0
            && self.gpu_memory_bytes == 0
            && self.storage_bytes == 0
        {
            bail!("resource budget must reserve at least one resource");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FmsResourceLeaseState {
    Active,
    Released,
}

/// Durable ownership record for one physical resource.
///
/// An active record is intentionally not expired by wall-clock age.  Missing
/// heartbeats do not prove that a worker stopped or that device memory was
/// released; a coordinator must reconcile the process and publish an explicit
/// release before another task can acquire the resource.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsResourceLease {
    pub schema_version: String,
    pub resource_id: String,
    pub kind: FmsResourceKind,
    pub budget: FmsResourceBudget,
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub ownership_epoch: u64,
    pub lease_token: String,
    pub state: FmsResourceLeaseState,
    pub acquired_at: DateTime<Utc>,
    pub heartbeat_at: DateTime<Utc>,
    pub heartbeat_sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released_at: Option<DateTime<Utc>>,
}

impl FmsResourceLease {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_RESOURCE_LEASE_SCHEMA {
            bail!(
                "unsupported resource lease schema `{}`",
                self.schema_version
            );
        }
        for (value, field) in [
            (self.resource_id.as_str(), "resource_id"),
            (self.run_id.as_str(), "run_id"),
            (self.task_id.as_str(), "task_id"),
            (self.attempt_id.as_str(), "attempt_id"),
            (self.lease_token.as_str(), "lease_token"),
        ] {
            crate::repository_path::validate_store_id(value)
                .with_context(|| format!("invalid resource lease {field}"))?;
        }
        if self.ownership_epoch == 0 {
            bail!("resource lease ownership_epoch must be greater than zero");
        }
        self.budget.validate()?;
        match (self.state, self.released_at.is_some()) {
            (FmsResourceLeaseState::Active, true) => {
                bail!("active resource lease must not have released_at")
            }
            (FmsResourceLeaseState::Released, false) => {
                bail!("released resource lease requires released_at")
            }
            _ => {}
        }
        Ok(())
    }

    pub fn identity_matches(&self, other: &Self) -> bool {
        self.resource_id == other.resource_id
            && self.run_id == other.run_id
            && self.task_id == other.task_id
            && self.attempt_id == other.attempt_id
            && self.ownership_epoch == other.ownership_epoch
            && self.lease_token == other.lease_token
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceLeaseCommitDisposition {
    Acquired,
    Replayed,
}

/// Durable intent for admitting one queued task to a resource lease.
///
/// The record is published before the run-catalog and lease projections. If
/// the process stops between those writes, recovery can finish this exact
/// admission without inventing a new attempt or lease token.
pub const FMS_TASK_ADMISSION_SCHEMA: &str = "task_admission.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsTaskAdmissionRecord {
    pub schema_version: String,
    pub expected_catalog_revision: u64,
    pub queued_task: FmsTaskCatalogEntry,
    pub task: FmsTaskCatalogEntry,
    pub lease: FmsResourceLease,
}

impl FmsTaskAdmissionRecord {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_TASK_ADMISSION_SCHEMA {
            bail!("unsupported task admission schema `{}`", self.schema_version);
        }
        if self.expected_catalog_revision == 0 {
            bail!("task admission expected catalog revision must be positive");
        }
        self.lease.validate()?;
        self.queued_task.validate(&self.lease.run_id)?;
        self.task.validate(&self.lease.run_id)?;
        if self.queued_task.task_id != self.task.task_id
            || self.queued_task.input_fingerprint != self.task.input_fingerprint
            || self.queued_task.lifecycle != FmsTaskLifecycle::Queued
            || self.queued_task.readiness != FmsTaskReadiness::Ready
            || self.queued_task.attempt_id.is_some()
            || self.queued_task.resource_id.is_some()
            || self.queued_task.resolved_input_fingerprint.is_some()
        {
            bail!("task admission source is not a ready, unclaimed queued task");
        }
        let expected_epoch = self
            .queued_task
            .ownership_epoch
            .map_or(Some(1), |epoch| epoch.checked_add(1))
            .context("task admission ownership epoch exhausted")?;
        if self.task.lifecycle != FmsTaskLifecycle::Preparing
            || self.task.readiness != FmsTaskReadiness::Ready
            || self.task.ownership_epoch != Some(expected_epoch)
            || self.task.attempt_id.as_deref() != Some(self.lease.attempt_id.as_str())
            || self.task.ownership_epoch != Some(self.lease.ownership_epoch)
            || self.task.resource_id.as_deref() != Some(self.lease.resource_id.as_str())
            || self.task.resolved_input_fingerprint.is_some()
            || self.task.coordinator_watermark.is_some()
            || self.task.coordinator_genesis.is_some()
        {
            bail!("task admission payload does not describe a fresh preparing claim");
        }
        let mut expected_task = self.queued_task.clone();
        expected_task.lifecycle = FmsTaskLifecycle::Preparing;
        expected_task.readiness = FmsTaskReadiness::Ready;
        expected_task.attempt_id = Some(self.lease.attempt_id.clone());
        expected_task.ownership_epoch = Some(self.lease.ownership_epoch);
        expected_task.resource_id = Some(self.lease.resource_id.clone());
        expected_task.resolved_input_fingerprint = None;
        expected_task.coordinator_watermark = None;
        expected_task.coordinator_genesis = None;
        if self.task != expected_task {
            bail!("task admission changed fields outside the claim projection");
        }
        if self.lease.state != FmsResourceLeaseState::Active
            || self.lease.heartbeat_sequence != 0
        {
            bail!("task admission requires a fresh active resource lease");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskAdmissionCommitDisposition {
    Admitted,
    Replayed,
    Superseded,
}

/// Canonical JSON bytes shared by the durable session journal and the
/// application RunSpecification fingerprint.
pub fn canonical_json_bytes(value: &Value) -> Vec<u8> {
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

pub fn canonical_json_sha256(value: &Value) -> String {
    format!("{:x}", Sha256::digest(canonical_json_bytes(value)))
}

fn validate_sha256(value: &str, field: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        bail!("{field} must be a lowercase 64-character SHA-256 digest");
    }
    Ok(())
}

fn validate_prefixed_sha256(value: &str, field: &str) -> Result<()> {
    let digest = value
        .strip_prefix("sha256:")
        .ok_or_else(|| anyhow::anyhow!("{field} must use the sha256:<hex> form"))?;
    validate_sha256(digest, field)
}

/// Per-run manifest, written as `runs/<run_id>/run_manifest.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FmsRunManifest {
    pub run_id: String,
    pub status: RunStatus,
    pub study_kind: String,
    pub backend: String,
    pub precision: String,
    pub started_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<DateTime<Utc>>,
    pub total_steps: u64,
    pub total_time_s: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_state_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_checkpoint_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_index_ref: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    Paused,
    Completed,
    Failed,
    Interrupted,
}

// ── Checkpoint ─────────────────────────────────────────────────────────

/// Checkpoint descriptor, written as `runs/<run>/checkpoints/<cp>/checkpoint.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FmsCheckpoint {
    pub checkpoint_id: String,
    pub run_id: String,
    pub created_at: DateTime<Utc>,
    pub step: u64,
    pub time_s: f64,
    pub dt: f64,

    /// Compatibility fingerprints for determining restore class.
    pub compatibility: CheckpointCompatibility,

    /// Reference to serialized common state (fields, energies).
    pub common_state_ref: String,
    /// Reference to integrator state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrator_ref: Option<String>,
    /// Reference to RNG state (for stochastic LLG / thermal noise).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rng_ref: Option<String>,
    /// Reference to backend-specific restart payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_state_ref: Option<String>,
    /// References to serialized field tensors (CAS object IDs).
    pub field_refs: Vec<FieldRef>,
}

impl FmsCheckpoint {
    pub fn new(run_id: &str, step: u64, time_s: f64, dt: f64) -> Self {
        let cp_id = format!("cp-{:06}-{}", step, uuid::Uuid::new_v4());
        Self {
            checkpoint_id: cp_id.clone(),
            run_id: run_id.into(),
            created_at: Utc::now(),
            step,
            time_s,
            dt,
            compatibility: CheckpointCompatibility::default(),
            common_state_ref: format!("runs/{run_id}/checkpoints/{cp_id}/common_state.json"),
            integrator_ref: None,
            rng_ref: None,
            backend_state_ref: None,
            field_refs: Vec::new(),
        }
    }
}

/// Hashes and signatures for determining the restore class.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CheckpointCompatibility {
    /// ABI tag for exact resume matching, e.g. `"fullmag.fdm.cpu.llg.v1"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_abi: Option<String>,
    /// Hash of the normalized ProblemIR.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem_hash: Option<String>,
    /// Hash of the execution plan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_hash: Option<String>,
    /// Version of the state schema.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_schema_version: Option<String>,
    /// Engine identifier (e.g. `"fullmag-engine-cpu"`, `"fullmag-fem-sys-gpu"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_id: Option<String>,
    /// Runtime family (cpu / cuda / hip / …)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_family: Option<String>,
    /// Numerical precision (`"f32"` or `"f64"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precision: Option<String>,
    /// Study kind tag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub study_kind: Option<String>,
    /// Mesh/grid deterministic signature.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discretization_signature: Option<String>,
    /// Layout of field vectors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_layout_signature: Option<String>,
}

// ── Common solver state ────────────────────────────────────────────────

/// Snapshot of common solver state saved alongside a checkpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommonSolverState {
    pub step: u64,
    pub time_s: f64,
    pub dt: f64,
    pub energies: SolverEnergies,
    /// Magnetization as flat `[mx, my, mz, …]` or object refs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnetization_ref: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SolverEnergies {
    #[serde(default)]
    pub exchange: f64,
    #[serde(default)]
    pub demag: f64,
    #[serde(default)]
    pub zeeman: f64,
    #[serde(default)]
    pub anisotropy: f64,
    #[serde(default)]
    pub dmi: f64,
    #[serde(default)]
    pub rotated_dmi: f64,
    #[serde(default)]
    pub total: f64,
}

// ── Tensor descriptor ──────────────────────────────────────────────────

/// Describes a binary tensor stored in the CAS object store.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TensorDescriptor {
    pub format: String,
    pub name: String,
    pub dtype: TensorDtype,
    pub shape: Vec<usize>,
    pub logical_axes: Vec<String>,
    pub endian: String,
    /// CAS object refs for each chunk.
    pub chunks: Vec<TensorChunk>,
}

impl TensorDescriptor {
    pub fn new_f64(name: &str, shape: Vec<usize>, axes: Vec<String>) -> Self {
        Self {
            format: "fullmag.tensor.v1".into(),
            name: name.into(),
            dtype: TensorDtype::F64,
            shape,
            logical_axes: axes,
            endian: "little".into(),
            chunks: Vec::new(),
        }
    }

    pub fn total_elements(&self) -> usize {
        self.shape.iter().product()
    }

    pub fn total_bytes(&self) -> usize {
        self.total_elements() * self.dtype.byte_size()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TensorDtype {
    U8,
    I32,
    U32,
    F32,
    F64,
}

impl TensorDtype {
    pub fn byte_size(self) -> usize {
        match self {
            TensorDtype::U8 => 1,
            TensorDtype::I32 | TensorDtype::U32 | TensorDtype::F32 => 4,
            TensorDtype::F64 => 8,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TensorChunk {
    pub object_ref: String,
    /// Byte offset in the complete decoded tensor (not an element index).
    pub offset: usize,
    /// Exact number of bytes in this CAS object and its tensor range.
    pub length: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

// ── Field reference ────────────────────────────────────────────────────

/// A named reference to a serialized field in the archive.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldRef {
    pub name: String,
    pub role: FieldRole,
    pub tensor_descriptor_ref: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldRole {
    Primary,
    ResumeAux,
    DerivedCached,
    Rebuildable,
    PreviewOnly,
}

// ── Backend-specific payload ───────────────────────────────────────────

/// Envelope for backend restart payloads.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendStatePayload {
    pub format: String,
    pub backend_family: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrator_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrator_state: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rng_state: Option<RngState>,
    /// Arbitrary additional state the backend needs.
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub extra: serde_json::Value,
}

/// Counter-based RNG state for reproducible thermal noise.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RngState {
    pub global_seed: u64,
    pub stream_family: String,
    pub counter_base: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub substream_per_cell: Option<bool>,
    pub last_consumed_nonce: u64,
}

// ── Compatibility inspection ───────────────────────────────────────────

/// Result of inspecting a `.fms` file before committing to open it.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SessionInspection {
    pub format_version: String,
    pub session_id: String,
    pub name: String,
    pub profile: SaveProfile,
    pub created_by_version: String,
    pub created_at: DateTime<Utc>,
    pub saved_at: DateTime<Utc>,
    pub run_count: usize,
    pub latest_checkpoint: Option<CheckpointSummary>,
    pub restore_class: RestoreClass,
    pub warnings: Vec<String>,
    pub total_size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CheckpointSummary {
    pub checkpoint_id: String,
    pub step: u64,
    pub time_s: f64,
    pub study_kind: String,
}

// ── File lock ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionFileLock {
    pub session_id: String,
    pub host: String,
    pub pid: u32,
    pub locked_at: DateTime<Utc>,
    pub user: String,
}

// ── Artifact index ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactIndex {
    pub entries: Vec<ArtifactIndexEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactIndexEntry {
    pub logical_path: String,
    pub artifact_type: String,
    pub size_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_ref: Option<String>,
    pub required: bool,
}

// ── UI / project state placeholders ────────────────────────────────────

/// Serialized UI state snapshot (panel layout, tabs, selections, camera).
/// Stored as an opaque JSON document for forward compatibility.
pub type UiStateSnapshot = serde_json::Value;

/// Serialized scene document. Stored as opaque JSON.
pub type SceneDocumentSnapshot = serde_json::Value;

/// Serialized script builder state. Stored as opaque JSON.
pub type ScriptBuilderSnapshot = serde_json::Value;

/// Serialized model builder graph. Stored as opaque JSON.
pub type ModelBuilderGraphSnapshot = serde_json::Value;
