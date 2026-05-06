//! Field endpoints — catalog, meta, binary vector (P1 component), and 2D slice (P2).

use std::borrow::Cow;
use std::sync::Arc;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, HeaderValue};
use axum::Json;

use crate::error::ApiError;
use crate::field_projection::{
    component_etag_token, parse_component, project_values, ComponentSelection,
};
use crate::field_slice::{
    fdm_projection, fdm_slice, fem_projection_exact, fem_projection_profile, fem_slice_fallback,
    resolve_projection_profile_query, resolve_projection_query, resolve_slice_query,
    slice_etag_token, FdmField, FemField, FieldProjectionProfileQuery, FieldProjectionQuery,
    FieldSliceQuery, ProjectionResult, ResolvedProjectionQuery,
};
use crate::field_store::serialize_field_vector_binary_v2;
use crate::preview::{quantity_spatial_domain, quantity_unit};
use crate::quantity_data_plane::{
    projection_empty_mask_cache_key, scalar_projection_cache_key, slice_cache_key,
};
use crate::schemas::fields::*;
use crate::types::AppState;
use crate::types::SessionStateResponse;
use fullmag_quantities::quantity_spec;
use fullmag_runner::{FemMeshPayload, RuntimeEngineId};

// ── Response header constants ────────────────────────────────────────────────

static HDR_FIELD_REVISION: &str = "x-fullmag-field-revision";
static HDR_DOMAIN_GEN_ID: &str = "x-fullmag-domain-generation-id";
static HDR_QUANTITY_ID: &str = "x-fullmag-quantity-id";
static HDR_COMPONENT: &str = "x-fullmag-component";
static HDR_ENCODING: &str = "x-fullmag-encoding";
static HDR_POINT_COUNT: &str = "x-fullmag-point-count";
static HDR_VALUE_COUNT: &str = "x-fullmag-value-count";
static HDR_SCOPE_KIND: &str = "x-fullmag-scope-kind";
static HDR_SCOPE_ID: &str = "x-fullmag-scope-id";

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
        ComponentSelection::MagnitudeSquared => "magnitude_squared".to_string(),
        ComponentSelection::AbsIndex(i) => format!("abs_c{}", i),
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

fn insert_scope_headers(resp: &mut axum::response::Response, scope: Option<&ResolvedFieldScope>) {
    let Some(scope) = scope else {
        return;
    };
    let h = resp.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&scope.kind) {
        h.insert(axum::http::HeaderName::from_static(HDR_SCOPE_KIND), value);
    }
    if let Some(id) = scope.id.as_deref() {
        if let Ok(value) = HeaderValue::from_str(id) {
            h.insert(axum::http::HeaderName::from_static(HDR_SCOPE_ID), value);
        }
    }
}

// ── Catalog ──────────────────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields",
    responses(
        (status = 200, description = "Field catalog", body = FieldCatalog),
        (status = 404, description = "No active workspace"),
    ),
    tag = "data"
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
        push_field_descriptor(
            &mut quantities,
            qid,
            quantity_unit(qid),
            snapshot.state_version,
            gen_id,
        );
    }

    for (qid, field) in snapshot.preview_cache.iter() {
        if quantities.iter().any(|q| q.quantity_id == *qid) {
            continue;
        }
        push_field_descriptor(
            &mut quantities,
            qid,
            &field.unit,
            snapshot.state_version,
            gen_id,
        );
    }

    if live_magnetization_available(snapshot) && !quantities.iter().any(|q| q.quantity_id == "m") {
        push_field_descriptor(
            &mut quantities,
            "m",
            quantity_unit("m"),
            snapshot.state_version,
            gen_id,
        );
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
    path = "/v2/sessions/current/data/fields/{quantity_id}/meta",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
    ),
    responses(
        (status = 200, description = "Field metadata", body = FieldMeta),
        (status = 404, description = "Field not found"),
    ),
    tag = "data"
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

    if snapshot.preview_cache.get(&quantity_id).is_some()
        || (quantity_id == "m" && live_magnetization_available(snapshot))
    {
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

fn live_magnetization_available(snapshot: &SessionStateResponse) -> bool {
    snapshot
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.magnetization.as_deref())
        .is_some_and(|values| !values.is_empty() && values.len() % 3 == 0)
}

