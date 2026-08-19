//! Domain endpoints — meta and topology.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::fields::{load_fdm_multilayer_airbox_carrier, FdmMultilayerAirboxCarrier};
use crate::error::ApiError;
use crate::fem_slice_overlay::{collect_fem_slice_overlay, FemSliceOverlayInput};
use crate::field_slice::{resolve_slice_query, FieldSliceQuery, SlicePlane};
use crate::router_v2::handlers::data::field_resolution::is_fdm_snapshot;
use crate::router_v2::handlers::sessions::status::{
    domain_generation_id, domain_generation_revision, fdm_grid_geometry, fdm_grid_shape,
};
use crate::schemas::domain::*;
use crate::types::{AppState, SessionStateResponse};

#[derive(Debug, Clone, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct DomainSliceMeshOverlayQuery {
    pub plane: SlicePlane,
    pub cut_world: Option<f64>,
    pub cut_norm: Option<f64>,
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/domain/meta",
    responses(
        (status = 200, description = "Domain metadata", body = DomainMeta),
        (status = 404, description = "No active workspace"),
    ),
    tag = "data"
)]
pub async fn get_domain_meta(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DomainMeta>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let is_fem = snapshot.fem_mesh.is_some() && !is_fdm_snapshot(snapshot);
    let latest = snapshot.live_state.as_ref().map(|l| &l.latest_step);

    let grid_shape = if is_fem {
        [0, 0, 0]
    } else {
        fdm_grid_shape(snapshot, latest.map(|s| s.grid))
    };

    let (cells, nodes, elements, boundary_faces) = if is_fem {
        let m = snapshot.fem_mesh.as_ref().unwrap();
        (
            None,
            Some(m.nodes.len() as u64),
            Some(m.cell_count() as u64),
            Some(m.facet_count() as u64),
        )
    } else {
        (
            Some(grid_shape[0] as u64 * grid_shape[1] as u64 * grid_shape[2] as u64),
            None,
            None,
            None,
        )
    };

    let mut units = HashMap::new();
    units.insert("length".into(), "m".into());

    let generation_id = domain_generation_id(snapshot);

    let fdm_grid =
        (!is_fem && grid_shape.iter().any(|v| *v > 0)).then(|| fdm_grid_descriptor(snapshot));

    let grid = fdm_grid.as_ref().map(|layout| StructuredGridDescriptor {
        shape: grid_shape,
        origin: layout.origin,
        spacing: layout.spacing,
    });

    let bounds = if is_fem {
        let m = snapshot.fem_mesh.as_ref().unwrap();
        let (mut bmin, mut bmax) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
        for node in &m.nodes {
            for i in 0..3 {
                if node[i] < bmin[i] {
                    bmin[i] = node[i];
                }
                if node[i] > bmax[i] {
                    bmax[i] = node[i];
                }
            }
        }
        Bounds3 {
            min: bmin,
            max: bmax,
        }
    } else if let Some(layout) = fdm_grid.as_ref() {
        Bounds3 {
            min: layout.origin,
            max: [
                layout.origin[0] + grid_shape[0] as f64 * layout.spacing[0],
                layout.origin[1] + grid_shape[1] as f64 * layout.spacing[1],
                layout.origin[2] + grid_shape[2] as f64 * layout.spacing[2],
            ],
        }
    } else {
        Bounds3 {
            min: [0.0, 0.0, 0.0],
            max: [0.0, 0.0, 0.0],
        }
    };

    Ok(Json(DomainMeta {
        domain_id: "current".into(),
        discretization: if is_fem { "fem" } else { "fdm" }.into(),
        generation_id,
        dimension: 3,
        coordinate_system: "cartesian".into(),
        units,
        bounds,
        counts: DomainCounts {
            cells,
            nodes,
            elements,
            boundary_faces,
        },
        grid,
        element_type: is_fem
            .then(|| snapshot.fem_mesh.as_ref().and_then(fem_element_type))
            .flatten(),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/domain/fdm-multilayer-layout",
    responses(
        (status = 200, description = "FDM multilayer native and common transform layouts", body = FdmMultilayerLayoutResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "data"
)]
pub async fn get_fdm_multilayer_layout(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FdmMultilayerLayoutResource>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    Ok(Json(fdm_multilayer_layout_resource(snapshot)))
}

fn fdm_multilayer_layout_resource(snapshot: &SessionStateResponse) -> FdmMultilayerLayoutResource {
    let generation = domain_generation_id(snapshot);
    let revisions = (
        domain_generation_revision(snapshot),
        snapshot.field_samples_revision,
        snapshot.stage_execution_revision,
    );
    let metadata = snapshot.metadata.as_ref();
    let artifact = metadata
        .and_then(|value| value.get("artifact_layout"))
        .filter(|value| value.get("backend").and_then(Value::as_str) == Some("fdm_multilayer"));
    let backend_plan = metadata
        .and_then(|value| value.get("execution_plan"))
        .and_then(|value| value.get("backend_plan"))
        .filter(|value| value.get("layers").is_some() && value.get("common_cells").is_some());
    let available = artifact.is_some() || backend_plan.is_some();
    if !available {
        return FdmMultilayerLayoutResource {
            schema_version: "fdm-multilayer-layout.v1".into(),
            domain_generation_id: generation,
            available: false,
            unavailable_reason: Some("not_fdm_multilayer".into()),
            backend: "fdm".into(),
            layout_revision: revisions.0,
            observation_revision: revisions.1,
            execution_revision: revisions.2,
            layout_fingerprint: None,
            strategy: None,
            requested_mode: None,
            resolved_mode: None,
            common_transform_layout: None,
            layers: Vec::new(),
            airbox: unavailable_fdm_multilayer_airbox_resource("not_fdm_multilayer"),
        };
    }

    let plan_summary = backend_plan.and_then(|value| value.get("planner_summary"));
    let strategy = plan_summary
        .and_then(|value| value.get("selected_strategy"))
        .and_then(Value::as_str)
        .or_else(|| {
            plan_summary
                .and_then(|value| value.get("requested_strategy"))
                .and_then(Value::as_str)
        })
        .map(str::to_owned);
    let requested_mode = plan_summary
        .and_then(|value| value.get("requested_mode"))
        .and_then(Value::as_str)
        .or_else(|| {
            backend_plan
                .and_then(|value| value.get("mode"))
                .and_then(Value::as_str)
        })
        .map(str::to_owned);
    let resolved_mode = plan_summary
        .and_then(|value| value.get("resolved_mode"))
        .and_then(Value::as_str)
        .or_else(|| {
            backend_plan
                .and_then(|value| value.get("mode"))
                .and_then(Value::as_str)
        })
        .map(str::to_owned);

    let certificate = backend_plan.and_then(|value| value.get("grid_certificate"));
    let common_shape = backend_plan
        .and_then(|value| value.get("common_cells"))
        .or_else(|| artifact.and_then(|value| value.get("common_cells")))
        .and_then(value_array3_u32)
        .unwrap_or([0, 0, 0]);
    let common_cell_size = certificate
        .and_then(|value| value.get("cell_m"))
        .and_then(value_array3_f64)
        .or_else(|| {
            artifact
                .and_then(|value| value.get("layers"))
                .and_then(Value::as_array)
                .and_then(|layers| layers.first())
                .and_then(|value| value.get("convolution_cell_size"))
                .and_then(value_array3_f64)
        })
        .unwrap_or([0.0, 0.0, 0.0]);
    let common_origin = certificate
        .and_then(|value| value.get("origin_m"))
        .and_then(value_array3_f64)
        .or_else(|| {
            artifact
                .and_then(|value| value.get("layers"))
                .and_then(Value::as_array)
                .and_then(|layers| layers.first())
                .and_then(|value| value.get("convolution_origin"))
                .and_then(value_array3_f64)
        })
        .unwrap_or([0.0, 0.0, 0.0]);
    let common_layout =
        (common_shape.iter().all(|value| *value > 0)).then(|| FdmCommonTransformLayoutResource {
            shape: common_shape,
            cell_size: common_cell_size,
            origin: common_origin,
            fft_shape: common_shape.map(|value| value.saturating_mul(2)),
            is_physical_mesh: false,
            provenance: "planner.grid_certificate;fft-scratch-only".into(),
        });

    let plan_layers = backend_plan
        .and_then(|value| value.get("layers"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let artifact_layers = artifact
        .and_then(|value| value.get("layers"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let transfer_provenance = metadata
        .and_then(|value| value.get("mesh"))
        .and_then(|value| value.get("transfer_provenance"))
        .and_then(Value::as_array);
    let layer_count = plan_layers.len().max(artifact_layers.len());
    let layers = (0..layer_count)
        .filter_map(|index| {
            let plan_layer = plan_layers.get(index);
            let artifact_layer = artifact_layers.get(index);
            let source = plan_layer.or(artifact_layer)?;
            let magnet_name = value_string(source, "magnet_name")
                .or_else(|| artifact_layer.and_then(|value| value_string(value, "magnet_name")))?;
            let native_grid = plan_layer
                .and_then(|value| value.get("native_grid"))
                .or_else(|| artifact_layer.and_then(|value| value.get("native_grid")))
                .and_then(value_array3_u32)?;
            let native_cell_size = plan_layer
                .and_then(|value| value.get("native_cell_size"))
                .or_else(|| artifact_layer.and_then(|value| value.get("native_cell_size")))
                .and_then(value_array3_f64)?;
            let native_origin = plan_layer
                .and_then(|value| value.get("native_origin"))
                .or_else(|| artifact_layer.and_then(|value| value.get("native_origin")))
                .and_then(value_array3_f64)?;
            let convolution_grid = artifact_layer
                .and_then(|value| value.get("convolution_grid"))
                .or_else(|| plan_layer.and_then(|value| value.get("convolution_grid")))
                .and_then(value_array3_u32)
                .unwrap_or(common_shape);
            let convolution_cell_size = artifact_layer
                .and_then(|value| value.get("convolution_cell_size"))
                .or_else(|| plan_layer.and_then(|value| value.get("convolution_cell_size")))
                .and_then(value_array3_f64)
                .unwrap_or(common_cell_size);
            let layer_id = value_string(source, "layer_id")
                .or_else(|| value_string(source, "object_id").map(|id| format!("layer:{id}")))
                .unwrap_or_else(|| format!("layer:{index}:{magnet_name}"));
            let object_id = value_string(source, "object_id")
                .unwrap_or_else(|| format!("object:{magnet_name}"));
            let active_mask = plan_layer
                .and_then(|value| value.get("native_active_mask"))
                .and_then(Value::as_array);
            let total_cells = native_grid
                .iter()
                .map(|value| u64::from(*value))
                .product::<u64>();
            let active_cell_count = active_mask
                .map(|mask| {
                    mask.iter()
                        .filter(|value| value.as_bool() == Some(true))
                        .count() as u64
                })
                .or_else(|| {
                    artifact_layer
                        .and_then(|value| value.get("active_cell_count"))
                        .and_then(Value::as_u64)
                })
                .unwrap_or(total_cells);
            let source_grid_fingerprint = transfer_provenance
                .and_then(|entries| {
                    entries.iter().find(|entry| {
                        value_string(entry, "magnet_name").as_deref() == Some(magnet_name.as_str())
                    })
                })
                .and_then(|entry| value_string(entry, "source_grid_fingerprint"));
            Some(FdmLayerLayoutResource {
                layer_id,
                object_id,
                magnet_name,
                native_grid,
                native_cell_size,
                native_origin,
                native_grid_fingerprint: source_grid_fingerprint,
                convolution_grid,
                convolution_cell_size,
                transfer_kind: value_string(source, "transfer_kind")
                    .unwrap_or_else(|| "identity".into()),
                active_mask_present: active_mask.is_some()
                    || artifact_layer
                        .and_then(|value| value.get("active_mask_present"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                active_cell_count,
                inactive_cell_count: total_cells.saturating_sub(active_cell_count),
                mask_provenance: active_mask
                    .is_some()
                    .then(|| "execution_plan.layers.native_active_mask".into()),
            })
        })
        .collect();
    let layout_fingerprint = artifact.or(backend_plan).and_then(|value| {
        serde_json::to_vec(value).ok().map(|bytes| {
            let mut hasher = Sha256::new();
            hasher.update(bytes);
            format!("sha256:{:x}", hasher.finalize())
        })
    });

    FdmMultilayerLayoutResource {
        schema_version: "fdm-multilayer-layout.v1".into(),
        domain_generation_id: generation,
        available: true,
        unavailable_reason: None,
        backend: "fdm_multilayer".into(),
        layout_revision: revisions.0,
        observation_revision: revisions.1,
        execution_revision: revisions.2,
        layout_fingerprint,
        strategy,
        requested_mode,
        resolved_mode,
        common_transform_layout: common_layout,
        layers,
        airbox: fdm_multilayer_airbox_resource(snapshot, revisions.1),
    }
}

fn unavailable_fdm_multilayer_airbox_resource(reason: &str) -> FdmMultilayerAirboxResource {
    FdmMultilayerAirboxResource {
        carrier_available: false,
        h_demag_available: false,
        h_eff_available: false,
        unavailable_reason: Some(reason.to_string()),
        h_eff_unavailable_reason: Some("fdm_multilayer_airbox_h_eff_unavailable.v1".into()),
        cells: None,
        origin_m: None,
        cell_size_m: None,
        carrier_fingerprint: None,
        sample_count: None,
        value_count: None,
        carrier_revision: None,
        source_policy: None,
        target_only: None,
        source_grid_fingerprints: None,
        source_runtime_identity: None,
    }
}

fn fdm_multilayer_airbox_resource(
    snapshot: &SessionStateResponse,
    observation_revision: u64,
) -> FdmMultilayerAirboxResource {
    match load_fdm_multilayer_airbox_carrier(snapshot) {
        Ok(Some(carrier)) => {
            fdm_multilayer_airbox_resource_from_carrier(carrier, observation_revision)
        }
        Ok(None) => unavailable_fdm_multilayer_airbox_resource("airbox_carrier_missing"),
        Err(reason) => {
            unavailable_fdm_multilayer_airbox_resource(&format!("airbox_carrier_invalid:{reason}"))
        }
    }
}

fn fdm_multilayer_airbox_resource_from_carrier(
    carrier: FdmMultilayerAirboxCarrier,
    observation_revision: u64,
) -> FdmMultilayerAirboxResource {
    FdmMultilayerAirboxResource {
        carrier_available: true,
        h_demag_available: true,
        h_eff_available: false,
        unavailable_reason: None,
        h_eff_unavailable_reason: Some("fdm_multilayer_airbox_h_eff_unavailable.v1".into()),
        cells: Some(carrier.cells),
        origin_m: Some(carrier.origin_m),
        cell_size_m: Some(carrier.cell_size_m),
        carrier_fingerprint: Some(format!("sha256:{}", carrier.carrier_fingerprint)),
        sample_count: Some(carrier.sample_count as u64),
        value_count: Some(carrier.values.len() as u64),
        carrier_revision: Some(observation_revision),
        source_policy: Some(carrier.source_policy),
        target_only: Some(true),
        source_grid_fingerprints: Some(
            carrier
                .source_grid_fingerprints
                .into_iter()
                .map(|fingerprint| format!("sha256:{fingerprint}"))
                .collect(),
        ),
        source_runtime_identity: Some(carrier.source_runtime_identity),
    }
}

fn value_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn value_array3_u32(value: &Value) -> Option<[u32; 3]> {
    let values = value.as_array()?;
    Some([
        u32::try_from(values.first()?.as_u64()?).ok()?,
        u32::try_from(values.get(1)?.as_u64()?).ok()?,
        u32::try_from(values.get(2)?.as_u64()?).ok()?,
    ])
}

fn value_array3_f64(value: &Value) -> Option<[f64; 3]> {
    let values = value.as_array()?;
    Some([
        values.first()?.as_f64()?,
        values.get(1)?.as_f64()?,
        values.get(2)?.as_f64()?,
    ])
}

fn fem_element_type(mesh: &fullmag_runner::FemMeshPayload) -> Option<String> {
    let first = *mesh.cells.types.first()?;
    if mesh.cells.types.iter().any(|cell_type| *cell_type != first) {
        return Some("mixed".to_string());
    }
    Some(
        match first {
            fullmag_ir::FemCellTypeIR::Tet4 => "tetrahedron",
            fullmag_ir::FemCellTypeIR::Prism6 => "prism",
            fullmag_ir::FemCellTypeIR::Pyramid5 => "pyramid",
            fullmag_ir::FemCellTypeIR::Hex8 => "hexahedron",
        }
        .to_string(),
    )
}

#[derive(Debug, Clone, Copy)]
struct FdmGridLayout {
    origin: [f64; 3],
    spacing: [f64; 3],
}

fn fdm_grid_descriptor(snapshot: &SessionStateResponse) -> FdmGridLayout {
    let (origin, spacing) =
        fdm_grid_geometry(snapshot).unwrap_or(([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]));

    FdmGridLayout { origin, spacing }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/domain/topology",
    params(
        ("If-None-Match" = Option<String>, Header, description = "Strong ETag from a previous domain topology response"),
        ("Range" = Option<String>, Header, description = "Optional single byte range for chunked FMMT topology reads")
    ),
    responses(
        (status = 200, description = "Binary FEM topology (FMMT v2)", content_type = "application/octet-stream"),
        (status = 206, description = "Partial binary FEM topology range (FMMT v2)", content_type = "application/octet-stream"),
        (status = 304, description = "Domain topology not modified for the supplied ETag"),
        (status = 409, description = "Active FEM topology is malformed"),
        (status = 416, description = "Requested topology byte range is not satisfiable"),
        (status = 204, description = "Not applicable (FDM)"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "data"
)]
pub async fn get_domain_topology(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    if is_fdm_snapshot(snapshot) {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    match snapshot.fem_mesh.as_ref() {
        Some(mesh) => {
            let generation_id = mesh.generation_id.as_deref().unwrap_or("no-generation");
            let topology_hash = fullmag_runner::fem_mesh_topology_fingerprint(mesh);
            let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
                "domain-topology:{generation_id}:{topology_hash}:{}",
                snapshot.mesh_revision,
            ));
            let mut response =
                crate::router_v2::handlers::shared::conditional_fem_topology_response(
                    &state, &headers, &etag, mesh,
                )
                .map_err(ApiError::conflict)?;
            crate::router_v2::handlers::shared::insert_mesh_topology_hash_header(
                &mut response,
                &topology_hash,
            );
            Ok(response)
        }
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/domain/slice/mesh-overlay",
    params(DomainSliceMeshOverlayQuery),
    responses(
        (status = 200, description = "Exact FEM 2D mesh overlay in slice coordinates", body = DomainSliceMeshOverlay),
        (status = 304, description = "Mesh overlay not modified for the supplied ETag"),
        (status = 204, description = "Not applicable (FDM)"),
        (status = 404, description = "No active workspace"),
        (status = 409, description = "FEM topology unavailable for slice overlay"),
    ),
    tag = "data"
)]
pub async fn get_domain_slice_mesh_overlay(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<DomainSliceMeshOverlayQuery>,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    if is_fdm_snapshot(snapshot) {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let Some(mesh) = snapshot.fem_mesh.as_ref() else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    let elements = mesh.require_tet4_elements().map_err(|error| {
        ApiError::conflict(format!(
            "FMMT v1 domain slice requires tet4 topology: {error}"
        ))
    })?;

    let resolved = resolve_slice_query(
        &FieldSliceQuery {
            plane: query.plane,
            component: None,
            cut_world: query.cut_world,
            cut_norm: query.cut_norm,
            x_size: None,
            y_size: None,
            max_points: None,
            include_arrows: None,
            arrow_every: None,
            max_arrows: None,
        },
        1,
    )?;
    let overlay = collect_fem_slice_overlay(
        FemSliceOverlayInput {
            nodes: &mesh.nodes,
            elements: &elements,
            element_markers: &mesh.element_markers,
        },
        &resolved,
    )?;
    let domain_generation_id = mesh
        .generation_id
        .as_deref()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "domain-slice-mesh-overlay:{domain_generation_id}:{}:{}:{:.17e}:{:.17e}:v1",
        snapshot.mesh_revision,
        overlay.plane.as_str(),
        overlay.cut_norm,
        overlay.cut_world,
    ));
    let segment_count = overlay.segments.len();
    let body = DomainSliceMeshOverlay {
        schema: "fullmag.domain_2d.mesh_overlay.v1".to_string(),
        plane: overlay.plane,
        cut_kind: if query.cut_world.is_some() {
            "world".to_string()
        } else {
            "normalized".to_string()
        },
        cut_world: overlay.cut_world,
        cut_norm: overlay.cut_norm,
        u_axis: overlay.u_axis.to_string(),
        v_axis: overlay.v_axis.to_string(),
        normal_axis: overlay.normal_axis.to_string(),
        bounds: Bounds2 {
            u_min: overlay.bounds.u_min,
            u_max: overlay.bounds.u_max,
            v_min: overlay.bounds.v_min,
            v_max: overlay.bounds.v_max,
        },
        segments: overlay
            .segments
            .into_iter()
            .map(|segment| DomainSliceMeshOverlaySegment {
                a: segment.a,
                b: segment.b,
            })
            .collect(),
        truncated: false,
        segment_count,
        point_count: 0,
        topology_revision: snapshot.mesh_revision,
        domain_generation_id: domain_generation_id.to_string(),
        etag: etag.clone(),
    };

    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &body))
}
