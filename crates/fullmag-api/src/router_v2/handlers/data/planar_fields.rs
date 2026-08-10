use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, Response, StatusCode},
    response::IntoResponse,
    Json,
};
use fullmag_ir::{MonitorTargetIR, PlanarExtentIR, PlanarMonitorIR, PlanarOperatorIR};
use sha2::{Digest, Sha256};

use super::fdm_region_membership::load_resolved_fdm_membership;
use super::field_resolution::{extract_fdm_field, extract_fem_field};
use crate::{
    error::ApiError,
    field_render_png::{encode_scalar_png, AutoScaleMode},
    field_store::serialize_field_vector_binary_v2,
    planar_sampling::{
        FdmPlanarField, FemPlanarField, Occupancy, PlanarComponent, PlanarSampleResult,
        PlanarSamplingEngine, ResolvedPlanarSampleRequest, MAX_PLANAR_SAMPLE_POINTS,
    },
    preview::quantity_unit,
    router_v2::handlers::{
        data::fields::{
            persisted_hysteresis_magnetization_values, validate_hysteresis_snapshot_stage_scope,
        },
        sessions::status::{domain_generation_id, field_quantity_revision},
    },
    schemas::{
        PlanarFieldFrameResource, PlanarFieldLinksResource, PlanarFieldMetaResource,
        PlanarFieldOccupancyResource, PlanarFieldProbeQuery, PlanarFieldProbeResource,
        PlanarFieldQuery,
    },
    types::AppState,
};

const DEFAULT_RESOLUTION: u32 = 128;
const MIN_RESOLUTION: u32 = 16;
const MAX_RESOLUTION: u32 = 2048;

