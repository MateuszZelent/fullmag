//! Hysteresis endpoints — points, metrics, branches, and minor loops.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader};
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use crate::schemas::hysteresis::{
    HysteresisAdaptiveRefinementSchema, HysteresisAngularFamilyResource,
    HysteresisAngularFamilySeriesSchema, HysteresisBranchSchema, HysteresisMetricsSchema,
    HysteresisMinorLoopSchema, HysteresisPointSchema, HysteresisSaturationResultSchema,
    HysteresisSettleTraceEntrySchema,
};
use axum::extract::{Path, State};
use axum::Json;
use serde_json::Value;

use crate::artifacts::require_current_live_artifact_dir;
use crate::error::ApiError;
use crate::router_v2::handlers::simulation::runtime::resolve_hysteresis_scene_stage;
use crate::types::AppState;

const HYSTERESIS_ZARR_STORE: &str = "hysteresis.zarr";
const HYSTERESIS_STORAGE_FORMAT: &str = "zarr_v2_json_fallback";

#[derive(Debug, serde::Deserialize)]
struct HysteresisAngularFamilyArtifact {
    family_id: String,
    label: String,
    active_variant_id: Option<String>,
    variants: Vec<HysteresisAngularFamilyVariantArtifact>,
}

#[derive(Debug, serde::Deserialize)]
struct HysteresisAngularFamilyVariantArtifact {
    variant_id: String,
    label: String,
    orientation: Value,
    measurement_axis: Value,
    data_status: String,
    point_count: usize,
    points_path: Option<String>,
    metrics_path: Option<String>,
}

async fn resolve_stage_artifact_path(
    state: &Arc<AppState>,
    stage_id: &str,
    filename: &str,
) -> Result<PathBuf, ApiError> {
    let artifact_dir = require_current_live_artifact_dir(state).await?;
    let guard = state.current_live_state.read().await;
    if let Some(snapshot) = guard.as_ref() {
        if let Some(ref stage_exec) = snapshot.stage_execution {
            for (idx, record) in stage_exec.stages.iter().enumerate() {
                if stage_identifier_matches(record, idx, stage_id) {
                    let active_stage_kind = stage_kind_for_index(stage_exec, idx);
                    if !is_hysteresis_stage_kind(record.kind.as_deref())
                        && !is_hysteresis_stage_kind(active_stage_kind.as_deref())
                    {
                        return Err(ApiError::not_found(format!(
                            "stage {} is not a hysteresis stage",
                            stage_id
                        )));
                    }
                    for ref_path in &record.artifact_refs {
                        if let Some(path) =
                            resolve_hysteresis_artifact_ref(&artifact_dir, ref_path, filename)?
                        {
                            return Ok(path);
                        }
                    }
                    if let Some(path) = resolve_flat_hysteresis_artifact(&artifact_dir, filename) {
                        return Ok(path);
                    }
                    return Err(ApiError::not_found(format!(
                        "stage artifact '{}' not found for stage {}",
                        filename, stage_id
                    )));
                }
            }
            return Err(ApiError::not_found(format!(
                "hysteresis stage {} not found",
                stage_id
            )));
        }
    }
    // Legacy single-stage runs wrote analysis artifacts directly into the run
    // artifact directory before per-stage artifact refs existed.
    if !is_legacy_default_stage_id(stage_id) {
        return Err(ApiError::not_found(format!(
            "hysteresis stage {} not found",
            stage_id
        )));
    }
    let direct = artifact_dir.join(filename);
    if direct.exists() {
        Ok(direct)
    } else {
        Err(ApiError::not_found(format!(
            "stage artifact '{}' not found for stage {}",
            filename, stage_id
        )))
    }
}

fn resolve_flat_hysteresis_artifact(artifact_dir: &FsPath, filename: &str) -> Option<PathBuf> {
    let direct = artifact_dir.join(filename);
    direct.is_file().then_some(direct)
}

fn is_legacy_default_stage_id(stage_id: &str) -> bool {
    matches!(stage_id, "0" | "stage_0")
}

fn is_hysteresis_stage_kind(kind: Option<&str>) -> bool {
    matches!(kind, Some("hysteresis" | "flat_hysteresis"))
}

fn stage_kind_for_index(stage: &crate::types::StageExecutionState, index: usize) -> Option<String> {
    if stage.active_stage_index == Some(index) {
        return stage.active_stage_kind.clone();
    }
    None
}

fn resolve_hysteresis_artifact_ref(
    artifact_dir: &FsPath,
    ref_path: &str,
    filename: &str,
) -> Result<Option<PathBuf>, ApiError> {
    let candidate = FsPath::new(ref_path);
    let full_path = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        let relative = crate::artifacts::sanitize_artifact_relative_path(ref_path)?;
        artifact_dir.join(relative)
    };

    let expected_root = artifact_dir
        .parent()
        .map(FsPath::to_path_buf)
        .unwrap_or_else(|| artifact_dir.to_path_buf());
    if full_path.is_absolute() && !full_path.starts_with(&expected_root) {
        return Err(ApiError::bad_request(
            "stage artifact path must stay under the active workspace",
        ));
    }

    if full_path.is_file()
        && full_path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == filename)
    {
        return Ok(Some(full_path));
    }
    if full_path.is_dir() {
        let nested = full_path.join(filename);
        if nested.exists() {
            return Ok(Some(nested));
        }
    }
    Ok(None)
}

