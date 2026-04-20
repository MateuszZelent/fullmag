//! Data-plane field store: direct read-only access to computed fields.
//!
//! These endpoints bypass the preview command queue and return field data
//! directly from `latest_fields` or `preview_cache` in memory.
//! This enables instant quantity switching in the frontend without going
//! through the control-plane preview pipeline.

use crate::error::ApiError;
use crate::preview::{quantity_spatial_domain, quantity_unit};
use crate::types::*;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::header::CONTENT_TYPE;
use axum::response::IntoResponse;
use axum::Json;
use fullmag_quantities::quantity_spec;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

// ── Catalog entry ───────────────────────────────────────────────────────

/// Lightweight metadata for a single field — no heavy payload.
#[derive(Debug, Serialize)]
pub(crate) struct LiveFieldCatalogEntry {
    pub quantity_id: String,
    pub label: String,
    pub kind: String, // "vector_field" | "spatial_scalar" | "global_scalar"
    pub unit: String,
    pub spatial_domain: String, // "magnetic_only" | "full_domain"
    pub n_comp: usize,
    pub source: String, // "latest_fields" | "preview_cache"
    pub available: bool,
    pub element_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grid: Option<[u32; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<FieldStats>,
}

#[derive(Debug, Serialize)]
pub(crate) struct FieldStats {
    pub min: f64,
    pub max: f64,
    pub mean: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_min: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_max: Option<[f64; 3]>,
}

fn compute_stats(values: &[f64], n_comp: usize) -> Option<FieldStats> {
    if values.is_empty() {
        return None;
    }
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    let mut sum = 0.0_f64;
    for &v in values {
        if v < min {
            min = v;
        }
        if v > max {
            max = v;
        }
        sum += v;
    }
    let mean = sum / values.len() as f64;

    let (component_min, component_max) = if n_comp == 3 && values.len() >= 3 {
        let mut cmin = [f64::INFINITY; 3];
        let mut cmax = [f64::NEG_INFINITY; 3];
        for chunk in values.chunks_exact(3) {
            for c in 0..3 {
                if chunk[c] < cmin[c] {
                    cmin[c] = chunk[c];
                }
                if chunk[c] > cmax[c] {
                    cmax[c] = chunk[c];
                }
            }
        }
        (Some(cmin), Some(cmax))
    } else {
        (None, None)
    };

    Some(FieldStats {
        min,
        max,
        mean,
        component_min,
        component_max,
    })
}

fn live_magnetization_snapshot(
    snapshot: &SessionStateResponse,
) -> Option<(&[f64], [u32; 3], usize)> {
    let live_state = snapshot.live_state.as_ref()?;
    let magnetization = live_state.latest_step.magnetization.as_deref()?;
    if magnetization.is_empty() || magnetization.len() % 3 != 0 {
        return None;
    }
    let node_count = magnetization.len() / 3;
    let grid = if live_state.latest_step.grid.iter().any(|value| *value > 0) {
        live_state.latest_step.grid
    } else {
        [node_count as u32, 1, 1]
    };
    Some((magnetization, grid, node_count))
}

// ── Vector response ─────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub(crate) struct LiveFieldVectorResponse {
    pub quantity_id: String,
    pub unit: String,
    pub n_comp: usize,
    pub element_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grid: Option<[u32; 3]>,
    pub values: Vec<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_mask: Option<Vec<bool>>,
    pub source: String,
}

// ── Query parameters ────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub(crate) struct FieldVectorQuery {
    #[serde(default)]
    #[allow(dead_code)]
    pub format: Option<String>, // "json" (default) | "bin"
}

#[derive(Debug, Deserialize)]
pub(crate) struct FemMeshTopologyQuery {
    #[serde(default)]
    pub generation_id: Option<String>,
    #[serde(default)]
    pub format: Option<String>, // "bin" (default)
}

const FIELD_VECTOR_BINARY_HEADER_LEN: usize = 48;
const FIELD_VECTOR_BINARY_VERSION: u8 = 2;
const FIELD_VECTOR_BINARY_KIND_F64: u8 = 1;
const FIELD_VECTOR_BINARY_QUANTITY_ID_LEN: usize = 16;
const FEM_MESH_TOPOLOGY_BINARY_HEADER_LEN: usize = 32;
const FEM_MESH_TOPOLOGY_BINARY_VERSION: u8 = 1;
const FEM_MESH_TOPOLOGY_BINARY_KIND_F64_U32: u8 = 1;