fn push_field_descriptor(
    quantities: &mut Vec<FieldDescriptor>,
    quantity_id: &str,
    unit: &str,
    field_revision: u64,
    domain_generation_id: u64,
) {
    let spec = quantity_spec(quantity_id);
    let n_comp = spec.map(|s| s.n_comp).unwrap_or(3);
    quantities.push(FieldDescriptor {
        quantity_id: quantity_id.to_string(),
        label: spec
            .map(|s| s.label.to_string())
            .unwrap_or_else(|| quantity_id.to_string()),
        kind: spec
            .map(|s| s.shape.as_api_kind().to_string())
            .unwrap_or_else(|| "vector_field".into()),
        components: n_comp,
        location: quantity_spatial_domain(quantity_id).to_string(),
        unit: unit.to_string(),
        field_revision,
        domain_generation_id,
        available: true,
    });
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

#[derive(Debug, Clone)]
struct ResolvedFieldScope {
    kind: String,
    id: Option<String>,
    node_indices: Vec<usize>,
}

impl ResolvedFieldScope {
    fn cache_token(&self) -> String {
        match self.id.as_deref() {
            Some(id) => format!("{}:{id}", self.kind),
            None => self.kind.clone(),
        }
    }
}

fn resolve_field_scope(
    query: &FieldVectorQuery,
    snapshot: &SessionStateResponse,
    workspace_selection: Option<&crate::schemas::workspace::WorkspaceSelectionResource>,
    raw_point_count: usize,
) -> Result<Option<ResolvedFieldScope>, ApiError> {
    let Some(scope_kind) = query
        .scope_kind
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    else {
        return Ok(None);
    };
    if scope_kind == "full" {
        return Ok(None);
    }
    let mesh = snapshot.fem_mesh.as_ref().ok_or_else(|| {
        ApiError::bad_request(format!(
            "field scope '{scope_kind}' requires FEM mesh topology"
        ))
    })?;
    let scope = match scope_kind {
        "object" => {
            let object_id = required_scope_id(query, "object")?;
            resolve_object_scope(mesh, object_id)?
        }
        "part" => {
            let part_id = required_scope_id(query, "part")?;
            resolve_part_scope(mesh, part_id, "part")?
        }
        "airbox" => {
            let part_id = match query.scope_id.as_deref().filter(|value| !value.is_empty()) {
                Some(part_id) => Cow::Borrowed(part_id),
                None => Cow::Owned(
                    mesh.mesh_parts
                        .iter()
                        .find(|part| part.role == "air")
                        .map(|part| part.id.clone())
                        .ok_or_else(|| ApiError::not_found("airbox mesh part not found"))?,
                ),
            };
            resolve_part_scope(mesh, part_id.as_ref(), "airbox")?
        }
        "selection" => {
            let selection = workspace_selection.ok_or_else(|| {
                ApiError::bad_request("field scope 'selection' requires workspace selection state")
            })?;
            resolve_selection_scope(mesh, selection)?
        }
        _ => {
            return Err(ApiError::bad_request(format!(
                "unsupported field scope_kind '{scope_kind}'"
            )))
        }
    };
    let node_indices = scope
        .node_indices
        .into_iter()
        .filter(|index| *index < raw_point_count)
        .collect::<Vec<_>>();
    Ok(Some(ResolvedFieldScope {
        node_indices,
        ..scope
    }))
}

fn required_scope_id<'a>(
    query: &'a FieldVectorQuery,
    scope_kind: &str,
) -> Result<&'a str, ApiError> {
    query
        .scope_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ApiError::bad_request(format!("scope_id is required for {scope_kind} scope"))
        })
}

fn resolve_object_scope(
    mesh: &FemMeshPayload,
    object_id: &str,
) -> Result<ResolvedFieldScope, ApiError> {
    if let Some(part) = mesh.mesh_parts.iter().find(|part| {
        part.role == "magnetic_object"
            && (part.object_id.as_deref() == Some(object_id)
                || part.geometry_id.as_deref() == Some(object_id)
                || part.id == object_id)
    }) {
        return Ok(ResolvedFieldScope {
            kind: "object".to_string(),
            id: Some(object_id.to_string()),
            node_indices: node_indices_for_part(part),
        });
    }

    let segment = mesh
        .object_segments
        .iter()
        .find(|segment| segment.object_id == object_id)
        .ok_or_else(|| ApiError::not_found(format!("object mesh not found: {object_id}")))?;
    let start = segment.node_start as usize;
    let end = start.saturating_add(segment.node_count as usize);
    Ok(ResolvedFieldScope {
        kind: "object".to_string(),
        id: Some(object_id.to_string()),
        node_indices: (start..end).collect(),
    })
}

