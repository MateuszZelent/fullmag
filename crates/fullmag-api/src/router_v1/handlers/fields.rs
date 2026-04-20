//! Field endpoints — catalog, meta, binary vector.

use std::sync::Arc;

use axum::extract::{Path as AxumPath, State};
use axum::http::header::CONTENT_TYPE;
use axum::response::IntoResponse;
use axum::Json;

use crate::error::ApiError;
use crate::field_store::serialize_field_vector_binary_v2;
use crate::preview::{quantity_spatial_domain, quantity_unit};
use crate::schemas::fields::*;
use crate::types::AppState;
use fullmag_quantities::quantity_spec;

// ── Catalog ─────────────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/v1/live/current/fields/catalog",
    responses(
        (status = 200, description = "Field catalog", body = FieldCatalog),
        (status = 404, description = "No active workspace"),
    ),
    tag = "fields"
)]
pub async fn get_field_catalog(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FieldCatalog>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let gen_id = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|m| m.generation_id.as_deref())
        .and_then(|g| g.parse::<u64>().ok())
        .unwrap_or(0);

    let mut quantities = Vec::new();

    for (qid, _value) in snapshot.latest_fields.entries() {
        let spec = quantity_spec(qid);
        let n_comp = spec.map(|s| s.n_comp).unwrap_or(3);
        quantities.push(FieldDescriptor {
            quantity_id: qid.clone(),
            label: spec
                .map(|s| s.label.to_string())
                .unwrap_or_else(|| qid.clone()),
            kind: spec
                .map(|s| s.shape.as_api_kind().to_string())
                .unwrap_or_else(|| "vector_field".into()),
            components: n_comp,
            location: quantity_spatial_domain(qid).to_string(),
            unit: quantity_unit(qid).to_string(),
            field_revision: snapshot.state_version,
            domain_generation_id: gen_id,
            available: true,
        });
    }

    for (qid, field) in snapshot.preview_cache.iter() {
        if quantities.iter().any(|q| q.quantity_id == *qid) {
            continue;
        }
        let spec = quantity_spec(qid);
        let n_comp = spec.map(|s| s.n_comp).unwrap_or(3);
        quantities.push(FieldDescriptor {
            quantity_id: qid.clone(),
            label: spec
                .map(|s| s.label.to_string())
                .unwrap_or_else(|| qid.clone()),
            kind: spec
                .map(|s| s.shape.as_api_kind().to_string())
                .unwrap_or_else(|| "vector_field".into()),
            components: n_comp,
            location: quantity_spatial_domain(qid).to_string(),
            unit: field.unit.clone(),
            field_revision: snapshot.state_version,
            domain_generation_id: gen_id,
            available: true,
        });
    }

    Ok(Json(FieldCatalog {
        revision: snapshot.state_version,
        domain_generation_id: gen_id,
        quantities,
    }))
}

// ── Meta ────────────────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/v1/live/current/fields/{quantity_id}/meta",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
    ),
    responses(
        (status = 200, description = "Field metadata", body = FieldMeta),
        (status = 404, description = "Field not found"),
    ),
    tag = "fields"
)]
pub async fn get_field_meta(
    State(state): State<Arc<AppState>>,
    AxumPath(quantity_id): AxumPath<String>,
) -> Result<Json<FieldMeta>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(&quantity_id);
    let n_comp = spec.map(|s| s.n_comp).unwrap_or(3);
    let label = spec
        .map(|s| s.label.to_string())
        .unwrap_or_else(|| quantity_id.clone());
    let kind = spec
        .map(|s| s.shape.as_api_kind().to_string())
        .unwrap_or_else(|| "vector_field".into());
    let unit = quantity_unit(&quantity_id).to_string();
    let location = quantity_spatial_domain(&quantity_id).to_string();

    let gen_id = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|m| m.generation_id.as_deref())
        .and_then(|g| g.parse::<u64>().ok())
        .unwrap_or(0);

    // Try latest_fields
    if snapshot.latest_fields.get(&quantity_id).is_some() {
        return Ok(Json(FieldMeta {
            quantity_id,
            label,
            kind,
            components: n_comp,
            location,
            unit,
            field_revision: snapshot.state_version,
            domain_generation_id: gen_id,
            stats: None,
        }));
    }

    // Try preview_cache
    if snapshot.preview_cache.get(&quantity_id).is_some() {
        return Ok(Json(FieldMeta {
            quantity_id,
            label,
            kind,
            components: n_comp,
            location,
            unit,
            field_revision: snapshot.state_version,
            domain_generation_id: gen_id,
            stats: None,
        }));
    }

    Err(ApiError::not_found(format!(
        "field '{}' not available in memory",
        quantity_id
    )))
}

// ── Binary vector ───────────────────────────────────────────────────────

fn flatten_json_field_values(raw: &serde_json::Value) -> Vec<f64> {
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

fn json_field_grid(raw: &serde_json::Value) -> Option<[u32; 3]> {
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

#[utoipa::path(
    get,
    path = "/v1/live/current/fields/{quantity_id}/vector",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
    ),
    responses(
        (status = 200, description = "Binary FMVP v2 field vector", content_type = "application/octet-stream"),
        (status = 404, description = "Field not found"),
    ),
    tag = "fields"
)]
pub async fn get_field_vector(
    State(state): State<Arc<AppState>>,
    AxumPath(quantity_id): AxumPath<String>,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(&quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);

    // Try latest_fields
    if let Some(raw) = snapshot.latest_fields.get(&quantity_id) {
        let values = flatten_json_field_values(raw);
        let element_count = if n_comp > 0 { values.len() / n_comp } else { values.len() };
        let grid = json_field_grid(raw).unwrap_or([element_count as u32, 1, 1]);
        let binary = serialize_field_vector_binary_v2(&quantity_id, n_comp, grid, &values);
        return Ok(([(CONTENT_TYPE, "application/octet-stream")], binary).into_response());
    }

    // Try preview_cache
    if let Some(field) = snapshot.preview_cache.get(&quantity_id) {
        let binary = serialize_field_vector_binary_v2(
            &quantity_id,
            n_comp,
            field.preview_grid,
            &field.vector_field_values,
        );
        return Ok(([(CONTENT_TYPE, "application/octet-stream")], binary).into_response());
    }

    // Try live magnetization fallback
    if quantity_id == "m" {
        if let Some(ls) = snapshot.live_state.as_ref() {
            if let Some(mag) = ls.latest_step.magnetization.as_deref() {
                if !mag.is_empty() && mag.len() % 3 == 0 {
                    let grid = if ls.latest_step.grid.iter().any(|v| *v > 0) {
                        ls.latest_step.grid
                    } else {
                        [(mag.len() / 3) as u32, 1, 1]
                    };
                    let binary = serialize_field_vector_binary_v2("m", n_comp, grid, mag);
                    return Ok(
                        ([(CONTENT_TYPE, "application/octet-stream")], binary).into_response()
                    );
                }
            }
        }
    }

    Err(ApiError::not_found(format!(
        "field '{}' not available in memory",
        quantity_id
    )))
}
