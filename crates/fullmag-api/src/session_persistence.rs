//! Session persistence API handlers — save, load, inspect, checkpoints, recovery.

#[path = "session_persistence_antenna_import.rs"]
mod antenna_import;
#[path = "session_persistence_antenna_mesh_import.rs"]
pub(crate) mod antenna_mesh_import;

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

use crate::error::ApiError;
use crate::router_v2::handlers::sessions::status::field_revision;
use crate::router_v2::handlers::visualization::display::{
    append_visualization_restore_warnings, bound_visualization_restore_warnings,
    canonicalize_visualization_overrides_with_diagnostics,
};
use crate::schemas::visualization_state::{
    default_planar_color_range_state, default_planar_visualization_state, PlanarColorRangeMode,
    PlanarColorRangeState, PlanarSourceSelectionState,
};
use crate::types::{
    AppState, CurrentWorkspaceLayout, CurrentWorkspaceRibbon, CurrentWorkspaceSelection,
    DisplayPresentationState, RuntimeStatusView, SessionStateResponse,
};
use crate::{
    current_live_realtime_state_from_snapshot, publish_current_live_realtime_batch_changed,
};

use fullmag_session::{
    capture_checkpoint, determine_restore_class, pack_fms, pack_fms_with_accepted_provenance,
    preflight_fms_staged, unpack_fms_staged, unpack_fms_staged_readonly, CaptureRequest,
    CheckpointCompatibility,
    CheckpointSnapshotProvider, FieldCapturePolicy, FmsAcceptedProvenanceReference,
    FmsExportProfile, FmsRunManifest, FmsSessionManifest, FmsStagedPreflight,
    FmsWorkspaceManifest, PackOptions, SaveProfile, SessionInspection, SessionStore,
    SolverEnergies,
};
use fullmag_session::accepted_provenance::{
    plan_accepted_provenance, AcceptedProvenanceContext, AcceptedProvenanceManifest,
    AcceptedProvenancePlan, AcceptedProvenanceRecordKind,
};

#[derive(Debug, Serialize, Deserialize, Clone)]
struct PersistedCurrentLiveSnapshot {
    session_protocol_version: String,
    capability_profile_version: String,
    session: crate::types::SessionManifest,
    run: Option<crate::types::RunManifest>,
    live_state: Option<crate::types::LiveState>,
    runtime_status: RuntimeStatusView,
    capabilities: Option<fullmag_runner::BackendCapabilities>,
    metadata: Option<crate::shared_json::SharedJson>,
    mesh_workspace: Option<crate::shared_json::SharedJson>,
    stage_execution: Option<crate::types::StageExecutionState>,
    scene_document: Option<fullmag_authoring::SceneDocument>,
    scalar_rows: Vec<crate::types::ScalarRow>,
    engine_log: Vec<crate::types::EngineLogEntry>,
    quantities: Vec<crate::types::QuantityDescriptor>,
    fem_mesh: Option<crate::shared_mesh::SharedFemMesh>,
    latest_fields: crate::types::LatestFields,
    #[serde(default)]
    field_publication_bundles: BTreeMap<String, crate::schemas::common::FieldPublicationBundle>,
    #[serde(default)]
    accepted_terminal_field_generation: Option<crate::types::CurrentLiveFieldGeneration>,
    #[serde(default)]
    terminal_field_generations: BTreeMap<String, u64>,
    artifacts: Vec<crate::types::ArtifactEntry>,
    display_selection: crate::types::CurrentDisplaySelection,
    /// Schema version for the persistence-only display presentation payload.
    /// Missing in historical snapshots means the frozen v6 shape.
    #[serde(default)]
    display_presentation_schema_version: Option<u32>,
    #[serde(default)]
    display_presentation: serde_json::Value,
    #[serde(default)]
    workspace_selection: CurrentWorkspaceSelection,
    #[serde(default)]
    workspace_ribbon: CurrentWorkspaceRibbon,
    #[serde(default)]
    workspace_layout: CurrentWorkspaceLayout,
    preview_config: crate::types::CurrentPreviewConfig,
    preview: Option<crate::types::PreviewState>,
    builder_adapter: Option<fullmag_authoring::ScriptBuilderState>,
    mesh_revision: u64,
    mesh_build_revision: u64,
    #[serde(default)]
    region_realization_revisions: fullmag_authoring::RegionRealizationRevisions,
}

impl From<&SessionStateResponse> for PersistedCurrentLiveSnapshot {
    fn from(value: &SessionStateResponse) -> Self {
        Self {
            session_protocol_version: value.session_protocol_version.clone(),
            capability_profile_version: value.capability_profile_version.clone(),
            session: value.session.clone(),
            run: value.run.clone(),
            live_state: value.live_state.clone(),
            runtime_status: value.runtime_status.clone(),
            capabilities: value.capabilities.clone(),
            metadata: value.metadata.clone(),
            mesh_workspace: value.mesh_workspace.clone(),
            stage_execution: value.stage_execution.clone(),
            scene_document: value.scene_document.clone(),
            scalar_rows: value.scalar_rows.clone(),
            engine_log: value.engine_log.clone(),
            quantities: value.quantities.clone(),
            fem_mesh: value.fem_mesh.clone(),
            latest_fields: value.latest_fields.clone(),
            field_publication_bundles: value.field_publication_bundles.clone(),
            accepted_terminal_field_generation: value.accepted_terminal_field_generation.clone(),
            terminal_field_generations: value.terminal_field_generations.clone(),
            artifacts: value.artifacts.clone(),
            display_selection: value.display_selection.clone(),
            display_presentation_schema_version: None,
            preview_config: value.preview_config.clone(),
            preview: value.preview.clone(),
            builder_adapter: value.builder_adapter.clone(),
            mesh_revision: value.mesh_revision,
            mesh_build_revision: value.mesh_build_revision,
            region_realization_revisions: value.region_realization_revisions,
            display_presentation: serde_json::Value::Null,
            workspace_selection: CurrentWorkspaceSelection::default(),
            workspace_ribbon: CurrentWorkspaceRibbon::default(),
            workspace_layout: CurrentWorkspaceLayout::default(),
        }
    }
}

const DISPLAY_PRESENTATION_SCHEMA_VERSION: u32 = 10;

fn persisted_display_presentation(
    presentation: &DisplayPresentationState,
) -> Result<serde_json::Value, serde_json::Error> {
    serde_json::to_value(presentation)
}

fn restore_display_presentation(
    schema_version: Option<u32>,
    document: &serde_json::Value,
) -> Result<DisplayPresentationState, String> {
    let mut restored = match schema_version.unwrap_or(6) {
        6 => migrate_display_presentation_v6(document.clone()),
        7 => migrate_display_presentation_v7(document.clone()),
        8 => migrate_display_presentation_v8(document.clone()),
        9 => migrate_display_presentation_v9(document.clone()),
        DISPLAY_PRESENTATION_SCHEMA_VERSION => serde_json::from_value(document.clone())
            .map_err(|error| format!("invalid v10 display presentation: {error}")),
        other => Err(format!(
            "unsupported display presentation schema_version {other}; current version is {DISPLAY_PRESENTATION_SCHEMA_VERSION}"
        )),
    }?;

    if let Some(overrides) = restored.visualization_overrides.take() {
        let canonicalized = canonicalize_visualization_overrides_with_diagnostics(&overrides);
        restored.visualization_overrides = Some(canonicalized.overrides);
        append_visualization_restore_warnings(
            &mut restored.visualization_restore_warnings,
            &canonicalized.warnings,
        );
    }
    bound_visualization_restore_warnings(&mut restored.visualization_restore_warnings);
    Ok(restored)
}

fn migrate_display_presentation_v7(
    mut state: serde_json::Value,
) -> Result<DisplayPresentationState, String> {
    if let Some(layers) = state
        .pointer_mut("/visualization_planar/layers")
        .and_then(serde_json::Value::as_object_mut)
    {
        layers
            .entry("bounds")
            .or_insert_with(|| serde_json::json!(false));
        layers
            .entry("points")
            .or_insert_with(|| serde_json::json!(false));
    }
    migrate_display_presentation_v8(state)
}

fn migrate_display_presentation_v8(
    mut state: serde_json::Value,
) -> Result<DisplayPresentationState, String> {
    let Some(planar_document) = state
        .pointer_mut("/visualization_planar")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return serde_json::from_value(state)
            .map_err(|error| format!("invalid v8 display presentation: {error}"));
    };

    if !planar_document.contains_key("source") {
        let source = match planar_document.remove("active_monitor_id") {
            Some(serde_json::Value::String(monitor_id)) if !monitor_id.trim().is_empty() => {
                serde_json::to_value(PlanarSourceSelectionState::Monitor { monitor_id })
                    .expect("planar monitor source serializes")
            }
            _ => serde_json::to_value(PlanarSourceSelectionState::Default)
                .expect("default planar source serializes"),
        };
        planar_document.insert("source".to_string(), source);
    } else {
        // The legacy alias is accepted only by this persistence migration.
        planar_document.remove("active_monitor_id");
    }
    if !planar_document.contains_key("default_slice") {
        let default_slice = default_planar_visualization_state().default_slice;
        planar_document.insert(
            "default_slice".to_string(),
            serde_json::to_value(default_slice).expect("default planar slice serializes"),
        );
    }

    migrate_display_presentation_v9(state)
}

fn migrate_display_presentation_v9(
    mut state: serde_json::Value,
) -> Result<DisplayPresentationState, String> {
    let defaults = serde_json::to_value(default_planar_visualization_state())
        .expect("default planar visualization serializes");
    if let Some(planar_document) = state
        .pointer_mut("/visualization_planar")
        .and_then(serde_json::Value::as_object_mut)
    {
        let default_planar = defaults
            .as_object()
            .expect("default planar visualization is an object");
        for field in [
            "visible",
            "viewport_colorbar_visible",
            "wireframe_style",
            "point_style",
        ] {
            if let Some(value) = default_planar.get(field) {
                planar_document
                    .entry(field)
                    .or_insert_with(|| value.clone());
            }
        }
        if let (Some(vector_style), Some(default_vector_style)) = (
            planar_document
                .get_mut("vector_style")
                .and_then(serde_json::Value::as_object_mut),
            default_planar
                .get("vector_style")
                .and_then(serde_json::Value::as_object),
        ) {
            for field in ["opacity", "thickness", "monochrome_color"] {
                if let Some(value) = default_vector_style.get(field) {
                    vector_style.entry(field).or_insert_with(|| value.clone());
                }
            }
        }
    }
    serde_json::from_value(state)
        .map_err(|error| format!("invalid migrated v9 display presentation: {error}"))
}

fn migrate_display_presentation_v6(
    mut state: serde_json::Value,
) -> Result<DisplayPresentationState, String> {
    let Some(planar_document) = state
        .pointer_mut("/visualization_planar")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return serde_json::from_value(state)
            .map_err(|error| format!("invalid v6 display presentation: {error}"));
    };

    let legacy_auto_contrast = planar_document
        .get("auto_contrast")
        .and_then(serde_json::Value::as_bool);
    let legacy_min = planar_document
        .get("contrast_min")
        .and_then(serde_json::Value::as_f64);
    let legacy_max = planar_document
        .get("contrast_max")
        .and_then(serde_json::Value::as_f64);

    let (range, warning) = match (legacy_auto_contrast, legacy_min, legacy_max) {
        (Some(true), _, _) | (None, _, _) => {
            (default_planar_color_range_state(), None)
        }
        (Some(false), Some(min), Some(max)) if min.is_finite() && max.is_finite() && min < max => {
            (
                PlanarColorRangeState {
                    mode: PlanarColorRangeMode::Manual,
                    min: Some(min),
                    max: Some(max),
                },
                None,
            )
        }
        (Some(false), _, _) => {
            (
                default_planar_color_range_state(),
                Some("Planarny zakres kontrastu z wersji v6 był niepoprawny; przywrócono bezpieczny zakres automatyczny.".to_string()),
            )
        }
    };
    planar_document.remove("auto_contrast");
    planar_document.remove("contrast_min");
    planar_document.remove("contrast_max");
    planar_document.insert(
        "range".to_string(),
        serde_json::to_value(range).expect("planar range serializes"),
    );
    planar_document
        .entry("raster_opacity")
        .or_insert_with(|| serde_json::json!(1.0));
    if let Some(layers) = planar_document
        .get_mut("layers")
        .and_then(serde_json::Value::as_object_mut)
    {
        layers
            .entry("bounds")
            .or_insert_with(|| serde_json::json!(false));
        layers
            .entry("points")
            .or_insert_with(|| serde_json::json!(false));
    }
    if let Some(warning) = warning {
        state
            .as_object_mut()
            .expect("v6 display presentation remains an object")
            .entry("visualization_restore_warnings")
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .expect("restore warnings remain an array")
            .push(serde_json::Value::String(warning));
    }
    migrate_display_presentation_v7(state)
}

impl From<PersistedCurrentLiveSnapshot> for SessionStateResponse {
    fn from(value: PersistedCurrentLiveSnapshot) -> Self {
        let scalar_revision = value.scalar_rows.len() as u64;
        let accepted_terminal_field_generation = value.accepted_terminal_field_generation;
        let mut terminal_field_generations = value.terminal_field_generations;
        if let Some(generation) = accepted_terminal_field_generation.as_ref() {
            terminal_field_generations
                .entry(generation.run_id.clone())
                .or_insert(generation.sequence);
        }
        SessionStateResponse {
            session_protocol_version: value.session_protocol_version,
            capability_profile_version: value.capability_profile_version,
            session: value.session,
            run: value.run,
            live_state: value.live_state,
            coupled_checkpoint: None,
            imported_antenna_mesh_proof: None,
            runtime_status: value.runtime_status,
            capabilities: value.capabilities,
            metadata: value.metadata,
            mesh_workspace: value.mesh_workspace,
            stage_execution: value.stage_execution,
            simulation_preparation: None,
            scene_document: value.scene_document,
            scalar_rows: value.scalar_rows,
            engine_log: value.engine_log,
            solver_profile: crate::schemas::diagnostics::SolverProfileResource::default(),
            quantities: value.quantities,
            fem_mesh: value.fem_mesh,
            latest_fields: value.latest_fields,
            field_publication_bundles: value.field_publication_bundles,
            preview_cache: crate::types::CachedPreviewFields::default(),
            artifacts: value.artifacts,
            display_selection: value.display_selection,
            preview_config: value.preview_config,
            preview: value.preview,
            builder_adapter: value.builder_adapter,
            state_version: 0,
            scalar_revision,
            mesh_revision: value.mesh_revision,
            mesh_build_revision: value.mesh_build_revision,
            field_catalog_revision: 0,
            field_samples_revision: 0,
            field_quantity_revisions: BTreeMap::new(),
            accepted_terminal_field_generation,
            terminal_field_generations,
            stage_execution_revision: 0,
            simulation_preparation_revision: 0,
            region_realization_revisions: value.region_realization_revisions,
        }
    }
}

// ── Request / Response types ───────────────────────────────────────────

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct AcceptedRunExportSource {
    pub project_id: String,
    pub run_id: String,
    pub run_catalog_revision: u64,
    pub artifact_catalog_revision: u64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct SessionExportRequest {
    /// Save profile: "compact", "solved", "resume", "archive".
    pub profile: SaveProfile,
    /// Optional session name override.
    #[serde(default)]
    pub name: Option<String>,
    /// Compression: "speed", "balanced", "smallest".
    #[serde(default)]
    pub compression: Option<fullmag_session::CompressionProfile>,
    /// Optional UI workspace snapshot provided by frontend.
    #[serde(default)]
    pub ui_state: Option<serde_json::Value>,
    /// Explicit `.fms` output path.  It is used only when `save_to_source` is
    /// true and must resolve inside the configured output mapping.
    #[serde(default)]
    pub target_path: Option<String>,
    /// Persist the archive beside the admitted source script instead of only
    /// returning its base64 representation.  Omitted requests preserve the
    /// historical export/download behavior.
    #[serde(default)]
    pub save_to_source: Option<bool>,
    /// Explicit immutable historical source. Solved downloads only; the current
    /// authoring workspace is not changed or used as historical result evidence.
    #[serde(default)]
    pub accepted_run: Option<AcceptedRunExportSource>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct SessionExportResponse {
    pub session_id: String,
    pub profile: SaveProfile,
    /// Base64-encoded `.fms` file content for browser exports.  This remains
    /// a required compatibility field and is empty when `saved_path` is
    /// present; source-save consumers should use the persisted path instead.
    pub fms_base64: String,
    pub size_bytes: usize,
    /// Path written when `save_to_source` was enabled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_path: Option<String>,
    /// File name written when `save_to_source` was enabled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

const SESSION_OUTPUT_ROOT_ENV: &str = "FULLMAG_SCRIPT_OUTPUT_ROOT";
const SESSION_OUTPUT_SOURCE_DIR_ENV: &str = "FULLMAG_SCRIPT_OUTPUT_SOURCE_DIR";
const DEFAULT_CONTAINER_SOURCE_ROOT: &str = "/opt/fullmag/source";
const MAX_SESSION_OUTPUT_COLLISION_ATTEMPTS: usize = 10_000;

/// Resolve the host-backed output mapping for a source script.  Docker may
/// expose only a deliberately selected source subtree as a writable alias;
/// the source checkout itself remains read-only.  With no mapping configured
/// (the native desktop case), an explicit absolute target is allowed and the
/// default is beside the admitted script.
fn resolve_session_output_target(
    script_path: &Path,
    requested_target: Option<&str>,
) -> Result<PathBuf, ApiError> {
    let output_root = std::env::var_os(SESSION_OUTPUT_ROOT_ENV).map(PathBuf::from);
    let source_root = output_root.as_ref().map(|_| {
        std::env::var_os(SESSION_OUTPUT_SOURCE_DIR_ENV)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_CONTAINER_SOURCE_ROOT))
    });

    resolve_session_output_target_for_mapping(
        script_path,
        requested_target,
        output_root
            .as_deref()
            .zip(source_root.as_deref()),
    )
}

fn resolve_session_output_target_for_mapping(
    script_path: &Path,
    requested_target: Option<&str>,
    output_mapping: Option<(&Path, &Path)>,
) -> Result<PathBuf, ApiError> {
    let target = if let Some((output_root, source_root)) = output_mapping {
        require_absolute_path(output_root, SESSION_OUTPUT_ROOT_ENV)?;
        require_absolute_path(source_root, SESSION_OUTPUT_SOURCE_DIR_ENV)?;
        let output_root = canonical_directory(output_root, SESSION_OUTPUT_ROOT_ENV)?;
        let source_root = canonical_directory(source_root, SESSION_OUTPUT_SOURCE_DIR_ENV)?;
        let script = canonical_regular_file(script_path, "session script")?;
        let relative = script.strip_prefix(&source_root).map_err(|_| {
            ApiError::bad_request(format!(
                "session script `{}` is outside configured source output mapping `{}`",
                script.display(),
                source_root.display()
            ))
        })?;
        let default_target = output_root
            .join(relative.parent().unwrap_or_else(|| Path::new("")))
            .join(default_session_filename(&script)?);
        let target = requested_target
            .map(PathBuf::from)
            .unwrap_or(default_target);
        validate_target_within_root(&target, &output_root, SESSION_OUTPUT_ROOT_ENV)?;
        target
    } else {
        let target = requested_target
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                script_path
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .join(
                        script_path
                            .file_stem()
                            .map(|stem| format!("{}.fms", stem.to_string_lossy()))
                            .unwrap_or_else(|| "session.fms".into()),
                    )
            });
        require_absolute_path(&target, "session target path")?;
        validate_path_components(&target, "session target path")?;
        target
    };

    require_fms_extension(&target)?;
    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| ApiError::bad_request("session target path has no parent directory"))?;
    canonical_directory(parent, "session target parent")?;
    validate_path_components(&target, "session target path")?;
    Ok(target)
}

fn validate_session_output_request(
    requested_target: Option<&str>,
    save_to_source: bool,
) -> Result<(), ApiError> {
    if requested_target.is_some() && !save_to_source {
        return Err(ApiError::bad_request(
            "target_path requires save_to_source=true",
        ));
    }
    Ok(())
}

fn default_session_filename(script_path: &Path) -> Result<String, ApiError> {
    let stem = script_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request("session script has no usable file stem"))?;
    Ok(format!("{stem}.fms"))
}

fn session_export_base64(fms_bytes: &[u8], saved_path: Option<&str>) -> String {
    if saved_path.is_some() {
        String::new()
    } else {
        base64_encode(fms_bytes)
    }
}

fn require_absolute_path(path: &Path, label: &str) -> Result<(), ApiError> {
    if !path.is_absolute() {
        return Err(ApiError::bad_request(format!(
            "{label} must be absolute"
        )));
    }
    Ok(())
}

fn require_fms_extension(path: &Path) -> Result<(), ApiError> {
    let valid = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("fms"));
    if !valid {
        return Err(ApiError::bad_request(format!(
            "session target must use the .fms extension: {}",
            path.display()
        )));
    }
    Ok(())
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, ApiError> {
    validate_path_components(path, label)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        ApiError::bad_request(format!("{label} is not available: {error}"))
    })?;
    if !metadata.file_type().is_dir() {
        return Err(ApiError::bad_request(format!(
            "{label} must be a directory: {}",
            path.display()
        )));
    }
    fs::canonicalize(path)
        .map_err(|error| ApiError::bad_request(format!("cannot canonicalize {label}: {error}")))
}

fn canonical_regular_file(path: &Path, label: &str) -> Result<PathBuf, ApiError> {
    require_absolute_path(path, label)?;
    validate_path_components(path, label)?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| ApiError::bad_request(format!("{label} is not available: {error}")))?;
    if !metadata.file_type().is_file() {
        return Err(ApiError::bad_request(format!(
            "{label} must be a regular file: {}",
            path.display()
        )));
    }
    fs::canonicalize(path)
        .map_err(|error| ApiError::bad_request(format!("cannot canonicalize {label}: {error}")))
}

fn validate_target_within_root(
    target: &Path,
    root: &Path,
    root_label: &str,
) -> Result<(), ApiError> {
    require_absolute_path(target, "session target path")?;
    validate_path_components(target, "session target path")?;
    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| ApiError::bad_request("session target path has no parent directory"))?;
    let canonical_parent = canonical_directory(parent, "session target parent")?;
    if !canonical_parent.starts_with(root) {
        return Err(ApiError::bad_request(format!(
            "session target path must stay inside {root_label}"
        )));
    }
    Ok(())
}

/// Reject links/reparse points in every existing component.  Canonicalizing
/// only the final path is insufficient when the final file has not been
/// created yet, because a parent link could redirect the publication.
fn validate_path_components(path: &Path, label: &str) -> Result<(), ApiError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        if matches!(component, Component::ParentDir) {
            return Err(ApiError::bad_request(format!(
                "{label} may not contain a parent-directory component"
            )));
        }
        current.push(component.as_os_str());
        #[cfg(windows)]
        if matches!(component, Component::Prefix(_)) {
            // A Windows volume/UNC prefix is not a filesystem component.
            // Inspecting it as a standalone path can return ERROR_INVALID_FUNCTION;
            // the following RootDir and normal components are still checked.
            continue;
        }
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(ApiError::bad_request(format!(
                    "cannot inspect {label}: {error}"
                )))
            }
        };
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err(ApiError::bad_request(format!(
                "{label} may not traverse a symlink or reparse point: {}",
                current.display()
            )));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes()
        & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
        != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn next_session_output_candidate(base: &Path, suffix: usize) -> PathBuf {
    if suffix == 0 {
        return base.to_path_buf();
    }
    let stem = base
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("session");
    base.with_file_name(format!("{stem}-{suffix}.fms"))
}

/// Publish a new archive without replacing an existing file.  The session
/// store transaction held by the export handler serializes API writers; the
/// create-new staging file plus hard-link publication closes the remaining
/// destination race without relying on rename-overwrite semantics.
fn publish_session_archive(
    base: &Path,
    bytes: &[u8],
) -> Result<(PathBuf, String), ApiError> {
    let parent = base
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| ApiError::bad_request("session target path has no parent directory"))?;
    canonical_directory(parent, "session target parent")?;
    for suffix in 0..=MAX_SESSION_OUTPUT_COLLISION_ATTEMPTS {
        let candidate = next_session_output_candidate(base, suffix);
        validate_path_components(&candidate, "session target path")?;
        if let Ok(metadata) = fs::symlink_metadata(&candidate) {
            if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
                return Err(ApiError::bad_request(format!(
                    "session target may not be a symlink or reparse point: {}",
                    candidate.display()
                )));
            }
            continue;
        }

        let staging = parent.join(format!(
            ".{}.{}.fms.part",
            candidate
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("session"),
            uuid::Uuid::new_v4()
        ));
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(ApiError::internal(format!(
                    "cannot stage session archive `{}`: {error}",
                    staging.display()
                )))
            }
        };
        let result = (|| -> Result<(), ApiError> {
            file.write_all(bytes).map_err(|error| {
                ApiError::internal(format!("cannot write session archive staging file: {error}"))
            })?;
            file.sync_all().map_err(|error| {
                ApiError::internal(format!("cannot sync session archive staging file: {error}"))
            })?;
            drop(file);
            match fs::hard_link(&staging, &candidate) {
                Ok(()) => {
                    let published = OpenOptions::new()
                        .read(true)
                        .write(true)
                        .open(&candidate)
                        .map_err(|error| {
                            ApiError::internal(format!(
                                "cannot reopen published session archive: {error}"
                            ))
                        })?;
                    published.sync_all().map_err(|error| {
                        ApiError::internal(format!(
                            "cannot sync published session archive: {error}"
                        ))
                    })?;
                    Ok(())
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    Err(ApiError::conflict("session output candidate already exists"))
                }
                Err(error) => Err(ApiError::internal(format!(
                    "cannot publish session archive `{}`: {error}",
                    candidate.display()
                ))),
            }
        })();
        let _ = fs::remove_file(&staging);
        match result {
            Ok(()) => {
                let filename = candidate
                    .file_name()
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| ApiError::internal("published session filename is not UTF-8"))?
                    .to_owned();
                return Ok((candidate, filename));
            }
            Err(error) if error.status == axum::http::StatusCode::CONFLICT => continue,
            Err(error) => return Err(error),
        }
    }
    Err(ApiError::conflict(
        "could not reserve a collision-free session output filename",
    ))
}

#[cfg(test)]
mod session_output_target_tests {
    use super::*;

    #[test]
    fn default_session_filename_uses_the_script_stem() {
        assert_eq!(
            default_session_filename(Path::new("/tmp/permalloy_layer.py")).unwrap(),
            "permalloy_layer.fms"
        );
    }

    #[test]
    fn mapped_default_target_preserves_the_script_relative_directory() {
        let root = tempfile::tempdir().expect("temporary mapping root");
        let source_root = root.path().join("source");
        let output_root = root.path().join("output");
        let script_directory = source_root.join("examples");
        std::fs::create_dir_all(&script_directory).expect("script directory");
        std::fs::create_dir_all(output_root.join("examples")).expect("output directory");
        let script = script_directory.join("model.py");
        std::fs::write(&script, b"study = None\n").expect("source script");

        let target = resolve_session_output_target_for_mapping(
            &script,
            None,
            Some((&output_root, &source_root)),
        )
        .expect("mapped target");

        let expected = std::fs::canonicalize(&output_root)
            .expect("canonical output directory")
            .join("examples/model.fms");
        assert_eq!(target, expected);
    }

    #[test]
    fn explicit_target_takes_priority_inside_the_output_mapping() {
        let root = tempfile::tempdir().expect("temporary mapping root");
        let source_root = root.path().join("source");
        let output_root = root.path().join("output");
        let script_directory = source_root.join("examples");
        std::fs::create_dir_all(&script_directory).expect("script directory");
        std::fs::create_dir_all(&output_root).expect("output directory");
        let script = script_directory.join("model.py");
        std::fs::write(&script, b"study = None\n").expect("source script");
        let explicit = output_root.join("chosen.fms");

        let target = resolve_session_output_target_for_mapping(
            &script,
            Some(explicit.to_str().expect("UTF-8 target")),
            Some((&output_root, &source_root)),
        )
        .expect("explicit mapped target");

        assert_eq!(target, explicit);
    }

    #[test]
    fn mapped_target_rejects_a_script_outside_the_source_mapping() {
        let root = tempfile::tempdir().expect("temporary mapping root");
        let source_root = root.path().join("source");
        let output_root = root.path().join("output");
        std::fs::create_dir_all(&source_root).expect("source directory");
        std::fs::create_dir_all(&output_root).expect("output directory");
        let script = root.path().join("outside.py");
        std::fs::write(&script, b"study = None\n").expect("outside script");

        let error = resolve_session_output_target_for_mapping(
            &script,
            None,
            Some((&output_root, &source_root)),
        )
        .expect_err("off-prefix script must be rejected");

        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
    }

    #[cfg(unix)]
    #[test]
    fn mapped_target_rejects_a_symlinked_source_component() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("temporary mapping root");
        let source_root = root.path().join("source");
        let real_directory = root.path().join("real-examples");
        let output_root = root.path().join("output");
        std::fs::create_dir_all(&source_root).expect("source directory");
        std::fs::create_dir_all(&real_directory).expect("real script directory");
        std::fs::create_dir_all(&output_root).expect("output directory");
        let real_script = real_directory.join("model.py");
        std::fs::write(&real_script, b"study = None\n").expect("source script");
        let linked_directory = source_root.join("examples");
        symlink(&real_directory, &linked_directory).expect("source symlink");
        let script = linked_directory.join("model.py");