async fn read_typed_stage_artifact<T: serde::de::DeserializeOwned>(
    state: &Arc<AppState>,
    stage_id: &str,
    filename: &str,
) -> Result<T, ApiError> {
    let path = resolve_stage_artifact_path(state, stage_id, filename).await?;
    let content = std::fs::read_to_string(&path)
        .map_err(|error| ApiError::internal(format!("failed to read stage artifact: {}", error)))?;
    serde_json::from_str(&content).map_err(|error| {
        ApiError::internal(format!(
            "failed to parse stage artifact '{}': {}",
            filename, error
        ))
    })
}

async fn read_optional_typed_stage_artifact_with_path<T: serde::de::DeserializeOwned>(
    state: &Arc<AppState>,
    stage_id: &str,
    filename: &str,
) -> Result<Option<(PathBuf, T)>, ApiError> {
    let path = match resolve_stage_artifact_path(state, stage_id, filename).await {
        Ok(path) => path,
        Err(error) if is_missing_stage_artifact(&error, filename) => return Ok(None),
        Err(error) => return Err(error),
    };
    let content = std::fs::read_to_string(&path)
        .map_err(|error| ApiError::internal(format!("failed to read stage artifact: {}", error)))?;
    let value = serde_json::from_str(&content).map_err(|error| {
        ApiError::internal(format!(
            "failed to parse stage artifact '{}': {}",
            filename, error
        ))
    })?;
    Ok(Some((path, value)))
}

fn read_typed_hysteresis_artifact_relative_to<T: serde::de::DeserializeOwned>(
    base_dir: &FsPath,
    relative_path: &str,
) -> Result<T, ApiError> {
    let relative = crate::artifacts::sanitize_artifact_relative_path(relative_path)?;
    let path = base_dir.join(relative);
    let content = std::fs::read_to_string(&path).map_err(|error| {
        ApiError::internal(format!(
            "failed to read hysteresis artifact '{}': {}",
            path.display(),
            error
        ))
    })?;
    serde_json::from_str(&content).map_err(|error| {
        ApiError::internal(format!(
            "failed to parse hysteresis artifact '{}': {}",
            path.display(),
            error
        ))
    })
}

async fn read_hysteresis_family_variant_points(
    state: &Arc<AppState>,
    stage_id: &str,
    variant_id: &str,
) -> Result<Vec<HysteresisPointSchema>, ApiError> {
    let stage = resolve_hysteresis_scene_stage(state, stage_id).await?;
    if let Some((manifest_path, artifact)) =
        read_optional_typed_stage_artifact_with_path::<HysteresisAngularFamilyArtifact>(
            state,
            &stage.stage_id,
            "hysteresis_angular_family.json",
        )
        .await?
    {
        let manifest_base_dir = manifest_path.parent().unwrap_or_else(|| FsPath::new(""));
        let active_variant_id = artifact.active_variant_id.as_deref();
        let Some(variant) = artifact
            .variants
            .into_iter()
            .find(|variant| variant.variant_id == variant_id)
        else {
            return Err(ApiError::not_found(format!(
                "hysteresis angular family variant '{}' not found for stage {}",
                variant_id, stage.stage_id
            )));
        };
        if let Some(points_path) = variant.points_path.as_deref() {
            return Ok(annotate_hysteresis_points(
                read_typed_hysteresis_artifact_relative_to(manifest_base_dir, points_path)?,
                manifest_base_dir,
                Some(&stage.stage_id),
            ));
        }
        if active_variant_id.is_some_and(|active| active == variant_id) {
            return read_hysteresis_points(state, &stage.stage_id).await;
        }
        return Ok(Vec::new());
    }

    let Some(family_value) = stage.value.get("angular_family") else {
        return Err(ApiError::not_found(format!(
            "hysteresis stage '{}' has no angular family",
            stage.stage_id
        )));
    };
    let Some(variants) = family_value.get("variants").and_then(Value::as_array) else {
        return Err(ApiError::internal(
            "hysteresis angular_family.variants is not an array",
        ));
    };
    let active_orientation = stage.value.get("orientation");
    for variant in variants {
        let Some(variant_obj) = variant.as_object() else {
            return Err(ApiError::internal(
                "hysteresis angular_family variant is not an object",
            ));
        };
        let current_variant_id = variant_obj
            .get("variant_id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ApiError::internal("hysteresis angular_family variant_id is not a string")
            })?;
        if current_variant_id != variant_id {
            continue;
        }
        let is_active = variant_obj.get("orientation").is_some_and(|orientation| {
            active_orientation.is_some_and(|active| active == orientation)
        });
        return if is_active {
            read_hysteresis_points(state, &stage.stage_id).await
        } else {
            Ok(Vec::new())
        };
    }
    Err(ApiError::not_found(format!(
        "hysteresis angular family variant '{}' not found for stage {}",
        variant_id, stage.stage_id
    )))
}

fn hysteresis_family_variant_points_resource_ref(stage_id: &str, variant_id: &str) -> String {
    format!(
        "/v2/sessions/current/analysis/hysteresis-family/{stage_id}/variants/{variant_id}/points"
    )
}

pub(crate) async fn read_hysteresis_saturation_result(
    state: &Arc<AppState>,
    stage_id: &str,
) -> Result<HysteresisSaturationResultSchema, ApiError> {
    read_typed_stage_artifact(state, stage_id, "hysteresis_saturation.json").await
}

