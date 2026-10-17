//! Core types for the Fullmag session persistence system.
//!
//! These types define the logical snapshot of a simulation session,
//! used for both the internal `SessionStore` and the portable `.fms` file format.

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, PathBuf};
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

pub const FMS_SESSION_FORMAT_V1: &str = "fullmag.session.v1";
pub const FMS_SESSION_FORMAT_V2: &str = "fullmag.session.v2";
pub const FMS_ACCEPTED_PROVENANCE_MANIFEST_REF: &str = "manifest/accepted_provenance.json";

/// Typed pointer to the detached accepted-run evidence closure in a v2 FMS.
///
/// This is provenance only. It carries no lease, claim, process, scheduler,
/// or resume authority and must never be used as a runtime store binding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsAcceptedProvenanceReference {
    pub manifest_ref: String,
    pub accepted_run_id: String,
    pub closure_sha256: String,
}

impl FmsAcceptedProvenanceReference {
    pub fn validate(&self) -> Result<()> {
        if self.manifest_ref != FMS_ACCEPTED_PROVENANCE_MANIFEST_REF {
            bail!("accepted provenance manifest reference is not canonical");
        }
        crate::repository_path::validate_store_id(&self.accepted_run_id)
            .context("invalid accepted provenance run id")?;
        validate_prefixed_sha256(&self.closure_sha256, "accepted provenance closure_sha256")
    }
}

/// Top-level manifest written as `manifest/session.json` in the `.fms` archive.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsSessionManifest {
    /// `fullmag.session.v1` for ordinary archives or `fullmag.session.v2`
    /// when an evidence-only accepted-run provenance closure is attached.
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
    /// References to durable accepted batch intents.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub batch_refs: Vec<String>,
    /// Reference to workspace manifest.
    pub workspace_ref: String,
    /// Reference to export profile.
    pub export_profile_ref: String,
    /// Present only for `fullmag.session.v2`; points to an evidence-only
    /// accepted-run closure under `manifest/accepted_provenance.json`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_provenance_ref: Option<FmsAcceptedProvenanceReference>,
}

impl FmsSessionManifest {
    pub fn new(
        session_id: impl Into<String>,
        name: impl Into<String>,
        profile: SaveProfile,
    ) -> Self {
        let now = Utc::now();
        Self {
            format: FMS_SESSION_FORMAT_V1.into(),
            session_id: session_id.into(),
            name: name.into(),
            profile,
            created_by_version: env!("CARGO_PKG_VERSION").into(),
            created_at: now,
            saved_at: now,
            description: None,
            run_refs: Vec::new(),
            batch_refs: Vec::new(),
            workspace_ref: "manifest/workspace.json".into(),
            export_profile_ref: "manifest/export_profile.json".into(),
            accepted_provenance_ref: None,
        }
    }
}

// ── Workspace manifest ─────────────────────────────────────────────────

/// Workspace layout metadata, written as `manifest/workspace.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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

/// Schema version for the durable parent record of an independent batch.
pub const FMS_BATCH_INTENT_SCHEMA: &str = "batch_intent.v1";
pub const FMS_BATCH_SUBMIT_SNAPSHOT_LEGACY_SCHEMA: &str = "batch_submit_snapshot.v1";
pub const FMS_BATCH_SUBMIT_SNAPSHOT_SCHEMA: &str = "batch_submit_snapshot.v2";
pub const FMS_BATCH_OUTPUT_STORAGE_SNAPSHOT_LEGACY_SCHEMA: &str =
    "batch_output_storage_snapshot.v1";
pub const FMS_BATCH_OUTPUT_STORAGE_SNAPSHOT_SCHEMA: &str = "batch_output_storage_snapshot.v2";
pub const FMS_BATCH_EXPANSION_MANIFEST_SCHEMA: &str = "batch_expansion_manifest.v2";
pub const FMS_BATCH_EXPANSION_PROGRESS_LEGACY_SCHEMA: &str = "batch_expansion_progress.v1";
pub const FMS_BATCH_EXPANSION_PROGRESS_SCHEMA: &str = "batch_expansion_progress.v2";
pub const FMS_BATCH_COMMAND_SCHEMA: &str = "batch_command.v1";
const FMS_BATCH_EXPANSION_MAX_CASES: usize = 10_000;
pub(crate) const FMS_BATCH_COMMAND_HISTORY_MAX: usize = 128;

/// Immutable accepted batch intent, published before any child run is
/// acknowledged. The application owns the typed request and expansion
/// manifest; this envelope pins their exact source objects in the session CAS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsBatchIntent {
    pub schema_version: String,
    pub batch_id: String,
    pub idempotency_key: String,
    pub payload_sha256: String,
    pub accepted_at: DateTime<Utc>,
    /// Versioned batch Submit snapshot containing the typed request and
    /// logical expansion-manifest digest. Version 2 pins OutputStorage;
    /// version 1 remains readable for already accepted batches.
    pub specification: Value,
    pub manifest_object_ref: String,
    pub definition_object_ref: String,
    pub study_object_ref: String,
    pub study_catalog_object_ref: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub asset_object_refs: BTreeMap<String, String>,
}

impl FmsBatchIntent {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        batch_id: impl Into<String>,
        idempotency_key: impl Into<String>,
        specification: Value,
        manifest_object_ref: impl Into<String>,
        definition_object_ref: impl Into<String>,
        study_object_ref: impl Into<String>,
        study_catalog_object_ref: impl Into<String>,
        asset_object_refs: BTreeMap<String, String>,
    ) -> Self {
        let payload_sha256 = canonical_json_sha256(&specification);
        Self {
            schema_version: FMS_BATCH_INTENT_SCHEMA.into(),
            batch_id: batch_id.into(),
            idempotency_key: idempotency_key.into(),
            payload_sha256,
            accepted_at: Utc::now(),
            specification,
            manifest_object_ref: manifest_object_ref.into(),
            definition_object_ref: definition_object_ref.into(),
            study_object_ref: study_object_ref.into(),
            study_catalog_object_ref: study_catalog_object_ref.into(),
            asset_object_refs,
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_BATCH_INTENT_SCHEMA {
            bail!("unsupported batch intent schema `{}`", self.schema_version);
        }
        crate::repository_path::validate_store_id(&self.batch_id)?;
        crate::repository_path::validate_store_id(&self.idempotency_key)?;
        validate_sha256(&self.payload_sha256, "payload_sha256")?;
        validate_sha256(&self.manifest_object_ref, "manifest_object_ref")?;
        validate_sha256(&self.definition_object_ref, "definition_object_ref")?;
        validate_sha256(&self.study_object_ref, "study_object_ref")?;
        validate_sha256(&self.study_catalog_object_ref, "study_catalog_object_ref")?;

        let snapshot_schema = self
            .specification
            .get("schema_version")
            .and_then(Value::as_str)
            .context("batch intent specification has no schema_version")?;
        let output_storage = self.specification.get("output_storage");
        if snapshot_schema == FMS_BATCH_SUBMIT_SNAPSHOT_SCHEMA {
            validate_batch_output_storage_snapshot(
                output_storage
                    .context("batch_submit_snapshot.v2 requires an output_storage snapshot")?,
            )?;
        } else if snapshot_schema == FMS_BATCH_SUBMIT_SNAPSHOT_LEGACY_SCHEMA {
            if let Some(snapshot) = output_storage {
                validate_batch_output_storage_snapshot(snapshot)?;
            }
        } else {
            bail!("unsupported batch submit snapshot schema `{snapshot_schema}`");
        }
        if self.specification.get("batch_id").and_then(Value::as_str)
            != Some(self.batch_id.as_str())
        {
            bail!("batch intent specification batch_id does not match its envelope");
        }
        let manifest_sha256 = self
            .specification
            .get("manifest_sha256")
            .and_then(Value::as_str)
            .context("batch intent specification has no manifest_sha256")?;
        validate_sha256(manifest_sha256, "manifest_sha256")?;

        let request = self
            .specification
            .get("request")
            .context("batch intent specification has no request")?;
        if request.get("batch_id").and_then(Value::as_str) != Some(self.batch_id.as_str()) {
            bail!("batch request batch_id does not match its envelope");
        }
        let template = request
            .get("template")
            .context("batch request has no template RunSpecification")?;
        if template
            .pointer("/snapshot/definition_sha256")
            .and_then(Value::as_str)
            != Some(self.definition_object_ref.as_str())
        {
            bail!("batch definition object does not match template snapshot digest");
        }
        if template
            .pointer("/study/plan_sha256")
            .and_then(Value::as_str)
            != Some(self.study_object_ref.as_str())
        {
            bail!("batch study object does not match template plan digest");
        }
        if template.get("study_catalog_sha256").and_then(Value::as_str)
            != Some(self.study_catalog_object_ref.as_str())
        {
            bail!("batch study catalog object does not match template catalog digest");
        }

        let assets = template
            .get("immutable_assets")
            .and_then(Value::as_array)
            .context("batch template has no immutable_assets array")?;
        if assets.len() != self.asset_object_refs.len() {
            bail!("batch asset object count differs from immutable_assets");
        }
        let mut seen = BTreeSet::new();
        for asset in assets {
            let asset_id = asset
                .get("asset_id")
                .and_then(Value::as_str)
                .context("batch immutable asset has no asset_id")?;
            let content_sha256 = asset
                .get("content_sha256")
                .and_then(Value::as_str)
                .context("batch immutable asset has no content_sha256")?;
            if !seen.insert(asset_id)
                || self.asset_object_refs.get(asset_id).map(String::as_str) != Some(content_sha256)
            {
                bail!("batch asset object does not match immutable asset reference");
            }
            validate_sha256(content_sha256, "asset_object_ref")?;
        }

        let actual = canonical_json_sha256(&self.specification);
        if actual != self.payload_sha256 {
            bail!(
                "batch intent payload digest mismatch: expected {}, got {}",
                self.payload_sha256,
                actual
            );
        }
        Ok(())
    }

    /// Verify that the pinned CAS bytes are the exact expansion manifest
    /// described by the logical digest in the immutable submit snapshot.
    pub fn validate_manifest_bytes(&self, bytes: &[u8]) -> Result<()> {
        self.validate()?;
        if crate::cas::hex_sha256(bytes) != self.manifest_object_ref {
            bail!("batch expansion manifest object digest mismatch");
        }
        let mut manifest: Value = serde_json::from_slice(bytes)
            .context("batch expansion manifest object is not valid JSON")?;
        if manifest.get("schema_version").and_then(Value::as_str)
            != Some(FMS_BATCH_EXPANSION_MANIFEST_SCHEMA)
        {
            bail!("unsupported batch expansion manifest schema");
        }
        if manifest.get("batch_id").and_then(Value::as_str) != Some(self.batch_id.as_str()) {
            bail!("batch expansion manifest batch_id does not match its intent");
        }
        let case_count = manifest
            .get("cases")
            .and_then(Value::as_array)
            .map(Vec::len)
            .context("batch expansion manifest has no cases array")?;
        if case_count == 0 || case_count > FMS_BATCH_EXPANSION_MAX_CASES {
            bail!(
                "batch expansion manifest case count must be between 1 and {FMS_BATCH_EXPANSION_MAX_CASES}"
            );
        }
        let recorded_digest = manifest
            .get("manifest_sha256")
            .and_then(Value::as_str)
            .context("batch expansion manifest has no manifest_sha256")?
            .to_string();
        validate_sha256(&recorded_digest, "manifest_sha256")?;
        let object = manifest
            .as_object_mut()
            .context("batch expansion manifest must be a JSON object")?;
        object.remove("manifest_sha256");
        let calculated_digest = canonical_json_sha256(&manifest);
        if calculated_digest != recorded_digest
            || self
                .specification
                .get("manifest_sha256")
                .and_then(Value::as_str)
                != Some(calculated_digest.as_str())
        {
            bail!("batch expansion manifest does not match its accepted logical digest");
        }
        Ok(())
    }
}

