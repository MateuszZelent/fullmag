//! Domain endpoints — meta and topology.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::http::{HeaderMap, HeaderName, HeaderValue};
use axum::response::IntoResponse;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::fields::{FdmMultilayerAirboxCarrier, load_fdm_multilayer_airbox_carrier};
use super::multilayer_identity::correlate_multilayer_layers;
use super::resolved_spatial_field::load_fdm_multilayer_native_layer_membership;
use crate::error::ApiError;
use crate::fem_slice_overlay::{FemSliceOverlayInput, collect_fem_slice_overlay};
use crate::field_slice::{FieldSliceQuery, SlicePlane, resolve_slice_query};
use crate::router_v2::handlers::data::field_resolution::is_fdm_snapshot;
use crate::router_v2::handlers::sessions::status::{
    domain_generation_id, domain_generation_revision, fdm_grid_geometry, fdm_grid_shape,
};
use crate::schemas::domain::*;
use crate::types::{AppState, SessionStateResponse};

const FMBM_HEADER_LEN: usize = 104;

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
        element_type: is_fem
            .then(|| snapshot.fem_mesh.as_ref().and_then(fem_element_type))
            .flatten(),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/domain/fdm-multilayer-layout",
    responses(
        (status = 200, description = "FDM multilayer native and common transform layouts", body = FdmMultilayerLayoutResource),
        (status = 404, description = "No active workspace"),
        (status = 409, description = "Artifact and execution-plan layers are missing, malformed, disagree in identity, native geometry, fingerprint, counts, or active-mask materialization, or cannot be correlated one-to-one"),
    ),
    tag = "data"
)]
pub async fn get_fdm_multilayer_layout(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FdmMultilayerLayoutResource>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    Ok(Json(fdm_multilayer_layout_resource(snapshot)?))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/domain/fdm-multilayer-layers/{layer_id}/active-mask",
    params(
        ("layer_id" = String, Path, description = "Stable native multilayer layer identity"),
        ("If-None-Match" = Option<String>, Header, description = "Strong ETag from a previous FMBM response"),
        ("Range" = Option<String>, Header, description = "Optional single byte range for the FMBM payload")
    ),
    responses(
        (status = 200, description = "Bit-packed native-layer active mask (FMBM v1)", content_type = "application/octet-stream", headers(
            ("x-fullmag-grid-fingerprint" = String, description = "Exact native grid fingerprint"),
            ("x-fullmag-mask-hash" = String, description = "SHA-256 identity of the packed active mask"),
            ("x-fullmag-layout-revision" = String, description = "Current multilayer layout revision")
        )),
        (status = 206, description = "Partial FMBM payload", content_type = "application/octet-stream"),
        (status = 304, description = "FMBM payload not modified for the supplied ETag"),
        (status = 404, description = "Layer or materialized native active mask is not applicable"),
        (status = 409, description = "Native active mask disagrees with the published layer layout"),
        (status = 416, description = "Requested FMBM byte range is not satisfiable")
    ),
    tag = "data"
)]
pub async fn get_fdm_multilayer_layer_active_mask(
    State(state): State<Arc<AppState>>,
    Path(layer_id): Path<String>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let layout = fdm_multilayer_layout_resource(snapshot)?;
    if !layout.available {
        return Err(ApiError::not_found(
            "FDM multilayer active mask is not applicable to the active backend",
        ));
    }
    let descriptor = layout
        .layers
        .iter()
        .find(|layer| layer.layer_id == layer_id)
        .ok_or_else(|| {
            ApiError::not_found(format!("FDM multilayer layer '{layer_id}' not found"))
        })?;
    if !descriptor.active_mask_present {
        return Err(ApiError::not_found(format!(
            "FDM multilayer layer '{layer_id}' has no materialized native active mask"
        )));
    }
    let mask = planned_native_active_mask(snapshot, &layer_id)?.ok_or_else(|| {
        ApiError::not_found(format!(
            "FDM multilayer layer '{layer_id}' has no materialized native active mask"
        ))
    })?;
    let total_cells = descriptor
        .native_grid
        .iter()
        .map(|value| u64::from(*value))
        .product::<u64>();
    if mask.len() as u64 != total_cells {
        return Err(ApiError::conflict(format!(
            "FDM multilayer layer '{layer_id}' active mask length does not match its native grid"
        )));
    }
    let grid_fingerprint = descriptor
        .native_grid_fingerprint
        .as_deref()
        .and_then(canonical_sha256_hex)
        .ok_or_else(|| {
            ApiError::conflict(format!(
                "FDM multilayer layer '{layer_id}' has no canonical native grid fingerprint"
            ))
        })?;
    let packed = pack_native_active_mask(&mask);
    let mask_hash = format!("{:x}", Sha256::digest(&packed));
    let expected_hash = descriptor
        .active_mask_hash
        .as_deref()
        .and_then(canonical_sha256_hex)
        .ok_or_else(|| {
            ApiError::conflict(format!(
                "FDM multilayer layer '{layer_id}' has no canonical active mask hash"
            ))
        })?;
    if expected_hash != mask_hash {
        return Err(ApiError::conflict(format!(
            "FDM multilayer layer '{layer_id}' active mask hash does not match its layout"
        )));
    }
    let cell_count = u32::try_from(total_cells)
        .map_err(|_| ApiError::conflict("FDM multilayer native active mask exceeds FMBM u32"))?;
    let packed_len = u32::try_from(packed.len())
        .map_err(|_| ApiError::conflict("FDM multilayer native active mask exceeds FMBM u32"))?;
    let mut payload = vec![0u8; FMBM_HEADER_LEN];
    payload[..4].copy_from_slice(b"FMBM");
    payload[4] = 1;
    payload[5] = 1;
    for (axis, count) in descriptor.native_grid.into_iter().enumerate() {
        let offset = 8 + axis * 4;
        payload[offset..offset + 4].copy_from_slice(&count.to_le_bytes());
    }
    payload[20..24].copy_from_slice(&cell_count.to_le_bytes());
    payload[24..28].copy_from_slice(&packed_len.to_le_bytes());
    payload[28..36].copy_from_slice(&layout.layout_revision.to_le_bytes());
    payload[36..68].copy_from_slice(&decode_sha256_hex(&grid_fingerprint)?);
    payload[68..100].copy_from_slice(&decode_sha256_hex(&mask_hash)?);
    payload.extend_from_slice(&packed);

    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "fdm-multilayer-active-mask:{}:{}:{}:{}",
        layer_id, layout.layout_revision, grid_fingerprint, mask_hash,
    ));
    let mut response =
        crate::router_v2::handlers::shared::conditional_binary_response(&headers, &etag, payload);
    insert_response_header(
        &mut response,
        "x-fullmag-grid-fingerprint",
        &format!("sha256:{grid_fingerprint}"),
    );
    insert_response_header(
        &mut response,
        "x-fullmag-mask-hash",
        &format!("sha256:{mask_hash}"),
    );
    insert_response_header(
        &mut response,
        "x-fullmag-layout-revision",
        &layout.layout_revision.to_string(),
    );
    Ok(response)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/domain/fdm-multilayer-layers/{layer_id}/region-membership",
    params(
        ("layer_id" = String, Path, description = "Stable native multilayer layer identity"),
        ("If-None-Match" = Option<String>, Header, description = "Strong ETag from a previous FMRM response"),
        ("Range" = Option<String>, Header, description = "Optional single byte range for the FMRM payload")
    ),
    responses(
        (status = 200, description = "Native-layer realized region membership (FMRM v2)", content_type = "application/octet-stream", headers(
            ("x-fullmag-grid-fingerprint" = String, description = "Exact native grid fingerprint"),
            ("x-fullmag-region-membership-fingerprint" = String, description = "Native membership and legend identity"),
            ("x-fullmag-region-membership-revision" = String, description = "Native membership revision")
        )),
        (status = 206, description = "Partial FMRM payload", content_type = "application/octet-stream"),
        (status = 304, description = "FMRM payload not modified for the supplied ETag"),
        (status = 404, description = "Layer or native region membership is not materialized"),
        (status = 409, description = "Native membership disagrees with layer identity, grid, legend, or payload hash"),
        (status = 416, description = "Requested FMRM byte range is not satisfiable")
    ),
    tag = "data"
)]
pub async fn get_fdm_multilayer_layer_region_membership(
    State(state): State<Arc<AppState>>,
    Path(layer_id): Path<String>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let layout = fdm_multilayer_layout_resource(snapshot)?;
    let descriptor = layout
        .layers
        .iter()
        .find(|layer| layer.layer_id == layer_id)
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "layer_not_found: multilayer FDM layer '{layer_id}' was not found"
            ))
        })?;
    if !descriptor.region_membership_available {
        return Err(ApiError::not_found(format!(
            "quantity_not_materialized: multilayer FDM layer '{layer_id}' has no native region membership"
        )));
    }
    let carrier = load_fdm_multilayer_native_layer_membership(snapshot, &layer_id)?
        .ok_or_else(|| ApiError::not_found("native multilayer membership is not applicable"))?;
    let super::resolved_spatial_field::FdmNativeLayerMembershipCarrier {
        layer_id: carrier_layer_id,
        object_id,
        magnet_name,
        cells,
        origin_m,
        cell_size_m,
        grid_fingerprint,
        membership,
        membership_revision,
        membership_fingerprint,
        legend_fingerprint: _,
    } = carrier;
    if carrier_layer_id != descriptor.layer_id
        || object_id != descriptor.object_id
        || magnet_name != descriptor.magnet_name
        || cells != descriptor.native_grid
        || origin_m != descriptor.native_origin
        || cell_size_m != descriptor.native_cell_size
        || descriptor.native_grid_fingerprint.as_deref() != Some(grid_fingerprint.as_str())
    {
        return Err(ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' membership carrier does not match its layout descriptor"
        )));
    }
    let cell_count = u32::try_from(membership.cell_membership.len())
        .map_err(|_| ApiError::conflict("native membership exceeds FMRM u32"))?;
    let legend_count = u32::try_from(membership.region_legend.len())
        .map_err(|_| ApiError::conflict("native membership legend exceeds FMRM u32"))?;
    let mut payload = vec![0u8; 64];
    payload[..4].copy_from_slice(b"FMRM");
    payload[4] = 2;
    payload[5] = 2;
    for (axis, count) in cells.into_iter().enumerate() {
        let offset = 8 + axis * 4;
        payload[offset..offset + 4].copy_from_slice(&count.to_le_bytes());
    }
    payload[20..24].copy_from_slice(&cell_count.to_le_bytes());
    payload[24..28].copy_from_slice(&legend_count.to_le_bytes());
    let grid_fingerprint_hex = canonical_sha256_hex(&grid_fingerprint)
        .ok_or_else(|| ApiError::conflict("native grid fingerprint is not canonical SHA-256"))?;
    payload[28..60].copy_from_slice(&decode_sha256_hex(&grid_fingerprint_hex)?);
    payload.reserve(membership.cell_membership.len().saturating_mul(4));
    for value in membership.cell_membership {
        payload.extend_from_slice(&value.to_le_bytes());
    }
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "fdm-multilayer-region-membership:{layer_id}:{grid_fingerprint}:{membership_fingerprint}:{membership_revision}"
    ));
    let mut response =
        crate::router_v2::handlers::shared::conditional_binary_response(&headers, &etag, payload);
    insert_response_header(
        &mut response,
        "x-fullmag-grid-fingerprint",
        &grid_fingerprint,
    );
    insert_response_header(
        &mut response,
        "x-fullmag-region-membership-fingerprint",
        &membership_fingerprint,
    );
    insert_response_header(
        &mut response,
        "x-fullmag-region-membership-revision",
        &membership_revision.to_string(),
    );
    Ok(response)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/domain/fdm-multilayer-layers/{layer_id}/region-memberships",
    params(("layer_id" = String, Path, description = "Stable native multilayer layer identity")),
    responses(
        (status = 200, description = "Thin descriptor and complete layer-local legend for native FMRM membership", body = FdmNativeLayerRegionMembershipResource),
        (status = 404, description = "Layer or native membership was not materialized"),
        (status = 409, description = "Declared native membership is stale, missing, corrupt, or disagrees with its layer layout")
    ),
    tag = "data"
)]
pub async fn get_fdm_multilayer_layer_region_memberships(
    State(state): State<Arc<AppState>>,
    Path(layer_id): Path<String>,
) -> Result<Json<FdmNativeLayerRegionMembershipResource>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let layout = fdm_multilayer_layout_resource(snapshot)?;
    let descriptor = layout
        .layers
        .iter()
        .find(|layer| layer.layer_id == layer_id)
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "layer_not_found: multilayer FDM layer '{layer_id}' was not found"
            ))
        })?;
    if !descriptor.region_membership_available {
        return Err(ApiError::not_found(format!(
            "quantity_not_materialized: multilayer FDM layer '{layer_id}' has no native region membership"
        )));
    }
    let carrier =
        load_fdm_multilayer_native_layer_membership(snapshot, &layer_id)?.ok_or_else(|| {
            ApiError::conflict("declared native multilayer membership is unavailable")
        })?;
    if carrier.layer_id != descriptor.layer_id
        || carrier.object_id != descriptor.object_id
        || carrier.magnet_name != descriptor.magnet_name
        || carrier.cells != descriptor.native_grid
        || carrier.origin_m != descriptor.native_origin
        || carrier.cell_size_m != descriptor.native_cell_size
        || descriptor.native_grid_fingerprint.as_deref() != Some(carrier.grid_fingerprint.as_str())
    {
        return Err(ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' membership carrier does not match its layout descriptor"
        )));
    }
    Ok(Json(FdmNativeLayerRegionMembershipResource {
        schema_version: "fdm_multilayer_region_membership.v1".into(),
        layer_id: carrier.layer_id,
        object_id: carrier.object_id,
        magnet_name: carrier.magnet_name,
        region_membership_revision: carrier.membership_revision,
        freshness: "current".into(),
        binary_path: format!(
            "/v2/sessions/current/data/domain/fdm-multilayer-layers/{}/region-membership",
            percent_encode_path_segment(&layer_id)
        ),
        domain_generation_id: layout.domain_generation_id,
        grid_fingerprint: carrier.grid_fingerprint,
        region_legend_fingerprint: carrier.legend_fingerprint,
        origin_m: carrier.origin_m,
        counts: carrier.cells,
        cell_m: carrier.cell_size_m,
        cell_count: carrier.membership.cell_membership.len() as u64,
        object_ids: carrier.membership.object_ids,
        region_legend: carrier.membership.region_legend,
        encoding: "FMRM:u32_membership_le".into(),
    }))
}