pub(crate) async fn read_hysteresis_adaptive_refinement(
    state: &Arc<AppState>,
    stage_id: &str,
) -> Result<HysteresisAdaptiveRefinementSchema, ApiError> {
    read_typed_stage_artifact(state, stage_id, "hysteresis_adaptive_refinement.json").await
}

pub(crate) async fn read_hysteresis_points_if_available(
    state: &Arc<AppState>,
    stage_id: &str,
) -> Result<Vec<HysteresisPointSchema>, ApiError> {
    match read_optional_typed_stage_artifact_with_path::<Vec<HysteresisPointSchema>>(
        state,
        stage_id,
        "hysteresis_points.json",
    )
    .await?
    {
        Some((path, points)) => Ok(annotate_hysteresis_points(
            points,
            path.parent().unwrap_or_else(|| FsPath::new("")),
            Some(stage_id),
        )),
        None => Ok(Vec::new()),
    }
}

pub(crate) async fn read_hysteresis_minor_loops_if_available(
    state: &Arc<AppState>,
    stage_id: &str,
) -> Result<Vec<HysteresisMinorLoopSchema>, ApiError> {
    match read_optional_typed_stage_artifact_with_path::<Vec<HysteresisMinorLoopSchema>>(
        state,
        stage_id,
        "hysteresis_minor_loops.json",
    )
    .await?
    {
        Some((_path, minor_loops)) => Ok(minor_loops),
        None => Ok(Vec::new()),
    }
}

pub(crate) async fn read_hysteresis_settle_trace_if_available(
    state: &Arc<AppState>,
    stage_id: &str,
) -> Result<Vec<HysteresisSettleTraceEntrySchema>, ApiError> {
    match read_optional_typed_stage_artifact_with_path::<Vec<HysteresisSettleTraceEntrySchema>>(
        state,
        stage_id,
        "hysteresis_settle_trace.json",
    )
    .await?
    {
        Some((_path, trace)) => Ok(trace),
        None => Ok(Vec::new()),
    }
}

async fn read_hysteresis_points(
    state: &Arc<AppState>,
    stage_id: &str,
) -> Result<Vec<HysteresisPointSchema>, ApiError> {
    let points_artifact = match read_optional_typed_stage_artifact_with_path::<
        Vec<HysteresisPointSchema>,
    >(state, stage_id, "hysteresis_points.json")
    .await
    {
        Ok(artifact) => artifact,
        Err(error) if is_missing_stage_artifact(&error, "hysteresis_points.json") => {
            if stage_reports_completed_hysteresis_points(state, stage_id).await {
                return Err(ApiError::conflict(format!(
                        "stage {} reports completed hysteresis points but hysteresis_points.json is missing",
                        stage_id
                    )));
            }
            None
        }
        Err(error) => return Err(error),
    };
    let Some((path, points)) = points_artifact else {
        if stage_reports_completed_hysteresis_points(state, stage_id).await {
            return Err(ApiError::conflict(format!(
                "stage {} reports completed hysteresis points but hysteresis_points.json is missing",
                stage_id
            )));
        }
        return Ok(Vec::new());
    };
    Ok(annotate_hysteresis_points(
        points,
        path.parent().unwrap_or_else(|| FsPath::new("")),
        Some(stage_id),
    ))
}

async fn stage_reports_completed_hysteresis_points(state: &Arc<AppState>, stage_id: &str) -> bool {
    let guard = state.current_live_state.read().await;
    let Some(snapshot) = guard.as_ref() else {
        return false;
    };
    let Some(stage_exec) = snapshot.stage_execution.as_ref() else {
        return false;
    };
    stage_exec
        .stages
        .iter()
        .enumerate()
        .find(|(idx, record)| stage_identifier_matches(record, *idx, stage_id))
        .is_some_and(|(_, record)| {
            matches!(
                record.status,
                crate::types::StageLifecycleState::Completed
                    | crate::types::StageLifecycleState::Skipped
            ) || record
                .current_point_index
                .is_some_and(|point_index| point_index > 0)
        })
}

fn stage_identifier_matches(
    record: &crate::types::StageExecutionRecord,
    idx: usize,
    stage_id: &str,
) -> bool {
    let record_stage_id = record.stage_id.as_deref().unwrap_or("");
    record_stage_id == stage_id
        || format!("stage_{}", idx) == stage_id
        || format!("stage-{idx:03}") == stage_id
        || idx.to_string() == stage_id
}

fn is_missing_stage_artifact(error: &ApiError, filename: &str) -> bool {
    error.status == axum::http::StatusCode::NOT_FOUND
        && error.message.starts_with(&format!(
            "stage artifact '{}' not found for stage ",
            filename
        ))
}