fn validate_batch_output_storage_snapshot(snapshot: &Value) -> Result<()> {
    let schema = snapshot
        .get("schema_version")
        .and_then(Value::as_str)
        .context("batch output_storage snapshot has no schema_version")?;
    match schema {
        FMS_BATCH_OUTPUT_STORAGE_SNAPSHOT_LEGACY_SCHEMA => {
            validate_legacy_batch_output_storage_snapshot(snapshot)
        }
        FMS_BATCH_OUTPUT_STORAGE_SNAPSHOT_SCHEMA => {
            validate_resolved_batch_output_storage_snapshot(snapshot)
        }
        _ => bail!("unsupported batch output_storage schema `{schema}`"),
    }
}

fn validate_legacy_batch_output_storage_snapshot(snapshot: &Value) -> Result<()> {
    if snapshot.get("source").and_then(Value::as_str) != Some("workspace_defaults") {
        bail!("batch output_storage source must be `workspace_defaults`");
    }
    let settings_value = snapshot
        .get("settings")
        .filter(|value| value.is_object())
        .context("batch output_storage snapshot has no settings object")?;
    let settings: BatchOutputStorageSettings = serde_json::from_value(settings_value.clone())
        .context("batch output_storage settings do not match the defaults contract")?;
    let ir = fullmag_ir::OutputStorageIR {
        output_dir: Some(settings.output_parent.clone()),
        temp_dir: settings.temp_parent.clone(),
        data_format: settings.data_format,
        cleanup: settings.cleanup,
        existing_output: settings.existing_output,
    };
    ir.validate()
        .map_err(|errors| anyhow::anyhow!(errors.join("; ")))
        .context("invalid batch output_storage paths")?;
    if !PathBuf::from(&settings.output_parent).is_absolute() {
        bail!("batch output_storage output_parent must be an absolute path");
    }
    if settings
        .temp_parent
        .as_deref()
        .is_some_and(|path| !PathBuf::from(path).is_absolute())
    {
        bail!("batch output_storage temp_parent must be an absolute path");
    }
    let expected = snapshot
        .get("settings_sha256")
        .and_then(Value::as_str)
        .context("batch output_storage snapshot has no settings_sha256")?;
    validate_sha256(expected, "output_storage.settings_sha256")?;
    if canonical_json_sha256(settings_value) != expected {
        bail!("batch output_storage settings digest does not match its snapshot");
    }
    Ok(())
}

fn validate_resolved_batch_output_storage_snapshot(snapshot: &Value) -> Result<()> {
    let source = snapshot
        .get("source")
        .and_then(Value::as_str)
        .context("batch output_storage snapshot has no source")?;
    if !matches!(source, "workspace_defaults" | "project_authoring") {
        bail!("unsupported batch output_storage source `{source}`");
    }
    let settings_value = snapshot
        .get("settings")
        .filter(|value| value.is_object())
        .context("batch output_storage snapshot has no settings object")?;
    let settings: fullmag_ir::OutputStorageIR = serde_json::from_value(settings_value.clone())
        .context(
            "batch output_storage settings do not match the resolved OutputStorage contract",
        )?;
    settings
        .validate()
        .map_err(|errors| anyhow::anyhow!(errors.join("; ")))
        .context("invalid resolved batch output_storage paths")?;
    let output_dir = settings
        .output_dir
        .as_deref()
        .context("resolved batch output_storage requires output_dir")?;
    if !PathBuf::from(output_dir).is_absolute() {
        bail!("resolved batch output_storage output_dir must be an absolute path");
    }
    if settings
        .temp_dir
        .as_deref()
        .is_some_and(|path| !PathBuf::from(path).is_absolute())
    {
        bail!("resolved batch output_storage temp_dir must be an absolute path");
    }

    for field in ["settings_sha256", "workspace_defaults_sha256"] {
        let digest = snapshot
            .get(field)
            .and_then(Value::as_str)
            .with_context(|| format!("batch output_storage snapshot has no {field}"))?;
        validate_sha256(digest, &format!("output_storage.{field}"))?;
    }
    let expected = snapshot
        .get("settings_sha256")
        .and_then(Value::as_str)
        .context("batch output_storage snapshot has no settings_sha256")?;
    if canonical_json_sha256(settings_value) != expected {
        bail!("batch output_storage settings digest does not match its snapshot");
    }
    match (source, snapshot.get("authoring_policy_sha256")) {
        ("workspace_defaults", None) => {}
        ("project_authoring", Some(Value::String(digest))) => {
            validate_sha256(digest, "output_storage.authoring_policy_sha256")?;
        }
        ("workspace_defaults", Some(_)) => {
            bail!("workspace-default output_storage cannot include an authoring policy digest")
        }
        ("project_authoring", _) => {
            bail!("project-authoring output_storage requires an authoring policy digest")
        }
        _ => bail!("unsupported batch output_storage source `{source}`"),
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchOutputStorageSettings {
    output_parent: String,
    #[serde(default)]
    temp_parent: Option<String>,
    #[serde(default)]
    data_format: fullmag_ir::OutputDataFormatIR,
    #[serde(default)]
    cleanup: fullmag_ir::TempCleanupIR,
    #[serde(default)]
    existing_output: fullmag_ir::ExistingOutputIR,
}

/// Durable expansion cursor for publishing deterministic child run intents.
/// `next_case_index` is a prefix length: cases before it must already have
/// idempotently published child intents, while cases at and after it remain
/// eligible for recovery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsBatchExpansionProgress {
    pub schema_version: String,
    pub batch_id: String,
    pub manifest_object_ref: String,
    pub manifest_sha256: String,
    pub total_cases: u64,
    pub next_case_index: u64,
    pub sequence: u64,
    pub state: FmsBatchExpansionState,
    /// Append-only admission command history. Empty is the legacy v1 form.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commands: Vec<FmsBatchCommandIntent>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FmsBatchExpansionState {
    Pending,
    Expanding,
    Complete,
    Stopped,
    Paused,
    Cancelled,
}

/// Durable admission commands for an accepted batch. CancelAdmission stops
/// publishing future cases and lets already-published cases finish.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FmsBatchCommandAction {
    PauseAdmission,
    ResumeAdmission,
    CancelAdmission,
}

impl FmsBatchCommandAction {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::PauseAdmission => "pause_admission",
            Self::ResumeAdmission => "resume_admission",
            Self::CancelAdmission => "cancel_admission",
        }
    }
}

/// Immutable command receipt appended to the batch expansion checkpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsBatchCommandIntent {
    pub schema_version: String,
    pub batch_id: String,
    pub command_id: String,
    pub expected_revision: u64,
    pub revision: u64,
    pub action: FmsBatchCommandAction,
    pub reason: String,
    pub created_at: DateTime<Utc>,
    pub payload_sha256: String,
}

impl FmsBatchCommandIntent {
    pub fn new(
        batch_id: impl Into<String>,
        command_id: impl Into<String>,
        expected_revision: u64,
        action: FmsBatchCommandAction,
        reason: impl Into<String>,
    ) -> Self {
        let batch_id = batch_id.into();
        let command_id = command_id.into();
        let reason = reason.into();
        let revision = expected_revision.saturating_add(1);
        let payload_sha256 = canonical_json_sha256(&serde_json::json!({
            "batch_id": batch_id,
            "command_id": command_id,
            "expected_revision": expected_revision,
            "revision": revision,
            "action": action.as_str(),
            "reason": reason,
        }));
        Self {
            schema_version: FMS_BATCH_COMMAND_SCHEMA.into(),
            batch_id,
            command_id,
            expected_revision,
            revision,
            action,
            reason,
            created_at: Utc::now(),
            payload_sha256,
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_BATCH_COMMAND_SCHEMA {
            bail!("unsupported batch command schema `{}`", self.schema_version);
        }
        crate::repository_path::validate_store_id(&self.batch_id)?;
        crate::repository_path::validate_store_id(&self.command_id)?;
        if self.revision
            != self
                .expected_revision
                .checked_add(1)
                .context("batch command revision overflow")?
        {
            bail!("batch command revision does not follow its expected revision");
        }
        if self.reason.trim().is_empty() || self.reason.len() > 1024 {
            bail!("batch command reason must be nonempty and at most 1024 bytes");
        }
        validate_sha256(&self.payload_sha256, "payload_sha256")?;
        let expected = canonical_json_sha256(&serde_json::json!({
            "batch_id": self.batch_id,
            "command_id": self.command_id,
            "expected_revision": self.expected_revision,
            "revision": self.revision,
            "action": self.action.as_str(),
            "reason": self.reason,
        }));
        if self.payload_sha256 != expected {
            bail!("batch command payload digest does not match its contents");
        }
        Ok(())
    }
}

impl FmsBatchExpansionProgress {
    pub fn new(
        intent: &FmsBatchIntent,
        total_cases: u64,
        next_case_index: u64,
        sequence: u64,
    ) -> Result<Self> {
        let manifest_sha256 = intent
            .specification
            .get("manifest_sha256")
            .and_then(Value::as_str)
            .context("batch intent has no manifest digest")?
            .to_string();
        let state = if next_case_index == 0 {
            FmsBatchExpansionState::Pending
        } else if next_case_index == total_cases {
            FmsBatchExpansionState::Complete
        } else {
            FmsBatchExpansionState::Expanding
        };
        let progress = Self {
            schema_version: FMS_BATCH_EXPANSION_PROGRESS_SCHEMA.into(),
            batch_id: intent.batch_id.clone(),
            manifest_object_ref: intent.manifest_object_ref.clone(),
            manifest_sha256,
            total_cases,
            next_case_index,
            sequence,
            state,
            commands: Vec::new(),
            updated_at: Utc::now(),
        };
        progress.validate()?;
        Ok(progress)
    }

