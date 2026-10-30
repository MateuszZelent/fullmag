use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, Response, StatusCode},
    response::IntoResponse,
    Json,
};
use fullmag_ir::{PlanarFrameIR, PlanarOperatorIR};
use sha2::{Digest, Sha256};

use crate::{
    error::ApiError,
    field_render_png::{encode_direction_png, encode_scalar_png, AutoScaleMode, DIRECTION_COLORMAP},
    field_store::serialize_field_vector_binary_v2,
    planar_sampling::{
        resolve_authored_planar_source, resolve_default_planar_source_with_stops,
        resolve_spatial_target, FemNodePlaneStops,
        evaluate_point_component, sample_resolved_target_cached, Occupancy, PlanarComponent, PlanarSampleIdentity,
        PlanarSampleResult, ResolvedPlanarSampleRequest, ResolvedPlanarSection,
        ResolvedPlanarSourceIdentity,
        ResolvedSpatialScope, ResolvedSpatialTarget, MAX_PLANAR_SAMPLE_POINTS,
    },
    preview::quantity_unit,
    router_v2::handlers::{
        data::fields::{
            is_fdm_multilayer_snapshot, load_fdm_multilayer_airbox_carrier_for_quantity, persisted_hysteresis_magnetization_values,
            resolved_fdm_multilayer_airbox_field, validate_hysteresis_snapshot_stage_scope,
        },
        data::fdm_multilayer_composite::resolve_fdm_multilayer_composite,
        data::resolved_spatial_field::{
            resolve_current_spatial_field, resolve_fdm_multilayer_native_layer_field,
            resolve_spatial_field_from_values, SpatialFieldProvenance, SpatialFieldSourceKind,
        },
        sessions::status::{domain_generation_id, field_quantity_revision},
    },
    schemas::{
        PlanarFieldFrameResource, PlanarFieldLinksResource, PlanarFieldMetaResource,
        PlanarFieldOccupancyResource, PlanarFieldProbeQuery, PlanarFieldProbeResource,
        PlanarFieldQuery, PlanarMeshOverlayDescriptor, PlanarSampleSourceResource,
        PlanarSectionResource,
    },
    types::AppState,
};

const DEFAULT_RESOLUTION: u32 = 128;
const MIN_RESOLUTION: u32 = 16;
const MAX_RESOLUTION: u32 = 2048;

#[path = "planar_profile.rs"]
pub mod planar_profile;
pub use planar_profile::*;

#[derive(Debug, Clone)]
enum PlanarDataSource {
    Default,
    Monitor(String),
}