fn annotate_hysteresis_points(
    mut points: Vec<HysteresisPointSchema>,
    artifact_base_dir: &FsPath,
    stage_id: Option<&str>,
) -> Vec<HysteresisPointSchema> {
    let branch_segments = infer_hysteresis_branch_segments(&points);
    let mut branch_ids_by_point: BTreeMap<usize, BTreeSet<String>> = BTreeMap::new();
    let mut primary_branch_by_point: BTreeMap<usize, (String, String, u32)> = BTreeMap::new();

    for (branch_index, direction, branch_points) in branch_segments {
        let branch_id = branch_id_for_direction(direction).to_string();
        let branch_role = branch_role_for_direction(direction).to_string();
        for point in branch_points {
            branch_ids_by_point
                .entry(point.point_id)
                .or_default()
                .insert(branch_id.clone());
            primary_branch_by_point.entry(point.point_id).or_insert((
                branch_id.clone(),
                branch_role.clone(),
                branch_index,
            ));
        }
    }

    for point in &mut points {
        if point.is_reversal_field.is_none() {
            point.is_reversal_field = Some(false);
        }
        if point.branch_ids.is_none() {
            if let Some(branch_ids) = branch_ids_by_point.get(&point.point_id) {
                point.branch_ids = Some(branch_ids.iter().cloned().collect());
            }
        }
        if let Some((branch_id, branch_role, branch_index)) =
            primary_branch_by_point.get(&point.point_id)
        {
            if point.branch_id.is_none() {
                point.branch_id = Some(branch_id.clone());
            }
            if point.protocol_role.is_none() {
                point.protocol_role = Some(branch_role.clone());
            }
            if point.branch_index.is_none() {
                point.branch_index = Some(*branch_index);
            }
        }
        if let Some(snapshot_id) = point.snapshot_id.clone() {
            annotate_hysteresis_snapshot_refs(point, &snapshot_id, artifact_base_dir, stage_id);
        }
    }
    points
}

fn annotate_hysteresis_snapshot_refs(
    point: &mut HysteresisPointSchema,
    snapshot_id: &str,
    artifact_base_dir: &FsPath,
    stage_id: Option<&str>,
) {
    let stage_param = stage_id
        .filter(|stage_id| !stage_id.trim().is_empty())
        .map(|stage_id| format!("&stage_id={stage_id}"))
        .unwrap_or_default();
    let vector_resource_ref = format!(
        "/v2/sessions/current/data/fields/m/samples/vector?component=full&scope_kind=full&snapshot_id={snapshot_id}{stage_param}"
    );
    point.snapshot_resource_ref = Some(vector_resource_ref.clone());
    point.snapshot_vector_resource_ref = Some(vector_resource_ref);
    if point.snapshot_json_artifact_ref.is_none() {
        point.snapshot_json_artifact_ref =
            Some(format!("hysteresis_snapshots/{snapshot_id}/m.json"));
    }
    if point.snapshot_zarr_store_ref.is_none() {
        point.snapshot_zarr_store_ref = Some(HYSTERESIS_ZARR_STORE.to_string());
    }
    if point.snapshot_storage_format.is_none() {
        point.snapshot_storage_format = Some(HYSTERESIS_STORAGE_FORMAT.to_string());
    }
    if point.snapshot_storage_status.is_none() || point.snapshot_storage_reason.is_none() {
        let (status, reason) = hysteresis_snapshot_storage_status(artifact_base_dir, snapshot_id);
        point.snapshot_storage_status.get_or_insert(status);
        point.snapshot_storage_reason.get_or_insert(reason);
    }
}

fn hysteresis_snapshot_storage_status(
    artifact_base_dir: &FsPath,
    snapshot_id: &str,
) -> (String, String) {
    if artifact_base_dir.as_os_str().is_empty() {
        return (
            "unknown".to_string(),
            "artifact directory is unavailable for snapshot storage verification".to_string(),
        );
    }
    if hysteresis_zarr_sample_exists(artifact_base_dir, snapshot_id) {
        return (
            "available_zarr".to_string(),
            "snapshot found in hysteresis.zarr".to_string(),
        );
    }
    if artifact_base_dir
        .join("hysteresis_snapshots")
        .join(snapshot_id)
        .join("m.json")
        .is_file()
    {
        return (
            "available_json_fallback".to_string(),
            "snapshot found in hysteresis_snapshots JSON fallback".to_string(),
        );
    }
    (
        "missing".to_string(),
        "snapshot payload not found in hysteresis.zarr or JSON fallback".to_string(),
    )
}

