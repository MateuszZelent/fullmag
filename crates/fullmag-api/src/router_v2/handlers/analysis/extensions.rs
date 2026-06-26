use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::analysis::topological_charge::{
    compute_topological_charge_grid, TopologicalChargeInput, TopologicalChargeWarningCode,
};
use crate::error::ApiError;
use crate::fem_slice::fem_tetra_linear_slice;
use crate::field_slice::{resolve_slice_query, FemField, FieldSliceQuery, SlicePlane};
use crate::router_v2::handlers::data::field_resolution::{
    flatten_json_field_values, json_field_grid, live_magnetization_values,
};
use crate::router_v2::handlers::sessions::status::field_quantity_revision;
use crate::types::AppState;

#[derive(Debug, Clone, Deserialize, IntoParams, ToSchema)]
pub struct TopologicalChargeQuery {
    #[serde(default = "default_quantity_id")]
    pub quantity_id: String,
    #[serde(default = "default_plane")]
    pub plane: String,
    #[serde(default = "default_resolution")]
    pub resolution: String,
    #[serde(default)]
    pub snapshot_id: Option<String>,
    #[serde(default = "default_method")]
    pub method: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TopologicalChargeSampleGrid {
    pub nx: u32,
    pub ny: u32,
    pub plane: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TopologicalChargeWarning {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TopologicalChargeStatus {
    Ready,
    FieldMissing,
    MeshMissing,
    Stale,
    UnsupportedGeometry,
    InsufficientSamples,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TopologicalChargeResource {
    pub object_id: String,
    pub quantity_id: String,
    pub revision: u64,
    pub status: TopologicalChargeStatus,
    pub charge: Option<f64>,
    pub nearest_integer: Option<i64>,
    pub integer_error: Option<f64>,
    pub polarity: Option<String>,
    pub method: String,
    pub plane: String,
    pub sample_grid: Option<TopologicalChargeSampleGrid>,
    pub sample_count: usize,
    pub valid_sample_count: usize,
    pub field_revision: Option<u64>,
    pub domain_generation_id: Option<String>,
    pub mesh_generation_id: Option<String>,
    pub mesh_revision: Option<u64>,
    pub computed_at_unix_ms: u64,
    pub warnings: Vec<TopologicalChargeWarning>,
}

fn default_quantity_id() -> String {
    "m".to_string()
}

fn default_plane() -> String {
    "auto".to_string()
}

fn default_resolution() -> String {
    "auto".to_string()
}

fn default_method() -> String {
    "berg_luescher_grid".to_string()
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/extensions/objects/{object_id}/topological-charge",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id"),
        TopologicalChargeQuery,
    ),
    responses(
        (status = 200, description = "Object-scoped topological charge analysis resource", body = TopologicalChargeResource),
        (status = 404, description = "Object or workspace not found"),
    ),
    tag = "analysis"
)]
pub async fn get_object_topological_charge(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
    Query(query): Query<TopologicalChargeQuery>,
) -> Result<Json<TopologicalChargeResource>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let scene = snapshot
        .scene_document
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no authoring scene"))?;
    let object = scene
        .objects
        .iter()
        .find(|object| object.id == object_id || object.name == object_id)
        .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))?;
    let requested_resolution = query.resolution;
    let requested_snapshot = query.snapshot_id.as_deref().unwrap_or("latest");
    let field_summary = topological_charge_field_summary(snapshot, &query.quantity_id);
    let mesh = snapshot.fem_mesh.as_ref();
    let sampled_result = match (field_summary.as_ref(), mesh) {
        (Some(summary), None) => compute_regular_fdm_topological_charge(summary, &query.plane),
        (Some(summary), Some(mesh)) => compute_fem_topological_charge(
            summary,
            mesh,
            &object.id,
            &query.plane,
            &requested_resolution,
        ),
        _ => None,
    };
    let field_revision = field_summary
        .as_ref()
        .map(|_| field_quantity_revision(snapshot, &query.quantity_id).max(1));
    let field_revision_token = field_revision.unwrap_or(0);
    let mesh_revision_token = mesh.map_or(0, |_| snapshot.mesh_revision.max(1));
    let cache_key = crate::quantity_data_plane::topological_charge_cache_key(
        &object.id,
        &query.quantity_id,
        field_revision_token,
        mesh_revision_token,
        mesh.and_then(|mesh| mesh.generation_id.as_deref()),
        scene.revision,
        &query.plane,
        &requested_resolution,
        &query.method,
    );
    if let Some(cached) = state
        .quantity_data_plane
        .topological_charge_cache
        .lock()
        .await
        .get(&cache_key)
    {
        if let Ok(resource) = serde_json::from_value::<TopologicalChargeResource>(cached) {
            return Ok(Json(resource));
        }
    }
    let mesh_missing = mesh.is_none();
    let mesh_surface_incomplete = mesh.is_some_and(|mesh| {
        sampled_result.is_none() && object_mesh_surface_incomplete(mesh, &object.id)
    });
    let status = match (
        field_summary.as_ref(),
        sampled_result.as_ref(),
        mesh_missing,
    ) {
        (None, _, _) => TopologicalChargeStatus::FieldMissing,
        (Some(_), Some(_), true) => TopologicalChargeStatus::Ready,
        (Some(_), None, true) => TopologicalChargeStatus::MeshMissing,
        (Some(_), Some(_), false) => TopologicalChargeStatus::Ready,
        (Some(_), None, false) => TopologicalChargeStatus::UnsupportedGeometry,
    };
    let warnings = topological_charge_warnings(
        &status,
        requested_snapshot,
        &requested_resolution,
        field_summary
            .as_ref()
            .map_or(0, |summary| summary.sample_count),
        sampled_result.as_ref(),
        mesh_surface_incomplete,
    );
    let charge: Option<f64> = sampled_result.as_ref().map(|result| result.result.charge);
    let nearest_integer = charge.map(|value| value.round() as i64);
    let integer_error = charge
        .zip(nearest_integer)
        .map(|(value, nearest)| (value - nearest as f64).abs());
    let polarity = nearest_integer.map(|nearest| {
        if nearest > 0 {
            "positive".to_string()
        } else if nearest < 0 {
            "negative".to_string()
        } else {
            "zero".to_string()
        }
    });
    let resolved_plane = sampled_result
        .as_ref()
        .map_or_else(|| query.plane.clone(), |result| result.plane.clone());

    let resource = TopologicalChargeResource {
        object_id: object.id.clone(),
        quantity_id: query.quantity_id,
        revision: scene.revision,
        status,
        charge,
        nearest_integer,
        integer_error,
        polarity,
        method: query.method,
        plane: resolved_plane,
        sample_grid: sampled_result
            .as_ref()
            .map(|result| TopologicalChargeSampleGrid {
                nx: result.nx as u32,
                ny: result.ny as u32,
                plane: result.plane.clone(),
            }),
        sample_count: sampled_result.as_ref().map_or_else(
            || {
                field_summary
                    .as_ref()
                    .map_or(0, |summary| summary.sample_count)
            },
            |result| result.result.sample_count,
        ),
        valid_sample_count: sampled_result.as_ref().map_or_else(
            || {
                field_summary
                    .as_ref()
                    .map_or(0, |summary| summary.valid_sample_count)
            },
            |result| result.result.valid_sample_count,
        ),
        field_revision,
        domain_generation_id: None,
        mesh_generation_id: mesh.and_then(|mesh| mesh.generation_id.clone()),
        mesh_revision: mesh.map(|_| snapshot.mesh_revision.max(1)),
        computed_at_unix_ms: 0,
        warnings,
    };
    if let Ok(value) = serde_json::to_value(&resource) {
        state
            .quantity_data_plane
            .topological_charge_cache
            .lock()
            .await
            .insert(cache_key, value);
    }
    Ok(Json(resource))
}