        let error = resolve_session_output_target_for_mapping(
            &script,
            None,
            Some((&output_root, &source_root)),
        )
        .expect_err("symlinked source component must be rejected");

        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
    }

    #[test]
    fn native_target_rejects_parent_directory_components() {
        let root = tempfile::tempdir().expect("temporary output root");
        let target = root.path().join("nested").join("..").join("model.fms");

        let error = resolve_session_output_target(
            &root.path().join("model.py"),
            Some(target.to_str().expect("UTF-8 target")),
        )
        .expect_err("parent-directory target must be rejected");

        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
    }

    #[test]
    fn explicit_target_requires_source_save() {
        let error = validate_session_output_request(Some("/tmp/model.fms"), false)
            .expect_err("target path without source save must be rejected");

        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
    }

    #[test]
    fn source_saved_response_omits_archive_base64_but_export_keeps_it() {
        assert_eq!(session_export_base64(b"archive", Some("/tmp/model.fms")), "");
        assert_eq!(
            session_export_base64(b"archive", None),
            base64_encode(b"archive")
        );
    }

    #[test]
    fn publication_adds_a_suffix_without_overwriting_an_existing_archive() {
        let root = tempfile::tempdir().expect("temporary output root");
        let base = root.path().join("model.fms");
        std::fs::write(&base, b"old archive").expect("existing archive");

        let (published, filename) = publish_session_archive(&base, b"new archive")
            .expect("collision-free archive publication");

        assert_eq!(filename, "model-1.fms");
        assert_eq!(published, root.path().join("model-1.fms"));
        assert_eq!(std::fs::read(&base).unwrap(), b"old archive");
        assert_eq!(std::fs::read(published).unwrap(), b"new archive");
    }

    #[test]
    fn publication_rejects_a_non_fms_target() {
        let root = tempfile::tempdir().expect("temporary output root");
        let target = root.path().join("model.zip");
        let error = resolve_session_output_target(
            &root.path().join("model.py"),
            Some(target.to_str().expect("UTF-8 target")),
        )
        .expect_err("non-FMS target must be rejected");
        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
    }

    #[test]
    fn publication_reports_a_non_directory_parent_without_partial_output() {
        let root = tempfile::tempdir().expect("temporary output root");
        let parent = root.path().join("parent");
        std::fs::write(&parent, b"parent file").expect("parent marker");
        let target = parent.join("model.fms");

        let error = publish_session_archive(&target, b"archive")
            .expect_err("a file cannot be used as an output directory");

        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(std::fs::read(&parent).unwrap(), b"parent file");
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct SessionImportInspectRequest {
    /// Base64-encoded `.fms` file content.
    pub fms_base64: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct SessionImportInspectResponse {
    pub inspection: SessionInspection,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct SessionImportCommitRequest {
    /// Base64-encoded `.fms` file content.
    pub fms_base64: String,
    /// Requested import behavior. Defaults to a visualization-only restore.
    #[serde(default)]
    pub restore_mode: SessionRestoreMode,
}

/// Explicit import behavior for an FMS archive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionRestoreMode {
    VisualizationOnly,
    ReplaceProject,
    Resume,
}

impl Default for SessionRestoreMode {
    fn default() -> Self {
        Self::VisualizationOnly
    }
}

/// Whether a semantic category could be compared from both snapshots.
#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionRestoreCompatibilityBasis {
    Available,
    Unavailable,
}

/// Non-blocking semantic differences in one restore category.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct SessionRestoreCompatibilityCategory {
    pub basis: SessionRestoreCompatibilityBasis,
    pub differences: Vec<String>,
}

/// Semantic compatibility report returned with every accepted FMS import.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct SessionRestoreCompatibility {
    pub geometry: SessionRestoreCompatibilityCategory,
    pub materials_physics: SessionRestoreCompatibilityCategory,
    pub mesh: SessionRestoreCompatibilityCategory,
    pub study_stages: SessionRestoreCompatibilityCategory,
    pub execution: SessionRestoreCompatibilityCategory,
    pub problem_ir: SessionRestoreCompatibilityCategory,
}

