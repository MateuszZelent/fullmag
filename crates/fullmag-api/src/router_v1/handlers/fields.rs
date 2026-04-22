//! Field endpoints — catalog, meta, binary vector (P1 component), and 2D slice (P2).

use std::sync::Arc;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, HeaderValue};
use axum::Json;

use crate::error::ApiError;
use crate::field_projection::{
    component_etag_token, parse_component, project_values, ComponentSelection,
};
use crate::field_slice::{
    fdm_slice, fem_slice_fallback, resolve_slice_query, slice_etag_token, FdmField, FieldSliceQuery,
};
use crate::field_store::serialize_field_vector_binary_v2;
use crate::preview::{quantity_spatial_domain, quantity_unit};
use crate::quantity_data_plane::slice_cache_key;
use crate::schemas::fields::*;
use crate::types::AppState;
use fullmag_quantities::quantity_spec;
use fullmag_runner::RuntimeEngineId;

// ── Response header constants ────────────────────────────────────────────────

static HDR_FIELD_REVISION: &str = "x-fullmag-field-revision";
static HDR_DOMAIN_GEN_ID: &str = "x-fullmag-domain-generation-id";
static HDR_QUANTITY_ID: &str = "x-fullmag-quantity-id";
static HDR_COMPONENT: &str = "x-fullmag-component";
static HDR_ENCODING: &str = "x-fullmag-encoding";
static HDR_POINT_COUNT: &str = "x-fullmag-point-count";
static HDR_VALUE_COUNT: &str = "x-fullmag-value-count";

fn insert_field_headers(
    resp: &mut axum::response::Response,
    quantity_id: &str,
    component: &ComponentSelection,
    field_revision: u64,
    domain_gen_id: u64,
    point_count: usize,
    value_count: usize,
) {
    let h = resp.headers_mut();
    let insert_str = |hm: &mut axum::http::HeaderMap, name, val: String| {
        if let Ok(v) = HeaderValue::from_str(&val) {
            hm.insert(name, v);
        }
    };
    insert_str(
        h,
        axum::http::HeaderName::from_static(HDR_FIELD_REVISION),
        field_revision.to_string(),
    );
    insert_str(
        h,
        axum::http::HeaderName::from_static(HDR_DOMAIN_GEN_ID),
        domain_gen_id.to_string(),
    );
    insert_str(
        h,
        axum::http::HeaderName::from_static(HDR_QUANTITY_ID),
        quantity_id.to_string(),
    );
    let comp_str = match component {
        ComponentSelection::Full => "full".to_string(),
        ComponentSelection::Magnitude => "magnitude".to_string(),
        ComponentSelection::Index(i) => format!("c{}", i),
    };
    insert_str(
        h,
        axum::http::HeaderName::from_static(HDR_COMPONENT),
        comp_str,
    );
    insert_str(
        h,
        axum::http::HeaderName::from_static(HDR_ENCODING),
        "FMVP;version=2".to_string(),
    );
    insert_str(
        h,
        axum::http::HeaderName::from_static(HDR_POINT_COUNT),
        point_count.to_string(),
    );
    insert_str(
        h,
        axum::http::HeaderName::from_static(HDR_VALUE_COUNT),
        value_count.to_string(),
    );
    let n_comp_out = if point_count > 0 {
        value_count / point_count
    } else {
        0
    };
    insert_str(
        h,
        axum::http::HeaderName::from_static("x-fullmag-n-comp"),
        n_comp_out.to_string(),
    );
}

// ── Catalog ──────────────────────────────────────────────────────────────────

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

// ── Meta ─────────────────────────────────────────────────────────────────────

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

// ── Internal helpers ──────────────────────────────────────────────────────────

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

