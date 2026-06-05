//! Field endpoints — catalog, meta, binary vector (P1 component), and 2D slice (P2).

use std::borrow::Cow;
use std::collections::BTreeSet;
use std::sync::Arc;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;

use super::field_resolution::{
    extract_fdm_field, extract_fem_field, field_values_match_current_domain,
    flatten_json_field_values, json_field_grid, live_magnetization_available,
    live_magnetization_values,
};
use crate::error::ApiError;
use crate::fem_slice::{fem_tetra_linear_slice, fem_tetra_slab_slice, SlabAggregation};
use crate::fem_slice_overlay::{
    collect_fem_slice_overlay, cut_norm_from_world, fem_normal_bounds_from_nodes,
    overlay_segments_to_pixel_lines, FemSliceOverlayInput, SliceOverlayBounds,
};
use crate::fem_spatial_index::FemNormalAxisIndex;
use crate::field_projection::{
    component_etag_token, parse_component, project_values, ComponentSelection,
};
use crate::field_render_png::{
    encode_rgba_matrix_png, encode_rgba_matrix_png_with_lines, encode_scalar_png,
    encode_scalar_png_with_lines, AutoScaleMode,
};
use crate::field_slice::{
    fdm_projection, fdm_slice, fem_projection_exact, fem_projection_profile, fem_slice_fallback,
    resolve_projection_profile_query, resolve_projection_query, resolve_slice_query,
    slice_etag_token, FdmField, FemField, FieldProjectionProfileQuery, FieldProjectionQuery,
    FieldSliceQuery, ProjectionResult, ResolvedProjectionQuery, SlicePlane,
};
use crate::field_store::serialize_field_vector_binary_v2;
use crate::orientation_color::apply_magnetization_hsl_rgba;
use crate::preview::{quantity_spatial_domain, quantity_unit};
use crate::quantity_data_plane::{
    projection_empty_mask_cache_key, scalar_projection_cache_key, slice_cache_key,
};
use crate::router_v2::handlers::sessions::status::{
    field_catalog_revision as current_field_catalog_revision, field_quantity_revision,
};
use crate::schemas::fields::*;
use crate::types::AppState;
use crate::types::SessionStateResponse;
use fullmag_quantities::{normalize_quantity_id, quantity_spec};
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

fn canonical_quantity_id(requested: &str) -> Cow<'_, str> {
    normalize_quantity_id(requested)
        .map(|id| Cow::Borrowed(id.as_str()))
        .unwrap_or_else(|_| Cow::Borrowed(requested))
}

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

    for (qid, value) in snapshot.latest_fields.entries() {
        let n_comp = quantity_spec(qid)
            .map(|spec| spec.n_comp as usize)
            .unwrap_or(3);
        let values = flatten_json_field_values(value);
        if !field_values_match_current_domain(snapshot, qid, n_comp, &values) {
            continue;
        }
        push_field_descriptor(
            &mut quantities,
            qid,
            quantity_unit(qid),
            field_quantity_revision(snapshot, qid),
            gen_id,
        );
    }

    for (qid, field) in snapshot.preview_cache.iter() {
        if quantities.iter().any(|q| q.quantity_id == *qid) {
            continue;
        }
        let n_comp = quantity_spec(qid)
            .map(|spec| spec.n_comp as usize)
            .unwrap_or(3);
        if !field_values_match_current_domain(snapshot, qid, n_comp, &field.vector_field_values) {
            continue;
        }
        push_field_descriptor(
            &mut quantities,
            qid,
            &field.unit,
            field_quantity_revision(snapshot, qid),
            gen_id,
        );
    }

    if live_magnetization_available(snapshot) && !quantities.iter().any(|q| q.quantity_id == "m") {
        push_field_descriptor(
            &mut quantities,
            "m",
            quantity_unit("m"),
            field_quantity_revision(snapshot, "m"),
            gen_id,
        );
    }

    Ok(Json(FieldCatalog {
        revision: current_field_catalog_revision(snapshot),
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
    let quantity_id = canonical_quantity_id(&quantity_id);
    let quantity_id = quantity_id.as_ref();
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(quantity_id);
    let n_comp = spec.map(|s| s.n_comp).unwrap_or(3);
    let label = spec
        .map(|s| s.label.to_string())
        .unwrap_or_else(|| quantity_id.to_string());
    let kind = spec
        .map(|s| s.shape.as_api_kind().to_string())
        .unwrap_or_else(|| "vector_field".into());
    let unit = quantity_unit(quantity_id).to_string();
    let location = quantity_spatial_domain(quantity_id).to_string();

    let gen_id = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|m| m.generation_id.as_deref())
        .and_then(|g| g.parse::<u64>().ok())
        .unwrap_or(0);

    if snapshot
        .latest_fields
        .get(quantity_id)
        .map(|raw| flatten_json_field_values(raw))
        .is_some_and(|values| {
            field_values_match_current_domain(snapshot, quantity_id, n_comp as usize, &values)
        })
    {
        return Ok(Json(FieldMeta {
            quantity_id: quantity_id.to_string(),
            label,
            kind,
            components: n_comp,
            location,
            unit,
            field_revision: field_quantity_revision(snapshot, quantity_id),
            domain_generation_id: gen_id,
            stats: None,
        }));
    }

    if snapshot
        .preview_cache
        .get(quantity_id)
        .is_some_and(|field| {
            field_values_match_current_domain(
                snapshot,
                quantity_id,
                n_comp as usize,
                &field.vector_field_values,
            )
        })
        || (quantity_id == "m" && live_magnetization_available(snapshot))
    {
        return Ok(Json(FieldMeta {
            quantity_id: quantity_id.to_string(),
            label,
            kind,
            components: n_comp,
            location,
            unit,
            field_revision: field_quantity_revision(snapshot, quantity_id),
            domain_generation_id: gen_id,
            stats: None,
        }));
    }

    Err(ApiError::not_found(format!(
        "field '{}' not available in memory",
        quantity_id
    )))
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

#[derive(Debug, Clone)]
struct ResolvedFieldScope {
    domain: ResolvedFieldScopeDomain,
    kind: String,
    id: Option<String>,
    node_indices: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResolvedFieldScopeDomain {
    Air,
    Magnetic,
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
    quantity_id: &str,
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
            let part_id = mesh
                .mesh_parts
                .iter()
                .find(|part| part.role == "air")
                .map(|part| part.id.clone())
                .ok_or_else(|| ApiError::not_found("airbox mesh part not found"))?;
            resolve_part_scope(mesh, &part_id, "airbox")?
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
            )));
        }
    };
    if quantity_spatial_domain(quantity_id) == "magnetic_only"
        && scope.domain == ResolvedFieldScopeDomain::Air
    {
        return Err(ApiError::not_found(format!(
            "field '{quantity_id}' is not available on airbox mesh scope"
        )));
    }
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