fn hysteresis_zarr_sample_exists(artifact_base_dir: &FsPath, snapshot_id: &str) -> bool {
    let samples_path = artifact_base_dir
        .join(HYSTERESIS_ZARR_STORE)
        .join("fields")
        .join("m")
        .join("samples.csv");
    let Ok(file) = std::fs::File::open(samples_path) else {
        return false;
    };
    BufReader::new(file).lines().skip(1).any(|line| {
        let Ok(line) = line else {
            return false;
        };
        line.split(',')
            .nth(1)
            .is_some_and(|candidate| candidate == snapshot_id)
    })
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/hysteresis/{stage_id}/points",
    params(
        ("stage_id" = String, Path, description = "Hysteresis stage index or stage identifier"),
    ),
    responses(
        (status = 200, description = "Hysteresis sweep points", body = Vec<HysteresisPointSchema>),
        (status = 404, description = "Hysteresis points not found"),
    ),
    tag = "analysis"
)]
pub async fn get_points(
    State(state): State<Arc<AppState>>,
    Path(stage_id): Path<String>,
) -> Result<Json<Vec<HysteresisPointSchema>>, ApiError> {
    let points = read_hysteresis_points(&state, &stage_id).await?;
    Ok(Json(points))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/hysteresis/{stage_id}/metrics",
    params(
        ("stage_id" = String, Path, description = "Hysteresis stage index or stage identifier"),
    ),
    responses(
        (status = 200, description = "Hysteresis loop metrics", body = HysteresisMetricsSchema),
        (status = 404, description = "Hysteresis metrics not found"),
    ),
    tag = "analysis"
)]
pub async fn get_metrics(
    State(state): State<Arc<AppState>>,
    Path(stage_id): Path<String>,
) -> Result<Json<HysteresisMetricsSchema>, ApiError> {
    let metrics = read_typed_stage_artifact(&state, &stage_id, "hysteresis_metrics.json").await?;
    Ok(Json(metrics))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/hysteresis/{stage_id}/saturation",
    params(
        ("stage_id" = String, Path, description = "Hysteresis stage index or stage identifier"),
    ),
    responses(
        (status = 200, description = "Hysteresis saturation probe result", body = HysteresisSaturationResultSchema),
        (status = 404, description = "Hysteresis saturation probe result not found"),
    ),
    tag = "analysis"
)]
pub async fn get_saturation(
    State(state): State<Arc<AppState>>,
    Path(stage_id): Path<String>,
) -> Result<Json<HysteresisSaturationResultSchema>, ApiError> {
    let saturation = read_hysteresis_saturation_result(&state, &stage_id).await?;
    Ok(Json(saturation))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/hysteresis/{stage_id}/adaptive-refinement",
    params(
        ("stage_id" = String, Path, description = "Hysteresis stage index or stage identifier"),
    ),
    responses(
        (status = 200, description = "Executed hysteresis adaptive refinement candidates and inserted points", body = HysteresisAdaptiveRefinementSchema),
        (status = 404, description = "Hysteresis adaptive refinement artifact not found"),
    ),
    tag = "analysis"
)]
pub async fn get_adaptive_refinement(
    State(state): State<Arc<AppState>>,
    Path(stage_id): Path<String>,
) -> Result<Json<HysteresisAdaptiveRefinementSchema>, ApiError> {
    let adaptive_refinement = read_hysteresis_adaptive_refinement(&state, &stage_id).await?;
    Ok(Json(adaptive_refinement))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/hysteresis/{stage_id}/branches",
    params(
        ("stage_id" = String, Path, description = "Hysteresis stage index or stage identifier"),
    ),
    responses(
        (status = 200, description = "Hysteresis loop branches grouped by sweep direction", body = Vec<HysteresisBranchSchema>),
        (status = 404, description = "Hysteresis points not found"),
    ),
    tag = "analysis"
)]
pub async fn get_branches(
    State(state): State<Arc<AppState>>,
    Path(stage_id): Path<String>,
) -> Result<Json<Vec<HysteresisBranchSchema>>, ApiError> {
    let points = read_hysteresis_points(&state, &stage_id).await?;
    if points.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let mut branches = Vec::new();
    for (branch_index, direction, branch_points) in infer_hysteresis_branch_segments(&points) {
        branches.push(build_branch_schema(
            branch_index,
            direction,
            branch_points,
            Some(&stage_id),
        ));
    }
    Ok(Json(branches))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/hysteresis-family/{stage_id}",
    params(
        ("stage_id" = String, Path, description = "Hysteresis stage index or stage identifier"),
    ),
    responses(
        (status = 200, description = "Angular hysteresis family series grouped by orientation", body = HysteresisAngularFamilyResource),
        (status = 404, description = "Angular hysteresis family not found"),
    ),
    tag = "analysis"
)]
pub async fn get_angular_family(
    State(state): State<Arc<AppState>>,
    Path(stage_id): Path<String>,
) -> Result<Json<HysteresisAngularFamilyResource>, ApiError> {
    let stage = resolve_hysteresis_scene_stage(&state, &stage_id).await?;
    let metrics = match read_typed_stage_artifact::<HysteresisMetricsSchema>(
        &state,
        &stage.stage_id,
        "hysteresis_metrics.json",
    )
    .await
    {
        Ok(metrics) => Some(metrics),
        Err(error) if is_missing_stage_artifact(&error, "hysteresis_metrics.json") => None,
        Err(error) => return Err(error),
    };
    if let Some((manifest_path, artifact)) =
        read_optional_typed_stage_artifact_with_path::<HysteresisAngularFamilyArtifact>(
            &state,
            &stage.stage_id,
            "hysteresis_angular_family.json",
        )
        .await?
    {
        let manifest_base_dir = manifest_path.parent().unwrap_or_else(|| FsPath::new(""));
        let active_variant_id = artifact.active_variant_id.clone();
        let mut series = Vec::new();
        for variant in artifact.variants.into_iter() {
            let is_active_variant = active_variant_id
                .as_deref()
                .is_some_and(|active| active == variant.variant_id);
            let variant_points = if let Some(points_path) = variant.points_path.as_deref() {
                annotate_hysteresis_points(
                    read_typed_hysteresis_artifact_relative_to(manifest_base_dir, points_path)?,
                    manifest_base_dir,
                    Some(&stage.stage_id),
                )
            } else if is_active_variant {
                read_hysteresis_points_if_available(&state, &stage.stage_id).await?
            } else {
                Vec::new()
            };
            let variant_metrics = if let Some(metrics_path) = variant.metrics_path.as_deref() {
                Some(read_typed_hysteresis_artifact_relative_to(
                    manifest_base_dir,
                    metrics_path,
                )?)
            } else if is_active_variant {
                metrics.clone()
            } else {
                None
            };
            series.push(HysteresisAngularFamilySeriesSchema {
                points_resource_ref: hysteresis_family_variant_points_resource_ref(
                    &stage.stage_id,
                    &variant.variant_id,
                ),
                variant_id: variant.variant_id,
                label: (!variant.label.is_empty()).then_some(variant.label),
                orientation: variant.orientation,
                measurement_axis: Some(variant.measurement_axis),
                data_status: variant.data_status,
                point_count: if !variant_points.is_empty() {
                    variant_points.len() as u32
                } else {
                    variant.point_count as u32
                },
                metrics: variant_metrics,
                points: variant_points,
            });
        }
        return Ok(Json(HysteresisAngularFamilyResource {
            revision: stage.revision,
            stage_id: stage.stage_id,
            stage_index: stage.stage_index,
            family_id: artifact.family_id,
            label: (!artifact.label.is_empty()).then_some(artifact.label),
            active_variant_id,
            series,
        }));
    }

    let Some(family_value) = stage.value.get("angular_family") else {
        return Err(ApiError::not_found(format!(
            "hysteresis stage '{}' has no angular family",
            stage.stage_id
        )));
    };
    let points = read_hysteresis_points(&state, &stage.stage_id).await?;
    let Some(family) = family_value.as_object() else {
        return Err(ApiError::internal(
            "hysteresis angular_family is not an object",
        ));
    };
    let Some(variants) = family.get("variants").and_then(Value::as_array) else {
        return Err(ApiError::internal(
            "hysteresis angular_family.variants is not an array",
        ));
    };
    let active_orientation = stage.value.get("orientation");
    let active_variant_id = variants.iter().find_map(|variant| {
        let variant = variant.as_object()?;
        let orientation = variant.get("orientation")?;
        if active_orientation.is_some_and(|active| active == orientation) {
            variant
                .get("variant_id")
                .and_then(Value::as_str)
                .map(str::to_string)
        } else {
            None
        }
    });

    let mut series = Vec::new();
    for variant in variants {
        let Some(variant) = variant.as_object() else {
            return Err(ApiError::internal(
                "hysteresis angular_family variant is not an object",
            ));
        };
        let variant_id = variant
            .get("variant_id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ApiError::internal("hysteresis angular_family variant_id is not a string")
            })?
            .to_string();
        let orientation = variant.get("orientation").cloned().ok_or_else(|| {
            ApiError::internal("hysteresis angular_family variant orientation is missing")
        })?;
        let is_active_variant = active_variant_id
            .as_deref()
            .is_some_and(|active| active == variant_id);
        let variant_points = if is_active_variant {
            points.clone()
        } else {
            Vec::new()
        };
        series.push(HysteresisAngularFamilySeriesSchema {
            points_resource_ref: hysteresis_family_variant_points_resource_ref(
                &stage.stage_id,
                &variant_id,
            ),
            variant_id,
            label: variant
                .get("label")
                .and_then(Value::as_str)
                .map(str::to_string),
            orientation,
            measurement_axis: variant.get("measurement_axis").cloned(),
            data_status: if is_active_variant {
                "computed_active_stage".to_string()
            } else {
                "pending_run".to_string()
            },
            point_count: variant_points.len() as u32,
            metrics: if is_active_variant {
                metrics.clone()
            } else {
                None
            },
            points: variant_points,
        });
    }

    Ok(Json(HysteresisAngularFamilyResource {
        revision: stage.revision,
        stage_id: stage.stage_id,
        stage_index: stage.stage_index,
        family_id: family
            .get("family_id")
            .and_then(Value::as_str)
            .unwrap_or("angular_family")
            .to_string(),
        label: family
            .get("label")
            .and_then(Value::as_str)
            .map(str::to_string),
        active_variant_id,
        series,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/hysteresis-family/{stage_id}/variants/{variant_id}/points",
    params(
        ("stage_id" = String, Path, description = "Hysteresis stage index or stage identifier"),
        ("variant_id" = String, Path, description = "Angular family variant identifier"),
    ),
    responses(
        (status = 200, description = "Hysteresis points for one angular-family variant", body = Vec<HysteresisPointSchema>),
        (status = 404, description = "Angular hysteresis family variant not found"),
    ),
    tag = "analysis"
)]
pub async fn get_angular_family_variant_points(
    State(state): State<Arc<AppState>>,
    Path((stage_id, variant_id)): Path<(String, String)>,
) -> Result<Json<Vec<HysteresisPointSchema>>, ApiError> {
    Ok(Json(
        read_hysteresis_family_variant_points(&state, &stage_id, &variant_id).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/hysteresis/{stage_id}/minor-loops",
    params(
        ("stage_id" = String, Path, description = "Hysteresis stage index or stage identifier"),
    ),
    responses(
        (status = 200, description = "Minor loops", body = Vec<HysteresisMinorLoopSchema>),
    ),
    tag = "analysis"
)]
pub async fn get_minor_loops(
    State(state): State<Arc<AppState>>,
    Path(stage_id): Path<String>,
) -> Result<Json<Vec<HysteresisMinorLoopSchema>>, ApiError> {
    match read_optional_typed_stage_artifact_with_path::<Vec<HysteresisMinorLoopSchema>>(
        &state,
        &stage_id,
        "hysteresis_minor_loops.json",
    )
    .await
    {
        Ok(Some((path, minor_loops))) => {
            let stage_points = read_hysteresis_points(&state, &stage_id).await?;
            Ok(Json(annotate_minor_loops(
                minor_loops,
                &stage_points,
                path.parent().unwrap_or_else(|| FsPath::new("")),
                Some(&stage_id),
            )))
        }
        Ok(None) => Ok(Json(Vec::new())),
        Err(error) if error.status == axum::http::StatusCode::NOT_FOUND => Ok(Json(Vec::new())),
        Err(error) => Err(error),
    }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/hysteresis/{stage_id}/reversal-fields",
    params(
        ("stage_id" = String, Path, description = "Hysteresis stage index or stage identifier"),
    ),
    responses(
        (status = 200, description = "Reversal fields", body = Vec<HysteresisPointSchema>),
    ),
    tag = "analysis"
)]
pub async fn get_reversal_fields(
    State(state): State<Arc<AppState>>,
    Path(stage_id): Path<String>,
) -> Result<Json<Vec<HysteresisPointSchema>>, ApiError> {
    let points = read_hysteresis_points(&state, &stage_id).await?;
    let mut reversal_fields = Vec::new();
    if points.len() < 3 {
        return Ok(Json(Vec::new()));
    }
    for i in 1..(points.len() - 1) {
        let prev = points[i - 1].field_value_m_t;
        let curr = points[i].field_value_m_t;
        let next = points[i + 1].field_value_m_t;
        if (curr - prev) * (next - curr) < 0.0 {
            let mut point = points[i].clone();
            point.is_reversal_field = Some(true);
            point.reversal_index = Some(reversal_fields.len() as u32);
            point.recoil_start_point_id = Some(point.point_id);
            reversal_fields.push(point);
        }
    }
    Ok(Json(reversal_fields))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/hysteresis/{stage_id}/steps/{point_id}",
    params(
        ("stage_id" = String, Path, description = "Hysteresis stage index or stage identifier"),
        ("point_id" = usize, Path, description = "Hysteresis point index"),
    ),
    responses(
        (status = 200, description = "Hysteresis point details", body = HysteresisPointSchema),
        (status = 404, description = "Hysteresis point not found"),
    ),
    tag = "analysis"
)]
pub async fn get_point_by_id(
    State(state): State<Arc<AppState>>,
    Path((stage_id, point_id)): Path<(String, usize)>,
) -> Result<Json<HysteresisPointSchema>, ApiError> {
    let points = read_hysteresis_points(&state, &stage_id).await?;
    for point in points {
        if point.point_id == point_id {
            return Ok(Json(point));
        }
    }
    Err(ApiError::not_found(format!(
        "point {} not found in stage {}",
        point_id, stage_id
    )))
}