fn fdm_multilayer_layout_resource(
    snapshot: &SessionStateResponse,
) -> Result<FdmMultilayerLayoutResource, ApiError> {
    let generation = domain_generation_id(snapshot);
    let revisions = (
        domain_generation_revision(snapshot),
        snapshot.field_samples_revision,
        snapshot.stage_execution_revision,
    );
    let metadata = snapshot.metadata.as_ref();
    let artifact = metadata
        .and_then(|value| value.get("artifact_layout"))
        .filter(|value| value.get("backend").and_then(Value::as_str) == Some("fdm_multilayer"));
    let raw_backend_plan = metadata
        .and_then(|value| value.get("execution_plan"))
        .and_then(|value| value.get("backend_plan"));
    let backend_plan = raw_backend_plan.filter(|value| {
        artifact.is_some()
            || value.get("kind").and_then(Value::as_str) == Some("fdm_multilayer")
            || (value.get("layers").is_some() && value.get("common_cells").is_some())
    });
    let available = artifact.is_some() || backend_plan.is_some();
    if !available {
        return Ok(FdmMultilayerLayoutResource {
            schema_version: "fdm-multilayer-layout.v1".into(),
            domain_generation_id: generation,
            available: false,
            unavailable_reason: Some("not_fdm_multilayer".into()),
            backend: "fdm".into(),
            layout_revision: revisions.0,
            observation_revision: revisions.1,
            execution_revision: revisions.2,
            layout_fingerprint: None,
            strategy: None,
            requested_mode: None,
            resolved_mode: None,
            requested_common_cell_size: None,
            common_transform_layout: None,
            layers: Vec::new(),
            airbox: unavailable_fdm_multilayer_airbox_resource("not_fdm_multilayer"),
        });
    }

    let plan_summary = backend_plan.and_then(|value| value.get("planner_summary"));
    let strategy = plan_summary
        .and_then(|value| value.get("selected_strategy"))
        .and_then(Value::as_str)
        .or_else(|| {
            plan_summary
                .and_then(|value| value.get("requested_strategy"))
                .and_then(Value::as_str)
        })
        .map(str::to_owned);
    let requested_mode = plan_summary
        .and_then(|value| value.get("requested_mode"))
        .and_then(Value::as_str)
        .or_else(|| {
            backend_plan
                .and_then(|value| value.get("mode"))
                .and_then(Value::as_str)
        })
        .map(str::to_owned);
    let resolved_mode = plan_summary
        .and_then(|value| value.get("resolved_mode"))
        .and_then(Value::as_str)
        .or_else(|| {
            backend_plan
                .and_then(|value| value.get("mode"))
                .and_then(Value::as_str)
        })
        .map(str::to_owned);
    let requested_common_cell_size = backend_plan
        .and_then(|value| value.get("requested_common_cell_size"))
        .and_then(value_array3_f64);

    let certificate = backend_plan.and_then(|value| value.get("grid_certificate"));
    let common_shape = backend_plan
        .and_then(|value| value.get("common_cells"))
        .or_else(|| artifact.and_then(|value| value.get("common_cells")))
        .and_then(value_array3_u32)
        .unwrap_or([0, 0, 0]);
    let common_cell_size = certificate
        .and_then(|value| value.get("cell_m"))
        .and_then(value_array3_f64)
        .or_else(|| {
            artifact
                .and_then(|value| value.get("layers"))
                .and_then(Value::as_array)
                .and_then(|layers| layers.first())
                .and_then(|value| value.get("convolution_cell_size"))
                .and_then(value_array3_f64)
        })
        .unwrap_or([0.0, 0.0, 0.0]);
    let common_origin = certificate
        .and_then(|value| value.get("origin_m"))
        .and_then(value_array3_f64)
        .or_else(|| {
            artifact
                .and_then(|value| value.get("layers"))
                .and_then(Value::as_array)
                .and_then(|layers| layers.first())
                .and_then(|value| value.get("convolution_origin"))
                .and_then(value_array3_f64)
        })
        .unwrap_or([0.0, 0.0, 0.0]);
    let common_layout =
        (common_shape.iter().all(|value| *value > 0)).then(|| FdmCommonTransformLayoutResource {
            shape: common_shape,
            cell_size: common_cell_size,
            origin: common_origin,
            fft_shape: common_shape.map(|value| value.saturating_mul(2)),
            is_physical_mesh: false,
            provenance: "planner.grid_certificate;fft-scratch-only".into(),
        });

    let plan_layers = required_multilayer_layers(backend_plan, "execution plan")?;
    let artifact_layers = required_multilayer_layers(artifact, "artifact layout")?;
    let transfer_provenance = metadata
        .and_then(|value| value.get("mesh"))
        .and_then(|value| value.get("transfer_provenance"))
        .and_then(Value::as_array);
    let correlated_layers = if !plan_layers.is_empty() && !artifact_layers.is_empty() {
        correlate_multilayer_layers(&artifact_layers, &plan_layers)?
            .into_iter()
            .map(|(artifact, plan)| (Some(artifact), Some(plan)))
            .collect::<Vec<_>>()
    } else if !plan_layers.is_empty() {
        plan_layers.iter().map(|plan| (None, Some(plan))).collect()
    } else {
        artifact_layers
            .iter()
            .map(|artifact| (Some(artifact), None))
            .collect()
    };
    let layers = correlated_layers
        .into_iter()
        .enumerate()
        .map(|(index, (artifact_layer, plan_layer))| {
            build_fdm_multilayer_layer_layout(
                index,
                artifact_layer,
                plan_layer,
                transfer_provenance,
                common_shape,
                common_cell_size,
                snapshot.region_realization_revisions.membership.max(1),
                &snapshot.field_quantity_revisions,
                snapshot.field_samples_revision.max(1),
            )
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let layout_fingerprint = artifact.or(backend_plan).and_then(|value| {
        serde_json::to_vec(value).ok().map(|bytes| {
            let mut hasher = Sha256::new();
            hasher.update(bytes);
            format!("sha256:{:x}", hasher.finalize())
        })
    });

    Ok(FdmMultilayerLayoutResource {
        schema_version: "fdm-multilayer-layout.v1".into(),
        domain_generation_id: generation,
        available: true,
        unavailable_reason: None,
        backend: "fdm_multilayer".into(),
        layout_revision: revisions.0,
        observation_revision: revisions.1,
        execution_revision: revisions.2,
        layout_fingerprint,
        strategy,
        requested_mode,
        resolved_mode,
        requested_common_cell_size,
        common_transform_layout: common_layout,
        layers,
        airbox: fdm_multilayer_airbox_resource(snapshot, revisions.1),
    })
}

fn unavailable_fdm_multilayer_airbox_resource(reason: &str) -> FdmMultilayerAirboxResource {
    FdmMultilayerAirboxResource {
        carrier_available: false,
        h_demag_available: false,
        h_eff_available: false,
        unavailable_reason: Some(reason.to_string()),
        h_eff_unavailable_reason: Some("fdm_multilayer_airbox_h_eff_unavailable.v1".into()),
        cells: None,
        origin_m: None,
        cell_size_m: None,
        carrier_fingerprint: None,
        sample_count: None,
        value_count: None,
        carrier_revision: None,
        source_policy: None,
        target_only: None,
        source_grid_fingerprints: None,
        source_runtime_identity: None,
    }
}

fn fdm_multilayer_airbox_resource(
    snapshot: &SessionStateResponse,
    observation_revision: u64,
) -> FdmMultilayerAirboxResource {
    match load_fdm_multilayer_airbox_carrier(snapshot) {
        Ok(Some(carrier)) => {
            fdm_multilayer_airbox_resource_from_carrier(carrier, observation_revision)
        }
        Ok(None) => unavailable_fdm_multilayer_airbox_resource("airbox_carrier_missing"),
        Err(reason) => {
            unavailable_fdm_multilayer_airbox_resource(&format!("airbox_carrier_invalid:{reason}"))
        }
    }
}

fn fdm_multilayer_airbox_resource_from_carrier(
    carrier: FdmMultilayerAirboxCarrier,
    observation_revision: u64,
) -> FdmMultilayerAirboxResource {
    FdmMultilayerAirboxResource {
        carrier_available: true,
        h_demag_available: true,
        h_eff_available: false,
        unavailable_reason: None,
        h_eff_unavailable_reason: Some("fdm_multilayer_airbox_h_eff_unavailable.v1".into()),
        cells: Some(carrier.cells),
        origin_m: Some(carrier.origin_m),
        cell_size_m: Some(carrier.cell_size_m),
        carrier_fingerprint: Some(format!("sha256:{}", carrier.carrier_fingerprint)),
        sample_count: Some(carrier.sample_count as u64),
        value_count: Some(carrier.values.len() as u64),
        carrier_revision: Some(observation_revision),
        source_policy: Some(carrier.source_policy),
        target_only: Some(true),
        source_grid_fingerprints: Some(
            carrier
                .source_grid_fingerprints
                .into_iter()
                .map(|fingerprint| format!("sha256:{fingerprint}"))
                .collect(),
        ),
        source_runtime_identity: Some(carrier.source_runtime_identity),
    }
}

fn value_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn required_multilayer_layers(
    owner: Option<&Value>,
    owner_label: &str,
) -> Result<Vec<Value>, ApiError> {
    let Some(owner) = owner else {
        return Ok(Vec::new());
    };
    let layers = owner
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ApiError::conflict(format!(
                "multilayer FDM {owner_label} has no valid native layer array"
            ))
        })?;
    if layers.is_empty() {
        return Err(ApiError::conflict(format!(
            "multilayer FDM {owner_label} has no native layers"
        )));
    }
    Ok(layers.clone())
}