fn object_ids_match(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let clean_a = a.strip_suffix("_geom").unwrap_or(a);
    let clean_b = b.strip_suffix("_geom").unwrap_or(b);
    clean_a == clean_b
}

fn resolve_object_scope(
    mesh: &FemMeshPayload,
    object_id: &str,
) -> Result<ResolvedFieldScope, ApiError> {
    if let Some(part) = mesh.mesh_parts.iter().find(|part| {
        part.role == "magnetic_object"
            && (part
                .object_id
                .as_deref()
                .map(|id| object_ids_match(id, object_id))
                .unwrap_or(false)
                || part
                    .geometry_id
                    .as_deref()
                    .map(|id| object_ids_match(id, object_id))
                    .unwrap_or(false)
                || part.id == object_id)
    }) {
        return Ok(ResolvedFieldScope {
            domain: ResolvedFieldScopeDomain::Magnetic,
            kind: "object".to_string(),
            id: Some(object_id.to_string()),
            node_indices: node_indices_for_part(part),
        });
    }

    let segment = mesh
        .object_segments
        .iter()
        .find(|segment| object_ids_match(&segment.object_id, object_id))
        .ok_or_else(|| ApiError::not_found(format!("object mesh not found: {object_id}")))?;
    Ok(ResolvedFieldScope {
        domain: if segment.object_id == "__air__" {
            ResolvedFieldScopeDomain::Air
        } else {
            ResolvedFieldScopeDomain::Magnetic
        },
        kind: "object".to_string(),
        id: Some(object_id.to_string()),
        node_indices: node_indices_for_segment(mesh, segment),
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

fn node_indices_for_segment(
    mesh: &FemMeshPayload,
    segment: &fullmag_runner::FemMeshObjectSegment,
) -> Vec<usize> {
    let mut node_indices = BTreeSet::new();

    let start = segment.node_start as usize;
    let end = start.saturating_add(segment.node_count as usize);
    node_indices.extend(start..end);

    let element_start = segment.element_start as usize;
    let element_end = element_start.saturating_add(segment.element_count as usize);
    if let Some(elements) = mesh.elements.get(element_start..element_end) {
        for element in elements {
            node_indices.extend(element.iter().map(|index| *index as usize));
        }
    }

    let face_start = segment.boundary_face_start as usize;
    let face_end = face_start.saturating_add(segment.boundary_face_count as usize);
    if let Some(faces) = mesh.boundary_faces.get(face_start..face_end) {
        for face in faces {
            node_indices.extend(face.iter().map(|index| *index as usize));
        }
    }

    node_indices.into_iter().collect()
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
        domain: if part.role == "air" {
            ResolvedFieldScopeDomain::Air
        } else {
            ResolvedFieldScopeDomain::Magnetic
        },
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
            .any(|segment| object_ids_match(&segment.object_id, entity_id))
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
            .any(|segment| object_ids_match(&segment.object_id, node_id))
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

fn resolve_field_vector_sample_limit(
    query: &FieldVectorQuery,
    _scope: Option<&ResolvedFieldScope>,
) -> Result<Option<usize>, ApiError> {
    let Some(max_samples) = query.max_samples else {
        return Ok(None);
    };
    if max_samples == 0 {
        return Err(ApiError::bad_request(
            "max_samples must be greater than zero",
        ));
    }
    Ok(Some(max_samples as usize))
}

fn sample_field_scope(
    mut scope: ResolvedFieldScope,
    max_samples: Option<usize>,
) -> ResolvedFieldScope {
    let Some(max_samples) = max_samples else {
        return scope;
    };
    if max_samples >= scope.node_indices.len() {
        return scope;
    }

    let sample_count = max_samples.max(1);
    let stride = (scope.node_indices.len() / sample_count).max(1);
    scope.node_indices = (0..sample_count)
        .filter_map(|sample| scope.node_indices.get(sample * stride).copied())
        .collect();
    scope
}

fn field_vector_sample_cache_token(max_samples: Option<usize>) -> String {
    max_samples
        .map(|value| format!(":max_samples={value}"))
        .unwrap_or_default()
}

fn sample_unscoped_field_values(
    raw_values: Vec<f64>,
    grid: [u32; 3],
    n_comp: usize,
    max_samples: Option<usize>,
) -> (Vec<f64>, [u32; 3]) {
    let Some(max_samples) = max_samples else {
        return (raw_values, grid);
    };
    let n_comp = n_comp.max(1);
    let point_count = raw_values.len() / n_comp;
    if max_samples >= point_count {
        return (raw_values, grid);
    }

    let sample_count = max_samples.max(1);
    let start = point_count.saturating_sub(sample_count) / 2;
    let mut sampled = Vec::with_capacity(sample_count * n_comp);
    for point_index in start..start + sample_count {
        let offset = point_index * n_comp;
        sampled.extend_from_slice(&raw_values[offset..offset + n_comp]);
    }

    (sampled, [sample_count as u32, 1, 1])
}

// ── Binary vector — P1 ───────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/samples/vector",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        ("If-None-Match" = Option<String>, Header, description = "Strong ETag from a previous field-vector response"),
        FieldVectorQuery,
    ),
    responses(
        (status = 200, description = "Binary FMVP v2 field vector", content_type = "application/octet-stream"),
        (status = 204, description = "Recognized field quantity is not available yet"),
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
    let quantity_id = canonical_quantity_id(&quantity_id);
    let quantity_id = quantity_id.as_ref();
    let workspace_selection = if query.scope_kind.as_deref() == Some("selection") {
        Some(state.current_workspace_selection.read().await.clone())
    } else {
        None
    };
    let guard = state.current_live_state.read().await;
    let Some(snapshot) = guard.as_ref() else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };

    let spec = quantity_spec(quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);

    let component = parse_component(query.component.as_deref(), n_comp)?;

    let field_revision = field_quantity_revision(snapshot, quantity_id);
    let gen_id_str = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|mesh| mesh.generation_id.as_deref())
        .unwrap_or("0");
    let gen_id: u64 = gen_id_str.parse().unwrap_or(0);

    // Collect raw values under the lock, then drop the lock before any heavy work
    let latest_field_values = || {
        if let Some(raw) = snapshot.latest_fields.get(quantity_id) {
            let values = flatten_json_field_values(raw);
            if !field_values_match_current_domain(snapshot, quantity_id, n_comp, &values) {
                return None;
            }
            let element_count = if n_comp > 0 {
                values.len() / n_comp
            } else {
                values.len()
            };
            let grid = json_field_grid(raw).unwrap_or([element_count as u32, 1, 1]);
            Some((values, grid))
        } else {
            None
        }
    };
    let preview_field_values = || {
        if let Some(field) = snapshot.preview_cache.get(quantity_id) {
            if !field_values_match_current_domain(
                snapshot,
                quantity_id,
                n_comp,
                &field.vector_field_values,
            ) {
                return None;
            }
            Some((field.vector_field_values.clone(), field.preview_grid))
        } else {
            None
        }
    };
    let raw_values_opt: Option<(Vec<f64>, [u32; 3])> = if quantity_id == "m" {
        live_magnetization_values(snapshot)
            .or_else(preview_field_values)
            .or_else(latest_field_values)
    } else {
        latest_field_values().or_else(preview_field_values)
    };
    let has_field_source = snapshot.latest_fields.get(quantity_id).is_some()
        || snapshot.preview_cache.get(quantity_id).is_some()
        || (quantity_id == "m"
            && snapshot
                .live_state
                .as_ref()
                .and_then(|state| state.latest_step.magnetization.as_ref())
                .is_some());

    let (raw_values, grid) = match raw_values_opt {
        Some(values) => values,
        None if spec.is_some() && !has_field_source => {
            return Ok(StatusCode::NO_CONTENT.into_response());
        }
        None => {
            return Err(ApiError::not_found(format!(
                "field '{}' not available in memory",
                quantity_id
            )));
        }
    };
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
        quantity_id,
    )?;
    let sample_limit = resolve_field_vector_sample_limit(&query, resolved_scope.as_ref())?;
    let resolved_scope = resolved_scope.map(|scope| sample_field_scope(scope, sample_limit));

    drop(guard);

    let scope_token = resolved_scope
        .as_ref()
        .map(ResolvedFieldScope::cache_token)
        .unwrap_or_else(|| "full-domain".to_string());
    let sample_token = field_vector_sample_cache_token(sample_limit);
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "{}:{scope_token}{sample_token}",
        component_etag_token(quantity_id, field_revision, gen_id, &component)
    ));
    let scoped_grid = resolved_scope
        .as_ref()
        .map(|scope| [scope.node_indices.len() as u32, 1, 1])
        .unwrap_or(grid);
    let (raw_values, scoped_grid) = if resolved_scope.is_some() {
        (
            apply_field_scope(raw_values, grid, n_comp, resolved_scope.as_ref()),
            scoped_grid,
        )
    } else {
        sample_unscoped_field_values(raw_values, scoped_grid, n_comp, sample_limit)
    };

    // P4: check projection cache before doing heavy projection work
    let comp_key = match &component {
        ComponentSelection::Full => "full".to_string(),
        ComponentSelection::Magnitude => "magnitude".to_string(),
        ComponentSelection::MagnitudeSquared => "magnitude_squared".to_string(),
        ComponentSelection::AbsIndex(i) => format!("abs_c{}", i),
        ComponentSelection::Index(i) => format!("c{}", i),
    };
    let cache_key = crate::quantity_data_plane::projection_cache_key(
        quantity_id,
        field_revision,
        gen_id,
        &format!("{comp_key}:{scope_token}{sample_token}"),
    );
    {
        let mut proj_cache = state.quantity_data_plane.projection_cache.lock().await;
        if let Some(cached) = proj_cache.get(&cache_key) {
            let binary = cached.bytes.clone();
            drop(proj_cache);
            // Derive point/value counts from cached FMVP payload for headers.
            let total_value_count = if binary.len() > 48 {
                (binary.len() - 48) / 8
            } else {
                0
            };
            let out_n_comp_for_header: usize = if binary.len() > 6 {
                binary[6] as usize
            } else {
                1
            };
            let point_count = total_value_count / out_n_comp_for_header.max(1);
            let mut resp = crate::router_v2::handlers::shared::conditional_binary_response(
                &headers, &etag, binary,
            );
            insert_field_headers(
                &mut resp,
                quantity_id,
                &component,
                field_revision,
                gen_id,
                point_count,
                total_value_count,
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

    let binary = serialize_field_vector_binary_v2(quantity_id, out_n_comp, out_grid, &projected)
        .map_err(ApiError::internal)?;

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
        quantity_id,
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
        q.tile_x
            .map_or_else(|| "full".to_string(), |value| value.to_string()),
        q.tile_y
            .map_or_else(|| "full".to_string(), |value| value.to_string()),
        q.tile_size
            .map_or_else(|| "full".to_string(), |value| value.to_string()),
    )
}

fn slice_cut_cache_key(q: &crate::field_slice::ResolvedSliceQuery) -> String {
    q.cut_world
        .map(|value| format!("world:{}", value.to_bits()))
        .unwrap_or_else(|| format!("norm:{}", q.cut_norm.to_bits()))
}

#[derive(Debug, Clone, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct FieldSliceMatrixQuery {
    pub plane: SlicePlane,
    pub component: Option<String>,
    pub color_mode: Option<String>,
    pub cut_world: Option<f64>,
    pub cut_norm: Option<f64>,
    pub mode: Option<String>,
    pub thickness_world: Option<f64>,
    pub aggregation: Option<String>,
    pub x_size: Option<u32>,
    pub y_size: Option<u32>,
    pub max_points: Option<u32>,
    pub samples: Option<u32>,
    pub format: Option<String>,
}