fn node_indices_for_part(part: &fullmag_runner::FemMeshPartPayload) -> Vec<usize> {
    if part.node_indices.is_empty() {
        let start = part.node_start as usize;
        let end = start.saturating_add(part.node_count as usize);
        (start..end).collect()
    } else {
        part.node_indices
            .iter()
            .map(|index| *index as usize)
            .collect()
    }
}

fn resolve_part_scope(
    mesh: &FemMeshPayload,
    part_id: &str,
    public_kind: &str,
) -> Result<ResolvedFieldScope, ApiError> {
    let part = mesh
        .mesh_parts
        .iter()
        .find(|part| part.id == part_id)
        .ok_or_else(|| ApiError::not_found(format!("mesh part not found: {part_id}")))?;
    Ok(ResolvedFieldScope {
        kind: public_kind.to_string(),
        id: Some(part.id.clone()),
        node_indices: node_indices_for_part(part),
    })
}

fn resolve_selection_scope(
    mesh: &FemMeshPayload,
    selection: &crate::schemas::workspace::WorkspaceSelectionResource,
) -> Result<ResolvedFieldScope, ApiError> {
    if let Some(object_id) = selection.selected_object_id.as_deref() {
        return resolve_object_scope(mesh, object_id);
    }
    if let Some(entity_id) = selection.selected_entity_id.as_deref() {
        if mesh.mesh_parts.iter().any(|part| part.id == entity_id) {
            return resolve_part_scope(mesh, entity_id, "selection");
        }
        if mesh
            .object_segments
            .iter()
            .any(|segment| segment.object_id == entity_id)
        {
            let mut scope = resolve_object_scope(mesh, entity_id)?;
            scope.kind = "selection".to_string();
            return Ok(scope);
        }
    }
    if let Some(node_id) = selection.selected_node_id.as_deref() {
        if node_id == "universe-airbox" || node_id == "universe-airbox-mesh" {
            let air_part_id = mesh
                .mesh_parts
                .iter()
                .find(|part| part.role == "air")
                .map(|part| part.id.clone())
                .ok_or_else(|| ApiError::not_found("airbox mesh part not found"))?;
            return resolve_part_scope(mesh, &air_part_id, "selection");
        }
        if mesh.mesh_parts.iter().any(|part| part.id == node_id) {
            return resolve_part_scope(mesh, node_id, "selection");
        }
        if mesh
            .object_segments
            .iter()
            .any(|segment| segment.object_id == node_id)
        {
            let mut scope = resolve_object_scope(mesh, node_id)?;
            scope.kind = "selection".to_string();
            return Ok(scope);
        }
    }
    Err(ApiError::bad_request(
        "current workspace selection does not resolve to a mesh scope",
    ))
}

fn apply_field_scope(
    raw_values: Vec<f64>,
    grid: [u32; 3],
    n_comp: usize,
    scope: Option<&ResolvedFieldScope>,
) -> Vec<f64> {
    let Some(scope) = scope else {
        return raw_values;
    };
    if n_comp == 0 {
        return raw_values;
    }
    let mut scoped = Vec::with_capacity(scope.node_indices.len() * n_comp);
    for point_index in &scope.node_indices {
        let start = point_index.saturating_mul(n_comp);
        let end = start.saturating_add(n_comp);
        if end <= raw_values.len() {
            scoped.extend_from_slice(&raw_values[start..end]);
        }
    }
    let _ = grid;
    scoped
}

fn live_magnetization_values(
    snapshot: &crate::types::SessionStateResponse,
) -> Option<(Vec<f64>, [u32; 3])> {
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
}