// ── Binary vector — P1 ───────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/v1/live/current/fields/{quantity_id}/vector",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldVectorQuery,
    ),
    responses(
        (status = 200, description = "Binary FMVP v2 field vector", content_type = "application/octet-stream"),
        (status = 304, description = "Not modified — ETag matched"),
        (status = 400, description = "Invalid component parameter"),
        (status = 404, description = "Field not found"),
    ),
    tag = "fields"
)]
pub async fn get_field_vector(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldVectorQuery>,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(&quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);

    let component = parse_component(query.component.as_deref(), n_comp)?;

    let field_revision = snapshot.state_version;
    let gen_id_str = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|mesh| mesh.generation_id.as_deref())
        .unwrap_or("0");
    let gen_id: u64 = gen_id_str.parse().unwrap_or(0);

    let etag = super::stable_strong_etag(&component_etag_token(
        &quantity_id,
        field_revision,
        gen_id,
        &component,
    ));

    // Collect raw values under the lock, then drop the lock before any heavy work
    let raw_values_opt: Option<(Vec<f64>, [u32; 3])> =
        if let Some(raw) = snapshot.latest_fields.get(&quantity_id) {
            let values = flatten_json_field_values(raw);
            let element_count = if n_comp > 0 {
                values.len() / n_comp
            } else {
                values.len()
            };
            let grid = json_field_grid(raw).unwrap_or([element_count as u32, 1, 1]);
            Some((values, grid))
        } else if let Some(field) = snapshot.preview_cache.get(&quantity_id) {
            Some((field.vector_field_values.clone(), field.preview_grid))
        } else if quantity_id == "m" {
            snapshot.live_state.as_ref().and_then(|ls| {
                let mag = ls.latest_step.magnetization.as_deref()?;
                if mag.is_empty() || mag.len() % 3 != 0 {
                    return None;
                }
                let grid = if ls.latest_step.grid.iter().any(|v| *v > 0) {
                    ls.latest_step.grid
                } else {
                    [(mag.len() / 3) as u32, 1, 1]
                };
                Some((mag.to_vec(), grid))
            })
        } else {
            None
        };

    drop(guard);

    let (raw_values, grid) = raw_values_opt.ok_or_else(|| {
        ApiError::not_found(format!("field '{}' not available in memory", quantity_id))
    })?;

    // P4: check projection cache before doing heavy projection work
    let comp_key = match &component {
        ComponentSelection::Full => "full".to_string(),
        ComponentSelection::Magnitude => "magnitude".to_string(),
        ComponentSelection::Index(i) => format!("c{}", i),
    };
    let cache_key = crate::quantity_data_plane::projection_cache_key(
        &quantity_id,
        field_revision,
        gen_id,
        &comp_key,
    );
    {
        let mut proj_cache = state.quantity_data_plane.projection_cache.lock().await;
        if let Some(cached) = proj_cache.get(&cache_key) {
            let binary = cached.bytes.clone();
            drop(proj_cache);
            // Derive point/value counts from cached payload for headers.
            let point_count = if binary.len() > 48 {
                (binary.len() - 48) / 8
            } else {
                0
            };
            let out_n_comp_for_header: usize = if binary.len() > 6 {
                binary[6] as usize
            } else {
                1
            };
            let value_count = point_count;
            let out_n_comp_header = if out_n_comp_for_header > 0 {
                out_n_comp_for_header
            } else {
                1
            };
            let _ = out_n_comp_header; // used for header insertion
            let mut resp = super::conditional_binary_response(&headers, &etag, binary);
            insert_field_headers(
                &mut resp,
                &quantity_id,
                &component,
                field_revision,
                gen_id,
                point_count / out_n_comp_for_header.max(1),
                value_count,
            );
            return Ok(resp);
        }
    }

    // Heavy work outside the lock
    let (out_n_comp, projected) = project_values(&raw_values, n_comp, &component)?;
    let point_count = if out_n_comp > 0 {
        projected.len() / out_n_comp
    } else {
        projected.len()
    };
    let value_count = projected.len();

    // Adjust grid for scalar output
    let out_grid = if out_n_comp == 1 && n_comp > 1 {
        [grid[0], grid[1], grid[2]]
    } else {
        grid
    };

    let binary = serialize_field_vector_binary_v2(&quantity_id, out_n_comp, out_grid, &projected);

    // P4: populate projection cache
    {
        let mut proj_cache = state.quantity_data_plane.projection_cache.lock().await;
        proj_cache.insert(cache_key, binary.clone(), etag.clone());
    }

    let mut resp = super::conditional_binary_response(&headers, &etag, binary);

    // Add informational headers (present on both 200 and 304)
    insert_field_headers(
        &mut resp,
        &quantity_id,
        &component,
        field_revision,
        gen_id,
        point_count,
        value_count,
    );

    Ok(resp)
}

// ── 2D slice — P2 ────────────────────────────────────────────────────────────