struct FieldSampleSummary {
    values: Vec<f64>,
    grid: Option<[u32; 3]>,
    sample_count: usize,
    valid_sample_count: usize,
}

struct ComputedTopologicalCharge {
    result: crate::analysis::topological_charge::TopologicalChargeResult,
    nx: usize,
    ny: usize,
    plane: String,
}

fn topological_charge_field_summary(
    snapshot: &crate::types::SessionStateResponse,
    quantity_id: &str,
) -> Option<FieldSampleSummary> {
    let (values, grid) = if quantity_id == "m" {
        live_magnetization_values(snapshot)
            .map(|(values, grid)| (values, Some(grid)))
            .or_else(|| latest_or_preview_field_values(snapshot, quantity_id))
    } else {
        latest_or_preview_field_values(snapshot, quantity_id)
    }?;
    if values.is_empty() || values.len() % 3 != 0 {
        return None;
    }
    let sample_count = values.len() / 3;
    let valid_sample_count = values
        .chunks_exact(3)
        .filter(|sample| {
            let norm_squared =
                sample[0] * sample[0] + sample[1] * sample[1] + sample[2] * sample[2];
            norm_squared > 1.0e-24 && norm_squared.is_finite()
        })
        .count();
    (sample_count > 0).then_some(FieldSampleSummary {
        values,
        grid,
        sample_count,
        valid_sample_count,
    })
}