fn build_fdm_multilayer_layer_layout(
    index: usize,
    artifact_layer: Option<&Value>,
    plan_layer: Option<&Value>,
    transfer_provenance: Option<&Vec<Value>>,
    common_shape: [u32; 3],
    common_cell_size: [f64; 3],
    membership_revision: u64,
    field_quantity_revisions: &std::collections::BTreeMap<String, u64>,
    field_samples_revision: u64,
) -> Result<FdmLayerLayoutResource, ApiError> {
    let source = plan_layer.or(artifact_layer).ok_or_else(|| {
        ApiError::conflict("multilayer FDM correlated layer has no source descriptor")
    })?;
    let magnet_name = value_string(source, "magnet_name")
        .or_else(|| artifact_layer.and_then(|value| value_string(value, "magnet_name")))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            ApiError::conflict(format!(
                "multilayer FDM layer at index {index} has no magnet_name"
            ))
        })?;
    let layer_id = value_string(source, "layer_id")
        .or_else(|| value_string(source, "object_id").map(|id| format!("layer:{id}")))
        .unwrap_or_else(|| format!("layer:{index}:{magnet_name}"));
    let object_id =
        value_string(source, "object_id").unwrap_or_else(|| format!("object:{magnet_name}"));

    let native_grid =
        resolve_required_layer_array3_u32(artifact_layer, plan_layer, "native_grid", &layer_id)?;
    if native_grid.iter().any(|value| *value == 0) {
        return Err(ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' native_grid must be positive"
        )));
    }
    let native_cell_size = resolve_required_layer_array3_f64(
        artifact_layer,
        plan_layer,
        "native_cell_size",
        &layer_id,
    )?;
    if native_cell_size
        .iter()
        .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return Err(ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' native_cell_size must be finite and positive"
        )));
    }
    let native_origin =
        resolve_required_layer_array3_f64(artifact_layer, plan_layer, "native_origin", &layer_id)?;
    if native_origin.iter().any(|value| !value.is_finite()) {
        return Err(ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' native_origin must be finite"
        )));
    }
    let total_cells = native_grid
        .iter()
        .try_fold(1u64, |total, count| total.checked_mul(u64::from(*count)))
        .ok_or_else(|| {
            ApiError::conflict(format!(
                "multilayer FDM layer '{layer_id}' native_grid cell count overflows u64"
            ))
        })?;

    let active_mask = parse_planned_native_active_mask(plan_layer, &layer_id, total_cells)?;
    let active_mask_present = active_mask.is_some();
    validate_declared_mask_presence(artifact_layer, plan_layer, &layer_id, active_mask_present)?;
    let active_cell_count = active_mask
        .as_ref()
        .map(|mask| mask.iter().filter(|active| **active).count() as u64)
        .unwrap_or(total_cells);
    let inactive_cell_count = total_cells - active_cell_count;
    validate_declared_layer_counts(
        artifact_layer,
        plan_layer,
        &layer_id,
        total_cells,
        active_cell_count,
        inactive_cell_count,
        active_mask_present,
    )?;

    let convolution_grid = artifact_layer
        .and_then(|value| value.get("convolution_grid"))
        .or_else(|| plan_layer.and_then(|value| value.get("convolution_grid")))
        .map(|value| {
            value_array3_u32(value).ok_or_else(|| {
                ApiError::conflict(format!(
                    "multilayer FDM layer '{layer_id}' has invalid convolution_grid"
                ))
            })
        })
        .transpose()?
        .unwrap_or(common_shape);
    let convolution_cell_size = artifact_layer
        .and_then(|value| value.get("convolution_cell_size"))
        .or_else(|| plan_layer.and_then(|value| value.get("convolution_cell_size")))
        .map(|value| {
            value_array3_f64(value).ok_or_else(|| {
                ApiError::conflict(format!(
                    "multilayer FDM layer '{layer_id}' has invalid convolution_cell_size"
                ))
            })
        })
        .transpose()?
        .unwrap_or(common_cell_size);

    let transfer_fingerprint = transfer_provenance
        .and_then(|entries| {
            entries.iter().find(|entry| {
                value_string(entry, "magnet_name").as_deref() == Some(magnet_name.as_str())
            })
        })
        .and_then(|entry| value_string(entry, "source_grid_fingerprint"))
        .map(|value| validate_layer_fingerprint(value, &layer_id))
        .transpose()?;
    let artifact_fingerprint =
        optional_layer_fingerprint(artifact_layer, "native_grid_fingerprint", &layer_id)?;
    let plan_fingerprint =
        optional_layer_fingerprint(plan_layer, "native_grid_fingerprint", &layer_id)?;
    ensure_optional_strings_agree(
        artifact_fingerprint.as_deref(),
        plan_fingerprint.as_deref(),
        "native_grid_fingerprint",
        &layer_id,
    )?;
    ensure_optional_strings_agree(
        artifact_fingerprint
            .as_deref()
            .or(plan_fingerprint.as_deref()),
        transfer_fingerprint.as_deref(),
        "native_grid_fingerprint",
        &layer_id,
    )?;
    let declared_grid_fingerprint = transfer_fingerprint
        .or(plan_fingerprint)
        .or(artifact_fingerprint);
    let source_grid_fingerprint = match declared_grid_fingerprint {
        Some(fingerprint) => fingerprint,
        None => {
            let topology_tokens = plan_layer
                .and_then(|layer| layer.get("native_region_mask"))
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .map(|value| value.as_u64().and_then(|value| u32::try_from(value).ok()))
                        .collect::<Option<Vec<_>>>()
                })
                .unwrap_or_else(|| Some(Vec::new()))
                .ok_or_else(|| ApiError::conflict(format!(
                    "multilayer FDM layer '{layer_id}' has malformed native_region_mask"
                )))?;
            prefixed_fingerprint(
                fullmag_ir::FdmGridCertificateIR::new_with_topology_tokens(
                    native_origin,
                    native_grid,
                    native_cell_size,
                    active_cell_count,
                    1,
                    active_mask.as_deref(),
                    &topology_tokens,
                )
                .map_err(|error| {
                    ApiError::conflict(format!(
                        "multilayer FDM layer '{layer_id}' cannot establish a native grid fingerprint: {error}"
                    ))
                })?
                .grid_fingerprint,
            )
        }
    };
    let (
        region_membership_available,
        region_membership_revision,
        region_mask_hash,
        region_legend_hash,
        region_membership_generation_id,
    ) = native_region_membership_summary(
        artifact_layer,
        plan_layer,
        &layer_id,
        membership_revision,
    )?;
    let (available_material_quantities, material_field_revisions) =
        native_material_field_summary(
            artifact_layer,
            plan_layer,
            &layer_id,
            field_quantity_revisions,
            field_samples_revision,
        )?;

    Ok(FdmLayerLayoutResource {
        layer_id: layer_id.clone(),
        object_id,
        magnet_name,
        native_grid,
        native_cell_size,
        native_origin,
        native_grid_fingerprint: Some(source_grid_fingerprint),
        convolution_grid,
        convolution_cell_size,
        transfer_kind: value_string(source, "transfer_kind")
            .or_else(|| artifact_layer.and_then(|value| value_string(value, "transfer_kind")))
            .unwrap_or_else(|| "identity".into()),
        active_mask_present,
        active_cell_count,
        inactive_cell_count,
        active_mask_hash: active_mask
            .as_ref()
            .map(|mask| format!("sha256:{:x}", Sha256::digest(pack_native_active_mask(mask)))),
        mask_ref: active_mask.as_ref().map(|_| {
            format!(
                "/v2/sessions/current/data/domain/fdm-multilayer-layers/{}/active-mask",
                percent_encode_path_segment(&layer_id),
            )
        }),
        mask_provenance: active_mask
            .is_some()
            .then(|| "execution_plan.layers.native_active_mask".into()),
        region_membership_available,
        region_membership_revision,
        region_mask_hash,
        region_legend_hash,
        region_membership_generation_id,
        region_membership_ref: region_membership_available.then(|| {
            format!(
                "/v2/sessions/current/data/domain/fdm-multilayer-layers/{}/region-membership",
                percent_encode_path_segment(&layer_id),
            )
        }),
        available_material_quantities,
        material_field_revisions,
    })
}