fn branch_id_for_direction(direction: i32) -> &'static str {
    if direction == 1 {
        "ascending"
    } else if direction == -1 {
        "descending"
    } else {
        "unknown"
    }
}

fn infer_hysteresis_branch_segments(
    points: &[HysteresisPointSchema],
) -> Vec<(u32, i32, Vec<HysteresisPointSchema>)> {
    if points.is_empty() {
        return Vec::new();
    }

    let mut branches = Vec::new();
    let mut current_points = Vec::new();
    let mut current_direction = 0; // 1 = ascending, -1 = descending, 0 = unknown

    for (idx, point) in points.iter().enumerate() {
        let field_val = point.field_value_m_t;
        if idx == 0 {
            current_points.push(point.clone());
        } else {
            let prev_field_val = points[idx - 1].field_value_m_t;
            let dir = if field_val > prev_field_val {
                1
            } else if field_val < prev_field_val {
                -1
            } else {
                0
            };
            if dir != 0 {
                if current_direction == 0 {
                    current_direction = dir;
                } else if dir != current_direction {
                    branches.push((branches.len() as u32, current_direction, current_points));
                    current_points = points
                        .get(idx.saturating_sub(1))
                        .cloned()
                        .into_iter()
                        .collect();
                    current_direction = dir;
                }
            }
            current_points.push(point.clone());
        }
    }
    if !current_points.is_empty() {
        branches.push((branches.len() as u32, current_direction, current_points));
    }
    branches
}