fn flatten_json_field_values(raw: &Value) -> Vec<f64> {
    raw.get("values")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .flat_map(|v| {
                    if let Some(inner) = v.as_array() {
                        inner.iter().filter_map(|c| c.as_f64()).collect::<Vec<_>>()
                    } else if let Some(f) = v.as_f64() {
                        vec![f]
                    } else {
                        vec![]
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn json_field_grid(raw: &Value) -> Option<[u32; 3]> {
    raw.get("layout")
        .and_then(|l| l.get("grid_cells"))
        .and_then(|g| g.as_array())
        .and_then(|g| {
            if g.len() == 3 {
                Some([
                    g[0].as_u64().unwrap_or(0) as u32,
                    g[1].as_u64().unwrap_or(0) as u32,
                    g[2].as_u64().unwrap_or(0) as u32,
                ])
            } else {
                None
            }
        })
}

pub(crate) fn serialize_field_vector_binary_v2(
    quantity_id: &str,
    n_comp: usize,
    grid: [u32; 3],
    values: &[f64],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(FIELD_VECTOR_BINARY_HEADER_LEN + values.len() * 8);
    out.extend_from_slice(b"FMVP");
    out.push(FIELD_VECTOR_BINARY_VERSION);
    out.push(FIELD_VECTOR_BINARY_KIND_F64);
    out.push(n_comp.min(u8::MAX as usize) as u8);
    out.push(0u8);
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&(values.len() as u32).to_le_bytes());
    out.extend_from_slice(&grid[0].to_le_bytes());
    out.extend_from_slice(&grid[1].to_le_bytes());
    out.extend_from_slice(&grid[2].to_le_bytes());
    let id_bytes = quantity_id.as_bytes();
    let copy_len = id_bytes.len().min(FIELD_VECTOR_BINARY_QUANTITY_ID_LEN);
    out.extend_from_slice(&id_bytes[..copy_len]);
    for _ in copy_len..FIELD_VECTOR_BINARY_QUANTITY_ID_LEN {
        out.push(0u8);
    }
    out.extend_from_slice(&[0u8; 4]);
    for value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

pub(crate) fn serialize_fem_mesh_topology_binary_v1(mesh: &fullmag_runner::FemMeshPayload) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        FEM_MESH_TOPOLOGY_BINARY_HEADER_LEN
            + mesh.nodes.len() * 3 * std::mem::size_of::<f64>()
            + mesh.elements.len() * 4 * std::mem::size_of::<u32>()
            + mesh.boundary_faces.len() * 3 * std::mem::size_of::<u32>()
            + mesh.element_markers.len() * std::mem::size_of::<u32>()
            + mesh.boundary_markers.len() * std::mem::size_of::<u32>(),
    );
    out.extend_from_slice(b"FMMT");
    out.push(FEM_MESH_TOPOLOGY_BINARY_VERSION);
    out.push(FEM_MESH_TOPOLOGY_BINARY_KIND_F64_U32);
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(mesh.nodes.len() as u32).to_le_bytes());
    out.extend_from_slice(&(mesh.elements.len() as u32).to_le_bytes());
    out.extend_from_slice(&(mesh.boundary_faces.len() as u32).to_le_bytes());
    out.extend_from_slice(&(mesh.element_markers.len() as u32).to_le_bytes());
    out.extend_from_slice(&(mesh.boundary_markers.len() as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    for node in &mesh.nodes {
        out.extend_from_slice(&node[0].to_le_bytes());
        out.extend_from_slice(&node[1].to_le_bytes());
        out.extend_from_slice(&node[2].to_le_bytes());
    }
    for element in &mesh.elements {
        out.extend_from_slice(&element[0].to_le_bytes());
        out.extend_from_slice(&element[1].to_le_bytes());
        out.extend_from_slice(&element[2].to_le_bytes());
        out.extend_from_slice(&element[3].to_le_bytes());
    }
    for face in &mesh.boundary_faces {
        out.extend_from_slice(&face[0].to_le_bytes());
        out.extend_from_slice(&face[1].to_le_bytes());
        out.extend_from_slice(&face[2].to_le_bytes());
    }
    for marker in &mesh.element_markers {
        out.extend_from_slice(&marker.to_le_bytes());
    }
    for marker in &mesh.boundary_markers {
        out.extend_from_slice(&marker.to_le_bytes());
    }
    out
}

// ── Handlers ────────────────────────────────────────────────────────────

/// `GET /v1/live/current/fields/catalog`
///
/// Returns lightweight metadata for every field that is currently in memory
/// (`latest_fields` or `preview_cache`).  No heavy payloads — just enough
/// for the frontend to know which quantities can be read instantly.
pub(crate) async fn get_live_field_catalog(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<LiveFieldCatalogEntry>>, ApiError> {
    let current = state.current_live_state.read().await;
    let snapshot = current
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let mut entries: Vec<LiveFieldCatalogEntry> = Vec::new();

    // 1) Fields from latest_fields (JSON-encoded solver outputs)
    for (quantity_id, value) in snapshot.latest_fields.entries() {
        let spec = quantity_spec(quantity_id);
        let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);
        let label = spec
            .map(|s| s.label.to_string())
            .unwrap_or_else(|| quantity_id.to_string());
        let element_count = value
            .get("values")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        let grid = value
            .get("layout")
            .and_then(|l| l.get("grid_cells"))
            .and_then(|g| g.as_array())
            .and_then(|g| {
                if g.len() == 3 {
                    Some([
                        g[0].as_u64().unwrap_or(0) as u32,
                        g[1].as_u64().unwrap_or(0) as u32,
                        g[2].as_u64().unwrap_or(0) as u32,
                    ])
                } else {
                    None
                }
            });

        // Compute stats from raw values
        let flat_values: Vec<f64> = value
            .get("values")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .flat_map(|v| {
                        if let Some(inner) = v.as_array() {
                            inner.iter().filter_map(|c| c.as_f64()).collect::<Vec<_>>()
                        } else if let Some(f) = v.as_f64() {
                            vec![f]
                        } else {
                            vec![]
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        let stats = compute_stats(&flat_values, n_comp);

        entries.push(LiveFieldCatalogEntry {
            quantity_id: quantity_id.to_string(),
            label,
            kind: spec
                .map(|s| s.shape.as_api_kind().to_string())
                .unwrap_or_else(|| "vector_field".to_string()),
            unit: quantity_unit(quantity_id).to_string(),
            spatial_domain: quantity_spatial_domain(quantity_id).to_string(),
            n_comp,
            source: "latest_fields".to_string(),
            available: true,
            element_count,
            grid,
            stats,
        });
    }

    // 2) Fields from preview_cache (pre-computed by runtime)
    for (quantity_id, field) in snapshot.preview_cache.iter() {
        // Skip if already covered by latest_fields
        if entries.iter().any(|e| e.quantity_id == *quantity_id) {
            continue;
        }
        let spec = quantity_spec(quantity_id);
        let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);
        let label = spec
            .map(|s| s.label.to_string())
            .unwrap_or_else(|| quantity_id.to_string());
        let element_count = if n_comp > 0 {
            field.vector_field_values.len() / n_comp
        } else {
            field.vector_field_values.len()
        };
        let stats = compute_stats(&field.vector_field_values, n_comp);
        entries.push(LiveFieldCatalogEntry {
            quantity_id: quantity_id.to_string(),
            label,
            kind: spec
                .map(|s| s.shape.as_api_kind().to_string())
                .unwrap_or_else(|| "vector_field".to_string()),
            unit: field.unit.clone(),
            spatial_domain: quantity_spatial_domain(quantity_id).to_string(),
            n_comp,
            source: "preview_cache".to_string(),
            available: true,
            element_count,
            grid: Some(field.preview_grid),
            stats,
        });
    }

    if !entries.iter().any(|entry| entry.quantity_id == "m") {
        if let Some((magnetization, grid, node_count)) = live_magnetization_snapshot(snapshot) {
            let n_comp = quantity_spec("m").map(|spec| spec.n_comp as usize).unwrap_or(3);
            entries.push(LiveFieldCatalogEntry {
                quantity_id: "m".to_string(),
                label: quantity_spec("m")
                    .map(|spec| spec.label.to_string())
                    .unwrap_or_else(|| "m".to_string()),
                kind: quantity_spec("m")
                    .map(|spec| spec.shape.as_api_kind().to_string())
                    .unwrap_or_else(|| "vector_field".to_string()),
                unit: quantity_unit("m").to_string(),
                spatial_domain: quantity_spatial_domain("m").to_string(),
                n_comp,
                source: "live_state".to_string(),
                available: true,
                element_count: node_count,
                grid: Some(grid),
                stats: compute_stats(magnetization, n_comp),
            });
        }
    }

    Ok(Json(entries))
}

/// `GET /v1/live/current/fields/:quantity/vector`
///
/// Returns the raw vector field values for a quantity.  Reads directly from
/// `latest_fields` or `preview_cache` in memory — no command queue involved.
pub(crate) async fn get_live_field_vector(
    State(state): State<Arc<AppState>>,
    AxumPath(quantity): AxumPath<String>,
    Query(query): Query<FieldVectorQuery>,
) -> Result<axum::response::Response, ApiError> {
    let wants_binary = matches!(query.format.as_deref(), Some("bin"));

    let current = state.current_live_state.read().await;
    let snapshot = current
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    // Try latest_fields first (full-resolution solver output)
    if let Some(raw) = snapshot.latest_fields.get(&quantity) {
        let spec = quantity_spec(&quantity);
        let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);
        let values = flatten_json_field_values(raw);

        let element_count = if n_comp > 0 {
            values.len() / n_comp
        } else {
            values.len()
        };

        let grid = json_field_grid(raw);

        if wants_binary {
            let binary = serialize_field_vector_binary_v2(
                &quantity,
                n_comp,
                grid.unwrap_or([element_count as u32, 1, 1]),
                &values,
            );
            return Ok(([(CONTENT_TYPE, "application/octet-stream")], binary).into_response());
        }

        let resp = LiveFieldVectorResponse {
            quantity_id: quantity.clone(),
            unit: quantity_unit(&quantity).to_string(),
            n_comp,
            element_count,
            grid,
            values,
            active_mask: None,
            source: "latest_fields".to_string(),
        };
        return Ok(Json(resp).into_response());
    }

    // Fall back to preview_cache
    if let Some(field) = snapshot.preview_cache.get(&quantity) {
        let spec = quantity_spec(&quantity);
        let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);
        let element_count = if n_comp > 0 {
            field.vector_field_values.len() / n_comp
        } else {
            field.vector_field_values.len()
        };

        if wants_binary {
            let binary = serialize_field_vector_binary_v2(
                &quantity,
                n_comp,
                field.preview_grid,
                &field.vector_field_values,
            );
            return Ok(([(CONTENT_TYPE, "application/octet-stream")], binary).into_response());
        }

        let resp = LiveFieldVectorResponse {
            quantity_id: quantity.clone(),
            unit: field.unit.clone(),
            n_comp,
            element_count,
            grid: Some(field.preview_grid),
            values: field.vector_field_values.clone(),
            active_mask: field.active_mask.clone(),
            source: "preview_cache".to_string(),
        };
        return Ok(Json(resp).into_response());
    }

    if quantity == "m" {
        if let Some((magnetization, grid, node_count)) = live_magnetization_snapshot(snapshot) {
            let n_comp = quantity_spec("m").map(|spec| spec.n_comp as usize).unwrap_or(3);
            if wants_binary {
                let binary =
                    serialize_field_vector_binary_v2("m", n_comp, grid, magnetization);
                return Ok(([(CONTENT_TYPE, "application/octet-stream")], binary).into_response());
            }

            let resp = LiveFieldVectorResponse {
                quantity_id: "m".to_string(),
                unit: quantity_unit("m").to_string(),
                n_comp,
                element_count: node_count,
                grid: Some(grid),
                values: magnetization.to_vec(),
                active_mask: None,
                source: "live_state".to_string(),
            };
            return Ok(Json(resp).into_response());
        }
    }

    Err(ApiError::not_found(&format!(
        "field '{}' not available in memory",
        quantity
    )))
}

// ── Meta endpoint ──────────────────────────────────────────────────────

/// `GET /v1/live/current/fields/:quantity/meta`
///
/// Returns catalog-level metadata + computed stats for a single field,
/// without the heavy vector payload.  Useful for the frontend to check
/// availability and stats without downloading the full buffer.
pub(crate) async fn get_live_field_meta(
    State(state): State<Arc<AppState>>,
    AxumPath(quantity): AxumPath<String>,
) -> Result<Json<LiveFieldCatalogEntry>, ApiError> {
    let current = state.current_live_state.read().await;
    let snapshot = current
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(&quantity);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);
    let label = spec
        .map(|s| s.label.to_string())
        .unwrap_or_else(|| quantity.clone());
    let kind = spec
        .map(|s| s.shape.as_api_kind().to_string())
        .unwrap_or_else(|| "vector_field".to_string());
    let unit = quantity_unit(&quantity).to_string();
    let spatial_domain = quantity_spatial_domain(&quantity).to_string();

    // Try latest_fields first
    if let Some(raw) = snapshot.latest_fields.get(&quantity) {
        let element_count = raw
            .get("values")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        let grid = raw
            .get("layout")
            .and_then(|l| l.get("grid_cells"))
            .and_then(|g| g.as_array())
            .and_then(|g| {
                if g.len() == 3 {
                    Some([
                        g[0].as_u64().unwrap_or(0) as u32,
                        g[1].as_u64().unwrap_or(0) as u32,
                        g[2].as_u64().unwrap_or(0) as u32,
                    ])
                } else {
                    None
                }
            });
        let flat_values: Vec<f64> = raw
            .get("values")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .flat_map(|v| {
                        if let Some(inner) = v.as_array() {
                            inner.iter().filter_map(|c| c.as_f64()).collect::<Vec<_>>()
                        } else if let Some(f) = v.as_f64() {
                            vec![f]
                        } else {
                            vec![]
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        let stats = compute_stats(&flat_values, n_comp);
        return Ok(Json(LiveFieldCatalogEntry {
            quantity_id: quantity,
            label,
            kind,
            unit,
            spatial_domain,
            n_comp,
            source: "latest_fields".to_string(),
            available: true,
            element_count,
            grid,
            stats,
        }));
    }

    // Fall back to preview_cache
    if let Some(field) = snapshot.preview_cache.get(&quantity) {
        let element_count = if n_comp > 0 {
            field.vector_field_values.len() / n_comp
        } else {
            field.vector_field_values.len()
        };
        let stats = compute_stats(&field.vector_field_values, n_comp);
        return Ok(Json(LiveFieldCatalogEntry {
            quantity_id: quantity,
            label,
            kind,
            unit: field.unit.clone(),
            spatial_domain,
            n_comp,
            source: "preview_cache".to_string(),
            available: true,
            element_count,
            grid: Some(field.preview_grid),
            stats,
        }));
    }

    if quantity == "m" {
        if let Some((magnetization, grid, node_count)) = live_magnetization_snapshot(snapshot) {
            let stats = compute_stats(magnetization, n_comp);
            return Ok(Json(LiveFieldCatalogEntry {
                quantity_id: quantity,
                label,
                kind,
                unit,
                spatial_domain,
                n_comp,
                source: "live_state".to_string(),
                available: true,
                element_count: node_count,
                grid: Some(grid),
                stats,
            }));
        }
    }

    Err(ApiError::not_found(&format!(
        "field '{}' not available in memory",
        quantity
    )))
}

/// `GET /v1/live/current/fem-mesh/topology`
///
/// Returns the active FEM topology as a compact binary blob, separate from
/// the JSON session snapshot. This keeps bootstrap/poll payloads metadata-only
/// while the frontend hydrates topology once per mesh generation.
pub(crate) async fn get_live_fem_mesh_topology(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FemMeshTopologyQuery>,
) -> Result<axum::response::Response, ApiError> {
    if query.format.as_deref().is_some_and(|format| format != "bin") {
        return Err(ApiError::bad_request(
            "unsupported fem mesh topology format (expected 'bin')",
        ));
    }

    let current = state.current_live_state.read().await;
    let snapshot = current
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let mesh = snapshot
        .fem_mesh
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active FEM mesh topology in memory"))?;

    if let Some(requested_generation_id) = query.generation_id.as_deref() {
        if let Some(current_generation_id) = mesh.generation_id.as_deref() {
            if current_generation_id != requested_generation_id {
                return Err(ApiError::bad_request(format!(
                    "requested FEM mesh generation '{}' is no longer current (current='{}')",
                    requested_generation_id, current_generation_id
                )));
            }
        }
    }

    let binary = serialize_fem_mesh_topology_binary_v1(mesh);
    Ok(([(CONTENT_TYPE, "application/octet-stream")], binary).into_response())
}