#[allow(clippy::type_complexity)]
fn native_region_membership_summary(
    artifact_layer: Option<&Value>,
    plan_layer: Option<&Value>,
    layer_id: &str,
    membership_revision: u64,
) -> Result<
    (
        bool,
        Option<u64>,
        Option<String>,
        Option<String>,
        Option<String>,
    ),
    ApiError,
> {
    if let Some(plan_layer) = plan_layer {
        let Some(mask) = plan_layer.get("native_region_mask").and_then(Value::as_array) else {
            return Ok((false, None, None, None, None));
        };
        let legend = plan_layer
            .get("native_region_legend")
            .and_then(Value::as_array)
            .ok_or_else(|| ApiError::conflict(format!(
                "multilayer FDM layer '{layer_id}' native_region_mask requires native_region_legend"
            )))?;
        let mask_values = mask
            .iter()
            .map(|value| value.as_u64().and_then(|value| u32::try_from(value).ok()))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| ApiError::conflict(format!(
                "multilayer FDM layer '{layer_id}' has malformed native_region_mask"
            )))?;
        let mask_hash = format!("sha256:{:x}", Sha256::digest(
            mask_values.iter().flat_map(|value| value.to_le_bytes()).collect::<Vec<_>>()
        ));
        let legend_hash = format!("sha256:{:x}", Sha256::digest(
            serde_json::to_vec(legend).map_err(|error| ApiError::conflict(format!(
                "failed to canonicalize multilayer legend: {error}"
            )))?
        ));
        let revision = membership_revision;
        let generation = format!("sha256:{:x}", Sha256::digest(format!(
            "{layer_id}:{mask_hash}:{legend_hash}:{revision}"
        ).as_bytes()));
        return Ok((true, Some(revision), Some(mask_hash), Some(legend_hash), Some(generation)));
    }
    let mask = artifact_layer.and_then(|layer| layer.get("native_region_mask"));
    let legend = artifact_layer.and_then(|layer| layer.get("native_region_legend"));
    match (mask, legend) {
        (None, None) => Ok((false, None, None, None, None)),
        (Some(mask), Some(legend)) => {
            if mask.get("available").and_then(Value::as_bool) != Some(true)
                || legend.get("available").and_then(Value::as_bool) != Some(true)
            {
                return Err(ApiError::conflict(format!(
                    "multilayer FDM layer '{layer_id}' has incomplete native region membership availability"
                )));
            }
            let revision = mask
                .get("revision")
                .and_then(Value::as_u64)
                .filter(|revision| *revision > 0)
                .ok_or_else(|| {
                    ApiError::conflict(format!(
                        "multilayer FDM layer '{layer_id}' has invalid native membership revision"
                    ))
                })?;
            if legend.get("revision").and_then(Value::as_u64) != Some(revision) {
                return Err(ApiError::conflict(format!(
                    "multilayer FDM layer '{layer_id}' mask and legend revisions disagree"
                )));
            }
            let generation = value_string(mask, "generation_id").ok_or_else(|| {
                ApiError::conflict(format!(
                    "multilayer FDM layer '{layer_id}' has no native membership generation"
                ))
            })?;
            if value_string(legend, "generation_id").as_deref() != Some(generation.as_str()) {
                return Err(ApiError::conflict(format!(
                    "multilayer FDM layer '{layer_id}' mask and legend generations disagree"
                )));
            }
            let mask_hash = value_string(mask, "value_sha256")
                .map(|value| validate_layer_fingerprint(value, layer_id))
                .transpose()?
                .ok_or_else(|| {
                    ApiError::conflict(format!(
                        "multilayer FDM layer '{layer_id}' has no native region mask hash"
                    ))
                })?;
            let legend_hash = value_string(legend, "legend_sha256")
                .map(|value| validate_layer_fingerprint(value, layer_id))
                .transpose()?
                .ok_or_else(|| {
                    ApiError::conflict(format!(
                        "multilayer FDM layer '{layer_id}' has no native region legend hash"
                    ))
                })?;
            Ok((
                true,
                Some(revision),
                Some(mask_hash),
                Some(legend_hash),
                Some(generation),
            ))
        }
        _ => Err(ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' has only one half of native region membership"
        ))),
    }
}