#[derive(Debug, Clone, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct FieldProjectionMatrixQuery {
    pub plane: SlicePlane,
    pub component: Option<String>,
    pub color_mode: Option<String>,
    pub mode: Option<String>,
    pub aggregation: Option<String>,
    pub reduction: Option<String>,
    pub include_air_as_zero: Option<bool>,
    pub samples: Option<u32>,
    pub adaptive: Option<bool>,
    pub error_tolerance: Option<f64>,
    pub min_samples: Option<u32>,
    pub x_size: Option<u32>,
    pub y_size: Option<u32>,
    pub max_points: Option<u32>,
    pub format: Option<String>,
}

#[derive(Debug, Clone, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct FieldRenderPngQuery {
    pub plane: SlicePlane,
    pub component: Option<String>,
    pub color_mode: Option<String>,
    pub cut_world: Option<f64>,
    pub cut_norm: Option<f64>,
    pub mode: Option<String>,
    pub thickness_world: Option<f64>,
    pub aggregation: Option<String>,
    pub reduction: Option<String>,
    pub include_air_as_zero: Option<bool>,
    pub samples: Option<u32>,
    pub adaptive: Option<bool>,
    pub error_tolerance: Option<f64>,
    pub min_samples: Option<u32>,
    pub x_size: Option<u32>,
    pub y_size: Option<u32>,
    pub max_points: Option<u32>,
    pub colormap: Option<String>,
    pub vmin: Option<f64>,
    pub vmax: Option<f64>,
    pub auto_scale: Option<String>,
    pub alpha_mask: Option<bool>,
    pub show_mesh: Option<bool>,
    pub show_arrows: Option<bool>,
}

