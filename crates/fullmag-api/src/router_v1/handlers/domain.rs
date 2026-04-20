//! Domain endpoints — meta and topology.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::State;
use axum::http::header::CONTENT_TYPE;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

use crate::error::ApiError;
use crate::field_store::serialize_fem_mesh_topology_binary_v1;
use crate::schemas::domain::*;
use crate::types::AppState;

#[utoipa::path(
    get,
    path = "/v1/live/current/domain/meta",
    responses(
        (status = 200, description = "Domain metadata", body = DomainMeta),
        (status = 404, description = "No active workspace"),
    ),
    tag = "domain"
)]
pub async fn get_domain_meta(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DomainMeta>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let is_fem = snapshot.fem_mesh.is_some();
    let latest = snapshot.live_state.as_ref().map(|l| &l.latest_step);

    let grid_shape = latest.map(|s| s.grid).unwrap_or([0, 0, 0]);

    let (cells, nodes, elements, boundary_faces) = if is_fem {
        let m = snapshot.fem_mesh.as_ref().unwrap();
        (
            None,
            Some(m.nodes.len() as u64),
            Some(m.elements.len() as u64),
            Some(m.boundary_faces.len() as u64),
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

    let generation_id = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|m| m.generation_id.as_deref())
        .and_then(|g| g.parse::<u64>().ok())
        .unwrap_or(0);

    let grid = if !is_fem && grid_shape.iter().any(|v| *v > 0) {
        Some(StructuredGridDescriptor {
            shape: grid_shape,
            origin: [0.0, 0.0, 0.0],
            spacing: [1.0, 1.0, 1.0],
        })
    } else {
        None
    };

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
    } else {
        Bounds3 {
            min: [0.0, 0.0, 0.0],
            max: [
                grid_shape[0] as f64,
                grid_shape[1] as f64,
                grid_shape[2] as f64,
            ],
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

#[utoipa::path(
    get,
    path = "/v1/live/current/domain/topology",
    responses(
        (status = 200, description = "Binary FEM topology (FMMT)", content_type = "application/octet-stream"),
        (status = 204, description = "Not applicable (FDM)"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "domain"
)]
pub async fn get_domain_topology(
    State(state): State<Arc<AppState>>,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    match snapshot.fem_mesh.as_ref() {
        Some(mesh) => {
            let binary = serialize_fem_mesh_topology_binary_v1(mesh);
            Ok(([(CONTENT_TYPE, "application/octet-stream")], binary).into_response())
        }
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}