fn native_material_field_summary(
    artifact_layer: Option<&Value>,
    plan_layer: Option<&Value>,
    layer_id: &str,
    field_quantity_revisions: &std::collections::BTreeMap<String, u64>,
    field_samples_revision: u64,
) -> Result<(Vec<String>, HashMap<String, u64>), ApiError> {
    if let Some(plan_layer) = plan_layer {
        let material = plan_layer.get("material");
        let mut quantities = Vec::new();
        let mut revisions = HashMap::new();
        for (quantity_id, key) in [
            ("mat_ms", "ms_field"),
            ("mat_aex", "a_field"),
            ("mat_alpha", "alpha_field"),
        ] {
            if material.and_then(|value| value.get(key)).and_then(Value::as_array).is_some() {
                quantities.push(quantity_id.to_string());
                revisions.insert(
                    quantity_id.to_string(),
                    field_quantity_revisions
                        .get(quantity_id)
                        .copied()
                        .unwrap_or(field_samples_revision)
                        .max(1),
                );
            }
        }
        return Ok((quantities, revisions));
    }
    let Some(fields) = artifact_layer
        .and_then(|layer| layer.get("material_fields"))
        .and_then(Value::as_object)
    else {
        return Ok((Vec::new(), HashMap::new()));
    };
    let mut quantities = Vec::new();
    let mut revisions = HashMap::new();
    for (quantity_id, descriptor) in fields {
        if !matches!(quantity_id.as_str(), "mat_ms" | "mat_aex" | "mat_alpha") {
            return Err(ApiError::conflict(format!(
                "multilayer FDM layer '{layer_id}' publishes unsupported material quantity '{quantity_id}'"
            )));
        }
        if descriptor.get("available").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let revision = descriptor
            .get("revision")
            .and_then(Value::as_u64)
            .filter(|revision| *revision > 0)
            .ok_or_else(|| ApiError::conflict(format!(
                "multilayer FDM layer '{layer_id}' material quantity '{quantity_id}' has invalid revision"
            )))?;
        quantities.push(quantity_id.clone());
        revisions.insert(quantity_id.clone(), revision);
    }
    quantities.sort();
    Ok((quantities, revisions))
}