// ── Binary vector — P1 ───────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/samples/vector",
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
    tag = "data"
)]
pub async fn get_field_vector(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldVectorQuery>,
) -> Result<axum::response::Response, ApiError> {
    let workspace_selection = if query.scope_kind.as_deref() == Some("selection") {
        Some(state.current_workspace_selection.read().await.clone())
    } else {
        None
    };
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

    // Collect raw values under the lock, then drop the lock before any heavy work
    let raw_values_opt: Option<(Vec<f64>, [u32; 3])> = (if quantity_id == "m" {
        live_magnetization_values(snapshot)
    } else {
        None
    })
    .or_else(|| {
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
        } else {
            None
        }
    });

    let (raw_values, grid) = raw_values_opt.ok_or_else(|| {
        ApiError::not_found(format!("field '{}' not available in memory", quantity_id))
    })?;
    let raw_point_count = if n_comp > 0 {
        raw_values.len() / n_comp
    } else {
        raw_values.len()
    };
    let resolved_scope = resolve_field_scope(
        &query,
        snapshot,
        workspace_selection.as_ref(),
        raw_point_count,
    )?;

    drop(guard);

    let scope_token = resolved_scope
        .as_ref()
        .map(ResolvedFieldScope::cache_token)
        .unwrap_or_else(|| "full-domain".to_string());
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "{}:{scope_token}",
        component_etag_token(&quantity_id, field_revision, gen_id, &component)
    ));
    let scoped_grid = resolved_scope
        .as_ref()
        .map(|scope| [scope.node_indices.len() as u32, 1, 1])
        .unwrap_or(grid);
    let raw_values = apply_field_scope(raw_values, grid, n_comp, resolved_scope.as_ref());

    // P4: check projection cache before doing heavy projection work
    let comp_key = match &component {
        ComponentSelection::Full => "full".to_string(),
        ComponentSelection::Magnitude => "magnitude".to_string(),
        ComponentSelection::MagnitudeSquared => "magnitude_squared".to_string(),
        ComponentSelection::AbsIndex(i) => format!("abs_c{}", i),
        ComponentSelection::Index(i) => format!("c{}", i),
    };
    let cache_key = crate::quantity_data_plane::projection_cache_key(
        &quantity_id,
        field_revision,
        gen_id,
        &format!("{comp_key}:{scope_token}"),
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
            let mut resp = crate::router_v2::handlers::shared::conditional_binary_response(
                &headers, &etag, binary,
            );
            insert_field_headers(
                &mut resp,
                &quantity_id,
                &component,
                field_revision,
                gen_id,
                point_count / out_n_comp_for_header.max(1),
                value_count,
            );
            insert_scope_headers(&mut resp, resolved_scope.as_ref());
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
        [scoped_grid[0], scoped_grid[1], scoped_grid[2]]
    } else {
        scoped_grid
    };

    let binary = serialize_field_vector_binary_v2(&quantity_id, out_n_comp, out_grid, &projected);

    // P4: populate projection cache
    {
        let mut proj_cache = state.quantity_data_plane.projection_cache.lock().await;
        proj_cache.insert(cache_key, binary.clone(), etag.clone());
    }

    let mut resp =
        crate::router_v2::handlers::shared::conditional_binary_response(&headers, &etag, binary);

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
    insert_scope_headers(&mut resp, resolved_scope.as_ref());

    Ok(resp)
}

// ── 2D slice — P2 ────────────────────────────────────────────────────────────

/// Build an `FdmField` from the snapshot, returning `None` if no data is available.
fn extract_fdm_field(
    snapshot: &crate::types::SessionStateResponse,
    quantity_id: &str,
    n_comp: usize,
) -> Option<FdmField> {
    if quantity_id == "m" {
        if let Some((values, grid)) = live_magnetization_values(snapshot) {
            return Some(FdmField {
                n_comp: 3,
                grid,
                values,
                origin: None,
                spacing: None,
            });
        }
    }
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
    None
}

fn extract_raw_field_values(
    snapshot: &crate::types::SessionStateResponse,
    quantity_id: &str,
    n_comp: usize,
) -> Option<Vec<f64>> {
    if quantity_id == "m" {
        if let Some((values, _grid)) = live_magnetization_values(snapshot) {
            return Some(values);
        }
    }
    if let Some(raw) = snapshot.latest_fields.get(quantity_id) {
        return Some(flatten_json_field_values(raw));
    }
    snapshot
        .preview_cache
        .get(quantity_id)
        .map(|field| field.vector_field_values.clone())
        .filter(|values| n_comp == 0 || values.len() % n_comp == 0)
}

fn extract_fem_field(
    snapshot: &crate::types::SessionStateResponse,
    quantity_id: &str,
    n_comp: usize,
) -> Option<FemField> {
    let mesh = snapshot.fem_mesh.as_ref()?;
    if mesh.nodes.is_empty() || mesh.elements.is_empty() {
        return None;
    }
    let values = extract_raw_field_values(snapshot, quantity_id, n_comp)?;
    if n_comp == 0 || values.len() / n_comp != mesh.nodes.len() {
        return None;
    }
    Some(FemField {
        n_comp,
        nodes: mesh.nodes.clone(),
        elements: mesh.elements.clone(),
        element_markers: mesh.element_markers.clone(),
        values,
    })
}