struct MatrixBuild {
    response: FieldMatrixResponse,
    scalar_values: Option<Vec<f64>>,
    rgba_pixels: Option<Vec<[u8; 4]>>,
    mask_flat: Vec<u8>,
    mesh_lines: Vec<[f64; 4]>,
}

fn slice_matrix_mode(mode: Option<&str>) -> Result<&'static str, ApiError> {
    match mode.unwrap_or("exact") {
        "exact" => Ok("exact"),
        "slab" => Ok("slab"),
        "projection" => Err(ApiError::bad_request(
            "invalid_query: use projection/matrix.json for mode=projection",
        )),
        other => Err(ApiError::bad_request(format!(
            "invalid_query: unsupported slice matrix mode '{other}'"
        ))),
    }
}

fn matrix_format(format: Option<&str>) -> Result<&'static str, ApiError> {
    match format.unwrap_or("values") {
        "values" => Ok("values"),
        "rgba" => Ok("rgba"),
        "both" => Ok("both"),
        other => Err(ApiError::bad_request(format!(
            "invalid_query: unsupported matrix format '{other}'"
        ))),
    }
}

fn color_mode(color_mode: Option<&str>, component: Option<&str>) -> Result<&'static str, ApiError> {
    let inferred = if component == Some("orientation") {
        "orientation"
    } else {
        color_mode.unwrap_or("scalar")
    };
    match inferred {
        "scalar" => Ok("scalar"),
        "orientation" => Ok("orientation"),
        other => Err(ApiError::bad_request(format!(
            "invalid_query: unsupported color_mode '{other}'"
        ))),
    }
}

fn matrix_axes(plane: SlicePlane) -> (&'static str, &'static str, &'static str) {
    match plane {
        SlicePlane::Xy => ("x", "y", "z"),
        SlicePlane::Xz => ("x", "z", "y"),
        SlicePlane::Yz => ("y", "z", "x"),
    }
}

fn slice_normal_axis(plane: SlicePlane) -> usize {
    match plane {
        SlicePlane::Xy => 2,
        SlicePlane::Xz => 1,
        SlicePlane::Yz => 0,
    }
}

fn fdm_normal_bounds(field: &FdmField, plane: SlicePlane) -> Option<(f64, f64)> {
    let axis = slice_normal_axis(plane);
    let origin = field.origin?;
    let spacing = field.spacing?;
    let extent = field.grid[axis] as f64 * spacing[axis];
    if !origin[axis].is_finite() || !extent.is_finite() || extent.abs() <= f64::EPSILON {
        return None;
    }
    let end = origin[axis] + extent;
    Some((origin[axis].min(end), origin[axis].max(end)))
}

fn matrix_hash(raw: &str) -> String {
    crate::router_v2::handlers::shared::stable_strong_etag(raw)
}

fn spatial_index_key(
    quantity_id: &str,
    domain_generation_id: u64,
    normal_axis: usize,
    field: &FemField,
) -> String {
    format!(
        "fem-spatial:{quantity_id}:{domain_generation_id}:axis={normal_axis}:nodes={}:elements={}:v1",
        field.nodes.len(),
        field.elements.len()
    )
}

async fn get_or_build_fem_spatial_index(
    state: &AppState,
    quantity_id: &str,
    domain_generation_id: u64,
    plane: SlicePlane,
    field: &FemField,
) -> std::sync::Arc<FemNormalAxisIndex> {
    let normal_axis = match plane {
        SlicePlane::Xy => 2,
        SlicePlane::Xz => 1,
        SlicePlane::Yz => 0,
    };
    let key = spatial_index_key(quantity_id, domain_generation_id, normal_axis, field);
    let mut cache = state
        .quantity_data_plane
        .fem_spatial_index_cache
        .lock()
        .await;
    if let Some(index) = cache.get(&key) {
        return index.clone();
    }
    let bins = (field.elements.len() as f64).sqrt().ceil().max(16.0) as usize;
    let index = std::sync::Arc::new(FemNormalAxisIndex::build(
        &field.nodes,
        &field.elements,
        normal_axis,
        bins,
    ));
    cache.insert(key, index.clone());
    index
}

fn slice_query_from_matrix(query: &FieldSliceMatrixQuery, component: String) -> FieldSliceQuery {
    FieldSliceQuery {
        plane: query.plane,
        component: Some(component),
        cut_world: query.cut_world,
        cut_norm: query.cut_norm,
        x_size: query.x_size,
        y_size: query.y_size,
        max_points: query.max_points,
        include_arrows: None,
        arrow_every: None,
        max_arrows: None,
    }
}

fn projection_query_from_matrix(query: &FieldProjectionMatrixQuery) -> FieldProjectionQuery {
    FieldProjectionQuery {
        plane: query.plane,
        component: query.component.clone(),
        reduction: query
            .reduction
            .clone()
            .or_else(|| query.aggregation.clone())
            .or_else(|| Some("mean_occupied".to_string())),
        include_air_as_zero: query.include_air_as_zero,
        samples: query.samples,
        adaptive: query.adaptive,
        error_tolerance: query.error_tolerance,
        min_samples: query.min_samples,
        x_size: query.x_size,
        y_size: query.y_size,
        max_points: query.max_points,
        tile_x: None,
        tile_y: None,
        tile_size: None,
    }
}

fn matrix_rows(values: &[f64], mask: &[u8], x_size: u32, y_size: u32) -> Vec<Vec<Option<f64>>> {
    let width = x_size as usize;
    (0..y_size as usize)
        .map(|row| {
            (0..width)
                .map(|col| {
                    let index = row * width + col;
                    let value = values.get(index).copied().unwrap_or(f64::NAN);
                    if mask.get(index).copied().unwrap_or(1) == 0 && value.is_finite() {
                        Some(value)
                    } else {
                        None
                    }
                })
                .collect()
        })
        .collect()
}

fn mask_rows(mask: &[u8], x_size: u32, y_size: u32) -> Vec<Vec<u8>> {
    let width = x_size as usize;
    (0..y_size as usize)
        .map(|row| {
            (0..width)
                .map(|col| mask.get(row * width + col).copied().unwrap_or(1))
                .collect()
        })
        .collect()
}

fn rgba_rows(rgba: &[[u8; 4]], x_size: u32, y_size: u32) -> Vec<Vec<[u8; 4]>> {
    let width = x_size as usize;
    (0..y_size as usize)
        .map(|row| {
            (0..width)
                .map(|col| rgba.get(row * width + col).copied().unwrap_or([0, 0, 0, 0]))
                .collect()
        })
        .collect()
}

fn finite_min_max(values: &[f64], mask: &[u8]) -> (Option<f64>, Option<f64>) {
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for (index, value) in values.iter().copied().enumerate() {
        if mask.get(index).copied().unwrap_or(1) == 0 && value.is_finite() {
            min = min.min(value);
            max = max.max(value);
        }
    }
    if min.is_infinite() || max.is_infinite() {
        (None, None)
    } else {
        (Some(min), Some(max))
    }
}