fn resolve_required_layer_array3_u32(
    artifact_layer: Option<&Value>,
    plan_layer: Option<&Value>,
    key: &str,
    layer_id: &str,
) -> Result<[u32; 3], ApiError> {
    let artifact = optional_layer_array3_u32(artifact_layer, key, layer_id)?;
    let plan = optional_layer_array3_u32(plan_layer, key, layer_id)?;
    if let (Some(artifact), Some(plan)) = (artifact, plan) {
        if artifact != plan {
            return Err(ApiError::conflict(format!(
                "multilayer FDM layer '{layer_id}' artifact and execution plan {key} disagree"
            )));
        }
    }
    plan.or(artifact).ok_or_else(|| {
        ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' has no valid {key}"
        ))
    })
}

fn resolve_required_layer_array3_f64(
    artifact_layer: Option<&Value>,
    plan_layer: Option<&Value>,
    key: &str,
    layer_id: &str,
) -> Result<[f64; 3], ApiError> {
    let artifact = optional_layer_array3_f64(artifact_layer, key, layer_id)?;
    let plan = optional_layer_array3_f64(plan_layer, key, layer_id)?;
    if let (Some(artifact), Some(plan)) = (artifact, plan) {
        if artifact != plan {
            return Err(ApiError::conflict(format!(
                "multilayer FDM layer '{layer_id}' artifact and execution plan {key} disagree"
            )));
        }
    }
    plan.or(artifact).ok_or_else(|| {
        ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' has no valid {key}"
        ))
    })
}