/// Build an `FdmField` from the snapshot, returning `None` if no data is available.
fn extract_fdm_field(
    snapshot: &crate::types::SessionStateResponse,
    quantity_id: &str,
    n_comp: usize,
) -> Option<FdmField> {
    // Try latest_fields
    if let Some(raw) = snapshot.latest_fields.get(quantity_id) {
        let values = flatten_json_field_values(raw);
        let grid = json_field_grid(raw)?;
        return Some(FdmField {
            n_comp,
            grid,
            values,
            origin: None,
            spacing: None,
        });
    }
    // Try preview_cache
    if let Some(field) = snapshot.preview_cache.get(quantity_id) {
        return Some(FdmField {
            n_comp,
            grid: field.preview_grid,
            values: field.vector_field_values.clone(),
            origin: None,
            spacing: None,
        });
    }
    // Live magnetisation fallback for "m"
    if quantity_id == "m" {
        if let Some(ls) = snapshot.live_state.as_ref() {
            let mag = ls.latest_step.magnetization.as_deref()?;
            if mag.is_empty() || mag.len() % 3 != 0 {
                return None;
            }
            let grid = if ls.latest_step.grid.iter().any(|v| *v > 0) {
                ls.latest_step.grid
            } else {
                [(mag.len() / 3) as u32, 1, 1]
            };
            return Some(FdmField {
                n_comp: 3,
                grid,
                values: mag.to_vec(),
                origin: None,
                spacing: None,
            });
        }
    }
    None
}

fn is_fem_runtime(snapshot: &crate::types::SessionStateResponse) -> bool {
    matches!(
        snapshot.capabilities.as_ref().map(|cap| cap.engine_id),
        Some(
            RuntimeEngineId::FemCpuNative
                | RuntimeEngineId::FemNativeGpu
                | RuntimeEngineId::FemEigenCpuBaseline
                | RuntimeEngineId::FemEigenNativeGpu
        )
    ) || snapshot.fem_mesh.is_some()
}

fn fem_topology_available(snapshot: &crate::types::SessionStateResponse) -> bool {
    snapshot.fem_mesh.as_ref().is_some_and(|mesh| {
        !mesh.nodes.is_empty() && (!mesh.elements.is_empty() || !mesh.boundary_faces.is_empty())
    })
}

fn component_label(c: &ComponentSelection) -> String {
    match c {
        ComponentSelection::Full => "full".into(),
        ComponentSelection::Magnitude => "magnitude".into(),
        ComponentSelection::Index(i) => format!("c{}", i),
    }
}

