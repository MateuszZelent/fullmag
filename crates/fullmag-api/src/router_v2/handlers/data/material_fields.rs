//! Material-parameter field data endpoints.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use fullmag_authoring::{SceneDocument, SceneMaterialParameterAssignment, SceneObject};
use serde_json::Value;

use super::field_resolution::flatten_json_field_values;
use crate::error::ApiError;
use crate::schemas::authoring::{
    MaterialParameterFieldDataListResource, MaterialParameterFieldDataResource,
    MaterialParameterFieldDataSummaryResource,
};
use crate::types::{AppState, LatestFields};

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
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let scene = snapshot
        .scene_document
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active scene document"))?;
    let assets = material_field_assets(snapshot.metadata.as_ref());

    Ok(Json(MaterialParameterFieldDataListResource {
        scene_revision: scene.revision,
        fields: material_field_data_resources(scene, &snapshot.latest_fields, &assets)
            .into_iter()
            .map(|resource| MaterialParameterFieldDataSummaryResource {
                field_id: resource.field_id.clone(),
                assignment_id: resource.assignment_id.clone(),
                asset_id: resource.asset_id.clone(),
                owner_object_id: resource.owner_object_id.clone(),
                parameter: resource.parameter.clone(),
                source_region_id: resource.source_region_id.clone(),
                unit: resource.unit.clone(),
                realization_status: resource.realization_status.clone(),
                sample_count: resource.sample_count,
                href: format!(
                    "/v2/sessions/current/data/material-fields/{}",
                    resource.field_id
                ),
            })
            .collect(),
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
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let scene = snapshot
        .scene_document
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active scene document"))?;
    let assets = material_field_assets(snapshot.metadata.as_ref());

    material_field_data_resources(scene, &snapshot.latest_fields, &assets)
        .into_iter()
        .find(|resource| resource.field_id == field_id || resource.assignment_id == field_id)
        .map(Json)
        .ok_or_else(|| ApiError::not_found(format!("material field '{field_id}' not found")))
}

fn material_field_data_resources(
    scene: &SceneDocument,
    latest_fields: &LatestFields,
    assets: &[fullmag_ir::MaterialFieldAssetIR],
) -> Vec<MaterialParameterFieldDataResource> {
    scene
        .objects
        .iter()
        .flat_map(|object| {
            object.material_parameter_fields.iter().map(|field| {
                material_field_data_resource(scene.revision, object, field, latest_fields, assets)
            })
        })
        .collect()
}

fn material_field_data_resource(
    scene_revision: u64,
    _object: &SceneObject,
    field: &SceneMaterialParameterAssignment,
    latest_fields: &LatestFields,
    assets: &[fullmag_ir::MaterialFieldAssetIR],
) -> MaterialParameterFieldDataResource {
    let parameter = serde_json::to_value(&field.parameter)
        .unwrap()
        .as_str()
        .unwrap()
        .to_string();
    let (unit, frame, location) = material_field_metadata(&field.value);
    let asset = matching_material_field_asset(field, &parameter, assets);
    let values = asset
        .map(|asset| asset.values.clone())
        .unwrap_or_else(|| latest_material_field_values(latest_fields, &parameter));
    let computed_stats = material_values_stats(&values);
    let realization_status = if asset.is_none() && values.is_empty() {
        "authored_pending_realization"
    } else {
        "realized"
    };

    MaterialParameterFieldDataResource {
        field_id: field.assignment_id.clone(),
        assignment_id: field.assignment_id.clone(),
        asset_id: asset.map(|asset| asset.asset_id.clone()),
        scene_revision,
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
    }
}

fn material_field_assets(metadata: Option<&Value>) -> Vec<fullmag_ir::MaterialFieldAssetIR> {
    metadata
        .and_then(|metadata| metadata.get("material_field_assets"))
        .and_then(|assets| {
            serde_json::from_value::<Vec<fullmag_ir::MaterialFieldAssetIR>>(assets.clone()).ok()
        })
        .unwrap_or_default()
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

fn latest_material_field_values(latest_fields: &LatestFields, parameter: &str) -> Vec<f64> {
    let lookup_keys = match parameter {
        "ms" | "Ms" => &["Ms", "ms"][..],
        "aex" | "Aex" => &["Aex", "aex"][..],
        "alpha" => &["alpha"][..],
        other => &[other][..],
    };

    lookup_keys
        .iter()
        .find_map(|key| latest_fields.get(key).map(flatten_json_field_values))
        .unwrap_or_default()
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