    pub fn new_stopped(
        intent: &FmsBatchIntent,
        total_cases: u64,
        next_case_index: u64,
        sequence: u64,
    ) -> Result<Self> {
        if next_case_index == 0 || next_case_index >= total_cases {
            bail!("stopped batch expansion must have a published, incomplete prefix");
        }
        let mut progress = Self::new(intent, total_cases, next_case_index, sequence)?;
        progress.state = FmsBatchExpansionState::Stopped;
        progress.validate()?;
        Ok(progress)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_BATCH_EXPANSION_PROGRESS_SCHEMA
            && self.schema_version != FMS_BATCH_EXPANSION_PROGRESS_LEGACY_SCHEMA
        {
            bail!(
                "unsupported batch expansion progress schema `{}`",
                self.schema_version
            );
        }
        crate::repository_path::validate_store_id(&self.batch_id)?;
        validate_sha256(&self.manifest_object_ref, "manifest_object_ref")?;
        validate_sha256(&self.manifest_sha256, "manifest_sha256")?;
        if self.total_cases == 0
            || self.total_cases > FMS_BATCH_EXPANSION_MAX_CASES as u64
            || self.next_case_index > self.total_cases
            || self.sequence == 0
        {
            bail!("batch expansion progress counters are outside their valid range");
        }
        if self.commands.len() > FMS_BATCH_COMMAND_HISTORY_MAX {
            bail!("batch command history exceeds its limit");
        }
        if self.schema_version == FMS_BATCH_EXPANSION_PROGRESS_LEGACY_SCHEMA
            && !self.commands.is_empty()
        {
            bail!("legacy batch expansion progress cannot contain command history");
        }
        let mut command_ids = BTreeSet::new();
        for (index, command) in self.commands.iter().enumerate() {
            command.validate()?;
            let expected_revision = u64::try_from(index)?;
            if command.batch_id != self.batch_id
                || command.expected_revision != expected_revision
                || command.revision != expected_revision + 1
                || !command_ids.insert(command.command_id.as_str())
            {
                bail!("batch command history is inconsistent with its batch or revision");
            }
        }
        let expected_state = if self.next_case_index == 0 {
            FmsBatchExpansionState::Pending
        } else if self.next_case_index == self.total_cases {
            FmsBatchExpansionState::Complete
        } else {
            FmsBatchExpansionState::Expanding
        };
        let valid_stopped_state = self.state == FmsBatchExpansionState::Stopped
            && self.next_case_index > 0
            && self.next_case_index < self.total_cases;
        let latest_action = self.commands.last().map(|command| command.action);
        let valid_command_state = match self.state {
            FmsBatchExpansionState::Paused => {
                self.next_case_index < self.total_cases
                    && latest_action == Some(FmsBatchCommandAction::PauseAdmission)
            }
            FmsBatchExpansionState::Cancelled => {
                latest_action == Some(FmsBatchCommandAction::CancelAdmission)
            }
            _ => false,
        };
        if self.state != expected_state && !valid_stopped_state && !valid_command_state {
            bail!("batch expansion progress state does not match its cursor");
        }
        Ok(())
    }

