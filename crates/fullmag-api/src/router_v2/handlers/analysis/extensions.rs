use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::analysis::topological_charge::{
    compute_topological_charge_grid, compute_topological_charge_triangles, TopologicalChargeInput,
    TopologicalChargeTriangleInput, TopologicalChargeWarningCode,
};
use crate::error::ApiError;
use crate::fem_slice::fem_tetra_linear_slice;
use crate::fem_slice_overlay::{
    collect_fem_slice_overlay, FemSliceOverlayInput, SliceOverlayPoint,
};
use crate::field_slice::{resolve_slice_query, FemField, FieldSliceQuery, SlicePlane};
use crate::router_v2::handlers::data::field_resolution::{
    flatten_json_field_values, json_field_grid, live_magnetization_values,
};
use crate::router_v2::handlers::sessions::status::{domain_generation_id, field_quantity_revision};
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
pub struct TopologicalChargeSampleTopology {
    pub kind: String,
    pub point_count: usize,
    pub triangle_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TopologicalChargeLayerSample {
    pub index: usize,
    pub coordinate: f64,
    pub charge: Option<f64>,
    pub sample_count: usize,
    pub valid_sample_count: usize,
    pub triangle_count: usize,
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
    NoCurrentMagnetization,
    EmptySupport,
    InvalidMagnetization,
    DegenerateSupport,
    UnderResolved,
    Stale,
    UnsupportedGeometry,
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
    pub sample_topology: Option<TopologicalChargeSampleTopology>,
    pub layer_samples: Vec<TopologicalChargeLayerSample>,
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
    "berg_luescher".to_string()
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
    let requested_method = query.method;
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
            &requested_method,
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
        &requested_method,
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
    let missing_fem_mesh = mesh.is_none();
    let sampled_result_has_valid_samples = sampled_result
        .as_ref()
        .is_some_and(|result| result.result.valid_sample_count > 0);
    let status = TopologicalChargeStatus::from_inputs(
        field_summary.as_ref(),
        sampled_result.as_ref(),
        sampled_result_has_valid_samples,
        missing_fem_mesh,
    );
    let warnings = topological_charge_warnings(
        &status,
        requested_snapshot,
        &requested_resolution,
        field_summary
            .as_ref()
            .map_or(0, |summary| summary.sample_count),
        sampled_result.as_ref(),
    );
    let charge: Option<f64> = matches!(status, TopologicalChargeStatus::Ready)
        .then(|| sampled_result.as_ref().map(|result| result.result.charge))
        .flatten();
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
        method: sampled_result
            .as_ref()
            .map_or_else(|| requested_method.clone(), |result| result.method.clone()),
        plane: resolved_plane,
        sample_grid: sampled_result
            .as_ref()
            .and_then(|result| result.sample_grid.clone()),
        sample_topology: sampled_result
            .as_ref()
            .and_then(|result| result.sample_topology.clone()),
        layer_samples: sampled_result
            .as_ref()
            .map_or_else(Vec::new, |result| result.layer_samples.clone()),
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
        domain_generation_id: Some(domain_generation_id(snapshot).to_string()),
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
    method: String,
    plane: String,
    sample_grid: Option<TopologicalChargeSampleGrid>,
    sample_topology: Option<TopologicalChargeSampleTopology>,
    layer_samples: Vec<TopologicalChargeLayerSample>,
}

impl TopologicalChargeStatus {
    fn from_inputs(
        field_summary: Option<&FieldSampleSummary>,
        sampled_result: Option<&ComputedTopologicalCharge>,
        has_valid_samples: bool,
        missing_fem_mesh: bool,
    ) -> Self {
        let Some(_summary) = field_summary else {
            return Self::NoCurrentMagnetization;
        };
        let Some(result) = sampled_result else {
            return if missing_fem_mesh {
                Self::EmptySupport
            } else {
                Self::DegenerateSupport
            };
        };
        if has_valid_samples {
            return Self::Ready;
        }
        if result
            .result
            .warnings
            .iter()
            .any(|warning| warning.code == TopologicalChargeWarningCode::NonUnitMagnetization)
        {
            Self::InvalidMagnetization
        } else {
            Self::DegenerateSupport
        }
    }
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
        method: "berg_luescher_grid".to_string(),
        plane: plane.clone(),
        sample_grid: Some(TopologicalChargeSampleGrid {
            nx: nx as u32,
            ny: ny as u32,
            plane,
        }),
        sample_topology: None,
        layer_samples: Vec::new(),
    })
}