fn build_branch_schema(
    branch_index: u32,
    direction: i32,
    mut points: Vec<HysteresisPointSchema>,
    stage_id: Option<&str>,
) -> HysteresisBranchSchema {
    let branch_id = branch_id_for_direction(direction).to_string();
    let branch_role = branch_role_for_direction(direction).to_string();
    for point in &mut points {
        point.branch_id = Some(branch_id.clone());
        point.protocol_role = Some(branch_role.clone());
        point.branch_index = Some(branch_index);
        if point.branch_ids.is_none() {
            point.branch_ids = Some(vec![branch_id.clone()]);
        }
        if let Some(snapshot_id) = point.snapshot_id.clone() {
            annotate_hysteresis_snapshot_refs(point, &snapshot_id, FsPath::new(""), stage_id);
        }
    }
    let first = points.first();
    let last = points.last();
    HysteresisBranchSchema {
        branch_id,
        branch_index,
        branch_role,
        direction,
        point_count: points.len() as u32,
        start_point_id: first.map(|point| point.point_id).unwrap_or_default(),
        end_point_id: last.map(|point| point.point_id).unwrap_or_default(),
        start_field_m_t: first.map(|point| point.field_value_m_t).unwrap_or_default(),
        end_field_m_t: last.map(|point| point.field_value_m_t).unwrap_or_default(),
        parent_branch_id: None,
        minor_loop_id: None,
        points,
    }
}

