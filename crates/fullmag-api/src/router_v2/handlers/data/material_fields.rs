//! Material-parameter field data endpoints.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use fullmag_authoring::{SceneDocument, SceneMaterialParameterAssignment, SceneObject};
use serde_json::Value;
use std::path::Path as FsPath;

use super::field_resolution::{flatten_current_field_values, json_field_value_count};
use crate::artifacts::read_json_artifact_value;
use crate::error::ApiError;
use crate::schemas::authoring::{
    MaterialParameterFieldDataListResource, MaterialParameterFieldDataResource,
    MaterialParameterFieldDataSummaryResource,
};
use crate::session::{current_artifact_dir, latest_field_source_is_qualified};
use crate::types::{AppState, SessionStateResponse};

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/material-fields",
    responses(
        (status = 200, description = "Material-parameter field data catalog", body = MaterialParameterFieldDataListResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "data"
)]
pub async fn get_material_field_data_catalog(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MaterialParameterFieldDataListResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    crate::ensure_current_live_request_context(
        snapshot,
        &request_context,
        state
            .current_live_session_epoch
            .load(std::sync::atomic::Ordering::Acquire),
    )?;
    let scene = snapshot
        .scene_document
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active scene document"))?;
    let artifact_dir = current_artifact_dir(snapshot);
    let assets = material_field_assets(snapshot.metadata.as_deref(), artifact_dir.as_deref());

    Ok(Json(MaterialParameterFieldDataListResource {
        scene_revision: scene.revision,
        region_coefficients_revision: Some(snapshot.region_realization_revisions.coefficients),
        fields: material_field_data_summaries(scene, snapshot, &assets),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/material-fields/{field_id}",
    params(
        ("field_id" = String, Path, description = "Material-parameter assignment id")
    ),
    responses(
        (status = 200, description = "Material-parameter field data payload", body = MaterialParameterFieldDataResource),
        (status = 404, description = "No material-parameter field with this assignment id"),
    ),
    tag = "data"
)]
pub async fn get_material_field_data(
    State(state): State<Arc<AppState>>,
    Path(field_id): Path<String>,
) -> Result<Json<MaterialParameterFieldDataResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    crate::ensure_current_live_request_context(
        snapshot,
        &request_context,
        state
            .current_live_session_epoch
            .load(std::sync::atomic::Ordering::Acquire),
    )?;
    let scene = snapshot
        .scene_document
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active scene document"))?;
    let artifact_dir = current_artifact_dir(snapshot);
    let assets = material_field_assets(snapshot.metadata.as_deref(), artifact_dir.as_deref());

    let selected = scene.objects.iter().find_map(|object| {
        object
            .material_parameter_fields
            .iter()
            .find(|field| field.assignment_id == field_id)
            .map(|field| (object, field))
    });
    let Some((object, field)) = selected else {
        return Err(ApiError::not_found(format!(
            "material field '{field_id}' not found"
        )));
    };
    material_field_data_resource(
        scene.revision,
        snapshot.region_realization_revisions.coefficients,
        object,
        field,
        snapshot,
        &assets,
    )
    .map(Json)
}

fn material_field_data_summaries(
    scene: &SceneDocument,
    snapshot: &SessionStateResponse,
    assets: &[fullmag_ir::MaterialFieldAssetIR],
) -> Vec<MaterialParameterFieldDataSummaryResource> {
    scene
        .objects
        .iter()
        .flat_map(|object| {
            object.material_parameter_fields.iter().map(|field| {
                let parameter = material_parameter_name(field);
                let asset = matching_material_field_asset(field, &parameter, assets);
                let sample_count = asset
                    .map(|asset| asset.values.len())
                    .unwrap_or_else(|| latest_material_field_value_count(snapshot, &parameter));
                MaterialParameterFieldDataSummaryResource {
                    field_id: field.assignment_id.clone(),
                    assignment_id: field.assignment_id.clone(),
                    asset_id: asset.map(|asset| asset.asset_id.clone()),
                    owner_object_id: field.owner_object.clone(),
                    parameter,
                    source_region_id: field.region_id.clone(),
                    unit: asset
                        .map(|asset| asset.unit.clone())
                        .or_else(|| material_field_metadata(&field.value).0),
                    realization_status: if asset.is_some() || sample_count > 0 {
                        "realized".to_string()
                    } else {
                        "authored_pending_realization".to_string()
                    },
                    sample_count: sample_count as u64,
                    href: format!(
                        "/v2/sessions/current/data/material-fields/{}",
                        field.assignment_id
                    ),
                }
            })
        })
        .collect()
}

fn material_field_data_resource(
    scene_revision: u64,
    region_coefficients_revision: u64,
    _object: &SceneObject,
    field: &SceneMaterialParameterAssignment,
    snapshot: &SessionStateResponse,
    assets: &[fullmag_ir::MaterialFieldAssetIR],
) -> Result<MaterialParameterFieldDataResource, ApiError> {
    let parameter = material_parameter_name(field);
    let (unit, frame, location) = material_field_metadata(&field.value);
    let asset = matching_material_field_asset(field, &parameter, assets);
    let values = match asset {
        Some(asset) => asset.values.clone(),
        None => latest_material_field_values(snapshot, &parameter)?,
    };
    let computed_stats = material_values_stats(&values);
    let realization_status = if asset.is_none() && values.is_empty() {
        "authored_pending_realization"
    } else {
        "realized"
    };

    Ok(MaterialParameterFieldDataResource {
        field_id: field.assignment_id.clone(),
        assignment_id: field.assignment_id.clone(),
        asset_id: asset.map(|asset| asset.asset_id.clone()),
        artifact_path: asset.and_then(|asset| asset.artifact_path.clone()),
        scene_revision,
        region_coefficients_revision: Some(region_coefficients_revision),
        owner_object_id: field.owner_object.clone(),
        owner_path: Some(field.owner_object.clone()),
        parameter,
        source_region_id: field.region_id.clone(),
        priority: Some(field.priority as i64),
        unit: asset.map(|asset| asset.unit.clone()).or(unit),
        frame,
        location: asset.map(|asset| enum_string(&asset.location)).or(location),
        mesh_id: asset.map(|asset| asset.mesh_id.clone()),
        mesh_generation_id: asset.map(|asset| asset.mesh_generation_id.clone()),
        component_count: asset.map(|asset| asset.component_count),
        source_kind: asset.map(|asset| enum_string(&asset.provenance.source_kind)),
        algorithm: asset.map(|asset| asset.provenance.algorithm.clone()),
        timing_ms: asset.map(|asset| asset.provenance.timing_ms),
        realization_status: realization_status.to_string(),
        sample_count: values.len() as u64,
        min: asset
            .map(|asset| asset.min)
            .or(computed_stats.map(|stats| stats.0)),
        max: asset
            .map(|asset| asset.max)
            .or(computed_stats.map(|stats| stats.1)),
        mean: asset
            .map(|asset| asset.mean)
            .or(computed_stats.map(|stats| stats.2)),
        values,
    })
}

fn material_parameter_name(field: &SceneMaterialParameterAssignment) -> String {
    serde_json::to_value(&field.parameter)
        .unwrap()
        .as_str()
        .unwrap()
        .to_string()
}

fn material_field_assets(
    metadata: Option<&Value>,
    artifact_dir: Option<&FsPath>,
) -> Vec<fullmag_ir::MaterialFieldAssetIR> {
    metadata
        .and_then(|metadata| metadata.get("material_field_assets"))
        .and_then(|assets| {
            serde_json::from_value::<Vec<fullmag_ir::MaterialFieldAssetIR>>(assets.clone()).ok()
        })
        .map(|assets| {
            assets
                .into_iter()
                .map(|asset| material_field_asset_with_file_values(asset, artifact_dir))
                .collect()
        })
        .unwrap_or_default()
}

fn material_field_asset_with_file_values(
    asset: fullmag_ir::MaterialFieldAssetIR,
    artifact_dir: Option<&FsPath>,
) -> fullmag_ir::MaterialFieldAssetIR {
    if !asset.values.is_empty() {
        return asset;
    }
    let Some(artifact_dir) = artifact_dir else {
        return asset;
    };
    let Some(artifact_path) = asset.artifact_path.as_deref() else {
        return asset;
    };

    read_json_artifact_value(artifact_dir, artifact_path)
        .ok()
        .and_then(|value| serde_json::from_value::<fullmag_ir::MaterialFieldAssetIR>(value).ok())
        .filter(|file_asset| file_asset.asset_id == asset.asset_id)
        .map(|mut file_asset| {
            if file_asset.artifact_path.is_none() {
                file_asset.artifact_path = Some(artifact_path.to_string());
            }
            file_asset
        })
        .unwrap_or(asset)
}

fn matching_material_field_asset<'a>(
    field: &SceneMaterialParameterAssignment,
    parameter: &str,
    assets: &'a [fullmag_ir::MaterialFieldAssetIR],
) -> Option<&'a fullmag_ir::MaterialFieldAssetIR> {
    if let fullmag_authoring::SceneMaterialParameterField::Sampled { asset_id, .. } = &field.value {
        if let Some(asset) = assets.iter().find(|asset| asset.asset_id == *asset_id) {
            return Some(asset);
        }
    }

    assets.iter().find(|asset| {
        asset.owner_object_id == field.owner_object
            && asset.source_region_id == field.region_id
            && enum_string(&asset.parameter) == parameter
    })
}