fn compute_fem_topological_charge(
    summary: &FieldSampleSummary,
    mesh: &fullmag_runner::FemMeshPayload,
    object_id: &str,
    requested_plane: &str,
    requested_resolution: &str,
    requested_method: &str,
) -> Option<ComputedTopologicalCharge> {
    if let Some(result) =
        compute_fem_layered_topological_charge(summary, mesh, object_id, requested_plane)
    {
        return Some(result);
    }
    if let Some(result) =
        compute_fem_plane_cut_topological_charge(summary, mesh, object_id, requested_plane)
    {
        return Some(result);
    }
    if !allows_fem_slice_grid_method(requested_method) {
        return None;
    }

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
        method: "berg_luescher_fem_slice_grid".to_string(),
        plane: plane.as_str().to_string(),
        sample_grid: Some(TopologicalChargeSampleGrid {
            nx: slice.x_size,
            ny: slice.y_size,
            plane: plane.as_str().to_string(),
        }),
        sample_topology: None,
        layer_samples: Vec::new(),
    })
}

fn allows_fem_slice_grid_method(requested_method: &str) -> bool {
    matches!(
        requested_method,
        "berg_luescher_fem_slice_grid" | "fem_slice_grid" | "slice_grid"
    )
}

fn compute_fem_plane_cut_topological_charge(
    summary: &FieldSampleSummary,
    mesh: &fullmag_runner::FemMeshPayload,
    object_id: &str,
    requested_plane: &str,
) -> Option<ComputedTopologicalCharge> {
    let fem_field = object_scoped_fem_field(summary, mesh, object_id)?;
    let plane = resolve_fem_plane(&fem_field.nodes, requested_plane)?;
    let resolved_slice = resolve_slice_query(
        &FieldSliceQuery {
            plane,
            component: Some("full".to_string()),
            cut_world: None,
            cut_norm: Some(0.5),
            x_size: Some(2),
            y_size: Some(2),
            max_points: Some(4),
            include_arrows: Some(false),
            arrow_every: None,
            max_arrows: None,
        },
        3,
    )
    .ok()?;
    let overlay = collect_fem_slice_overlay(
        FemSliceOverlayInput {
            nodes: &fem_field.nodes,
            elements: &fem_field.elements,
            element_markers: &fem_field.element_markers,
        },
        &resolved_slice,
    )
    .ok()?;

    let mut sample_map = BTreeMap::<CutPointKey, usize>::new();
    let mut samples = Vec::new();
    let mut triangles = Vec::new();
    let mut degenerate_triangle_count = 0usize;
    for polygon in &overlay.polygons {
        if polygon.points.len() < 3 {
            continue;
        }
        for index in 1..(polygon.points.len() - 1) {
            let points = [
                &polygon.points[0],
                &polygon.points[index],
                &polygon.points[index + 1],
            ];
            if cut_triangle_area(points) <= 1.0e-30 {
                degenerate_triangle_count += 1;
                continue;
            }
            let mut triangle = [0usize; 3];
            for (slot, point) in points.into_iter().enumerate() {
                triangle[slot] = remap_cut_point(&fem_field, point, &mut sample_map, &mut samples)?;
            }
            triangles.push(triangle);
        }
    }
    if samples.len() < 3 || triangles.is_empty() {
        return None;
    }

    let mut result = compute_topological_charge_triangles(TopologicalChargeTriangleInput {
        samples: &samples,
        triangles: &triangles,
    })
    .ok()?;
    if degenerate_triangle_count > 0 {
        result.warnings.push(
            crate::analysis::topological_charge::TopologicalChargeWarning {
                code: TopologicalChargeWarningCode::InsufficientSamples,
                message: format!(
                    "{degenerate_triangle_count} degenerate FEM cut triangles were skipped."
                ),
            },
        );
    }
    let sample_count = result.sample_count;
    let valid_sample_count = result.valid_sample_count;
    let triangle_count = triangles.len();
    let charge = (valid_sample_count > 0).then_some(result.charge);
    Some(ComputedTopologicalCharge {
        result,
        method: "fem_plane_cut_solid_angle".to_string(),
        plane: plane.as_str().to_string(),
        sample_grid: None,
        sample_topology: Some(TopologicalChargeSampleTopology {
            kind: "tetra_plane_cut".to_string(),
            point_count: sample_count,
            triangle_count,
        }),
        layer_samples: vec![TopologicalChargeLayerSample {
            index: 0,
            coordinate: overlay.cut_world,
            charge,
            sample_count,
            valid_sample_count,
            triangle_count,
        }],
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum CutPointKey {
    MeshNode(u32),
    Edge { a: u32, b: u32, t_quantized: i64 },
}

fn cut_point_key(point: &SliceOverlayPoint) -> CutPointKey {
    let [a, b] = point.edge_node_ids;
    if a == b {
        return CutPointKey::MeshNode(a);
    }
    let (a, b, t) = if a <= b {
        (a, b, point.edge_t)
    } else {
        (b, a, 1.0 - point.edge_t)
    };
    CutPointKey::Edge {
        a,
        b,
        t_quantized: (t.clamp(0.0, 1.0) * 1.0e12).round() as i64,
    }
}

fn remap_cut_point(
    field: &FemField,
    point: &SliceOverlayPoint,
    sample_map: &mut BTreeMap<CutPointKey, usize>,
    samples: &mut Vec<[f64; 3]>,
) -> Option<usize> {
    let key = cut_point_key(point);
    if let Some(index) = sample_map.get(&key) {
        return Some(*index);
    }
    let sample = cut_point_sample(field, point)?;
    let index = samples.len();
    sample_map.insert(key, index);
    samples.push(sample);
    Some(index)
}

fn cut_point_sample(field: &FemField, point: &SliceOverlayPoint) -> Option<[f64; 3]> {
    let [a, b] = point.edge_node_ids;
    if a == b {
        return fem_field_node_vector(field, a as usize);
    }
    let left = fem_field_node_vector(field, a as usize)?;
    let right = fem_field_node_vector(field, b as usize)?;
    let t = point.edge_t.clamp(0.0, 1.0);
    Some([
        left[0] + (right[0] - left[0]) * t,
        left[1] + (right[1] - left[1]) * t,
        left[2] + (right[2] - left[2]) * t,
    ])
}

fn fem_field_node_vector(field: &FemField, node_index: usize) -> Option<[f64; 3]> {
    if field.n_comp != 3 {
        return None;
    }
    let base = node_index.checked_mul(3)?;
    Some([
        *field.values.get(base)?,
        *field.values.get(base + 1)?,
        *field.values.get(base + 2)?,
    ])
}

fn cut_triangle_area(points: [&SliceOverlayPoint; 3]) -> f64 {
    let a = points[0].uv;
    let b = points[1].uv;
    let c = points[2].uv;
    0.5 * ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).abs()
}

fn compute_fem_layered_topological_charge(
    summary: &FieldSampleSummary,
    mesh: &fullmag_runner::FemMeshPayload,
    object_id: &str,
    requested_plane: &str,
) -> Option<ComputedTopologicalCharge> {
    let layers = object_scoped_fem_layers(summary, mesh, object_id, requested_plane)?;
    let mut layer_samples = Vec::with_capacity(layers.len());
    let mut valid_layers = Vec::new();
    let mut sample_count = 0usize;
    let mut valid_sample_count = 0usize;
    let mut saw_non_unit = false;
    let mut saw_insufficient = false;

    for (index, layer) in layers.iter().enumerate() {
        let layer_result = compute_topological_charge_triangles(TopologicalChargeTriangleInput {
            samples: &layer.samples,
            triangles: &layer.triangles,
        })
        .ok()?;
        sample_count += layer_result.sample_count;
        valid_sample_count += layer_result.valid_sample_count;
        for warning in &layer_result.warnings {
            match warning.code {
                TopologicalChargeWarningCode::NonUnitMagnetization => saw_non_unit = true,
                TopologicalChargeWarningCode::InsufficientSamples => saw_insufficient = true,
            }
        }
        let charge = (layer_result.valid_sample_count > 0).then_some(layer_result.charge);
        if let Some(charge) = charge {
            valid_layers.push((layer.coordinate, charge));
        }
        layer_samples.push(TopologicalChargeLayerSample {
            index,
            coordinate: layer.coordinate,
            charge,
            sample_count: layer_result.sample_count,
            valid_sample_count: layer_result.valid_sample_count,
            triangle_count: layer.triangles.len(),
        });
    }

    let charge = thickness_average_charge(&valid_layers).unwrap_or(0.0);
    let mut warnings = Vec::new();
    if saw_non_unit {
        warnings.push(
            crate::analysis::topological_charge::TopologicalChargeWarning {
                code: TopologicalChargeWarningCode::NonUnitMagnetization,
                message: "One or more magnetization samples were normalized or rejected."
                    .to_string(),
            },
        );
    }
    if saw_insufficient || valid_layers.is_empty() {
        warnings.push(
            crate::analysis::topological_charge::TopologicalChargeWarning {
                code: TopologicalChargeWarningCode::InsufficientSamples,
                message: "One or more FEM layers had no valid oriented triangle samples."
                    .to_string(),
            },
        );
    }
    let result = crate::analysis::topological_charge::TopologicalChargeResult {
        charge,
        sample_count,
        valid_sample_count,
        warnings,
    };
    let triangle_count = layers.iter().map(|layer| layer.triangles.len()).sum();
    Some(ComputedTopologicalCharge {
        result,
        method: "berg_luescher_fem_layers".to_string(),
        plane: layers[0].plane.as_str().to_string(),
        sample_grid: None,
        sample_topology: Some(TopologicalChargeSampleTopology {
            kind: "fem_layer_faces".to_string(),
            point_count: sample_count,
            triangle_count,
        }),
        layer_samples,
    })
}

struct FemLayerSamples {
    samples: Vec<[f64; 3]>,
    triangles: Vec<[usize; 3]>,
    plane: SlicePlane,
    coordinate: f64,
}

fn object_scoped_fem_layers(
    summary: &FieldSampleSummary,
    mesh: &fullmag_runner::FemMeshPayload,
    object_id: &str,
    requested_plane: &str,
) -> Option<Vec<FemLayerSamples>> {
    if summary.values.len() / 3 != mesh.nodes.len() {
        return None;
    }
    let (node_indices, element_indices) = object_mesh_scope(mesh, object_id)?;
    let plane = resolve_fem_plane_for_object(mesh, &node_indices, requested_plane)?;
    let normal_axis = plane_normal_axis(plane);
    let (_, max) = node_bounds(mesh, &node_indices)?;
    let tolerance = layer_coordinate_tolerance(mesh, &node_indices, normal_axis)?;
    let mut layers = layer_coordinates(mesh, &node_indices, normal_axis, tolerance);
    layers.sort_by(|a, b| a.total_cmp(b));
    let mut result = Vec::new();
    for coordinate in layers {
        let faces = layer_faces_from_elements(
            mesh,
            &element_indices,
            plane,
            normal_axis,
            coordinate,
            tolerance,
        );
        let mut node_map = BTreeMap::<u32, usize>::new();
        let mut samples = Vec::new();
        let mut triangles = Vec::new();
        for face in faces {
            let Some(triangle) =
                remap_surface_triangle(mesh, summary, face, plane, &mut node_map, &mut samples)
            else {
                continue;
            };
            triangles.push(triangle);
        }
        if samples.len() >= 3 && !triangles.is_empty() {
            result.push(FemLayerSamples {
                samples,
                triangles,
                plane,
                coordinate,
            });
        }
    }
    if result.is_empty() {
        let top_faces = object_surface_layer_faces(
            mesh,
            object_id,
            plane,
            normal_axis,
            max[normal_axis],
            tolerance,
        )?;
        let mut node_map = BTreeMap::<u32, usize>::new();
        let mut samples = Vec::new();
        let mut triangles = Vec::new();
        for face in top_faces {
            let Some(triangle) =
                remap_surface_triangle(mesh, summary, face, plane, &mut node_map, &mut samples)
            else {
                continue;
            };
            triangles.push(triangle);
        }
        if samples.len() >= 3 && !triangles.is_empty() {
            result.push(FemLayerSamples {
                samples,
                triangles,
                plane,
                coordinate: max[normal_axis],
            });
        }
    }
    (!result.is_empty()).then_some(result)
}

fn thickness_average_charge(layers: &[(f64, f64)]) -> Option<f64> {
    if layers.is_empty() {
        return None;
    }
    if layers.len() == 1 {
        return Some(layers[0].1);
    }
    let mut sorted = layers.to_vec();
    sorted.sort_by(|a, b| a.0.total_cmp(&b.0));
    let thickness = sorted.last()?.0 - sorted.first()?.0;
    if thickness.abs() <= 1.0e-30 {
        return Some(sorted.iter().map(|(_, charge)| charge).sum::<f64>() / sorted.len() as f64);
    }
    let mut integral = 0.0;
    for pair in sorted.windows(2) {
        let dz = pair[1].0 - pair[0].0;
        integral += 0.5 * dz * (pair[0].1 + pair[1].1);
    }
    Some(integral / thickness)
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

fn resolve_fem_plane_for_object(
    mesh: &fullmag_runner::FemMeshPayload,
    node_indices: &[usize],
    requested_plane: &str,
) -> Option<SlicePlane> {
    match requested_plane {
        "xy" | "XY" => return Some(SlicePlane::Xy),
        "xz" | "XZ" => return Some(SlicePlane::Xz),
        "yz" | "YZ" => return Some(SlicePlane::Yz),
        "auto" | "" => {}
        _ => return None,
    }
    let nodes = node_indices
        .iter()
        .filter_map(|index| mesh.nodes.get(*index).copied())
        .collect::<Vec<_>>();
    resolve_fem_plane(&nodes, requested_plane)
}

fn object_part_boundary_face_indices(
    part: &fullmag_runner::FemMeshPartPayload,
    boundary_face_count: usize,
) -> Vec<u32> {
    if !part.boundary_face_indices.is_empty() {
        return part.boundary_face_indices.clone();
    }
    let start = part.boundary_face_start as usize;
    let end = start
        .saturating_add(part.boundary_face_count as usize)
        .min(boundary_face_count);
    if start >= end {
        return Vec::new();
    }
    (start..end).map(|index| index as u32).collect()
}

fn object_surface_layer_faces(
    mesh: &fullmag_runner::FemMeshPayload,
    object_id: &str,
    plane: SlicePlane,
    normal_axis: usize,
    coordinate: f64,
    tolerance: f64,
) -> Option<Vec<[u32; 3]>> {
    let mut faces = Vec::new();
    if let Some(part) = mesh
        .mesh_parts
        .iter()
        .find(|part| part.role == "magnetic_object" && part.object_id.as_deref() == Some(object_id))
    {
        faces.extend(part.surface_faces.iter().copied());
        if faces.is_empty() {
            for face_index in object_part_boundary_face_indices(part, mesh.boundary_faces.len()) {
                if let Some(face) = mesh.boundary_faces.get(face_index as usize) {
                    faces.push(*face);
                }
            }
        }
    } else if let Some(segment) = mesh
        .object_segments
        .iter()
        .find(|segment| segment.object_id == object_id)
    {
        let start = segment.boundary_face_start as usize;
        let end = start
            .saturating_add(segment.boundary_face_count as usize)
            .min(mesh.boundary_faces.len());
        faces.extend(mesh.boundary_faces[start..end].iter().copied());
    }
    let selected =
        select_faces_on_axis_target(mesh, &faces, plane, normal_axis, coordinate, tolerance);
    (!selected.is_empty()).then_some(selected)
}

fn node_bounds(
    mesh: &fullmag_runner::FemMeshPayload,
    node_indices: &[usize],
) -> Option<([f64; 3], [f64; 3])> {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    let mut saw_node = false;
    for node_index in node_indices {
        let node = mesh.nodes.get(*node_index)?;
        saw_node = true;
        for axis in 0..3 {
            min[axis] = min[axis].min(node[axis]);
            max[axis] = max[axis].max(node[axis]);
        }
    }
    saw_node.then_some((min, max))
}

fn layer_coordinate_tolerance(
    mesh: &fullmag_runner::FemMeshPayload,
    node_indices: &[usize],
    normal_axis: usize,
) -> Option<f64> {
    let (min, max) = node_bounds(mesh, node_indices)?;
    let extent = max[normal_axis] - min[normal_axis];
    Some((extent.abs() * 1.0e-8).max(1.0e-12))
}

fn layer_coordinates(
    mesh: &fullmag_runner::FemMeshPayload,
    node_indices: &[usize],
    normal_axis: usize,
    tolerance: f64,
) -> Vec<f64> {
    let mut coordinates = Vec::<f64>::new();
    for node_index in node_indices {
        let Some(node) = mesh.nodes.get(*node_index) else {
            continue;
        };
        let coordinate = node[normal_axis];
        if coordinates
            .iter()
            .any(|existing| (*existing - coordinate).abs() <= tolerance)
        {
            continue;
        }
        coordinates.push(coordinate);
    }
    coordinates
}

fn layer_faces_from_elements(
    mesh: &fullmag_runner::FemMeshPayload,
    element_indices: &[usize],
    plane: SlicePlane,
    normal_axis: usize,
    coordinate: f64,
    tolerance: f64,
) -> Vec<[u32; 3]> {
    let mut seen = BTreeSet::<[u32; 3]>::new();
    let mut faces = Vec::new();
    for element_index in element_indices {
        let Some(element) = mesh.elements.get(*element_index) else {
            continue;
        };
        for face in tetra_faces(*element) {
            if !face.iter().all(|node_index| {
                mesh.nodes
                    .get(*node_index as usize)
                    .is_some_and(|node| (node[normal_axis] - coordinate).abs() <= tolerance)
            }) {
                continue;
            }
            if projected_triangle_area(mesh, face, plane).abs() <= 1.0e-30 {
                continue;
            }
            let mut key = face;
            key.sort_unstable();
            if seen.insert(key) {
                faces.push(face);
            }
        }
    }
    faces
}

fn tetra_faces(element: [u32; 4]) -> [[u32; 3]; 4] {
    [
        [element[0], element[1], element[2]],
        [element[0], element[1], element[3]],
        [element[0], element[2], element[3]],
        [element[1], element[2], element[3]],
    ]
}

fn select_faces_on_axis_target(
    mesh: &fullmag_runner::FemMeshPayload,
    faces: &[[u32; 3]],
    plane: SlicePlane,
    normal_axis: usize,
    target: f64,
    tolerance: f64,
) -> Vec<[u32; 3]> {
    faces
        .iter()
        .copied()
        .filter(|face| {
            face.iter().all(|node_index| {
                mesh.nodes
                    .get(*node_index as usize)
                    .is_some_and(|node| (node[normal_axis] - target).abs() <= tolerance)
            }) && projected_triangle_area(mesh, *face, plane).abs() > 1.0e-30
        })
        .collect()
}

fn remap_surface_triangle(
    mesh: &fullmag_runner::FemMeshPayload,
    summary: &FieldSampleSummary,
    face: [u32; 3],
    plane: SlicePlane,
    node_map: &mut BTreeMap<u32, usize>,
    samples: &mut Vec<[f64; 3]>,
) -> Option<[usize; 3]> {
    let mut remapped = [0usize; 3];
    for (slot, old_index) in face.iter().copied().enumerate() {
        let new_index = if let Some(index) = node_map.get(&old_index) {
            *index
        } else {
            let old_index_usize = old_index as usize;
            let value_offset = old_index_usize * 3;
            let sample = [
                *summary.values.get(value_offset)?,
                *summary.values.get(value_offset + 1)?,
                *summary.values.get(value_offset + 2)?,
            ];
            let index = samples.len();
            node_map.insert(old_index, index);
            samples.push(sample);
            index
        };
        remapped[slot] = new_index;
    }
    if projected_triangle_area(mesh, face, plane) < 0.0 {
        remapped.swap(1, 2);
    }
    Some(remapped)
}

fn plane_normal_axis(plane: SlicePlane) -> usize {
    match plane {
        SlicePlane::Xy => 2,
        SlicePlane::Xz => 1,
        SlicePlane::Yz => 0,
    }
}

fn plane_axes(plane: SlicePlane) -> (usize, usize) {
    match plane {
        SlicePlane::Xy => (0, 1),
        SlicePlane::Xz => (0, 2),
        SlicePlane::Yz => (1, 2),
    }
}

fn projected_triangle_area(
    mesh: &fullmag_runner::FemMeshPayload,
    face: [u32; 3],
    plane: SlicePlane,
) -> f64 {
    let (u_axis, v_axis) = plane_axes(plane);
    let Some(a) = mesh.nodes.get(face[0] as usize) else {
        return 0.0;
    };
    let Some(b) = mesh.nodes.get(face[1] as usize) else {
        return 0.0;
    };
    let Some(c) = mesh.nodes.get(face[2] as usize) else {
        return 0.0;
    };
    let bu = b[u_axis] - a[u_axis];
    let bv = b[v_axis] - a[v_axis];
    let cu = c[u_axis] - a[u_axis];
    let cv = c[v_axis] - a[v_axis];
    0.5 * (bu * cv - bv * cu)
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
) -> Vec<TopologicalChargeWarning> {
    match status {
        TopologicalChargeStatus::Ready => fdm_result_warnings(fdm_result),
        TopologicalChargeStatus::NoCurrentMagnetization => vec![TopologicalChargeWarning {
            code: "no_current_magnetization".to_string(),
            message: format!(
                "Current magnetization field data is not available for this object yet (snapshot: {requested_snapshot}, resolution: {requested_resolution}).",
            ),
        }],
        TopologicalChargeStatus::EmptySupport => vec![TopologicalChargeWarning {
            code: "empty_support".to_string(),
            message: format!(
                "No valid two-dimensional support is available for the selected object and analysis plane (magnetization samples: {sample_count}).",
            ),
        }],
        TopologicalChargeStatus::InvalidMagnetization => vec![TopologicalChargeWarning {
            code: "invalid_magnetization".to_string(),
            message: "No valid magnetization vectors are available on the selected support; the result is undefined, not Q = 0.".to_string(),
        }],
        TopologicalChargeStatus::DegenerateSupport => {
            vec![TopologicalChargeWarning {
                code: "degenerate_support".to_string(),
                message: "The selected support has no usable oriented triangles for topological charge.".to_string(),
            }]
        }
        TopologicalChargeStatus::UnderResolved => vec![TopologicalChargeWarning {
            code: "under_resolved".to_string(),
            message: "Topological charge was computed, but neighboring magnetization directions indicate an under-resolved texture.".to_string(),
        }],
        TopologicalChargeStatus::Stale => vec![TopologicalChargeWarning {
            code: "stale".to_string(),
            message: "Topological charge source data is stale.".to_string(),
        }],
        TopologicalChargeStatus::UnsupportedGeometry => vec![TopologicalChargeWarning {
            code: "unsupported_geometry".to_string(),
            message: "The selected geometry is not supported for topological charge.".to_string(),
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
