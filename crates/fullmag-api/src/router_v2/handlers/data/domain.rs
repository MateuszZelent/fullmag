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

use crate::error::ApiError;
use crate::fem_slice_overlay::{collect_fem_slice_overlay, FemSliceOverlayInput};
use crate::field_slice::{resolve_slice_query, FieldSliceQuery, SlicePlane};
use crate::router_v2::handlers::data::field_resolution::is_fdm_snapshot;
use crate::router_v2::handlers::sessions::status::{domain_generation_id, fdm_grid_shape};
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
        element_type: if is_fem {
            Some("tetrahedron".into())
        } else {
            None
        },
    }))
}

#[derive(Debug, Clone, Copy)]
struct FdmGridLayout {
    origin: [f64; 3],
    spacing: [f64; 3],
}

fn fdm_grid_descriptor(snapshot: &SessionStateResponse) -> FdmGridLayout {
    let layout = snapshot
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("artifact_layout"))
        .filter(|layout| layout.get("backend").and_then(Value::as_str) == Some("fdm"));
    let origin = layout
        .and_then(|layout| {
            layout
                .get("origin_m")
                .or_else(|| layout.get("origin"))
                .or_else(|| layout.get("grid_origin"))
                .or_else(|| layout.get("native_origin"))
        })
        .and_then(value_array3_f64_any_finite)
        .unwrap_or([0.0, 0.0, 0.0]);
    let spacing = layout
        .and_then(|layout| layout.get("cell_size"))
        .and_then(value_array3_f64_allow_planar)
        .unwrap_or([1.0, 1.0, 1.0]);

    FdmGridLayout { origin, spacing }
}

fn value_array3_f64_any_finite(value: &Value) -> Option<[f64; 3]> {
    let array = value.as_array()?;
    let values = [
        array.first()?.as_f64()?,
        array.get(1)?.as_f64()?,
        array.get(2)?.as_f64()?,
    ];
    values
        .iter()
        .all(|value| value.is_finite())
        .then_some(values)
}

fn value_array3_f64_allow_planar(value: &Value) -> Option<[f64; 3]> {
    let array = value.as_array()?;
    let values = [
        array.first()?.as_f64()?,
        array.get(1)?.as_f64()?,
        array.get(2)?.as_f64()?,
    ];
    let positive_axes = values.iter().filter(|value| **value > 0.0).count();
    values
        .iter()
        .all(|value| value.is_finite() && *value >= 0.0)
        .then_some(values)
        .filter(|_| positive_axes >= 2)
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
        domain_generation_id,
        etag: etag.clone(),
    };

    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &body))
}
