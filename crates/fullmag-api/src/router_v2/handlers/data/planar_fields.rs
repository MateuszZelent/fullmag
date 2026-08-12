use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, Response, StatusCode},
    response::IntoResponse,
    Json,
};
use fullmag_ir::{PlanarMonitorIR, PlanarOperatorIR};
use sha2::{Digest, Sha256};

use crate::{
    error::ApiError,
    field_render_png::{encode_scalar_png, AutoScaleMode},
    field_store::serialize_field_vector_binary_v2,
    planar_sampling::{
        resolve_spatial_target, sample_resolved_target, Occupancy, PlanarComponent,
        PlanarSampleIdentity, PlanarSampleResult, ResolvedPlanarSampleRequest,
        ResolvedSpatialScope, MAX_PLANAR_SAMPLE_POINTS,
    },
    preview::quantity_unit,
    router_v2::handlers::{
        data::fields::{
            load_fdm_multilayer_airbox_carrier, persisted_hysteresis_magnetization_values,
            resolved_fdm_multilayer_airbox_field, validate_hysteresis_snapshot_stage_scope,
        },
        data::resolved_spatial_field::{
            resolve_current_spatial_field, resolve_spatial_field_from_values,
            SpatialFieldProvenance, SpatialFieldSourceKind,
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
    monitor_revision: u64,
    quantity_id: String,
    component: String,
    field_revision: u64,
    mesh_revision: u64,
    carrier_revision: u64,
    generation_id: String,
    field_source: String,
    quality: String,
    stage_id: Option<String>,
    snapshot_id: Option<String>,
    include_mesh: bool,
    source_entity_kind: &'static str,
    scope_kind: String,
    scope_id: Option<String>,
    etag: String,
    sample_token: String,
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
        sample_token: probe.sample_token,
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
        expected_scene_revision: probe.expected_scene_revision,
        expected_monitor_revision: probe.expected_monitor_revision,
        expected_mesh_revision: probe.expected_mesh_revision,
        expected_carrier_revision: probe.expected_carrier_revision,
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
    let spec = fullmag_quantities::quantity_spec(quantity_id).ok_or_else(|| {
        ApiError::not_found(format!(
            "quantity_unavailable: quantity '{quantity_id}' is unknown"
        ))
    })?;
    let n_comp = spec.n_comp as usize;
    let current_field_revision = field_quantity_revision(snapshot, quantity_id);
    let generation_id = domain_generation_id(snapshot);
    let mesh_revision = snapshot.mesh_revision;
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
    let resolved_field = if let Some((values, grid)) = snapshot_values {
        resolve_spatial_field_from_values(
            snapshot,
            quantity_id,
            n_comp,
            values,
            Some(grid),
            SpatialFieldSourceKind::Persisted,
            current_field_revision.max(1),
            query.snapshot_id.clone(),
            SpatialFieldProvenance {
                backend: snapshot.session.resolved_backend.clone(),
                device: snapshot.session.resolved_device.clone(),
                precision: snapshot.session.resolved_precision.clone(),
            },
        )?
    } else if query.scope_kind.as_deref() == Some("airbox") {
        match load_fdm_multilayer_airbox_carrier(snapshot).map_err(|reason| {
            ApiError::not_found(format!(
                "multilayer FDM Airbox carrier unavailable: {reason}"
            ))
        })? {
            Some(carrier) => {
                resolved_fdm_multilayer_airbox_field(snapshot, quantity_id, n_comp, &carrier)?
            }
            None => {
                resolve_current_spatial_field(snapshot, quantity_id, n_comp)?.ok_or_else(|| {
                    ApiError::not_found(format!(
                        "quantity_not_materialized: field '{quantity_id}' is not published"
                    ))
                })?
            }
        }
    } else {
        resolve_current_spatial_field(snapshot, quantity_id, n_comp)?.ok_or_else(|| {
            ApiError::not_found(format!(
                "quantity_not_materialized: field '{quantity_id}' is not published"
            ))
        })?
    };
    let field_revision = resolved_field.quantity_revision;
    let monitor_hash = monitor_hash(&monitor)?;
    let monitor_revision = monitor_revision(&monitor_hash);
    let carrier_revision = resolved_field.mesh_or_grid_revision;
    validate_expected_revisions(
        query,
        scene.revision,
        monitor_revision,
        mesh_revision,
        carrier_revision,
        field_revision,
    )?;
    let scope = match query.scope_kind.as_deref().unwrap_or("monitor_target") {
        "monitor_target" => ResolvedSpatialScope::MonitorTarget,
        "mesh_part" => ResolvedSpatialScope::MeshPart {
            scope_id: query.scope_id.clone().expect("validated mesh-part scope"),
        },
        "airbox" => ResolvedSpatialScope::Airbox {
            scope_id: query.scope_id.clone(),
        },
        _ => unreachable!("scope validated before target resolution"),
    };
    let target =
        resolve_spatial_target(&resolved_field, &monitor.target, scope, &monitor.operator)?;
    target.resolve_dynamic_extent(&mut monitor.frame)?;
    let scene_revision = scene.revision;
    let session_id = snapshot.session.session_id.clone();
    let target_fingerprint = target.fingerprint().to_string();
    let target_kind = target.target_kind().to_string();
    let target_id = target.target_id().map(str::to_string);
    let target_entity_count = target.selected_entity_ids().len();
    let source_entity_kind = target.source_entity_kind();
    let field_generation = resolved_field.field_generation.clone();
    let field_content_fingerprint = (field_revision == 0 && field_generation.is_none())
        .then(|| spatial_field_content_fingerprint(&resolved_field.values));
    let source_kind = spatial_source_kind_label(resolved_field.source_kind).to_string();
    let source_backend = resolved_field.provenance.backend.clone();
    let source_device = resolved_field.provenance.device.clone();
    let source_precision = resolved_field.provenance.precision.clone();
    let field_source = query
        .snapshot_id
        .as_ref()
        .map(|snapshot| format!("stage_snapshot:{snapshot}"))
        .unwrap_or_else(|| "live".to_string());
    drop(guard);

    let component = resolve_component(query.component.as_deref(), n_comp)?;
    let request = ResolvedPlanarSampleRequest {
        monitor_id: monitor.id.clone(),
        monitor_hash: monitor_hash.clone(),
        frame: monitor.frame.clone(),
        operator: monitor.operator.clone(),
        resolution,
        component,
    };
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
    let sample_token = PlanarSampleIdentity {
        session_id,
        monitor_id: monitor.id.clone(),
        monitor_revision,
        monitor_hash: monitor_hash.clone(),
        scene_revision,
        target_fingerprint,
        target_kind,
        target_id,
        target_entity_count,
        scope_kind: scope_kind.clone(),
        scope_id: query.scope_id.clone(),
        quantity_id: quantity_id.to_string(),
        component: component_label.clone(),
        quantity_revision: field_revision,
        field_generation,
        field_content_fingerprint,
        carrier_revision,
        source_kind,
        source_backend,
        source_device,
        source_precision,
        frame: monitor.frame.clone(),
        operator: monitor.operator.clone(),
        resolution,
        quality: query
            .quality
            .clone()
            .unwrap_or_else(|| "interactive".to_string()),
    }
    .cache_key();
    if query
        .sample_token
        .as_deref()
        .is_some_and(|expected| expected != sample_token)
    {
        return Err(ApiError::conflict(
            "stale_sample_token: requested sample identity is no longer current",
        ));
    }
    let result = state
        .quantity_data_plane
        .get_or_sample_planar(&sample_token, || async move {
            Ok(Arc::new(sample_resolved_target(&target, &request)?))
        })
        .await?;
    let etag = format!(
        "\"fm-planar-sha256:{:x}\"",
        Sha256::digest(sample_token.as_bytes())
    );
    Ok(BuiltPlanarField {
        result,
        monitor,
        scene_revision,
        monitor_revision,
        quantity_id: quantity_id.to_string(),
        component: component_label,
        field_revision,
        mesh_revision,
        carrier_revision,
        generation_id,
        field_source,
        quality: query
            .quality
            .clone()
            .unwrap_or_else(|| "interactive".to_string()),
        stage_id: query.stage_id.clone(),
        snapshot_id: query.snapshot_id.clone(),
        include_mesh: query.include_mesh.unwrap_or(false),
        source_entity_kind,
        scope_kind,
        scope_id: query.scope_id.clone(),
        etag,
        sample_token,
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
    scene_revision: u64,
    monitor_revision: u64,
    mesh_revision: u64,
    carrier_revision: u64,
    field_revision: u64,
) -> Result<(), ApiError> {
    for (kind, expected, current) in [
        ("scene", query.expected_scene_revision, scene_revision),
        ("monitor", query.expected_monitor_revision, monitor_revision),
        ("mesh", query.expected_mesh_revision, mesh_revision),
        ("carrier", query.expected_carrier_revision, carrier_revision),
        ("field", query.expected_field_revision, field_revision),
    ] {
        if expected.is_some_and(|expected| expected != current) {
            return Err(ApiError::conflict(format!(
                "stale_{kind}_revision: expected {}, current {current}",
                expected.expect("checked expected revision")
            )))
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
            )));
        }
    }
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

fn spatial_source_kind_label(source: SpatialFieldSourceKind) -> &'static str {
    match source {
        SpatialFieldSourceKind::Live => "live",
        SpatialFieldSourceKind::Materialized => "materialized",
        SpatialFieldSourceKind::Preview => "preview",
        SpatialFieldSourceKind::Persisted => "persisted",
    }
}

fn spatial_field_content_fingerprint(values: &[f64]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update(value.to_le_bytes());
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn meta_resource(built: &BuiltPlanarField) -> PlanarFieldMetaResource {
    let bounds = built.result.meta.bounds_uv_m;
    let base = format!(
        "/v2/sessions/current/data/fields/{}/planar-monitors/{}",
        built.quantity_id, built.monitor.id
    );
    let query = canonical_sample_query(built);
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
        schema_version: "planar_sample_meta.v2".to_string(),
        sample_token: built.sample_token.clone(),
        scene_revision: built.scene_revision,
        monitor_id: built.result.meta.monitor_id.clone(),
        monitor_revision: built.monitor_revision,
        monitor_hash: built.result.meta.monitor_hash.clone(),
        quantity_id: built.quantity_id.clone(),
        canonical_unit: quantity_unit(&built.quantity_id).to_string(),
        component: built.component.clone(),
        field_revision: built.field_revision,
        mesh_revision: built.mesh_revision,
        carrier_revision: built.carrier_revision,
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
            scalar: format!("{base}/scalar?{query}"),
            vectors: format!("{base}/vectors?{query}"),
            empty_mask: format!("{base}/empty-mask?{query}"),
            mesh_overlay: format!("{base}/mesh-overlay?{query}"),
            probe: format!("{base}/probe?{query}"),
            render_png: format!("{base}/render.png?{query}"),
        },
    }
}