struct BuiltPlanarField {
    result: Arc<PlanarSampleResult>,
    monitor: PlanarMonitorIR,
    scene_revision: u64,
    quantity_id: String,
    component: String,
    field_revision: u64,
    mesh_revision: u64,
    generation_id: String,
    field_source: String,
    source_entity_kind: &'static str,
    scope_kind: String,
    scope_id: Option<String>,
    etag: String,
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/meta",
    params(("quantity_id" = String, Path), ("monitor_id" = String, Path), PlanarFieldQuery),
    responses((status = 200, body = PlanarFieldMetaResource), (status = 404, description = "Field or monitor missing"), (status = 409, description = "Stale source"), (status = 422, description = "Unsupported planar sampling")),
    tag = "data"
)]
pub async fn get_planar_field_meta(
    State(state): State<Arc<AppState>>,
    Path((quantity_id, monitor_id)): Path<(String, String)>,
    Query(query): Query<PlanarFieldQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiError> {
    let built = build_planar_field(&state, &quantity_id, &monitor_id, &query).await?;
    if etag_matches(&headers, &built.etag) {
        return not_modified(&built.etag);
    }
    let meta = meta_resource(&built);
    json_response(&meta, &built.etag)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/scalar",
    params(("quantity_id" = String, Path), ("monitor_id" = String, Path), PlanarFieldQuery),
    responses((status = 200, description = "FMVP v2 scalar raster"), (status = 304, description = "Not modified")),
    tag = "data"
)]
pub async fn get_planar_field_scalar(
    State(state): State<Arc<AppState>>,
    Path((quantity_id, monitor_id)): Path<(String, String)>,
    Query(query): Query<PlanarFieldQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiError> {
    let built = build_planar_field(&state, &quantity_id, &monitor_id, &query).await?;
    if etag_matches(&headers, &built.etag) {
        return not_modified(&built.etag);
    }
    let values = finite_payload(&built.result.scalar_values);
    let bytes = serialize_field_vector_binary_v2(
        &quantity_id,
        1,
        [
            built.result.meta.resolution[0],
            built.result.meta.resolution[1],
            1,
        ],
        &values,
    )
    .map_err(ApiError::internal)?;
    binary_response(bytes, "application/vnd.fullmag.field-vector", &built.etag)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/vectors",
    params(("quantity_id" = String, Path), ("monitor_id" = String, Path), PlanarFieldQuery),
    responses((status = 200, description = "FMVP v2 vector raster"), (status = 422, description = "Quantity is not vector-valued")),
    tag = "data"
)]
pub async fn get_planar_field_vectors(
    State(state): State<Arc<AppState>>,
    Path((quantity_id, monitor_id)): Path<(String, String)>,
    Query(query): Query<PlanarFieldQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiError> {
    let built = build_planar_field(&state, &quantity_id, &monitor_id, &query).await?;
    if etag_matches(&headers, &built.etag) {
        return not_modified(&built.etag);
    }
    let vectors =
        built.result.vector_values.as_ref().ok_or_else(|| {
            ApiError::unprocessable("planar_vector_unsupported: quantity is scalar")
        })?;
    let values = vectors
        .iter()
        .flat_map(|vector| {
            vector
                .iter()
                .map(|value| if value.is_finite() { *value } else { 0.0 })
        })
        .collect::<Vec<_>>();
    let bytes = serialize_field_vector_binary_v2(
        &quantity_id,
        3,
        [
            built.result.meta.resolution[0],
            built.result.meta.resolution[1],
            1,
        ],
        &values,
    )
    .map_err(ApiError::internal)?;
    binary_response(bytes, "application/vnd.fullmag.field-vector", &built.etag)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/empty-mask",
    params(("quantity_id" = String, Path), ("monitor_id" = String, Path), PlanarFieldQuery),
    responses((status = 200, description = "One occupancy byte per pixel")),
    tag = "data"
)]
pub async fn get_planar_field_empty_mask(
    State(state): State<Arc<AppState>>,
    Path((quantity_id, monitor_id)): Path<(String, String)>,
    Query(query): Query<PlanarFieldQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiError> {
    let built = build_planar_field(&state, &quantity_id, &monitor_id, &query).await?;
    if etag_matches(&headers, &built.etag) {
        return not_modified(&built.etag);
    }
    let bytes = built
        .result
        .occupancy
        .iter()
        .map(|occupancy| *occupancy as u8)
        .collect();
    binary_response(bytes, "application/octet-stream", &built.etag)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/probe",
    params(("quantity_id" = String, Path), ("monitor_id" = String, Path), PlanarFieldProbeQuery),
    responses((status = 200, body = PlanarFieldProbeResource)),
    tag = "data"
)]
pub async fn get_planar_field_probe(
    State(state): State<Arc<AppState>>,
    Path((quantity_id, monitor_id)): Path<(String, String)>,
    Query(probe): Query<PlanarFieldProbeQuery>,
) -> Result<Json<PlanarFieldProbeResource>, ApiError> {
    if !probe.u_m.is_finite() || !probe.v_m.is_finite() {
        return Err(ApiError::bad_request(
            "invalid_planar_probe: coordinates must be finite",
        ));
    }
    let query = PlanarFieldQuery {
        component: probe.component,
        scope_kind: probe.scope_kind,
        scope_id: probe.scope_id,
        stage_id: probe.stage_id,
        snapshot_id: probe.snapshot_id,
        resolution_x: probe.resolution_x,
        resolution_y: probe.resolution_y,
        quality: None,
        vector_budget: Some(0),
        include_mesh: Some(false),
        expected_monitor_revision: probe.expected_monitor_revision,
        expected_mesh_revision: probe.expected_mesh_revision,
        expected_field_revision: probe.expected_field_revision,
    };
    let built = build_planar_field(&state, &quantity_id, &monitor_id, &query).await?;
    let bounds = built.result.meta.bounds_uv_m;
    let x = (((probe.u_m - bounds[0]) / (bounds[1] - bounds[0])
        * built.result.meta.resolution[0] as f64)
        .floor() as i64)
        .clamp(0, built.result.meta.resolution[0] as i64 - 1) as u32;
    let y = (((probe.v_m - bounds[2]) / (bounds[3] - bounds[2])
        * built.result.meta.resolution[1] as f64)
        .floor() as i64)
        .clamp(0, built.result.meta.resolution[1] as i64 - 1) as u32;
    let index = (y * built.result.meta.resolution[0] + x) as usize;
    let occupancy = built.result.occupancy[index];
    let source_entity_id = built.result.source_entity_ids[index];
    let frame = &built.monitor.frame;
    let world_m = [
        frame.origin_m[0] + probe.u_m * frame.u_axis[0] + probe.v_m * frame.v_axis[0],
        frame.origin_m[1] + probe.u_m * frame.u_axis[1] + probe.v_m * frame.v_axis[1],
        frame.origin_m[2] + probe.u_m * frame.u_axis[2] + probe.v_m * frame.v_axis[2],
    ];
    Ok(Json(PlanarFieldProbeResource {
        monitor_id,
        quantity_id,
        u_m: probe.u_m,
        v_m: probe.v_m,
        world_m,
        scalar: built.result.scalar_values[index]
            .is_finite()
            .then_some(built.result.scalar_values[index]),
        vector: built
            .result
            .vector_values
            .as_ref()
            .map(|vectors| vectors[index])
            .filter(|vector| vector.iter().all(|value| value.is_finite())),
        cell_id: (built.source_entity_kind == "cell")
            .then_some(source_entity_id)
            .flatten(),
        element_id: (built.source_entity_kind == "element")
            .then_some(source_entity_id)
            .flatten(),
        occupancy: occupancy_label(occupancy).to_string(),
        sampling_method: built.result.meta.sampling_method.to_string(),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/render.png",
    params(("quantity_id" = String, Path), ("monitor_id" = String, Path), PlanarFieldQuery),
    responses((status = 200, description = "PNG export")),
    tag = "data"
)]
pub async fn get_planar_field_render_png(
    State(state): State<Arc<AppState>>,
    Path((quantity_id, monitor_id)): Path<(String, String)>,
    Query(query): Query<PlanarFieldQuery>,
) -> Result<Response<Body>, ApiError> {
    let built = build_planar_field(&state, &quantity_id, &monitor_id, &query).await?;
    let mask = built
        .result
        .occupancy
        .iter()
        .map(|occupancy| u8::from(*occupancy == Occupancy::Empty))
        .collect::<Vec<_>>();
    let png = encode_scalar_png(
        built.result.meta.resolution[0],
        built.result.meta.resolution[1],
        &built.result.scalar_values,
        &mask,
        "viridis",
        AutoScaleMode::Slice,
        None,
        None,
        true,
    )?;
    binary_response(png, "image/png", &built.etag)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/mesh-overlay",
    params(("quantity_id" = String, Path), ("monitor_id" = String, Path), PlanarFieldQuery),
    responses((status = 200, description = "FMCS v3 planar mesh overlay"), (status = 204, description = "Structured grid has no FEM overlay")),
    tag = "data"
)]
pub async fn get_planar_field_mesh_overlay(
    State(state): State<Arc<AppState>>,
    Path((quantity_id, monitor_id)): Path<(String, String)>,
    Query(query): Query<PlanarFieldQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiError> {
    let built = build_planar_field(&state, &quantity_id, &monitor_id, &query).await?;
    let Some(overlay) = built.result.overlay.as_ref() else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    if etag_matches(&headers, &built.etag) {
        return not_modified(&built.etag);
    }
    let bytes = crate::fem_cross_section::serialize_planar_overlay_fmcs_v3(overlay);
    binary_response(bytes, "application/octet-stream", &built.etag)
}

async fn build_planar_field(
    state: &Arc<AppState>,
    quantity_id: &str,
    monitor_id: &str,
    query: &PlanarFieldQuery,
) -> Result<BuiltPlanarField, ApiError> {
    let resolution = resolve_resolution(query)?;
    validate_auxiliary_query(query)?;
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let scene = snapshot
        .scene_document
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no canonical scene document"))?;
    let mut monitor = scene
        .monitors
        .planar
        .iter()
        .find(|monitor| monitor.id == monitor_id)
        .cloned()
        .ok_or_else(|| ApiError::not_found(format!("planar monitor not found: {monitor_id}")))?;
    let spec = fullmag_quantities::quantity_spec(quantity_id)
        .ok_or_else(|| ApiError::not_found(format!("quantity not found: {quantity_id}")))?;
    let n_comp = spec.n_comp as usize;
    let field_revision = field_quantity_revision(snapshot, quantity_id);
    let generation_id = domain_generation_id(snapshot);
    let mesh_revision = snapshot.mesh_revision;
    validate_expected_revisions(query, scene.revision, mesh_revision, field_revision)?;
    validate_scope(snapshot, query)?;

    let snapshot_values = if let Some(snapshot_id) = query.snapshot_id.as_deref() {
        let stage_id = query.stage_id.as_deref().ok_or_else(|| {
            ApiError::bad_request("snapshot_requires_stage: snapshot_id requires stage_id")
        })?;
        if quantity_id != "m" {
            return Err(ApiError::unprocessable(
                "snapshot_quantity_unsupported: persisted snapshots currently publish m",
            ));
        }
        validate_hysteresis_snapshot_stage_scope(state, Some(stage_id), snapshot_id).await?;
        Some(persisted_hysteresis_magnetization_values(
            snapshot,
            snapshot_id,
        )?)
    } else {
        None
    };
    let mut fdm = if let Some((values, grid)) = snapshot_values {
        Some(crate::field_slice::FdmField {
            n_comp,
            grid,
            values,
            origin: None,
            spacing: None,
            active_mask: None,
        })
    } else {
        extract_fdm_field(snapshot, quantity_id, n_comp)
    };
    let mut fem = if query.snapshot_id.is_none() {
        extract_fem_field(snapshot, quantity_id, n_comp)
    } else {
        None
    };
    apply_resolved_scope(snapshot, &monitor.target, query, &mut fdm, &mut fem)?;
    resolve_dynamic_extent(&mut monitor, fdm.as_ref(), fem.as_ref())?;
    let scene_revision = scene.revision;
    let field_source = query
        .snapshot_id
        .as_ref()
        .map(|snapshot| format!("stage_snapshot:{snapshot}"))
        .unwrap_or_else(|| "live".to_string());
    drop(guard);

    let monitor_hash = monitor_hash(&monitor)?;
    let component = resolve_component(query.component.as_deref(), n_comp)?;
    let request = ResolvedPlanarSampleRequest {
        monitor_id: monitor.id.clone(),
        monitor_hash: monitor_hash.clone(),
        frame: monitor.frame.clone(),
        operator: monitor.operator.clone(),
        resolution,
        component,
    };
    let source_entity_kind = if fem.is_some() { "element" } else { "cell" };
    let scope_kind = query
        .scope_kind
        .clone()
        .unwrap_or_else(|| "monitor_target".to_string());
    let component_label = query.component.clone().unwrap_or_else(|| {
        if n_comp == 1 {
            "scalar".to_string()
        } else {
            "magnitude".to_string()
        }
    });
    let sample_cache_identity = serde_json::json!({
        "schema": "planar-sample-cache-v1",
        "monitor_hash": monitor_hash,
        "quantity_id": quantity_id,
        "component": component_label,
        "resolution": resolution,
        "field_revision": field_revision,
        "mesh_revision": mesh_revision,
        "generation_id": generation_id,
        "field_source": field_source,
        "scope_kind": scope_kind,
        "scope_id": query.scope_id,
    });
    let sample_cache_key = format!(
        "planar-sample:{:x}",
        Sha256::digest(sample_cache_identity.to_string().as_bytes())
    );
    let mut sample_cache = state.quantity_data_plane.planar_sample_cache.lock().await;
    let result = if let Some(cached) = sample_cache.get(&sample_cache_key) {
        cached
    } else {
        let sampled = if let Some(fem) = fem {
            let source = FemPlanarField::new(
                fem.n_comp,
                fem.nodes,
                fem.elements,
                fem.element_markers,
                fem.values,
            )?;
            PlanarSamplingEngine::sample_fem(&source, &request)?
        } else if let Some(fdm) = fdm {
            let mut source = FdmPlanarField::new(
                fdm.n_comp,
                fdm.grid,
                fdm.origin.unwrap_or([-0.5; 3]),
                fdm.spacing.unwrap_or([1.0; 3]),
                fdm.values,
            )?;
            if let Some(active_mask) = fdm.active_mask {
                source = source.with_membership_mask(active_mask)?;
            }
            PlanarSamplingEngine::sample_fdm(&source, &request)?
        } else {
            return Err(ApiError::not_found(format!(
                "quantity_not_materialized: field '{quantity_id}' is not published"
            )));
        };
        let sampled = Arc::new(sampled);
        sample_cache.insert(sample_cache_key, Arc::clone(&sampled));
        sampled
    };
    drop(sample_cache);
    let etag_identity = serde_json::json!({
        "schema": "planar-field-cache-v1",
        "monitor_hash": monitor_hash,
        "quantity_id": quantity_id,
        "component": component_label,
        "operator": monitor.operator,
        "resolution": resolution,
        "field_revision": field_revision,
        "mesh_revision": mesh_revision,
        "generation_id": generation_id,
        "field_source": field_source,
        "scope_kind": scope_kind,
        "scope_id": query.scope_id,
        "quality": query.quality,
        "vector_budget": query.vector_budget,
        "include_mesh": query.include_mesh,
        "sampler_version": result.meta.sampler_version,
    });
    let etag = format!(
        "\"fm-planar-sha256:{:x}\"",
        Sha256::digest(etag_identity.to_string().as_bytes())
    );
    Ok(BuiltPlanarField {
        result,
        monitor,
        scene_revision,
        quantity_id: quantity_id.to_string(),
        component: component_label,
        field_revision,
        mesh_revision,
        generation_id,
        field_source,
        source_entity_kind,
        scope_kind,
        scope_id: query.scope_id.clone(),
        etag,
    })
}

fn resolve_resolution(query: &PlanarFieldQuery) -> Result<[u32; 2], ApiError> {
    let x = query.resolution_x.unwrap_or(DEFAULT_RESOLUTION);
    let y = query.resolution_y.unwrap_or(DEFAULT_RESOLUTION);
    if !(MIN_RESOLUTION..=MAX_RESOLUTION).contains(&x)
        || !(MIN_RESOLUTION..=MAX_RESOLUTION).contains(&y)
        || x.saturating_mul(y) > MAX_PLANAR_SAMPLE_POINTS
    {
        return Err(ApiError::bad_request(
            "invalid_planar_resolution: dimensions must be 16..2048 and at most 1048576 points",
        ));
    }
    Ok([x, y])
}

fn validate_auxiliary_query(query: &PlanarFieldQuery) -> Result<(), ApiError> {
    if query.snapshot_id.is_some() && query.stage_id.is_none() {
        return Err(ApiError::bad_request(
            "snapshot_requires_stage: snapshot_id requires stage_id",
        ));
    }
    if !matches!(
        query.quality.as_deref(),
        None | Some("interactive") | Some("export")
    ) {
        return Err(ApiError::bad_request("invalid_planar_quality"));
    }
    if query.vector_budget.unwrap_or(0) > 10_000 {
        return Err(ApiError::bad_request(
            "invalid_vector_budget: maximum is 10000",
        ));
    }
    Ok(())
}

fn validate_expected_revisions(
    query: &PlanarFieldQuery,
    monitor_revision: u64,
    mesh_revision: u64,
    field_revision: u64,
) -> Result<(), ApiError> {
    for (kind, expected, current) in [
        ("monitor", query.expected_monitor_revision, monitor_revision),
        ("mesh", query.expected_mesh_revision, mesh_revision),
        ("field", query.expected_field_revision, field_revision),
    ] {
        if expected.is_some_and(|expected| expected != current) {
            return Err(ApiError::conflict(format!(
                "stale_{kind}_revision: expected {}, current {current}",
                expected.expect("checked expected revision")
            )));
        }
    }
    Ok(())
}

fn validate_scope(
    snapshot: &crate::types::SessionStateResponse,
    query: &PlanarFieldQuery,
) -> Result<(), ApiError> {
    match query.scope_kind.as_deref().unwrap_or("monitor_target") {
        "monitor_target" => {
            if query.scope_id.is_some() {
                return Err(ApiError::bad_request(
                    "invalid_planar_scope: monitor_target does not accept scope_id",
                ));
            }
        }
        "mesh_part" => {
            let scope_id = query.scope_id.as_deref().ok_or_else(|| {
                ApiError::bad_request("invalid_planar_scope: mesh_part requires scope_id")
            })?;
            let exists = snapshot
                .fem_mesh
                .as_ref()
                .is_some_and(|mesh| mesh.mesh_parts.iter().any(|part| part.id == scope_id));
            if !exists {
                return Err(ApiError::conflict(format!(
                    "stale_mesh_scope: mesh part '{scope_id}' is absent from the current mesh revision"
                )));
            }
        }
        "airbox" => {
            if query.scope_id.is_some() {
                return Err(ApiError::bad_request(
                    "invalid_planar_scope: airbox does not accept scope_id",
                ));
            }
        }
        other => {
            return Err(ApiError::bad_request(format!(
                "invalid_planar_scope: unsupported scope_kind '{other}'"
            )))
        }
    }
    Ok(())
}

fn apply_resolved_scope(
    snapshot: &crate::types::SessionStateResponse,
    target: &MonitorTargetIR,
    query: &PlanarFieldQuery,
    fdm: &mut Option<crate::field_slice::FdmField>,
    fem: &mut Option<crate::field_slice::FemField>,
) -> Result<(), ApiError> {
    let scope_kind = query.scope_kind.as_deref().unwrap_or("monitor_target");
    if fem.is_none() {
        if scope_kind != "monitor_target" {
            return Err(ApiError::unprocessable(
                "planar_scope_unsupported: structured-grid runtime does not publish mesh-part or airbox membership",
            ));
        }
        if matches!(target, MonitorTargetIR::Domain) {
            return Ok(());
        }
        let field = fdm
            .as_mut()
            .ok_or_else(|| ApiError::not_found("quantity_not_materialized"))?;
        let membership = load_resolved_fdm_membership(snapshot)?;
        if membership.counts != field.grid
            || membership.cell_membership.len()
                != field
                    .grid
                    .iter()
                    .map(|count| *count as usize)
                    .product::<usize>()
        {
            return Err(ApiError::conflict(
                "stale_fdm_membership: membership grid does not match the published field",
            ));
        }
        let selected = match target {
            MonitorTargetIR::MagneticDomain => membership
                .cell_membership
                .iter()
                .map(|value| *value != u32::MAX)
                .collect::<Vec<_>>(),
            MonitorTargetIR::Object { object_id } => {
                if !membership.object_ids.iter().any(|id| id == object_id) {
                    return Err(ApiError::conflict(format!(
                        "stale_fdm_membership: object '{object_id}' is absent from the realized grid"
                    )));
                }
                membership
                    .cell_membership
                    .iter()
                    .map(|value| *value != u32::MAX)
                    .collect::<Vec<_>>()
            }
            MonitorTargetIR::Region {
                object_id,
                region_id,
            } => {
                let numeric_id = membership
                    .region_legend
                    .iter()
                    .find(|entry| {
                        entry.object_id == *object_id && entry.region_id == *region_id
                    })
                    .map(|entry| entry.numeric_id)
                    .ok_or_else(|| {
                        ApiError::conflict(format!(
                            "stale_fdm_membership: region '{object_id}/{region_id}' is absent from the realized grid"
                        ))
                    })?;
                membership
                    .cell_membership
                    .iter()
                    .map(|value| *value == numeric_id)
                    .collect::<Vec<_>>()
            }
            MonitorTargetIR::Domain => unreachable!("domain target returned above"),
        };
        if !selected.iter().any(|selected| *selected) {
            return Err(ApiError::unprocessable(
                "planar_scope_empty: resolved FDM monitor target has no active cells",
            ));
        }
        field.origin = Some(membership.origin_m);
        field.spacing = Some(membership.cell_m);
        field.active_mask = Some(selected);
        return Ok(());
    }

    let mesh = snapshot
        .fem_mesh
        .as_ref()
        .ok_or_else(|| ApiError::conflict("stale_mesh_scope: FEM field has no current mesh"))?;
    let field = fem.as_mut().expect("checked FEM field");
    let mut selected = vec![false; field.elements.len()];
    match target {
        MonitorTargetIR::MagneticDomain => {
            for (index, marker) in field.element_markers.iter().enumerate() {
                selected[index] = *marker != 0;
            }
        }
        MonitorTargetIR::Domain => selected.fill(true),
        MonitorTargetIR::Object { object_id } => {
            select_mesh_parts(mesh, &mut selected, |part| {
                part.object_id.as_deref() == Some(object_id.as_str())
            });
        }
        MonitorTargetIR::Region {
            object_id,
            region_id,
        } => {
            select_mesh_parts(mesh, &mut selected, |part| {
                part.object_id.as_deref() == Some(object_id.as_str())
                    && (part.id == *region_id
                        || part.geometry_id.as_deref() == Some(region_id.as_str()))
            });
        }
    }

    match scope_kind {
        "monitor_target" => {}
        "mesh_part" => {
            let scope_id = query.scope_id.as_deref().expect("validated mesh-part id");
            let mut runtime_scope = vec![false; selected.len()];
            select_mesh_parts(mesh, &mut runtime_scope, |part| part.id == scope_id);
            for (selected, runtime) in selected.iter_mut().zip(runtime_scope) {
                *selected &= runtime;
            }
        }
        "airbox" => {
            let mut runtime_scope = vec![false; selected.len()];
            select_mesh_parts(mesh, &mut runtime_scope, |part| {
                part.role.contains("air") || part.id.contains("airbox")
            });
            for (selected, runtime) in selected.iter_mut().zip(runtime_scope) {
                *selected &= runtime;
            }
        }
        _ => unreachable!("scope validated before resolution"),
    }
    if !selected.iter().any(|selected| *selected) {
        return Err(ApiError::unprocessable(
            "planar_scope_empty: resolved monitor target and runtime scope do not overlap",
        ));
    }
    field.element_markers = selected.into_iter().map(u32::from).collect();
    *fdm = None;
    Ok(())
}

fn select_mesh_parts(
    mesh: &fullmag_runner::FemMeshPayload,
    selected: &mut [bool],
    predicate: impl Fn(&fullmag_runner::FemMeshPartPayload) -> bool,
) {
    let selected_len = selected.len();
    for part in mesh.mesh_parts.iter().filter(|part| predicate(part)) {
        let start = part.element_start as usize;
        let end = start
            .saturating_add(part.element_count as usize)
            .min(selected_len);
        selected[start.min(selected_len)..end].fill(true);
    }
}

fn resolve_dynamic_extent(
    monitor: &mut PlanarMonitorIR,
    fdm: Option<&crate::field_slice::FdmField>,
    fem: Option<&crate::field_slice::FemField>,
) -> Result<(), ApiError> {
    let padding = match monitor.frame.extent {
        PlanarExtentIR::Explicit { .. } => return Ok(()),
        PlanarExtentIR::TargetBounds { padding_m }
        | PlanarExtentIR::MagneticDomain { padding_m }
        | PlanarExtentIR::Universe { padding_m } => padding_m,
    };
    let points = if let Some(fem) = fem {
        fem.nodes.clone()
    } else if let Some(fdm) = fdm {
        let origin = fdm.origin.unwrap_or([-0.5; 3]);
        let spacing = fdm.spacing.unwrap_or([1.0; 3]);
        let mut low_cell = [0u32; 3];
        let mut high_cell = fdm.grid;
        if let Some(active_mask) = fdm.active_mask.as_ref() {
            low_cell = fdm.grid;
            high_cell = [0; 3];
            for (cell, selected) in active_mask.iter().enumerate() {
                if !selected {
                    continue;
                }
                let x = cell as u32 % fdm.grid[0];
                let yz = cell as u32 / fdm.grid[0];
                let y = yz % fdm.grid[1];
                let z = yz / fdm.grid[1];
                for (axis, coordinate) in [x, y, z].into_iter().enumerate() {
                    low_cell[axis] = low_cell[axis].min(coordinate);
                    high_cell[axis] = high_cell[axis].max(coordinate + 1);
                }
            }
        }
        let low = [0, 1, 2].map(|axis| origin[axis] + spacing[axis] * low_cell[axis] as f64);
        let high = [0, 1, 2].map(|axis| origin[axis] + spacing[axis] * high_cell[axis] as f64);
        let mut corners = Vec::with_capacity(8);
        for z in [low[2], high[2]] {
            for y in [low[1], high[1]] {
                for x in [low[0], high[0]] {
                    corners.push([x, y, z]);
                }
            }
        }
        corners
    } else {
        return Err(ApiError::not_found("quantity_not_materialized"));
    };
    let mut bounds = [
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
    ];
    for point in points {
        let delta = [0, 1, 2].map(|axis| point[axis] - monitor.frame.origin_m[axis]);
        let u = dot(delta, monitor.frame.u_axis);
        let v = dot(delta, monitor.frame.v_axis);
        bounds[0] = bounds[0].min(u);
        bounds[1] = bounds[1].max(u);
        bounds[2] = bounds[2].min(v);
        bounds[3] = bounds[3].max(v);
    }
    monitor.frame.extent = PlanarExtentIR::Explicit {
        u_min_m: bounds[0] - padding,
        u_max_m: bounds[1] + padding,
        v_min_m: bounds[2] - padding,
        v_max_m: bounds[3] + padding,
    };
    Ok(())
}

fn resolve_component(component: Option<&str>, n_comp: usize) -> Result<PlanarComponent, ApiError> {
    if n_comp == 1 {
        return match component.unwrap_or("scalar") {
            "scalar" | "full" => Ok(PlanarComponent::Scalar),
            other => Err(ApiError::bad_request(format!(
                "invalid_planar_component: scalar quantity does not expose '{other}'"
            ))),
        };
    }
    match component.unwrap_or("magnitude") {
        "magnitude" => Ok(PlanarComponent::Magnitude),
        "x" => Ok(PlanarComponent::WorldX),
        "y" => Ok(PlanarComponent::WorldY),
        "z" => Ok(PlanarComponent::WorldZ),
        "u" => Ok(PlanarComponent::MonitorU),
        "v" => Ok(PlanarComponent::MonitorV),
        "normal" => Ok(PlanarComponent::MonitorNormal),
        "in_plane_magnitude" => Ok(PlanarComponent::InPlaneMagnitude),
        "orientation" => Ok(PlanarComponent::Orientation),
        other => Err(ApiError::bad_request(format!(
            "invalid_planar_component: '{other}'"
        ))),
    }
}

fn meta_resource(built: &BuiltPlanarField) -> PlanarFieldMetaResource {
    let bounds = built.result.meta.bounds_uv_m;
    let base = format!(
        "/v2/sessions/current/data/fields/{}/planar-monitors/{}",
        built.quantity_id, built.monitor.id
    );
    let (scalar_min, scalar_max) = built
        .result
        .scalar_values
        .iter()
        .filter(|value| value.is_finite())
        .fold((None::<f64>, None::<f64>), |(min, max), value| {
            (
                Some(min.map_or(*value, |current| current.min(*value))),
                Some(max.map_or(*value, |current| current.max(*value))),
            )
        });
    PlanarFieldMetaResource {
        schema_version: "planar_sample_meta.v1".to_string(),
        monitor_id: built.result.meta.monitor_id.clone(),
        monitor_revision: built.scene_revision,
        monitor_hash: built.result.meta.monitor_hash.clone(),
        quantity_id: built.quantity_id.clone(),
        canonical_unit: quantity_unit(&built.quantity_id).to_string(),
        component: built.component.clone(),
        field_revision: built.field_revision,
        mesh_revision: built.mesh_revision,
        generation_id: built.generation_id.to_string(),
        field_source: built.field_source.clone(),
        scope_kind: built.scope_kind.clone(),
        scope_id: built.scope_id.clone(),
        frame: PlanarFieldFrameResource {
            origin_m: built.monitor.frame.origin_m,
            u_axis: built.monitor.frame.u_axis,
            v_axis: built.monitor.frame.v_axis,
            normal: built.monitor.frame.normal,
            bounds_uv_m: bounds,
        },
        resolution: built.result.meta.resolution,
        pixel_size_m: [
            (bounds[1] - bounds[0]) / built.result.meta.resolution[0] as f64,
            (bounds[3] - bounds[2]) / built.result.meta.resolution[1] as f64,
        ],
        sample_support: match built.monitor.operator {
            PlanarOperatorIR::PlaneSample => "point_center",
            PlanarOperatorIR::SlabAverage { .. } | PlanarOperatorIR::DepthProjection { .. } => {
                "pixel_prism"
            }
            PlanarOperatorIR::SurfaceProjection { .. } => "projected_pixel_area",
        }
        .to_string(),
        sampling_execution: "cpu".to_string(),
        sampling_method: built.result.meta.sampling_method.to_string(),
        sampler_version: built.result.meta.sampler_version.to_string(),
        basis_order: built.result.meta.basis_order,
        integration_order: built.result.meta.integration_order,
        occupancy: PlanarFieldOccupancyResource {
            occupied: built.result.meta.occupied_count,
            partial: built.result.meta.partial_count,
            empty: built.result.meta.empty_count,
            occupied_measure: built.result.meta.occupied_measure,
        },
        overlap_count: built.result.meta.overlap_count,
        fold_count: built.result.meta.fold_count,
        non_injective: built.result.meta.non_injective,
        scalar_min,
        scalar_max,
        etag: built.etag.clone(),
        links: PlanarFieldLinksResource {
            scalar: format!("{base}/scalar"),
            vectors: format!("{base}/vectors"),
            empty_mask: format!("{base}/empty-mask"),
            mesh_overlay: format!("{base}/mesh-overlay"),
            probe: format!("{base}/probe"),
            render_png: format!("{base}/render.png"),
        },
    }
}

fn monitor_hash(monitor: &PlanarMonitorIR) -> Result<String, ApiError> {
    let json = serde_json::to_vec(monitor)
        .map_err(|error| ApiError::internal(format!("monitor serialization failed: {error}")))?;
    Ok(format!("sha256:{:x}", Sha256::digest(json)))
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn finite_payload(values: &[f64]) -> Vec<f64> {
    values
        .iter()
        .map(|value| if value.is_finite() { *value } else { 0.0 })
        .collect()
}

fn occupancy_label(occupancy: Occupancy) -> &'static str {
    match occupancy {
        Occupancy::Occupied => "occupied",
        Occupancy::Empty => "empty",
        Occupancy::Partial => "partial",
        Occupancy::UndefinedOrientation => "undefined_orientation",
        Occupancy::OverlapAmbiguous => "overlap_ambiguous",
    }
}

fn etag_matches(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == etag)
}

fn not_modified(etag: &str) -> Result<Response<Body>, ApiError> {
    Response::builder()
        .status(StatusCode::NOT_MODIFIED)
        .header(header::ETAG, etag)
        .body(Body::empty())
        .map_err(|error| ApiError::internal(error.to_string()))
}

fn json_response<T: serde::Serialize>(value: &T, etag: &str) -> Result<Response<Body>, ApiError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| ApiError::internal(format!("JSON serialization failed: {error}")))?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(etag).map_err(|error| ApiError::internal(error.to_string()))?,
    );
    Ok(response)
}

fn binary_response(
    bytes: Vec<u8>,
    content_type: &'static str,
    etag: &str,
) -> Result<Response<Body>, ApiError> {
    let mut response = bytes.into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(etag).map_err(|error| ApiError::internal(error.to_string()))?,
    );
    Ok(response)
}