fn latest_or_preview_field_values(
    snapshot: &crate::types::SessionStateResponse,
    quantity_id: &str,
) -> Option<(Vec<f64>, Option<[u32; 3]>)> {
    snapshot
        .latest_fields
        .get(quantity_id)
        .map(|raw| (flatten_json_field_values(raw), json_field_grid(raw)))
        .filter(|(values, _grid)| !values.is_empty())
        .or_else(|| {
            snapshot
                .preview_cache
                .get(quantity_id)
                .map(|field| (field.vector_field_values.clone(), Some(field.preview_grid)))
                .filter(|(values, _grid)| !values.is_empty())
        })
}

fn compute_regular_fdm_topological_charge(
    summary: &FieldSampleSummary,
    requested_plane: &str,
) -> Option<ComputedTopologicalCharge> {
    let (samples, nx, ny, plane) =
        regular_fdm_plane_samples(&summary.values, summary.grid?, requested_plane)?;
    let result = compute_topological_charge_grid(TopologicalChargeInput {
        samples: &samples,
        nx,
        ny,
    })
    .ok()?;
    Some(ComputedTopologicalCharge {
        result,
        nx,
        ny,
        plane,
    })
}

fn compute_fem_topological_charge(
    summary: &FieldSampleSummary,
    mesh: &fullmag_runner::FemMeshPayload,
    object_id: &str,
    requested_plane: &str,
    requested_resolution: &str,
) -> Option<ComputedTopologicalCharge> {
    let fem_field = object_scoped_fem_field(summary, mesh, object_id)?;
    let plane = resolve_fem_plane(&fem_field.nodes, requested_plane)?;
    let resolution = resolve_topological_charge_resolution(requested_resolution)?;
    let resolved_slice = resolve_slice_query(
        &FieldSliceQuery {
            plane,
            component: Some("full".to_string()),
            cut_world: None,
            cut_norm: Some(0.5),
            x_size: Some(resolution),
            y_size: Some(resolution),
            max_points: Some(resolution.saturating_mul(resolution)),
            include_arrows: Some(false),
            arrow_every: None,
            max_arrows: None,
        },
        3,
    )
    .ok()?;
    let slice = fem_tetra_linear_slice(&fem_field, &resolved_slice, None).ok()?;
    if slice.n_comp_out != 3 {
        return None;
    }
    let mut samples = Vec::with_capacity(slice.x_size as usize * slice.y_size as usize);
    for pixel in 0..(slice.x_size as usize * slice.y_size as usize) {
        let base = pixel * 3;
        if slice.empty_mask.get(pixel).copied().unwrap_or(1) == 0 {
            samples.push([
                *slice.scalar_values.get(base)?,
                *slice.scalar_values.get(base + 1)?,
                *slice.scalar_values.get(base + 2)?,
            ]);
        } else {
            samples.push([0.0, 0.0, 0.0]);
        }
    }
    let result = compute_topological_charge_grid(TopologicalChargeInput {
        samples: &samples,
        nx: slice.x_size as usize,
        ny: slice.y_size as usize,
    })
    .ok()?;
    Some(ComputedTopologicalCharge {
        result,
        nx: slice.x_size as usize,
        ny: slice.y_size as usize,
        plane: plane.as_str().to_string(),
    })
}