fn canonical_sample_query(built: &BuiltPlanarField) -> String {
    let mut entries = vec![
        ("sample_token", built.sample_token.clone()),
        ("component", built.component.clone()),
        ("expected_scene_revision", built.scene_revision.to_string()),
        (
            "expected_monitor_revision",
            built.monitor_revision.to_string(),
        ),
        ("expected_mesh_revision", built.mesh_revision.to_string()),
        (
            "expected_carrier_revision",
            built.carrier_revision.to_string(),
        ),
        ("expected_field_revision", built.field_revision.to_string()),
        ("resolution_x", built.result.meta.resolution[0].to_string()),
        ("resolution_y", built.result.meta.resolution[1].to_string()),
        ("scope_kind", built.scope_kind.clone()),
        ("quality", built.quality.clone()),
        ("include_mesh", built.include_mesh.to_string()),
    ];
    if let Some(scope_id) = &built.scope_id {
        entries.push(("scope_id", scope_id.clone()));
    }
    if let Some(stage_id) = &built.stage_id {
        entries.push(("stage_id", stage_id.clone()));
    }
    if let Some(snapshot_id) = &built.snapshot_id {
        entries.push(("snapshot_id", snapshot_id.clone()));
    }
    entries
        .into_iter()
        .map(|(name, value)| format!("{name}={}", encode_query_component(&value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn encode_query_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn monitor_hash(monitor: &PlanarMonitorIR) -> Result<String, ApiError> {
    let json = serde_json::to_vec(monitor)
        .map_err(|error| ApiError::internal(format!("monitor serialization failed: {error}")))?;
    Ok(format!("sha256:{:x}", Sha256::digest(json)))
}

fn monitor_revision(monitor_hash: &str) -> u64 {
    let digest = Sha256::digest(monitor_hash.as_bytes());
    u64::from(u32::from_be_bytes(
        digest[..4]
            .try_into()
            .expect("SHA-256 prefix is four bytes"),
    ))
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