fn orientation_rgba_from_full_values(result: &crate::field_slice::SliceResult) -> Vec<[u8; 4]> {
    let width = result.x_size as usize;
    let height = result.y_size as usize;
    let mut rgba = Vec::with_capacity(width * height);
    for pixel in 0..width * height {
        if result.empty_mask.get(pixel).copied().unwrap_or(1) != 0 || result.n_comp_out < 3 {
            rgba.push([0, 0, 0, 0]);
            continue;
        }
        let base = pixel * result.n_comp_out;
        let mx = result.scalar_values.get(base).copied().unwrap_or(0.0);
        let my = result.scalar_values.get(base + 1).copied().unwrap_or(0.0);
        let mz = result.scalar_values.get(base + 2).copied().unwrap_or(0.0);
        rgba.push(apply_magnetization_hsl_rgba(mx, my, mz, 255));
    }
    rgba
}

fn magnitude_values_from_full(result: &crate::field_slice::SliceResult) -> Vec<f64> {
    let pixel_count = result.x_size as usize * result.y_size as usize;
    (0..pixel_count)
        .map(|pixel| {
            if result.empty_mask.get(pixel).copied().unwrap_or(1) != 0 || result.n_comp_out < 3 {
                return f64::NAN;
            }
            let base = pixel * result.n_comp_out;
            let mx = result.scalar_values.get(base).copied().unwrap_or(0.0);
            let my = result.scalar_values.get(base + 1).copied().unwrap_or(0.0);
            let mz = result.scalar_values.get(base + 2).copied().unwrap_or(0.0);
            (mx * mx + my * my + mz * mz).sqrt()
        })
        .collect()
}

fn matrix_response_from_slice(
    quantity_id: &str,
    plane: SlicePlane,
    mode: &str,
    component: &str,
    color_mode: &str,
    format: &str,
    aggregation: Option<String>,
    effective_thickness_world: Option<f64>,
    result: crate::field_slice::SliceResult,
    hash: String,
) -> Result<MatrixBuild, ApiError> {
    let (u_axis, v_axis, normal_axis) = matrix_axes(plane);
    let mask_flat = result.empty_mask.clone();
    let mut scalar_values = None;
    let mut values = None;
    let mut rgba_pixels = None;
    let mut rgba = None;

    if color_mode == "orientation" {
        if result.n_comp_out < 3 {
            return Err(ApiError::bad_request(
                "invalid_query: color_mode=orientation requires a vector field with at least 3 components",
            ));
        }
        let pixels = orientation_rgba_from_full_values(&result);
        if format == "rgba" || format == "both" || format == "values" {
            rgba = Some(rgba_rows(&pixels, result.x_size, result.y_size));
            rgba_pixels = Some(pixels);
        }
        if format == "both" {
            let magnitudes = magnitude_values_from_full(&result);
            values = Some(matrix_rows(
                &magnitudes,
                &mask_flat,
                result.x_size,
                result.y_size,
            ));
            scalar_values = Some(magnitudes);
        }
    } else {
        if result.n_comp_out != 1 {
            return Err(ApiError::bad_request(
                "invalid_query: matrix.json scalar mode requires a scalar component",
            ));
        }
        scalar_values = Some(result.scalar_values.clone());
        values = Some(matrix_rows(
            &result.scalar_values,
            &mask_flat,
            result.x_size,
            result.y_size,
        ));
    }

    let (min, max) = scalar_values
        .as_ref()
        .map(|values| finite_min_max(values, &mask_flat))
        .unwrap_or((None, None));
    let response = FieldMatrixResponse {
        schema: "fullmag.field_2d.matrix.v1".to_string(),
        quantity_id: quantity_id.to_string(),
        plane: plane.as_str().to_string(),
        mode: mode.to_string(),
        component: component.to_string(),
        color_mode: color_mode.to_string(),
        x_size: result.x_size,
        y_size: result.y_size,
        u_axis: u_axis.to_string(),
        v_axis: v_axis.to_string(),
        normal_axis: normal_axis.to_string(),
        cut_world: result.cut_world,
        bounds: FieldSliceBounds {
            u_min: result.u_min,
            u_max: result.u_max,
            v_min: result.v_min,
            v_max: result.v_max,
        },
        values,
        rgba,
        mask: mask_rows(&mask_flat, result.x_size, result.y_size),
        min,
        max,
        sampling_method: result.sampling_method.to_string(),
        aggregation,
        effective_thickness_world,
        matrix_hash: hash,
        warnings: Vec::new(),
    };

    Ok(MatrixBuild {
        response,
        scalar_values,
        rgba_pixels,
        mask_flat,
        mesh_lines: Vec::new(),
    })
}

fn matrix_response_from_projection(
    quantity_id: &str,
    plane: SlicePlane,
    component: &str,
    aggregation: &str,
    projection: ProjectionResult,
    hash: String,
) -> MatrixBuild {
    let (u_axis, v_axis, normal_axis) = matrix_axes(plane);
    let mask_flat = projection.empty_mask.clone();
    let values = matrix_rows(
        &projection.scalar_values,
        &mask_flat,
        projection.x_size,
        projection.y_size,
    );
    let (min, max) = finite_min_max(&projection.scalar_values, &mask_flat);
    let response = FieldMatrixResponse {
        schema: "fullmag.field_2d.matrix.v1".to_string(),
        quantity_id: quantity_id.to_string(),
        plane: plane.as_str().to_string(),
        mode: "projection".to_string(),
        component: component.to_string(),
        color_mode: "scalar".to_string(),
        x_size: projection.x_size,
        y_size: projection.y_size,
        u_axis: u_axis.to_string(),
        v_axis: v_axis.to_string(),
        normal_axis: normal_axis.to_string(),
        cut_world: None,
        bounds: FieldSliceBounds {
            u_min: projection.u_min,
            u_max: projection.u_max,
            v_min: projection.v_min,
            v_max: projection.v_max,
        },
        values: Some(values),
        rgba: None,
        mask: mask_rows(&mask_flat, projection.x_size, projection.y_size),
        min,
        max,
        sampling_method: projection.sampling_method.to_string(),
        aggregation: Some(aggregation.to_string()),
        effective_thickness_world: None,
        matrix_hash: hash,
        warnings: Vec::new(),
    };
    MatrixBuild {
        response,
        scalar_values: Some(projection.scalar_values),
        rgba_pixels: None,
        mask_flat,
        mesh_lines: Vec::new(),
    }
}

fn matrix_etag_token(
    quantity_id: &str,
    field_revision: u64,
    domain_generation_id: u64,
    plane: SlicePlane,
    mode: &str,
    component: &str,
    color_mode: &str,
    x_size: u32,
    y_size: u32,
    extra: &str,
) -> String {
    format!(
        "fmmatrix:{quantity_id}:{field_revision}:{domain_generation_id}:{}:{mode}:{component}:{color_mode}:{x_size}x{y_size}:{extra}:v1",
        plane.as_str()
    )
}