    pub fn validate_for_manifest(
        &self,
        intent: &FmsBatchIntent,
        manifest_bytes: &[u8],
    ) -> Result<()> {
        self.validate()?;
        intent.validate_manifest_bytes(manifest_bytes)?;
        let manifest: Value = serde_json::from_slice(manifest_bytes)
            .context("batch expansion manifest object is not valid JSON")?;
        if self.state == FmsBatchExpansionState::Stopped
            && manifest.get("failure_policy").and_then(Value::as_str) != Some("stop_admission")
        {
            bail!("stopped batch expansion requires stop_admission failure policy");
        }
        let total_cases = manifest
            .get("cases")
            .and_then(Value::as_array)
            .map(Vec::len)
            .context("batch expansion manifest has no cases array")?;
        let manifest_sha256 = intent
            .specification
            .get("manifest_sha256")
            .and_then(Value::as_str)
            .context("batch intent has no manifest digest")?;
        if self.batch_id != intent.batch_id
            || self.manifest_object_ref != intent.manifest_object_ref
            || self.manifest_sha256 != manifest_sha256
            || self.total_cases != u64::try_from(total_cases)?
        {
            bail!("batch expansion progress differs from its immutable intent");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchExpansionProgressCommitDisposition {
    Accepted,
    Replayed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchCommandCommitDisposition {
    Accepted,
    Replayed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BatchCommandConflict {
    Revision {
        expected: u64,
        actual: u64,
    },
    Identity,
    InvalidTransition {
        action: &'static str,
        state: FmsBatchExpansionState,
    },
}

impl std::fmt::Display for BatchCommandConflict {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Revision { expected, actual } => write!(
                formatter,
                "batch command revision conflict: expected {expected}, found {actual}"
            ),
            Self::Identity => {
                formatter.write_str("batch command id was reused for another request")
            }
            Self::InvalidTransition { action, state } => write!(
                formatter,
                "batch command `{action}` is invalid while expansion is {state:?}"
            ),
        }
    }
}

impl std::error::Error for BatchCommandConflict {}

/// Result of publishing an immutable batch parent intent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BatchIntentCommitDisposition {
    Accepted,
    Replayed { batch_id: String },
}

pub const FMS_SCHEDULER_POOL_CHECKPOINT_SCHEMA: &str = "scheduler_pool_checkpoint.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FmsSchedulerRunSource {
    Explicit,
    Store,
}

/// Operational cursor for one bounded scheduler pool. This state belongs to
/// the local store and is deliberately not part of a portable project export.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsSchedulerPoolCheckpoint {
    pub schema_version: String,
    pub pool_id: String,
    pub sequence: u64,
    pub run_source: FmsSchedulerRunSource,
    pub run_ids: Vec<String>,
    pub next_run_id: Option<String>,
}

impl FmsSchedulerPoolCheckpoint {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_SCHEDULER_POOL_CHECKPOINT_SCHEMA {
            bail!(
                "unsupported scheduler pool checkpoint schema `{}`",
                self.schema_version
            );
        }
        crate::repository_path::validate_store_id(&self.pool_id)?;
        if self.sequence == 0 {
            bail!("scheduler pool checkpoint sequence must be positive");
        }
        let mut seen = BTreeSet::new();
        for run_id in &self.run_ids {
            crate::repository_path::validate_store_id(run_id)?;
            if !seen.insert(run_id) {
                bail!("scheduler pool checkpoint contains a duplicate run id");
            }
        }
        if matches!(self.run_source, FmsSchedulerRunSource::Explicit) && self.run_ids.is_empty() {
            bail!("explicit scheduler pool checkpoint requires run ids");
        }
        if let Some(next_run_id) = self.next_run_id.as_deref() {
            crate::repository_path::validate_store_id(next_run_id)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulerPoolCheckpointCommitDisposition {
    Accepted,
    Replayed,
}

pub const FMS_SCHEDULER_RESOURCE_POOL_SCHEMA: &str = "scheduler_resource_pool.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsSchedulerResourceOffer {
    pub resource_id: String,
    pub kind: FmsResourceKind,
    pub budget: FmsResourceBudget,
}

impl FmsSchedulerResourceOffer {
    pub fn validate(&self) -> Result<()> {
        crate::repository_path::validate_store_id(&self.resource_id)?;
        if self.budget.cpu_millis == 0 {
            bail!("scheduler resource offer requires positive cpu_millis");
        }
        if self.budget.memory_bytes == 0 {
            bail!("scheduler resource offer requires positive memory_bytes");
        }
        if self.budget.storage_bytes == 0 {
            bail!("scheduler resource offer requires positive storage_bytes");
        }
        match self.kind {
            FmsResourceKind::Cpu if self.budget.gpu_memory_bytes != 0 => {
                bail!("CPU scheduler resource offer requires zero gpu_memory_bytes")
            }
            FmsResourceKind::Gpu if self.budget.gpu_memory_bytes == 0 => {
                bail!("GPU scheduler resource offer requires positive gpu_memory_bytes")
            }
            FmsResourceKind::Cpu | FmsResourceKind::Gpu => {}
            FmsResourceKind::Storage | FmsResourceKind::Meshing => {
                bail!("scheduler solver resource pool supports only CPU and GPU offers")
            }
        }
        Ok(())
    }
}

/// Monotonic local membership snapshot for one scheduler resource pool.
/// Removal blocks new admission only; an active fenced lease remains the
/// authority until its supervisor publishes an explicit release.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsSchedulerResourcePool {
    pub schema_version: String,
    pub pool_id: String,
    pub generation: u64,
    pub resources: Vec<FmsSchedulerResourceOffer>,
}

impl FmsSchedulerResourcePool {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_SCHEDULER_RESOURCE_POOL_SCHEMA {
            bail!(
                "unsupported scheduler resource pool schema `{}`",
                self.schema_version
            );
        }
        crate::repository_path::validate_store_id(&self.pool_id)?;
        if self.generation == 0 {
            bail!("scheduler resource pool generation must be positive");
        }
        let mut seen = BTreeSet::new();
        for resource in &self.resources {
            resource.validate()?;
            if !seen.insert(resource.resource_id.as_str()) {
                bail!("scheduler resource pool contains a duplicate resource id");
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulerResourcePoolCommitDisposition {
    Accepted,
    Replayed,
}

pub const FMS_PREPARATION_RESOURCE_POOL_SCHEMA: &str = "preparation_resource_pool.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsPreparationResourceOffer {
    pub resource_id: String,
    pub budget: FmsResourceBudget,
}

impl FmsPreparationResourceOffer {
    pub fn validate(&self) -> Result<()> {
        crate::repository_path::validate_store_id(&self.resource_id)?;
        self.budget.validate()?;
        if self.budget.cpu_millis == 0
            || self.budget.memory_bytes == 0
            || self.budget.storage_bytes == 0
            || self.budget.gpu_memory_bytes != 0
        {
            bail!(
                "preparation resource offer requires positive CPU, memory, and storage budgets and zero GPU memory"
            );
        }
        Ok(())
    }
}

/// Monotonic membership snapshot for resources allowed to execute accepted-run
/// preparation. This pool never admits solver workers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsPreparationResourcePool {
    pub schema_version: String,
    pub pool_id: String,
    pub generation: u64,
    pub resources: Vec<FmsPreparationResourceOffer>,
}

impl FmsPreparationResourcePool {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_PREPARATION_RESOURCE_POOL_SCHEMA {
            bail!(
                "unsupported preparation resource pool schema `{}`",
                self.schema_version
            );
        }
        crate::repository_path::validate_store_id(&self.pool_id)?;
        if self.generation == 0 {
            bail!("preparation resource pool generation must be positive");
        }
        let mut seen = BTreeSet::new();
        for resource in &self.resources {
            resource.validate()?;
            if !seen.insert(resource.resource_id.as_str()) {
                bail!("preparation resource pool contains a duplicate resource id");
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreparationResourcePoolCommitDisposition {
    Accepted,
    Replayed,
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

/// Immutable pointer proving that the live accepted projection selected one
/// study-stage preparation. The task receipt remains the authoritative
/// payload; this record stores the exact task/plan identity needed to recover
/// the selected stage after an API restart without replacing the run-level
/// live preparation anchor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsAcceptedStagePreparationReceipt {
    pub schema_version: String,
    pub run_id: String,
    pub step_id: String,
    pub task_id: String,
    pub input_fingerprint: String,
    pub preparation_id: String,
    pub plan_fingerprint: String,
    pub task_receipt_payload_sha256: String,
}

pub const FMS_ACCEPTED_STAGE_PREPARATION_RECEIPT_SCHEMA: &str =
    "accepted_stage_preparation_receipt.v1";

impl FmsAcceptedStagePreparationReceipt {
    pub fn from_task_receipt(receipt: &FmsTaskPreparationReceipt) -> Result<Self> {
        receipt.validate()?;
        let stage = Self {
            schema_version: FMS_ACCEPTED_STAGE_PREPARATION_RECEIPT_SCHEMA.into(),
            run_id: receipt.run_id.clone(),
            step_id: receipt.step_id.clone(),
            task_id: receipt.task_id.clone(),
            input_fingerprint: receipt.input_fingerprint.clone(),
            preparation_id: receipt.preparation_id.clone(),
            plan_fingerprint: receipt.plan_fingerprint.clone(),
            task_receipt_payload_sha256: receipt.payload_sha256.clone(),
        };
        stage.validate()?;
        Ok(stage)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_ACCEPTED_STAGE_PREPARATION_RECEIPT_SCHEMA {
            bail!(
                "unsupported accepted stage preparation receipt schema `{}`",
                self.schema_version
            );
        }
        crate::repository_path::validate_store_id(&self.run_id)
            .context("invalid accepted stage receipt run_id")?;
        validate_study_step_id(&self.step_id)?;
        crate::repository_path::validate_store_id(&self.task_id)
            .context("invalid accepted stage receipt task_id")?;
        validate_sha256(
            &self.input_fingerprint,
            "accepted stage receipt input_fingerprint",
        )?;
        crate::repository_path::validate_store_id(&self.preparation_id)
            .context("invalid accepted stage receipt preparation_id")?;
        validate_prefixed_sha256(
            &self.plan_fingerprint,
            "accepted stage receipt plan_fingerprint",
        )?;
        validate_sha256(
            &self.task_receipt_payload_sha256,
            "accepted stage receipt task_receipt_payload_sha256",
        )?;
        let expected_task_id = task_id_for_study_step(&self.run_id, &self.step_id)?;
        if self.task_id != expected_task_id {
            bail!("accepted stage receipt task_id does not match run_id and step_id");
        }
        if self.preparation_id != format!("prep-{}", self.task_id) {
            bail!("accepted stage receipt preparation_id is not deterministic for its task");
        }
        Ok(())
    }

    pub fn relative_path(&self) -> Result<String> {
        self.validate()?;
        Ok(format!(
            "runs/{}/accepted_stage_preparation_receipts/{}.json",
            self.run_id, self.task_id
        ))
    }

    pub fn matches_task_receipt(&self, receipt: &FmsTaskPreparationReceipt) -> bool {
        self.run_id == receipt.run_id
            && self.step_id == receipt.step_id
            && self.task_id == receipt.task_id
            && self.input_fingerprint == receipt.input_fingerprint
            && self.preparation_id == receipt.preparation_id
            && self.plan_fingerprint == receipt.plan_fingerprint
            && self.task_receipt_payload_sha256 == receipt.payload_sha256
    }

    pub fn same_immutable_payload(&self, other: &Self) -> bool {
        self.schema_version == other.schema_version
            && self.run_id == other.run_id
            && self.step_id == other.step_id
            && self.task_id == other.task_id
            && self.input_fingerprint == other.input_fingerprint
            && self.preparation_id == other.preparation_id
            && self.plan_fingerprint == other.plan_fingerprint
            && self.task_receipt_payload_sha256 == other.task_receipt_payload_sha256
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

pub const FMS_TASK_AWAITING_PREPARATION_REASON: &str = "accepted_task_awaiting_preparation";
pub const FMS_TASK_AWAITING_DEPENDENCY_RESOLUTION_REASON: &str =
    "awaiting dependency resolution and runtime admission";

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
#[serde(deny_unknown_fields)]
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
    pub(crate) fn validate(&self, run_id: &str) -> Result<()> {
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

/// Schema version for immutable proof that a supervised worker process exited.
pub const FMS_WORKER_PROCESS_EXIT_RECEIPT_SCHEMA: &str = "worker_process_exit_receipt.v1";

/// Durable proof captured only after the supervisor has reaped its child.
///
/// The receipt is fenced to the exact task claim and the last active lease
/// heartbeat observed by that supervisor.  It authorizes orphan
/// reconciliation after a supervisor crash, but never creates a new claim or
/// treats a missing process as evidence of termination.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsWorkerProcessExitReceipt {
    pub schema_version: String,
    pub receipt_id: String,
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub ownership_epoch: u64,
    pub resource_id: String,
    pub lease_token: String,
    pub lease_heartbeat_sequence: u64,
    pub process_id: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_start_token: Option<String>,
    pub status_success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub stop_requested: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
    pub observed_at: DateTime<Utc>,
}

impl FmsWorkerProcessExitReceipt {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_WORKER_PROCESS_EXIT_RECEIPT_SCHEMA {
            bail!(
                "unsupported worker process exit receipt schema `{}`",
                self.schema_version
            );
        }
        for (value, field) in [
            (self.receipt_id.as_str(), "receipt_id"),
            (self.run_id.as_str(), "run_id"),
            (self.task_id.as_str(), "task_id"),
            (self.attempt_id.as_str(), "attempt_id"),
            (self.resource_id.as_str(), "resource_id"),
            (self.lease_token.as_str(), "lease_token"),
        ] {
            crate::repository_path::validate_store_id(value)
                .with_context(|| format!("invalid worker process exit receipt {field}"))?;
        }
        if self.ownership_epoch == 0 {
            bail!("worker process exit receipt ownership_epoch must be greater than zero");
        }
        if self.process_id == 0 {
            bail!("worker process exit receipt process_id must be greater than zero");
        }
        if self
            .process_start_token
            .as_deref()
            .is_some_and(|value| value.trim().is_empty() || value.len() > 256)
        {
            bail!("worker process exit receipt process_start_token is invalid");
        }
        if self.timed_out && self.stop_requested {
            bail!("worker process exit receipt cannot be both timed out and operator-stopped");
        }
        if self.status_success && self.timed_out {
            bail!("a timed-out worker process exit cannot report success");
        }
        match self.failure_reason.as_deref() {
            Some(reason) if reason.trim().is_empty() || reason.len() > 4096 => {
                bail!("worker process exit receipt failure_reason is invalid")
            }
            Some(_) if self.status_success => {
                bail!("successful process exit must not carry a failure reason")
            }
            None if !self.status_success => {
                bail!("failed worker process exit requires a failure reason")
            }
            _ => {}
        }
        Ok(())
    }

    pub fn relative_path(&self) -> Result<String> {
        self.validate()?;
        Ok(format!(
            "runs/{}/worker_process_exit_receipts/{}.json",
            self.run_id, self.receipt_id
        ))
    }

    pub fn validate_for_task(&self, task: &FmsTaskCatalogEntry) -> Result<()> {
        self.validate()?;
        if task.task_id != self.task_id
            || task.attempt_id.as_deref() != Some(self.attempt_id.as_str())
            || task.ownership_epoch != Some(self.ownership_epoch)
            || task.resource_id.as_deref() != Some(self.resource_id.as_str())
            || !matches!(task.readiness, FmsTaskReadiness::Ready)
        {
            bail!("worker process exit receipt ownership fence does not match the run catalog");
        }
        Ok(())
    }

    pub fn validate_for_lease(&self, lease: &FmsResourceLease) -> Result<()> {
        self.validate()?;
        if lease.state != FmsResourceLeaseState::Active
            || lease.run_id != self.run_id
            || lease.task_id != self.task_id
            || lease.attempt_id != self.attempt_id
            || lease.ownership_epoch != self.ownership_epoch
            || lease.resource_id != self.resource_id
            || lease.lease_token != self.lease_token
            || lease.heartbeat_sequence != self.lease_heartbeat_sequence
        {
            bail!("worker process exit receipt ownership fence does not match the active lease");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerProcessExitReceiptCommitDisposition {
    Accepted,
    Replayed,
}

pub const FMS_PREPARATION_PROCESS_LAUNCH_SCHEMA: &str = "preparation_process_launch.v1";

/// Immutable authorization for exactly one accepted-run preparation process
/// spawn. Only the first accepted commit permits the supervisor to spawn; a
/// replay is deliberately ambiguous and must never authorize another child.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsPreparationProcessLaunch {
    pub schema_version: String,
    pub launch_id: String,
    pub run_id: String,
    pub task_id: String,
    pub preparation_attempt_id: String,
    pub resource_id: String,
    pub lease_token: String,
    pub lease_heartbeat_sequence: u64,
    pub supervisor_process_id: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supervisor_start_token: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl FmsPreparationProcessLaunch {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_PREPARATION_PROCESS_LAUNCH_SCHEMA {
            bail!(
                "unsupported preparation process launch schema `{}`",
                self.schema_version
            );
        }
        for (value, field) in [
            (self.launch_id.as_str(), "launch_id"),
            (self.run_id.as_str(), "run_id"),
            (self.task_id.as_str(), "task_id"),
            (
                self.preparation_attempt_id.as_str(),
                "preparation_attempt_id",
            ),
            (self.resource_id.as_str(), "resource_id"),
            (self.lease_token.as_str(), "lease_token"),
        ] {
            crate::repository_path::validate_store_id(value)
                .with_context(|| format!("invalid preparation process launch {field}"))?;
        }
        if self.supervisor_process_id == 0 {
            bail!("preparation process launch supervisor_process_id must be greater than zero");
        }
        if self
            .supervisor_start_token
            .as_deref()
            .is_some_and(|value| value.trim().is_empty() || value.len() > 256)
        {
            bail!("preparation process launch supervisor_start_token is invalid");
        }
        Ok(())
    }

    pub fn relative_path(&self) -> Result<String> {
        self.validate()?;
        Ok(format!(
            "runs/{}/preparation_process_launches/{}.json",
            self.run_id, self.launch_id
        ))
    }

    pub fn validate_for_lease(&self, lease: &FmsPreparationResourceLease) -> Result<()> {
        self.validate()?;
        if lease.state != FmsResourceLeaseState::Active
            || lease.run_id != self.run_id
            || lease.task_id != self.task_id
            || lease.preparation_attempt_id != self.preparation_attempt_id
            || lease.resource_id != self.resource_id
            || lease.lease_token != self.lease_token
            || lease.heartbeat_sequence != self.lease_heartbeat_sequence
        {
            bail!("preparation process launch ownership fence does not match the active lease");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreparationProcessLaunchCommitDisposition {
    Accepted,
    Replayed,
}

pub const FMS_PREPARATION_PROCESS_EXIT_RECEIPT_SCHEMA: &str = "preparation_process_exit_receipt.v1";

/// Immutable proof that the supervisor reaped one accepted-run preparation
/// process while it still owned the exact durable meshing lease.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsPreparationProcessExitReceipt {
    pub schema_version: String,
    pub receipt_id: String,
    pub run_id: String,
    pub task_id: String,
    pub preparation_attempt_id: String,
    pub resource_id: String,
    pub lease_token: String,
    pub lease_heartbeat_sequence: u64,
    pub process_id: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_start_token: Option<String>,
    pub status_success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
    pub observed_at: DateTime<Utc>,
}

impl FmsPreparationProcessExitReceipt {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_PREPARATION_PROCESS_EXIT_RECEIPT_SCHEMA {
            bail!(
                "unsupported preparation process exit receipt schema `{}`",
                self.schema_version
            );
        }
        for (value, field) in [
            (self.receipt_id.as_str(), "receipt_id"),
            (self.run_id.as_str(), "run_id"),
            (self.task_id.as_str(), "task_id"),
            (
                self.preparation_attempt_id.as_str(),
                "preparation_attempt_id",
            ),
            (self.resource_id.as_str(), "resource_id"),
            (self.lease_token.as_str(), "lease_token"),
        ] {
            crate::repository_path::validate_store_id(value)
                .with_context(|| format!("invalid preparation process exit receipt {field}"))?;
        }
        if self.process_id == 0 {
            bail!("preparation process exit receipt process_id must be greater than zero");
        }
        if self
            .process_start_token
            .as_deref()
            .is_some_and(|value| value.trim().is_empty() || value.len() > 256)
        {
            bail!("preparation process exit receipt process_start_token is invalid");
        }
        if self.status_success && (self.timed_out || self.exit_code != Some(0)) {
            bail!("successful preparation process exit requires exit code zero without timeout");
        }
        match self.failure_reason.as_deref() {
            Some(reason) if reason.trim().is_empty() || reason.len() > 4096 => {
                bail!("preparation process exit receipt failure_reason is invalid")
            }
            Some(_) if self.status_success => {
                bail!("successful preparation process exit must not carry a failure reason")
            }
            None if !self.status_success => {
                bail!("failed preparation process exit requires a failure reason")
            }
            _ => {}
        }
        Ok(())
    }

    pub fn relative_path(&self) -> Result<String> {
        self.validate()?;
        Ok(format!(
            "runs/{}/preparation_process_exit_receipts/{}.json",
            self.run_id, self.receipt_id
        ))
    }

    pub fn validate_for_lease(&self, lease: &FmsPreparationResourceLease) -> Result<()> {
        self.validate()?;
        if lease.state != FmsResourceLeaseState::Active
            || lease.run_id != self.run_id
            || lease.task_id != self.task_id
            || lease.preparation_attempt_id != self.preparation_attempt_id
            || lease.resource_id != self.resource_id
            || lease.lease_token != self.lease_token
            || lease.heartbeat_sequence != self.lease_heartbeat_sequence
        {
            bail!(
                "preparation process exit receipt ownership fence does not match the active lease"
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreparationProcessExitReceiptCommitDisposition {
    Accepted,
    Replayed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreparationProcessFinalizationDisposition {
    Succeeded,
    Failed,
    Replayed,
}

pub const FMS_PREPARATION_RETRY_DECISION_SCHEMA: &str = "preparation_retry_decision.v1";

/// Immutable operator authorization for one additional preparation attempt.
/// `retry_sequence` counts retries after the initial attempt, while
/// `max_attempts` includes the initial attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsPreparationRetryDecision {
    pub schema_version: String,
    pub decision_id: String,
    pub run_id: String,
    pub task_id: String,
    pub failed_preparation_attempt_id: String,
    pub retry_sequence: u32,
    pub max_attempts: u32,
    pub reason: String,
    pub created_at: DateTime<Utc>,
}

impl FmsPreparationRetryDecision {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_PREPARATION_RETRY_DECISION_SCHEMA {
            bail!(
                "unsupported preparation retry decision schema `{}`",
                self.schema_version
            );
        }
        for (value, field) in [
            (self.decision_id.as_str(), "decision_id"),
            (self.run_id.as_str(), "run_id"),
            (self.task_id.as_str(), "task_id"),
            (
                self.failed_preparation_attempt_id.as_str(),
                "failed_preparation_attempt_id",
            ),
        ] {
            crate::repository_path::validate_store_id(value)
                .with_context(|| format!("invalid preparation retry decision {field}"))?;
        }
        if self.retry_sequence == 0 {
            bail!("preparation retry decision retry_sequence must be positive");
        }
        if self.max_attempts < 2 || self.retry_sequence >= self.max_attempts {
            bail!("preparation retry decision must authorize an attempt within max_attempts");
        }
        if self.reason.trim().is_empty() || self.reason.len() > 4096 {
            bail!("preparation retry decision reason is invalid");
        }
        Ok(())
    }

    pub fn relative_path(&self) -> Result<String> {
        self.validate()?;
        Ok(format!(
            "runs/{}/preparation_retry_decisions/{}.json",
            self.run_id, self.decision_id
        ))
    }

    pub fn same_immutable_payload(&self, other: &Self) -> bool {
        self.schema_version == other.schema_version
            && self.decision_id == other.decision_id
            && self.run_id == other.run_id
            && self.task_id == other.task_id
            && self.failed_preparation_attempt_id == other.failed_preparation_attempt_id
            && self.retry_sequence == other.retry_sequence
            && self.max_attempts == other.max_attempts
            && self.reason == other.reason
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreparationRetryDecisionCommitDisposition {
    Accepted,
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

    pub fn checkpoint_watermarks(&self) -> Result<(u64, u64)> {
        let checkpoint = self
            .payload
            .get("checkpoint")
            .and_then(Value::as_object)
            .context("coordinator journal payload has no checkpoint object")?;
        let command_sequence = checkpoint
            .get("command_sequence")
            .and_then(Value::as_u64)
            .context("coordinator journal checkpoint has no command_sequence")?;
        let event_sequence = checkpoint
            .get("event_sequence")
            .and_then(Value::as_u64)
            .context("coordinator journal checkpoint has no event_sequence")?;
        Ok((command_sequence, event_sequence))
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

pub const FMS_STUDY_OUTPUT_MANIFEST_SCHEMA_V1: &str = "study_output_manifest.v1";
pub const FMS_STUDY_OUTPUT_MANIFEST_SCHEMA_V2: &str = "study_output_manifest.v2";
pub const FMS_STUDY_OUTPUT_MANIFEST_SCHEMA: &str = "study_output_manifest.v3";
pub const FMS_OBSERVATION_SOURCE_SCHEMA: &str = "observation_source.v1";
pub const FMS_FDM_CPU_OBSERVATION_ADAPTER_ID: &str = "fdm_cpu_observation.v1";
pub const FMS_FDM_CPU_ACCEPTED_STATE_SNAPSHOT_SCHEMA: &str =
    "fullmag.fdm.cpu.accepted-state-snapshot.v1";
pub const FMS_OBSERVATION_STATE_CODEC_ID: &str = "fullmag.runner.field_json";
pub const FMS_OBSERVATION_STATE_CODEC_VERSION: &str = "v1";
pub const FMS_OBSERVATION_SNAPSHOT_ARTIFACT_TYPE: &str = "observation_state_snapshot";
pub const FMS_OBSERVATION_STATE_ARTIFACT_TYPE: &str = "observation_terminal_state";

/// Immutable CAS-backed carriers required to reconstruct one historical
/// observation runtime. These are system artifacts, not declared study ports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsObservationSourceDescriptor {
    pub schema_version: String,
    pub adapter_id: String,
    pub accepted_state_ref: fullmag_quantities::AcceptedStateRef,
    pub snapshot_schema_version: String,
    pub snapshot_artifact_id: String,
    pub snapshot_object_ref: String,
    pub state_codec_id: String,
    pub state_codec_version: String,
    pub state_artifact_id: String,
    pub state_object_ref: String,
    pub grid_cells: [u32; 3],
    pub quantity_ids: Vec<String>,
}

impl FmsObservationSourceDescriptor {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_OBSERVATION_SOURCE_SCHEMA {
            bail!(
                "unsupported observation source schema `{}`",
                self.schema_version
            );
        }
        if self.adapter_id != FMS_FDM_CPU_OBSERVATION_ADAPTER_ID
            || self.snapshot_schema_version != FMS_FDM_CPU_ACCEPTED_STATE_SNAPSHOT_SCHEMA
            || self.state_codec_id != FMS_OBSERVATION_STATE_CODEC_ID
            || self.state_codec_version != FMS_OBSERVATION_STATE_CODEC_VERSION
            || self.quantity_ids != ["m"]
        {
            bail!("observation source v1 has an unsupported adapter or carrier contract");
        }
        for (value, label) in [
            (&self.adapter_id, "observation adapter_id"),
            (
                &self.snapshot_schema_version,
                "observation snapshot_schema_version",
            ),
            (
                &self.snapshot_artifact_id,
                "observation snapshot_artifact_id",
            ),
            (&self.state_codec_id, "observation state_codec_id"),
            (&self.state_codec_version, "observation state_codec_version"),
            (&self.state_artifact_id, "observation state_artifact_id"),
        ] {
            crate::repository_path::validate_store_id(value)
                .with_context(|| format!("invalid {label}"))?;
        }
        validate_sha256(&self.snapshot_object_ref, "observation snapshot_object_ref")?;
        validate_sha256(&self.state_object_ref, "observation state_object_ref")?;
        if self.snapshot_artifact_id == self.state_artifact_id {
            bail!("observation source artifact identities must be distinct");
        }
        let cell_count = self
            .grid_cells
            .into_iter()
            .try_fold(1_u64, |count, extent| {
                (extent > 0)
                    .then_some(extent as u64)
                    .and_then(|extent| count.checked_mul(extent))
            });
        if cell_count.is_none() {
            bail!("observation source grid must contain a positive finite cell count");
        }
        if self.quantity_ids.is_empty() {
            bail!("observation source must expose at least one quantity");
        }
        let mut quantity_ids = std::collections::BTreeSet::new();
        for quantity_id in &self.quantity_ids {
            crate::repository_path::validate_store_id(quantity_id)
                .context("invalid observation quantity id")?;
            if !quantity_ids.insert(quantity_id.as_str()) {
                bail!("observation source contains a duplicate quantity id");
            }
        }
        self.accepted_state_ref
            .validate()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        Ok(())
    }
}

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_state_ref: Option<fullmag_quantities::AcceptedStateRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation_source: Option<FmsObservationSourceDescriptor>,
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
        if !matches!(
            self.schema_version.as_str(),
            FMS_STUDY_OUTPUT_MANIFEST_SCHEMA_V1
                | FMS_STUDY_OUTPUT_MANIFEST_SCHEMA_V2
                | FMS_STUDY_OUTPUT_MANIFEST_SCHEMA
        ) {
            bail!(
                "unsupported study output manifest schema `{}`",
                self.schema_version
            );
        }
        if self.schema_version == FMS_STUDY_OUTPUT_MANIFEST_SCHEMA_V1
            && self.accepted_state_ref.is_some()
        {
            bail!("study output manifest v1 cannot contain accepted_state_ref");
        }
        if self.schema_version != FMS_STUDY_OUTPUT_MANIFEST_SCHEMA
            && self.observation_source.is_some()
        {
            bail!("study output manifest before v3 cannot contain observation_source");
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
        if let Some(accepted_state_ref) = &self.accepted_state_ref {
            accepted_state_ref
                .validate()
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            if accepted_state_ref.id.run_id != self.run_id
                || accepted_state_ref.id.stage_id.as_deref() != Some(self.step_id.as_str())
                || accepted_state_ref.generation.runtime_epoch != self.ownership_epoch
            {
                bail!("study output manifest accepted state identity differs from its attempt");
            }
        }
        if let Some(observation_source) = &self.observation_source {
            observation_source.validate()?;
            if self.accepted_state_ref.as_ref() != Some(&observation_source.accepted_state_ref) {
                bail!("observation source differs from manifest accepted_state_ref");
            }
            if observation_source.accepted_state_ref.id.run_id != self.run_id
                || observation_source.accepted_state_ref.id.stage_id.as_deref()
                    != Some(self.step_id.as_str())
                || observation_source
                    .accepted_state_ref
                    .generation
                    .runtime_epoch
                    != self.ownership_epoch
            {
                bail!("observation source identity differs from its manifest attempt");
            }
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
        if let Some(observation_source) = &self.observation_source {
            if artifact_ids.contains(observation_source.snapshot_artifact_id.as_str())
                || artifact_ids.contains(observation_source.state_artifact_id.as_str())
            {
                bail!("observation source artifact identity collides with a study output");
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
pub const FMS_HOST_LAUNCH_BINDING_SCHEMA: &str = "host_launch_binding.v1";

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

/// Immutable host configuration captured when a physical resource lease is admitted.
///
/// Workers can use this durable binding to find the host launch fence without
/// trusting process arguments or performing host discovery themselves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsHostLaunchBinding {
    pub schema_version: String,
    pub ledger_root: PathBuf,
    pub policy: crate::host_resource_ledger::HostResourceLedgerPolicy,
    /// Canonical digest of the immutable host-readiness blob for the strict
    /// runtime generation that admitted this lease. Legacy bindings may omit
    /// it and remain readable, but new v2 launch paths require it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_generation_sha256: Option<String>,
}

impl FmsHostLaunchBinding {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_HOST_LAUNCH_BINDING_SCHEMA {
            bail!(
                "unsupported host launch binding schema `{}`",
                self.schema_version
            );
        }
        if !self.ledger_root.is_absolute() {
            bail!("host launch binding ledger_root must be an explicit absolute path");
        }
        if self
            .ledger_root
            .components()
            .any(|component| component == Component::ParentDir)
        {
            bail!("host launch binding ledger_root must not contain parent-directory components");
        }
        if self.ledger_root.file_name().is_none() {
            bail!("host launch binding ledger_root must name a dedicated directory");
        }
        self.policy.validate()?;
        if let Some(digest) = self.runtime_generation_sha256.as_deref() {
            validate_runtime_generation_sha256(digest)?;
        }
        Ok(())
    }

    /// Return the generation carried by a strict host binding. This separate
    /// accessor preserves readability of legacy bindings while preventing a
    /// v2 worker from treating a missing generation as an admission proof.
    pub fn require_runtime_generation_sha256(&self) -> Result<&str> {
        self.validate()?;
        self.runtime_generation_sha256
            .as_deref()
            .context("host launch binding is missing runtime_generation_sha256")
    }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_launch_binding: Option<FmsHostLaunchBinding>,
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
        if let Some(binding) = &self.host_launch_binding {
            binding
                .validate()
                .context("invalid resource lease host launch binding")?;
        }
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
            && self.host_launch_binding == other.host_launch_binding
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceLeaseCommitDisposition {
    Acquired,
    Replayed,
}

pub const FMS_PREPARATION_RESOURCE_LEASE_SCHEMA: &str = "preparation_resource_lease.v1";

/// Durable ownership of one meshing resource while an accepted task remains
/// blocked before solver admission. This is deliberately separate from
/// `FmsResourceLease`, whose owner is a claimed solver attempt and epoch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsPreparationResourceLease {
    pub schema_version: String,
    pub resource_id: String,
    pub budget: FmsResourceBudget,
    pub run_id: String,
    pub task_id: String,
    pub preparation_attempt_id: String,
    pub lease_token: String,
    pub state: FmsResourceLeaseState,
    pub acquired_at: DateTime<Utc>,
    pub heartbeat_at: DateTime<Utc>,
    pub heartbeat_sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_launch_binding: Option<FmsHostLaunchBinding>,
}

impl FmsPreparationResourceLease {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_PREPARATION_RESOURCE_LEASE_SCHEMA {
            bail!(
                "unsupported preparation resource lease schema `{}`",
                self.schema_version
            );
        }
        for (value, field) in [
            (self.resource_id.as_str(), "resource_id"),
            (self.run_id.as_str(), "run_id"),
            (self.task_id.as_str(), "task_id"),
            (
                self.preparation_attempt_id.as_str(),
                "preparation_attempt_id",
            ),
            (self.lease_token.as_str(), "lease_token"),
        ] {
            crate::repository_path::validate_store_id(value)
                .with_context(|| format!("invalid preparation resource lease {field}"))?;
        }
        self.budget.validate()?;
        if let Some(binding) = &self.host_launch_binding {
            binding
                .validate()
                .context("invalid preparation host launch binding")?;
        }
        if self.budget.cpu_millis == 0
            || self.budget.memory_bytes == 0
            || self.budget.storage_bytes == 0
            || self.budget.gpu_memory_bytes != 0
        {
            bail!(
                "preparation meshing resource requires positive CPU, memory, and storage budgets and zero GPU memory"
            );
        }
        match (self.state, self.released_at.is_some()) {
            (FmsResourceLeaseState::Active, true) => {
                bail!("active preparation resource lease must not have released_at")
            }
            (FmsResourceLeaseState::Released, false) => {
                bail!("released preparation resource lease requires released_at")
            }
            _ => {}
        }
        Ok(())
    }

    pub fn validate_for_catalog(&self, catalog: &FmsRunCatalog) -> Result<()> {
        if catalog.run_id != self.run_id {
            bail!("preparation resource lease belongs to another run catalog");
        }
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == self.task_id)
            .context("preparation resource lease task is missing from the run catalog")?;
        if task.lifecycle != FmsTaskLifecycle::Accepted
            || !matches!(
                &task.readiness,
                FmsTaskReadiness::Blocked { reason }
                    if reason == FMS_TASK_AWAITING_PREPARATION_REASON
            )
            || task.attempt_id.is_some()
            || task.ownership_epoch.is_some()
            || task.resource_id.is_some()
        {
            bail!(
                "preparation resource lease requires an unclaimed accepted task awaiting preparation"
            );
        }
        Ok(())
    }

    pub fn identity_matches(&self, other: &Self) -> bool {
        self.resource_id == other.resource_id
            && self.run_id == other.run_id
            && self.task_id == other.task_id
            && self.preparation_attempt_id == other.preparation_attempt_id
            && self.lease_token == other.lease_token
            && self.host_launch_binding == other.host_launch_binding
    }

    pub fn relative_path(&self) -> Result<String> {
        self.validate()?;
        Ok(format!(
            "runs/{}/preparation_resource_leases/{}/{}.json",
            self.run_id, self.resource_id, self.lease_token
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreparationResourceLeaseCommitDisposition {
    Acquired,
    Replayed,
}

/// Durable intent for admitting one queued task to a resource lease.
///
/// The record is published before the run-catalog and lease projections. If
/// the process stops between those writes, recovery can finish this exact
/// admission without inventing a new attempt or lease token.
pub const FMS_TASK_ADMISSION_SCHEMA: &str = "task_admission.v1";

pub const FMS_RESOLVED_INPUTS_SNAPSHOT_SCHEMA: &str = "resolved_inputs_snapshot.v1";
const MAX_RESOLVED_INPUT_SNAPSHOT_ENTRIES: usize = 256;
const MAX_RESOLVED_INPUT_SNAPSHOT_BYTES: usize = 128 * 1024;

/// Bounded, hashed copy of the resolved-input map captured with an admission.
///
/// This persistence layer checks the envelope and hash only. The application
/// layer owns validation of each serialized `ResolvedInput` domain value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsResolvedInputsSnapshot {
    pub schema_version: String,
    pub inputs: Value,
    pub content_sha256: String,
}

impl FmsResolvedInputsSnapshot {
    pub fn new(inputs: Value) -> Result<Self> {
        let snapshot = Self {
            schema_version: FMS_RESOLVED_INPUTS_SNAPSHOT_SCHEMA.into(),
            content_sha256: canonical_json_sha256(&inputs),
            inputs,
        };
        snapshot.validate()?;
        Ok(snapshot)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_RESOLVED_INPUTS_SNAPSHOT_SCHEMA {
            bail!(
                "unsupported resolved-input snapshot schema `{}`",
                self.schema_version
            );
        }
        let inputs = self
            .inputs
            .as_object()
            .context("resolved-input snapshot inputs must be a JSON object")?;
        if inputs.len() > MAX_RESOLVED_INPUT_SNAPSHOT_ENTRIES {
            bail!(
                "resolved-input snapshot has {} entries, exceeding the limit of {}",
                inputs.len(),
                MAX_RESOLVED_INPUT_SNAPSHOT_ENTRIES
            );
        }
        let canonical_inputs = canonical_json_bytes(&self.inputs);
        if canonical_inputs.len() > MAX_RESOLVED_INPUT_SNAPSHOT_BYTES {
            bail!(
                "resolved-input snapshot metadata exceeds the {}-byte limit",
                MAX_RESOLVED_INPUT_SNAPSHOT_BYTES
            );
        }
        validate_sha256(
            &self.content_sha256,
            "resolved-input snapshot content_sha256",
        )?;
        let actual = format!("{:x}", Sha256::digest(&canonical_inputs));
        if self.content_sha256 != actual {
            bail!("resolved-input snapshot content_sha256 does not match its inputs");
        }
        self.collect_object_refs()?;
        Ok(())
    }

    /// Return only CAS references declared under `study_artifact.object_ref`.
    /// `content_sha256` values identify resolved metadata and are not object roots.
    pub fn object_refs(&self) -> Result<BTreeSet<String>> {
        self.validate()?;
        self.collect_object_refs()
    }

    fn collect_object_refs(&self) -> Result<BTreeSet<String>> {
        let inputs = self
            .inputs
            .as_object()
            .context("resolved-input snapshot inputs must be a JSON object")?;
        let mut object_refs = BTreeSet::new();
        for (port_id, descriptor) in inputs {
            let descriptor = descriptor.as_object().with_context(|| {
                format!("resolved-input snapshot entry `{port_id}` must be an object")
            })?;
            let Some(study_artifact) = descriptor.get("study_artifact") else {
                continue;
            };
            if study_artifact.is_null() {
                continue;
            }
            let study_artifact = study_artifact.as_object().with_context(|| {
                format!(
                    "resolved-input snapshot entry `{port_id}` study_artifact must be an object"
                )
            })?;
            let object_ref = study_artifact
                .get("object_ref")
                .and_then(Value::as_str)
                .with_context(|| {
                    format!(
                        "resolved-input snapshot entry `{port_id}` study_artifact.object_ref must be a SHA-256 string"
                    )
                })?;
            validate_sha256(object_ref, "resolved-input study_artifact.object_ref")?;
            object_refs.insert(object_ref.to_owned());
        }
        Ok(object_refs)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsTaskAdmissionRecord {
    pub schema_version: String,
    pub expected_catalog_revision: u64,
    pub queued_task: FmsTaskCatalogEntry,
    pub task: FmsTaskCatalogEntry,
    pub lease: FmsResourceLease,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_inputs_snapshot: Option<FmsResolvedInputsSnapshot>,
}

impl FmsTaskAdmissionRecord {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != FMS_TASK_ADMISSION_SCHEMA {
            bail!(
                "unsupported task admission schema `{}`",
                self.schema_version
            );
        }
        if self.expected_catalog_revision == 0 {
            bail!("task admission expected catalog revision must be positive");
        }
        self.lease.validate()?;
        if let Some(snapshot) = &self.resolved_inputs_snapshot {
            snapshot
                .validate()
                .context("invalid task admission resolved-input snapshot")?;
        }
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
        if self.lease.state != FmsResourceLeaseState::Active || self.lease.heartbeat_sequence != 0 {
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

pub(crate) fn validate_runtime_generation_sha256(value: &str) -> Result<()> {
    validate_sha256(value, "runtime_generation_sha256")
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
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
pub struct TensorDescriptor {
    pub format: String,
    pub name: String,
    pub dtype: TensorDtype,
    pub shape: Vec<usize>,
    pub logical_axes: Vec<String>,
    pub endian: String,
    /// CAS object refs for each chunk.
    pub chunks: Vec<TensorChunk>,
    /// Optional producer metadata, immutable under the tensor root CAS identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_binding: Option<crate::solution_tensor_field::TensorFieldBinding>,
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
            field_binding: None,
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
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
pub struct ArtifactIndex {
    pub entries: Vec<ArtifactIndexEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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

#[cfg(test)]
mod graph_schema_tests {
    use super::*;

    #[test]
    fn graph_control_records_reject_untracked_reference_fields() {
        let mut task = serde_json::json!({"task_id": "task", "input_fingerprint": "a".repeat(64),
            "lifecycle": "queued"});
        assert!(serde_json::from_value::<FmsTaskCatalogEntry>(task.clone()).is_ok());
        task["hidden_object_ref"] = serde_json::json!("a".repeat(64));
        assert!(serde_json::from_value::<FmsTaskCatalogEntry>(task).is_err());
        let mut artifact = serde_json::json!({"artifact_id": "artifact", "task_id": "task",
            "attempt_id": "attempt", "ownership_epoch": 1, "logical_path": "state",
            "artifact_type": "state", "content_sha256": "a".repeat(64),
            "status": "published", "required": false});
        assert!(serde_json::from_value::<FmsArtifactCatalogEntry>(artifact.clone()).is_ok());
        artifact["hidden_object_ref"] = serde_json::json!("b".repeat(64));
        assert!(serde_json::from_value::<FmsArtifactCatalogEntry>(artifact).is_err());
        let state = serde_json::json!({"step": 0, "time_s": 0.0, "dt": 1.0,
            "energies": {}, "hidden_object_ref": "a".repeat(64)});
        assert!(serde_json::from_value::<CommonSolverState>(state).is_err());
        let index = serde_json::json!({"entries": [], "hidden_object_ref": "a".repeat(64)});
        assert!(serde_json::from_value::<ArtifactIndex>(index).is_err());
        let entry = serde_json::json!({"logical_path": "field", "artifact_type": "state",
            "size_bytes": 0, "required": false, "hidden_object_ref": "a".repeat(64)});
        assert!(serde_json::from_value::<ArtifactIndexEntry>(entry).is_err());
        let state = serde_json::json!({"step": 0, "time_s": 0.0, "dt": 1.0,
            "energies": {"hidden_object_ref": "a".repeat(64)}});
        assert!(serde_json::from_value::<CommonSolverState>(state).is_err());
        let backend = serde_json::json!({"format": "fullmag.backend_state.v1",
            "backend_family": "fdm", "extra": {"step": 0},
            "hidden_object_ref": "a".repeat(64)});
        assert!(serde_json::from_value::<BackendStatePayload>(backend).is_err());
    }
}

#[cfg(test)]
mod host_launch_binding_tests {
    use super::{
        FMS_HOST_LAUNCH_BINDING_SCHEMA, FMS_RESOURCE_LEASE_SCHEMA, FmsHostLaunchBinding,
        FmsResourceBudget, FmsResourceKind, FmsResourceLease, FmsResourceLeaseState,
    };
    use crate::host_resource_ledger::{
        HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V1, HostResourceLedgerPolicy,
    };
    use chrono::Utc;
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::PathBuf;

    fn absolute_test_root() -> PathBuf {
        #[cfg(windows)]
        {
            PathBuf::from(r"C:\fullmag\host-ledger")
        }
        #[cfg(not(windows))]
        {
            PathBuf::from("/tmp/fullmag-host-ledger")
        }
    }

    fn binding(ledger_root: PathBuf) -> FmsHostLaunchBinding {
        FmsHostLaunchBinding {
            schema_version: FMS_HOST_LAUNCH_BINDING_SCHEMA.into(),
            ledger_root,
            policy: HostResourceLedgerPolicy {
                schema_version: HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V1.into(),
                host_id: "test-host".into(),
                topology_sha256: "a".repeat(64),
                revision: 1,
                owner_epoch: 1,
                total_budget: FmsResourceBudget {
                    cpu_millis: 1_000,
                    memory_bytes: 1_024,
                    gpu_memory_bytes: 0,
                    storage_bytes: 0,
                },
                gpu_vram_bytes_by_uuid: BTreeMap::new(),
                allowed_cpu_ids: BTreeSet::new(),
            },
            runtime_generation_sha256: None,
        }
    }

    fn lease(host_launch_binding: Option<FmsHostLaunchBinding>) -> FmsResourceLease {
        let now = Utc::now();
        FmsResourceLease {
            schema_version: FMS_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: "cpu-0".into(),
            kind: FmsResourceKind::Cpu,
            budget: FmsResourceBudget {
                cpu_millis: 1_000,
                memory_bytes: 1_024,
                gpu_memory_bytes: 0,
                storage_bytes: 0,
            },
            run_id: "run".into(),
            task_id: "task".into(),
            attempt_id: "attempt".into(),
            ownership_epoch: 1,
            lease_token: "lease-token".into(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
            host_launch_binding,
        }
    }

    #[test]
    fn binding_validates_absolute_non_traversing_root_and_policy() {
        assert!(binding(absolute_test_root()).validate().is_ok());
        assert!(
            binding(PathBuf::from("relative/ledger"))
                .validate()
                .is_err()
        );
        assert!(
            binding(absolute_test_root().join("..").join("ledger"))
                .validate()
                .is_err()
        );

        let mut invalid_policy = binding(absolute_test_root());
        invalid_policy.policy.revision = 0;
        assert!(invalid_policy.validate().is_err());
    }

    #[test]
    fn absent_binding_stays_absent_and_binding_is_part_of_lease_identity() {
        let legacy = lease(None);
        let legacy_json = serde_json::to_value(&legacy).unwrap();
        assert!(legacy_json.get("host_launch_binding").is_none());
        let decoded: FmsResourceLease = serde_json::from_value(legacy_json).unwrap();
        assert!(decoded.host_launch_binding.is_none());

        let bound = lease(Some(binding(absolute_test_root())));
        assert!(bound.validate().is_ok());
        let bound_json = serde_json::to_value(&bound).unwrap();
        assert!(bound_json.get("host_launch_binding").is_some());
        let decoded_bound: FmsResourceLease = serde_json::from_value(bound_json).unwrap();
        assert_eq!(decoded_bound.host_launch_binding, bound.host_launch_binding);
        assert!(!legacy.identity_matches(&bound));
        assert!(bound.identity_matches(&bound.clone()));
    }
}

#[cfg(test)]
mod resolved_inputs_snapshot_tests {
    use super::{
        FMS_RESOLVED_INPUTS_SNAPSHOT_SCHEMA, FmsResolvedInputsSnapshot, canonical_json_sha256,
    };
    use serde_json::{Map, Value, json};
    use std::collections::BTreeSet;

    #[test]
    fn snapshot_round_trips_canonical_hash_and_rejects_tampering() {
        let inputs = json!({
            "step_output": {"source": "artifact-a", "content_sha256": "a".repeat(64)},
            "pinned": {"source": "artifact-b", "content_sha256": "b".repeat(64)}
        });
        let snapshot = FmsResolvedInputsSnapshot::new(inputs).unwrap();
        assert_eq!(snapshot.schema_version, FMS_RESOLVED_INPUTS_SNAPSHOT_SCHEMA);
        assert_eq!(
            snapshot.content_sha256,
            canonical_json_sha256(&snapshot.inputs)
        );

        let bytes = serde_json::to_vec(&snapshot).unwrap();
        let decoded: FmsResolvedInputsSnapshot = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded, snapshot);
        decoded.validate().unwrap();

        let mut tampered = decoded;
        tampered.inputs["pinned"]["source"] = json!("different-artifact");
        assert!(tampered.validate().is_err());
    }

    #[test]
    fn snapshot_bounds_entry_count_and_metadata_size() {
        let mut too_many = Map::new();
        for index in 0..=256 {
            too_many.insert(format!("port-{index}"), json!({}));
        }
        assert!(FmsResolvedInputsSnapshot::new(Value::Object(too_many)).is_err());

        let too_large = json!({"port": {"value": "x".repeat(128 * 1024)}});
        assert!(FmsResolvedInputsSnapshot::new(too_large).is_err());
    }

    #[test]
    fn snapshot_object_refs_follow_study_artifacts_not_content_hashes() {
        let inline_hash = "a".repeat(64);
        let artifact_hash = "b".repeat(64);
        let snapshot = FmsResolvedInputsSnapshot::new(json!({
            "inline": {
                "source": "input-data",
                "content_sha256": inline_hash,
                "study_artifact": null
            },
            "artifact": {
                "source": "artifact-id",
                "content_sha256": "c".repeat(64),
                "study_artifact": {"object_ref": artifact_hash}
            }
        }))
        .unwrap();

        assert_eq!(
            snapshot.object_refs().unwrap(),
            BTreeSet::from(["b".repeat(64)])
        );
        assert!(
            FmsResolvedInputsSnapshot::new(json!({
                "artifact": {"study_artifact": {"object_ref": "not-a-sha256"}}
            }))
            .is_err()
        );
    }
}

#[cfg(test)]
mod batch_output_storage_snapshot_tests {
    use super::{
        FMS_BATCH_OUTPUT_STORAGE_SNAPSHOT_LEGACY_SCHEMA, FMS_BATCH_OUTPUT_STORAGE_SNAPSHOT_SCHEMA,
        canonical_json_sha256, validate_batch_output_storage_snapshot,
    };
    use serde_json::{Value, json};

    fn legacy_snapshot(settings: Value) -> Value {
        json!({
            "schema_version": FMS_BATCH_OUTPUT_STORAGE_SNAPSHOT_LEGACY_SCHEMA,
            "source": "workspace_defaults",
            "settings_sha256": canonical_json_sha256(&settings),
            "settings": settings
        })
    }

    fn resolved_snapshot(settings: Value, source: &str) -> Value {
        let mut snapshot = json!({
            "schema_version": FMS_BATCH_OUTPUT_STORAGE_SNAPSHOT_SCHEMA,
            "source": source,
            "settings_sha256": canonical_json_sha256(&settings),
            "workspace_defaults_sha256": canonical_json_sha256(&json!({"defaults": true})),
            "settings": settings
        });
        if source == "project_authoring" {
            snapshot["authoring_policy_sha256"] =
                json!(canonical_json_sha256(&json!({"authoring": true})));
        }
        snapshot
    }

    #[test]
    fn validates_settings_shape_paths_and_enum_values() {
        #[cfg(windows)]
        let output_parent = r"C:\fullmag\outputs";
        #[cfg(not(windows))]
        let output_parent = "/tmp/fullmag/outputs";

        let valid = json!({
            "output_parent": output_parent,
            "temp_parent": null,
            "data_format": "zarr",
            "cleanup": "on_success",
            "existing_output": "timestamp"
        });
        assert!(validate_batch_output_storage_snapshot(&legacy_snapshot(valid.clone())).is_ok());

        assert!(validate_batch_output_storage_snapshot(&legacy_snapshot(json!({}))).is_err());

        let mut relative = valid.clone();
        relative["output_parent"] = json!("outputs");
        assert!(validate_batch_output_storage_snapshot(&legacy_snapshot(relative)).is_err());

        let mut traversal = valid.clone();
        traversal["output_parent"] = json!(format!("{output_parent}/../escape"));
        assert!(validate_batch_output_storage_snapshot(&legacy_snapshot(traversal)).is_err());

        let mut unsupported_format = valid;
        unsupported_format["data_format"] = json!("csv");
        assert!(
            validate_batch_output_storage_snapshot(&legacy_snapshot(unsupported_format)).is_err()
        );
    }

    #[test]
    fn validates_resolved_settings_and_provenance_digests() {
        #[cfg(windows)]
        let output_dir = r"C:\fullmag\outputs";
        #[cfg(not(windows))]
        let output_dir = "/tmp/fullmag/outputs";

        let settings = json!({
            "output_dir": output_dir,
            "temp_dir": null,
            "data_format": "zarr",
            "cleanup": "on_success",
            "existing_output": "timestamp"
        });
        assert!(
            validate_batch_output_storage_snapshot(&resolved_snapshot(
                settings.clone(),
                "workspace_defaults"
            ))
            .is_ok()
        );
        assert!(
            validate_batch_output_storage_snapshot(&resolved_snapshot(
                settings.clone(),
                "project_authoring"
            ))
            .is_ok()
        );

        let mut relative = settings.clone();
        relative["output_dir"] = json!("results");
        assert!(
            validate_batch_output_storage_snapshot(&resolved_snapshot(
                relative,
                "workspace_defaults"
            ))
            .is_err()
        );

        let mut traversal = settings.clone();
        traversal["output_dir"] = json!(format!("{output_dir}/../escape"));
        assert!(
            validate_batch_output_storage_snapshot(&resolved_snapshot(
                traversal,
                "workspace_defaults"
            ))
            .is_err()
        );

        let mut missing_policy_digest = resolved_snapshot(settings.clone(), "project_authoring");
        missing_policy_digest
            .as_object_mut()
            .unwrap()
            .remove("authoring_policy_sha256");
        assert!(validate_batch_output_storage_snapshot(&missing_policy_digest).is_err());

        let mut tampered = resolved_snapshot(settings, "workspace_defaults");
        tampered["settings"]["cleanup"] = json!("always");
        assert!(validate_batch_output_storage_snapshot(&tampered).is_err());
    }
}