fn compute_projection(
    fdm_field: &FdmField,
    fem_field: Option<&FemField>,
    resolved: &ResolvedProjectionQuery,
) -> Result<ProjectionResult, ApiError> {
    match fem_field {
        Some(field) => fem_projection_exact(field, resolved),
        None => fdm_projection(fdm_field, resolved),
    }
}

fn projection_error_estimate(
    fdm_field: &FdmField,
    fem_field: Option<&FemField>,
    resolved: &ResolvedProjectionQuery,
    projection: &ProjectionResult,
) -> Result<(Option<f64>, Option<String>), ApiError> {
    if fem_field.is_some() {
        return Ok((Some(0.0), Some("exact_tetra_volume".to_string())));
    }
    if resolved.samples <= 1 {
        return Ok((None, None));
    }
    let mut coarse_query = resolved.clone();
    coarse_query.adaptive = false;
    coarse_query.samples = (resolved.samples / 2).max(1);
    let coarse = fdm_projection(fdm_field, &coarse_query)?;
    let mut max_abs_diff = 0.0f64;
    for (fine, coarse) in projection
        .scalar_values
        .iter()
        .zip(coarse.scalar_values.iter())
    {
        if fine.is_finite() && coarse.is_finite() {
            max_abs_diff = max_abs_diff.max((fine - coarse).abs());
        }
    }
    Ok((
        Some(max_abs_diff),
        Some("coarse_fine_sample_delta_max_abs".to_string()),
    ))
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
        ComponentSelection::MagnitudeSquared => "magnitude_squared".into(),
        ComponentSelection::AbsIndex(i) => format!("abs_c{}", i),
        ComponentSelection::Index(i) => format!("c{}", i),
    }
}