fn enum_string<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn material_field_metadata(
    field: &fullmag_authoring::SceneMaterialParameterField,
) -> (Option<String>, Option<String>, Option<String>) {
    let unit = match field {
        fullmag_authoring::SceneMaterialParameterField::Constant { unit, .. } => unit.clone(),
        fullmag_authoring::SceneMaterialParameterField::Linear { unit, .. } => unit.clone(),
        fullmag_authoring::SceneMaterialParameterField::Radial { unit, .. } => unit.clone(),
        fullmag_authoring::SceneMaterialParameterField::Sampled { unit, .. } => Some(unit.clone()),
    };
    let frame = match field {
        fullmag_authoring::SceneMaterialParameterField::Linear { frame, .. } => Some(
            serde_json::to_value(frame)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string(),
        ),
        fullmag_authoring::SceneMaterialParameterField::Radial { frame, .. } => Some(
            serde_json::to_value(frame)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string(),
        ),
        _ => None,
    };
    let location = match field {
        fullmag_authoring::SceneMaterialParameterField::Sampled { location, .. } => Some(
            serde_json::to_value(location)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string(),
        ),
        _ => None,
    };
    (unit, frame, location)
}

fn latest_material_field_values(
    snapshot: &SessionStateResponse,
    parameter: &str,
) -> Result<Vec<f64>, ApiError> {
    for quantity in material_field_lookup_keys(parameter) {
        let Some(raw) = snapshot.latest_fields.get(quantity) else {
            continue;
        };
        if !latest_field_source_is_qualified(snapshot, quantity, raw) {
            continue;
        }
        return flatten_current_field_values(snapshot, quantity, raw);
    }
    Ok(Vec::new())
}

fn latest_material_field_value_count(snapshot: &SessionStateResponse, parameter: &str) -> usize {
    material_field_lookup_keys(parameter)
        .into_iter()
        .find_map(|quantity| {
            let raw = snapshot.latest_fields.get(quantity)?;
            latest_field_source_is_qualified(snapshot, quantity, raw)
                .then(|| json_field_value_count(raw))
        })
        .unwrap_or(0)
}

fn material_field_lookup_keys(parameter: &str) -> Vec<&str> {
    match parameter {
        "ms" | "Ms" => vec!["mat_ms", "Ms", "ms"],
        "aex" | "Aex" => vec!["mat_aex", "Aex", "aex"],
        "alpha" => vec!["mat_alpha", "alpha"],
        other => vec![other],
    }
}

fn material_values_stats(values: &[f64]) -> Option<(f64, f64, f64)> {
    let (&first, rest) = values.split_first()?;
    let mut min = first;
    let mut max = first;
    let mut sum = first;
    for &value in rest {
        if value < min {
            min = value;
        }
        if value > max {
            max = value;
        }
        sum += value;
    }
    Some((min, max, sum / values.len() as f64))
}