#[utoipa::path(
    get,
    path = "/v1/live/current/fields/{quantity_id}/slice/meta",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldSliceQuery,
    ),
    responses(
        (status = 200, description = "Slice metadata with resolved parameters and binary URLs", body = FieldSliceMeta),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
        (status = 409, description = "Slice requires mesh topology (FEM only)"),
    ),
    tag = "fields"
)]
pub async fn get_field_slice_meta(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldSliceQuery>,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(&quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);

    let resolved = resolve_slice_query(&query, n_comp)?;
    let is_fem = is_fem_runtime(snapshot);
    if is_fem && !fem_topology_available(snapshot) {
        return Err(ApiError::conflict(
            "quantity slice requires mesh topology for FEM runtime",
        ));
    }

    let field_revision = snapshot.state_version;
    let gen_id_str = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|mesh| mesh.generation_id.as_deref())
        .unwrap_or("0");
    let gen_id: u64 = gen_id_str.parse().unwrap_or(0);

    let fdm_field = extract_fdm_field(snapshot, &quantity_id, n_comp)
        .ok_or_else(|| ApiError::not_found(format!("field '{}' not available", quantity_id)))?;

    drop(guard);

    // Perform slice outside lock
    let slice_result = if is_fem {
        fem_slice_fallback(&fdm_field, &resolved)?
    } else {
        fdm_slice(&fdm_field, &resolved)?
    };

    let scalar_etag_token = slice_etag_token(&quantity_id, field_revision, gen_id, &resolved);
    let scalar_etag = super::stable_strong_etag(&scalar_etag_token);

    let meta_etag_token = format!("meta:{}", scalar_etag_token);
    let meta_etag = super::stable_strong_etag(&meta_etag_token);

    let mut arrows_query = resolved.clone();
    arrows_query.component = ComponentSelection::Full;
    arrows_query.include_arrows = true;
    let arrows_etag_token = format!(
        "arrows:{}",
        slice_etag_token(&quantity_id, field_revision, gen_id, &arrows_query)
    );
    let arrows_etag = super::stable_strong_etag(&arrows_etag_token);

    let comp_label = component_label(&resolved.component);
    let plane_str = resolved.plane.as_str().to_string();
    let cut_kind = if query.cut_world.is_some() {
        "world"
    } else {
        "normalized"
    };

    // Build canonical href parameters for binary endpoints
    let comp_param = urlencoding(&comp_label);
    let plane_param = urlencoding(&plane_str);
    let cut_param = format!("cut_norm={:.6}", resolved.cut_norm);
    let size_param = format!("x_size={}&y_size={}", resolved.x_size, resolved.y_size);

    let scalar_href = format!(
        "/v1/live/current/fields/{}/slice/scalar?plane={}&component={}&{}&{}",
        urlencoding(&quantity_id),
        plane_param,
        comp_param,
        cut_param,
        size_param
    );
    let arrows_href = if resolved.include_arrows {
        Some(format!(
            "/v1/live/current/fields/{}/slice/arrows?plane={}&component=full&{}&{}&arrow_every={}&max_arrows={}",
            urlencoding(&quantity_id),
            plane_param,
            cut_param,
            size_param,
            resolved.arrow_every,
            resolved.max_arrows
        ))
    } else {
        None
    };

    let meta = FieldSliceMeta {
        quantity_id: quantity_id.clone(),
        component: comp_label,
        plane: plane_str,
        cut_kind: cut_kind.to_string(),
        cut_norm: resolved.cut_norm,
        cut_world: slice_result.cut_world,
        field_revision,
        domain_generation_id: gen_id,
        sampling_method: slice_result.sampling_method.to_string(),
        etag: meta_etag.clone(),
        slice_revision: meta_etag_token.clone(),
        x_pixels: slice_result.x_size,
        y_pixels: slice_result.y_size,
        grid: FieldSliceGrid {
            x_size: slice_result.x_size,
            y_size: slice_result.y_size,
            point_count: slice_result.x_size * slice_result.y_size,
        },
        bounds: Some(FieldSliceBounds {
            u_min: slice_result.u_min,
            u_max: slice_result.u_max,
            v_min: slice_result.v_min,
            v_max: slice_result.v_max,
        }),
        scalar: FieldSliceBinaryDescriptor {
            available: true,
            n_comp: slice_result.n_comp_out as u8,
            point_count: slice_result.x_size * slice_result.y_size,
            min: Some(slice_result.min),
            max: Some(slice_result.max),
            etag: Some(scalar_etag.clone()),
            href: Some(scalar_href),
        },
        arrows: FieldSliceBinaryDescriptor {
            available: resolved.include_arrows && slice_result.arrow_count > 0,
            n_comp: 2,
            point_count: slice_result.arrow_count as u32,
            min: None,
            max: None,
            etag: if resolved.include_arrows {
                Some(arrows_etag)
            } else {
                None
            },
            href: arrows_href,
        },
    };

    Ok(super::conditional_json_response(
        &headers, &meta_etag, &meta,
    ))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/fields/{quantity_id}/slice/scalar",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldSliceQuery,
    ),
    responses(
        (status = 200, description = "Binary FMVP v2 2D scalar slice", content_type = "application/octet-stream"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
        (status = 409, description = "Slice requires mesh topology"),
    ),
    tag = "fields"
)]
pub async fn get_field_slice_scalar(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldSliceQuery>,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(&quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);

    let mut resolved = resolve_slice_query(&query, n_comp)?;
    resolved.include_arrows = false;
    let is_fem = is_fem_runtime(snapshot);
    if is_fem && !fem_topology_available(snapshot) {
        return Err(ApiError::conflict(
            "quantity slice requires mesh topology for FEM runtime",
        ));
    }
    let field_revision = snapshot.state_version;
    let gen_id: u64 = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|m| m.generation_id.as_deref())
        .and_then(|g| g.parse().ok())
        .unwrap_or(0);

    let fdm_field = extract_fdm_field(snapshot, &quantity_id, n_comp)
        .ok_or_else(|| ApiError::not_found(format!("field '{}' not available", quantity_id)))?;

    let component = component_label(&resolved.component);
    let cache_key = slice_cache_key(
        &quantity_id,
        field_revision,
        gen_id,
        resolved.plane.as_str(),
        resolved.cut_norm,
        resolved.x_size,
        resolved.y_size,
        &component,
        resolved.include_arrows,
        resolved.arrow_every,
        resolved.max_arrows,
    );
    let etag_token = slice_etag_token(&quantity_id, field_revision, gen_id, &resolved);
    let etag = super::stable_strong_etag(&etag_token);

    drop(guard);

    {
        let mut cache = state.quantity_data_plane.scalar_slice_cache.lock().await;
        if let Some(cached) = cache.get(&cache_key) {
            let mut resp =
                super::conditional_binary_response(&headers, &cached.etag, cached.bytes.clone());
            if let Ok(v) = HeaderValue::from_str(&field_revision.to_string()) {
                resp.headers_mut()
                    .insert(axum::http::HeaderName::from_static(HDR_FIELD_REVISION), v);
            }
            return Ok(resp);
        }
    }

    let slice_result = if is_fem {
        fem_slice_fallback(&fdm_field, &resolved)?
    } else {
        fdm_slice(&fdm_field, &resolved)?
    };

    let grid = [resolved.x_size, resolved.y_size, 1];
    let binary = serialize_field_vector_binary_v2(
        &quantity_id,
        slice_result.n_comp_out,
        grid,
        &slice_result.scalar_values,
    );

    {
        let mut cache = state.quantity_data_plane.scalar_slice_cache.lock().await;
        cache.insert(cache_key, binary.clone(), etag.clone());
    }

    let mut resp = super::conditional_binary_response(&headers, &etag, binary);
    if let Ok(v) = HeaderValue::from_str(&field_revision.to_string()) {
        resp.headers_mut()
            .insert(axum::http::HeaderName::from_static(HDR_FIELD_REVISION), v);
    }
    Ok(resp)
}