fn object_scoped_fem_field(
    summary: &FieldSampleSummary,
    mesh: &fullmag_runner::FemMeshPayload,
    object_id: &str,
) -> Option<FemField> {
    if summary.values.len() / 3 != mesh.nodes.len() {
        return None;
    }
    let (node_indices, element_indices) = object_mesh_scope(mesh, object_id)?;
    let mut selected_nodes = BTreeSet::new();
    for index in node_indices {
        if index < mesh.nodes.len() {
            selected_nodes.insert(index);
        }
    }
    for element_index in &element_indices {
        if let Some(element) = mesh.elements.get(*element_index) {
            for node_index in element {
                selected_nodes.insert(*node_index as usize);
            }
        }
    }
    if selected_nodes.is_empty() {
        return None;
    }

    let mut node_map = BTreeMap::new();
    let mut nodes = Vec::with_capacity(selected_nodes.len());
    let mut values = Vec::with_capacity(selected_nodes.len() * 3);
    for old_index in selected_nodes {
        let new_index = nodes.len() as u32;
        node_map.insert(old_index as u32, new_index);
        nodes.push(*mesh.nodes.get(old_index)?);
        let value_offset = old_index * 3;
        values.extend_from_slice(summary.values.get(value_offset..value_offset + 3)?);
    }

    let mut elements = Vec::new();
    let mut element_markers = Vec::new();
    for element_index in element_indices {
        let element = *mesh.elements.get(element_index)?;
        let Some(remapped) = remap_tetra(element, &node_map) else {
            continue;
        };
        elements.push(remapped);
        if let Some(marker) = mesh.element_markers.get(element_index) {
            element_markers.push(*marker);
        }
    }
    if elements.is_empty() {
        return None;
    }

    Some(FemField {
        n_comp: 3,
        nodes,
        elements,
        element_markers,
        values,
    })
}

fn object_mesh_scope(
    mesh: &fullmag_runner::FemMeshPayload,
    object_id: &str,
) -> Option<(Vec<usize>, Vec<usize>)> {
    if let Some(part) = mesh
        .mesh_parts
        .iter()
        .find(|part| part.role == "magnetic_object" && part.object_id.as_deref() == Some(object_id))
    {
        let nodes = if part.node_indices.is_empty() {
            range_indices(
                part.node_start as usize,
                part.node_count as usize,
                mesh.nodes.len(),
            )
        } else {
            part.node_indices
                .iter()
                .map(|index| *index as usize)
                .collect()
        };
        let elements = range_indices(
            part.element_start as usize,
            part.element_count as usize,
            mesh.elements.len(),
        );
        return Some((nodes, elements));
    }
    let segment = mesh
        .object_segments
        .iter()
        .find(|segment| segment.object_id == object_id)?;
    Some((
        range_indices(
            segment.node_start as usize,
            segment.node_count as usize,
            mesh.nodes.len(),
        ),
        range_indices(
            segment.element_start as usize,
            segment.element_count as usize,
            mesh.elements.len(),
        ),
    ))
}