fn component_for_matrix(
    n_comp: usize,
    color_mode: &str,
    component: Option<&str>,
) -> Result<(String, ComponentSelection), ApiError> {
    if color_mode == "orientation" {
        if n_comp < 3 {
            return Err(ApiError::bad_request(
                "invalid_query: color_mode=orientation requires n_comp >= 3",
            ));
        }
        return Ok(("orientation".to_string(), ComponentSelection::Full));
    }
    let raw = component.unwrap_or(if n_comp == 1 { "full" } else { "magnitude" });
    let parsed = parse_component(Some(raw), n_comp)?;
    if matches!(parsed, ComponentSelection::Full) && n_comp > 1 {
        return Err(ApiError::bad_request(
            "invalid_query: scalar matrix requires a scalar component, not full",
        ));
    }
    Ok((component_label(&parsed), parsed))
}

async fn build_slice_matrix(
    state: &AppState,
    quantity_id: &str,
    query: &FieldSliceMatrixQuery,
) -> Result<(String, MatrixBuild), ApiError> {
    let mode = slice_matrix_mode(query.mode.as_deref())?;
    let format = matrix_format(query.format.as_deref())?;
    let color_mode = color_mode(query.color_mode.as_deref(), query.component.as_deref())?;
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let spec = quantity_spec(quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);
    let (component_label, component) =
        component_for_matrix(n_comp, color_mode, query.component.as_deref())?;
    let resolved_component = if color_mode == "orientation" {
        "full".to_string()
    } else {
        component_label.clone()
    };
    let mut resolved =
        resolve_slice_query(&slice_query_from_matrix(query, resolved_component), n_comp)?;
    resolved.component = component;

    let field_revision = field_quantity_revision(snapshot, &quantity_id);
    let gen_id: u64 = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|m| m.generation_id.as_deref())
        .and_then(|g| g.parse().ok())
        .unwrap_or(0);
    let fdm_field = extract_fdm_field(snapshot, quantity_id, n_comp)
        .ok_or_else(|| ApiError::not_found(format!("field '{}' not available", quantity_id)))?;
    let fem_field = extract_fem_field(snapshot, quantity_id, n_comp);
    drop(guard);

    let spatial_index = if let Some(fem_field) = fem_field.as_ref() {
        Some(
            get_or_build_fem_spatial_index(state, quantity_id, gen_id, query.plane, fem_field)
                .await,
        )
    } else {
        None
    };
    let result = match mode {
        "exact" => {
            if let Some(fem_field) = fem_field.as_ref() {
                fem_tetra_linear_slice(fem_field, &resolved, spatial_index.as_deref())?
            } else {
                fdm_slice(&fdm_field, &resolved)?
            }
        }
        "slab" => {
            let fem_field = fem_field.as_ref().ok_or_else(|| {
                ApiError::conflict("mode=slab requires a nodal FEM field matching the current mesh")
            })?;
            let aggregation = SlabAggregation::parse(query.aggregation.as_deref())?;
            fem_tetra_slab_slice(
                fem_field,
                &resolved,
                query.thickness_world.unwrap_or(0.0),
                aggregation,
                query.samples.unwrap_or(5),
                spatial_index.as_deref(),
            )?
        }
        _ => unreachable!("slice_matrix_mode only returns exact or slab"),
    };

    let aggregation = if mode == "slab" {
        Some(
            SlabAggregation::parse(query.aggregation.as_deref())?
                .as_str()
                .to_string(),
        )
    } else {
        None
    };
    let extra = format!(
        "cut={}:thickness={}:aggregation={}:samples={}:method={}",
        resolved
            .cut_world
            .map(|value| format!("world:{}", value.to_bits()))
            .unwrap_or_else(|| format!("norm:{}", resolved.cut_norm.to_bits())),
        query
            .thickness_world
            .map(|value| value.to_bits().to_string())
            .unwrap_or_else(|| "none".to_string()),
        aggregation.as_deref().unwrap_or("sample"),
        query.samples.unwrap_or(1),
        result.sampling_method
    );
    let hash = matrix_hash(&matrix_etag_token(
        quantity_id,
        field_revision,
        gen_id,
        query.plane,
        mode,
        &component_label,
        color_mode,
        result.x_size,
        result.y_size,
        &extra,
    ));
    let mut matrix = matrix_response_from_slice(
        quantity_id,
        query.plane,
        mode,
        &component_label,
        color_mode,
        format,
        aggregation,
        if mode == "slab" {
            query.thickness_world
        } else {
            None
        },
        result,
        hash.clone(),
    )?;
    if let Some(fem_field) = fem_field.as_ref() {
        if let Ok(overlay) = collect_fem_slice_overlay(
            FemSliceOverlayInput {
                nodes: &fem_field.nodes,
                elements: &fem_field.elements,
                element_markers: &fem_field.element_markers,
            },
            &resolved,
        ) {
            matrix.mesh_lines = overlay_segments_to_pixel_lines(
                &overlay.segments,
                SliceOverlayBounds {
                    u_min: matrix.response.bounds.u_min,
                    u_max: matrix.response.bounds.u_max,
                    v_min: matrix.response.bounds.v_min,
                    v_max: matrix.response.bounds.v_max,
                },
                matrix.response.x_size,
                matrix.response.y_size,
            );
        }
    }
    Ok((hash, matrix))
}

