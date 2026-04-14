//! Core types for the Fullmag session persistence system.
//!
//! These types define the logical snapshot of a simulation session,
//! used for both the internal `SessionStore` and the portable `.fms` file format.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// ── Save profiles ──────────────────────────────────────────────────────

/// Which elements to include when saving a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompressionProfile {
    Speed,
    Balanced,
    Smallest,
}

// ── Run manifest ───────────────────────────────────────────────────────

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
        let cp_id = format!("cp-{:06}", step);
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
    pub offset: usize,
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
#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