fn object_mesh_surface_incomplete(mesh: &fullmag_runner::FemMeshPayload, object_id: &str) -> bool {
    if let Some(part) = mesh
        .mesh_parts
        .iter()
        .find(|part| part.role == "magnetic_object" && part.object_id.as_deref() == Some(object_id))
    {
        return part.surface_faces.is_empty()
            || (part.boundary_face_count > 0 && part.boundary_face_indices.is_empty());
    }
    mesh.object_segments
        .iter()
        .find(|segment| segment.object_id == object_id)
        .is_some_and(|segment| segment.boundary_face_count > 0 && mesh.boundary_faces.is_empty())
}

fn range_indices(start: usize, count: usize, limit: usize) -> Vec<usize> {
    let end = start.saturating_add(count).min(limit);
    if start >= end {
        return Vec::new();
    }
    (start..end).collect()
}

fn remap_tetra(element: [u32; 4], node_map: &BTreeMap<u32, u32>) -> Option<[u32; 4]> {
    Some([
        *node_map.get(&element[0])?,
        *node_map.get(&element[1])?,
        *node_map.get(&element[2])?,
        *node_map.get(&element[3])?,
    ])
}

fn resolve_fem_plane(nodes: &[[f64; 3]], requested_plane: &str) -> Option<SlicePlane> {
    match requested_plane {
        "xy" | "XY" => return Some(SlicePlane::Xy),
        "xz" | "XZ" => return Some(SlicePlane::Xz),
        "yz" | "YZ" => return Some(SlicePlane::Yz),
        "auto" | "" => {}
        _ => return None,
    }
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for node in nodes {
        for axis in 0..3 {
            min[axis] = min[axis].min(node[axis]);
            max[axis] = max[axis].max(node[axis]);
        }
    }
    let extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    if extent[2] <= extent[0] && extent[2] <= extent[1] {
        Some(SlicePlane::Xy)
    } else if extent[1] <= extent[0] && extent[1] <= extent[2] {
        Some(SlicePlane::Xz)
    } else {
        Some(SlicePlane::Yz)
    }
}

fn resolve_topological_charge_resolution(requested_resolution: &str) -> Option<u32> {
    if requested_resolution == "auto" || requested_resolution.trim().is_empty() {
        return Some(64);
    }
    requested_resolution
        .parse::<u32>()
        .ok()
        .map(|value| value.clamp(2, 256))
}

fn regular_fdm_plane_samples(
    values: &[f64],
    grid: [u32; 3],
    requested_plane: &str,
) -> Option<(Vec<[f64; 3]>, usize, usize, String)> {
    let [gx, gy, gz] = grid;
    let point_count = gx as usize * gy as usize * gz as usize;
    if gx == 0 || gy == 0 || gz == 0 || values.len() != point_count * 3 {
        return None;
    }
    let resolved_plane = resolve_fdm_plane(grid, requested_plane)?;
    let (nx, ny, fixed_layer) = match resolved_plane {
        "xy" if gx >= 2 && gy >= 2 => (gx as usize, gy as usize, (gz / 2) as usize),
        "xz" if gx >= 2 && gz >= 2 => (gx as usize, gz as usize, (gy / 2) as usize),
        "yz" if gy >= 2 && gz >= 2 => (gy as usize, gz as usize, (gx / 2) as usize),
        _ => return None,
    };
    Some((
        plane_samples(
            values,
            gx as usize,
            gy as usize,
            gz as usize,
            fixed_layer,
            resolved_plane,
        )?,
        nx,
        ny,
        resolved_plane.to_string(),
    ))
}

fn resolve_fdm_plane(grid: [u32; 3], requested_plane: &str) -> Option<&'static str> {
    match requested_plane {
        "xy" | "XY" => return Some("xy"),
        "xz" | "XZ" => return Some("xz"),
        "yz" | "YZ" => return Some("yz"),
        "auto" | "" => {}
        _ => return None,
    }

    let [gx, gy, gz] = grid;
    if gz <= gx && gz <= gy {
        Some("xy")
    } else if gy <= gx && gy <= gz {
        Some("xz")
    } else {
        Some("yz")
    }
}