fn optional_layer_array3_u32(
    layer: Option<&Value>,
    key: &str,
    layer_id: &str,
) -> Result<Option<[u32; 3]>, ApiError> {
    let Some(value) = layer.and_then(|layer| layer.get(key)) else {
        return Ok(None);
    };
    value_array3_u32(value).map(Some).ok_or_else(|| {
        ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' has invalid {key}"
        ))
    })
}

fn optional_layer_array3_f64(
    layer: Option<&Value>,
    key: &str,
    layer_id: &str,
) -> Result<Option<[f64; 3]>, ApiError> {
    let Some(value) = layer.and_then(|layer| layer.get(key)) else {
        return Ok(None);
    };
    value_array3_f64(value).map(Some).ok_or_else(|| {
        ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' has invalid {key}"
        ))
    })
}

fn parse_planned_native_active_mask(
    plan_layer: Option<&Value>,
    layer_id: &str,
    total_cells: u64,
) -> Result<Option<Vec<bool>>, ApiError> {
    let Some(mask_value) = plan_layer.and_then(|layer| layer.get("native_active_mask")) else {
        return Ok(None);
    };
    let values = mask_value.as_array().ok_or_else(|| {
        ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' native_active_mask must be a boolean array"
        ))
    })?;
    let mask = value_bool_mask(values).ok_or_else(|| {
        ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' native_active_mask contains non-boolean values"
        ))
    })?;
    if mask.len() as u64 != total_cells {
        return Err(ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' native_active_mask length disagrees with native_grid"
        )));
    }
    Ok(Some(mask))
}

fn validate_declared_mask_presence(
    artifact_layer: Option<&Value>,
    plan_layer: Option<&Value>,
    layer_id: &str,
    materialized: bool,
) -> Result<(), ApiError> {
    for (owner, owner_label) in [(artifact_layer, "artifact"), (plan_layer, "execution plan")] {
        let Some(value) = owner.and_then(|layer| layer.get("active_mask_present")) else {
            continue;
        };
        let declared = value.as_bool().ok_or_else(|| {
            ApiError::conflict(format!(
                "multilayer FDM layer '{layer_id}' {owner_label} active_mask_present is not boolean"
            ))
        })?;
        if declared != materialized {
            return Err(ApiError::conflict(format!(
                "multilayer FDM layer '{layer_id}' {owner_label} active_mask_present disagrees with materialized native_active_mask"
            )));
        }
    }
    Ok(())
}

fn validate_declared_layer_counts(
    artifact_layer: Option<&Value>,
    plan_layer: Option<&Value>,
    layer_id: &str,
    total_cells: u64,
    active_cell_count: u64,
    inactive_cell_count: u64,
    active_mask_present: bool,
) -> Result<(), ApiError> {
    for (key, expected) in [
        ("total_cell_count", total_cells),
        ("active_cell_count", active_cell_count),
        ("inactive_cell_count", inactive_cell_count),
    ] {
        for (owner, owner_label) in [(artifact_layer, "artifact"), (plan_layer, "execution plan")] {
            let Some(value) = owner.and_then(|layer| layer.get(key)) else {
                continue;
            };
            let declared = value.as_u64().ok_or_else(|| {
                ApiError::conflict(format!(
                    "multilayer FDM layer '{layer_id}' {owner_label} {key} is not a non-negative integer"
                ))
            })?;
            if declared != expected {
                return Err(ApiError::conflict(format!(
                    "multilayer FDM layer '{layer_id}' {owner_label} {key} disagrees with native geometry and active mask"
                )));
            }
        }
    }
    if !active_mask_present && active_cell_count != total_cells {
        return Err(ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' has partial counts without a materialized native_active_mask"
        )));
    }
    Ok(())
}