fn branch_role_for_direction(direction: i32) -> &'static str {
    if direction == 1 {
        "forward"
    } else if direction == -1 {
        "return"
    } else {
        "unknown"
    }
}

fn annotate_minor_loops(
    minor_loops: Vec<HysteresisMinorLoopSchema>,
    stage_points: &[HysteresisPointSchema],
    artifact_base_dir: &FsPath,
    stage_id: Option<&str>,
) -> Vec<HysteresisMinorLoopSchema> {
    minor_loops
        .into_iter()
        .map(|mut loop_result| {
            let loop_id = loop_result.loop_id.clone();
            let mut points =
                annotate_hysteresis_points(loop_result.points, artifact_base_dir, stage_id);
            for point in &mut points {
                point.minor_loop_id = Some(loop_id.clone());
                point.protocol_role = Some("minor".to_string());
            }

            let reversal_point_id = loop_result
                .reversal_point_id
                .or_else(|| points.first().map(|point| point.point_id));
            let return_point_id = loop_result
                .return_point_id
                .or_else(|| points.last().map(|point| point.point_id));
            let closure_status = loop_result.closure_status.or_else(|| {
                points.last().map(|last| {
                    if same_m_t(last.field_value_m_t, loop_result.return_field_m_t) {
                        "returned".to_string()
                    } else {
                        "open".to_string()
                    }
                })
            });
            let closure_error_m_parallel = loop_result
                .closure_error_m_parallel
                .or_else(|| minor_loop_closure_error_m_parallel(&points));
            let recoil_susceptibility = loop_result
                .recoil_susceptibility
                .or_else(|| minor_loop_recoil_susceptibility(&points));
            let minor_loop_area = loop_result
                .minor_loop_area
                .or_else(|| minor_loop_area_m_parallel(&points));

            loop_result.parent_branch_id = loop_result.parent_branch_id.or_else(|| {
                reversal_point_id
                    .and_then(|point_id| {
                        stage_points
                            .iter()
                            .find(|point| point.point_id == point_id)
                            .and_then(|point| point.branch_id.clone())
                    })
                    .or_else(|| points.first().and_then(|point| point.branch_id.clone()))
            });
            loop_result.reversal_point_id = reversal_point_id;
            loop_result.return_point_id = return_point_id;
            loop_result.policy = loop_result
                .policy
                .or_else(|| Some("branch_only".to_string()));
            loop_result.closure_status = closure_status;
            loop_result.closure_error_m_parallel = closure_error_m_parallel;
            loop_result.recoil_susceptibility = recoil_susceptibility;
            loop_result.minor_loop_area = minor_loop_area;
            loop_result.points = points;
            loop_result
        })
        .collect()
}

fn minor_loop_closure_error_m_parallel(points: &[HysteresisPointSchema]) -> Option<f64> {
    let first = points.first()?;
    let last = points.last()?;
    Some((last.m_parallel - first.m_parallel).abs())
}

fn minor_loop_recoil_susceptibility(points: &[HysteresisPointSchema]) -> Option<f64> {
    let first = points.first()?;
    let second = points.get(1)?;
    let delta_h = second.field_value_m_t - first.field_value_m_t;
    if delta_h.abs() <= 1e-12 {
        None
    } else {
        Some((second.m_parallel - first.m_parallel) / delta_h)
    }
}

fn minor_loop_area_m_parallel(points: &[HysteresisPointSchema]) -> Option<f64> {
    if points.len() < 2 {
        return None;
    }
    let area = points
        .windows(2)
        .map(|window| {
            let left = &window[0];
            let right = &window[1];
            0.5 * (left.m_parallel + right.m_parallel)
                * (right.field_value_m_t - left.field_value_m_t)
        })
        .sum::<f64>()
        .abs();
    Some(area)
}

fn same_m_t(left: f64, right: f64) -> bool {
    (left - right).abs() <= 1e-9
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/hysteresis/{stage_id}/steps/{point_id}/settle-trace",
    params(
        ("stage_id" = String, Path, description = "Hysteresis stage index or stage identifier"),
        ("point_id" = usize, Path, description = "Hysteresis point index"),
    ),
    responses(
        (status = 200, description = "Settle trace for a point", body = Vec<HysteresisSettleTraceEntrySchema>),
    ),
    tag = "analysis"
)]
pub async fn get_settle_trace(
    State(state): State<Arc<AppState>>,
    Path((stage_id, point_id)): Path<(String, usize)>,
) -> Result<Json<Vec<HysteresisSettleTraceEntrySchema>>, ApiError> {
    let trace: Vec<HysteresisSettleTraceEntrySchema> =
        read_typed_stage_artifact(&state, &stage_id, "hysteresis_settle_trace.json").await?;
    let point_trace = trace
        .into_iter()
        .filter(|entry| entry.point_id == point_id)
        .collect::<Vec<_>>();
    if point_trace.is_empty() {
        return Err(ApiError::not_found(format!(
            "settle trace for point {} not found in stage {}",
            point_id, stage_id
        )));
    }
    Ok(Json(point_trace))
}