fn plane_samples(
    values: &[f64],
    gx: usize,
    gy: usize,
    gz: usize,
    fixed_layer: usize,
    plane: &str,
) -> Option<Vec<[f64; 3]>> {
    let (nx, ny) = match plane {
        "xy" => (gx, gy),
        "xz" => (gx, gz),
        "yz" => (gy, gz),
        _ => return None,
    };
    let mut samples = Vec::with_capacity(nx * ny);
    for v in 0..ny {
        for u in 0..nx {
            let point_index = match plane {
                "xy" => point_index_3d(u, v, fixed_layer, gx, gy, gz)?,
                "xz" => point_index_3d(u, fixed_layer, v, gx, gy, gz)?,
                "yz" => point_index_3d(fixed_layer, u, v, gx, gy, gz)?,
                _ => return None,
            };
            let value_index = point_index * 3;
            samples.push([
                *values.get(value_index)?,
                *values.get(value_index + 1)?,
                *values.get(value_index + 2)?,
            ]);
        }
    }
    Some(samples)
}

fn point_index_3d(x: usize, y: usize, z: usize, gx: usize, gy: usize, gz: usize) -> Option<usize> {
    (x < gx && y < gy && z < gz).then_some((z * gy + y) * gx + x)
}

fn topological_charge_warnings(
    status: &TopologicalChargeStatus,
    requested_snapshot: &str,
    requested_resolution: &str,
    sample_count: usize,
    fdm_result: Option<&ComputedTopologicalCharge>,
    mesh_surface_incomplete: bool,
) -> Vec<TopologicalChargeWarning> {
    match status {
        TopologicalChargeStatus::Ready => fdm_result_warnings(fdm_result),
        TopologicalChargeStatus::FieldMissing => vec![TopologicalChargeWarning {
            code: "field_missing".to_string(),
            message: format!(
                "Magnetization field data is not available for this object yet (snapshot: {requested_snapshot}, resolution: {requested_resolution}).",
            ),
        }],
        TopologicalChargeStatus::MeshMissing => vec![TopologicalChargeWarning {
            code: "mesh_missing".to_string(),
            message: format!(
                "Magnetization samples are available ({sample_count}), but object mesh provenance is not available yet.",
            ),
        }],
        TopologicalChargeStatus::UnsupportedGeometry if mesh_surface_incomplete => {
            vec![TopologicalChargeWarning {
                code: "mesh_surface_incomplete".to_string(),
                message: "Object surface topology is incomplete and no volume slice result was available for this request.".to_string(),
            }]
        }
        TopologicalChargeStatus::UnsupportedGeometry => {
            vec![TopologicalChargeWarning {
                code: "unsupported_geometry".to_string(),
                message: "Object field sampling for this mesh geometry is not available yet."
                    .to_string(),
            }]
        }
        TopologicalChargeStatus::Stale => vec![TopologicalChargeWarning {
            code: "stale".to_string(),
            message: "Topological charge source data is stale.".to_string(),
        }],
        TopologicalChargeStatus::InsufficientSamples => vec![TopologicalChargeWarning {
            code: "insufficient_samples".to_string(),
            message: "Not enough object field samples are available.".to_string(),
        }],
        TopologicalChargeStatus::Error => vec![TopologicalChargeWarning {
            code: "error".to_string(),
            message: "Topological charge calculation failed.".to_string(),
        }],
    }
}

fn fdm_result_warnings(
    fdm_result: Option<&ComputedTopologicalCharge>,
) -> Vec<TopologicalChargeWarning> {
    let Some(fdm_result) = fdm_result else {
        return Vec::new();
    };
    fdm_result
        .result
        .warnings
        .iter()
        .map(|warning| TopologicalChargeWarning {
            code: match warning.code {
                TopologicalChargeWarningCode::NonUnitMagnetization => {
                    "non_unit_magnetization".to_string()
                }
                TopologicalChargeWarningCode::InsufficientSamples => {
                    "insufficient_samples".to_string()
                }
            },
            message: warning.message.clone(),
        })
        .collect()
}