#[utoipa::path(
    get,
    path = "/v1/live/current/fields/{quantity_id}/slice/arrows",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldSliceQuery,
    ),
    responses(
        (status = 200, description = "Binary FMVP v2 2D arrow (u,v) pairs", content_type = "application/octet-stream"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
        (status = 409, description = "Slice requires mesh topology"),
    ),
    tag = "fields"
)]
pub async fn get_field_slice_arrows(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(mut query): Query<FieldSliceQuery>,
) -> Result<axum::response::Response, ApiError> {
    // Arrows always use the full vector
    query.component = Some("full".to_string());
    query.include_arrows = Some(true);

    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(&quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);

    let mut resolved = resolve_slice_query(&query, n_comp)?;
    resolved.component = ComponentSelection::Full;
    resolved.include_arrows = true;
    let is_fem = is_fem_runtime(snapshot);
    if is_fem && !fem_topology_available(snapshot) {
        return Err(ApiError::conflict(
            "quantity slice requires mesh topology for FEM runtime",
        ));
    }
    let field_revision = snapshot.state_version;
    let gen_id: u64 = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|m| m.generation_id.as_deref())
        .and_then(|g| g.parse().ok())
        .unwrap_or(0);

    let fdm_field = extract_fdm_field(snapshot, &quantity_id, n_comp)
        .ok_or_else(|| ApiError::not_found(format!("field '{}' not available", quantity_id)))?;

    let cache_key = slice_cache_key(
        &quantity_id,
        field_revision,
        gen_id,
        resolved.plane.as_str(),
        resolved.cut_norm,
        resolved.x_size,
        resolved.y_size,
        "full",
        true,
        resolved.arrow_every,
        resolved.max_arrows,
    );
    let etag_token = format!(
        "arrows:{}",
        slice_etag_token(&quantity_id, field_revision, gen_id, &resolved)
    );
    let etag = super::stable_strong_etag(&etag_token);

    drop(guard);

    {
        let mut cache = state.quantity_data_plane.arrow_slice_cache.lock().await;
        if let Some(cached) = cache.get(&cache_key) {
            return Ok(super::conditional_binary_response(
                &headers,
                &cached.etag,
                cached.bytes.clone(),
            ));
        }
    }

    let slice_result = if is_fem {
        fem_slice_fallback(&fdm_field, &resolved)?
    } else {
        fdm_slice(&fdm_field, &resolved)?
    };

    let arrow_count = slice_result.arrow_count as u32;
    let binary = serialize_field_vector_binary_v2(
        &quantity_id,
        2,
        [arrow_count, 1, 1],
        &slice_result.arrow_values,
    );

    {
        let mut cache = state.quantity_data_plane.arrow_slice_cache.lock().await;
        cache.insert(cache_key, binary.clone(), etag.clone());
    }

    Ok(super::conditional_binary_response(&headers, &etag, binary))
}

// ── URL encoding helper ───────────────────────────────────────────────────────

fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{:02X}", byte));
            }
        }
    }
    out
}