impl SessionRestoreCompatibility {
    fn warnings(&self) -> Vec<String> {
        [
            ("geometry", &self.geometry),
            ("materials_physics", &self.materials_physics),
            ("mesh", &self.mesh),
            ("study_stages", &self.study_stages),
            ("execution", &self.execution),
            ("problem_ir", &self.problem_ir),
        ]
        .into_iter()
        .filter(|(_, category)| !category.differences.is_empty())
        .map(|(name, _)| format!("non-blocking semantic difference in {name}"))
        .collect()
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct SessionImportCommitResponse {
    pub session_id: String,
    pub restore_mode: SessionRestoreMode,
    pub restore_class: fullmag_session::RestoreClass,
    pub warnings: Vec<String>,
    pub compatibility: SessionRestoreCompatibility,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_state: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct CheckpointListResponse {
    pub checkpoints: Vec<CheckpointEntry>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct CheckpointCreateRequest {
    #[serde(default = "default_checkpoint_profile")]
    pub profile: SaveProfile,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub expected_state_version: Option<u64>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct CheckpointCreateResponse {
    pub checkpoint: CheckpointEntry,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct CheckpointRestoreRequest {
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub expected_state_version: Option<u64>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct CheckpointRestoreResponse {
    pub checkpoint: CheckpointEntry,
    pub restore_class: fullmag_session::RestoreClass,
    pub restored_vector_count: u64,
    pub field_revision: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct CheckpointEntry {
    pub checkpoint_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    pub run_id: String,
    pub step: u64,
    pub time_s: f64,
    pub dt: f64,
    pub created_at: String,
    pub source: String,
    pub format: String,
    pub vector_count: u64,
    pub coordinate_frame: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_family: Option<String>,
    pub resume_class: fullmag_session::RestoreClass,
    pub artifact_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checksum: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct RecoveryListResponse {
    pub snapshots: Vec<RecoveryEntry>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct RecoveryEntry {
    pub session_id: String,
    pub name: String,
    pub saved_at: String,
    pub profile: SaveProfile,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct RecoveryClearResponse {
    pub cleared: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub(crate) struct FieldStateTargetRef {
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct FieldStateExportRequest {
    pub target: FieldStateTargetRef,
    pub quantity_id: String,
    #[serde(default = "default_field_state_format")]
    pub format: String,
    #[serde(default)]
    pub file_name: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct FieldStateExportResponse {
    pub artifact_ref: String,
    pub target: FieldStateTargetRef,
    pub quantity_id: String,
    pub format: String,
    pub point_count: u64,
    pub component_count: u64,
    pub field_revision: u64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct FieldStateInspectRequest {
    pub artifact_ref: String,
    pub target: FieldStateTargetRef,
    pub quantity_id: String,
    #[serde(default)]
    pub format: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct FieldStateInspectResponse {
    pub artifact_ref: String,
    pub target: FieldStateTargetRef,
    pub quantity_id: String,
    pub format: String,
    pub compatibility: String,
    pub default_mode: String,
    pub point_count: u64,
    pub component_count: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct FieldStateImportRequest {
    pub artifact_ref: String,
    pub target: FieldStateTargetRef,
    pub quantity_id: String,
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct FieldStateImportResponse {
    pub artifact_ref: String,
    pub target: FieldStateTargetRef,
    pub quantity_id: String,
    pub mode: String,
    pub applied_point_count: u64,
    pub field_revision: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct FieldStateJsonArtifact {
    fullmag_kind: String,
    schema_version: u32,
    quantity_id: String,
    target: FieldStateTargetRef,
    component_count: u64,
    values: Vec<[f64; 3]>,
    source_step: Option<u64>,
    source_time_s: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct HysteresisMagnetizationSnapshotArtifact {
    quantity_id: String,
    values: Vec<[f64; 3]>,
}

// ── Helpers ────────────────────────────────────────────────────────────

pub(crate) fn session_store_root(state: &AppState) -> std::path::PathBuf {
    session_store_path(
        &state.repo_root,
        state.current_command_journal_store_root.as_deref(),
    )
}

fn session_store_path(
    repo_root: &std::path::Path,
    configured: Option<&std::path::Path>,
) -> std::path::PathBuf {
    // Startup resolves the writable state once. Checkpoints and the command
    // journal must use that same store, including installed Windows packages.
    configured
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| {
            repo_root
                .join(".fullmag")
                .join("local-live")
                .join("session-store")
        })
}

#[cfg(test)]
mod session_store_path_tests {
    use super::session_store_path;

    #[test]
    fn checkpoint_store_uses_the_frozen_startup_state_root() {
        let directory = tempfile::tempdir().unwrap();
        let install = directory.path().join("read-only-install");
        let store = directory.path().join("user-state/local-live/session-store");
        assert_eq!(session_store_path(&install, Some(&store)), store);
        assert!(!install.exists());
    }

    #[test]
    fn unconfigured_legacy_state_keeps_its_existing_store() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            session_store_path(directory.path(), None),
            directory.path().join(".fullmag/local-live/session-store")
        );
    }
}

fn default_checkpoint_profile() -> SaveProfile {
    SaveProfile::Resume
}

fn default_field_state_format() -> String {
    "field_state_json".to_string()
}

pub(crate) fn open_store(state: &AppState) -> Result<SessionStore, ApiError> {
    SessionStore::open(session_store_root(state)).map_err(|e| ApiError::internal(e.to_string()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AcceptedExportIdentity {
    session_id: String,
    run_id: String,
    session_epoch: u64,
    scene_revision: u64,
}

#[derive(Debug)]
struct AcceptedExportCapture {
    identity: AcceptedExportIdentity,
    /// Full accepted-store closure captured before profile filtering.  The
    /// archive may intentionally omit solver outputs, but a final fence must
    /// still detect records appended to the source closure meanwhile.
    full_provenance_manifest: AcceptedProvenanceManifest,
    run_manifest: FmsRunManifest,
    provenance: AcceptedProvenancePlan,
}

fn accepted_marker_value(
    value: &serde_json::Value,
    field: &str,
) -> Result<Option<String>, ApiError> {
    let object = value.as_object().ok_or_else(|| {
        ApiError::conflict(format!(
            "accepted export marker containing `{field}` must be an object"
        ))
    })?;
    let Some(value) = object.get(field) else {
        return Ok(None);
    };
    let value = value.as_str().ok_or_else(|| {
        ApiError::conflict(format!(
            "accepted export marker `{field}` must be a string"
        ))
    })?;
    if value.is_empty() {
        return Err(ApiError::conflict(format!(
            "accepted export marker `{field}` must not be empty"
        )));
    }
    Ok(Some(value.to_string()))
}

fn declared_accepted_run_id(
    snapshot: &SessionStateResponse,
) -> Result<Option<String>, ApiError> {
    let startup = snapshot
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("docker_startup"));
    let startup_run = startup
        .map(|value| accepted_marker_value(value, "run_id"))
        .transpose()?
        .flatten();
    let workspace_run = snapshot
        .mesh_workspace
        .as_ref()
        .map(|workspace| accepted_marker_value(workspace, "accepted_run_id"))
        .transpose()?
        .flatten();
    if let (Some(startup), Some(workspace)) = (&startup_run, &workspace_run) {
        if startup != workspace {
            return Err(ApiError::conflict(
                "accepted export markers disagree on the run identity",
            ));
        }
    }
    Ok(startup_run.or(workspace_run))
}

fn accepted_fms_run_status(status: &str) -> Result<fullmag_session::RunStatus, ApiError> {
    match status {
        "running" | "waiting_for_solve" | "waiting_for_compute" | "awaiting_command"
        | "preparing" => Ok(fullmag_session::RunStatus::Running),
        "paused" => Ok(fullmag_session::RunStatus::Paused),
        "completed" => Ok(fullmag_session::RunStatus::Completed),
        "failed" => Ok(fullmag_session::RunStatus::Failed),
        "interrupted" | "stopped" => Ok(fullmag_session::RunStatus::Interrupted),
        other => Err(ApiError::conflict(format!(
            "accepted export has unsupported run status `{other}`"
        ))),
    }
}

fn accepted_plan_for_profile(
    plan: AcceptedProvenancePlan,
    context: &AcceptedProvenanceContext,
    include_artifacts: bool,
) -> anyhow::Result<AcceptedProvenancePlan> {
    if include_artifacts {
        return Ok(plan);
    }

    // Compact/ConfigOnly exports retain the accepted input closure but must
    // not smuggle accepted solver outputs into the archive.  The generic
    // planner intentionally discovers all typed outputs; trim that plan here
    // before the FMS packer sees it and retain only CAS objects named by the
    // immutable RunIntent.
    let retained_records = plan
        .records
        .iter()
        .filter(|record| {
            matches!(
                record.kind,
                AcceptedProvenanceRecordKind::RunIntent
                    | AcceptedProvenanceRecordKind::RunCatalog
                    | AcceptedProvenanceRecordKind::TaskPreparationReceipt
                    | AcceptedProvenanceRecordKind::AcceptedStagePreparationReceipt
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    let intent_record = retained_records
        .iter()
        .find(|record| record.kind == AcceptedProvenanceRecordKind::RunIntent)
        .ok_or_else(|| anyhow::anyhow!("accepted provenance closure has no RunIntent"))?;
    let intent_bytes = plan.read_record(intent_record)?;
    let intent: fullmag_session::FmsRunIntent = serde_json::from_slice(&intent_bytes)?;
    intent.validate()?;

    let mut retained_refs = std::collections::BTreeSet::new();
    for object_ref in [
        intent.definition_object_ref.as_deref(),
        intent.study_object_ref.as_deref(),
        intent.study_catalog_object_ref.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        retained_refs.insert(object_ref.to_string());
    }
    retained_refs.extend(intent.asset_object_refs.values().cloned());

    let retained_objects = plan
        .cas_objects
        .iter()
        .filter(|object| retained_refs.contains(&object.object_ref))
        .cloned()
        .collect::<Vec<_>>();
    let manifest_records = retained_records
        .iter()
        .map(|record| fullmag_session::accepted_provenance::AcceptedProvenanceRecord {
            kind: record.kind,
            source_path: record.source_relative_path.clone(),
            archive_path: record.archive_path.clone(),
            content_sha256: record.content_sha256.clone(),
            byte_count: record.byte_count,
        })
        .collect::<Vec<_>>();
    let manifest_objects = retained_objects
        .iter()
        .map(|object| fullmag_session::accepted_provenance::AcceptedProvenanceCasObject {
            object_ref: object.object_ref.clone(),
            byte_count: object.byte_count,
        })
        .collect::<Vec<_>>();
    let manifest = AcceptedProvenanceManifest::from_context(
        context,
        manifest_records,
        manifest_objects,
    )?;
    let filtered = AcceptedProvenancePlan {
        source_root: plan.source_root.clone(),
        manifest,
        records: retained_records,
        cas_objects: retained_objects,
    };
    filtered.verify_sources()?;
    Ok(filtered)
}

fn historical_export_error(error: anyhow::Error) -> ApiError {
    if error.chain().any(|cause| matches!(cause.downcast_ref::<std::fs::TryLockError>(),
        Some(std::fs::TryLockError::WouldBlock))) {
        ApiError::conflict_with_code("antenna_store_busy", "accepted source has an active writer; retry this read")
    } else {
        ApiError::conflict(format!("historical_export_source_invalid: {error}"))
    }
}

fn validate_historical_export_pins(state: &AppState, source: &AcceptedRunExportSource, capture: &AcceptedExportCapture)
    -> Result<(), ApiError> {
    let root = state.submit_store_root.as_ref().ok_or_else(|| ApiError::conflict("accepted export store disappeared"))?;
    for (kind, expected) in [(AcceptedProvenanceRecordKind::RunCatalog, source.run_catalog_revision),
        (AcceptedProvenanceRecordKind::ArtifactCatalog, source.artifact_catalog_revision)] {
        let records = capture.full_provenance_manifest.records.iter().filter(|record| record.kind == kind).collect::<Vec<_>>();
        if records.len() != 1 { return Err(ApiError::conflict("historical export catalog is absent or ambiguous")); }
        let record = records[0];
        let bytes = fullmag_session::repository_path::read_bounded_regular_file(root, &record.source_path,
            fullmag_session::accepted_provenance::MAX_ACCEPTED_PROVENANCE_RECORD_BYTES).map_err(historical_export_error)?;
        if bytes.len() as u64 != record.byte_count || fullmag_session::hex_sha256(&bytes) != record.content_sha256 {
            return Err(ApiError::conflict("historical export catalog changed after initial capture"));
        }
        let revision = match kind {
            AcceptedProvenanceRecordKind::RunCatalog => serde_json::from_slice::<fullmag_session::FmsRunCatalog>(&bytes)
                .map(|catalog| catalog.revision),
            AcceptedProvenanceRecordKind::ArtifactCatalog => serde_json::from_slice::<fullmag_session::FmsArtifactCatalog>(&bytes)
                .map(|catalog| catalog.revision),
            _ => unreachable!("only catalogs are selected above"),
        }.map_err(|e| ApiError::conflict(e.to_string()))?;
        if revision != expected { return Err(ApiError::conflict("historical export catalog differs from the requested revision")); }
    }
    Ok(())
}

const ACCEPTED_PROJECTION_WARNING: &str = "accepted_definition_readonly_projection: scene is a read-only projection of the immutable accepted definition, not an exact restoration of the former authored workspace; original authored input identity is preserved in provenance";

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptedDefinitionProjection {
    schema_version: String,
    project_id: String,
    run_id: String,
    definition_sha256: String,
    projection_sha256: String,
    authored_execution_input: serde_json::Value,
}

// This constructs archive documents only. It never publishes a current session,
// reattaches a worker or restores scheduler authority for a historical run.
fn historical_export_snapshot(state: &AppState, source: &AcceptedRunExportSource)
    -> Result<(SessionStateResponse, u64, Vec<u8>), ApiError> {
    let invalid = |error: String| ApiError::conflict(format!("historical_export_source_invalid: {error}"));
    let root = state.submit_store_root.as_ref().ok_or_else(|| invalid("accepted store unavailable".into()))?;
    let store = SessionStore::open_existing(root).map_err(|e| invalid(e.to_string()))?;
    let _transaction = store.read_transaction().map_err(historical_export_error)?;
    let run = fullmag_application::RunId::parse(&source.run_id).map_err(|e| invalid(e.to_string()))?;
    let project = fullmag_application::ProjectId::parse(&source.project_id).map_err(|e| invalid(e.to_string()))?;
    let accepted = fullmag_runtime_control::load_accepted_study_snapshot(&store, &run, &project).map_err(|e| invalid(e.to_string()))?;
    let catalog = store.read_run_catalog(run.as_str()).map_err(|e| invalid(e.to_string()))?
        .ok_or_else(|| invalid("run catalog absent".into()))?;
    let artifacts = store.read_artifact_catalog(run.as_str()).map_err(|e| invalid(e.to_string()))?
        .ok_or_else(|| invalid("artifact catalog absent".into()))?;
    catalog.validate().map_err(|e| invalid(e.to_string()))?;
    artifacts.validate().map_err(|e| invalid(e.to_string()))?;
    if catalog.revision != source.run_catalog_revision || artifacts.revision != source.artifact_catalog_revision
        || catalog.tasks.is_empty() || catalog.tasks.iter().any(|task| task.lifecycle != fullmag_session::FmsTaskLifecycle::Succeeded) {
        return Err(invalid("catalog pins differ or the run is not successfully completed".into()));
    }
    let specification = &accepted.run.specification;
    let workspace = &specification.parameters["live_workspace"];
    let session_id = workspace["session_id"].as_str().ok_or_else(|| invalid("source session identity absent".into()))?;
    fullmag_session::repository_path::validate_store_id(session_id).map_err(|e| invalid(e.to_string()))?;
    let epoch = workspace["session_epoch"].as_u64().filter(|value| *value > 0).ok_or_else(|| invalid("source epoch absent".into()))?;
    let definition: serde_json::Value = serde_json::from_slice(&accepted.run.definition_bytes).map_err(|e| invalid(e.to_string()))?;
    let scene: fullmag_authoring::SceneDocument = serde_json::from_value(definition["scene"].clone()).map_err(|e| invalid(e.to_string()))?;
    if workspace["scene_revision"].as_u64() != Some(scene.revision) {
        return Err(invalid("source scene revision differs".into()));
    }
    // A historical definition is immutable accepted input, not a reconstruction
    // of the former live authored document. Preserve both identities explicitly.
    let projection = AcceptedDefinitionProjection {
        schema_version: "accepted_definition_readonly_projection.v1".into(),
        project_id: project.as_str().into(), run_id: run.as_str().into(),
        definition_sha256: specification.snapshot.definition_sha256.clone(),
        projection_sha256: fullmag_session::canonical_json_sha256(&serde_json::to_value(&scene)
            .map_err(|e| invalid(e.to_string()))?),
        authored_execution_input: workspace.get("execution_input").cloned().unwrap_or(serde_json::Value::Null),
    };
    let script = accepted_captured_script(&store, &accepted)?;
    // Require a genuine typed antenna inspection, with the same durable cold
    // gate used by accepted HTTP reads. No new Solve is submitted for export.
    let mut inspections = 0;
    for step in &accepted.study.steps {
        if !step.enabled || !matches!(step.kind, fullmag_authoring::StudyStepKind::ClosedLoopInspection { .. }) { continue; }
        let task_id = fullmag_session::task_id_for_study_step(run.as_str(), &step.step_id).map_err(|e| invalid(e.to_string()))?;
        let task = catalog.tasks.iter().find(|task| task.task_id == task_id).ok_or_else(|| invalid("inspection task absent".into()))?;
        let attempt = task.attempt_id.as_deref().ok_or_else(|| invalid("inspection attempt absent".into()))?;
        let ownership_epoch = task.ownership_epoch.ok_or_else(|| invalid("inspection epoch absent".into()))?;
        let outputs = artifacts.entries.iter().filter(|entry| entry.task_id == task_id && entry.attempt_id == attempt
            && entry.ownership_epoch == ownership_epoch && entry.artifact_type == "artifact" && entry.study_output.is_some()).collect::<Vec<_>>();
        if outputs.len() != 1 { return Err(invalid("inspection output absent or ambiguous".into())); }
        let object = outputs[0].object_ref.as_deref().ok_or_else(|| invalid("inspection CAS absent".into()))?;
        fullmag_runtime_control::verify_saved_inspection(&store, &project, &run, &task_id, attempt, ownership_epoch, object)
            .map_err(historical_export_error)?;
        inspections += 1;
    }
    if inspections == 0 { return Err(invalid("historical source has no typed closed-loop inspection".into())); }
    let request: crate::types::CurrentLiveSnapshotRequest = serde_json::from_value(serde_json::json!({
        "session_id":session_id,"session_status":"completed"
    })).map_err(|e| invalid(e.to_string()))?;
    let mut snapshot = crate::default_current_live_state(&request);
    let requested = &specification.requested_execution;
    snapshot.session.run_id = run.as_str().into();
    snapshot.session.problem_name = scene.scene.name.clone();
    snapshot.session.requested_backend = requested.backend.clone();
    snapshot.session.authored_requested_device = requested.device.clone();
    snapshot.session.requested_device = requested.device.clone();
    snapshot.session.requested_precision = requested.precision.clone();
    snapshot.session.precision = requested.precision.clone();
    snapshot.session.requested_mode = requested.mode.clone();
    snapshot.session.execution_mode = requested.mode.clone();
    snapshot.session.plan_summary = serde_json::json!({"requested_execution":requested,
        "historical_export":true,"resolved_execution_source":"accepted_preparation_and_output"});
    snapshot.run = Some(crate::types::RunManifest { run_id:run.as_str().into(),session_id:session_id.into(),
        status:"completed".into(),total_steps:0,final_time:None,final_e_ex:None,final_e_demag:None,
        final_e_ext:None,final_e_ani:None,final_e_dmi:None,final_e_rotated_dmi:None,final_e_total:None,artifact_dir:String::new() });
    snapshot.scene_document = Some(scene);
    snapshot.metadata = Some(serde_json::json!({"accepted_definition_projection":projection,"historical_export":{
        "run_id":source.run_id,"project_id":source.project_id,"session_epoch":epoch,
        "run_catalog_revision":source.run_catalog_revision,"artifact_catalog_revision":source.artifact_catalog_revision
    }}).into());
    Ok((snapshot, epoch, script))
}

fn historical_project_documents(snapshot: &SessionStateResponse, script: Vec<u8>) -> Result<HashMap<String, Vec<u8>>, ApiError> {
    let mut documents = HashMap::new();
    let mut persisted = PersistedCurrentLiveSnapshot::from(snapshot);
    persisted.display_presentation_schema_version = Some(DISPLAY_PRESENTATION_SCHEMA_VERSION);
    persisted.display_presentation = persisted_display_presentation(&DisplayPresentationState::default())
        .map_err(|e| ApiError::internal(e.to_string()))?;
    documents.insert("main.py".into(), script);
    documents.insert("ui_state.json".into(), b"{}".to_vec());
    documents.insert("scene_document.json".into(), serde_json::to_vec_pretty(&snapshot.scene_document)
        .map_err(|e| ApiError::internal(e.to_string()))?);
    documents.insert("current_live_snapshot.json".into(), serde_json::to_vec_pretty(&persisted)
        .map_err(|e| ApiError::internal(e.to_string()))?);
    Ok(documents)
}

fn accepted_export_capture(
    state: &AppState,
    snapshot: &SessionStateResponse,
    profile: &FmsExportProfile,
) -> Result<Option<AcceptedExportCapture>, ApiError> {
    accepted_export_capture_at_epoch(state, snapshot, profile,
        state.current_live_session_epoch.load(std::sync::atomic::Ordering::Acquire))
}

fn accepted_export_capture_at_epoch(
    state: &AppState, snapshot: &SessionStateResponse, profile: &FmsExportProfile, session_epoch: u64,
) -> Result<Option<AcceptedExportCapture>, ApiError> {
    if snapshot.runtime_status.code == "imported_read_only" {
        return Err(ApiError::conflict(
            "imported_read_only: accepted session export is unavailable",
        ));
    }
    let declared_run_id = declared_accepted_run_id(snapshot)?;
    let Some(run) = snapshot.run.as_ref() else {
        if declared_run_id.is_some() {
            return Err(ApiError::conflict(
                "accepted export marker has no current accepted run",
            ));
        }
        return Ok(None);
    };
    if run.run_id != snapshot.session.run_id {
        return Err(ApiError::conflict(
            "accepted export run differs from the current session run",
        ));
    }
    if declared_run_id
        .as_deref()
        .is_some_and(|declared| declared != run.run_id)
    {
        return Err(ApiError::conflict(
            "accepted export marker differs from the current run",
        ));
    }

    let Some(accepted_root) = state.submit_store_root.clone() else {
        if declared_run_id.is_some() {
            return Err(ApiError::with_status_and_code(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "accepted_export_store_unavailable",
                "accepted export requires the configured durable run store",
            ));
        }
        return Ok(None);
    };
    let accepted_store = match SessionStore::open_existing(&accepted_root) {
        Ok(store) => store,
        Err(_error) if declared_run_id.is_none() => return Ok(None),
        Err(error) => {
            return Err(ApiError::conflict(format!(
                "accepted export store cannot be opened: {error}"
            )));
        }
    };
    let intent = accepted_store
        .read_run_intent(&run.run_id)
        .map_err(|error| ApiError::conflict(format!("accepted export RunIntent read failed: {error}")))?;
    let Some(intent) = intent else {
        if declared_run_id.is_some() {
            return Err(ApiError::conflict(
                "accepted export marker has no durable RunIntent",
            ));
        }
        return Ok(None);
    };
    if intent.run_id != run.run_id {
        return Err(ApiError::conflict(
            "accepted export RunIntent identity differs from the current run",
        ));
    }

    let scene_revision = snapshot
        .scene_document
        .as_ref()
        .map(|scene| scene.revision)
        .ok_or_else(|| ApiError::conflict("accepted export has no persisted scene revision"))?;
    if session_epoch == 0 {
        return Err(ApiError::conflict(
            "accepted export has no positive live session epoch",
        ));
    }
    let bare_binding = fullmag_runtime_control::accepted_store::store_binding(&accepted_root)
        .ok_or_else(|| ApiError::conflict("accepted export store has no stable binding"))?;
    let context = AcceptedProvenanceContext {
        source_store_binding: format!("sha256:{bare_binding}"),
        accepted_run_id: run.run_id.clone(),
        captured_live_session_id: snapshot.session.session_id.clone(),
        captured_live_session_epoch: session_epoch,
        captured_scene_revision: scene_revision.to_string(),
    };
    let full_plan = plan_accepted_provenance(&accepted_root, &context).map_err(|error| {
        ApiError::conflict(format!("accepted export closure is incomplete or invalid: {error}"))
    })?;
    let full_provenance_manifest = full_plan.manifest.clone();
    let plan = accepted_plan_for_profile(full_plan, &context, profile.include_artifacts())
        .map_err(|error| {
            ApiError::conflict(format!("accepted export closure profile is invalid: {error}"))
        })?;
    let run_status = accepted_fms_run_status(&run.status)?;
    let now = chrono::Utc::now();
    let run_manifest = FmsRunManifest {
        run_id: run.run_id.clone(),
        status: run_status,
        study_kind: "accepted_study".into(),
        backend: snapshot
            .session
            .resolved_backend
            .clone()
            .unwrap_or_else(|| snapshot.session.requested_backend.clone()),
        precision: snapshot
            .session
            .resolved_precision
            .clone()
            .unwrap_or_else(|| snapshot.session.precision.clone()),
        started_at: now,
        finished_at: matches!(run_status, fullmag_session::RunStatus::Completed).then_some(now),
        total_steps: run.total_steps as u64,
        total_time_s: snapshot
            .live_state
            .as_ref()
            .map(|live| live.latest_step.time)
            .unwrap_or(0.0),
        plan_ref: None,
        live_state_ref: None,
        latest_checkpoint_ref: None,
        artifact_index_ref: None,
    };
    Ok(Some(AcceptedExportCapture {
        identity: AcceptedExportIdentity {
            session_id: snapshot.session.session_id.clone(),
            run_id: run.run_id.clone(),
            session_epoch,
            scene_revision,
        },
        full_provenance_manifest,
        run_manifest,
        provenance: plan,
    }))
}

fn validate_accepted_export_capture(
    state: &AppState,
    snapshot: &SessionStateResponse,
    capture: &AcceptedExportCapture,
    profile: &FmsExportProfile,
    epoch: u64,
) -> Result<AcceptedProvenancePlan, ApiError> {
    if epoch != capture.identity.session_epoch
        || snapshot.session.session_id != capture.identity.session_id
        || snapshot
            .run
            .as_ref()
            .map(|run| run.run_id.as_str())
            != Some(capture.identity.run_id.as_str())
        || snapshot.session.run_id != capture.identity.run_id
        || snapshot
            .scene_document
            .as_ref()
            .map(|scene| scene.revision)
            != Some(capture.identity.scene_revision)
    {
        return Err(ApiError::conflict(
            "accepted export context changed during archive preparation",
        ));
    }
    if declared_accepted_run_id(snapshot)?.as_deref()
        .is_some_and(|run_id| run_id != capture.identity.run_id)
    {
        return Err(ApiError::conflict(
            "accepted export marker changed during archive preparation",
        ));
    }
    let root = state.submit_store_root.as_ref().ok_or_else(|| {
        ApiError::conflict("accepted export store disappeared during archive preparation")
    })?;
    let bare_binding = fullmag_runtime_control::accepted_store::store_binding(root)
        .ok_or_else(|| ApiError::conflict("accepted export store has no stable binding"))?;
    let source_store_binding = format!("sha256:{bare_binding}");
    if capture.full_provenance_manifest.source_store_binding != source_store_binding {
        return Err(ApiError::conflict(
            "accepted export store binding changed during archive preparation",
        ));
    }
    let context = AcceptedProvenanceContext {
        source_store_binding,
        accepted_run_id: capture.identity.run_id.clone(),
        captured_live_session_id: capture.identity.session_id.clone(),
        captured_live_session_epoch: capture.identity.session_epoch,
        captured_scene_revision: capture.identity.scene_revision.to_string(),
    };
    let full_plan = plan_accepted_provenance(root, &context).map_err(|error| {
        ApiError::conflict(format!(
            "accepted export closure changed during archive preparation: {error}"
        ))
    })?;
    if full_plan.manifest != capture.full_provenance_manifest {
        return Err(ApiError::conflict(
            "accepted export closure changed during archive preparation",
        ));
    }
    let refreshed = accepted_plan_for_profile(full_plan, &context, profile.include_artifacts())
        .map_err(|error| {
            ApiError::conflict(format!(
                "accepted export closure profile changed during archive preparation: {error}"
            ))
        })?;
    if refreshed.manifest != capture.provenance.manifest {
        return Err(ApiError::conflict(
            "accepted export profile closure changed during archive preparation",
        ));
    }
    refreshed.verify_sources().map_err(|error| {
        ApiError::conflict(format!(
            "accepted export closure changed during archive preparation: {error}"
        ))
    })?;
    Ok(refreshed)
}

fn validate_imported_definition_projection(
    preflight: &FmsStagedPreflight, persisted: &PersistedCurrentLiveSnapshot, manifest: &AcceptedProvenanceManifest,
) -> Result<(), ApiError> {
    let Some(value) = persisted.metadata.as_ref().and_then(|metadata| metadata.get("accepted_definition_projection")) else {
        return Ok(());
    };
    let invalid = |message: String| ApiError::bad_request(format!("invalid_fms_definition_projection: {message}"));
    let projection: AcceptedDefinitionProjection = serde_json::from_value(value.clone()).map_err(|e| invalid(e.to_string()))?;
    if projection.schema_version != "accepted_definition_readonly_projection.v1" || projection.run_id != manifest.accepted_run_id {
        return Err(invalid("projection schema or run differs".into()));
    }
    let intents = manifest.records.iter().filter(|record| record.kind == AcceptedProvenanceRecordKind::RunIntent).collect::<Vec<_>>();
    if intents.len() != 1 { return Err(invalid("one immutable RunIntent is required".into())); }
    let record = intents[0];
    let bytes = preflight.read_document(&record.archive_path).map_err(|e| invalid(e.to_string()))?;
    if bytes.len() as u64 != record.byte_count || fullmag_session::hex_sha256(&bytes) != record.content_sha256 {
        return Err(invalid("RunIntent differs from portable closure".into()));
    }
    let intent: fullmag_session::FmsRunIntent = serde_json::from_slice(&bytes).map_err(|e| invalid(e.to_string()))?;
    intent.validate().map_err(|e| invalid(e.to_string()))?;
    let specification: fullmag_application::RunSpecification = serde_json::from_value(intent.specification.clone())
        .map_err(|e| invalid(e.to_string()))?;
    if specification.fingerprint().map_err(|e| invalid(e.to_string()))? != intent.payload_sha256
        || specification.run_id.as_str() != projection.run_id || specification.snapshot.project_id.as_str() != projection.project_id
        || specification.snapshot.definition_sha256 != projection.definition_sha256
        || intent.definition_object_ref.as_deref() != Some(projection.definition_sha256.as_str())
        || specification.parameters["live_workspace"].get("execution_input").cloned().unwrap_or(serde_json::Value::Null) != projection.authored_execution_input {
        return Err(invalid("projection differs from immutable run/source identity".into()));
    }
    let bytes = preflight.read_document(&format!("objects/sha256/{}", projection.definition_sha256)).map_err(|e| invalid(e.to_string()))?;
    if fullmag_session::hex_sha256(&bytes) != projection.definition_sha256 {
        return Err(invalid("definition CAS digest differs".into()));
    }
    let definition: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| invalid(e.to_string()))?;
    let expected: fullmag_authoring::SceneDocument = serde_json::from_value(definition["scene"].clone()).map_err(|e| invalid(e.to_string()))?;
    let projected = persisted.scene_document.as_ref().ok_or_else(|| invalid("projected scene absent".into()))?;
    let hash = |scene: &fullmag_authoring::SceneDocument| -> Result<String, serde_json::Error> {
        Ok(fullmag_session::canonical_json_sha256(&serde_json::to_value(scene)?))
    };
    if hash(&expected).map_err(|e| invalid(e.to_string()))? != projection.projection_sha256
        || hash(projected).map_err(|e| invalid(e.to_string()))? != projection.projection_sha256 {
        return Err(invalid("readonly scene is not the pinned accepted definition projection".into()));
    }
    Ok(())
}

fn validate_imported_accepted_provenance(
    preflight: &FmsStagedPreflight,
    persisted: &PersistedCurrentLiveSnapshot,
) -> Result<(), ApiError> {
    let Some(reference) = preflight.session.accepted_provenance_ref.as_ref() else {
        if persisted.metadata.as_ref().is_some_and(|metadata| metadata.get("accepted_definition_projection").is_some()) {
            return Err(ApiError::bad_request("invalid_fms_definition_projection: portable accepted closure absent"));
        }
        return Ok(());
    };
    let manifest_bytes = preflight
        .read_document(&reference.manifest_ref)
        .map_err(|error| {
            ApiError::bad_request(format!(
                "invalid_fms_accepted_provenance: manifest cannot be read: {error}"
            ))
        })?;
    let manifest: AcceptedProvenanceManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| {
            ApiError::bad_request(format!(
                "invalid_fms_accepted_provenance: manifest is invalid: {error}"
            ))
        })?;
    manifest.validate().map_err(|error| {
        ApiError::bad_request(format!(
            "invalid_fms_accepted_provenance: manifest validation failed: {error}"
        ))
    })?;
    if manifest.accepted_run_id != reference.accepted_run_id
        || manifest.closure_sha256 != reference.closure_sha256
    {
        return Err(ApiError::bad_request(
            "invalid_fms_accepted_provenance: manifest reference does not match closure",
        ));
    }
    if manifest.accepted_run_id != persisted.session.run_id
        || persisted
            .run
            .as_ref()
            .map(|run| run.run_id.as_str())
            != Some(manifest.accepted_run_id.as_str())
    {
        return Err(ApiError::bad_request(
            "invalid_fms_accepted_provenance: accepted run does not match persisted snapshot",
        ));
    }
    if manifest.captured_live_session_id != persisted.session.session_id {
        return Err(ApiError::bad_request(
            "invalid_fms_accepted_provenance: captured session does not match persisted snapshot",
        ));
    }
    let scene_revision = persisted
        .scene_document
        .as_ref()
        .map(|scene| scene.revision)
        .ok_or_else(|| {
            ApiError::bad_request(
                "invalid_fms_accepted_provenance: persisted snapshot has no scene revision",
            )
        })?;
    if manifest.captured_scene_revision != scene_revision.to_string() {
        return Err(ApiError::bad_request(
            "invalid_fms_accepted_provenance: captured scene revision does not match persisted snapshot",
        ));
    }

    validate_imported_definition_projection(preflight, persisted, &manifest)?;

    // The startup metadata is an optional duplicate marker. If present, it is
    // part of the same binding and must not silently disagree with the typed
    // run/scene identity above.
    let snapshot: SessionStateResponse = persisted.clone().into();
    if let Some(marked_run_id) = declared_accepted_run_id(&snapshot)? {
        if marked_run_id != manifest.accepted_run_id {
            return Err(ApiError::bad_request(
                "invalid_fms_accepted_provenance: accepted marker does not match closure",
            ));
        }
    }
    if let Some(startup) = snapshot
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("docker_startup"))
    {
        if let Some(marked_scene_revision) = startup.get("scene_revision") {
            if marked_scene_revision.as_u64() != Some(scene_revision) {
                return Err(ApiError::bad_request(
                    "invalid_fms_accepted_provenance: startup scene revision does not match closure",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod accepted_fms_persistence_tests {
    use super::*;
    use axum::extract::State;
    use base64::Engine;
    use std::io::{Cursor, Read, Write};
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use zip::write::SimpleFileOptions;

    fn scene(revision: u64) -> fullmag_authoring::SceneDocument {
        serde_json::from_value(serde_json::json!({
            "version": "scene.v2",
            "revision": revision,
            "objects": [{
                "id": "strip",
                "name": "strip",
                "role": "magnet",
                "geometry": {
                    "geometry_kind": "Box",
                    "geometry_params": {"size": [200e-9, 20e-9, 6e-9]}
                },
                "material_ref": "permalloy",
                "magnetization_ref": "uniform",
                "regions": [{
                    "region_id": "strip:core",
                    "owner_object": "strip",
                    "name": "core",
                    "shape": {"kind": "box", "size": [200e-9, 20e-9, 6e-9], "center": [0.0, 0.0, 0.0]},
                    "frame": "object",
                    "enabled": true,
                    "priority": 1,
                    "realization_policy": "inherit"
                }]
            }],
            "materials": [{
                "id": "permalloy",
                "name": "Permalloy",
                "properties": {"Ms": 800e3, "Aex": 13e-12, "alpha": 0.02}
            }],
            "magnetization_assets": [{
                "id": "uniform",
                "name": "Uniform",
                "kind": "uniform",
                "value": [0.0, 0.0, 1.0]
            }],
            "study": {
                "backend": "fdm",
                "requested_backend": "fdm",
                "requested_device": "cpu",
                "requested_precision": "double",
                "requested_mode": "strict",
                "fdm": {"default_cell": [10e-9, 10e-9, 6e-9]}
            }
        }))
        .expect("accepted FMS scene fixture should deserialize")
    }

    fn rewrite_member(bytes: &[u8], target: &str, replacement: Option<Vec<u8>>) -> Vec<u8> {
        let mut source = zip::ZipArchive::new(Cursor::new(bytes)).expect("valid FMS ZIP");
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let mut found = false;
        for index in 0..source.len() {
            let mut member = source.by_index(index).expect("ZIP member");
            let name = member.name().to_string();
            let mut data = Vec::new();
            member.read_to_end(&mut data).expect("read ZIP member");
            drop(member);
            if name == target {
                found = true;
                let Some(replacement) = replacement.as_ref() else {
                    continue;
                };
                data = replacement.clone();
            }
            writer.start_file(name, options).expect("write ZIP member");
            writer.write_all(&data).expect("write ZIP payload");
        }
        assert!(found, "test fixture must contain {target}");
        writer.finish().expect("finish rewritten ZIP").into_inner()
    }

    async fn destination_state(root: &std::path::Path) -> Arc<AppState> {
        let mut state = crate::router_v2::tests::test_app_state_with_live_session().await;
        let state_mut = Arc::get_mut(&mut state).expect("test state has one owner");
        state_mut.repo_root = root.to_path_buf();
        state_mut.current_workspace_root = root.to_path_buf();
        state_mut.submit_store_root = Some(root.join("accepted-store-unused"));
        state_mut.current_command_journal_store_root = Some(root.join("live-store"));
        let script = root.join("import.py");
        std::fs::write(&script, b"study = fullmag.Study()\n").expect("import script");
        drop(state_mut);
        if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
            snapshot.session.script_path = script.display().to_string();
        }
        state
    }

    fn captured_export_source_fixture(store: &SessionStore) -> (serde_json::Value, Vec<u8>) {
        let script = b"# Exact admitted bytes, including CRLF.\r\nimport fullmag\r\nstudy = fullmag.Study()\r\n".to_vec();
        let digest = store.cas().put(&script).expect("captured Python entry CAS");
        let helper = b"HELPER = True\n";
        let helper_digest = store.cas().put(helper).expect("captured helper CAS");
        let source = serde_json::json!({"capture":{"entry_relative_path":"source/scenario.py", "records":[
            {"relative_path":"source/helper.py", "role":"source", "sha256":helper_digest, "byte_count":helper.len()},
            {"relative_path":"source/scenario.py", "role":"source", "sha256":digest, "byte_count":script.len()}
        ]}});
        (source, script)
    }

    #[test]
    fn accepted_export_preserves_exact_bytes_and_selects_declared_capture_entry() {
        let root = tempfile::tempdir().expect("capture root");
        let store = SessionStore::open(root.path()).expect("capture store");
        let (source, script) = captured_export_source_fixture(&store);
        assert_eq!(read_captured_export_script(&store, &source).expect("captured export source"), script);
        let mut missing = source.clone();
        missing["capture"]["entry_relative_path"] = serde_json::json!("source/missing.py");
        assert!(read_captured_export_script(&store, &missing).is_err());
        let mut duplicate = source.clone();
        let entry = duplicate["capture"]["records"][1].clone();
        duplicate["capture"]["records"].as_array_mut().unwrap().push(entry);
        assert!(read_captured_export_script(&store, &duplicate).is_err());
        let mut runtime_entry = source;
        runtime_entry["capture"]["records"][1]["role"] = serde_json::json!("runtime");
        assert!(read_captured_export_script(&store, &runtime_entry).is_err());
    }

    #[test]
    fn accepted_export_refuses_missing_changed_or_oversized_captured_entry() {
        let root = tempfile::tempdir().expect("capture root");
        let store = SessionStore::open(root.path()).expect("capture store");
        let (source, _) = captured_export_source_fixture(&store);
        for (field, value) in [
            ("sha256", serde_json::json!("f".repeat(64))),
            ("byte_count", serde_json::json!(1)),
            ("byte_count", serde_json::json!(0)),
            ("byte_count", serde_json::json!(MAX_RETIREMENT_SCRIPT_BYTES + 1)),
        ] {
            let mut changed = source.clone();
            changed["capture"]["records"][1][field] = value;
            assert!(read_captured_export_script(&store, &changed).is_err(), "accepted changed {field}");
        }
    }

    #[tokio::test]
    async fn accepted_v4_export_resolves_ui_source_without_a_filesystem_script_and_fences_input() {
        use fullmag_application::{ProjectId, RunId, RunIntentAuthoring};
        use fullmag_application::script_stage_contract::{ScriptExecutionConfig, ScriptExecutionStage};
        let root = tempfile::tempdir().expect("accepted UI export root");
        let accepted_root = root.path().join("accepted-store");
        let store = SessionStore::open(&accepted_root).expect("accepted store");
        let admitted = b"# Immutable UI source\r\nimport fullmag\r\nstudy = fullmag.Study()\r\n";
        // Reuse the canonical compiler's capture contract, including its pinned runtime inventory.
        let files = [("source/main.py", "source", admitted.as_slice()),
            ("fullmag/__init__.py", "runtime", b"fullmag".as_slice()),
            ("interpreter/python", "runtime", b"python".as_slice())];
        let records = files.iter().map(|(path, role, bytes)| serde_json::json!({
            "relative_path":path, "asset_id":format!("script-file-{}", fullmag_session::hex_sha256(path.as_bytes())),
            "sha256":fullmag_session::hex_sha256(bytes), "byte_count":bytes.len(), "role":role
        })).collect::<Vec<_>>();
        let fullmag_inventory = serde_json::json!([{"relative_path":"fullmag/__init__.py",
            "sha256":fullmag_session::hex_sha256(b"fullmag"), "byte_count":7}]);
        let capture = serde_json::json!({"schema_version":"fullmag.script-source-capture.v1",
            "entry_relative_path":"source/main.py", "records":records,
            "runtime":{"python_version":"3.10.12", "implementation":"cpython", "numpy_version":null,
                "executable_sha256":fullmag_session::hex_sha256(b"python"),
                "fullmag_source_tree_sha256":fullmag_ir::canonical_ir_json_sha256(&fullmag_inventory).unwrap(),
                "fullmag_version_binding":"source_tree_only", "capture_policy":"trusted_readonly_dsl_observed_io.v1",
                "native_io_completeness":"NOT_VERIFIED", "source_bytes":admitted.len(), "runtime_bytes":13},
            "observed_reads":["source/main.py"], "inventory_sha256":"a".repeat(64)});
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.problem_meta.runtime_metadata.insert("active_stage_id".into(), serde_json::json!("first"));
        let config = ScriptExecutionConfig { ir:problem.clone(), antenna_inventory:Default::default(),
            shared_geometry_assets:None, default_until_seconds:Some(1e-12),
            study_pipeline:Some(serde_json::from_value(serde_json::json!({"version":"study_pipeline.v1", "nodes":[
                {"node_kind":"primitive", "id":"first", "label":"First", "stage_kind":"run", "payload":{"until_seconds":1e-12}}
            ]})).unwrap()),
            stages:vec![ScriptExecutionStage {ir:problem, default_until_seconds:Some(1e-12), entrypoint_kind:"flat_run".into(), action:None}] };
        let profile = fullmag_ir::ExecutionProfileIR {profile_id:"physical".into(), version:"v1".into(),
            defaults:fullmag_ir::ExecutionRequestPatchIR {
                backend:fullmag_ir::FieldPatch::Value(fullmag_ir::BackendTarget::Fdm),
                device:fullmag_ir::FieldPatch::Value(fullmag_ir::ExecutionDevice::Cpu),
                precision:fullmag_ir::FieldPatch::Value(fullmag_ir::ExecutionPrecision::Double),
                mode:fullmag_ir::FieldPatch::Value(fullmag_ir::ExecutionMode::Strict), ..Default::default()}, ..Default::default()};
        let compiled = fullmag_application::compile_accepted_closed_loop_pipeline(config, "export-study".into(), 17,
            fullmag_authoring::StudyExecutionProfileReference {profile_id:profile.profile_id.clone(), version:profile.version.clone()},
            vec![], capture, |_,_| Ok(profile.clone()), fullmag_ir::configure_project_autosave_policy).expect("canonical v4 compilation");
        let authored_scene = scene(17);
        let mut definition = fullmag_application::ProjectEnvelope::blank(ProjectId::parse("project-ui-export").unwrap(), "UI export").unwrap();
        definition.replace_scene(fullmag_application::RawJsonEnvelope::from_value(serde_json::to_value(&authored_scene).unwrap()).unwrap()).unwrap();
        definition.definition.revision = 17;
        definition.rewrite_known_fields().unwrap();
        let mut paths = BTreeMap::new();
        for (path, _, bytes) in &files {
            let asset_id = format!("script-file-{}", fullmag_session::hex_sha256(path.as_bytes()));
            let asset_path = format!("project/assets/accepted-script/files/{path}");
            definition.assets.push(fullmag_application::OpaqueAsset::new(&asset_path, bytes.to_vec(), None).unwrap());
            paths.insert(asset_id, asset_path);
        }
        let pipeline_path = "project/assets/accepted-script/pipeline-source.json";
        definition.assets.push(fullmag_application::OpaqueAsset::new(pipeline_path, compiled.source_bytes.clone(), None).unwrap());
        paths.insert(compiled.source_reference.asset_id.clone(), pipeline_path.into());
        let resources = fullmag_ir::ComputeResourcesIR::from_problem(compiled.catalog.entries()[0].problem())
            .expect("compiled compute resources").expect("canonical profile declares compute resources");
        let threads = match resources.parallelism {
            fullmag_ir::ComputeParallelismIR::SingleProcess => resources.cpu.threads.count().unwrap_or(1) as u64,
            fullmag_ir::ComputeParallelismIR::Distributed {ranks, threads_per_rank, ..} => u64::from(ranks) * u64::from(threads_per_rank),
        };
        let minimum_resources = fullmag_application::RequestedResourceBudget {
            cpu_millis:threads.checked_mul(1_000).expect("fixture CPU reservation"),
            memory_bytes:resources.ram.reservation_bytes.unwrap_or(1),
            storage_bytes:resources.scratch.reservation_bytes.unwrap_or(1), gpu_memory_bytes:0,
        };
        let authored = RunIntentAuthoring {run_id:RunId::parse("run-ui-export").unwrap(), idempotency_key:"intent-ui-export".into(),
            parameters:serde_json::json!({"live_workspace":{"scene_revision":17,
                "execution_input":crate::live_execution_binding::input_identity(&authored_scene).unwrap()}}),
            seeds:BTreeMap::new(), dependencies:Vec::new(), scheduling_priority:0,
            requested_execution:fullmag_application::RequestedExecution {backend:"fdm".into(), device:"cpu".into(),
                precision:"double".into(), mode:"strict".into(), minimum_resources:Some(minimum_resources)}};
        let intent = fullmag_application::materialize_run_intent(&definition, &compiled.study, &compiled.catalog, authored, &paths)
            .expect("canonical immutable RunSpec");
        let mut persisted = fullmag_session::FmsRunIntent::new("run-ui-export", "intent-ui-export", serde_json::to_value(&intent.specification).unwrap());
        persisted.definition_object_ref = Some(store.cas().put(definition.raw_definition.raw_bytes()).unwrap());
        persisted.study_object_ref = Some(store.cas().put(&serde_json::to_vec(&serde_json::to_value(&compiled.study).unwrap()).unwrap()).unwrap());
        persisted.study_catalog_object_ref = Some(store.cas().put(&serde_json::to_vec(&serde_json::to_value(&compiled.catalog).unwrap()).unwrap()).unwrap());
        assert_eq!(persisted.study_object_ref.as_deref(), Some(intent.specification.study.plan_sha256.as_str()));
        assert_eq!(persisted.study_catalog_object_ref.as_deref(), Some(intent.specification.study_catalog_sha256.as_str()));
        for asset in &intent.specification.immutable_assets {
            let project_asset = definition.assets.iter().find(|candidate| candidate.path() == paths[&asset.asset_id].as_str()).unwrap();
            persisted.asset_object_refs.insert(asset.asset_id.clone(), store.cas().put(project_asset.bytes()).unwrap());
        }
        store.commit_run_intent(&persisted).unwrap();
        store.commit_run_catalog(&fullmag_session::FmsRunCatalog {schema_version:fullmag_session::FMS_RUN_CATALOG_SCHEMA.into(),
            run_id:"run-ui-export".into(), revision:1, updated_at:chrono::Utc::now(), tasks:Vec::new()}).unwrap();
        drop(store);
        let mut state = destination_state(root.path()).await;
        Arc::get_mut(&mut state).unwrap().submit_store_root = Some(accepted_root);
        state.current_live_session_epoch.store(7, Ordering::Release);
        {
            let mut current = state.current_live_state.write().await;
            let snapshot = current.as_mut().unwrap();
            snapshot.session.run_id = "run-ui-export".into();
            snapshot.session.script_path.clear();
            snapshot.scene_document = Some(authored_scene);
            snapshot.metadata = Some(serde_json::json!({"docker_startup":{"run_id":"run-ui-export", "scene_revision":17}}).into());
            snapshot.run = Some(crate::types::RunManifest {run_id:"run-ui-export".into(), session_id:snapshot.session.session_id.clone(),
                status:"completed".into(), total_steps:0, final_time:None, final_e_ex:None, final_e_demag:None, final_e_ext:None,
                final_e_ani:None, final_e_dmi:None, final_e_rotated_dmi:None, final_e_total:None, artifact_dir:String::new()});
        }
        let capture = accepted_export_capture(&state, state.current_live_state.read().await.as_ref().unwrap(),
            &FmsExportProfile::for_profile(SaveProfile::Solved)).unwrap().unwrap();
        assert_eq!(read_canonical_script(&state, Some(&capture)).await.unwrap().as_slice(), admitted.as_slice());
        let decoy = root.path().join("decoy.py");
        std::fs::write(&decoy, b"raise RuntimeError('filesystem source must not win')\n").unwrap();
        state.current_live_state.write().await.as_mut().unwrap().session.script_path = decoy.display().to_string();
        assert_eq!(read_canonical_script(&state, Some(&capture)).await.unwrap().as_slice(), admitted.as_slice());
        state.current_live_state.write().await.as_mut().unwrap().scene_document.as_mut().unwrap().study.requested_device = "gpu".into();
        let error = read_canonical_script(&state, Some(&capture)).await.expect_err("changed authored input must reject");
        assert_eq!(error.code.as_deref(), Some("accepted_execution_input_mismatch"));
    }

    #[tokio::test]
    async fn missing_nonaccepted_script_still_fails_without_generated_fallback() {
        let root = tempfile::tempdir().expect("legacy root");
        let state = destination_state(root.path()).await;
        state.current_live_state.write().await.as_mut().unwrap().session.script_path.clear();
        let error = read_canonical_script(&state, None).await.expect_err("empty legacy script path");
        assert_eq!(error.status, axum::http::StatusCode::UNPROCESSABLE_ENTITY);
        assert!(error.message.contains("invalid_script"));
    }

    #[tokio::test]
    async fn accepted_fms_export_inspect_readonly_import_and_tamper_rejection() {
        let source_root = tempfile::tempdir().expect("source temp root");
        let accepted_root = source_root.path().join("accepted-store");
        let live_root = source_root.path().join("live-store");
        let script = source_root.path().join("scene.py");
        std::fs::write(&script, b"study = fullmag.Study()\n").expect("source script");

        let run_id = "run-accepted-fms";
        let accepted_store = SessionStore::open(&accepted_root).expect("accepted store");
        let intent = fullmag_session::FmsRunIntent::new(
            run_id,
            "intent-accepted-fms",
            serde_json::json!({"run_id": run_id, "solver": "fixture"}),
        );
        accepted_store
            .commit_run_intent(&intent)
            .expect("accepted intent");
        accepted_store
            .commit_run_catalog(&fullmag_session::FmsRunCatalog {
                schema_version: fullmag_session::FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: chrono::Utc::now(),
                tasks: Vec::new(),
            })
            .expect("accepted catalog");
        drop(accepted_store);

        let mut state = crate::router_v2::tests::test_app_state_with_live_session().await;
        let state_mut = Arc::get_mut(&mut state).expect("source state has one owner");
        state_mut.repo_root = source_root.path().to_path_buf();
        state_mut.current_workspace_root = source_root.path().to_path_buf();
        state_mut.submit_store_root = Some(accepted_root);
        state_mut.current_command_journal_store_root = Some(live_root);
        state_mut
            .current_live_session_epoch
            .store(7, Ordering::Release);
        drop(state_mut);
        {
            let mut current = state.current_live_state.write().await;
            let snapshot = current.as_mut().expect("live state fixture");
            snapshot.session.run_id = run_id.into();
            snapshot.session.script_path = script.display().to_string();
            snapshot.run = Some(crate::types::RunManifest {
                run_id: run_id.into(),
                session_id: snapshot.session.session_id.clone(),
                status: "completed".into(),
                total_steps: 0,
                final_time: None,
                final_e_ex: None,
                final_e_demag: None,
                final_e_ext: None,
                final_e_ani: None,
                final_e_dmi: None,
                final_e_rotated_dmi: None,
                final_e_total: None,
                artifact_dir: source_root.path().join("legacy-artifacts").display().to_string(),
            });
            snapshot.scene_document = Some(scene(17));
            snapshot.metadata = Some(serde_json::json!({
                "docker_startup": {"run_id": run_id, "scene_revision": 17}
            }).into());
        }

        let exported = export_session_with_context(
            State(state.clone()),
            Json(SessionExportRequest {
                profile: SaveProfile::Compact,
                name: Some("accepted FMS fixture".into()),
                compression: Some(fullmag_session::CompressionProfile::Speed),
                ui_state: None,
                target_path: None,
                save_to_source: None,
                accepted_run: None,
            }),
            None,
        )
        .await
        .expect("accepted export")
        .0;
        let fms_bytes = base64::engine::general_purpose::STANDARD
            .decode(exported.fms_base64)
            .expect("exported FMS base64");

        let destination_root = tempfile::tempdir().expect("destination temp root");
        let destination = destination_state(destination_root.path()).await;
        let inspection = import_session_inspect(
            State(destination.clone()),
            Json(SessionImportInspectRequest {
                fms_base64: base64::engine::general_purpose::STANDARD.encode(&fms_bytes),
            }),
        )
        .await
        .expect("accepted archive inspection")
        .0;
        assert_eq!(inspection.inspection.format_version, fullmag_session::FMS_SESSION_FORMAT_V2);
        assert_eq!(inspection.inspection.session_id, "test-session");

        let imported = import_session_commit(
            State(destination.clone()),
            Json(SessionImportCommitRequest {
                fms_base64: base64::engine::general_purpose::STANDARD.encode(&fms_bytes),
                restore_mode: SessionRestoreMode::VisualizationOnly,
            }),
        )
        .await
        .expect("accepted archive readonly import")
        .0;
        assert_eq!(imported.session_id, "test-session");
        assert_eq!(imported.restore_mode, SessionRestoreMode::VisualizationOnly);
        assert!(!destination_root.path().join("accepted-store-unused").exists());
        assert_eq!(
            destination
                .current_live_state
                .read()
                .await
                .as_ref()
                .expect("imported snapshot")
                .session
                .run_id,
            run_id
        );
        let colliding_store = SessionStore::open(
            destination_root.path().join("accepted-store-unused"),
        )
        .expect("colliding submit store fixture");
        colliding_store
            .commit_run_intent(&fullmag_session::FmsRunIntent::new(
                run_id,
                "colliding-imported-read-only",
                serde_json::json!({"run_id": run_id, "solver": "fixture"}),
            ))
            .expect("colliding submit intent");
        drop(colliding_store);
        let readonly_reexport = export_session(
            State(destination.clone()),
            Json(SessionExportRequest {
                profile: SaveProfile::Compact,
                name: None,
                compression: None,
                ui_state: None,
                target_path: None,
                save_to_source: None,
                accepted_run: None,
            }),
        )
        .await
        .expect_err("imported read-only accepted state must not be re-exported");
        assert_eq!(readonly_reexport.status, axum::http::StatusCode::CONFLICT);
        assert_eq!(
            readonly_reexport.message,
            "imported_read_only: accepted session export is unavailable"
        );

        let mut manifest = Vec::new();
        {
            let mut archive = zip::ZipArchive::new(Cursor::new(&fms_bytes)).expect("FMS ZIP");
            let mut member = archive
                .by_name(fullmag_session::FMS_ACCEPTED_PROVENANCE_MANIFEST_REF)
                .expect("accepted closure manifest");
            member.read_to_end(&mut manifest).expect("closure manifest");
        }
        let mut tampered_manifest: serde_json::Value =
            serde_json::from_slice(&manifest).expect("closure manifest JSON");
        tampered_manifest["closure_sha256"] = serde_json::Value::String(format!(
            "sha256:{}",
            "0".repeat(64)
        ));
        let tampered = rewrite_member(
            &fms_bytes,
            fullmag_session::FMS_ACCEPTED_PROVENANCE_MANIFEST_REF,
            Some(serde_json::to_vec(&tampered_manifest).expect("tampered manifest JSON")),
        );
        let error = import_session_inspect(
            State(destination.clone()),
            Json(SessionImportInspectRequest {
                fms_base64: base64::engine::general_purpose::STANDARD.encode(tampered),
            }),
        )
        .await
        .expect_err("tampered closure must be rejected");
        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);

        let mut snapshot_bytes = Vec::new();
        {
            let mut archive = zip::ZipArchive::new(Cursor::new(&fms_bytes)).expect("FMS ZIP");
            let mut member = archive
                .by_name("project/current_live_snapshot.json")
                .expect("persisted snapshot");
            member
                .read_to_end(&mut snapshot_bytes)
                .expect("persisted snapshot bytes");
        }
        let mut tampered_snapshot: serde_json::Value =
            serde_json::from_slice(&snapshot_bytes).expect("persisted snapshot JSON");
        tampered_snapshot["session"]["session_id"] = serde_json::Value::String(
            "different-session".into(),
        );
        let tampered_snapshot_archive = rewrite_member(
            &fms_bytes,
            "project/current_live_snapshot.json",
            Some(serde_json::to_vec(&tampered_snapshot).expect("tampered snapshot JSON")),
        );
        let error = import_session_inspect(
            State(destination.clone()),
            Json(SessionImportInspectRequest {
                fms_base64: base64::engine::general_purpose::STANDARD
                    .encode(tampered_snapshot_archive),
            }),
        )
        .await
        .expect_err("snapshot identity tampering must be rejected");
        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);

        let missing = rewrite_member(
            &fms_bytes,
            fullmag_session::FMS_ACCEPTED_PROVENANCE_MANIFEST_REF,
            None,
        );
        let error = import_session_inspect(
            State(destination),
            Json(SessionImportInspectRequest {
                fms_base64: base64::engine::general_purpose::STANDARD.encode(missing),
            }),
        )
        .await
        .expect_err("missing closure must be rejected");
        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn context_bound_export_rejects_session_identity_before_script_read() {
        let state = crate::router_v2::tests::test_app_state_with_live_session().await;
        let context = crate::capture_current_live_request_context(&state)
            .await
            .expect("request context");
        {
            let mut current = state.current_live_state.write().await;
            let snapshot = current.as_mut().expect("live state fixture");
            snapshot.session.session_id = "replacement-session".into();
            snapshot.session.script_path = "missing-script-for-stale-context-test.py".into();
        }

        let error = export_session_with_context(
            State(state),
            Json(SessionExportRequest {
                profile: SaveProfile::Compact,
                name: None,
                compression: None,
                ui_state: None,
                target_path: None,
                save_to_source: None,
                accepted_run: None,
            }),
            Some(&context),
        )
        .await
        .expect_err("stale context must reject before reading the script");
        assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
        assert_eq!(error.message, "request_context_stale");
    }
}

const MAX_RETIREMENT_SCRIPT_BYTES: usize = 8 * 1024 * 1024;

/// Documents captured from the in-memory authoring/session projection for a
/// terminal workspace retirement.  This deliberately does not read
/// `SessionManifest::script_path`: the canonical source may have been removed
/// after accepted reattach, while the SceneDocument remains authoritative.
#[derive(Debug)]
pub(crate) struct LiveRetirementDocuments {
    pub documents: BTreeMap<String, Vec<u8>>,
    pub script_available: bool,
    pub ui_state_scope: &'static str,
}

#[derive(Debug, Serialize)]
struct LiveRetirementWorkspaceMetadata<'a> {
    schema: &'static str,
    session: &'a crate::types::SessionManifest,
    run: Option<&'a crate::types::RunManifest>,
    runtime_status: &'a RuntimeStatusView,
    scene_revision: Option<u64>,
    state_version: u64,
    mesh_revision: u64,
    mesh_build_revision: u64,
    region_realization_revisions: &'a fullmag_authoring::RegionRealizationRevisions,
    artifacts: &'a [crate::types::ArtifactEntry],
    accepted_terminal_field_generation:
        Option<&'a crate::types::CurrentLiveFieldGeneration>,
    terminal_field_generations: &'a BTreeMap<String, u64>,
}

/// Capture the current authoring projection without acquiring the transition
/// lock. Callers that mutate current state must hold that lock around this
/// helper and the later publication. A scene with incomplete physics remains a
/// valid archive and simply has no generated `main.py`.
pub(crate) async fn capture_live_retirement_documents(
    state: &AppState,
    snapshot: &SessionStateResponse,
) -> Result<LiveRetirementDocuments, ApiError> {
    let display_selection = state.current_display_selection.read().await.clone();
    let display_presentation = state.current_display_presentation.read().await.clone();
    let workspace_selection = state.current_workspace_selection.read().await.clone();
    let workspace_ribbon = state.current_workspace_ribbon.read().await.clone();
    let workspace_layout = state.current_workspace_layout.read().await.clone();

    let mut documents = BTreeMap::new();
    if let Some(scene) = snapshot.scene_document.as_ref() {
        documents.insert(
            "scene_document.json".to_string(),
            serde_json::to_vec_pretty(scene)
                .map_err(|error| ApiError::internal(format!("serializing scene document: {error}")))?,
        );
    }
    if let Some(builder) = snapshot.builder_adapter.as_ref() {
        documents.insert(
            "script_builder.json".to_string(),
            serde_json::to_vec_pretty(builder)
                .map_err(|error| ApiError::internal(format!("serializing script builder: {error}")))?,
        );
    }

    // These are backend-owned typed resources. A missing browser does not make
    // CLI retirement impossible, and an empty object must never masquerade as
    // a captured workspace state. Browser-local state remains outside this
    // archive and is named explicitly by the manifest scope.
    let ui_state = serde_json::json!({
        "schema": "fullmag.backend-typed-workspace-state.v1",
        "scope": "backend_typed_workspace",
        "display_selection": display_selection,
        "display_presentation": display_presentation,
        "workspace_selection": workspace_selection,
        "workspace_ribbon": workspace_ribbon,
        "workspace_layout": workspace_layout,
        "preview_config": snapshot.preview_config.clone(),
    });
    documents.insert(
        "ui_state.json".to_string(),
        serde_json::to_vec_pretty(&ui_state)
            .map_err(|error| ApiError::internal(format!("serializing typed workspace state: {error}")))?,
    );

    // Keep immutable result/artifact references without copying scalar rows,
    // field payloads, FEM meshes, or engine logs into every retirement.
    let metadata = LiveRetirementWorkspaceMetadata {
        schema: "fullmag.live-retirement-workspace-metadata.v1",
        session: &snapshot.session,
        run: snapshot.run.as_ref(),
        runtime_status: &snapshot.runtime_status,
        scene_revision: snapshot.scene_document.as_ref().map(|scene| scene.revision),
        state_version: snapshot.state_version,
        mesh_revision: snapshot.mesh_revision,
        mesh_build_revision: snapshot.mesh_build_revision,
        region_realization_revisions: &snapshot.region_realization_revisions,
        artifacts: &snapshot.artifacts,
        accepted_terminal_field_generation: snapshot.accepted_terminal_field_generation.as_ref(),
        terminal_field_generations: &snapshot.terminal_field_generations,
    };
    documents.insert(
        "workspace_metadata.json".to_string(),
        serde_json::to_vec_pretty(&metadata)
            .map_err(|error| ApiError::internal(format!("serializing retirement metadata: {error}")))?,
    );

    let mut script_available = false;
    if let Some(scene) = snapshot.scene_document.as_ref() {
        let temp = tempfile::tempdir().map_err(|error| {
            ApiError::internal(format!("creating private retirement render directory: {error}"))
        })?;
        let output = temp.path().join("main.py");
        if crate::script::try_render_scene_document_for_persistence(
            &state.repo_root,
            temp.path(),
            &output,
            scene,
        )?
        .is_some() {
            let script = read_bounded_generated_source(&output)?;
            if script.is_empty() {
                return Err(ApiError::internal("generated retirement source is empty"));
            }
            documents.insert("main.py".to_string(), script);
            script_available = true;
        }
    }

    Ok(LiveRetirementDocuments {
        documents,
        script_available,
        ui_state_scope: "backend_typed_workspace",
    })
}

fn read_bounded_generated_source(path: &Path) -> Result<Vec<u8>, ApiError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        ApiError::internal(format!("inspect generated retirement source: {error}"))
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_RETIREMENT_SCRIPT_BYTES as u64 {
        return Err(ApiError::internal("generated retirement source is not a bounded regular file"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|error| {
        ApiError::internal(format!("open generated retirement source: {error}"))
    })?;
    let opened = file.metadata().map_err(|error| {
        ApiError::internal(format!("inspect generated retirement source handle: {error}"))
    })?;
    if !opened.is_file() || opened.len() > MAX_RETIREMENT_SCRIPT_BYTES as u64 {
        return Err(ApiError::internal("generated retirement source handle changed"));
    }
    let mut bytes = Vec::new();
    file.take((MAX_RETIREMENT_SCRIPT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| ApiError::internal(format!("read generated retirement source: {error}")))?;
    if bytes.len() > MAX_RETIREMENT_SCRIPT_BYTES {
        return Err(ApiError::internal("generated retirement source exceeds its byte bound"));
    }
    Ok(bytes)
}

async fn collect_project_documents(
    state: &AppState,
    ui_state: Option<&serde_json::Value>,
    script: Vec<u8>,
) -> HashMap<String, Vec<u8>> {
    let mut docs = HashMap::new();
    let guard = state.current_live_state.read().await;
    if let Some(snapshot) = guard.as_ref() {
        // Scene document
        if let Some(scene) = &snapshot.scene_document {
            if let Ok(data) = serde_json::to_vec_pretty(scene) {
                docs.insert("scene_document.json".into(), data);
            }
        }
        // Script builder (stored in builder_adapter)
        if let Some(sb) = &snapshot.builder_adapter {
            if let Ok(data) = serde_json::to_vec_pretty(sb) {
                docs.insert("script_builder.json".into(), data);
            }
        }
        // UI state (panel layout, analyze selection, workspace tabs).
        if let Some(value) = ui_state {
            if let Ok(data) = serde_json::to_vec_pretty(value) {
                docs.insert("ui_state.json".into(), data);
            }
        } else {
            docs.insert("ui_state.json".into(), b"{}".to_vec());
        }
        // Full workspace/session snapshot used for exact workspace restore.
        let presentation = state.current_display_presentation.read().await.clone();
        let workspace_selection = state.current_workspace_selection.read().await.clone();
        let workspace_ribbon = state.current_workspace_ribbon.read().await.clone();
        let workspace_layout = state.current_workspace_layout.read().await.clone();
        let persisted = PersistedCurrentLiveSnapshot::from(snapshot);
        let persisted = PersistedCurrentLiveSnapshot {
            display_presentation_schema_version: Some(DISPLAY_PRESENTATION_SCHEMA_VERSION),
            display_presentation: persisted_display_presentation(&presentation)
                .expect("display presentation must serialize"),
            workspace_selection,
            workspace_ribbon,
            workspace_layout,
            ..persisted
        };
        if let Ok(data) = serde_json::to_vec_pretty(&persisted) {
            docs.insert("current_live_snapshot.json".into(), data);
        }
    }

    docs.insert("main.py".into(), script);

    docs
}

fn read_captured_export_script(store: &SessionStore, source: &serde_json::Value) -> Result<Vec<u8>, ApiError> {
    let invalid = |message: &str| ApiError::conflict(format!("accepted export source: {message}"));
    let capture = &source["capture"];
    let entry = capture["entry_relative_path"].as_str().ok_or_else(|| invalid("entry path missing"))?;
    let records = capture["records"].as_array().ok_or_else(|| invalid("capture records missing"))?;
    let entries = records.iter().filter(|record| record["relative_path"].as_str() == Some(entry)).collect::<Vec<_>>();
    if entries.len() != 1 || entries[0]["role"].as_str() != Some("source") {
        return Err(invalid("entry is not one captured source file"));
    }
    let record = entries[0];
    let length = record["byte_count"].as_u64().filter(|length| *length > 0 && *length <= MAX_RETIREMENT_SCRIPT_BYTES as u64)
        .ok_or_else(|| invalid("entry exceeds source byte budget or is empty"))?;
    let digest = record["sha256"].as_str().ok_or_else(|| invalid("entry digest missing"))?;
    let bytes = store.cas().get_bounded(digest, length)
        .map_err(|error| ApiError::conflict(format!("accepted export source read failed: {error}")))?
        .ok_or_else(|| invalid("captured entry CAS object missing"))?;
    if bytes.len() as u64 != length || fullmag_session::hex_sha256(&bytes) != digest {
        return Err(invalid("captured entry differs from immutable source"));
    }
    Ok(bytes)
}

fn accepted_export_script(
    state: &AppState, snapshot: &SessionStateResponse, capture: &AcceptedExportCapture,
) -> Result<Option<Vec<u8>>, ApiError> {
    let root = state.submit_store_root.as_ref().ok_or_else(|| ApiError::conflict("accepted export store unavailable"))?;
    let store = SessionStore::open_existing(root).map_err(|error| ApiError::conflict(error.to_string()))?;
    let intent = store.read_run_intent(&capture.identity.run_id).map_err(|error| ApiError::conflict(error.to_string()))?
        .ok_or_else(|| ApiError::conflict("accepted export RunIntent missing"))?;
    if !intent.asset_object_refs.contains_key(fullmag_application::SCRIPT_PIPELINE_SOURCE_ASSET_ID) {
        return Ok(None);
    }
    let specification: fullmag_application::RunSpecification = serde_json::from_value(intent.specification.clone())
        .map_err(|error| ApiError::conflict(format!("accepted export specification invalid: {error}")))?;
    let scene = snapshot.scene_document.as_ref().ok_or_else(|| ApiError::conflict("accepted export scene missing"))?;
    crate::live_execution_binding::validate_input_binding(&intent.specification,
        &crate::live_execution_binding::input_identity(scene)?, scene.revision)?;
    let run = fullmag_application::RunId::parse(capture.identity.run_id.as_str()).map_err(|error| ApiError::conflict(error.to_string()))?;
    let accepted = fullmag_runtime_control::load_accepted_study_snapshot(&store, &run, &specification.snapshot.project_id)
        .map_err(|error| ApiError::conflict(format!("accepted export source closure invalid: {error}")))?;
    accepted_captured_script(&store, &accepted).map(Some)
}

fn accepted_captured_script(store: &SessionStore, accepted: &fullmag_runtime_control::AcceptedStudySnapshot)
    -> Result<Vec<u8>, ApiError> {
    let reference = accepted.run.specification.immutable_assets.iter()
        .find(|asset| asset.asset_id == fullmag_application::SCRIPT_PIPELINE_SOURCE_ASSET_ID)
        .ok_or_else(|| ApiError::conflict("accepted export captured source reference missing"))?;
    let bytes = store.cas().get_bounded(&reference.content_sha256, 16 * 1024 * 1024)
        .map_err(|error| ApiError::conflict(error.to_string()))?
        .ok_or_else(|| ApiError::conflict("accepted export captured source missing"))?;
    let source = fullmag_application::validate_accepted_script_pipeline_source(&accepted.study, &accepted.catalog, &bytes)
        .map_err(|error| ApiError::conflict(format!("accepted export captured source invalid: {error}")))?;
    // The accepted snapshot reader already verifies every captured file against RunSpec and CAS.
    fullmag_application::validate_script_source_assets(&accepted.run.specification, &source, |hash, maximum|
        store.cas().get_bounded(hash, maximum)?.ok_or_else(|| anyhow::anyhow!("accepted source file missing")))
        .map_err(|error| ApiError::conflict(format!("accepted export source assets invalid: {error}")))?;
    read_captured_export_script(store, &source)
}

async fn read_canonical_script(state: &AppState, accepted: Option<&AcceptedExportCapture>) -> Result<Vec<u8>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active workspace"))?;
    if let Some(capture) = accepted {
        if let Some(script) = accepted_export_script(state, snapshot, capture)? {
            return Ok(script);
        }
    }
    let script_path = Path::new(&snapshot.session.script_path);
    let metadata = std::fs::symlink_metadata(script_path).map_err(|_| {
        ApiError::unprocessable(
            "invalid_script: session script_path must name a readable regular Python file",
        )
    })?;
    if !metadata.file_type().is_file() {
        return Err(ApiError::unprocessable(
            "invalid_script: session script_path must name a readable regular Python file",
        ));
    }
    let script = std::fs::read(script_path).map_err(|_| {
        ApiError::unprocessable(
            "invalid_script: session script_path must name a readable regular Python file",
        )
    })?;
    if script.is_empty() {
        return Err(ApiError::unprocessable(
            "invalid_script: session script_path must name a non-empty Python file",
        ));
    }
    Ok(script)
}

fn session_store_run_artifact_dir(store: &SessionStore, run_id: &str) -> Result<PathBuf, ApiError> {
    fullmag_session::repository_path::validate_store_id(run_id)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    fullmag_session::repository_path::checked_path(
        store.root(),
        &format!("runs/{run_id}/artifacts"),
    )
    .map_err(|error| ApiError::conflict(error.to_string()))
}

fn copy_artifact_tree(source: &Path, destination: &Path) -> Result<(), ApiError> {
    std::fs::create_dir_all(destination).map_err(|error| {
        ApiError::internal(format!(
            "creating session artifact snapshot '{}': {error}",
            destination.display()
        ))
    })?;
    for entry in std::fs::read_dir(source).map_err(|error| {
        ApiError::internal(format!(
            "reading solved artifact directory '{}': {error}",
            source.display()
        ))
    })? {
        let entry = entry.map_err(|error| {
            ApiError::internal(format!(
                "reading solved artifact directory entry '{}': {error}",
                source.display()
            ))
        })?;
        let file_type = entry.file_type().map_err(|error| {
            ApiError::internal(format!(
                "reading solved artifact type '{}': {error}",
                entry.path().display()
            ))
        })?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| ApiError::conflict("non-UTF8 solved artifact name"))?;
        fullmag_session::repository_path::checked_path(source, &name)
            .map_err(|error| ApiError::conflict(error.to_string()))?;
        let target = destination.join(entry.file_name());
        if file_type.is_symlink() {
            return Err(ApiError::conflict(format!(
                "solved session export rejects symbolic-link artifact '{}'",
                entry.path().display()
            )));
        }
        if file_type.is_dir() {
            copy_artifact_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &target).map_err(|error| {
                ApiError::internal(format!(
                    "copying solved artifact to '{}': {error}",
                    target.display()
                ))
            })?;
        } else {
            return Err(ApiError::conflict(format!(
                "solved session export rejects non-regular artifact '{}'",
                entry.path().display()
            )));
        }
    }
    Ok(())
}

fn capture_solved_artifacts(
    store: &SessionStore,
    run_id: &str,
    source: &Path,
) -> Result<PathBuf, ApiError> {
    let _lease = store
        .write_transaction()
        .map_err(|error| ApiError::conflict(error.to_string()))?;
    if !source.is_dir() {
        return Err(ApiError::conflict(format!(
            "solved session export requires an existing artifact directory for run '{run_id}': {}",
            source.display()
        )));
    }

    let destination = session_store_run_artifact_dir(store, run_id)?;
    if destination.exists() {
        let source_canonical = source.canonicalize().map_err(|error| {
            ApiError::internal(format!(
                "resolving solved artifact source '{}': {error}",
                source.display()
            ))
        })?;
        let destination_canonical = destination.canonicalize().map_err(|error| {
            ApiError::internal(format!(
                "resolving session artifact destination '{}': {error}",
                destination.display()
            ))
        })?;
        if source_canonical == destination_canonical {
            return Ok(destination);
        }
    }

    let temporary = fullmag_session::repository_path::checked_path(
        store.root(),
        &format!("runs/.artifacts.save-{}", uuid::Uuid::new_v4()),
    )
    .map_err(|error| ApiError::conflict(error.to_string()))?;
    std::fs::create_dir(&temporary).map_err(|error| {
        ApiError::internal(format!("creating exclusive artifact staging: {error}"))
    })?;
    if let Err(error) = copy_artifact_tree(source, &temporary) {
        let _ = std::fs::remove_dir_all(&temporary);
        return Err(error);
    }

    let destination_parent = destination
        .parent()
        .expect("artifact destination has run parent");
    let destination_parent_existed = destination_parent.exists();
    if let Err(error) = std::fs::create_dir_all(destination_parent) {
        let _ = std::fs::remove_dir_all(&temporary);
        return Err(ApiError::internal(format!(
            "creating session artifact run directory '{}': {error}",
            destination_parent.display()
        )));
    }

    let previous =
        destination.with_file_name(format!("artifacts.previous-{}", uuid::Uuid::new_v4()));
    if destination.exists() {
        std::fs::rename(&destination, &previous).map_err(|error| {
            let _ = std::fs::remove_dir_all(&temporary);
            ApiError::internal(format!(
                "preparing session artifact snapshot replacement '{}': {error}",
                destination.display()
            ))
        })?;
    }
    if let Err(error) = std::fs::rename(&temporary, &destination) {
        if previous.exists() {
            let _ = std::fs::rename(&previous, &destination);
        }
        let _ = std::fs::remove_dir_all(&temporary);
        if !destination_parent_existed {
            let _ = std::fs::remove_dir(destination_parent);
        }
        return Err(ApiError::internal(format!(
            "committing session artifact snapshot '{}': {error}",
            destination.display()
        )));
    }
    if previous.exists() {
        std::fs::remove_dir_all(&previous).map_err(|error| {
            ApiError::internal(format!(
                "removing superseded session artifact snapshot '{}': {error}",
                previous.display()
            ))
        })?;
    }
    Ok(destination)
}

#[cfg(test)]
mod artifact_capture_tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn failed_artifact_copy_leaves_no_published_or_staged_artifact_tree() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "fullmag-api-artifact-capture-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let source = root.join("source");
        std::fs::create_dir_all(source.join("eigen/modes"))
            .expect("source artifact fixture should be created");
        std::fs::write(source.join("eigen/spectrum.v2.json"), b"spectrum")
            .expect("spectrum fixture should be written");
        symlink(
            "/not-a-real-mode.bin",
            source.join("eigen/modes/mode_0000.bin"),
        )
        .expect("symlink fixture should be created");
        let store = SessionStore::open(root.join("store")).expect("session store should open");

        let error = capture_solved_artifacts(&store, "run-001", &source)
            .expect_err("symbolic-link artifact must reject the snapshot");
        assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
        let run_dir = store.root().join("runs/run-001");
        assert!(!run_dir.exists(), "failed copy must not publish a run tree");
        assert!(
            !store.root().join("runs").exists()
                || std::fs::read_dir(store.root().join("runs"))
                    .expect("runs staging parent should be readable")
                    .all(|entry| {
                        !entry
                            .expect("staging entry should be readable")
                            .file_name()
                            .to_string_lossy()
                            .starts_with(".artifacts.save-")
                    }),
            "failed copy must clean its staging tree"
        );

        let _ = std::fs::remove_dir_all(root);
    }
}

// ── Handlers ───────────────────────────────────────────────────────────

/// `POST /v2/sessions/current/persistence/exports`
pub(crate) async fn export_session(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SessionExportRequest>,
) -> Result<Json<SessionExportResponse>, ApiError> {
    export_session_with_context(State(state), Json(req), None).await
}

pub(crate) async fn export_session_with_context(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SessionExportRequest>,
    request_context: Option<&crate::types::CurrentLiveRequestContext>,
) -> Result<Json<SessionExportResponse>, ApiError> {
    // Establish the transition fence before reading any session identity,
    // script bytes, snapshot, or project document.  A context-bound export
    // must never assemble an archive from a session that is being replaced.
    let _transition = state.current_live_session_transition.lock().await;
    if let Some(context) = request_context {
        crate::validate_current_live_request_context(&state, context).await?;
    }
    let save_to_source = req.save_to_source.unwrap_or(false);
    let requested_target = req.target_path.as_deref();
    validate_session_output_request(requested_target, save_to_source)?;
    if req.accepted_run.is_some() && (req.profile != SaveProfile::Solved || save_to_source
        || req.ui_state.is_some() || requested_target.is_some()) {
        return Err(ApiError::bad_request("historical accepted_run export requires a solved download without UI override or output path"));
    }

    // Historical downloads are sourced entirely from their pinned accepted run;
    // they also work when no current workspace has been opened.
    let (snapshot, source_epoch, historical_script) = if let Some(source) = req.accepted_run.as_ref() {
        let (historical, epoch, script) = historical_export_snapshot(&state, source)?;
        (historical, epoch, Some(script))
    } else {
        let snapshot = state.current_live_state.read().await.clone()
            .ok_or_else(|| ApiError::not_found("no active workspace"))?;
        (snapshot, state.current_live_session_epoch.load(std::sync::atomic::Ordering::Acquire), None)
    };
    let session_id = snapshot.session.session_id.clone();
    let name = req.name.unwrap_or_else(|| snapshot.session.problem_name.clone());
    let export_profile = FmsExportProfile::for_profile(req.profile);
    let save_target = if save_to_source {
        Some(resolve_session_output_target(
            Path::new(&snapshot.session.script_path),
            requested_target,
        )?)
    } else {
        None
    };
    let mut accepted_capture = if req.accepted_run.is_some() {
        accepted_export_capture_at_epoch(&state, &snapshot, &export_profile, source_epoch)?
    } else { accepted_export_capture(&state, &snapshot, &export_profile)? };
    if let Some(source) = req.accepted_run.as_ref() {
        validate_historical_export_pins(&state, source, accepted_capture.as_ref()
            .ok_or_else(|| ApiError::conflict("historical accepted capture absent"))?)?;
    }
    let script = if let Some(script) = historical_script { script }
        else { read_canonical_script(&state, accepted_capture.as_ref()).await? };
    let mut session_manifest = FmsSessionManifest::new(&session_id, &name, req.profile);

    if let Some(capture) = accepted_capture.as_ref() {
        session_manifest.format = fullmag_session::FMS_SESSION_FORMAT_V2.into();
        session_manifest.run_refs.push(format!(
            "runs/{}/run_manifest.json",
            capture.identity.run_id
        ));
        session_manifest.accepted_provenance_ref = Some(FmsAcceptedProvenanceReference {
            manifest_ref: fullmag_session::FMS_ACCEPTED_PROVENANCE_MANIFEST_REF.into(),
            accepted_run_id: capture.provenance.manifest.accepted_run_id.clone(),
            closure_sha256: capture.provenance.manifest.closure_sha256.clone(),
        });
    }

    // Legacy live runs still use the local-live artifact snapshot. Accepted
    // runs use their detached accepted-store closure and never read the
    // legacy artifact directory as solver-result evidence.
    let run_capture = if accepted_capture.is_some() {
        None
    } else {
        let run_ref = format!("runs/{}/run_manifest.json", snapshot.session.run_id);
        session_manifest.run_refs.push(run_ref);
        let is_field_only = snapshot.metadata.as_ref()
            .and_then(|metadata| metadata.get("execution_plan"))
            .and_then(|plan| serde_json::from_value::<fullmag_ir::ExecutionPlanIR>(plan.clone()).ok())
            .is_some_and(|plan| matches!(plan.backend_plan, fullmag_ir::BackendPlanIR::AntennaFieldOnly(_)));
        let run_manifest = FmsRunManifest {
            run_id: snapshot.session.run_id.clone(),
            status: fullmag_session::RunStatus::Completed, // simplified
            study_kind: if is_field_only { "field_only".into() } else { "unknown".into() },
            backend: snapshot.session.requested_backend.clone(),
            precision: snapshot.session.precision.clone(),
            started_at: chrono::Utc::now(),
            finished_at: None,
            total_steps: snapshot
                .run
                .as_ref()
                .map(|r| r.total_steps as u64)
                .unwrap_or(0),
            total_time_s: snapshot
                .live_state
                .as_ref()
                .map(|ls| ls.latest_step.time)
                .unwrap_or(0.0),
            plan_ref: None,
            live_state_ref: None,
            latest_checkpoint_ref: None,
            artifact_index_ref: None,
        };
        Some((run_manifest, crate::session::current_artifact_dir(&snapshot)))
    };
    let docs = if req.accepted_run.is_some() { historical_project_documents(&snapshot, script)? }
        else { collect_project_documents(&state, req.ui_state.as_ref(), script).await };

    if let Some(context) = request_context {
        crate::validate_current_live_request_context(&state, context).await?;
    }
    if let Some(capture) = accepted_capture.as_mut() {
        // The transition fence above pins the requester; the source closure
        // below is separately fenced without substituting the current run.
        let refreshed = if req.accepted_run.is_some() {
            validate_accepted_export_capture(&state, &snapshot, capture, &export_profile, source_epoch)?
        } else {
            let current = state.current_live_state.read().await;
            let current = current.as_ref().ok_or_else(|| ApiError::conflict("accepted export workspace disappeared"))?;
            validate_accepted_export_capture(&state, current, capture, &export_profile,
                state.current_live_session_epoch.load(std::sync::atomic::Ordering::Acquire))?
        };
        capture.provenance = refreshed;
    }
    let store = open_store(&state)?;
    // No await may occur while this thread-owned transaction is held.
    let _transaction = store
        .write_transaction()
        .map_err(|error| ApiError::conflict(error.to_string()))?;
    if export_profile.include_artifacts() && accepted_capture.is_none() {
        let (run_manifest, artifact_source) = run_capture.as_ref().ok_or_else(|| {
            ApiError::conflict("solved session export requires an active run artifact directory")
        })?;
        let artifact_source = artifact_source.as_ref().ok_or_else(|| {
            ApiError::conflict("solved session export requires an active run artifact directory")
        })?;
        capture_solved_artifacts(&store, &run_manifest.run_id, artifact_source)?;
    }
    let script = docs
        .get("main.py")
        .expect("validated canonical script must be present in project documents");
    let workspace_manifest = FmsWorkspaceManifest {
        workspace_id: "local-live".into(),
        problem_name: name.clone(),
        project_ref: "project/".into(),
        script_ref: "project/main.py".into(),
        script_sha256: fullmag_session::hex_sha256(script),
        ui_state_ref: "project/ui_state.json".into(),
        scene_document_ref: "project/scene_document.json".into(),
        script_builder_ref: docs.contains_key("script_builder.json").then(|| "project/script_builder.json".into()),
        model_builder_graph_ref: None,
        asset_index_ref: None,
    };

    let opts = PackOptions {
        compression: req
            .compression
            .unwrap_or(fullmag_session::CompressionProfile::Balanced),
    };

    if let Some(capture) = accepted_capture.as_ref() {
        store
            .commit_run(&capture.run_manifest)
            .map_err(|e| ApiError::internal(e.to_string()))?;
    } else if let Some((run_manifest, _)) = run_capture.as_ref() {
        store
            .commit_run(run_manifest)
            .map_err(|e| ApiError::internal(e.to_string()))?;
    }
    // Pack to in-memory buffer.
    let mut buf = Cursor::new(Vec::new());
    if let Some(capture) = accepted_capture.as_ref() {
        pack_fms_with_accepted_provenance(
            &mut buf,
            &store,
            &session_manifest,
            &workspace_manifest,
            &export_profile,
            &docs,
            &opts,
            &capture.provenance,
        )
        .map_err(|e| ApiError::internal(format!("packing accepted .fms: {e}")))?;
    } else {
        pack_fms(
            &mut buf,
            &store,
            &session_manifest,
            &workspace_manifest,
            &export_profile,
            &docs,
            &opts,
        )
        .map_err(|e| ApiError::internal(format!("packing .fms: {e}")))?;
    }

    store
        .commit_session(&session_manifest)
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let fms_bytes = buf.into_inner();
    let (saved_path, filename) = if let Some(target) = save_target {
        let (saved_path, filename) = publish_session_archive(&target, &fms_bytes)?;
        (Some(saved_path.display().to_string()), Some(filename))
    } else {
        (None, None)
    };
    let fms_base64 = session_export_base64(&fms_bytes, saved_path.as_deref());

    Ok(Json(SessionExportResponse {
        session_id,
        profile: req.profile,
        fms_base64,
        size_bytes: fms_bytes.len(),
        saved_path,
        filename,
    }))
}

fn archive_preflight_error(error: anyhow::Error, operation: &str) -> ApiError {
    let infrastructure = error.downcast_ref::<fullmag_session::ArchiveCapacityUnavailable>().is_some()
        || error.chain().any(|cause| cause.downcast_ref::<std::io::Error>().is_some_and(|io| {
            !matches!(io.kind(), std::io::ErrorKind::InvalidData | std::io::ErrorKind::UnexpectedEof)
        }));
    let message = format!("{operation}: {error}");
    if infrastructure { ApiError::internal(message) } else { ApiError::bad_request(message) }
}

/// `POST /v2/persistence/imports/inspections`
pub(crate) async fn import_session_inspect(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SessionImportInspectRequest>,
) -> Result<Json<SessionImportInspectResponse>, ApiError> {
    let fms_bytes = base64_decode(&req.fms_base64)
        .map_err(|e| ApiError::bad_request(format!("invalid base64: {e}")))?;

    let decoding_root = session_store_root(&state).join("imports");
    std::fs::create_dir_all(&decoding_root)
        .map_err(|error| ApiError::internal(format!("creating archive decode root: {error}")))?;
    let staged = preflight_fms_staged(Cursor::new(&fms_bytes), &[], &decoding_root)
        .map_err(|error| archive_preflight_error(error, "invalid_fms_preflight"))?;
    let mut inspection = staged.inspection.clone();
    if staged.session.accepted_provenance_ref.is_some() {
        let snapshot_bytes = staged
            .read_document("project/current_live_snapshot.json")
            .map_err(|error| {
                ApiError::bad_request(format!(
                    "invalid_fms_accepted_provenance: persisted snapshot is missing: {error}"
                ))
            })?;
        let persisted: PersistedCurrentLiveSnapshot =
            serde_json::from_slice(&snapshot_bytes).map_err(|error| {
                ApiError::bad_request(format!(
                    "invalid_fms_accepted_provenance: persisted snapshot is invalid: {error}"
                ))
            })?;
        validate_imported_accepted_provenance(&staged, &persisted)?;
        if persisted.metadata.as_ref().is_some_and(|metadata| metadata.get("accepted_definition_projection").is_some()) {
            inspection.warnings.push(ACCEPTED_PROJECTION_WARNING.into());
        }
    }

    Ok(Json(SessionImportInspectResponse { inspection }))
}

fn json_field_subset(value: &serde_json::Value, fields: &[&str]) -> serde_json::Value {
    let source = value.as_object();
    serde_json::Value::Object(
        fields
            .iter()
            .map(|field| {
                (
                    (*field).to_string(),
                    source
                        .and_then(|object| object.get(*field))
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                )
            })
            .collect(),
    )
}

fn scene_objects_subset(
    scene: &fullmag_authoring::SceneDocument,
    fields: &[&str],
) -> Option<serde_json::Value> {
    scene
        .objects
        .iter()
        .map(|object| {
            serde_json::to_value(object)
                .ok()
                .map(|value| json_field_subset(&value, fields))
        })
        .collect::<Option<Vec<_>>>()
        .map(serde_json::Value::Array)
}

fn scene_study_subset(
    scene: &fullmag_authoring::SceneDocument,
    fields: &[&str],
) -> Option<serde_json::Value> {
    serde_json::to_value(&scene.study)
        .ok()
        .map(|value| json_field_subset(&value, fields))
}

fn scene_semantic_section(
    snapshot: &SessionStateResponse,
    category: &str,
) -> Option<serde_json::Value> {
    let scene = snapshot.scene_document.as_ref()?;
    let scene_value = serde_json::to_value(scene).ok()?;
    let scene_fields = |fields: &[&str]| json_field_subset(&scene_value, fields);

    match category {
        "geometry" => Some(serde_json::json!({
            "objects": scene_objects_subset(scene, &["id", "geometry", "transform", "region_name"])?,
            "universe": scene_fields(&["universe"]),
        })),
        "materials_physics" => Some(serde_json::json!({
            "scene": scene_fields(&[
                "materials",
                "magnetization_assets",
                "couplings",
                "field_drives",
                "current_modules",
                "current_transports",
                "spin_transports",
                "spin_torques",
                "oersted_fields",
            ]),
            "objects": scene_objects_subset(scene, &[
                "id",
                "material_ref",
                "magnetization_ref",
                "region_overrides",
                "physics_stack",
                "material_parameter_fields",
                "absorbing_boundary",
            ])?,
        })),
        "mesh" => Some(serde_json::json!({
            "universe": scene_fields(&["universe"]),
            "study": scene_study_subset(scene, &[
                "fdm",
                "universe_mesh",
                "shared_domain_mesh",
                "mesh_defaults",
                "mesh_interfaces",
            ])?,
            "objects": scene_objects_subset(scene, &[
                "id",
                "object_mesh",
                "mesh_override",
                "regions",
                "allocated_region_ids",
            ])?,
        })),
        "study_stages" => Some(serde_json::json!({
            "study": scene_study_subset(scene, &["stages", "study_pipeline", "initial_state"])?,
            "outputs": scene_fields(&["outputs"]),
        })),
        _ => None,
    }
}

fn execution_semantic_section(snapshot: &SessionStateResponse) -> serde_json::Value {
    let mut section = serde_json::json!({
        "requested_backend": snapshot.session.requested_backend,
        "authored_requested_device": snapshot.session.authored_requested_device,
        "requested_device": snapshot.session.requested_device,
        "requested_precision": snapshot.session.requested_precision,
        "requested_mode": snapshot.session.requested_mode,
        "resolved_backend": snapshot.session.resolved_backend,
        "resolved_device": snapshot.session.resolved_device,
        "resolved_precision": snapshot.session.resolved_precision,
        "resolved_mode": snapshot.session.resolved_mode,
        "resolved_runtime_family": snapshot.session.resolved_runtime_family,
        "resolved_engine_id": snapshot.session.resolved_engine_id,
        "plan_summary": snapshot.session.plan_summary,
        "runtime_status": snapshot.runtime_status,
    });
    if let Some(scene) = snapshot.scene_document.as_ref() {
        if scene.study.execution_profile.is_some() || !scene.study.execution_layers.is_empty() {
            section["authored_execution"] = serde_json::json!({
                "execution_profile": scene.study.execution_profile,
                "execution_layers": scene.study.execution_layers,
            });
        }
    }
    section
}

fn problem_ir_semantic_section(snapshot: &SessionStateResponse) -> Option<serde_json::Value> {
    snapshot
        .metadata
        .as_ref()
        .and_then(|metadata| {
            metadata
                .get("problem_ir")
                .or_else(|| metadata.get("normalized_problem_ir"))
        })
        .cloned()
}

fn compare_restore_category(
    active: Option<serde_json::Value>,
    imported: Option<serde_json::Value>,
    difference: &str,
) -> SessionRestoreCompatibilityCategory {
    match (active, imported) {
        (Some(active), Some(imported)) => SessionRestoreCompatibilityCategory {
            basis: SessionRestoreCompatibilityBasis::Available,
            differences: (active != imported)
                .then(|| vec![difference.to_string()])
                .unwrap_or_default(),
        },
        _ => SessionRestoreCompatibilityCategory {
            basis: SessionRestoreCompatibilityBasis::Unavailable,
            differences: Vec::new(),
        },
    }
}

fn session_restore_compatibility(
    active: Option<&SessionStateResponse>,
    imported: &SessionStateResponse,
) -> SessionRestoreCompatibility {
    let compare_scene = |category, difference| {
        compare_restore_category(
            active.and_then(|snapshot| scene_semantic_section(snapshot, category)),
            scene_semantic_section(imported, category),
            difference,
        )
    };

    SessionRestoreCompatibility {
        geometry: compare_scene("geometry", "geometry differs"),
        materials_physics: compare_scene("materials_physics", "materials or physics differs"),
        mesh: compare_scene("mesh", "mesh differs"),
        study_stages: compare_scene("study_stages", "study stages differ"),
        execution: compare_restore_category(
            active.map(execution_semantic_section),
            Some(execution_semantic_section(imported)),
            "execution differs",
        ),
        problem_ir: compare_restore_category(
            active.and_then(problem_ir_semantic_section),
            problem_ir_semantic_section(imported),
            "ProblemIR differs",
        ),
    }
}

fn safe_import_session_id(session_id: &str) -> String {
    let safe = session_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if safe.is_empty() {
        "session".to_string()
    } else {
        safe
    }
}

fn validate_imported_snapshot_run(
    preflight: &FmsStagedPreflight,
    persisted: &PersistedCurrentLiveSnapshot,
) -> Result<(), ApiError> {
    if persisted.session.session_id != preflight.session.session_id {
        return Err(ApiError::bad_request(
            "invalid_fms_snapshot: snapshot session_id does not match manifest/session.json",
        ));
    }
    let run_id = &persisted.session.run_id;
    let run_ref = format!("runs/{run_id}/run_manifest.json");
    if !preflight
        .session
        .run_refs
        .iter()
        .any(|reference| reference == &run_ref)
    {
        return Err(ApiError::bad_request(format!(
            "invalid_fms_snapshot: active run '{run_id}' is not declared by manifest/session.json"
        )));
    }
    let run_bytes = preflight.read_document(&run_ref).map_err(|_| {
        ApiError::bad_request(format!(
            "invalid_fms_snapshot: declared run manifest '{run_ref}' is missing"
        ))
    })?;
    let run_manifest: FmsRunManifest = serde_json::from_slice(&run_bytes).map_err(|error| {
        ApiError::bad_request(format!(
            "invalid_fms_snapshot: declared run manifest '{run_ref}' is invalid: {error}"
        ))
    })?;
    if run_manifest.run_id != *run_id {
        return Err(ApiError::bad_request(format!(
            "invalid_fms_snapshot: declared run manifest '{run_ref}' has run_id '{}'",
            run_manifest.run_id
        )));
    }
    for document in [
        "project/main.py",
        "project/ui_state.json",
        "project/current_live_snapshot.json",
    ] {
        if !preflight.contains_document(document) {
            return Err(ApiError::bad_request(format!(
                "invalid_fms_snapshot: required document '{document}' is missing"
            )));
        }
    }
    Ok(())
}

fn normalize_imported_read_only(persisted: &mut PersistedCurrentLiveSnapshot) {
    persisted.session.status = "completed".to_string();
    persisted.runtime_status = RuntimeStatusView {
        kind: fullmag_runner::RuntimeStatus::Completed,
        code: "imported_read_only".to_string(),
        is_busy: false,
        can_accept_commands: false,
    };
    if let Some(run) = persisted.run.as_mut() {
        run.status = "completed".to_string();
    }
    if let Some(live_state) = persisted.live_state.as_mut() {
        live_state.status = "completed".to_string();
        live_state.latest_step.finished = true;
    }
    if let Some(execution) = persisted.stage_execution.as_mut() {
        let total_stages = execution
            .total_stages
            .max(execution.stage_statuses.len())
            .max(execution.stages.len());
        execution.total_stages = total_stages;
        execution.completed_stage_indexes = (0..total_stages).collect();
        execution.stage_statuses = vec![crate::types::StageLifecycleState::Completed; total_stages];
        for stage in &mut execution.stages {
            stage.status = crate::types::StageLifecycleState::Completed;
        }
        execution.active_stage_index = None;
        execution.active_stage_kind = None;
        execution.runtime_state = crate::types::RuntimeLifecycleState::Completed;
    }
}

fn publish_imported_session(
    state: &AppState,
    preflight: &FmsStagedPreflight,
    persisted: &PersistedCurrentLiveSnapshot,
    import_id: &str,
) -> Result<PathBuf, ApiError> {
    if matches!(preflight.session.profile, SaveProfile::Solved | SaveProfile::Resume | SaveProfile::Archive) {
        preflight.reachability.require_complete()
            .map_err(|error| ApiError::bad_request(format!("invalid_fms_graph: {error}")))?;
    } else {
        preflight.reachability.require_visualization_safe()
            .map_err(|error| ApiError::bad_request(format!("invalid_fms_graph: {error}")))?;
    }
    let imports = session_store_root(state).join("imports");
    std::fs::create_dir_all(&imports)
        .map_err(|error| ApiError::internal(format!("creating import root: {error}")))?;
    let published = imports.join(&import_id);
    let staging = imports.join(format!(".{import_id}.staging"));

    // Exclusive UUID paths belong only to this operation. Uncertain durable
    // writes retain their staging directory for reconciliation.
    std::fs::create_dir(&staging)
        .map_err(|error| ApiError::internal(format!("creating exclusive import staging: {error}")))?;
    let mut retain_staging = false;
    let result = (|| -> Result<(), ApiError> {
        let staging_store = SessionStore::open(&staging)
            .map_err(|error| ApiError::internal(format!("creating import staging: {error}")))?;
        let imported_session = if preflight.session.format == fullmag_session::FMS_SESSION_FORMAT_V2 {
            unpack_fms_staged_readonly(preflight, &staging_store)
        } else {
            unpack_fms_staged(preflight, &staging_store)
        }
        .map_err(|error| {
            retain_staging = error
                .downcast_ref::<fullmag_session::PublicationUncertain>()
                .is_some();
            ApiError::internal(format!(
                "archive import storage failure at {}: {error}",
                staging.display()
            ))
        })?;
        if imported_session.session_id != preflight.session.session_id {
            return Err(ApiError::bad_request(
                "invalid_fms_unpack: session manifest changed during import",
            ));
        }
        validate_imported_snapshot_run(preflight, persisted)?;
        staging_store
            .write_document(
                "project/current_live_snapshot.json",
                &serde_json::to_vec_pretty(persisted).map_err(|error| {
                    ApiError::internal(format!(
                        "serializing rebased imported session snapshot: {error}"
                    ))
                })?,
            )
            .map_err(|error| {
                retain_staging = error.downcast_ref::<fullmag_session::PublicationUncertain>().is_some();
                ApiError::internal(format!(
                    "persisting rebased imported session snapshot at {}: {error}", staging.display()
                ))
            })?;
        // Release writer ownership through its original path before moving
        // the private root. All handles are closed at the publication boundary.
        drop(staging_store);
        fullmag_session::publish_directory(&staging, &published).map_err(|error| {
            retain_staging = error.downcast_ref::<fullmag_session::PublicationUncertain>().is_some()
                || error.downcast_ref::<fullmag_session::WriterReleaseUnconfirmed>().is_some();
            ApiError::internal(format!("publishing imported session snapshot at {}: {error}", published.display()))
        })?;
        Ok(())
    })();
    if let Err(error) = result {
        if !retain_staging { let _ = std::fs::remove_dir_all(&staging); }
        return Err(error);
    }
    Ok(published)
}

/// `POST /v2/sessions/current/persistence/imports`
pub(crate) async fn import_session_commit(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SessionImportCommitRequest>,
) -> Result<Json<SessionImportCommitResponse>, ApiError> {
    import_session_commit_with_context(State(state), Json(req), None).await
}

pub(crate) async fn import_session_commit_with_context(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SessionImportCommitRequest>,
    request_context: Option<&crate::types::CurrentLiveRequestContext>,
) -> Result<Json<SessionImportCommitResponse>, ApiError> {
    if let Some(context) = request_context {
        crate::validate_current_live_request_context(&state, context).await?;
    }
    let fms_bytes = base64_decode(&req.fms_base64)
        .map_err(|e| ApiError::bad_request(format!("invalid base64: {e}")))?;

    // The archive, persisted snapshot, presentation migration, and semantic
    // report must all be valid before opening a SessionStore or mutating live
    // application state.
    let decoding_root = session_store_root(&state).join("imports");
    std::fs::create_dir_all(&decoding_root)
        .map_err(|error| ApiError::internal(format!("creating archive decode root: {error}")))?;
    let preflight = preflight_fms_staged(
        Cursor::new(&fms_bytes),
        &["project/current_live_snapshot.json"],
        &decoding_root,
    )
    .map_err(|error| archive_preflight_error(error, "invalid_fms_preflight"))?;
    let snapshot_bytes = preflight.read_document("project/current_live_snapshot.json")
        .map_err(|error| ApiError::bad_request(format!("invalid_fms_snapshot: {error}")))?;
    let mut persisted: PersistedCurrentLiveSnapshot = serde_json::from_slice(&snapshot_bytes)
        .map_err(|error| ApiError::bad_request(format!("invalid_fms_snapshot: {error}")))?;
    let restored_display_presentation = restore_display_presentation(
        persisted.display_presentation_schema_version,
        &persisted.display_presentation,
    )
    .map_err(|error| {
        ApiError::bad_request(format!(
            "invalid_fms_snapshot: unsupported or invalid persisted display presentation ({error})"
        ))
    })?;
    let imported_snapshot: SessionStateResponse = persisted.clone().into();
    let active_snapshot = state.current_live_state.read().await.clone();
    let compatibility = session_restore_compatibility(active_snapshot.as_ref(), &imported_snapshot);
    let mut warnings = preflight.inspection.warnings.clone();
    warnings.extend(compatibility.warnings());

    if matches!(req.restore_mode, SessionRestoreMode::Resume) {
        return Err(ApiError::conflict(
            "checkpoint_restore_unsupported: this runtime cannot restore an FMS checkpoint",
        ));
    }

    // Validate the accepted closure against the exact snapshot bytes from the
    // archive before any presentation/reference normalization can rewrite
    // identity-bearing fields.
    validate_imported_accepted_provenance(&preflight, &persisted)?;
    if persisted.metadata.as_ref().is_some_and(|metadata| metadata.get("accepted_definition_projection").is_some()) {
        warnings.push(ACCEPTED_PROJECTION_WARNING.into());
    }
    // An archive cannot supply the private, importer-issued geometry proof.
    if let Some(metadata) = persisted.metadata.as_deref_mut().and_then(serde_json::Value::as_object_mut) {
        metadata.remove("imported_antenna_mesh_proof");
    }
    antenna_import::normalize_registered_refs(&mut persisted, &preflight)?;
    normalize_imported_read_only(&mut persisted);
    // Replace any archive-supplied marker with the reference just validated by
    // the canonical importer. It pins subsequent cold reads to this closure.
    if let Some(reference) = preflight.session.accepted_provenance_ref.as_ref() {
        let metadata = persisted.metadata.get_or_insert_with(|| serde_json::json!({}).into());
        let metadata = metadata.as_object_mut().ok_or_else(|| ApiError::bad_request("invalid_fms_snapshot: accepted metadata must be an object"))?;
        metadata.insert("imported_accepted_evidence".into(), serde_json::json!({
            "run_id":reference.accepted_run_id,"closure_sha256":reference.closure_sha256
        }));
    } else if let Some(metadata) = persisted.metadata.as_deref_mut().and_then(serde_json::Value::as_object_mut) {
        metadata.remove("imported_accepted_evidence");
    }
    let import_id = format!(
        "{}-{}",
        safe_import_session_id(&preflight.session.session_id),
        crate::uuid_v4_hex()
    );
    let published_root = session_store_root(&state).join("imports").join(&import_id);
    persisted.session.script_path = published_root.join("project/main.py").display().to_string();
    let restored_artifact_dir = published_root
        .join("runs")
        .join(&persisted.session.run_id)
        .join("artifacts")
        .display()
        .to_string();
    persisted.session.artifact_dir = restored_artifact_dir.clone();
    if let Some(run) = persisted.run.as_mut() {
        run.artifact_dir = restored_artifact_dir;
    }
    let mut restored: SessionStateResponse = persisted.clone().into();
    validate_imported_snapshot_run(&preflight, &persisted)?;
    restored.imported_antenna_mesh_proof = antenna_mesh_import::issue(
        &restored, preflight.session.accepted_provenance_ref.as_ref(),
        &session_store_root(&state).join("imports"), &published_root,
    )?;
    let restored_ui_state = preflight.read_document("project/ui_state.json")
        .map_err(|error| ApiError::bad_request(format!("invalid_fms_ui_state: {error}")))
        .map(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())?;

    // Publishing an imported workspace replaces the mutable `current` root.
    // Revalidate the request identity after preflight and keep the transition
    // fence until the replacement and its realtime publication are complete.
    // An import into an empty workspace has no request context to validate,
    // but it still must be serialized against other session transitions.
    let _transition = state.current_live_session_transition.lock().await;
    if let Some(context) = request_context {
        crate::validate_current_live_request_context(&state, context).await?;
    }
    publish_imported_session(&state, &preflight, &persisted, &import_id)?;

    // Drop queues, replay, and other session-owned side channels before the
    // imported snapshot becomes visible. The imported presentation below then
    // repopulates the workspace-specific stores from the archive.
    crate::reset_current_live_session_resources(&state).await;
    {
        let mut current = state.current_live_state.write().await;
        state
            .current_live_session_epoch
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        *current = Some(restored.clone());
    }
    {
        let mut selection = state.current_display_selection.write().await;
        *selection = restored.display_selection.clone();
    }
    {
        let mut presentation = state.current_display_presentation.write().await;
        *presentation = restored_display_presentation;
    }
    {
        let mut selection = state.current_workspace_selection.write().await;
        *selection = persisted.workspace_selection.clone();
    }
    {
        let mut ribbon = state.current_workspace_ribbon.write().await;
        *ribbon = persisted.workspace_ribbon.clone();
    }
    {
        let mut layout = state.current_workspace_layout.write().await;
        *layout = persisted.workspace_layout.clone();
    }
    let realtime_state = current_live_realtime_state_from_snapshot(
        &state,
        &restored,
        restored.display_selection.revision,
    )
    .await;
    publish_current_live_realtime_batch_changed(&state, &realtime_state, false, 0).await?;

    Ok(Json(SessionImportCommitResponse {
        session_id: preflight.session.session_id.clone(),
        restore_mode: req.restore_mode,
        restore_class: preflight.inspection.restore_class,
        warnings,
        compatibility,
        ui_state: restored_ui_state,
    }))
}

/// `GET /v2/sessions/current/persistence/checkpoints`
pub(crate) async fn list_checkpoints_with_context(
    State(state): State<Arc<AppState>>,
    context: Option<&crate::types::CurrentLiveRequestContext>,
) -> Result<Json<CheckpointListResponse>, ApiError> {
    let (run_id, current) = {
        let _transition = if context.is_some() {
            Some(state.current_live_session_transition.lock().await)
        } else {
            None
        };
        let guard = state.current_live_state.read().await;
        let snapshot = guard
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active workspace"))?;
        if let Some(context) = context {
            crate::ensure_current_live_request_context(
                snapshot,
                context,
                state
                    .current_live_session_epoch
                    .load(std::sync::atomic::Ordering::Acquire),
            )?;
        }
        (
            snapshot.session.run_id.clone(),
            checkpoint_context_from_snapshot(snapshot, 0),
        )
    };
    let store = open_store(&state)?;

    let checkpoints = store
        .list_checkpoints(&run_id)
        .map_err(|e| ApiError::internal(e.to_string()))?;

    if let Some(context) = context {
        let _transition = state.current_live_session_transition.lock().await;
        crate::validate_current_live_request_context(&state, context).await?;
    }

    let checkpoints = checkpoints
        .into_iter()
        .map(|checkpoint| checkpoint_entry(checkpoint, &current, None))
        .collect();

    Ok(Json(CheckpointListResponse { checkpoints }))
}

/// `GET /v2/sessions/current/persistence/checkpoints/{checkpoint_id}`
pub(crate) async fn get_checkpoint_with_context(
    State(state): State<Arc<AppState>>,
    checkpoint_id: String,
    context: Option<&crate::types::CurrentLiveRequestContext>,
) -> Result<Json<CheckpointEntry>, ApiError> {
    let (run_id, current) = {
        let _transition = if context.is_some() {
            Some(state.current_live_session_transition.lock().await)
        } else {
            None
        };
        let guard = state.current_live_state.read().await;
        let snapshot = guard
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active workspace"))?;
        if let Some(context) = context {
            crate::ensure_current_live_request_context(
                snapshot,
                context,
                state
                    .current_live_session_epoch
                    .load(std::sync::atomic::Ordering::Acquire),
            )?;
        }
        (
            snapshot.session.run_id.clone(),
            checkpoint_context_from_snapshot(snapshot, 0),
        )
    };
    // Inspect committed checkpoint bytes without acquiring a recovery writer lease.
    let root = session_store_root(&state);
    if !root
        .try_exists()
        .map_err(|error| ApiError::internal(error.to_string()))?
    {
        return Err(ApiError::not_found("checkpoint not found"));
    }
    let store = SessionStore::open_existing(root)
        .map_err(|error| ApiError::internal(error.to_string()))?;

    let checkpoint = read_checkpoint_for_run(&store, &run_id, &checkpoint_id)?;
    if let Some(context) = context {
        let _transition = state.current_live_session_transition.lock().await;
        crate::validate_current_live_request_context(&state, context).await?;
    }
    Ok(Json(checkpoint_entry(checkpoint, &current, None)))
}

/// `POST /v2/sessions/current/persistence/checkpoints`
pub(crate) async fn create_checkpoint(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CheckpointCreateRequest>,
) -> Result<Json<CheckpointCreateResponse>, ApiError> {
    create_checkpoint_with_context(State(state), Json(req), None).await
}

pub(crate) async fn create_checkpoint_with_context(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CheckpointCreateRequest>,
    request_context: Option<&crate::types::CurrentLiveRequestContext>,
) -> Result<Json<CheckpointCreateResponse>, ApiError> {
    // Pin the session identity across the synchronous capture and the final
    // state publication. The legacy wrapper remains available for internal
    // callers that have not yet migrated to the request-context contract.
    let _transition = if request_context.is_some() {
        Some(state.current_live_session_transition.lock().await)
    } else {
        None
    };
    if let Some(context) = request_context {
        crate::validate_current_live_request_context(&state, context).await?;
    }
    let store = open_store(&state)?;

    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active workspace"))?;
    if let Some(context) = request_context {
        crate::ensure_current_live_request_context(
            snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
    }
    if let Some(expected_state_version) = req.expected_state_version {
        if snapshot.state_version != expected_state_version {
            return Err(ApiError::conflict(format!(
                "checkpoint_capture_stale_state: expected state version {expected_state_version}, found {}",
                snapshot.state_version
            )));
        }
    }
    let capture_state_version = snapshot.state_version;
    let capture_run_id = snapshot.session.run_id.clone();
    let capture_stage_index = snapshot
        .stage_execution
        .as_ref()
        .and_then(|stage| stage.active_stage_index);
    let capture_field_catalog_revision = snapshot.field_catalog_revision;
    let capture_field_samples_revision = snapshot.field_samples_revision;

    let provider = LiveCheckpointProvider::from_snapshot(snapshot)?;
    let mut context =
        checkpoint_context_from_active_stage(snapshot, provider.vector_count() as u64);
    let request = CaptureRequest {
        run_id: snapshot.session.run_id.clone(),
        profile: req.profile,
        field_policy: FieldCapturePolicy::PrimaryOnly,
    };
    let capture = capture_checkpoint(&store, &provider, &request)
        .map_err(|error| ApiError::internal(format!("capturing checkpoint: {error}")))?;
    context.checksum = capture.common_state.magnetization_ref.clone();
    let checkpoint_id = capture.checkpoint.checkpoint_id.clone();
    let artifact_ref = capture.checkpoint.common_state_ref.clone();
    drop(guard);

    let mut guard = state.current_live_state.write().await;
    let current_snapshot = guard
        .as_mut()
        .ok_or_else(|| ApiError::not_found("no active workspace"))?;
    if let Some(context) = request_context {
        crate::ensure_current_live_request_context(
            current_snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
    }
    if current_snapshot.session.run_id != capture_run_id
        || current_snapshot.state_version != capture_state_version
        || current_snapshot
            .stage_execution
            .as_ref()
            .and_then(|stage| stage.active_stage_index)
            != capture_stage_index
        || current_snapshot.field_catalog_revision != capture_field_catalog_revision
        || current_snapshot.field_samples_revision != capture_field_samples_revision
    {
        return Err(ApiError::conflict(
            "checkpoint_capture_stale_state: session state mutated during capture",
        ));
    }
    let changed = link_active_stage_checkpoint_preserved(
        current_snapshot,
        &checkpoint_id,
        Some(&artifact_ref),
    );
    let changed_snapshot = if changed {
        current_snapshot.state_version = current_snapshot.state_version.saturating_add(1);
        Some(current_snapshot.clone())
    } else {
        None
    };
    drop(guard);

    if let Some(snapshot) = changed_snapshot {
        let realtime_state = current_live_realtime_state_from_snapshot(
            &state,
            &snapshot,
            snapshot.display_selection.revision,
        )
        .await;
        publish_current_live_realtime_batch_changed(&state, &realtime_state, false, 0).await?;
    }

    Ok(Json(CheckpointCreateResponse {
        checkpoint: checkpoint_entry(capture.checkpoint, &context, req.reason),
    }))
}

/// `DELETE /v2/sessions/current/persistence/checkpoints/{checkpoint_id}`
///
/// Removes one checkpoint of the current session's run. Fail-closed: a
/// checkpoint that a stage record uses as restore source or loaded state, or
/// that the run manifest names as its latest checkpoint, is refused with 409.
/// Only the checkpoint-owned files go; CAS objects are reclaimed by the
/// store's reviewed GC, never here.
pub(crate) async fn delete_checkpoint_with_context(
    State(state): State<Arc<AppState>>,
    checkpoint_id: String,
    context: Option<&crate::types::CurrentLiveRequestContext>,
) -> Result<axum::http::StatusCode, ApiError> {
    let _transition = if context.is_some() {
        Some(state.current_live_session_transition.lock().await)
    } else {
        None
    };
    if let Some(context) = context {
        crate::validate_current_live_request_context(&state, context).await?;
    }
    let store = open_store(&state)?;

    let mut guard = state.current_live_state.write().await;
    let snapshot = guard
        .as_mut()
        .ok_or_else(|| ApiError::not_found("no active workspace"))?;
    if let Some(context) = context {
        crate::ensure_current_live_request_context(
            snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
    }
    let run_id = snapshot.session.run_id.clone();
    let checkpoint = read_checkpoint_for_run(&store, &run_id, &checkpoint_id)?;

    if let Some(stage_execution) = snapshot.stage_execution.as_ref() {
        for (index, record) in stage_execution.stages.iter().enumerate() {
            let restore_source = record.resume_from_checkpoint_ref.as_deref()
                == Some(checkpoint_id.as_str());
            let loaded_state = record.loaded_state_ref.as_deref()
                == Some(checkpoint.common_state_ref.as_str());
            if restore_source || loaded_state {
                return Err(ApiError::conflict(format!(
                    "checkpoint_delete_referenced: checkpoint {checkpoint_id} is the restore source of {}",
                    stage_id_for_index(index)
                )));
            }
        }
    }

    match store.delete_checkpoint(&run_id, &checkpoint_id) {
        Ok(true) => {}
        // Removed by a concurrent writer between the read and the lease.
        Ok(false) => return Err(ApiError::not_found("checkpoint not found")),
        Err(error) => {
            return Err(
                if error
                    .downcast_ref::<fullmag_session::CheckpointStillReferenced>()
                    .is_some()
                {
                    ApiError::conflict(format!("checkpoint_delete_referenced: {error}"))
                } else {
                    ApiError::internal(format!("deleting checkpoint: {error}"))
                },
            );
        }
    }

    // The stage that saved the checkpoint no longer has a file to point at.
    if let Some(stage_execution) = snapshot.stage_execution.as_mut() {
        for record in &mut stage_execution.stages {
            if record.checkpoint_ref.as_deref() == Some(checkpoint_id.as_str()) {
                record.checkpoint_ref = None;
                record
                    .artifact_refs
                    .retain(|artifact| artifact != &checkpoint.common_state_ref);
                if record.state_transition_kind.as_deref() == Some("save_checkpoint") {
                    record.state_transition = None;
                    record.state_transition_kind = None;
                    record.state_transition_reason = None;
                    record.state_transition_ui_presentation = None;
                }
            }
        }
    }
    // The catalogue's revision: clients refetch when the session state advances.
    snapshot.state_version = snapshot.state_version.saturating_add(1);
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// `POST /v2/sessions/current/persistence/checkpoints/{checkpoint_id}/restore`
pub(crate) async fn restore_checkpoint(
    State(state): State<Arc<AppState>>,
    checkpoint_id: String,
    Json(req): Json<CheckpointRestoreRequest>,
) -> Result<Json<CheckpointRestoreResponse>, ApiError> {
    restore_checkpoint_with_context(State(state), checkpoint_id, Json(req), None).await
}

pub(crate) async fn restore_checkpoint_with_context(
    State(state): State<Arc<AppState>>,
    checkpoint_id: String,
    Json(req): Json<CheckpointRestoreRequest>,
    context: Option<&crate::types::CurrentLiveRequestContext>,
) -> Result<Json<CheckpointRestoreResponse>, ApiError> {
    // Keep the transition fence while loading and applying the checkpoint so
    // a replacement of the `current` workspace cannot receive stale data.
    let _transition = if context.is_some() {
        Some(state.current_live_session_transition.lock().await)
    } else {
        None
    };
    if let Some(context) = context {
        crate::validate_current_live_request_context(&state, context).await?;
    }
    let store = open_store(&state)?;

    let mut guard = state.current_live_state.write().await;
    let snapshot = guard
        .as_mut()
        .ok_or_else(|| ApiError::not_found("no active workspace"))?;
    if let Some(context) = context {
        crate::ensure_current_live_request_context(
            snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
    }
    if let Some(expected_state_version) = req.expected_state_version {
        if snapshot.state_version != expected_state_version {
            return Err(ApiError::conflict(format!(
                "checkpoint_restore_stale_state: expected state version {expected_state_version}, found {}",
                snapshot.state_version
            )));
        }
    }
    let run_id = snapshot.session.run_id.clone();
    let checkpoint = read_checkpoint_for_run(&store, &run_id, &checkpoint_id)?;
    let resume_unsupported_reason = checkpoint_resume_unsupported_reason(snapshot);
    if let Some(reason) = resume_unsupported_reason
        .as_deref()
        .or_else(|| checkpoint_schema_resume_unsupported_reason(&checkpoint))
    {
        return Err(ApiError::conflict(reason));
    }
    let common_state = read_checkpoint_common_state(&store, &checkpoint)?;
    let magnetization = read_checkpoint_magnetization(&store, &common_state)?;
    let coupled_checkpoint = read_checkpoint_coupled_state(&store, &checkpoint)?;
    if snapshot.coupled_checkpoint.is_some() && coupled_checkpoint.is_none() {
        return Err(ApiError::bad_request(
            "legacy magnetization-only checkpoint cannot resume an active coupled M3 runtime",
        ));
    }
    match (
        snapshot.coupled_checkpoint.as_ref(),
        coupled_checkpoint.as_ref(),
    ) {
        (Some(active), Some(candidate))
            if active["schema"].as_str()
                == Some(fullmag_runner::constraints::FROZEN_SPINS_CHECKPOINT_SCHEMA)
                && candidate["schema"].as_str()
                    == Some(fullmag_runner::constraints::FROZEN_SPINS_CHECKPOINT_SCHEMA) =>
        {
            validate_frozen_checkpoint_restore(
                active,
                candidate,
                &magnetization,
                common_state.time_s,
                common_state.dt,
            )?
        }
        (Some(active), Some(candidate))
            if active["schema"].as_str()
                == Some(fullmag_runner::constraints::FROZEN_SPINS_CHECKPOINT_SCHEMA)
                || candidate["schema"].as_str()
                    == Some(fullmag_runner::constraints::FROZEN_SPINS_CHECKPOINT_SCHEMA) =>
        {
            return Err(ApiError::bad_request(
                "FDM checkpoint constraint schema cannot change during restore",
            ));
        }
        (Some(active), Some(candidate)) => validate_coupled_checkpoint_restore(
            snapshot,
            active,
            candidate,
            &magnetization,
            common_state.time_s,
            common_state.dt,
        )?,
        (None, Some(_)) => {
            return Err(ApiError::bad_request(
                "coupled M3 checkpoint cannot resume a runtime without active coupled identity",
            ));
        }
        _ => {}
    }
    validate_checkpoint_restore_shape(snapshot, magnetization.len())?;

    let restore_class = supported_checkpoint_restore_class(
        &checkpoint,
        &checkpoint_compatibility(snapshot),
        resume_unsupported_reason.as_deref(),
    );
    if restore_class != fullmag_session::RestoreClass::ExactResume {
        return Err(ApiError::conflict(format!(
            "checkpoint_restore_requires_exact_resume: checkpoint is classified as {restore_class:?}"
        )));
    }
    let flat_magnetization = flatten_magnetization(&magnetization);
    let live_state = snapshot
        .live_state
        .as_mut()
        .ok_or_else(|| ApiError::bad_request("checkpoint restore requires live state"))?;
    live_state.latest_step.step = common_state.step;
    live_state.latest_step.time = common_state.time_s;
    live_state.latest_step.dt = common_state.dt;
    live_state.latest_step.e_ex = common_state.energies.exchange;
    live_state.latest_step.e_demag = common_state.energies.demag;
    live_state.latest_step.e_ext = common_state.energies.zeeman;
    live_state.latest_step.e_ani = common_state.energies.anisotropy;
    live_state.latest_step.e_dmi = common_state.energies.dmi;
    live_state.latest_step.e_rotated_dmi = common_state.energies.rotated_dmi;
    live_state.latest_step.e_total = common_state.energies.total;
    live_state.latest_step.magnetization = Some(flat_magnetization);
    snapshot.coupled_checkpoint = coupled_checkpoint;
    live_state.status = "paused".to_string();
    live_state.updated_at_unix_ms = now_unix_ms();
    let loaded_state_ref = checkpoint.common_state_ref.clone();
    link_active_stage_checkpoint_restored(snapshot, &checkpoint_id, Some(&loaded_state_ref));
    snapshot.state_version = snapshot.state_version.saturating_add(1);
    snapshot.field_catalog_revision = if snapshot.field_catalog_revision == 0 {
        1
    } else {
        snapshot.field_catalog_revision.saturating_add(1)
    };
    let next_quantity_revision = snapshot
        .field_quantity_revisions
        .get("m")
        .copied()
        .map(|revision| revision.saturating_add(1))
        .unwrap_or(2);
    snapshot
        .field_quantity_revisions
        .insert("m".to_string(), next_quantity_revision);
    snapshot.field_samples_revision = if snapshot.field_samples_revision == 0 {
        next_quantity_revision
    } else {
        snapshot
            .field_samples_revision
            .max(next_quantity_revision)
            .saturating_add(1)
    };
    let field_revision = field_revision(snapshot);
    let context = checkpoint_context_from_active_stage(snapshot, magnetization.len() as u64);
    let restored_snapshot = snapshot.clone();
    drop(guard);

    let realtime_state = current_live_realtime_state_from_snapshot(
        &state,
        &restored_snapshot,
        restored_snapshot.display_selection.revision,
    )
    .await;
    publish_current_live_realtime_batch_changed(&state, &realtime_state, false, 0).await?;

    Ok(Json(CheckpointRestoreResponse {
        checkpoint: checkpoint_entry(checkpoint, &context, req.reason),
        restore_class,
        restored_vector_count: magnetization.len() as u64,
        field_revision,
        warnings: Vec::new(),
    }))
}

/// `POST /v2/sessions/current/persistence/field-states/exports`
pub(crate) async fn export_field_state(
    State(state): State<Arc<AppState>>,
    Json(req): Json<FieldStateExportRequest>,
) -> Result<Json<FieldStateExportResponse>, ApiError> {
    export_field_state_with_context(State(state), Json(req), None).await
}

pub(crate) async fn export_field_state_with_context(
    State(state): State<Arc<AppState>>,
    Json(req): Json<FieldStateExportRequest>,
    request_context: Option<&crate::types::CurrentLiveRequestContext>,
) -> Result<Json<FieldStateExportResponse>, ApiError> {
    let export_format = normalize_field_state_export_format(&req.format)?;
    validate_supported_field_state_export(&req)?;
    let file_name = sanitize_field_state_file_name(req.file_name.as_deref(), &req)?;
    let repo_root = state.repo_root.clone();

    let _transition = if request_context.is_some() {
        Some(state.current_live_session_transition.lock().await)
    } else {
        None
    };
    if let Some(context) = request_context {
        crate::validate_current_live_request_context(&state, context).await?;
    }

    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active workspace"))?;
    if let Some(context) = request_context {
        crate::ensure_current_live_request_context(
            snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
    }
    let latest = snapshot
        .live_state
        .as_ref()
        .map(|state| &state.latest_step)
        .ok_or_else(|| ApiError::bad_request("field-state export requires live state"))?;
    let values = latest
        .magnetization
        .as_deref()
        .ok_or_else(|| ApiError::bad_request("field-state export requires live magnetization"))?;
    if values.len() % 3 != 0 {
        return Err(ApiError::bad_request(
            "live magnetization length must be divisible by 3",
        ));
    }
    let vectors = values
        .chunks_exact(3)
        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
        .collect::<Vec<_>>();
    if vectors.is_empty() {
        return Err(ApiError::bad_request(
            "field-state export requires at least one magnetization vector",
        ));
    }
    let artifact_dir = std::path::PathBuf::from(&snapshot.session.artifact_dir);
    let field_revision = field_revision(snapshot);
    let artifact = FieldStateJsonArtifact {
        fullmag_kind: "field_state".to_string(),
        schema_version: 1,
        quantity_id: req.quantity_id.clone(),
        target: req.target.clone(),
        component_count: 3,
        values: vectors,
        source_step: Some(latest.step),
        source_time_s: Some(latest.time),
    };
    drop(guard);

    let artifact_ref = format!("field-states/{file_name}");
    let artifact_path = artifact_dir.join(&artifact_ref);
    if let Some(parent) = artifact_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            ApiError::internal(format!("creating field-state directory: {error}"))
        })?;
    }
    if export_format == "field_state_json" {
        let raw = serde_json::to_vec_pretty(&artifact).map_err(|error| {
            ApiError::internal(format!("serializing field-state artifact: {error}"))
        })?;
        std::fs::write(&artifact_path, raw).map_err(|error| {
            ApiError::internal(format!("writing field-state artifact: {error}"))
        })?;
    } else {
        write_field_state_with_python(&repo_root, &artifact_path, &export_format, &artifact)?;
    }

    let mut guard = state.current_live_state.write().await;
    if let Some(snapshot) = guard.as_mut() {
        if let Some(context) = request_context {
            crate::ensure_current_live_request_context(
                snapshot,
                context,
                state
                    .current_live_session_epoch
                    .load(std::sync::atomic::Ordering::Acquire),
            )?;
        }
        if !snapshot
            .artifacts
            .iter()
            .any(|entry| entry.path == artifact_ref)
        {
            snapshot.artifacts.push(crate::types::ArtifactEntry {
                path: artifact_ref.clone(),
                kind: "field_state".to_string(),
                region_owned_provenance: crate::types::region_owned_artifact_provenance(snapshot),
            });
            snapshot.state_version = snapshot.state_version.saturating_add(1);
        }
    } else if request_context.is_some() {
        return Err(ApiError::not_found("no active workspace"));
    }

    Ok(Json(FieldStateExportResponse {
        artifact_ref,
        target: req.target,
        quantity_id: req.quantity_id,
        format: export_format,
        point_count: artifact.values.len() as u64,
        component_count: artifact.component_count,
        field_revision,
    }))
}

/// `POST /v2/sessions/current/persistence/field-states/imports/inspections`
pub(crate) async fn inspect_field_state(
    State(state): State<Arc<AppState>>,
    Json(req): Json<FieldStateInspectRequest>,
) -> Result<Json<FieldStateInspectResponse>, ApiError> {
    inspect_field_state_with_context(State(state), Json(req), None).await
}

pub(crate) async fn inspect_field_state_with_context(
    State(state): State<Arc<AppState>>,
    Json(req): Json<FieldStateInspectRequest>,
    request_context: Option<&crate::types::CurrentLiveRequestContext>,
) -> Result<Json<FieldStateInspectResponse>, ApiError> {
    if let Some(format) = req.format.as_deref() {
        validate_field_state_json_format(format)?;
    }
    let _transition = if request_context.is_some() {
        Some(state.current_live_session_transition.lock().await)
    } else {
        None
    };
    if let Some(context) = request_context {
        crate::validate_current_live_request_context(&state, context).await?;
    }
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active workspace"))?;
    if let Some(context) = request_context {
        crate::ensure_current_live_request_context(
            snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
    }
    let artifact =
        read_field_state_artifact(&state.repo_root, snapshot, &req.artifact_ref, &req.target)?;
    let mut warnings = Vec::new();
    let mut compatible = true;
    if artifact.quantity_id != req.quantity_id {
        compatible = false;
        warnings.push(format!(
            "artifact quantity '{}' does not match requested quantity '{}'",
            artifact.quantity_id, req.quantity_id
        ));
    }
    if artifact.target.kind != req.target.kind || artifact.target.id != req.target.id {
        compatible = false;
        warnings.push("artifact target does not match requested target".to_string());
    }
    let default_mode = default_field_state_mode(&req.target, &req.quantity_id);
    if default_mode == "apply" {
        if let Err(error) = validate_checkpoint_restore_shape(snapshot, artifact.values.len()) {
            compatible = false;
            warnings.push(error.message);
        }
    }
    let compatibility = if compatible {
        "compatible"
    } else {
        "incompatible"
    }
    .to_string();

    Ok(Json(FieldStateInspectResponse {
        artifact_ref: req.artifact_ref,
        target: req.target,
        quantity_id: req.quantity_id,
        format: "field_state_json".to_string(),
        compatibility,
        default_mode,
        point_count: artifact.values.len() as u64,
        component_count: artifact.component_count,
        warnings,
    }))
}

/// `POST /v2/sessions/current/persistence/field-states/imports`
pub(crate) async fn import_field_state(
    State(state): State<Arc<AppState>>,
    Json(req): Json<FieldStateImportRequest>,
) -> Result<Json<FieldStateImportResponse>, ApiError> {
    import_field_state_with_context(State(state), Json(req), None).await
}

pub(crate) async fn import_field_state_with_context(
    State(state): State<Arc<AppState>>,
    Json(req): Json<FieldStateImportRequest>,
    request_context: Option<&crate::types::CurrentLiveRequestContext>,
) -> Result<Json<FieldStateImportResponse>, ApiError> {
    let mode = req
        .mode
        .clone()
        .unwrap_or_else(|| default_field_state_mode(&req.target, &req.quantity_id));
    let _transition = if request_context.is_some() {
        Some(state.current_live_session_transition.lock().await)
    } else {
        None
    };
    if let Some(context) = request_context {
        crate::validate_current_live_request_context(&state, context).await?;
    }
    if mode == "attach" {
        let mut guard = state.current_live_state.write().await;
        let snapshot = guard
            .as_mut()
            .ok_or_else(|| ApiError::not_found("no active workspace"))?;
        if let Some(context) = request_context {
            crate::ensure_current_live_request_context(
                snapshot,
                context,
                state
                    .current_live_session_epoch
                    .load(std::sync::atomic::Ordering::Acquire),
            )?;
        }
        let artifact =
            read_field_state_artifact(&state.repo_root, snapshot, &req.artifact_ref, &req.target)?;
        validate_field_state_request_match(&artifact, &req.target, &req.quantity_id)?;
        if !snapshot
            .artifacts
            .iter()
            .any(|entry| entry.path == req.artifact_ref)
        {
            snapshot.artifacts.push(crate::types::ArtifactEntry {
                path: req.artifact_ref.clone(),
                kind: "field_state".to_string(),
                region_owned_provenance: crate::types::region_owned_artifact_provenance(snapshot),
            });
            snapshot.state_version = snapshot.state_version.saturating_add(1);
        }
        let field_revision = field_revision(snapshot);
        let restored_snapshot = snapshot.clone();
        drop(guard);

        let realtime_state = current_live_realtime_state_from_snapshot(
            &state,
            &restored_snapshot,
            restored_snapshot.display_selection.revision,
        )
        .await;
        publish_current_live_realtime_batch_changed(&state, &realtime_state, false, 0).await?;

        return Ok(Json(FieldStateImportResponse {
            artifact_ref: req.artifact_ref,
            target: req.target,
            quantity_id: req.quantity_id,
            mode,
            applied_point_count: 0,
            field_revision,
            warnings: Vec::new(),
        }));
    }
    if mode != "apply" {
        return Err(ApiError::bad_request(
            "field-state import mode must be 'apply' or 'attach'",
        ));
    }
    if req.quantity_id != "m" || req.target.kind != "object" {
        return Err(ApiError::bad_request(
            "field-state apply currently supports object quantity 'm'",
        ));
    }

    let mut guard = state.current_live_state.write().await;
    let snapshot = guard
        .as_mut()
        .ok_or_else(|| ApiError::not_found("no active workspace"))?;
    if let Some(context) = request_context {
        crate::ensure_current_live_request_context(
            snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
    }
    let artifact =
        read_field_state_artifact(&state.repo_root, snapshot, &req.artifact_ref, &req.target)?;
    validate_field_state_request_match(&artifact, &req.target, &req.quantity_id)?;
    validate_checkpoint_restore_shape(snapshot, artifact.values.len())?;
    let live_state = snapshot
        .live_state
        .as_mut()
        .ok_or_else(|| ApiError::bad_request("field-state apply requires live state"))?;
    live_state.latest_step.magnetization = Some(flatten_magnetization(&artifact.values));
    live_state.status = "paused".to_string();
    live_state.updated_at_unix_ms = now_unix_ms();
    snapshot.state_version = snapshot.state_version.saturating_add(1);
    bump_live_field_revisions(snapshot, &req.quantity_id);
    if !snapshot
        .artifacts
        .iter()
        .any(|entry| entry.path == req.artifact_ref)
    {
        snapshot.artifacts.push(crate::types::ArtifactEntry {
            path: req.artifact_ref.clone(),
            kind: "field_state".to_string(),
            region_owned_provenance: crate::types::region_owned_artifact_provenance(snapshot),
        });
    }
    let field_revision = field_revision(snapshot);
    let restored_snapshot = snapshot.clone();
    drop(guard);

    let realtime_state = current_live_realtime_state_from_snapshot(
        &state,
        &restored_snapshot,
        restored_snapshot.display_selection.revision,
    )
    .await;
    publish_current_live_realtime_batch_changed(&state, &realtime_state, false, 0).await?;

    Ok(Json(FieldStateImportResponse {
        artifact_ref: req.artifact_ref,
        target: req.target,
        quantity_id: req.quantity_id,
        mode,
        applied_point_count: artifact.values.len() as u64,
        field_revision,
        warnings: Vec::new(),
    }))
}

/// `GET /v2/sessions/current/persistence/recovery`
pub(crate) async fn list_recovery(
    State(state): State<Arc<AppState>>,
) -> Result<Json<RecoveryListResponse>, ApiError> {
    list_recovery_with_context(State(state), None).await
}

pub(crate) async fn list_recovery_with_context(
    State(state): State<Arc<AppState>>,
    request_context: Option<&crate::types::CurrentLiveRequestContext>,
) -> Result<Json<RecoveryListResponse>, ApiError> {
    // Recovery is stored outside the in-memory live snapshot. When the caller
    // has pinned a current-session context, hold the transition fence through
    // the synchronous store read so a session swap cannot retarget the read.
    let _transition = match request_context {
        Some(_) => Some(state.current_live_session_transition.lock().await),
        None => None,
    };
    if let Some(context) = request_context {
        crate::validate_current_live_request_context(&state, context).await?;
    }
    let store = open_store(&state)?;

    let manifests = match request_context {
        Some(context) => store
            .read_session_recovery(&context.session_id)
            .map(|snapshot| snapshot.into_iter().collect()),
        None => store.list_recovery(),
    };
    let snapshots = manifests
        .map_err(|e| ApiError::internal(e.to_string()))?
        .into_iter()
        .map(|m| RecoveryEntry {
            session_id: m.session_id.clone(),
            name: m.name.clone(),
            saved_at: m.saved_at.to_rfc3339(),
            profile: m.profile,
        })
        .collect();

    Ok(Json(RecoveryListResponse { snapshots }))
}

/// `DELETE /v2/sessions/current/persistence/recovery`
pub(crate) async fn clear_recovery(
    State(state): State<Arc<AppState>>,
) -> Result<Json<RecoveryClearResponse>, ApiError> {
    clear_recovery_with_context(State(state), None).await
}

pub(crate) async fn clear_recovery_with_context(
    State(state): State<Arc<AppState>>,
    request_context: Option<&crate::types::CurrentLiveRequestContext>,
) -> Result<Json<RecoveryClearResponse>, ApiError> {
    // Validate immediately before the destructive store operation. The
    // context-free wrapper remains only for unmigrated internal callers.
    let _transition = match request_context {
        Some(_) => Some(state.current_live_session_transition.lock().await),
        None => None,
    };
    if let Some(context) = request_context {
        crate::validate_current_live_request_context(&state, context).await?;
    }
    let store = open_store(&state)?;

    let before = match request_context {
        Some(context) => store
            .clear_session_recovery(&context.session_id)
            .map_err(|e| ApiError::internal(e.to_string()))?,
        None => {
            let count = store
                .list_recovery()
                .map_err(|e| ApiError::internal(e.to_string()))?
                .len();
            store
                .clear_recovery()
                .map_err(|e| ApiError::internal(e.to_string()))?;
            count
        }
    };

    Ok(Json(RecoveryClearResponse { cleared: before }))
}

#[derive(Clone)]
struct LiveCheckpointProvider {
    step: u64,
    time_s: f64,
    dt: f64,
    energies: SolverEnergies,
    magnetization: Vec<[f64; 3]>,
    compatibility: CheckpointCompatibility,
    coupled_checkpoint: Option<serde_json::Value>,
}

impl LiveCheckpointProvider {
    fn from_snapshot(snapshot: &SessionStateResponse) -> Result<Self, ApiError> {
        let latest = snapshot
            .live_state
            .as_ref()
            .map(|state| &state.latest_step)
            .ok_or_else(|| ApiError::bad_request("checkpoint capture requires live state"))?;
        let magnetization = latest
            .magnetization
            .as_deref()
            .ok_or_else(|| ApiError::bad_request("checkpoint capture requires magnetization"))?;
        if magnetization.len() % 3 != 0 {
            return Err(ApiError::bad_request(
                "checkpoint magnetization length must be divisible by 3",
            ));
        }

        let magnetization = magnetization
            .chunks_exact(3)
            .map(|chunk| [chunk[0], chunk[1], chunk[2]])
            .collect::<Vec<_>>();
        if magnetization.is_empty() {
            return Err(ApiError::bad_request(
                "checkpoint capture requires at least one magnetization vector",
            ));
        }

        if let Some(checkpoint) = snapshot.coupled_checkpoint.as_ref() {
            validate_coupled_checkpoint_value(checkpoint)?;
        }
        Ok(Self {
            step: latest.step,
            time_s: latest.time,
            dt: latest.dt,
            energies: SolverEnergies {
                exchange: latest.e_ex,
                demag: latest.e_demag,
                zeeman: latest.e_ext,
                anisotropy: latest.e_ani,
                dmi: latest.e_dmi,
                rotated_dmi: latest.e_rotated_dmi,
                total: latest.e_total,
            },
            magnetization,
            compatibility: checkpoint_compatibility(snapshot),
            coupled_checkpoint: snapshot.coupled_checkpoint.clone(),
        })
    }

    fn vector_count(&self) -> usize {
        self.magnetization.len()
    }
}

impl CheckpointSnapshotProvider for LiveCheckpointProvider {
    fn step(&self) -> u64 {
        self.step
    }

    fn time_s(&self) -> f64 {
        self.time_s
    }

    fn dt(&self) -> f64 {
        self.dt
    }

    fn energies(&self) -> SolverEnergies {
        self.energies.clone()
    }

    fn magnetization(&self) -> anyhow::Result<Vec<[f64; 3]>> {
        Ok(self.magnetization.clone())
    }

    fn auxiliary_fields(
        &self,
        _policy: FieldCapturePolicy,
    ) -> anyhow::Result<Vec<(String, Vec<[f64; 3]>)>> {
        Ok(Vec::new())
    }

    fn backend_state_payload(
        &self,
    ) -> anyhow::Result<Option<fullmag_session::BackendStatePayload>> {
        let Some(checkpoint) = self.coupled_checkpoint.clone() else {
            return Ok(None);
        };
        let is_frozen_spins = checkpoint["schema"].as_str()
            == Some(fullmag_runner::constraints::FROZEN_SPINS_CHECKPOINT_SCHEMA);
        let (integrator_kind, rng_state, checkpoint_schema) = if is_frozen_spins {
            (
                "frozen_spins",
                None,
                fullmag_runner::constraints::FROZEN_SPINS_CHECKPOINT_SCHEMA,
            )
        } else {
            let thermal_counter = checkpoint["thermal_counter"].as_u64().unwrap_or(0);
            (
                "coupled_imex_ark2",
                Some(fullmag_session::RngState {
                    global_seed: checkpoint["thermal_seed"].as_u64().unwrap_or(0),
                    stream_family: checkpoint["thermal_rng_algorithm"]
                        .as_str()
                        .unwrap_or("unknown")
                        .to_string(),
                    counter_base: thermal_counter,
                    substream_per_cell: Some(true),
                    last_consumed_nonce: thermal_counter,
                }),
                "fullmag.fdm.coupled_m3_checkpoint.v1",
            )
        };
        let backend_family = match self.compatibility.runtime_family.as_deref() {
            Some(family) if !family.is_empty() => family.to_string(),
            _ => "fdm_cpu_reference".to_string(),
        };
        Ok(Some(fullmag_session::BackendStatePayload {
            format: "fullmag.backend_state.v1".into(),
            backend_family: backend_family.into(),
            integrator_kind: Some(integrator_kind.into()),
            integrator_state: Some(checkpoint),
            rng_state,
            extra: serde_json::json!({"checkpoint_schema": checkpoint_schema}),
        }))
    }

    fn compatibility(&self) -> CheckpointCompatibility {
        self.compatibility.clone()
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct CoupledM3CheckpointIdentity {
    requested_discretization: String,
    requested_device: String,
    requested_precision: String,
    requested_execution_mode: String,
    resolved_discretization: String,
    resolved_device: String,
    resolved_precision: String,
    resolved_execution_mode: String,
    scene_revision: u64,
    plan_revision: u64,
    mesh_revision: u64,
    material_revision: u64,
    current_operator_revision: u64,
    spin_operator_revision: u64,
    oersted_operator_revision: u64,
    charge_cache_identity: String,
    spin_cache_identity: String,
    oersted_cache_identity: String,
    source_identity: String,
}

#[derive(Debug, Clone, Deserialize)]
struct CoupledM3CheckpointPayload {
    schema: String,
    problem_ir_abi: String,
    scalar_layout: String,
    vector_layout: String,
    endianness: String,
    formula_version: String,
    integrator_version: String,
    integrator_implementation_revision: String,
    identity: CoupledM3CheckpointIdentity,
    magnetization: Vec<[f64; 3]>,
    time_s: f64,
    previous_dt_s: f64,
    thermal_rng_algorithm: String,
    thermal_seed: u64,
}

fn parse_coupled_checkpoint(
    value: &serde_json::Value,
) -> Result<CoupledM3CheckpointPayload, ApiError> {
    serde_json::from_value(value.clone()).map_err(|error| {
        ApiError::bad_request(format!("invalid coupled M3 checkpoint payload: {error}"))
    })
}

fn validate_coupled_checkpoint_value(value: &serde_json::Value) -> Result<(), ApiError> {
    if value["schema"].as_str() == Some(fullmag_runner::constraints::FROZEN_SPINS_CHECKPOINT_SCHEMA)
    {
        let vector_count = value["magnetization"]
            .as_array()
            .map(Vec::len)
            .ok_or_else(|| ApiError::bad_request("Frozen Spins checkpoint has no magnetization"))?;
        return fullmag_runner::validate_frozen_spins_checkpoint_value(value, vector_count)
            .map_err(|error| ApiError::bad_request(error.message));
    }
    let payload = parse_coupled_checkpoint(value)?;
    fullmag_runner::validate_coupled_m3_checkpoint_value(value, payload.magnetization.len())
        .map_err(|error| ApiError::bad_request(error.message))
}

fn validate_coupled_checkpoint_restore(
    snapshot: &SessionStateResponse,
    active_value: &serde_json::Value,
    candidate_value: &serde_json::Value,
    common_magnetization: &[[f64; 3]],
    common_time_s: f64,
    common_dt_s: f64,
) -> Result<(), ApiError> {
    fullmag_runner::validate_coupled_m3_checkpoint_value(active_value, common_magnetization.len())
        .map_err(|error| ApiError::bad_request(error.message))?;
    fullmag_runner::validate_coupled_m3_checkpoint_value(
        candidate_value,
        common_magnetization.len(),
    )
    .map_err(|error| ApiError::bad_request(error.message))?;
    let active = parse_coupled_checkpoint(active_value)?;
    let candidate = parse_coupled_checkpoint(candidate_value)?;
    validate_active_coupled_identity(snapshot, &active.identity)?;
    compare_coupled_identity(&candidate.identity, &active.identity)?;
    compare_coupled_contract(&candidate, &active)?;
    if candidate.magnetization != common_magnetization
        || candidate.time_s != common_time_s
        || candidate.previous_dt_s != common_dt_s
    {
        return Err(ApiError::bad_request(
            "coupled M3 checkpoint disagrees with common solver state",
        ));
    }
    fullmag_runner::compare_coupled_m3_checkpoint_module_identity_values(
        candidate_value,
        active_value,
    )
    .map_err(|error| ApiError::bad_request(error.message))
}

fn validate_frozen_checkpoint_restore(
    active_value: &serde_json::Value,
    candidate_value: &serde_json::Value,
    common_magnetization: &[[f64; 3]],
    common_time_s: f64,
    common_dt_s: f64,
) -> Result<(), ApiError> {
    fullmag_runner::validate_frozen_spins_checkpoint_value(
        active_value,
        common_magnetization.len(),
    )
    .map_err(|error| ApiError::bad_request(error.message))?;
    fullmag_runner::validate_frozen_spins_checkpoint_value(
        candidate_value,
        common_magnetization.len(),
    )
    .map_err(|error| ApiError::bad_request(error.message))?;
    let active: fullmag_runner::constraints::FrozenSpinsCheckpointV1 =
        serde_json::from_value(active_value.clone()).map_err(|error| {
            ApiError::bad_request(format!("invalid Frozen Spins checkpoint payload: {error}"))
        })?;
    let candidate: fullmag_runner::constraints::FrozenSpinsCheckpointV1 =
        serde_json::from_value(candidate_value.clone()).map_err(|error| {
            ApiError::bad_request(format!("invalid Frozen Spins checkpoint payload: {error}"))
        })?;
    if active.constraint_ids != candidate.constraint_ids
        || active.authored_fingerprints != candidate.authored_fingerprints
        || active.activation != candidate.activation
        || active.mask_len != candidate.mask_len
        || active.mask_bits != candidate.mask_bits
        || active.mask_sha256 != candidate.mask_sha256
        || active.reference != candidate.reference
        || active.reference_sha256 != candidate.reference_sha256
        || active.active_dof_count != candidate.active_dof_count
        || active.frozen_dof_count != candidate.frozen_dof_count
        || active.free_dof_count != candidate.free_dof_count
        || active.backend != candidate.backend
        || active.device != candidate.device
        || active.precision != candidate.precision
    {
        return Err(ApiError::bad_request(
            "Frozen Spins checkpoint activation or backend identity mismatch",
        ));
    }
    if candidate.magnetization.as_slice() != common_magnetization
        || candidate.time_s != common_time_s
        || candidate.dt != common_dt_s
    {
        return Err(ApiError::bad_request(
            "Frozen Spins checkpoint disagrees with common solver state",
        ));
    }
    Ok(())
}

fn validate_active_coupled_identity(
    snapshot: &SessionStateResponse,
    identity: &CoupledM3CheckpointIdentity,
) -> Result<(), ApiError> {
    let requested_discretization = normalize_discretization(&snapshot.session.requested_backend);
    let resolved_discretization = snapshot
        .session
        .resolved_backend
        .as_deref()
        .map(normalize_discretization)
        .ok_or_else(|| ApiError::bad_request("active session has no resolved discretization"))?;
    let checks = [
        (
            "requested discretization",
            identity.requested_discretization.as_str(),
            requested_discretization.as_str(),
        ),
        (
            "requested device",
            identity.requested_device.as_str(),
            snapshot.session.requested_device.as_str(),
        ),
        (
            "requested precision",
            identity.requested_precision.as_str(),
            snapshot.session.requested_precision.as_str(),
        ),
        (
            "requested execution mode",
            identity.requested_execution_mode.as_str(),
            snapshot.session.requested_mode.as_str(),
        ),
        (
            "resolved discretization",
            identity.resolved_discretization.as_str(),
            resolved_discretization.as_str(),
        ),
        (
            "resolved device",
            identity.resolved_device.as_str(),
            snapshot.session.resolved_device.as_deref().unwrap_or(""),
        ),
        (
            "resolved precision",
            identity.resolved_precision.as_str(),
            snapshot.session.resolved_precision.as_deref().unwrap_or(""),
        ),
        (
            "resolved execution mode",
            identity.resolved_execution_mode.as_str(),
            snapshot.session.resolved_mode.as_deref().unwrap_or(""),
        ),
    ];
    if let Some((label, _, _)) = checks
        .iter()
        .find(|(_, actual, expected)| actual != expected)
    {
        return Err(ApiError::bad_request(format!(
            "active coupled M3 {label} does not match resolved session"
        )));
    }
    Ok(())
}

fn normalize_discretization(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "cpu-fdm" | "fdm-cpu" => "fdm".to_string(),
        other => other.to_string(),
    }
}

fn compare_coupled_identity(
    actual: &CoupledM3CheckpointIdentity,
    expected: &CoupledM3CheckpointIdentity,
) -> Result<(), ApiError> {
    macro_rules! compare {
        ($field:ident, $label:literal) => {
            if actual.$field != expected.$field {
                return Err(ApiError::bad_request(concat!(
                    "coupled M3 checkpoint ",
                    $label,
                    " mismatch"
                )));
            }
        };
    }
    compare!(requested_discretization, "requested discretization");
    compare!(requested_device, "requested device");
    compare!(requested_precision, "requested precision");
    compare!(requested_execution_mode, "requested execution mode");
    compare!(resolved_discretization, "resolved discretization");
    compare!(resolved_device, "resolved device");
    compare!(resolved_precision, "resolved precision");
    compare!(resolved_execution_mode, "resolved execution mode");
    compare!(scene_revision, "scene revision");
    compare!(plan_revision, "plan revision");
    compare!(mesh_revision, "mesh revision");
    compare!(material_revision, "material revision");
    compare!(current_operator_revision, "current operator revision");
    compare!(spin_operator_revision, "spin operator revision");
    compare!(oersted_operator_revision, "Oersted operator revision");
    compare!(charge_cache_identity, "charge cache identity");
    compare!(spin_cache_identity, "spin cache identity");
    compare!(oersted_cache_identity, "Oersted cache identity");
    compare!(source_identity, "source identity");
    Ok(())
}

fn compare_coupled_contract(
    actual: &CoupledM3CheckpointPayload,
    expected: &CoupledM3CheckpointPayload,
) -> Result<(), ApiError> {
    if actual.schema != expected.schema
        || actual.problem_ir_abi != expected.problem_ir_abi
        || actual.scalar_layout != expected.scalar_layout
        || actual.vector_layout != expected.vector_layout
        || actual.endianness != expected.endianness
        || actual.formula_version != expected.formula_version
        || actual.integrator_version != expected.integrator_version
        || actual.integrator_implementation_revision != expected.integrator_implementation_revision
        || actual.thermal_rng_algorithm != expected.thermal_rng_algorithm
        || actual.thermal_seed != expected.thermal_seed
    {
        return Err(ApiError::bad_request(
            "coupled M3 checkpoint contract or RNG identity mismatch",
        ));
    }
    Ok(())
}

struct CheckpointEntryContext {
    backend_family: Option<String>,
    checksum: Option<String>,
    stage_id: Option<String>,
    command_id: Option<String>,
    field_revision: Option<u64>,
    mesh_revision: Option<u64>,
    scene_revision: Option<u64>,
    vector_count: u64,
    resume_unsupported_reason: Option<String>,
}

fn checkpoint_context_from_snapshot(
    snapshot: &SessionStateResponse,
    vector_count: u64,
) -> CheckpointEntryContext {
    CheckpointEntryContext {
        backend_family: snapshot
            .session
            .resolved_runtime_family
            .clone()
            .or_else(|| snapshot.session.resolved_device.clone()),
        checksum: None,
        stage_id: None,
        command_id: None,
        field_revision: Some(field_revision(snapshot)),
        mesh_revision: Some(snapshot.mesh_revision),
        scene_revision: None,
        vector_count,
        resume_unsupported_reason: checkpoint_resume_unsupported_reason(snapshot),
    }
}

fn checkpoint_context_from_active_stage(
    snapshot: &SessionStateResponse,
    vector_count: u64,
) -> CheckpointEntryContext {
    let mut context = checkpoint_context_from_snapshot(snapshot, vector_count);
    if let Some(stage_execution) = snapshot.stage_execution.as_ref() {
        if let Some(index) = stage_execution.active_stage_index {
            context.stage_id = Some(stage_id_for_index(index));
            context.command_id = stage_execution
                .stages
                .get(index)
                .and_then(|record| record.command_id.clone());
        }
    }
    context
}

fn checkpoint_entry(
    checkpoint: fullmag_session::FmsCheckpoint,
    context: &CheckpointEntryContext,
    reason: Option<String>,
) -> CheckpointEntry {
    CheckpointEntry {
        checkpoint_id: checkpoint.checkpoint_id.clone(),
        stage_id: context.stage_id.clone(),
        command_id: context.command_id.clone(),
        run_id: checkpoint.run_id.clone(),
        step: checkpoint.step,
        time_s: checkpoint.time_s,
        dt: checkpoint.dt,
        created_at: checkpoint.created_at.to_rfc3339(),
        source: reason.unwrap_or_else(|| "manual".to_string()),
        format: "fmstate".to_string(),
        vector_count: if context.vector_count > 0 {
            context.vector_count
        } else {
            checkpoint_vector_count(&checkpoint).unwrap_or(0)
        },
        coordinate_frame: "solver_domain".to_string(),
        mesh_revision: context.mesh_revision,
        field_revision: context.field_revision,
        scene_revision: context.scene_revision,
        backend_family: context.backend_family.clone(),
        resume_class: checkpoint_resume_class(&checkpoint, context),
        artifact_ref: checkpoint.common_state_ref,
        checksum: context.checksum.clone(),
    }
}

fn link_active_stage_checkpoint_preserved(
    snapshot: &mut SessionStateResponse,
    checkpoint_id: &str,
    artifact_ref: Option<&str>,
) -> bool {
    link_active_stage_checkpoint(snapshot, |record| {
        let mut changed = set_optional_string(&mut record.checkpoint_ref, checkpoint_id);
        changed |= set_optional_string(&mut record.state_transition, "preserved");
        changed |= set_optional_string(&mut record.state_transition_kind, "save_checkpoint");
        changed |= set_optional_string(&mut record.state_transition_reason, "user_export");
        changed |=
            set_optional_string(&mut record.state_transition_ui_presentation, "boundary_bar");
        if let Some(artifact_ref) = artifact_ref {
            changed |= push_unique_string(&mut record.artifact_refs, artifact_ref);
        }
        changed
    })
}

fn link_active_stage_checkpoint_restored(
    snapshot: &mut SessionStateResponse,
    checkpoint_id: &str,
    loaded_state_ref: Option<&str>,
) -> bool {
    link_active_stage_checkpoint(snapshot, |record| {
        let mut changed =
            set_optional_string(&mut record.resume_from_checkpoint_ref, checkpoint_id);
        changed |= set_optional_string(&mut record.state_transition, "restored");
        changed |= set_optional_string(&mut record.state_transition_kind, "load_state");
        changed |= set_optional_string(&mut record.state_transition_reason, "checkpoint_load");
        changed |= set_optional_string(&mut record.state_transfer_operator_kind, "checkpoint_load");
        changed |=
            set_optional_string(&mut record.state_transition_ui_presentation, "boundary_bar");
        if let Some(loaded_state_ref) = loaded_state_ref {
            changed |= set_optional_string(&mut record.loaded_state_ref, loaded_state_ref);
            changed |= push_unique_string(&mut record.artifact_refs, loaded_state_ref);
        }
        changed
    })
}

fn link_active_stage_checkpoint(
    snapshot: &mut SessionStateResponse,
    update: impl FnOnce(&mut crate::types::StageExecutionRecord) -> bool,
) -> bool {
    let Some(stage_execution) = snapshot.stage_execution.as_mut() else {
        return false;
    };
    let Some(index) = stage_execution.active_stage_index else {
        return false;
    };
    let Some(record) = stage_execution.stages.get_mut(index) else {
        return false;
    };
    update(record)
}

fn set_optional_string(target: &mut Option<String>, value: &str) -> bool {
    if target.as_deref() == Some(value) {
        return false;
    }
    *target = Some(value.to_string());
    true
}

fn push_unique_string(values: &mut Vec<String>, value: &str) -> bool {
    if values.iter().any(|existing| existing == value) {
        return false;
    }
    values.push(value.to_string());
    true
}

fn stage_id_for_index(index: usize) -> String {
    format!("stage-{index:03}")
}

fn checkpoint_vector_count(checkpoint: &fullmag_session::FmsCheckpoint) -> Option<u64> {
    checkpoint
        .compatibility
        .field_layout_signature
        .as_deref()
        .and_then(|signature| {
            signature
                .strip_prefix("magnetization:")
                .and_then(|suffix| suffix.strip_suffix("x3"))
        })
        .and_then(|value| value.parse().ok())
}

fn read_checkpoint_for_run(
    store: &SessionStore,
    run_id: &str,
    checkpoint_id: &str,
) -> Result<fullmag_session::FmsCheckpoint, ApiError> {
    store
        .read_checkpoint(run_id, checkpoint_id)
        .map_err(|error| ApiError::internal(format!("reading checkpoint: {error}")))?
        .ok_or_else(|| ApiError::not_found("checkpoint not found"))
}

fn read_checkpoint_common_state(
    store: &SessionStore,
    checkpoint: &fullmag_session::FmsCheckpoint,
) -> Result<fullmag_session::CommonSolverState, ApiError> {
    let raw = store
        .read_document(&checkpoint.common_state_ref)
        .map_err(|error| ApiError::internal(format!("reading checkpoint state: {error}")))?
        .ok_or_else(|| ApiError::not_found("checkpoint state not found"))?;
    serde_json::from_slice(&raw)
        .map_err(|error| ApiError::internal(format!("parsing checkpoint state: {error}")))
}

fn read_checkpoint_coupled_state(
    store: &SessionStore,
    checkpoint: &fullmag_session::FmsCheckpoint,
) -> Result<Option<serde_json::Value>, ApiError> {
    let Some(reference) = checkpoint.backend_state_ref.as_deref() else {
        return Ok(None);
    };
    let bytes = store
        .read_document(reference)
        .map_err(|error| ApiError::internal(format!("reading checkpoint backend state: {error}")))?
        .ok_or_else(|| ApiError::not_found("checkpoint backend state not found"))?;
    let payload: fullmag_session::BackendStatePayload =
        serde_json::from_slice(&bytes).map_err(|error| {
            ApiError::bad_request(format!("invalid checkpoint backend state: {error}"))
        })?;
    let supported_integrator = matches!(
        payload.integrator_kind.as_deref(),
        Some("coupled_imex_ark2") | Some("frozen_spins")
    );
    let supported_backend = matches!(
        payload.backend_family.as_str(),
        "fdm_cpu_reference" | "fdm_cuda" | "fem_cpu" | "fem_gpu"
    );
    if payload.format != "fullmag.backend_state.v1" || !supported_backend || !supported_integrator {
        return Err(ApiError::bad_request(
            "unsupported backend checkpoint envelope",
        ));
    }
    let state = payload
        .integrator_state
        .ok_or_else(|| ApiError::bad_request("FDM backend checkpoint has no integrator state"))?;
    validate_coupled_checkpoint_value(&state)?;
    Ok(Some(state))
}

fn read_checkpoint_magnetization(
    store: &SessionStore,
    common_state: &fullmag_session::CommonSolverState,
) -> Result<Vec<[f64; 3]>, ApiError> {
    let magnetization_ref = common_state
        .magnetization_ref
        .as_deref()
        .ok_or_else(|| ApiError::bad_request("checkpoint has no magnetization state"))?;
    store
        .load_magnetization(magnetization_ref)
        .map_err(|error| ApiError::internal(format!("loading checkpoint magnetization: {error}")))?
        .ok_or_else(|| ApiError::not_found("checkpoint magnetization not found"))
}

fn validate_checkpoint_restore_shape(
    snapshot: &SessionStateResponse,
    vector_count: usize,
) -> Result<(), ApiError> {
    let current_count = snapshot
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.magnetization.as_ref())
        .map(|values| values.len() / 3)
        .or_else(|| {
            snapshot.live_state.as_ref().and_then(|state| {
                let product = state
                    .latest_step
                    .grid
                    .iter()
                    .try_fold(1usize, |acc, value| {
                        usize::try_from(*value)
                            .ok()
                            .and_then(|item| acc.checked_mul(item))
                    })?;
                (product > 0).then_some(product)
            })
        });

    if current_count.is_some_and(|count| count != vector_count) {
        return Err(ApiError::bad_request(format!(
            "checkpoint vector count {vector_count} does not match active domain vector count {}",
            current_count.unwrap_or_default()
        )));
    }
    Ok(())
}

fn flatten_magnetization(magnetization: &[[f64; 3]]) -> Vec<f64> {
    let mut flat = Vec::with_capacity(magnetization.len() * 3);
    for vector in magnetization {
        flat.extend_from_slice(vector);
    }
    flat
}

fn now_unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn checkpoint_schema_resume_unsupported_reason(
    checkpoint: &fullmag_session::FmsCheckpoint,
) -> Option<&'static str> {
    match checkpoint.compatibility.study_kind.as_deref() {
        Some("fdm_coupled_m3") => Some(fullmag_runner::FDM_CPU_TRANSPORT_EXACT_RESUME_UNSUPPORTED),
        Some(kind) if kind.starts_with("unsupported:") => {
            Some("checkpoint ExactResume is unsupported for this checkpoint schema")
        }
        _ => None,
    }
}

fn checkpoint_resume_unsupported_reason(snapshot: &SessionStateResponse) -> Option<String> {
    let metadata = snapshot.metadata.as_ref();
    let plan_value = metadata.and_then(|metadata| metadata.get("execution_plan"));
    let resolved_transport = plan_value
        .and_then(|value| value["backend_plan"].get("spin_transport_plans"))
        .is_some_and(|plans| plans.as_array().is_none_or(|plans| !plans.is_empty()));
    let authored_transport = metadata
        .and_then(|metadata| {
            metadata
                .get("problem_ir")
                .or_else(|| metadata.get("normalized_problem_ir"))
        })
        .and_then(|problem| problem.get("spin_transport_modules"))
        .is_some_and(|modules| modules.as_array().is_none_or(|modules| !modules.is_empty()));
    // Missing identity fails closed for transport without reparsing large pure
    // magnetic/FEM plans or treating a charge-only current module as spin.
    if resolved_transport || authored_transport {
        match plan_value.and_then(|value| {
            serde_json::from_value::<fullmag_ir::ExecutionPlanIR>(value.clone()).ok()
        }) {
            Some(plan) => {
                if let fullmag_ir::BackendPlanIR::Fdm(fdm) = &plan.backend_plan {
                    if let Err(error) =
                        fullmag_runner::validate_fdm_transport_checkpoint_resume_support(fdm)
                    {
                        return Some(error.message);
                    }
                }
            }
            None => {
                return Some("transport checkpoint ExactResume requires valid resolved execution-plan identity".into());
            }
        }
    }
    match snapshot
        .coupled_checkpoint
        .as_ref()
        .and_then(|value| value["schema"].as_str())
    {
        Some("fullmag.fdm.coupled_m3_checkpoint.v1") => {
            Some(fullmag_runner::FDM_CPU_TRANSPORT_EXACT_RESUME_UNSUPPORTED.into())
        }
        Some(schema)
            if schema != fullmag_runner::constraints::FROZEN_SPINS_CHECKPOINT_SCHEMA
                && schema != "fullmag.fdm.cpu.abm3-checkpoint.v1" =>
        {
            Some(format!(
                "checkpoint ExactResume is unsupported for schema '{schema}'"
            ))
        }
        _ => None,
    }
}

fn checkpoint_resume_class(
    checkpoint: &fullmag_session::FmsCheckpoint,
    context: &CheckpointEntryContext,
) -> fullmag_session::RestoreClass {
    supported_checkpoint_restore_class(
        checkpoint,
        &checkpoint.compatibility,
        context.resume_unsupported_reason.as_deref(),
    )
}

fn supported_checkpoint_restore_class(
    checkpoint: &fullmag_session::FmsCheckpoint,
    current: &CheckpointCompatibility,
    resume_unsupported_reason: Option<&str>,
) -> fullmag_session::RestoreClass {
    if resume_unsupported_reason.is_some()
        || checkpoint_schema_resume_unsupported_reason(checkpoint).is_some()
    {
        return fullmag_session::RestoreClass::Unsupported;
    }
    let class = determine_restore_class(&checkpoint.compatibility, current);
    if class == fullmag_session::RestoreClass::ExactResume && checkpoint.backend_state_ref.is_none()
    {
        fullmag_session::RestoreClass::LogicalResume
    } else {
        class
    }
}

fn checkpoint_compatibility(snapshot: &SessionStateResponse) -> CheckpointCompatibility {
    let vector_count = snapshot
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.magnetization.as_ref())
        .map(|values| values.len() / 3)
        .unwrap_or(0);
    let runtime_family = snapshot
        .session
        .resolved_runtime_family
        .clone()
        .or_else(|| snapshot.session.resolved_device.clone())
        .unwrap_or_else(|| "fdm_cpu_reference".to_string());

    let checkpoint_schema = snapshot
        .coupled_checkpoint
        .as_ref()
        .and_then(|checkpoint| checkpoint["schema"].as_str());
    let exact_resume_supported = checkpoint_schema == Some("fullmag.fdm.coupled_m3_checkpoint.v1")
        && checkpoint_resume_unsupported_reason(snapshot).is_none();
    let restart_abi = exact_resume_supported.then(|| {
        format!(
            "{}:{}:{}",
            runtime_family,
            snapshot
                .session
                .resolved_engine_id
                .as_deref()
                .unwrap_or("default"),
            checkpoint_schema.expect("exact resume schema was matched")
        )
    });
    let problem_hash = snapshot
        .scene_document
        .as_ref()
        .and_then(|scene| {
            serde_json::to_vec(scene)
                .ok()
                .map(|bytes| format!("problem:sha256:{:x}", Sha256::digest(bytes)))
        })
        .or_else(|| {
            snapshot
                .coupled_checkpoint
                .as_ref()
                .and_then(|checkpoint| checkpoint.get("identity"))
                .map(|identity| {
                    format!(
                        "problem:sha256:{}",
                        fullmag_session::canonical_json_sha256(identity)
                    )
                })
        });
    let plan_hash = serde_json::to_vec(&snapshot.session.plan_summary)
        .ok()
        .map(|bytes| format!("plan:sha256:{:x}", Sha256::digest(bytes)));

    CheckpointCompatibility {
        restart_abi,
        problem_hash,
        plan_hash,
        state_schema_version: Some("fullmag.checkpoint.v1".to_string()),
        engine_id: snapshot.session.resolved_engine_id.clone(),
        runtime_family: Some(runtime_family),
        precision: Some(
            snapshot
                .session
                .resolved_precision
                .clone()
                .unwrap_or_else(|| snapshot.session.requested_precision.clone()),
        ),
        study_kind: checkpoint_schema.map(|schema| match schema {
            "fullmag.fdm.coupled_m3_checkpoint.v1" => "fdm_coupled_m3".to_string(),
            fullmag_runner::constraints::FROZEN_SPINS_CHECKPOINT_SCHEMA => {
                "fdm_frozen_spins".to_string()
            }
            other => format!("unsupported:{other}"),
        }),
        discretization_signature: Some(format!(
            "mesh:{};vectors:{}",
            snapshot.mesh_revision, vector_count
        )),
        field_layout_signature: Some(format!("magnetization:{}x3", vector_count)),
    }
}

fn validate_supported_field_state_export(req: &FieldStateExportRequest) -> Result<(), ApiError> {
    normalize_field_state_export_format(&req.format)?;
    if req.quantity_id != "m" || req.target.kind != "object" {
        return Err(ApiError::bad_request(
            "field-state export currently supports object quantity 'm'",
        ));
    }
    Ok(())
}

fn normalize_field_state_export_format(format: &str) -> Result<String, ApiError> {
    match format {
        "field_state_json" | "json" => Ok("field_state_json".to_string()),
        "h5" | "hdf5" => Ok("h5".to_string()),
        "zarr" => Ok("zarr".to_string()),
        _ => Err(ApiError::bad_request(
            "field-state export format must be 'field_state_json', 'h5', or 'zarr'",
        )),
    }
}

fn validate_field_state_json_format(format: &str) -> Result<(), ApiError> {
    if format == "field_state_json" {
        return Ok(());
    }
    Err(ApiError::bad_request(
        "backend field-state operations currently support format 'field_state_json'",
    ))
}

fn sanitize_field_state_file_name(
    file_name: Option<&str>,
    req: &FieldStateExportRequest,
) -> Result<String, ApiError> {
    let format = normalize_field_state_export_format(&req.format)?;
    let extension = match format.as_str() {
        "h5" => ".h5",
        "zarr" => ".zarr.zip",
        _ => ".field-state.json",
    };
    let fallback = format!(
        "{}-{}-{}{}",
        req.target.kind, req.target.id, req.quantity_id, extension
    );
    let candidate = file_name.unwrap_or(&fallback);
    if candidate.is_empty()
        || candidate == "."
        || candidate == ".."
        || candidate.contains('/')
        || candidate.contains('\\')
    {
        return Err(ApiError::bad_request(
            "field-state file_name must be a single file name",
        ));
    }
    let name = candidate.to_ascii_lowercase();
    let valid_extension = match format.as_str() {
        "h5" => name.ends_with(".h5") || name.ends_with(".hdf5"),
        "zarr" => name.ends_with(".zarr") || name.ends_with(".zarr.zip"),
        _ => name.ends_with(".json"),
    };
    if !valid_extension {
        return Err(ApiError::bad_request(
            "field-state file_name extension must match the requested format",
        ));
    }
    Ok(candidate.to_string())
}

fn default_field_state_mode(target: &FieldStateTargetRef, quantity_id: &str) -> String {
    if target.kind == "object" && quantity_id == "m" {
        "apply".to_string()
    } else {
        "attach".to_string()
    }
}

fn validate_field_state_request_match(
    artifact: &FieldStateJsonArtifact,
    target: &FieldStateTargetRef,
    quantity_id: &str,
) -> Result<(), ApiError> {
    if artifact.quantity_id != quantity_id {
        return Err(ApiError::bad_request(format!(
            "field-state quantity '{}' does not match requested quantity '{}'",
            artifact.quantity_id, quantity_id
        )));
    }
    if artifact.target.kind != target.kind || artifact.target.id != target.id {
        return Err(ApiError::bad_request(
            "field-state target does not match requested target",
        ));
    }
    if artifact.component_count != 3 {
        return Err(ApiError::bad_request(
            "field-state apply requires 3-component vector data",
        ));
    }
    Ok(())
}

fn read_field_state_artifact(
    repo_root: &std::path::Path,
    snapshot: &SessionStateResponse,
    artifact_ref: &str,
    target: &FieldStateTargetRef,
) -> Result<FieldStateJsonArtifact, ApiError> {
    let artifact_path = resolve_session_artifact_ref(snapshot, artifact_ref)?;
    let raw = std::fs::read(&artifact_path)
        .map_err(|error| ApiError::not_found(format!("field-state artifact not found: {error}")))?;
    let artifact: FieldStateJsonArtifact = match serde_json::from_slice(&raw) {
        Ok(artifact) => artifact,
        Err(json_error) if field_state_path_needs_python_loader(&artifact_path) => {
            convert_field_state_with_python(repo_root, &artifact_path).map_err(|error| {
                ApiError::bad_request(format!("{error}; JSON parse error was: {json_error}"))
            })?
        }
        Err(json_error) => {
            return read_hysteresis_snapshot_as_field_state(&raw, target).map_err(|snapshot_error| {
                ApiError::bad_request(format!(
                    "invalid field-state artifact: {json_error}; hysteresis snapshot parse error was: {snapshot_error}"
                ))
            });
        }
    };
    if artifact.fullmag_kind != "field_state" || artifact.schema_version != 1 {
        return Err(ApiError::bad_request(
            "unsupported field-state artifact schema",
        ));
    }
    Ok(artifact)
}

fn read_hysteresis_snapshot_as_field_state(
    raw: &[u8],
    target: &FieldStateTargetRef,
) -> Result<FieldStateJsonArtifact, serde_json::Error> {
    let snapshot: HysteresisMagnetizationSnapshotArtifact = serde_json::from_slice(raw)?;
    Ok(FieldStateJsonArtifact {
        fullmag_kind: "field_state".to_string(),
        schema_version: 1,
        quantity_id: snapshot.quantity_id,
        target: target.clone(),
        component_count: 3,
        values: snapshot.values,
        source_step: None,
        source_time_s: None,
    })
}

fn field_state_path_needs_python_loader(path: &std::path::Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    name.ends_with(".h5")
        || name.ends_with(".hdf5")
        || name.ends_with(".zarr")
        || name.ends_with(".zarr.zip")
}

fn convert_field_state_with_python(
    repo_root: &std::path::Path,
    artifact_path: &std::path::Path,
) -> Result<FieldStateJsonArtifact, String> {
    let workspace_root = crate::script::python_workspace_root(repo_root);
    let python_path = workspace_root.join("packages/fullmag-py/src");
    let existing_python_path = std::env::var_os("PYTHONPATH");
    let mut python_path_value = std::ffi::OsString::from(python_path.as_os_str());
    if let Some(existing) = existing_python_path {
        python_path_value.push(":");
        python_path_value.push(existing);
    }

    let mut command = crate::script::python_command(repo_root)
        .map_err(|error| format!("configuring Python field-state loader failed: {error}"))?;
    command
        .arg("-m")
        .arg("fullmag.init.field_state_cli")
        .arg(artifact_path)
        .current_dir(&workspace_root);
    if fullmag_runtime_control::python_runtime::packaged_windows_python(&workspace_root).is_none() {
        command.env("PYTHONPATH", python_path_value);
    }
    let output = command
        .output()
        .map_err(|error| format!("running Python field-state loader failed: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Python field-state loader failed with status {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Python field-state loader returned invalid JSON: {error}"))
}

fn write_field_state_with_python(
    repo_root: &std::path::Path,
    artifact_path: &std::path::Path,
    format: &str,
    artifact: &FieldStateJsonArtifact,
) -> Result<(), ApiError> {
    let json_path = artifact_path.with_extension("field-state-export.json");
    let raw = serde_json::to_vec(artifact).map_err(|error| {
        ApiError::internal(format!("serializing field-state export input: {error}"))
    })?;
    std::fs::write(&json_path, raw).map_err(|error| {
        ApiError::internal(format!(
            "writing temporary field-state export input: {error}"
        ))
    })?;

    let workspace_root = crate::script::python_workspace_root(repo_root);
    let python_path = workspace_root.join("packages/fullmag-py/src");
    let existing_python_path = std::env::var_os("PYTHONPATH");
    let mut python_path_value = std::ffi::OsString::from(python_path.as_os_str());
    if let Some(existing) = existing_python_path {
        python_path_value.push(":");
        python_path_value.push(existing);
    }

    let output = crate::script::python_command(repo_root).and_then(|mut command| {
        command
            .arg("-m")
            .arg("fullmag.init.field_state_cli")
            .arg("write")
            .arg(artifact_path)
            .arg("--input-json")
            .arg(&json_path)
            .arg("--format")
            .arg(format)
            .current_dir(&workspace_root);
        if fullmag_runtime_control::python_runtime::packaged_windows_python(&workspace_root)
            .is_none()
        {
            command.env("PYTHONPATH", python_path_value);
        }
        command.output().map_err(|error| {
            ApiError::internal(format!("running Python field-state writer: {error}"))
        })
    });

    let _ = std::fs::remove_file(&json_path);

    let output = output?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::internal(format!(
            "Python field-state writer failed with status {}: {}",
            output.status,
            stderr.trim()
        )));
    }
    Ok(())
}

fn resolve_session_artifact_ref(
    snapshot: &SessionStateResponse,
    artifact_ref: &str,
) -> Result<std::path::PathBuf, ApiError> {
    let relative = std::path::Path::new(artifact_ref);
    if relative.is_absolute() || artifact_ref.is_empty() {
        return Err(ApiError::bad_request(
            "artifact_ref must be a relative session artifact path",
        ));
    }
    if !relative.components().all(|component| {
        matches!(
            component,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    }) {
        return Err(ApiError::bad_request(
            "artifact_ref must not contain parent-directory components",
        ));
    }
    Ok(std::path::PathBuf::from(&snapshot.session.artifact_dir).join(relative))
}

fn bump_live_field_revisions(snapshot: &mut SessionStateResponse, quantity_id: &str) {
    snapshot.field_catalog_revision = if snapshot.field_catalog_revision == 0 {
        1
    } else {
        snapshot.field_catalog_revision.saturating_add(1)
    };
    let next_quantity_revision = snapshot
        .field_quantity_revisions
        .get(quantity_id)
        .copied()
        .map(|revision| revision.saturating_add(1))
        .unwrap_or(2);
    snapshot
        .field_quantity_revisions
        .insert(quantity_id.to_string(), next_quantity_revision);
    snapshot.field_samples_revision = if snapshot.field_samples_revision == 0 {
        next_quantity_revision
    } else {
        snapshot
            .field_samples_revision
            .max(next_quantity_revision)
            .saturating_add(1)
    };
}

// ── Base64 helpers ─────────────────────────────────────────────────────

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn base64_decode(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s)
}

#[cfg(test)]
mod coupled_checkpoint_identity_tests {
    use super::validate_coupled_checkpoint_value;

    fn checkpoint() -> serde_json::Value {
        let mut checkpoint = serde_json::json!({
            "schema": "fullmag.fdm.coupled_m3_checkpoint.v1",
            "problem_ir_abi": "fullmag.problem_ir.v1",
            "scalar_layout": "f64",
            "vector_layout": "aos_xyz",
            "endianness": "little",
            "formula_version": "transient_spin_balance.fullmag.v1",
            "integrator_version": "coupled_imex_ark2.v1",
            "integrator_implementation_revision": "imex_ars_232_step_doubling.fullmag.v1",
            "identity": {
                "requested_discretization": "fdm",
                "requested_device": "cpu",
                "requested_precision": "double",
                "requested_execution_mode": "strict",
                "resolved_discretization": "fdm",
                "resolved_device": "cpu",
                "resolved_precision": "double",
                "resolved_execution_mode": "strict",
                "scene_revision": 1,
                "plan_revision": 2,
                "mesh_revision": 3,
                "material_revision": 4,
                "current_operator_revision": 5,
                "spin_operator_revision": 6,
                "oersted_operator_revision": 7,
                "charge_cache_identity": "charge-cache:5",
                "spin_cache_identity": "spin-cache:6",
                "oersted_cache_identity": "oersted-cache:7",
                "source_identity": "source:8"
            },
            "magnetization": [[1.0, 0.0, 0.0]],
            "previous_magnetization": [[1.0, 0.0, 0.0]],
            "time_s": 1.0e-13,
            "previous_dt_s": 1.0e-13,
            "transient_states": {"spin": {
                "spin_potential_v": [[0.01, 0.0, 0.0]],
                "previous_spin_potential_v": [[0.0, 0.0, 0.0]],
                "time_s": 1.0e-13,
                "previous_dt_s": 1.0e-13,
                "state_revision": 1
            }},
            "accepted": {
                "revision": 4,
                "evaluated_time_s": 1.0e-13,
                "refresh_count": 4,
                "modules": [{
                    "module_id": "spin",
                    "current_source_id": "charge",
                    "potential_volts": [0.1],
                    "current_density_apm2": [[1.0, 0.0, 0.0]],
                    "spin_potential_volts": [[0.01, 0.0, 0.0]],
                    "spin_current_tensor_apm2": [[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]],
                    "interface_fluxes": [],
                    "transport_torque_per_s": [[0.0, 1.0, 0.0]],
                    "oersted_field_apm": [[0.0, 0.0, 1.0]],
                    "telemetry": {},
                    "constitutive_version": "transport_constitutive.one_way.fullmag.v1",
                    "charge_operator_version": "fv_charge_face_flux.v1",
                    "spin_operator_version": "fv_spin_upwind_v1",
                    "runtime_owner": "fdm_cpu_reference",
                    "transport_realization": "drift_diffusion.fdm_cpu_reference",
                    "fallback_used": false,
                    "evaluated_envelope_multiplier": 1.0,
                    "state_revision": 1,
                    "operator_revision": 0
                }],
                "combined_transport_torque_per_s": [[0.0, 1.0, 0.0]],
                "combined_oersted_field_apm": [[0.0, 0.0, 1.0]]
            },
            "next_revision": 5,
            "refresh_count": 4,
            "accepted_steps": 1,
            "rejected_steps": 0,
            "error_controller": {"next_dt_s": 1.0e-13, "last_normalized_error": 0.0},
            "charge_nonlinear_history": {"spin": []},
            "telemetry_cursor": 1,
            "thermal_rng_algorithm": "counter_hash_box_muller.fullmag.v1",
            "thermal_seed": 17,
            "thermal_counter": 1
        });
        checkpoint["accepted"]["modules"][0]["telemetry"] = serde_json::json!({
            "charge_iterations": 1,
            "charge_residual_l2": 0.0,
            "charge_net_boundary_current_a": 0.0,
            "charge_max_abs_divergence_a_per_m3": 0.0,
            "spin_iterations": 1,
            "spin_initial_residual_l2": 0.0,
            "spin_final_residual_l2": 0.0,
            "spin_scaled_residual": 0.0,
            "spin_relative_balance_closure": 0.0,
            "convergence_reason": "converged",
            "preconditioner": "none"
        });
        checkpoint
    }

    #[test]
    fn api_rejects_missing_or_malformed_coupled_identity_classes() {
        validate_coupled_checkpoint_value(&checkpoint()).expect("complete checkpoint");
        let mut invalid = Vec::new();
        for field in [
            "requested_discretization",
            "requested_device",
            "requested_precision",
            "requested_execution_mode",
            "resolved_discretization",
            "resolved_device",
            "resolved_precision",
            "resolved_execution_mode",
            "charge_cache_identity",
            "spin_cache_identity",
            "oersted_cache_identity",
            "source_identity",
        ] {
            let mut value = checkpoint();
            value["identity"][field] = serde_json::json!("");
            invalid.push(value);
        }
        for field in [
            "scene_revision",
            "plan_revision",
            "mesh_revision",
            "material_revision",
            "current_operator_revision",
            "spin_operator_revision",
            "oersted_operator_revision",
        ] {
            let mut value = checkpoint();
            value["identity"][field] = serde_json::Value::Null;
            invalid.push(value);
        }
        let mut no_history = checkpoint();
        no_history
            .as_object_mut()
            .unwrap()
            .remove("charge_nonlinear_history");
        invalid.push(no_history);
        let mut no_cursor = checkpoint();
        no_cursor
            .as_object_mut()
            .unwrap()
            .remove("telemetry_cursor");
        invalid.push(no_cursor);

        for value in invalid {
            assert!(
                validate_coupled_checkpoint_value(&value).is_err(),
                "{value}"
            );
        }
    }
}

#[cfg(test)]
mod terminal_field_generation_persistence_tests {
    use super::*;
    use crate::session::{apply_current_live_field_frame, default_current_live_state};
    use crate::types::{CurrentLiveFieldFrameRequest, CurrentLiveSnapshotRequest};

    #[test]
    fn restore_execution_compatibility_includes_authored_profile_and_layers() {
        let request: CurrentLiveSnapshotRequest =
            serde_json::from_value(serde_json::json!({"session_id": "profile-restore"})).unwrap();
        let mut original = default_current_live_state(&request);
        let builder: fullmag_authoring::ScriptBuilderState =
            serde_json::from_value(serde_json::json!({
                "revision": 1,
                "solver": {
                    "integrator": "rk45",
                    "fixed_timestep": "",
                    "relax_algorithm": "llg_overdamped",
                    "torque_tolerance": "1e-4",
                    "energy_tolerance": "",
                    "max_relax_steps": "1000"
                },
                "mesh": {
                    "algorithm_2d": 6,
                    "algorithm_3d": 1,
                    "hmax": "",
                    "hmin": "",
                    "size_factor": 1.0,
                    "size_from_curvature": 0,
                    "smoothing_steps": 1,
                    "optimize": "",
                    "optimize_iterations": 1,
                    "compute_quality": false,
                    "per_element_quality": false
                },
                "geometries": []
            }))
            .expect("minimal builder state should deserialize");
        original.scene_document = Some(fullmag_authoring::scene_document_from_script_builder(
            &builder,
        ));
        assert!(execution_semantic_section(&original)
            .get("authored_execution")
            .is_none());
        let mut changed = original.clone();
        changed
            .scene_document
            .as_mut()
            .unwrap()
            .study
            .execution_profile = Some(fullmag_ir::ExecutionProfileIR {
            profile_id: "exec:restore".into(),
            version: "1".into(),
            ..Default::default()
        });
        assert!(!session_restore_compatibility(Some(&original), &changed)
            .execution
            .differences
            .is_empty());
        original = changed.clone();
        changed
            .scene_document
            .as_mut()
            .unwrap()
            .study
            .execution_profile
            .as_mut()
            .unwrap()
            .version = "2".into();
        assert!(!session_restore_compatibility(Some(&original), &changed)
            .execution
            .differences
            .is_empty());
        changed = original.clone();
        changed
            .scene_document
            .as_mut()
            .unwrap()
            .study
            .execution_layers = serde_json::from_value(serde_json::json!([{
            "origin": {"kind": "study", "location": "scene.study"},
            "request": {"device": "auto"}
        }]))
        .unwrap();
        assert!(!session_restore_compatibility(Some(&original), &changed)
            .execution
            .differences
            .is_empty());
        assert!(session_restore_compatibility(Some(&original), &original)
            .execution
            .differences
            .is_empty());
    }

    fn terminal_frame(run_id: &str, sequence: u64) -> CurrentLiveFieldFrameRequest {
        serde_json::from_value(serde_json::json!({
            "session_id": "persisted-session",
            "replace_latest_fields": true,
            "clear_preview_cache": true,
            "field_generation": { "run_id": run_id, "sequence": sequence },
            "latest_fields": { "m": { "values": [[0.0, 0.0, 1.0]], "layout": { "grid_cells": [1, 1, 1] } } }
        }))
        .expect("terminal field frame")
    }

    #[test]
    fn restored_terminal_generation_accepts_new_run_and_rejects_old_run() {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(serde_json::json!({
            "session_id": "persisted-session"
        }))
        .expect("bootstrap request");
        let mut snapshot = default_current_live_state(&request);
        apply_current_live_field_frame(&mut snapshot, terminal_frame("run-before-restart", 9))
            .expect("first run terminal frame");

        let persisted = PersistedCurrentLiveSnapshot::from(&snapshot);
        let mut restored: crate::types::SessionStateResponse = persisted.into();
        apply_current_live_field_frame(&mut restored, terminal_frame("run-after-restart", 1))
            .expect("new run may restart its local sequence at one");

        let error =
            apply_current_live_field_frame(&mut restored, terminal_frame("run-before-restart", 10))
                .expect_err("delayed frame from retired run must remain stale");
        assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
    }
}

#[cfg(test)]
mod planar_presentation_migration_tests {
    use super::*;
    use crate::schemas::visualization_state::{
        default_planar_visualization_state, VisualizationOverrideState, VisualizationScopeKind,
    };

    fn persisted_document(
        auto_contrast: bool,
        min: serde_json::Value,
        max: serde_json::Value,
    ) -> serde_json::Value {
        let mut state = serde_json::to_value(DisplayPresentationState {
            visualization_planar: Some(default_planar_visualization_state()),
            ..DisplayPresentationState::default()
        })
        .expect("serialize v6 state");
        let planar = state
            .pointer_mut("/visualization_planar")
            .and_then(serde_json::Value::as_object_mut)
            .expect("planar presentation");
        planar.remove("range");
        planar.remove("raster_opacity");
        planar.insert(
            "auto_contrast".to_string(),
            serde_json::json!(auto_contrast),
        );
        planar.insert("contrast_min".to_string(), min);
        planar.insert("contrast_max".to_string(), max);
        state
    }

    #[test]
    fn v6_manual_planar_range_migrates_without_changing_its_si_limits() {
        let document = persisted_document(false, serde_json::json!(-2.0), serde_json::json!(4.0));
        let restored = restore_display_presentation(None, &document).expect("migrate v6 snapshot");
        let planar = restored
            .visualization_planar
            .expect("restored planar presentation");
        assert_eq!(planar.range.mode, PlanarColorRangeMode::Manual);
        assert_eq!(planar.range.min, Some(-2.0));
        assert_eq!(planar.range.max, Some(4.0));
    }

    #[test]
    fn invalid_v6_manual_range_resets_with_a_restore_diagnostic() {
        let document = persisted_document(false, serde_json::json!(4.0), serde_json::json!(-2.0));
        let restored = restore_display_presentation(None, &document).expect("migrate v6 snapshot");
        let planar = restored
            .visualization_planar
            .expect("restored planar presentation");
        assert_eq!(planar.range.mode, PlanarColorRangeMode::Auto);
        assert!(restored
            .visualization_restore_warnings
            .iter()
            .any(|warning| warning.contains("wersji v6")));
    }

    #[test]
    fn display_presentation_v8_null_monitor_migrates_to_default_source() {
        let mut document = serde_json::to_value(DisplayPresentationState {
            visualization_planar: Some(default_planar_visualization_state()),
            ..DisplayPresentationState::default()
        })
        .expect("serialize v8 presentation");
        let planar = document
            .pointer_mut("/visualization_planar")
            .and_then(serde_json::Value::as_object_mut)
            .expect("planar presentation");
        planar.insert("active_monitor_id".to_string(), serde_json::Value::Null);
        planar.remove("source");
        planar.remove("default_slice");

        let restored =
            restore_display_presentation(Some(8), &document).expect("migrate v8 default source");
        let restored = serde_json::to_value(restored).expect("serialize migrated presentation");
        assert_eq!(
            restored["visualization_planar"]["source"],
            serde_json::json!({"kind": "default"})
        );
        assert!(restored["visualization_planar"]
            .get("active_monitor_id")
            .is_none());
    }

    #[test]
    fn display_presentation_v8_monitor_id_migrates_to_monitor_source() {
        let mut document = serde_json::to_value(DisplayPresentationState {
            visualization_planar: Some(default_planar_visualization_state()),
            ..DisplayPresentationState::default()
        })
        .expect("serialize v8 presentation");
        let planar = document
            .pointer_mut("/visualization_planar")
            .and_then(serde_json::Value::as_object_mut)
            .expect("planar presentation");
        planar.insert(
            "active_monitor_id".to_string(),
            serde_json::json!("plane-1"),
        );
        planar.remove("source");
        planar.remove("default_slice");

        let restored =
            restore_display_presentation(Some(8), &document).expect("migrate v8 monitor source");
        let restored = serde_json::to_value(restored).expect("serialize migrated presentation");
        assert_eq!(
            restored["visualization_planar"]["source"],
            serde_json::json!({"kind": "monitor", "monitor_id": "plane-1"})
        );
        assert!(restored["visualization_planar"]
            .get("active_monitor_id")
            .is_none());
    }

    #[test]
    fn display_presentation_v9_round_trips_without_legacy_active_monitor_id() {
        let state = DisplayPresentationState {
            visualization_planar: Some(
                crate::schemas::visualization_state::PlanarVisualizationState {
                    range: PlanarColorRangeState {
                        mode: PlanarColorRangeMode::Symmetric,
                        min: None,
                        max: None,
                    },
                    raster_opacity: 0.4,
                    ..default_planar_visualization_state()
                },
            ),
            ..DisplayPresentationState::default()
        };
        let document = persisted_display_presentation(&state).expect("serialize v9 presentation");
        assert!(document["visualization_planar"]
            .get("active_monitor_id")
            .is_none());
        assert_eq!(
            document["visualization_planar"]["source"]["kind"],
            "default"
        );
        assert_eq!(
            restore_display_presentation(Some(9), &document).unwrap(),
            state
        );
    }

    #[test]
    fn v7_planar_layers_migrate_with_disabled_points_and_bounds() {
        let mut document = serde_json::to_value(DisplayPresentationState {
            visualization_planar: Some(default_planar_visualization_state()),
            ..DisplayPresentationState::default()
        })
        .expect("serialize presentation");
        let layers = document
            .pointer_mut("/visualization_planar/layers")
            .and_then(serde_json::Value::as_object_mut)
            .expect("planar layers");
        layers.remove("points");
        layers.remove("bounds");

        let restored =
            restore_display_presentation(Some(7), &document).expect("migrate v7 presentation");
        let layers = restored
            .visualization_planar
            .expect("planar presentation")
            .layers;
        assert!(!layers.points);
        assert!(!layers.bounds);
    }

    #[test]
    fn unknown_presentation_version_is_rejected_without_migration() {
        let document = serde_json::json!({});
        assert!(restore_display_presentation(
            Some(DISPLAY_PRESENTATION_SCHEMA_VERSION + 1),
            &document
        )
        .expect_err("future schema must not mutate state")
        .contains("unsupported"));
    }

    #[test]
    fn persisted_airbox_alias_conflict_restores_to_canonical_identity_with_warning() {
        let mut document = serde_json::to_value(DisplayPresentationState {
            visualization_overrides: Some(vec![
                VisualizationOverrideState {
                    scope: VisualizationScopeKind::Object,
                    scope_id: "object:__air__".to_string(),
                    visible: Some(false),
                    display: None,
                    style: None,
                    quantity: None,
                },
                VisualizationOverrideState {
                    scope: VisualizationScopeKind::Airbox,
                    scope_id: "airbox".to_string(),
                    visible: Some(true),
                    display: None,
                    style: None,
                    quantity: None,
                },
            ]),
            ..DisplayPresentationState::default()
        })
        .expect("serialize persisted presentation");

        let restored =
            restore_display_presentation(Some(DISPLAY_PRESENTATION_SCHEMA_VERSION), &document)
                .expect("restore persisted presentation");
        let overrides = restored
            .visualization_overrides
            .expect("restored visualization overrides");
        assert_eq!(overrides.len(), 1);
        assert_eq!(overrides[0].scope, VisualizationScopeKind::Airbox);
        assert_eq!(overrides[0].scope_id, "airbox");
        assert_eq!(overrides[0].visible, Some(true));
        assert!(restored
            .visualization_restore_warnings
            .iter()
            .any(|warning| warning.contains("ambiguous_airbox_ordering")));
    }

    #[test]
    fn checkpoint_request_types_support_expected_state_version() {
        let req_create: CheckpointCreateRequest =
            serde_json::from_str(r#"{"expected_state_version": 42, "reason": "test"}"#)
                .expect("deserialize create req");
        assert_eq!(req_create.expected_state_version, Some(42));
        assert_eq!(req_create.reason.as_deref(), Some("test"));

        let req_restore: CheckpointRestoreRequest =
            serde_json::from_str(r#"{"expected_state_version": 99}"#)
                .expect("deserialize restore req");
        assert_eq!(req_restore.expected_state_version, Some(99));
    }
}

#[cfg(test)]
mod archive_error_regressions {
    use super::*;

    #[test]
    fn archive_format_errors_and_storage_errors_have_distinct_http_statuses() {
        let malformed = archive_preflight_error(
            std::io::Error::new(std::io::ErrorKind::InvalidData, "CRC mismatch").into(), "preflight");
        assert_eq!(malformed.status, axum::http::StatusCode::BAD_REQUEST);
        let storage = archive_preflight_error(
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "staging denied").into(), "preflight");
        assert_eq!(storage.status, axum::http::StatusCode::INTERNAL_SERVER_ERROR);
    }
}