struct BuiltPlanarField {
    result: Arc<PlanarSampleResult>,
    target: Arc<ResolvedSpatialTarget>,
    request: ResolvedPlanarSampleRequest,
    source: ResolvedPlanarSourceIdentity,
    section: Option<ResolvedPlanarSection>,
    frame: PlanarFrameIR,
    operator: PlanarOperatorIR,
    scene_revision: u64,
    quantity_id: String,
    component: String,
    field_revision: u64,
    mesh_revision: u64,
    carrier_revision: u64,
    generation_id: String,
    field_source: String,
    field_backend: Option<String>,
    field_device: Option<String>,
    field_precision: Option<String>,
    quality: String,
    stage_id: Option<String>,
    snapshot_id: Option<String>,
    include_mesh: bool,
    source_entity_kind: &'static str,
    scope_kind: String,
    scope_id: Option<String>,
    scope_region_id: Option<String>,
    /// Default-source position override (multislice panel), echoed into links.
    position_fraction: Option<f64>,
    etag: String,
    sample_token: String,
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/meta",
    params(("quantity_id" = String, Path), ("monitor_id" = String, Path), PlanarFieldQuery),
    responses(
        (status = 200, body = PlanarFieldMetaResource),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid planar query", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "Field or monitor missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale source", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Unsupported planar sampling", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "data"
)]
pub async fn get_planar_field_meta(
    State(state): State<Arc<AppState>>,
    Path((quantity_id, monitor_id)): Path<(String, String)>,
    Query(query): Query<PlanarFieldQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiError> {
    planar_meta_response(
        &state,
        &quantity_id,
        PlanarDataSource::Monitor(monitor_id),
        &query,
        &headers,
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/scalar",
    params(("quantity_id" = String, Path), ("monitor_id" = String, Path), PlanarFieldQuery),
    responses(
        (status = 200, description = "FMVP v2 scalar raster"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid planar query", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "Field or monitor missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale source", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Unsupported planar sampling", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "data"
)]
pub async fn get_planar_field_scalar(
    State(state): State<Arc<AppState>>,
    Path((quantity_id, monitor_id)): Path<(String, String)>,
    Query(query): Query<PlanarFieldQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiError> {
    planar_scalar_response(
        &state,
        &quantity_id,
        PlanarDataSource::Monitor(monitor_id),
        &query,
        &headers,
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/vectors",
    params(("quantity_id" = String, Path), ("monitor_id" = String, Path), PlanarFieldQuery),
    responses(
        (status = 200, description = "FMVP v2 vector raster"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid planar query", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "Field or monitor missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale source", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Quantity or sampling mode unsupported", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "data"
)]
pub async fn get_planar_field_vectors(
    State(state): State<Arc<AppState>>,
    Path((quantity_id, monitor_id)): Path<(String, String)>,
    Query(query): Query<PlanarFieldQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiError> {
    planar_vectors_response(
        &state,
        &quantity_id,
        PlanarDataSource::Monitor(monitor_id),
        &query,
        &headers,
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/empty-mask",
    params(("quantity_id" = String, Path), ("monitor_id" = String, Path), PlanarFieldQuery),
    responses(
        (status = 200, description = "One occupancy byte per pixel"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid planar query", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "Field or monitor missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale source", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Unsupported planar sampling", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "data"
)]
pub async fn get_planar_field_empty_mask(
    State(state): State<Arc<AppState>>,
    Path((quantity_id, monitor_id)): Path<(String, String)>,
    Query(query): Query<PlanarFieldQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiError> {
    planar_empty_mask_response(
        &state,
        &quantity_id,
        PlanarDataSource::Monitor(monitor_id),
        &query,
        &headers,
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/probe",
    params(("quantity_id" = String, Path), ("monitor_id" = String, Path), PlanarFieldProbeQuery),
    responses(
        (status = 200, body = PlanarFieldProbeResource),
        (status = 400, description = "Invalid planar query or probe coordinates", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "Field or monitor missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale source", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Unsupported planar sampling", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "data"
)]
pub async fn get_planar_field_probe(
    State(state): State<Arc<AppState>>,
    Path((quantity_id, monitor_id)): Path<(String, String)>,
    Query(probe): Query<PlanarFieldProbeQuery>,
) -> Result<Json<PlanarFieldProbeResource>, ApiError> {
    planar_probe_response(
        &state,
        &quantity_id,
        PlanarDataSource::Monitor(monitor_id),
        probe,
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/render.png",
    params(("quantity_id" = String, Path), ("monitor_id" = String, Path), PlanarFieldQuery),
    responses(
        (status = 200, description = "PNG export"),
        (status = 400, description = "Invalid planar query", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "Field or monitor missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale source", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Unsupported planar sampling", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "data"
)]
pub async fn get_planar_field_render_png(
    State(state): State<Arc<AppState>>,
    Path((quantity_id, monitor_id)): Path<(String, String)>,
    Query(query): Query<PlanarFieldQuery>,
) -> Result<Response<Body>, ApiError> {
    planar_render_png_response(
        &state,
        &quantity_id,
        PlanarDataSource::Monitor(monitor_id),
        &query,
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/mesh-overlay",
    params(("quantity_id" = String, Path), ("monitor_id" = String, Path), PlanarFieldQuery),
    responses(
        (status = 200, description = "FMCS v4 FEM topology or FMFG v1 FDM structured-grid planar overlay"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid planar query", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "Field or monitor missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale source", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Unsupported planar sampling", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "data"
)]
pub async fn get_planar_field_mesh_overlay(
    State(state): State<Arc<AppState>>,
    Path((quantity_id, monitor_id)): Path<(String, String)>,
    Query(query): Query<PlanarFieldQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiError> {
    planar_mesh_overlay_response(
        &state,
        &quantity_id,
        PlanarDataSource::Monitor(monitor_id),
        &query,
        &headers,
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-default/meta",
    params(("quantity_id" = String, Path), PlanarFieldQuery),
    responses(
        (status = 200, body = PlanarFieldMetaResource),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid planar query", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "Field or domain missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale source", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Unsupported planar sampling", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "data"
)]
pub async fn get_planar_default_field_meta(
    State(state): State<Arc<AppState>>,
    Path(quantity_id): Path<String>,
    Query(query): Query<PlanarFieldQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiError> {
    planar_meta_response(
        &state,
        &quantity_id,
        PlanarDataSource::Default,
        &query,
        &headers,
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-default/scalar",
    params(("quantity_id" = String, Path), PlanarFieldQuery),
    responses(
        (status = 200, description = "FMVP v2 scalar raster"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid planar query", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "Field or domain missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale source", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Unsupported planar sampling", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "data"
)]
pub async fn get_planar_default_field_scalar(
    State(state): State<Arc<AppState>>,
    Path(quantity_id): Path<String>,
    Query(query): Query<PlanarFieldQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiError> {
    planar_scalar_response(
        &state,
        &quantity_id,
        PlanarDataSource::Default,
        &query,
        &headers,
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-default/vectors",
    params(("quantity_id" = String, Path), PlanarFieldQuery),
    responses(
        (status = 200, description = "FMVP v2 vector raster"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid planar query", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "Field or domain missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale source", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Quantity or sampling mode unsupported", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "data"
)]
pub async fn get_planar_default_field_vectors(
    State(state): State<Arc<AppState>>,
    Path(quantity_id): Path<String>,
    Query(query): Query<PlanarFieldQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiError> {
    planar_vectors_response(
        &state,
        &quantity_id,
        PlanarDataSource::Default,
        &query,
        &headers,
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-default/empty-mask",
    params(("quantity_id" = String, Path), PlanarFieldQuery),
    responses(
        (status = 200, description = "One occupancy byte per pixel"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid planar query", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "Field or domain missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale source", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Unsupported planar sampling", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "data"
)]
pub async fn get_planar_default_field_empty_mask(
    State(state): State<Arc<AppState>>,
    Path(quantity_id): Path<String>,
    Query(query): Query<PlanarFieldQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiError> {
    planar_empty_mask_response(
        &state,
        &quantity_id,
        PlanarDataSource::Default,
        &query,
        &headers,
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-default/probe",
    params(("quantity_id" = String, Path), PlanarFieldProbeQuery),
    responses(
        (status = 200, body = PlanarFieldProbeResource),
        (status = 400, description = "Invalid planar query or probe coordinates", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "Field or domain missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale source", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Unsupported planar sampling", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "data"
)]
pub async fn get_planar_default_field_probe(
    State(state): State<Arc<AppState>>,
    Path(quantity_id): Path<String>,
    Query(probe): Query<PlanarFieldProbeQuery>,
) -> Result<Json<PlanarFieldProbeResource>, ApiError> {
    planar_probe_response(&state, &quantity_id, PlanarDataSource::Default, probe).await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-default/render.png",
    params(("quantity_id" = String, Path), PlanarFieldQuery),
    responses(
        (status = 200, description = "PNG export"),
        (status = 400, description = "Invalid planar query", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "Field or domain missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale source", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Unsupported planar sampling", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "data"
)]
pub async fn get_planar_default_field_render_png(
    State(state): State<Arc<AppState>>,
    Path(quantity_id): Path<String>,
    Query(query): Query<PlanarFieldQuery>,
) -> Result<Response<Body>, ApiError> {
    planar_render_png_response(&state, &quantity_id, PlanarDataSource::Default, &query).await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-default/mesh-overlay",
    params(("quantity_id" = String, Path), PlanarFieldQuery),
    responses(
        (status = 200, description = "FMCS v4 FEM topology or FMFG v1 FDM structured-grid planar overlay"),
        (status = 204, description = "Mesh overlay unavailable for the current field"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid planar query", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "Field or domain missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale source", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Unsupported planar sampling", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "data"
)]
pub async fn get_planar_default_field_mesh_overlay(
    State(state): State<Arc<AppState>>,
    Path(quantity_id): Path<String>,
    Query(query): Query<PlanarFieldQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiError> {
    planar_mesh_overlay_response(
        &state,
        &quantity_id,
        PlanarDataSource::Default,
        &query,
        &headers,
    )
    .await
}

async fn build_planar_field_from_source(
    state: &Arc<AppState>,
    quantity_id: &str,
    source: PlanarDataSource,
    query: &PlanarFieldQuery,
) -> Result<BuiltPlanarField, ApiError> {
    let request_context = crate::capture_current_live_request_context(state).await?;
    let resolution = resolve_resolution(query)?;
    validate_auxiliary_query(query)?;
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let presentation = state.current_display_presentation.read().await.clone();
    crate::ensure_current_live_request_context(
        snapshot,
        &request_context,
        state
            .current_live_session_epoch
            .load(std::sync::atomic::Ordering::Acquire),
    )?;
    let planar_state = presentation
        .visualization_planar
        .unwrap_or_else(crate::schemas::visualization_state::default_planar_visualization_state);
    // Ok(None) unless the plan is an FDM multilayer; an error matters only to
    // the scopes that sample the composite carrier.
    let multilayer_composite = resolve_fdm_multilayer_composite(snapshot);
    let resolved_source = match &source {
        PlanarDataSource::Default => {
            let mut domain = super::domain::domain_meta_for_snapshot(snapshot);
            if let Ok(Some(composite)) = &multilayer_composite {
                composite.apply_to_domain(&mut domain);
            }
            let stops = snapshot
                .fem_mesh
                .as_ref()
                .and_then(|mesh| mesh.build_report.as_ref())
                .and_then(FemNodePlaneStops::from_build_report);
            let mut default_slice = planar_state.default_slice.clone();
            if let Some(position_fraction) = query.position_fraction {
                // Multislice panel: same plane and operator, its own position.
                default_slice.position_fraction = position_fraction;
            }
            resolve_default_planar_source_with_stops(&domain, &default_slice, stops.as_ref())?
        }
        PlanarDataSource::Monitor(_) if query.position_fraction.is_some() => {
            return Err(ApiError::bad_request(
                "planar_position_fraction_requires_default_source: position_fraction applies only to the default source",
            ));
        }
        PlanarDataSource::Monitor(monitor_id) => {
            let scene = snapshot
                .scene_document
                .as_ref()
                .ok_or_else(|| ApiError::not_found("no canonical scene document"))?;
            resolve_authored_planar_source(&scene.monitors.planar, monitor_id)?
        }
    };
    let mut frame = resolved_source.frame.clone();
    let operator = resolved_source.operator.clone();
    let mut target_definition = resolved_source.target.clone();
    let scene_revision = snapshot
        .scene_document
        .as_ref()
        .map(|scene| scene.revision)
        .unwrap_or(0);
    let spec = fullmag_quantities::quantity_spec(quantity_id).ok_or_else(|| {
        ApiError::not_found(format!(
            "quantity_unavailable: quantity '{quantity_id}' is unknown"
        ))
    })?;
    if matches!(&source, PlanarDataSource::Default)
        && spec.domain == fullmag_quantities::QuantityDomain::MagneticOnly
    {
        target_definition = fullmag_ir::MonitorTargetIR::MagneticDomain;
    }
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
        crate::ensure_current_live_request_context(
            snapshot,
            &request_context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
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
    } else if query.scope_kind.as_deref() == Some("layer") {
        let layer_id = query.scope_id.as_deref().expect("validated layer scope");
        resolve_fdm_multilayer_native_layer_field(snapshot, quantity_id, n_comp, layer_id)?
            .ok_or_else(|| {
                ApiError::unprocessable(
                    "target_unsupported: layer scope requires an FDM multilayer native carrier",
                )
            })?
    } else if query.scope_kind.as_deref() == Some("airbox") {
        match load_fdm_multilayer_airbox_carrier_for_quantity(snapshot, quantity_id).map_err(|reason| {
            ApiError::not_found(format!(
                "multilayer FDM Airbox carrier unavailable: {reason}"
            ))
        })? {
            Some(carrier) => {
                resolved_fdm_multilayer_airbox_field(snapshot, quantity_id, n_comp, &carrier)?
            }
            None => {
                if is_fdm_multilayer_snapshot(snapshot) {
                    return Err(ApiError::not_found(format!(
                        "quantity_not_materialized: Airbox field '{quantity_id}' is not published"
                    )));
                }
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
    let resolved_field = if matches!(
        query.scope_kind.as_deref().unwrap_or("monitor_target"),
        "monitor_target" | "region"
    ) {
        match multilayer_composite {
            Ok(Some(composite)) => composite.embed(resolved_field)?,
            Ok(None) => resolved_field,
            Err(error) => return Err(error),
        }
    } else {
        resolved_field
    };
    let field_revision = resolved_field.quantity_revision;
    let source_revision = resolved_source.identity.source_revision;
    let carrier_revision = resolved_field.mesh_or_grid_revision;
    validate_expected_revisions(
        query,
        scene_revision,
        &resolved_source.identity.source_kind,
        source_revision,
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
        "layer" => ResolvedSpatialScope::FdmNativeLayer {
            layer_id: query.scope_id.clone().expect("validated layer scope"),
        },
        "region" => ResolvedSpatialScope::Region {
            object_id: query.scope_id.clone().expect("validated region scope"),
            region_id: query.scope_region_id.clone().expect("validated region scope"),
        },
        _ => unreachable!("scope validated before target resolution"),
    };
    let target = resolve_spatial_target(&resolved_field, &target_definition, scope, &operator)?;
    target.resolve_dynamic_extent(&mut frame)?;
    let session_id = snapshot.session.session_id.clone();
    let target_fingerprint = target.fingerprint().to_string();
    let target_kind = target.target_kind().to_string();
    let target_id = target.target_id().map(str::to_string);
    let target_entity_count = target.selected_entity_ids().len();
    let source_entity_kind = target.source_entity_kind();
    let field_generation = resolved_field.field_generation.clone();
    let field_content_fingerprint = (field_revision == 0 && field_generation.is_none())
        .then(|| spatial_field_content_fingerprint(&resolved_field.values));
    let field_source_kind = spatial_source_kind_label(resolved_field.source_kind).to_string();
    let source_backend = resolved_field.provenance.backend.clone();
    let source_device = resolved_field.provenance.device.clone();
    let source_precision = resolved_field.provenance.precision.clone();
    let field_source = query
        .snapshot_id
        .as_ref()
        .map(|snapshot| format!("stage_snapshot:{snapshot}"))
        .unwrap_or_else(|| "live".to_string());
    drop(guard);

    let component = resolve_component(
        query.component.as_deref(),
        n_comp,
        spec.tensor_descriptor().as_ref(),
    )?;
    let request = ResolvedPlanarSampleRequest {
        frame: frame.clone(),
        operator: operator.clone(),
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
        } else if spec.tensor_descriptor().is_some() {
            "frobenius".to_string()
        } else {
            "magnitude".to_string()
        }
    });
    // Geometry identity of the cached plane operator: everything that decides
    // which element and weights serve a pixel, but no field values. The
    // operator additionally verifies the carrier topology fingerprint.
    let geometry_key = format!(
        "planar-operator:{session_id}:{generation_id}:{scene_revision}:{target_fingerprint}:\
         {scope_kind}:{scope_id:?}:{scope_region_id:?}:{carrier_revision}:{resolution:?}:{frame:?}:{operator:?}:{}",
        crate::planar_sampling::PLANAR_SAMPLER_VERSION,
        scope_id = query.scope_id,
        scope_region_id = query.scope_region_id,
    );
    let sample_token = PlanarSampleIdentity {
        session_id,
        source_kind: resolved_source.identity.source_kind.clone(),
        source_id: resolved_source.identity.source_id.clone(),
        source_revision,
        source_hash: resolved_source.identity.source_hash.clone(),
        domain_generation_id: generation_id.clone(),
        scene_revision,
        target_fingerprint,
        target_kind,
        target_id,
        target_entity_count,
        scope_kind: scope_kind.clone(),
        scope_id: query.scope_id.clone(),
        scope_region_id: query.scope_region_id.clone(),
        quantity_id: quantity_id.to_string(),
        component: component_label.clone(),
        quantity_revision: field_revision,
        field_generation,
        field_content_fingerprint,
        carrier_revision,
        field_source_kind,
        source_backend: source_backend.clone(),
        source_device: source_device.clone(),
        source_precision: source_precision.clone(),
        frame: frame.clone(),
        operator: operator.clone(),
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
    let target = Arc::new(target);
    let sampling_target = Arc::clone(&target);
    let sampling_request = request.clone();
    let operator_cache = Arc::clone(&state.quantity_data_plane.planar_operator_cache);
    let fence_state = Arc::clone(state);
    let fence_context = request_context.clone();
    let result = state
        .quantity_data_plane
        .get_or_sample_planar(&sample_token, || async move {
            // Sampling is CPU-bound; keep it off the async executor.
            let sampled = tokio::task::spawn_blocking(move || {
                sample_resolved_target_cached(
                    &sampling_target,
                    &sampling_request,
                    &operator_cache,
                    &geometry_key,
                )
            })
            .await
            .map_err(|error| ApiError::internal(format!("planar sampling task failed: {error}")))??;
            // Fence before the sample enters the shared cache, so a session
            // switch during sampling cannot publish a stale entry.
            {
                let _transition = fence_state.current_live_session_transition.lock().await;
                let current = fence_state.current_live_state.read().await;
                let current = current
                    .as_ref()
                    .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
                crate::ensure_current_live_request_context(
                    current,
                    &fence_context,
                    fence_state
                        .current_live_session_epoch
                        .load(std::sync::atomic::Ordering::Acquire),
                )?;
            }
            Ok(Arc::new(sampled))
        })
        .await?;
    {
        let _transition = state.current_live_session_transition.lock().await;
        let current = state.current_live_state.read().await;
        let current = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        crate::ensure_current_live_request_context(
            current,
            &request_context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
    }
    let etag = format!(
        "\"fm-planar-sha256:{:x}\"",
        Sha256::digest(sample_token.as_bytes())
    );
    let section = resolved_source
        .section
        .map(|section| section.with_fem_section_extent(result.section_extent));
    Ok(BuiltPlanarField {
        result,
        target,
        request,
        source: resolved_source.identity,
        section,
        frame,
        operator,
        scene_revision,
        quantity_id: quantity_id.to_string(),
        component: component_label,
        field_revision,
        mesh_revision,
        carrier_revision,
        generation_id,
        field_source,
        field_backend: source_backend,
        field_device: source_device,
        field_precision: source_precision,
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
        scope_region_id: query.scope_region_id.clone(),
        position_fraction: query.position_fraction,
        etag,
        sample_token,
    })
}

async fn planar_meta_response(
    state: &Arc<AppState>,
    quantity_id: &str,
    source: PlanarDataSource,
    query: &PlanarFieldQuery,
    headers: &HeaderMap,
) -> Result<Response<Body>, ApiError> {
    let built = build_planar_field_from_source(state, quantity_id, source, query).await?;
    if etag_matches(headers, &built.etag) {
        return not_modified(&built.etag);
    }
    let meta = meta_resource(&built);
    json_response(&meta, &built.etag)
}

async fn planar_scalar_response(
    state: &Arc<AppState>,
    quantity_id: &str,
    source: PlanarDataSource,
    query: &PlanarFieldQuery,
    headers: &HeaderMap,
) -> Result<Response<Body>, ApiError> {
    let built = build_planar_field_from_source(state, quantity_id, source, query).await?;
    if etag_matches(headers, &built.etag) {
        return not_modified(&built.etag);
    }
    let values = finite_payload(&built.result.scalar_values);
    let bytes = serialize_field_vector_binary_v2(
        quantity_id,
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

async fn planar_vectors_response(
    state: &Arc<AppState>,
    quantity_id: &str,
    source: PlanarDataSource,
    query: &PlanarFieldQuery,
    headers: &HeaderMap,
) -> Result<Response<Body>, ApiError> {
    let built = build_planar_field_from_source(state, quantity_id, source, query).await?;
    if etag_matches(headers, &built.etag) {
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
        quantity_id,
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

async fn planar_empty_mask_response(
    state: &Arc<AppState>,
    quantity_id: &str,
    source: PlanarDataSource,
    query: &PlanarFieldQuery,
    headers: &HeaderMap,
) -> Result<Response<Body>, ApiError> {
    let built = build_planar_field_from_source(state, quantity_id, source, query).await?;
    if etag_matches(headers, &built.etag) {
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

async fn planar_probe_response(
    state: &Arc<AppState>,
    quantity_id: &str,
    source: PlanarDataSource,
    probe: PlanarFieldProbeQuery,
) -> Result<Json<PlanarFieldProbeResource>, ApiError> {
    if !probe.u_m.is_finite() || !probe.v_m.is_finite() {
        return Err(ApiError::bad_request(
            "invalid_planar_probe: coordinates must be finite",
        ));
    }
    let query = PlanarFieldQuery {
        sample_token: probe.sample_token.clone(),
        component: probe.component.clone(),
        scope_kind: probe.scope_kind.clone(),
        scope_id: probe.scope_id.clone(),
        scope_region_id: probe.scope_region_id.clone(),
        stage_id: probe.stage_id.clone(),
        snapshot_id: probe.snapshot_id.clone(),
        resolution_x: probe.resolution_x,
        resolution_y: probe.resolution_y,
        quality: probe.quality.clone(),
        vector_budget: Some(0),
        include_mesh: Some(false),
        expected_scene_revision: probe.expected_scene_revision,
        expected_monitor_revision: probe.expected_monitor_revision,
        expected_source_revision: probe.expected_source_revision,
        expected_mesh_revision: probe.expected_mesh_revision,
        expected_carrier_revision: probe.expected_carrier_revision,
        expected_field_revision: probe.expected_field_revision,
        position_fraction: None,
    };
    let built = build_planar_field_from_source(state, quantity_id, source, &query).await?;
    let bounds = built.result.meta.bounds_uv_m;
    let frame = &built.frame;
    // The probe is a point evaluation at the exact requested position: never
    // clamped to the raster edge, and position and value refer to one point.
    let world_m = [
        frame.origin_m[0] + probe.u_m * frame.u_axis[0] + probe.v_m * frame.v_axis[0],
        frame.origin_m[1] + probe.u_m * frame.u_axis[1] + probe.v_m * frame.v_axis[1],
        frame.origin_m[2] + probe.u_m * frame.u_axis[2] + probe.v_m * frame.v_axis[2],
    ];
    let inside_frame = probe.u_m >= bounds[0]
        && probe.u_m <= bounds[1]
        && probe.v_m >= bounds[2]
        && probe.v_m <= bounds[3];
    let point = if inside_frame {
        built.target.evaluate_point(world_m)
    } else {
        None
    };
    let (scalar, vector, entity_id) = match &point {
        Some((entity_id, values)) => {
            let (scalar, vector) = evaluate_point_component(values, &built.request)?;
            (scalar, vector, Some(*entity_id))
        }
        None => (None, None, None),
    };
    let occupancy = match (inside_frame, &point) {
        (false, _) => "outside",
        (true, None) => "empty",
        (true, Some(_)) => "occupied",
    };
    Ok(Json(PlanarFieldProbeResource {
        source: source_resource(&built.source),
        quantity_id: quantity_id.to_string(),
        u_m: probe.u_m,
        v_m: probe.v_m,
        world_m,
        scalar,
        vector,
        cell_id: (built.source_entity_kind == "cell")
            .then_some(entity_id)
            .flatten(),
        element_id: (built.source_entity_kind == "element")
            .then_some(entity_id)
            .flatten(),
        occupancy: occupancy.to_string(),
        sampling_method: "point_probe".to_string(),
    }))
}

async fn planar_render_png_response(
    state: &Arc<AppState>,
    quantity_id: &str,
    source: PlanarDataSource,
    query: &PlanarFieldQuery,
) -> Result<Response<Body>, ApiError> {
    let built = build_planar_field_from_source(state, quantity_id, source, query).await?;
    let planar = state
        .current_display_presentation
        .read()
        .await
        .visualization_planar
        .clone()
        .unwrap_or_else(crate::schemas::visualization_state::default_planar_visualization_state);
    let style = PlanarPngStyle::from_state(&planar);
    let mask = built
        .result
        .occupancy
        .iter()
        .map(|occupancy| u8::from(*occupancy == Occupancy::Empty))
        .collect::<Vec<_>>();
    let png = match (&built.result.vector_values, style.colormap.as_str()) {
        // The direction wheel needs the full vector; a scalar field falls
        // back to viridis exactly as the Control Room legend does.
        (Some(vectors), DIRECTION_COLORMAP) => encode_direction_png(
            built.result.meta.resolution[0],
            built.result.meta.resolution[1],
            vectors,
            &mask,
        )?,
        (_, colormap) => encode_scalar_png(
            built.result.meta.resolution[0],
            built.result.meta.resolution[1],
            &built.result.scalar_values,
            &mask,
            if colormap == DIRECTION_COLORMAP { "viridis" } else { colormap },
            style.auto_scale,
            style.vmin,
            style.vmax,
            true,
        )?,
    };
    binary_response(png, "image/png", &planar_png_etag(&built.etag, &style))
}

/// Presentation applied to the exported PNG: the session planar colormap and
/// SI color range, so the export matches the 2D view's legend.
#[derive(Debug, Clone, PartialEq)]
struct PlanarPngStyle {
    colormap: String,
    auto_scale: AutoScaleMode,
    vmin: Option<f64>,
    vmax: Option<f64>,
}

impl PlanarPngStyle {
    fn from_state(planar: &crate::schemas::visualization_state::PlanarVisualizationState) -> Self {
        use crate::schemas::visualization_state::PlanarColorRangeMode;
        let range = &planar.range;
        let (auto_scale, vmin, vmax) = match (range.mode, range.min, range.max) {
            (PlanarColorRangeMode::Manual, Some(min), Some(max))
                if min.is_finite() && max.is_finite() && min < max =>
            {
                (AutoScaleMode::Manual, Some(min), Some(max))
            }
            (PlanarColorRangeMode::Symmetric, _, _) => (AutoScaleMode::SymmetricZero, None, None),
            _ => (AutoScaleMode::Slice, None, None),
        };
        Self {
            colormap: planar.colormap.clone(),
            auto_scale,
            vmin,
            vmax,
        }
    }
}

fn planar_png_etag(sample_etag: &str, style: &PlanarPngStyle) -> String {
    format!(
        "\"fm-planar-png:{:x}\"",
        Sha256::digest(format!("{sample_etag}:{style:?}").as_bytes())
    )
}

async fn planar_mesh_overlay_response(
    state: &Arc<AppState>,
    quantity_id: &str,
    source: PlanarDataSource,
    query: &PlanarFieldQuery,
    headers: &HeaderMap,
) -> Result<Response<Body>, ApiError> {
    let built = build_planar_field_from_source(state, quantity_id, source, query).await?;
    let codec = if fdm_grid_overlay_available(&built) {
        "fmfg.v1"
    } else {
        "fmcs.v4"
    };
    let overlay_etag = planar_overlay_etag(&built.etag, codec);
    if etag_matches(headers, &overlay_etag) {
        return not_modified(&overlay_etag);
    }
    let bytes = if codec == "fmfg.v1" {
        let overlay = built
            .target
            .build_fdm_grid_overlay(&built.request)?
            .ok_or_else(|| {
                ApiError::unprocessable(
                    "planar_mesh_overlay_unavailable: FDM grid geometry is absent",
                )
            })?;
        crate::fdm_planar_grid_overlay::serialize_fmfg_v1(&overlay)?
    } else {
        let Some(overlay) = built.result.overlay.as_ref() else {
            return Ok(StatusCode::NO_CONTENT.into_response());
        };
        crate::fem_cross_section::serialize_planar_overlay_fmcs_v4(overlay)
    };
    binary_response(bytes, "application/octet-stream", &overlay_etag)
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
    source_kind: &str,
    source_revision: u64,
    mesh_revision: u64,
    carrier_revision: u64,
    field_revision: u64,
) -> Result<(), ApiError> {
    for (kind, expected, current) in [
        ("scene", query.expected_scene_revision, scene_revision),
        ("mesh", query.expected_mesh_revision, mesh_revision),
        ("carrier", query.expected_carrier_revision, carrier_revision),
        ("field", query.expected_field_revision, field_revision),
    ] {
        if expected.is_some_and(|expected| expected != current) {
            return Err(ApiError::conflict(format!(
                "stale_{kind}_revision: expected {}, current {current}",
                expected.expect("checked expected revision")
            )));
        }
    }
    let expected_source_revision = query.expected_source_revision.or_else(|| {
        (source_kind == "monitor")
            .then_some(query.expected_monitor_revision)
            .flatten()
    });
    if expected_source_revision.is_some_and(|expected| expected != source_revision) {
        let kind = if source_kind == "monitor" {
            "monitor"
        } else {
            "source"
        };
        return Err(ApiError::conflict(format!(
            "stale_{kind}_revision: expected {}, current {source_revision}",
            expected_source_revision.expect("checked expected source revision")
        )));
    }
    Ok(())
}

fn validate_scope(
    snapshot: &crate::types::SessionStateResponse,
    query: &PlanarFieldQuery,
) -> Result<(), ApiError> {
    if query.scope_region_id.is_some() && query.scope_kind.as_deref() != Some("region") {
        return Err(ApiError::bad_request(
            "invalid_planar_scope: scope_region_id is only valid for region scope",
        ));
    }
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
        "region" => {
            let object_id = query.scope_id.as_deref().filter(|id| !id.trim().is_empty());
            let region_id = query
                .scope_region_id
                .as_deref()
                .filter(|id| !id.trim().is_empty());
            if object_id.is_none() || region_id.is_none() {
                return Err(ApiError::bad_request(
                    "invalid_planar_scope: region requires scope_id (object) and scope_region_id",
                ));
            }
        }
        "layer" => {
            let scope_id = query
                .scope_id
                .as_deref()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    ApiError::bad_request("invalid_planar_scope: layer requires scope_id")
                })?;
            let multilayer = snapshot.metadata.as_ref().is_some_and(|metadata| {
                metadata
                    .get("artifact_layout")
                    .and_then(|layout| layout.get("backend"))
                    .and_then(serde_json::Value::as_str)
                    == Some("fdm_multilayer")
            });
            if !multilayer {
                return Err(ApiError::unprocessable(format!(
                    "target_unsupported: layer scope '{scope_id}' requires FDM multilayer"
                )));
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

fn resolve_component(
    component: Option<&str>,
    n_comp: usize,
    tensor: Option<&fullmag_quantities::QuantityTensorDescriptor>,
) -> Result<PlanarComponent, ApiError> {
    if tensor.is_some() {
        use crate::field_projection::ComponentSelection;
        return match crate::field_projection::parse_quantity_component(
            component.or(Some("frobenius")),
            n_comp,
            tensor,
        )? {
            ComponentSelection::Index(index) => Ok(PlanarComponent::Index(index)),
            ComponentSelection::Frobenius => Ok(PlanarComponent::Frobenius),
            ComponentSelection::SpinFlow(axis) => Ok(PlanarComponent::SpinFlow(axis)),
            _ => Err(ApiError::bad_request(
                "invalid_planar_component: tensor requires cN, frobenius, or spin_flow_x/y/z",
            )),
        };
    }
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
    let base = source_base_path(built);
    let query = canonical_sample_query(built);
    // Extrema describe occupied support only; empty bins serialized as zero
    // (`include_air_as_zero`) must not widen the scientific range (PM-N05).
    let (scalar_min, scalar_max) = built
        .result
        .scalar_values
        .iter()
        .zip(&built.result.occupancy)
        .filter(|(value, occupancy)| value.is_finite() && **occupancy != Occupancy::Empty)
        .map(|(value, _)| value)
        .fold((None::<f64>, None::<f64>), |(min, max), value| {
            (
                Some(min.map_or(*value, |current| current.min(*value))),
                Some(max.map_or(*value, |current| current.max(*value))),
            )
        });
    PlanarFieldMetaResource {
        schema_version: "planar_sample_meta.v7".to_string(),
        sample_token: built.sample_token.clone(),
        scene_revision: built.scene_revision,
        source: source_resource(&built.source),
        quantity_id: built.quantity_id.clone(),
        canonical_unit: quantity_unit(&built.quantity_id).to_string(),
        component: built.component.clone(),
        field_revision: built.field_revision,
        mesh_revision: built.mesh_revision,
        carrier_revision: built.carrier_revision,
        generation_id: built.generation_id.to_string(),
        field_source: built.field_source.clone(),
        field_backend: built.field_backend.clone(),
        field_device: built.field_device.clone(),
        field_precision: built.field_precision.clone(),
        scope_kind: built.scope_kind.clone(),
        scope_id: built.scope_id.clone(),
        scope_region_id: built.scope_region_id.clone(),
        frame: PlanarFieldFrameResource {
            origin_m: built.frame.origin_m,
            u_axis: built.frame.u_axis,
            v_axis: built.frame.v_axis,
            normal: built.frame.normal,
            bounds_uv_m: bounds,
        },
        section: built.section.as_ref().map(section_resource),
        operator: (&built.operator).into(),
        resolution: built.result.meta.resolution,
        pixel_size_m: [
            (bounds[1] - bounds[0]) / built.result.meta.resolution[0] as f64,
            (bounds[3] - bounds[2]) / built.result.meta.resolution[1] as f64,
        ],
        sample_support: match built.operator {
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
        mesh_overlay_descriptor: if fdm_grid_overlay_available(built) {
            PlanarMeshOverlayDescriptor {
                available: true,
                codec: Some("fmfg.v1".to_string()),
                boundary_classification: "unavailable".to_string(),
                geometry_source: "fdm_structured_grid".to_string(),
            }
        } else if built.result.overlay.is_some() {
            PlanarMeshOverlayDescriptor {
                available: true,
                codec: Some("fmcs.v4".to_string()),
                boundary_classification: "exact".to_string(),
                geometry_source: "fem_topology".to_string(),
            }
        } else {
            PlanarMeshOverlayDescriptor {
                available: false,
                codec: None,
                boundary_classification: "unavailable".to_string(),
                geometry_source: "unavailable".to_string(),
            }
        },
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

fn fdm_grid_overlay_available(built: &BuiltPlanarField) -> bool {
    built.source_entity_kind == "cell"
        && matches!(built.scope_kind.as_str(), "monitor_target" | "layer")
        && !matches!(built.operator, PlanarOperatorIR::SurfaceProjection { .. })
}

fn planar_overlay_etag(sample_etag: &str, codec: &str) -> String {
    format!(
        "\"fm-planar-overlay-{}:{:x}\"",
        codec.replace('.', "-"),
        Sha256::digest(format!("{sample_etag}:{codec}").as_bytes())
    )
}

fn canonical_sample_query(built: &BuiltPlanarField) -> String {
    let mut entries = vec![
        ("sample_token", built.sample_token.clone()),
        ("component", built.component.clone()),
        ("expected_scene_revision", built.scene_revision.to_string()),
        (
            if built.source.source_kind == "monitor" {
                "expected_monitor_revision"
            } else {
                "expected_source_revision"
            },
            built.source.source_revision.to_string(),
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
    if let Some(scope_region_id) = &built.scope_region_id {
        entries.push(("scope_region_id", scope_region_id.clone()));
    }
    if let Some(position_fraction) = built.position_fraction {
        // Shortest round-trip decimal, so the link names the same slice.
        entries.push(("position_fraction", position_fraction.to_string()));
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

fn source_base_path(built: &BuiltPlanarField) -> String {
    match built.source.source_kind.as_str() {
        "default" => format!(
            "/v2/sessions/current/data/fields/{}/planar-default",
            encode_query_component(&built.quantity_id)
        ),
        "monitor" => format!(
            "/v2/sessions/current/data/fields/{}/planar-monitors/{}",
            encode_query_component(&built.quantity_id),
            encode_query_component(
                built
                    .source
                    .source_id
                    .as_deref()
                    .expect("authored planar source has an ID"),
            )
        ),
        other => panic!("unsupported resolved planar source kind: {other}"),
    }
}

fn section_resource(section: &ResolvedPlanarSection) -> PlanarSectionResource {
    PlanarSectionResource {
        plane: section.plane.to_string(),
        normal_axis: section.normal_axis.to_string(),
        requested_fraction: section.requested_fraction,
        requested_coordinate_m: section.requested_coordinate_m,
        resolved_coordinate_m: section.resolved_coordinate_m,
        stops_kind: section.stops_kind.to_string(),
        layer_index: section.layer_index,
        layer_count: section.layer_count,
        layer_spacing_m: section.layer_spacing_m,
        normal_min_m: section.normal_min_m,
        normal_max_m: section.normal_max_m,
        navigation_step_m: section.navigation_step_m,
        navigation_step_kind: section.navigation_step_kind.to_string(),
        cut_element_count: section.cut_element_count,
        layer_stops_m: section.layer_stops_m.clone(),
    }
}

fn source_resource(identity: &ResolvedPlanarSourceIdentity) -> PlanarSampleSourceResource {
    match identity.source_kind.as_str() {
        "default" => PlanarSampleSourceResource::Default {
            default_slice_hash: identity.source_hash.clone(),
            default_slice_revision: identity.source_revision,
            domain_generation_id: identity.domain_generation_id.clone(),
        },
        "monitor" => PlanarSampleSourceResource::Monitor {
            monitor_id: identity
                .source_id
                .clone()
                .expect("authored planar source has an ID"),
            monitor_hash: identity.source_hash.clone(),
            monitor_revision: identity.source_revision,
        },
        other => panic!("unsupported resolved planar source kind: {other}"),
    }
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

fn finite_payload(values: &[f64]) -> Vec<f64> {
    values
        .iter()
        .map(|value| if value.is_finite() { *value } else { 0.0 })
        .collect()
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