async fn build_projection_matrix(
    state: &AppState,
    quantity_id: &str,
    query: &FieldProjectionMatrixQuery,
) -> Result<(String, MatrixBuild), ApiError> {
    if query
        .mode
        .as_deref()
        .is_some_and(|mode| mode != "projection")
    {
        return Err(ApiError::bad_request(
            "invalid_query: projection/matrix.json only supports mode=projection",
        ));
    }
    let color_mode = color_mode(query.color_mode.as_deref(), query.component.as_deref())?;
    if color_mode == "orientation" {
        return Err(ApiError::bad_request(
            "invalid_query: projection/matrix.json does not yet support color_mode=orientation",
        ));
    }
    let _ = matrix_format(query.format.as_deref())?;
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let spec = quantity_spec(quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);
    let resolved = resolve_projection_query(&projection_query_from_matrix(query), n_comp)?;
    let field_revision = field_quantity_revision(snapshot, &quantity_id);
    let gen_id: u64 = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|m| m.generation_id.as_deref())
        .and_then(|g| g.parse().ok())
        .unwrap_or(0);
    let fdm_field = extract_fdm_field(snapshot, quantity_id, n_comp)
        .ok_or_else(|| ApiError::not_found(format!("field '{}' not available", quantity_id)))?;
    let fem_field = extract_fem_field(snapshot, quantity_id, n_comp);
    drop(guard);

    let projection = compute_projection(&fdm_field, fem_field.as_ref(), &resolved)?;
    let component = component_label(&resolved.component);
    let extra = format!(
        "reduction={}:samples={}:adaptive={}:method={}",
        resolved.reduction.as_str(),
        resolved.samples,
        u8::from(resolved.adaptive),
        projection.sampling_method
    );
    let hash = matrix_hash(&matrix_etag_token(
        quantity_id,
        field_revision,
        gen_id,
        query.plane,
        "projection",
        &component,
        "scalar",
        projection.x_size,
        projection.y_size,
        &extra,
    ));
    let matrix = matrix_response_from_projection(
        quantity_id,
        query.plane,
        &component,
        resolved.reduction.as_str(),
        projection,
        hash.clone(),
    );
    Ok((hash, matrix))
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
    let field_revision = field_quantity_revision(snapshot, &quantity_id);
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
    let field_revision = field_quantity_revision(snapshot, &quantity_id);
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
    )
    .map_err(ApiError::internal)?;
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
    let field_revision = field_quantity_revision(snapshot, &quantity_id);
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
    let field_revision = field_quantity_revision(snapshot, &quantity_id);
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
    path = "/v2/sessions/current/data/fields/{quantity_id}/samples/slice/matrix.json",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldSliceMatrixQuery,
    ),
    responses(
        (status = 200, description = "Debug JSON 2D slice matrix", body = FieldMatrixResponse),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
        (status = 409, description = "Requested FEM mode requires mesh/field parity"),
    ),
    tag = "data"
)]
pub async fn get_field_slice_matrix_json(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldSliceMatrixQuery>,
) -> Result<axum::response::Response, ApiError> {
    let (etag, matrix) = build_slice_matrix(&state, &quantity_id, &query).await?;
    Ok(
        crate::router_v2::handlers::shared::conditional_json_response(
            &headers,
            &etag,
            &matrix.response,
        ),
    )
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/projection/matrix.json",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldProjectionMatrixQuery,
    ),
    responses(
        (status = 200, description = "Debug JSON 2D projection matrix", body = FieldMatrixResponse),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
    ),
    tag = "data"
)]
pub async fn get_field_projection_matrix_json(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldProjectionMatrixQuery>,
) -> Result<axum::response::Response, ApiError> {
    let (etag, matrix) = build_projection_matrix(&state, &quantity_id, &query).await?;
    Ok(
        crate::router_v2::handlers::shared::conditional_json_response(
            &headers,
            &etag,
            &matrix.response,
        ),
    )
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/samples/slice/render.png",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldRenderPngQuery,
    ),
    responses(
        (status = 200, description = "Diagnostic PNG for a 2D slice", content_type = "image/png"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
        (status = 409, description = "Requested FEM mode requires mesh/field parity"),
    ),
    tag = "data"
)]
pub async fn get_field_slice_render_png(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldRenderPngQuery>,
) -> Result<axum::response::Response, ApiError> {
    let matrix_query = FieldSliceMatrixQuery {
        plane: query.plane,
        component: query.component.clone(),
        color_mode: query.color_mode.clone(),
        cut_world: query.cut_world,
        cut_norm: query.cut_norm,
        mode: query.mode.clone(),
        thickness_world: query.thickness_world,
        aggregation: query.aggregation.clone(),
        x_size: query.x_size,
        y_size: query.y_size,
        max_points: query.max_points,
        samples: query.samples,
        format: Some("both".to_string()),
    };
    let (matrix_etag, matrix) = build_slice_matrix(&state, &quantity_id, &matrix_query).await?;
    let png = encode_png_from_matrix(&matrix, &query)?;
    let render_etag = matrix_hash(&format!(
        "render:{}:colormap={}:auto={}:vmin={}:vmax={}:alpha={}:mesh={}:arrows={}",
        matrix_etag,
        query.colormap.as_deref().unwrap_or("viridis"),
        query.auto_scale.as_deref().unwrap_or("slice"),
        query
            .vmin
            .map_or_else(|| "none".to_string(), |value| value.to_bits().to_string()),
        query
            .vmax
            .map_or_else(|| "none".to_string(), |value| value.to_bits().to_string()),
        u8::from(query.alpha_mask.unwrap_or(true)),
        u8::from(query.show_mesh.unwrap_or(false)),
        u8::from(query.show_arrows.unwrap_or(false)),
    ));
    let mut response =
        crate::router_v2::handlers::shared::conditional_binary_response_with_content_type(
            &headers,
            &render_etag,
            png,
            HeaderValue::from_static("image/png"),
        );
    insert_matrix_headers(
        &mut response,
        &matrix_etag,
        &matrix.response.sampling_method,
    );
    Ok(response)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/projection/render.png",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldRenderPngQuery,
    ),
    responses(
        (status = 200, description = "Diagnostic PNG for a 2D projection", content_type = "image/png"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
    ),
    tag = "data"
)]
pub async fn get_field_projection_render_png(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldRenderPngQuery>,
) -> Result<axum::response::Response, ApiError> {
    let matrix_query = FieldProjectionMatrixQuery {
        plane: query.plane,
        component: query.component.clone(),
        color_mode: query.color_mode.clone(),
        mode: query
            .mode
            .clone()
            .or_else(|| Some("projection".to_string())),
        aggregation: query.aggregation.clone(),
        reduction: query.reduction.clone(),
        include_air_as_zero: query.include_air_as_zero,
        samples: query.samples,
        adaptive: query.adaptive,
        error_tolerance: query.error_tolerance,
        min_samples: query.min_samples,
        x_size: query.x_size,
        y_size: query.y_size,
        max_points: query.max_points,
        format: Some("values".to_string()),
    };
    let (matrix_etag, matrix) =
        build_projection_matrix(&state, &quantity_id, &matrix_query).await?;
    let png = encode_png_from_matrix(&matrix, &query)?;
    let render_etag = matrix_hash(&format!(
        "render:{}:colormap={}:auto={}:vmin={}:vmax={}:alpha={}:mesh={}:arrows={}",
        matrix_etag,
        query.colormap.as_deref().unwrap_or("viridis"),
        query.auto_scale.as_deref().unwrap_or("slice"),
        query
            .vmin
            .map_or_else(|| "none".to_string(), |value| value.to_bits().to_string()),
        query
            .vmax
            .map_or_else(|| "none".to_string(), |value| value.to_bits().to_string()),
        u8::from(query.alpha_mask.unwrap_or(true)),
        u8::from(query.show_mesh.unwrap_or(false)),
        u8::from(query.show_arrows.unwrap_or(false)),
    ));
    let mut response =
        crate::router_v2::handlers::shared::conditional_binary_response_with_content_type(
            &headers,
            &render_etag,
            png,
            HeaderValue::from_static("image/png"),
        );
    insert_matrix_headers(
        &mut response,
        &matrix_etag,
        &matrix.response.sampling_method,
    );
    Ok(response)
}