fn projection_etag_token(
    quantity_id: &str,
    field_revision: u64,
    domain_generation_id: u64,
    q: &crate::field_slice::ResolvedProjectionQuery,
    sampling_method: &str,
) -> String {
    format!(
        "fmpr:{quantity_id}:{field_revision}:{domain_generation_id}:method={sampling_method}:{}:{}x{}:{}:{}:air={}:samples={}:adaptive={}:tol={}:min_samples={}:tile={},{},{}:v3",
        q.plane.as_str(),
        q.full_x_size,
        q.full_y_size,
        component_label(&q.component),
        q.reduction.as_str(),
        u8::from(q.include_air_as_zero),
        q.samples,
        u8::from(q.adaptive),
        q.error_tolerance
            .map(|value| value.to_bits().to_string())
            .unwrap_or_else(|| "none".to_string()),
        q.min_samples,
        q.tile_x.map_or_else(|| "full".to_string(), |value| value.to_string()),
        q.tile_y.map_or_else(|| "full".to_string(), |value| value.to_string()),
        q.tile_size.map_or_else(|| "full".to_string(), |value| value.to_string()),
    )
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/projection/meta",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldProjectionQuery,
    ),
    responses(
        (status = 200, description = "Projection metadata with binary scalar URL", body = FieldProjectionMeta),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
    ),
    tag = "data"
)]
pub async fn get_field_projection_meta(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldProjectionQuery>,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(&quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);
    let resolved = resolve_projection_query(&query, n_comp)?;
    let field_revision = snapshot.state_version;
    let gen_id: u64 = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|m| m.generation_id.as_deref())
        .and_then(|g| g.parse().ok())
        .unwrap_or(0);
    let fdm_field = extract_fdm_field(snapshot, &quantity_id, n_comp)
        .ok_or_else(|| ApiError::not_found(format!("field '{}' not available", quantity_id)))?;
    let fem_field = extract_fem_field(snapshot, &quantity_id, n_comp);
    drop(guard);

    let projection = compute_projection(&fdm_field, fem_field.as_ref(), &resolved)?;
    let (error_estimate, error_method) =
        projection_error_estimate(&fdm_field, fem_field.as_ref(), &resolved, &projection)?;
    let etag_token = projection_etag_token(
        &quantity_id,
        field_revision,
        gen_id,
        &resolved,
        projection.sampling_method,
    );
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&etag_token);
    let mask_etag_token = format!("empty-mask:{etag_token}");
    let mask_etag = crate::router_v2::handlers::shared::stable_strong_etag(&mask_etag_token);
    let comp_label = component_label(&resolved.component);
    let tile_query = match (resolved.tile_x, resolved.tile_y, resolved.tile_size) {
        (Some(tile_x), Some(tile_y), Some(tile_size)) => {
            format!("&tile_x={tile_x}&tile_y={tile_y}&tile_size={tile_size}")
        }
        _ => String::new(),
    };
    let adaptive_query = if resolved.adaptive {
        format!(
            "&adaptive=true&min_samples={}{}",
            resolved.min_samples,
            resolved
                .error_tolerance
                .map(|value| format!("&error_tolerance={value}"))
                .unwrap_or_default()
        )
    } else {
        String::new()
    };
    let scalar_href = format!(
        "/v2/sessions/current/data/fields/{}/projection/scalar?plane={}&component={}&reduction={}&include_air_as_zero={}&samples={}&x_size={}&y_size={}{}{}",
        urlencoding(&quantity_id),
        urlencoding(resolved.plane.as_str()),
        urlencoding(&comp_label),
        urlencoding(resolved.reduction.as_str()),
        resolved.include_air_as_zero,
        resolved.samples,
        resolved.full_x_size,
        resolved.full_y_size,
        adaptive_query,
        tile_query,
    );
    let empty_mask_href = format!(
        "/v2/sessions/current/data/fields/{}/projection/empty-mask?plane={}&component={}&reduction={}&include_air_as_zero={}&samples={}&x_size={}&y_size={}{}{}",
        urlencoding(&quantity_id),
        urlencoding(resolved.plane.as_str()),
        urlencoding(&comp_label),
        urlencoding(resolved.reduction.as_str()),
        resolved.include_air_as_zero,
        resolved.samples,
        resolved.full_x_size,
        resolved.full_y_size,
        adaptive_query,
        tile_query,
    );
    let meta = FieldProjectionMeta {
        quantity_id: quantity_id.clone(),
        component: comp_label,
        plane: resolved.plane.as_str().to_string(),
        reduction: resolved.reduction.as_str().to_string(),
        include_air_as_zero: resolved.include_air_as_zero,
        samples: projection.samples,
        field_revision,
        domain_generation_id: gen_id,
        sampling_method: projection.sampling_method.to_string(),
        etag: etag.clone(),
        projection_revision: etag_token,
        x_pixels: projection.x_size,
        y_pixels: projection.y_size,
        grid: FieldSliceGrid {
            x_size: projection.x_size,
            y_size: projection.y_size,
            point_count: projection.x_size * projection.y_size,
        },
        bounds: Some(FieldSliceBounds {
            u_min: projection.u_min,
            u_max: projection.u_max,
            v_min: projection.v_min,
            v_max: projection.v_max,
        }),
        occupied_count: projection.occupied_count,
        occupied_measure: projection.occupied_measure,
        empty_count: projection.empty_count,
        error_estimate,
        error_method,
        scalar: FieldSliceBinaryDescriptor {
            available: true,
            n_comp: 1,
            point_count: projection.x_size * projection.y_size,
            min: Some(projection.min),
            max: Some(projection.max),
            etag: Some(etag.clone()),
            href: Some(scalar_href),
        },
        empty_mask: FieldProjectionMaskDescriptor {
            available: true,
            point_count: projection.x_size * projection.y_size,
            etag: Some(mask_etag),
            href: Some(empty_mask_href),
        },
    };

    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &meta))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/projection/scalar",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldProjectionQuery,
    ),
    responses(
        (status = 200, description = "Binary FMVP v2 projected scalar raster", content_type = "application/octet-stream"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
    ),
    tag = "data"
)]
pub async fn get_field_projection_scalar(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldProjectionQuery>,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(&quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);
    let resolved = resolve_projection_query(&query, n_comp)?;
    let field_revision = snapshot.state_version;
    let gen_id: u64 = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|m| m.generation_id.as_deref())
        .and_then(|g| g.parse().ok())
        .unwrap_or(0);
    let fdm_field = extract_fdm_field(snapshot, &quantity_id, n_comp)
        .ok_or_else(|| ApiError::not_found(format!("field '{}' not available", quantity_id)))?;
    let fem_field = extract_fem_field(snapshot, &quantity_id, n_comp);
    let sampling_method = if fem_field.is_some() {
        "fem_tetra_volume_projection_conservative"
    } else if resolved.adaptive {
        "fdm_layer_projection_adaptive_nearest"
    } else {
        "fdm_layer_projection_nearest"
    };
    let component = component_label(&resolved.component);
    let component_cache_token = format!(
        "{component}:method={sampling_method}:tol={}:min={}",
        resolved
            .error_tolerance
            .map(|value| value.to_bits().to_string())
            .unwrap_or_else(|| "none".to_string()),
        resolved.min_samples
    );
    let cache_key = scalar_projection_cache_key(
        &quantity_id,
        field_revision,
        gen_id,
        resolved.plane.as_str(),
        resolved.x_size,
        resolved.y_size,
        &component_cache_token,
        resolved.reduction.as_str(),
        resolved.include_air_as_zero,
        resolved.samples,
        resolved.tile_x,
        resolved.tile_y,
        resolved.tile_size,
    );
    let etag_token = projection_etag_token(
        &quantity_id,
        field_revision,
        gen_id,
        &resolved,
        sampling_method,
    );
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&etag_token);
    drop(guard);

    {
        let mut cache = state.quantity_data_plane.scalar_slice_cache.lock().await;
        if let Some(cached) = cache.get(&cache_key) {
            return Ok(
                crate::router_v2::handlers::shared::conditional_binary_response(
                    &headers,
                    &cached.etag,
                    cached.bytes.clone(),
                ),
            );
        }
    }

    let projection = compute_projection(&fdm_field, fem_field.as_ref(), &resolved)?;
    let binary = serialize_field_vector_binary_v2(
        &quantity_id,
        1,
        [projection.x_size, projection.y_size, 1],
        &projection.scalar_values,
    );
    {
        let mut cache = state.quantity_data_plane.scalar_slice_cache.lock().await;
        cache.insert(cache_key, binary.clone(), etag.clone());
    }

    Ok(crate::router_v2::handlers::shared::conditional_binary_response(&headers, &etag, binary))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/projection/profile",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldProjectionProfileQuery,
    ),
    responses(
        (status = 200, description = "Depth-resolved FEM projection profile for one raster pixel", body = FieldProjectionProfile),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
        (status = 409, description = "Projection profile requires nodal FEM field and tetrahedral mesh"),
    ),
    tag = "data"
)]
pub async fn get_field_projection_profile(
    State(state): State<Arc<AppState>>,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldProjectionProfileQuery>,
) -> Result<Json<FieldProjectionProfile>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(&quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);
    let resolved = resolve_projection_profile_query(&query, n_comp)?;
    let field_revision = snapshot.state_version;
    let gen_id: u64 = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|m| m.generation_id.as_deref())
        .and_then(|g| g.parse().ok())
        .unwrap_or(0);
    let fem_field = extract_fem_field(snapshot, &quantity_id, n_comp).ok_or_else(|| {
        ApiError::conflict(
            "projection profile requires a nodal FEM field matching the current mesh",
        )
    })?;
    drop(guard);

    let profile = fem_projection_profile(&fem_field, &resolved)?;
    let sample_count = profile.samples.len() as u32;
    let truncated = sample_count >= resolved.max_samples;
    Ok(Json(FieldProjectionProfile {
        quantity_id: quantity_id.clone(),
        component: component_label(&resolved.component),
        plane: resolved.plane.as_str().to_string(),
        field_revision,
        domain_generation_id: gen_id,
        sampling_method: profile.sampling_method.to_string(),
        pixel_x: resolved.pixel_x,
        pixel_y: resolved.pixel_y,
        x_pixels: resolved.x_size,
        y_pixels: resolved.y_size,
        u: profile.u,
        v: profile.v,
        bounds: Some(FieldSliceBounds {
            u_min: profile.u_min,
            u_max: profile.u_max,
            v_min: profile.v_min,
            v_max: profile.v_max,
        }),
        sample_count,
        truncated,
        samples: profile
            .samples
            .into_iter()
            .map(|sample| FieldProjectionProfileSample {
                element_index: sample.element_index,
                marker: sample.marker,
                normal_coord: sample.normal_coord,
                value: sample.value,
                measure: sample.measure,
            })
            .collect(),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/projection/empty-mask",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldProjectionQuery,
    ),
    responses(
        (status = 200, description = "Binary projected empty-column mask, one byte per raster cell", content_type = "application/octet-stream"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
    ),
    tag = "data"
)]
pub async fn get_field_projection_empty_mask(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldProjectionQuery>,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(&quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);
    let resolved = resolve_projection_query(&query, n_comp)?;
    let field_revision = snapshot.state_version;
    let gen_id: u64 = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|m| m.generation_id.as_deref())
        .and_then(|g| g.parse().ok())
        .unwrap_or(0);
    let fdm_field = extract_fdm_field(snapshot, &quantity_id, n_comp)
        .ok_or_else(|| ApiError::not_found(format!("field '{}' not available", quantity_id)))?;
    let fem_field = extract_fem_field(snapshot, &quantity_id, n_comp);
    let sampling_method = if fem_field.is_some() {
        "fem_tetra_volume_projection_conservative"
    } else if resolved.adaptive {
        "fdm_layer_projection_adaptive_nearest"
    } else {
        "fdm_layer_projection_nearest"
    };
    let component = component_label(&resolved.component);
    let component_cache_token = format!(
        "{component}:method={sampling_method}:tol={}:min={}",
        resolved
            .error_tolerance
            .map(|value| value.to_bits().to_string())
            .unwrap_or_else(|| "none".to_string()),
        resolved.min_samples
    );
    let cache_key = projection_empty_mask_cache_key(
        &quantity_id,
        field_revision,
        gen_id,
        resolved.plane.as_str(),
        resolved.x_size,
        resolved.y_size,
        &component_cache_token,
        resolved.reduction.as_str(),
        resolved.include_air_as_zero,
        resolved.samples,
        resolved.tile_x,
        resolved.tile_y,
        resolved.tile_size,
    );
    let etag_token = projection_etag_token(
        &quantity_id,
        field_revision,
        gen_id,
        &resolved,
        sampling_method,
    );
    let etag =
        crate::router_v2::handlers::shared::stable_strong_etag(&format!("empty-mask:{etag_token}"));
    drop(guard);

    {
        let mut cache = state.quantity_data_plane.scalar_slice_cache.lock().await;
        if let Some(cached) = cache.get(&cache_key) {
            return Ok(
                crate::router_v2::handlers::shared::conditional_binary_response(
                    &headers,
                    &cached.etag,
                    cached.bytes.clone(),
                ),
            );
        }
    }

    let projection = compute_projection(&fdm_field, fem_field.as_ref(), &resolved)?;
    let binary = projection.empty_mask;
    {
        let mut cache = state.quantity_data_plane.scalar_slice_cache.lock().await;
        cache.insert(cache_key, binary.clone(), etag.clone());
    }

    Ok(crate::router_v2::handlers::shared::conditional_binary_response(&headers, &etag, binary))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/samples/slice/meta",
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
    tag = "data"
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
    let scalar_etag = crate::router_v2::handlers::shared::stable_strong_etag(&scalar_etag_token);

    let meta_etag_token = format!("meta:{}", scalar_etag_token);
    let meta_etag = crate::router_v2::handlers::shared::stable_strong_etag(&meta_etag_token);

    let mut arrows_query = resolved.clone();
    arrows_query.component = ComponentSelection::Full;
    arrows_query.include_arrows = true;
    let arrows_etag_token = format!(
        "arrows:{}",
        slice_etag_token(&quantity_id, field_revision, gen_id, &arrows_query)
    );
    let arrows_etag = crate::router_v2::handlers::shared::stable_strong_etag(&arrows_etag_token);

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
        "/v2/sessions/current/data/fields/{}/samples/slice/scalar?plane={}&component={}&{}&{}",
        urlencoding(&quantity_id),
        plane_param,
        comp_param,
        cut_param,
        size_param
    );
    let arrows_href = if resolved.include_arrows {
        Some(format!(
            "/v2/sessions/current/data/fields/{}/samples/slice/arrows?plane={}&component=full&{}&{}&arrow_every={}&max_arrows={}",
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

    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &meta_etag, &meta))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/samples/slice/scalar",
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
    tag = "data"
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
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&etag_token);

    drop(guard);

    {
        let mut cache = state.quantity_data_plane.scalar_slice_cache.lock().await;
        if let Some(cached) = cache.get(&cache_key) {
            let mut resp = crate::router_v2::handlers::shared::conditional_binary_response(
                &headers,
                &cached.etag,
                cached.bytes.clone(),
            );
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

    let mut resp =
        crate::router_v2::handlers::shared::conditional_binary_response(&headers, &etag, binary);
    if let Ok(v) = HeaderValue::from_str(&field_revision.to_string()) {
        resp.headers_mut()
            .insert(axum::http::HeaderName::from_static(HDR_FIELD_REVISION), v);
    }
    Ok(resp)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/samples/slice/arrows",
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
    tag = "data"
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
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&etag_token);

    drop(guard);

    {
        let mut cache = state.quantity_data_plane.arrow_slice_cache.lock().await;
        if let Some(cached) = cache.get(&cache_key) {
            return Ok(
                crate::router_v2::handlers::shared::conditional_binary_response(
                    &headers,
                    &cached.etag,
                    cached.bytes.clone(),
                ),
            );
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

    Ok(crate::router_v2::handlers::shared::conditional_binary_response(&headers, &etag, binary))
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