fn optional_layer_fingerprint(
    layer: Option<&Value>,
    key: &str,
    layer_id: &str,
) -> Result<Option<String>, ApiError> {
    let Some(value) = layer.and_then(|layer| layer.get(key)) else {
        return Ok(None);
    };
    let value = value.as_str().ok_or_else(|| {
        ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' has invalid {key}"
        ))
    })?;
    Ok(Some(validate_layer_fingerprint(
        value.to_owned(),
        layer_id,
    )?))
}

fn validate_layer_fingerprint(value: String, layer_id: &str) -> Result<String, ApiError> {
    canonical_sha256_hex(&value)
        .map(|hex| format!("sha256:{hex}"))
        .ok_or_else(|| {
            ApiError::conflict(format!(
                "multilayer FDM layer '{layer_id}' native_grid_fingerprint must be canonical SHA-256"
            ))
        })
}

fn ensure_optional_strings_agree(
    left: Option<&str>,
    right: Option<&str>,
    key: &str,
    layer_id: &str,
) -> Result<(), ApiError> {
    let (Some(left), Some(right)) = (left, right) else {
        return Ok(());
    };
    if left != right {
        return Err(ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' {key} declarations disagree"
        )));
    }
    Ok(())
}

fn prefixed_fingerprint(fingerprint: String) -> String {
    if fingerprint.starts_with("sha256:") {
        fingerprint
    } else {
        format!("sha256:{fingerprint}")
    }
}

fn value_array3_u32(value: &Value) -> Option<[u32; 3]> {
    let values = value.as_array()?;
    if values.len() != 3 {
        return None;
    }
    Some([
        u32::try_from(values.first()?.as_u64()?).ok()?,
        u32::try_from(values.get(1)?.as_u64()?).ok()?,
        u32::try_from(values.get(2)?.as_u64()?).ok()?,
    ])
}

fn value_array3_f64(value: &Value) -> Option<[f64; 3]> {
    let values = value.as_array()?;
    if values.len() != 3 {
        return None;
    }
    Some([
        values.first()?.as_f64()?,
        values.get(1)?.as_f64()?,
        values.get(2)?.as_f64()?,
    ])
}

fn value_bool_mask(values: &[Value]) -> Option<Vec<bool>> {
    values.iter().map(Value::as_bool).collect()
}

fn planned_native_active_mask(
    snapshot: &SessionStateResponse,
    requested_layer_id: &str,
) -> Result<Option<Vec<bool>>, ApiError> {
    let layers = snapshot
        .metadata
        .as_ref()
        .and_then(|value| value.get("execution_plan"))
        .and_then(|value| value.get("backend_plan"))
        .and_then(|value| value.get("layers"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ApiError::not_found("FDM multilayer execution plan has no native layer masks")
        })?;
    for (index, layer) in layers.iter().enumerate() {
        let magnet_name =
            value_string(layer, "magnet_name").unwrap_or_else(|| format!("layer-{index}"));
        let layer_id = value_string(layer, "layer_id")
            .or_else(|| value_string(layer, "object_id").map(|id| format!("layer:{id}")))
            .unwrap_or_else(|| format!("layer:{index}:{magnet_name}"));
        if layer_id != requested_layer_id {
            continue;
        }
        let Some(values) = layer.get("native_active_mask").and_then(Value::as_array) else {
            return Ok(None);
        };
        return value_bool_mask(values).map(Some).ok_or_else(|| {
            ApiError::conflict(format!(
                "FDM multilayer layer '{requested_layer_id}' active mask contains non-boolean values"
            ))
        });
    }
    Ok(None)
}

fn pack_native_active_mask(mask: &[bool]) -> Vec<u8> {
    let mut packed = vec![0u8; mask.len().div_ceil(8)];
    for (cell_index, active) in mask.iter().copied().enumerate() {
        if active {
            packed[cell_index / 8] |= 1 << (cell_index % 8);
        }
    }
    packed
}

fn canonical_sha256_hex(value: &str) -> Option<String> {
    let hex = value.strip_prefix("sha256:").unwrap_or(value);
    (hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| hex.to_ascii_lowercase())
}

fn decode_sha256_hex(value: &str) -> Result<[u8; 32], ApiError> {
    let canonical = canonical_sha256_hex(value)
        .ok_or_else(|| ApiError::conflict("invalid SHA-256 fingerprint in FMBM identity"))?;
    let mut decoded = [0u8; 32];
    for (index, target) in decoded.iter_mut().enumerate() {
        *target = u8::from_str_radix(&canonical[index * 2..index * 2 + 2], 16)
            .map_err(|_| ApiError::conflict("invalid SHA-256 fingerprint in FMBM identity"))?;
    }
    Ok(decoded)
}

fn percent_encode_path_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn insert_response_header(
    response: &mut axum::response::Response,
    name: &'static str,
    value: &str,
) {
    if let Ok(value) = HeaderValue::from_str(value) {
        response
            .headers_mut()
            .insert(HeaderName::from_static(name), value);
    }
}

fn fem_element_type(mesh: &fullmag_runner::FemMeshPayload) -> Option<String> {
    let first = *mesh.cells.types.first()?;
    if mesh.cells.types.iter().any(|cell_type| *cell_type != first) {
        return Some("mixed".to_string());
    }
    Some(
        match first {
            fullmag_ir::FemCellTypeIR::Tet4 => "tetrahedron",
            fullmag_ir::FemCellTypeIR::Prism6 => "prism",
            fullmag_ir::FemCellTypeIR::Pyramid5 => "pyramid",
            fullmag_ir::FemCellTypeIR::Hex8 => "hexahedron",
        }
        .to_string(),
    )
}

#[derive(Debug, Clone, Copy)]
struct FdmGridLayout {
    origin: [f64; 3],
    spacing: [f64; 3],
}

fn fdm_grid_descriptor(snapshot: &SessionStateResponse) -> FdmGridLayout {
    let (origin, spacing) =
        fdm_grid_geometry(snapshot).unwrap_or(([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]));

    FdmGridLayout { origin, spacing }
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
        domain_generation_id: domain_generation_id.to_string(),
        etag: etag.clone(),
    };

    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &body))
}