fn encode_png_from_matrix(
    matrix: &MatrixBuild,
    query: &FieldRenderPngQuery,
) -> Result<Vec<u8>, ApiError> {
    let mesh_lines: &[[f64; 4]] = if query.show_mesh.unwrap_or(false) {
        &matrix.mesh_lines
    } else {
        &[]
    };
    if let Some(rgba) = matrix.rgba_pixels.as_ref() {
        if mesh_lines.is_empty() {
            return encode_rgba_matrix_png(
                matrix.response.x_size,
                matrix.response.y_size,
                rgba,
                &matrix.mask_flat,
                query.alpha_mask.unwrap_or(true),
            );
        }
        return encode_rgba_matrix_png_with_lines(
            matrix.response.x_size,
            matrix.response.y_size,
            rgba,
            &matrix.mask_flat,
            query.alpha_mask.unwrap_or(true),
            mesh_lines,
        );
    }
    let values = matrix.scalar_values.as_ref().ok_or_else(|| {
        ApiError::internal("render_png: scalar matrix values missing for PNG render")
    })?;
    if mesh_lines.is_empty() {
        return encode_scalar_png(
            matrix.response.x_size,
            matrix.response.y_size,
            values,
            &matrix.mask_flat,
            query.colormap.as_deref().unwrap_or("viridis"),
            AutoScaleMode::parse(query.auto_scale.as_deref())?,
            query.vmin,
            query.vmax,
            query.alpha_mask.unwrap_or(true),
        );
    }
    encode_scalar_png_with_lines(
        matrix.response.x_size,
        matrix.response.y_size,
        values,
        &matrix.mask_flat,
        query.colormap.as_deref().unwrap_or("viridis"),
        AutoScaleMode::parse(query.auto_scale.as_deref())?,
        query.vmin,
        query.vmax,
        query.alpha_mask.unwrap_or(true),
        mesh_lines,
    )
}

fn insert_matrix_headers(
    response: &mut axum::response::Response,
    matrix_hash: &str,
    sampling_method: &str,
) {
    if let Ok(value) = HeaderValue::from_str(matrix_hash) {
        response
            .headers_mut()
            .insert(HeaderName::from_static("x-fullmag-matrix-hash"), value);
    }
    if let Ok(value) = HeaderValue::from_str(sampling_method) {
        response
            .headers_mut()
            .insert(HeaderName::from_static("x-fullmag-sampling-method"), value);
    }
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

    let field_revision = field_quantity_revision(snapshot, &quantity_id);
    let gen_id_str = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|mesh| mesh.generation_id.as_deref())
        .unwrap_or("0");
    let gen_id: u64 = gen_id_str.parse().unwrap_or(0);

    let fdm_field = extract_fdm_field(snapshot, &quantity_id, n_comp)
        .ok_or_else(|| ApiError::not_found(format!("field '{}' not available", quantity_id)))?;
    let fem_field = extract_fem_field(snapshot, &quantity_id, n_comp);

    drop(guard);
    let spatial_index = if let Some(fem_field) = fem_field.as_ref() {
        Some(
            get_or_build_fem_spatial_index(&state, &quantity_id, gen_id, resolved.plane, fem_field)
                .await,
        )
    } else {
        None
    };

    // Perform slice outside lock
    let slice_result = if let Some(fem_field) = fem_field.as_ref() {
        fem_tetra_linear_slice(fem_field, &resolved, spatial_index.as_deref())?
    } else if is_fem {
        fem_slice_fallback(&fdm_field, &resolved)?
    } else {
        fdm_slice(&fdm_field, &resolved)?
    };
    let response_cut_norm = cut_norm_from_world(
        slice_result.cut_world,
        fem_field
            .as_ref()
            .and_then(|field| fem_normal_bounds_from_nodes(&field.nodes, resolved.plane))
            .or_else(|| fdm_normal_bounds(&fdm_field, resolved.plane)),
        resolved.cut_norm,
    );

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
    let cut_param = if query.cut_world.is_some() {
        resolved
            .cut_world
            .map(|value| format!("cut_world={value}"))
            .unwrap_or_else(|| format!("cut_norm={response_cut_norm:.6}"))
    } else {
        format!("cut_norm={response_cut_norm:.6}")
    };
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
        cut_norm: response_cut_norm,
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
    let field_revision = field_quantity_revision(snapshot, &quantity_id);
    let gen_id: u64 = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|m| m.generation_id.as_deref())
        .and_then(|g| g.parse().ok())
        .unwrap_or(0);

    let fdm_field = extract_fdm_field(snapshot, &quantity_id, n_comp)
        .ok_or_else(|| ApiError::not_found(format!("field '{}' not available", quantity_id)))?;
    let fem_field = extract_fem_field(snapshot, &quantity_id, n_comp);

    let component = component_label(&resolved.component);
    let cache_key = slice_cache_key(
        &quantity_id,
        field_revision,
        gen_id,
        resolved.plane.as_str(),
        &slice_cut_cache_key(&resolved),
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
    let spatial_index = if let Some(fem_field) = fem_field.as_ref() {
        Some(
            get_or_build_fem_spatial_index(&state, &quantity_id, gen_id, resolved.plane, fem_field)
                .await,
        )
    } else {
        None
    };

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

    let slice_result = if let Some(fem_field) = fem_field.as_ref() {
        fem_tetra_linear_slice(fem_field, &resolved, spatial_index.as_deref())?
    } else if is_fem {
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
    )
    .map_err(ApiError::internal)?;

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
    let field_revision = field_quantity_revision(snapshot, &quantity_id);
    let gen_id: u64 = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|m| m.generation_id.as_deref())
        .and_then(|g| g.parse().ok())
        .unwrap_or(0);

    let fdm_field = extract_fdm_field(snapshot, &quantity_id, n_comp)
        .ok_or_else(|| ApiError::not_found(format!("field '{}' not available", quantity_id)))?;
    let fem_field = extract_fem_field(snapshot, &quantity_id, n_comp);

    let cache_key = slice_cache_key(
        &quantity_id,
        field_revision,
        gen_id,
        resolved.plane.as_str(),
        &slice_cut_cache_key(&resolved),
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
    let spatial_index = if let Some(fem_field) = fem_field.as_ref() {
        Some(
            get_or_build_fem_spatial_index(&state, &quantity_id, gen_id, resolved.plane, fem_field)
                .await,
        )
    } else {
        None
    };

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

    let slice_result = if let Some(fem_field) = fem_field.as_ref() {
        fem_tetra_linear_slice(fem_field, &resolved, spatial_index.as_deref())?
    } else if is_fem {
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
    )
    .map_err(ApiError::internal)?;

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
