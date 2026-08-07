//! Realized single-grid FDM region membership resources.
//!
//! The descriptor is thin JSON; the cell mask is served as a versioned FMRM
//! binary payload and can be filtered to one canonical region ID.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::header::{HeaderName, HeaderValue};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::artifacts::{read_json_artifact_value, resolve_artifact_path};
use crate::error::ApiError;
use crate::schemas::mesh::{
    FdmMagneticSupportSemanticRole, FdmMagneticSupportSummaryResource,
    FdmRegionLegendEntryResource, FdmRegionMembershipResource,
};
use crate::router_v2::handlers::data::field_resolution::is_fdm_snapshot;
use crate::router_v2::handlers::sessions::status::{
    fdm_grid_fingerprint, fdm_grid_geometry, fdm_grid_shape,
};
use crate::session::current_artifact_dir;
use crate::types::{AppState, SessionStateResponse};

const FMRM_HEADER_LEN: usize = 64;

#[derive(Debug, Default, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct FdmRegionMembershipScopeQuery {
    /// Canonical object owner used to disambiguate duplicate region IDs.
    pub owner_object_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FdmMembershipArtifactDescriptor {
    schema_version: String,
    binary_path: String,
    #[serde(default)]
    domain_generation_id: Option<String>,
    grid_fingerprint: String,
    #[serde(default)]
    region_legend_fingerprint: Option<String>,
    origin_m: [f64; 3],
    counts: [u32; 3],
    cell_m: [f64; 3],
    cell_count: u64,
    #[serde(default)]
    magnetic_support: Option<FdmMagneticSupportSummaryResource>,
    #[serde(default)]
    object_ids: Vec<String>,
    region_legend: Vec<FdmRegionLegendEntryResource>,
    encoding: String,
}

pub(super) struct ResolvedFdmMembership {
    pub grid_fingerprint: String,
    pub counts: [u32; 3],
    pub origin_m: [f64; 3],
    pub cell_m: [f64; 3],
    pub object_ids: Vec<String>,
    pub region_legend: Vec<FdmRegionLegendEntryResource>,
    pub cell_membership: Vec<u32>,
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fdm-region-memberships",
    responses(
        (status = 200, description = "Thin descriptor for realized FDM cell membership", body = FdmRegionMembershipResource),
        (status = 204, description = "No realized FDM region membership artifact yet"),
        (status = 404, description = "No active workspace"),
        (status = 409, description = "Persisted membership does not belong to the current FDM domain"),
    ),
    tag = "data"
)]
pub async fn get_fdm_region_memberships(
    State(state): State<Arc<AppState>>,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    if !is_fdm_snapshot(snapshot) {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let descriptor = if has_membership_descriptor_artifact(snapshot) {
        load_descriptor(snapshot)?.0
    } else {
        let resolved = load_resolved_fdm_membership(snapshot)?;
        descriptor_from_resolved_membership(snapshot, &resolved)?
    };
    Ok(Json(to_resource(snapshot, descriptor)).into_response())
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fdm-region-membership",
    params(
        ("If-None-Match" = Option<String>, Header, description = "Strong ETag from a previous FMRM response"),
        ("Range" = Option<String>, Header, description = "Optional single byte range for the FMRM payload")
    ),
    responses(
        (status = 200, description = "Binary realized FDM cell membership (FMRM)", content_type = "application/octet-stream", headers(
            ("x-fullmag-grid-fingerprint" = String, description = "Exact FDM grid fingerprint"),
            ("x-fullmag-domain-generation-id" = String, description = "Exact domain generation identity"),
            ("x-fullmag-region-membership-revision" = String, description = "Current region-membership revision")
        )),
        (status = 206, description = "Partial FMRM payload", content_type = "application/octet-stream", headers(
            ("x-fullmag-grid-fingerprint" = String, description = "Exact FDM grid fingerprint"),
            ("x-fullmag-domain-generation-id" = String, description = "Exact domain generation identity"),
            ("x-fullmag-region-membership-revision" = String, description = "Current region-membership revision")
        )),
        (status = 304, description = "FMRM payload not modified for the supplied ETag"),
        (status = 404, description = "No realized FDM region membership artifact"),
        (status = 409, description = "Persisted membership does not belong to the current FDM domain"),
        (status = 416, description = "Requested FMRM byte range is not satisfiable"),
    ),
    tag = "data"
)]
pub async fn get_fdm_region_membership_binary(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    serve_fdm_region_membership_binary(state, headers, None).await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fdm-region-membership/{region_id}",
    params(
        ("region_id" = String, Path, description = "Canonical authored region ID"),
        FdmRegionMembershipScopeQuery,
        ("If-None-Match" = Option<String>, Header, description = "Strong ETag from a previous scoped FMRM response"),
        ("Range" = Option<String>, Header, description = "Optional single byte range for the FMRM payload")
    ),
    responses(
        (status = 200, description = "Scoped binary realized FDM cell membership (FMRM)", content_type = "application/octet-stream", headers(
            ("x-fullmag-grid-fingerprint" = String, description = "Exact FDM grid fingerprint"),
            ("x-fullmag-domain-generation-id" = String, description = "Exact domain generation identity"),
            ("x-fullmag-region-membership-revision" = String, description = "Current region-membership revision")
        )),
        (status = 206, description = "Partial scoped FMRM payload", content_type = "application/octet-stream", headers(
            ("x-fullmag-grid-fingerprint" = String, description = "Exact FDM grid fingerprint"),
            ("x-fullmag-domain-generation-id" = String, description = "Exact domain generation identity"),
            ("x-fullmag-region-membership-revision" = String, description = "Current region-membership revision")
        )),
        (status = 304, description = "Scoped FMRM payload not modified for the supplied ETag"),
        (status = 404, description = "No realized FDM membership or unknown region ID"),
        (status = 409, description = "Persisted membership does not belong to the current FDM domain"),
        (status = 416, description = "Requested FMRM byte range is not satisfiable"),
    ),
    tag = "data"
)]
pub async fn get_fdm_region_membership_binary_scoped(
    State(state): State<Arc<AppState>>,
    Path(region_id): Path<String>,
    Query(query): Query<FdmRegionMembershipScopeQuery>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    serve_fdm_region_membership_binary(
        state,
        headers,
        Some((query.owner_object_id, region_id)),
    )
    .await
}

async fn serve_fdm_region_membership_binary(
    state: Arc<AppState>,
    headers: HeaderMap,
    region_scope: Option<(Option<String>, String)>,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let (descriptor, original) = if has_membership_descriptor_artifact(snapshot) {
        let (descriptor, artifact_dir) = load_descriptor(snapshot)?;
        let binary_path = resolve_artifact_path(&artifact_dir, &descriptor.binary_path)?;
        let payload = std::fs::read(&binary_path).map_err(|error| {
            ApiError::internal(format!("failed to read FMRM artifact: {error}"))
        })?;
        (descriptor, payload)
    } else {
        let resolved = load_resolved_fdm_membership(snapshot)?;
        let descriptor = descriptor_from_resolved_membership(snapshot, &resolved)?;
        let payload = serialize_resolved_membership_payload(&descriptor, &resolved)?;
        (descriptor, payload)
    };
    let (mut payload, mask_offset) = validate_fmrm_payload(&original, &descriptor)?;

    let selected_region = if let Some((owner_object_id, region_id)) = region_scope.as_ref() {
        let mut entries = descriptor
            .region_legend
            .iter()
            .filter(|entry| {
                entry.region_id == region_id.as_str()
                    && owner_object_id
                        .as_deref()
                        .map(|owner| entry.object_id == owner)
                        .unwrap_or(true)
            });
        let entry = entries.next().ok_or_else(|| {
            ApiError::not_found(match owner_object_id.as_deref() {
                Some(owner) => format!("FDM region '{owner}/{region_id}' not found"),
                None => format!("FDM region '{region_id}' not found"),
            })
        })?;
        if entries.next().is_some() {
            return Err(ApiError::conflict(format!(
                "FDM region '{region_id}' is ambiguous; provide owner_object_id"
            )));
        }
        Some((entry.numeric_id, format!("region:{}:{}", entry.object_id, entry.region_id)))
    } else {
        None
    };
    if let Some((numeric_id, _)) = selected_region.as_ref() {
        for chunk in payload[mask_offset..].chunks_exact_mut(4) {
            let value = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            if value != *numeric_id {
                let empty = if descriptor.schema_version == "fdm_region_membership.v2" {
                    u32::MAX
                } else {
                    0
                };
                chunk.copy_from_slice(&empty.to_le_bytes());
            }
        }
    }

    let payload_hash = Sha256::digest(&payload);
    let scope = selected_region
        .as_ref()
        .map(|(_, scope)| scope.as_str())
        .unwrap_or("all");
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "fdm-membership:{}:{}:{}:{:x}",
        descriptor.grid_fingerprint,
        snapshot.region_realization_revisions.membership,
        scope,
        payload_hash,
    ));
    let mut response =
        crate::router_v2::handlers::shared::conditional_binary_response(&headers, &etag, payload);
    insert_header(
        &mut response,
        "x-fullmag-grid-fingerprint",
        &descriptor.grid_fingerprint,
    );
    insert_header(
        &mut response,
        "x-fullmag-domain-generation-id",
        descriptor
            .domain_generation_id
            .as_deref()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                crate::router_v2::handlers::sessions::status::domain_generation_id(snapshot)
            })
            .as_str(),
    );
    insert_header(
        &mut response,
        "x-fullmag-region-membership-revision",
        &snapshot.region_realization_revisions.membership.to_string(),
    );
    Ok(response)
}

fn load_descriptor(
    snapshot: &SessionStateResponse,
) -> Result<(FdmMembershipArtifactDescriptor, PathBuf), ApiError> {
    let artifact_dir = current_artifact_dir(snapshot)
        .ok_or_else(|| ApiError::not_found("no artifact directory for the active workspace"))?;
    let descriptor_path = if artifact_dir
        .join("mesh/fdm_region_membership.v2.json")
        .is_file()
    {
        "mesh/fdm_region_membership.v2.json"
    } else {
        "mesh/fdm_region_membership.v1.json"
    };
    let descriptor_value = read_json_artifact_value(&artifact_dir, descriptor_path)?;
    let mut descriptor: FdmMembershipArtifactDescriptor = serde_json::from_value(descriptor_value)
        .map_err(|error| {
            ApiError::internal(format!("invalid FDM membership descriptor: {error}"))
        })?;
    let supported = matches!(
        (
            descriptor.schema_version.as_str(),
            descriptor.encoding.as_str()
        ),
        ("fdm_region_membership.v1", "FMRM:u32_le")
            | ("fdm_region_membership.v2", "FMRM:u32_membership_le")
    );
    if !supported {
        return Err(ApiError::internal(
            "unsupported FDM region membership descriptor schema",
        ));
    }
    validate_descriptor_summary(&descriptor)?;
    validate_descriptor_for_current_domain(snapshot, &descriptor)?;
    if descriptor.magnetic_support.is_some() {
        let binary_path = resolve_artifact_path(&artifact_dir, &descriptor.binary_path)?;
        let binary = std::fs::read(&binary_path).map_err(|error| {
            ApiError::internal(format!(
                "FDM magnetic-support summary requires its FMRM binary artifact: {error}"
            ))
        })?;
        let (payload, mask_offset) = validate_fmrm_payload(&binary, &descriptor)?;
        validate_summary_against_fmrm(&descriptor, &payload[mask_offset..])?;
    } else {
        // Backfill magnetic_support from binary mask for legacy descriptors.
        let binary_path = resolve_artifact_path(&artifact_dir, &descriptor.binary_path);
        if let Ok(binary_path) = binary_path {
            if let Ok(binary) = std::fs::read(&binary_path) {
                if let Ok((payload, mask_offset)) = validate_fmrm_payload(&binary, &descriptor) {
                    let mask_bytes = &payload[mask_offset..];
                    let nx = descriptor.counts[0] as usize;
                    let ny = descriptor.counts[1] as usize;
                    let plane_stride = nx * ny;
                    let mut support_min = [u32::MAX; 3];
                    let mut support_max_exclusive = [0u32; 3];
                    let mut active = 0u64;
                    let mut inactive = 0u64;
                    let mut active_unassigned = 0u64;

                    for (index, chunk) in mask_bytes.chunks_exact(4).enumerate() {
                        let membership = u32::from_le_bytes(chunk.try_into().unwrap());
                        if membership == u32::MAX {
                            inactive += 1;
                            continue;
                        }
                        active += 1;
                        if membership == 0 {
                            active_unassigned += 1;
                        }
                        let coords = [
                            (index % nx) as u32,
                            ((index / nx) % ny) as u32,
                            (index / plane_stride) as u32,
                        ];
                        for (axis, coord) in coords.into_iter().enumerate() {
                            support_min[axis] = support_min[axis].min(coord);
                            support_max_exclusive[axis] =
                                support_max_exclusive[axis].max(coord + 1);
                        }
                    }

                    if active > 0 && inactive > 0 {
                        let bounds_min_m: [f64; 3] = std::array::from_fn(|axis| {
                            descriptor.origin_m[axis]
                                + f64::from(support_min[axis]) * descriptor.cell_m[axis]
                        });
                        let bounds_max_m: [f64; 3] = std::array::from_fn(|axis| {
                            descriptor.origin_m[axis]
                                + f64::from(support_max_exclusive[axis])
                                    * descriptor.cell_m[axis]
                        });
                        descriptor.magnetic_support =
                            Some(FdmMagneticSupportSummaryResource {
                                semantic_role:
                                    FdmMagneticSupportSemanticRole::MagneticSupport,
                                grid_fingerprint: descriptor.grid_fingerprint.clone(),
                                bounds_min_m,
                                bounds_max_m,
                                active_cell_count: active,
                                inactive_cell_count: inactive,
                                active_unassigned_cell_count: active_unassigned,
                            });
                    }
                }
            }
        }
    }
    Ok((descriptor, artifact_dir))
}

fn has_membership_descriptor_artifact(snapshot: &SessionStateResponse) -> bool {
    current_artifact_dir(snapshot).is_some_and(|artifact_dir| {
        artifact_dir
            .join("mesh/fdm_region_membership.v2.json")
            .is_file()
            || artifact_dir
                .join("mesh/fdm_region_membership.v1.json")
                .is_file()
    })
}

fn descriptor_from_resolved_membership(
    snapshot: &SessionStateResponse,
    resolved: &ResolvedFdmMembership,
) -> Result<FdmMembershipArtifactDescriptor, ApiError> {
    let cell_count = u64::try_from(resolved.cell_membership.len())
        .map_err(|_| ApiError::internal("FDM membership cell count exceeds u64"))?;
    let expected_cell_count = resolved
        .counts
        .into_iter()
        .try_fold(1u64, |product, count| product.checked_mul(u64::from(count)))
        .ok_or_else(|| ApiError::internal("FDM membership grid cell count overflows u64"))?;
    if cell_count != expected_cell_count {
        return Err(ApiError::conflict(
            "planned FDM membership length does not match the execution-plan grid",
        ));
    }
    let legend_json = serde_json::to_vec(&resolved.region_legend)
        .map_err(|error| ApiError::internal(format!("failed to encode FDM region legend: {error}")))?;
    let legend_hash = Sha256::digest(legend_json);

    // Compute magnetic-support summary from the cell membership mask.
    let magnetic_support = {
        let nx = resolved.counts[0] as usize;
        let ny = resolved.counts[1] as usize;
        let plane_stride = nx * ny;
        let mut support_min = [u32::MAX; 3];
        let mut support_max_exclusive = [0u32; 3];
        let mut active = 0u64;
        let mut inactive = 0u64;
        let mut active_unassigned = 0u64;

        for (index, &membership) in resolved.cell_membership.iter().enumerate() {
            if membership == u32::MAX {
                inactive += 1;
                continue;
            }
            active += 1;
            if membership == 0 {
                active_unassigned += 1;
            }
            let coords = [
                (index % nx) as u32,
                ((index / nx) % ny) as u32,
                (index / plane_stride) as u32,
            ];
            for (axis, coord) in coords.into_iter().enumerate() {
                support_min[axis] = support_min[axis].min(coord);
                support_max_exclusive[axis] = support_max_exclusive[axis].max(coord + 1);
            }
        }

        if active > 0 && inactive > 0 {
            let bounds_min_m: [f64; 3] = std::array::from_fn(|axis| {
                resolved.origin_m[axis]
                    + f64::from(support_min[axis]) * resolved.cell_m[axis]
            });
            let bounds_max_m: [f64; 3] = std::array::from_fn(|axis| {
                resolved.origin_m[axis]
                    + f64::from(support_max_exclusive[axis]) * resolved.cell_m[axis]
            });
            Some(FdmMagneticSupportSummaryResource {
                semantic_role: FdmMagneticSupportSemanticRole::MagneticSupport,
                grid_fingerprint: resolved.grid_fingerprint.clone(),
                bounds_min_m,
                bounds_max_m,
                active_cell_count: active,
                inactive_cell_count: inactive,
                active_unassigned_cell_count: active_unassigned,
            })
        } else {
            None
        }
    };

    let descriptor = FdmMembershipArtifactDescriptor {
        schema_version: "fdm_region_membership.v2".to_string(),
        binary_path: "mesh/fdm_region_membership.v2.bin".to_string(),
        domain_generation_id: Some(
            crate::router_v2::handlers::sessions::status::domain_generation_id(snapshot),
        ),
        grid_fingerprint: resolved.grid_fingerprint.clone(),
        region_legend_fingerprint: Some(format!("sha256:{legend_hash:x}")),
        origin_m: resolved.origin_m,
        counts: resolved.counts,
        cell_m: resolved.cell_m,
        cell_count,
        magnetic_support,
        object_ids: resolved.object_ids.clone(),
        region_legend: resolved.region_legend.clone(),
        encoding: "FMRM:u32_membership_le".to_string(),
    };
    validate_descriptor_summary(&descriptor)?;
    Ok(descriptor)
}

fn serialize_resolved_membership_payload(
    descriptor: &FdmMembershipArtifactDescriptor,
    membership: &ResolvedFdmMembership,
) -> Result<Vec<u8>, ApiError> {
    let resolved = decode_hex32(&descriptor.grid_fingerprint)
        .ok_or_else(|| ApiError::internal("invalid planned FDM grid fingerprint"))?;
    let snapshot_membership = descriptor
        .region_legend
        .iter()
        .map(|entry| entry.numeric_id)
        .collect::<std::collections::BTreeSet<_>>();
    if membership.cell_membership.iter().any(|value| {
        *value != u32::MAX && *value != 0 && !snapshot_membership.contains(value)
    }) {
        return Err(ApiError::internal(
            "planned FDM membership references an unknown region legend entry",
        ));
    }
    let mut payload = vec![0u8; FMRM_HEADER_LEN];
    payload[..4].copy_from_slice(b"FMRM");
    payload[4] = 2;
    payload[5] = 2;
    for (axis, count) in descriptor.counts.into_iter().enumerate() {
        let offset = 8 + axis * 4;
        payload[offset..offset + 4].copy_from_slice(&count.to_le_bytes());
    }
    let cell_count = u32::try_from(descriptor.cell_count)
        .map_err(|_| ApiError::internal("FDM membership cell count exceeds FMRM u32"))?;
    payload[20..24].copy_from_slice(&cell_count.to_le_bytes());
    let legend_count = u32::try_from(descriptor.region_legend.len())
        .map_err(|_| ApiError::internal("FDM region legend count exceeds FMRM u32"))?;
    payload[24..28].copy_from_slice(&legend_count.to_le_bytes());
    payload[28..60].copy_from_slice(&resolved);
    payload.reserve(membership.cell_membership.len().saturating_mul(4));
    for value in &membership.cell_membership {
        payload.extend_from_slice(&value.to_le_bytes());
    }
    Ok(payload)
}

fn validate_descriptor_for_current_domain(
    snapshot: &SessionStateResponse,
    descriptor: &FdmMembershipArtifactDescriptor,
) -> Result<(), ApiError> {
    if !is_fdm_snapshot(snapshot) {
        return Err(ApiError::not_found(
            "FDM membership is not applicable to the active backend",
        ));
    }
    let current_counts = fdm_grid_shape(
        snapshot,
        snapshot.live_state.as_ref().map(|state| state.latest_step.grid),
    );
    if descriptor.counts != current_counts {
        return Err(ApiError::conflict(
            "FDM membership descriptor does not match the current FDM domain grid counts",
        ));
    }
    if let Some((current_origin, current_spacing)) = fdm_grid_geometry(snapshot) {
        if (0..3).any(|axis| {
            !same_grid_coordinate(descriptor.origin_m[axis], current_origin[axis])
                || !same_grid_coordinate(descriptor.cell_m[axis], current_spacing[axis])
        }) {
            return Err(ApiError::conflict(
                "FDM membership descriptor does not match the current FDM domain geometry",
            ));
        }
    }
    if let Some(current_fingerprint) = fdm_grid_fingerprint(snapshot) {
        if descriptor.grid_fingerprint != current_fingerprint {
            return Err(ApiError::conflict(
                "FDM membership descriptor does not match the current FDM domain fingerprint",
            ));
        }
    }
    if let Some(artifact_generation_id) = descriptor.domain_generation_id.as_deref() {
        if artifact_generation_id != crate::router_v2::handlers::sessions::status::domain_generation_id(snapshot) {
            return Err(ApiError::conflict(
                "FDM membership descriptor does not match the current FDM domain generation",
            ));
        }
    }
    Ok(())
}

fn same_grid_coordinate(left: f64, right: f64) -> bool {
    let scale = left.abs().max(right.abs()).max(f64::MIN_POSITIVE);
    (left - right).abs() <= 128.0 * f64::EPSILON * scale
}

fn validate_descriptor_summary(
    descriptor: &FdmMembershipArtifactDescriptor,
) -> Result<(), ApiError> {
    let expected_cell_count = descriptor
        .counts
        .into_iter()
        .try_fold(1u64, |product, count| product.checked_mul(u64::from(count)))
        .ok_or_else(|| ApiError::internal("FDM membership grid cell count overflows u64"))?;
    if descriptor.counts.contains(&0) || descriptor.cell_count != expected_cell_count {
        return Err(ApiError::internal(
            "FDM membership descriptor grid counts do not match cell_count",
        ));
    }
    for axis in 0..3 {
        if !descriptor.origin_m[axis].is_finite()
            || !descriptor.cell_m[axis].is_finite()
            || descriptor.cell_m[axis] <= 0.0
        {
            return Err(ApiError::internal(
                "FDM membership descriptor grid geometry is invalid",
            ));
        }
    }

    let Some(summary) = descriptor.magnetic_support.as_ref() else {
        return Ok(());
    };
    if descriptor.schema_version != "fdm_region_membership.v2" {
        return Err(ApiError::internal(
            "FDM magnetic-support summary requires the v2 membership contract",
        ));
    }
    if summary.grid_fingerprint != descriptor.grid_fingerprint {
        return Err(ApiError::internal(
            "FDM magnetic-support summary grid identity does not match descriptor",
        ));
    }
    if summary.active_cell_count == 0
        || summary
            .active_cell_count
            .checked_add(summary.inactive_cell_count)
            != Some(descriptor.cell_count)
        || summary.active_unassigned_cell_count > summary.active_cell_count
    {
        return Err(ApiError::internal(
            "FDM magnetic-support summary cell counts are inconsistent",
        ));
    }
    for axis in 0..3 {
        let grid_min = descriptor.origin_m[axis];
        let grid_max = grid_min + f64::from(descriptor.counts[axis]) * descriptor.cell_m[axis];
        let support_min = summary.bounds_min_m[axis];
        let support_max = summary.bounds_max_m[axis];
        if !grid_max.is_finite()
            || !support_min.is_finite()
            || !support_max.is_finite()
            || support_min < grid_min
            || support_max > grid_max
            || support_min >= support_max
            || !is_cell_edge_aligned(support_min, grid_min, descriptor.cell_m[axis])
            || !is_cell_edge_aligned(support_max, grid_min, descriptor.cell_m[axis])
        {
            return Err(ApiError::internal(
                "FDM magnetic-support summary bounds are invalid for descriptor grid",
            ));
        }
    }
    Ok(())
}

fn is_cell_edge_aligned(value: f64, origin: f64, spacing: f64) -> bool {
    let ordinal = (value - origin) / spacing;
    let tolerance = 128.0 * f64::EPSILON * ordinal.abs().max(1.0);
    (ordinal - ordinal.round()).abs() <= tolerance
}

fn validate_summary_against_fmrm(
    descriptor: &FdmMembershipArtifactDescriptor,
    mask_bytes: &[u8],
) -> Result<(), ApiError> {
    let summary = descriptor.magnetic_support.as_ref().ok_or_else(|| {
        ApiError::internal("FDM magnetic-support binary validation requires a summary")
    })?;
    let nx = usize::try_from(descriptor.counts[0])
        .map_err(|_| ApiError::internal("FDM support x count is not addressable"))?;
    let ny = usize::try_from(descriptor.counts[1])
        .map_err(|_| ApiError::internal("FDM support y count is not addressable"))?;
    let plane_stride = nx
        .checked_mul(ny)
        .ok_or_else(|| ApiError::internal("FDM support xy plane size overflows usize"))?;
    let mut support_min = [u32::MAX; 3];
    let mut support_max_exclusive = [0u32; 3];
    let mut active_cell_count = 0u64;
    let mut inactive_cell_count = 0u64;
    let mut active_unassigned_cell_count = 0u64;

    for (index, chunk) in mask_bytes.chunks_exact(4).enumerate() {
        let membership = u32::from_le_bytes(chunk.try_into().unwrap());
        if membership == u32::MAX {
            inactive_cell_count = inactive_cell_count
                .checked_add(1)
                .ok_or_else(|| ApiError::internal("FDM inactive support count overflows u64"))?;
            continue;
        }
        active_cell_count = active_cell_count
            .checked_add(1)
            .ok_or_else(|| ApiError::internal("FDM active support count overflows u64"))?;
        if membership == 0 {
            active_unassigned_cell_count =
                active_unassigned_cell_count.checked_add(1).ok_or_else(|| {
                    ApiError::internal("FDM active-unassigned support count overflows u64")
                })?;
        }
        let coordinates = [
            u32::try_from(index % nx)
                .map_err(|_| ApiError::internal("FDM support x index exceeds u32"))?,
            u32::try_from((index / nx) % ny)
                .map_err(|_| ApiError::internal("FDM support y index exceeds u32"))?,
            u32::try_from(index / plane_stride)
                .map_err(|_| ApiError::internal("FDM support z index exceeds u32"))?,
        ];
        for (axis, coordinate) in coordinates.into_iter().enumerate() {
            support_min[axis] = support_min[axis].min(coordinate);
            support_max_exclusive[axis] = support_max_exclusive[axis].max(
                coordinate
                    .checked_add(1)
                    .ok_or_else(|| ApiError::internal("FDM support edge index exceeds u32"))?,
            );
        }
    }

    if active_cell_count == 0 {
        return Err(ApiError::internal(
            "FMRM binary contains no active magnetic-support cells",
        ));
    }
    let bounds_min_m: [f64; 3] = std::array::from_fn(|axis| {
        descriptor.origin_m[axis] + f64::from(support_min[axis]) * descriptor.cell_m[axis]
    });
    let bounds_max_m: [f64; 3] = std::array::from_fn(|axis| {
        descriptor.origin_m[axis] + f64::from(support_max_exclusive[axis]) * descriptor.cell_m[axis]
    });
    if summary.active_cell_count != active_cell_count
        || summary.inactive_cell_count != inactive_cell_count
        || summary.active_unassigned_cell_count != active_unassigned_cell_count
        || (0..3).any(|axis| {
            !support_bound_matches(
                summary.bounds_min_m[axis],
                bounds_min_m[axis],
                descriptor.cell_m[axis],
            ) || !support_bound_matches(
                summary.bounds_max_m[axis],
                bounds_max_m[axis],
                descriptor.cell_m[axis],
            )
        })
    {
        return Err(ApiError::internal(
            "FDM magnetic-support summary disagrees with FMRM binary mask",
        ));
    }
    Ok(())
}

fn support_bound_matches(published: f64, realized: f64, spacing: f64) -> bool {
    let scale = published.abs().max(realized.abs()).max(spacing.abs());
    (published - realized).abs() <= 128.0 * f64::EPSILON * scale
}

fn to_resource(
    snapshot: &SessionStateResponse,
    descriptor: FdmMembershipArtifactDescriptor,
) -> FdmRegionMembershipResource {
    FdmRegionMembershipResource {
        schema_version: descriptor.schema_version,
        mesh_revision: snapshot.mesh_revision,
        region_membership_revision: snapshot.region_realization_revisions.membership,
        freshness: "current".to_string(),
        binary_path: descriptor.binary_path,
        domain_generation_id: descriptor
            .domain_generation_id
            .unwrap_or_else(|| {
                crate::router_v2::handlers::sessions::status::domain_generation_id(snapshot)
            }),
        grid_fingerprint: descriptor.grid_fingerprint,
        region_legend_fingerprint: descriptor.region_legend_fingerprint,
        origin_m: descriptor.origin_m,
        counts: descriptor.counts,
        cell_m: descriptor.cell_m,
        cell_count: descriptor.cell_count,
        magnetic_support: descriptor.magnetic_support,
        object_ids: canonicalize_object_ids(&descriptor.object_ids),
        region_legend: descriptor.region_legend,
        encoding: descriptor.encoding,
    }
}

/// Deduplicate object IDs by stripping geometry-alias suffixes.
///
/// The planner internally carries both the magnet name (`"film"`) and its
/// generated geometry alias (`"film_geom"`) as `owner_names` for region
/// filtering.  The public API should expose only canonical scene object IDs
/// so that the frontend resolves exactly one render target per physical
/// object, preventing "ambiguous-active-unassigned-owner" errors.
fn canonicalize_object_ids(ids: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::with_capacity(ids.len());
    for id in ids {
        let canonical = strip_geometry_suffix(id);
        if seen.insert(canonical.clone()) {
            result.push(canonical);
        }
    }
    result
}

fn strip_geometry_suffix(id: &str) -> String {
    for suffix in ["_geom", "_geometry", "-geometry"] {
        if let Some(base) = id.strip_suffix(suffix) {
            if !base.is_empty() {
                return base.to_string();
            }
        }
    }
    id.to_string()
}

pub(super) fn load_resolved_fdm_membership(
    snapshot: &SessionStateResponse,
) -> Result<ResolvedFdmMembership, ApiError> {
    let artifact_dir = current_artifact_dir(snapshot);
    if !artifact_dir.as_ref().is_some_and(|directory| {
        directory
            .join("mesh/fdm_region_membership.v2.json")
            .is_file()
    }) {
        return resolved_membership_from_execution_plan(snapshot);
    }
    let (descriptor, artifact_dir) = load_descriptor(snapshot)?;
    if descriptor.schema_version != "fdm_region_membership.v2" {
        return Err(ApiError::unprocessable(
            "planar_scope_unsupported: FDM membership artifact does not publish active-cell support",
        ));
    }
    let binary_path = resolve_artifact_path(&artifact_dir, &descriptor.binary_path)?;
    let original = std::fs::read(&binary_path)
        .map_err(|error| ApiError::internal(format!("failed to read FMRM artifact: {error}")))?;
    let (payload, mask_offset) = validate_fmrm_payload(&original, &descriptor)?;
    let cell_membership = payload[mask_offset..]
        .chunks_exact(4)
        .map(|chunk| u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();
    Ok(ResolvedFdmMembership {
        grid_fingerprint: descriptor.grid_fingerprint,
        counts: descriptor.counts,
        origin_m: descriptor.origin_m,
        cell_m: descriptor.cell_m,
        object_ids: descriptor.object_ids,
        region_legend: descriptor.region_legend,
        cell_membership,
    })
}

fn resolved_membership_from_execution_plan(
    snapshot: &SessionStateResponse,
) -> Result<ResolvedFdmMembership, ApiError> {
    let plan_value = snapshot
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("execution_plan"))
        .ok_or_else(|| {
            ApiError::unprocessable(
                "planar_scope_unsupported: no realized FDM membership is published",
            )
        })?;
    let plan: fullmag_ir::ExecutionPlanIR =
        serde_json::from_value(plan_value.clone()).map_err(|error| {
            ApiError::internal(format!(
                "invalid execution plan for FDM membership: {error}"
            ))
        })?;
    let fullmag_ir::BackendPlanIR::Fdm(fdm) = plan.backend_plan else {
        return Err(ApiError::unprocessable(
            "planar_scope_unsupported: active execution plan is not single-grid FDM",
        ));
    };
    let certificate = fdm.grid_certificate.ok_or_else(|| {
        ApiError::unprocessable("planar_scope_unsupported: FDM plan has no grid certificate")
    })?;
    certificate.validate().map_err(|error| {
        ApiError::internal(format!(
            "invalid FDM grid certificate in execution plan: {error}"
        ))
    })?;
    certificate
        .validate_region_legend(&fdm.region_mask)
        .map_err(|error| {
            ApiError::internal(format!(
                "invalid FDM region legend in execution plan: {error}"
            ))
        })?;
    let expected_cells = fdm
        .grid
        .cells
        .iter()
        .try_fold(1usize, |product, count| {
            product.checked_mul(*count as usize)
        })
        .ok_or_else(|| ApiError::internal("FDM membership cell count overflows usize"))?;
    if fdm.region_mask.len() != expected_cells {
        return Err(ApiError::internal(
            "FDM execution-plan membership length does not match the grid",
        ));
    }
    if let Some(active_mask) = fdm.active_mask.as_ref() {
        if active_mask.len() != expected_cells {
            return Err(ApiError::internal(
                "FDM execution-plan active-mask length does not match the grid",
            ));
        }
        let active_cells = active_mask.iter().filter(|active| **active).count() as u64;
        if active_cells != certificate.active_cells {
            return Err(ApiError::internal(
                "FDM execution-plan active-mask count does not match the grid certificate",
            ));
        }
    } else if certificate.active_cells != expected_cells as u64 {
        return Err(ApiError::internal(
            "FDM execution plan omits an active mask for a partially occupied grid",
        ));
    }
    let cell_membership = fdm
        .region_mask
        .into_iter()
        .enumerate()
        .map(|(index, region_id)| {
            if fdm
                .active_mask
                .as_ref()
                .is_some_and(|active| !active[index])
            {
                u32::MAX
            } else {
                region_id
            }
        })
        .collect();
    Ok(ResolvedFdmMembership {
        grid_fingerprint: certificate.grid_fingerprint,
        counts: certificate.counts,
        origin_m: certificate.origin_m,
        cell_m: certificate.cell_m,
        object_ids: certificate.object_ids,
        region_legend: certificate
            .region_legend
            .into_iter()
            .map(|entry| FdmRegionLegendEntryResource {
                numeric_id: entry.numeric_id,
                object_id: entry.object_id,
                region_id: entry.region_id,
                priority: entry.priority,
            })
            .collect(),
        cell_membership,
    })
}

fn validate_fmrm_payload(
    payload: &[u8],
    descriptor: &FdmMembershipArtifactDescriptor,
) -> Result<(Vec<u8>, usize), ApiError> {
    if payload.len() < FMRM_HEADER_LEN || &payload[..4] != b"FMRM" {
        return Err(ApiError::internal("invalid FMRM magic or truncated header"));
    }
    let expected_header = match descriptor.schema_version.as_str() {
        "fdm_region_membership.v1" => [1, 1],
        "fdm_region_membership.v2" => [2, 2],
        _ => return Err(ApiError::internal("unsupported FMRM descriptor schema")),
    };
    if payload[4..6] != expected_header {
        return Err(ApiError::internal(
            "unsupported FMRM version or payload kind",
        ));
    }
    let counts = [
        u32::from_le_bytes(payload[8..12].try_into().unwrap()),
        u32::from_le_bytes(payload[12..16].try_into().unwrap()),
        u32::from_le_bytes(payload[16..20].try_into().unwrap()),
    ];
    if counts != descriptor.counts {
        return Err(ApiError::internal(
            "FMRM grid counts disagree with descriptor",
        ));
    }
    let mask_len = u32::from_le_bytes(payload[20..24].try_into().unwrap()) as u64;
    if mask_len != descriptor.cell_count {
        return Err(ApiError::internal(
            "FMRM mask length disagrees with descriptor",
        ));
    }
    let expected_len = FMRM_HEADER_LEN
        .checked_add(
            usize::try_from(mask_len)
                .map_err(|_| ApiError::internal("FMRM mask length is not addressable"))?
                .checked_mul(4)
                .ok_or_else(|| ApiError::internal("FMRM payload length overflows usize"))?,
        )
        .ok_or_else(|| ApiError::internal("FMRM payload length overflows usize"))?;
    if payload.len() != expected_len {
        return Err(ApiError::internal("FMRM payload length mismatch"));
    }
    let fingerprint = decode_hex32(&descriptor.grid_fingerprint)
        .ok_or_else(|| ApiError::internal("invalid descriptor grid fingerprint"))?;
    if payload[28..60] != fingerprint {
        return Err(ApiError::internal("FMRM grid fingerprint mismatch"));
    }
    Ok((payload.to_vec(), FMRM_HEADER_LEN))
}

fn decode_hex32(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 {
        return None;
    }
    let mut output = [0u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        output[index] =
            (char::from(pair[0]).to_digit(16)? * 16 + char::from(pair[1]).to_digit(16)?) as u8;
    }
    Some(output)
}

fn insert_header(response: &mut axum::response::Response, name: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        response
            .headers_mut()
            .insert(HeaderName::from_static(name), value);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        serialize_resolved_membership_payload, validate_descriptor_summary,
        validate_fmrm_payload, ResolvedFdmMembership, FMRM_HEADER_LEN,
    };
    use crate::schemas::mesh::{
        FdmMagneticSupportSemanticRole, FdmMagneticSupportSummaryResource,
        FdmRegionLegendEntryResource,
    };

    fn descriptor() -> super::FdmMembershipArtifactDescriptor {
        super::FdmMembershipArtifactDescriptor {
            schema_version: "fdm_region_membership.v1".to_string(),
            binary_path: "mesh/fdm_region_membership.v1.bin".to_string(),
            grid_fingerprint: "00".repeat(32),
            domain_generation_id: None,
            region_legend_fingerprint: Some("sha256:test".to_string()),
            origin_m: [0.0; 3],
            counts: [2, 2, 1],
            cell_m: [1.0e-9; 3],
            cell_count: 4,
            magnetic_support: None,
            object_ids: Vec::new(),
            region_legend: Vec::new(),
            encoding: "FMRM:u32_le".to_string(),
        }
    }

    fn payload() -> Vec<u8> {
        let mut bytes = vec![0u8; FMRM_HEADER_LEN + 4 * 4];
        bytes[..4].copy_from_slice(b"FMRM");
        bytes[4] = 1;
        bytes[5] = 1;
        bytes[8..12].copy_from_slice(&2u32.to_le_bytes());
        bytes[12..16].copy_from_slice(&2u32.to_le_bytes());
        bytes[16..20].copy_from_slice(&1u32.to_le_bytes());
        bytes[20..24].copy_from_slice(&4u32.to_le_bytes());
        bytes[28..60].fill(0);
        for (index, value) in [1u32, 1, 2, 0].into_iter().enumerate() {
            let offset = FMRM_HEADER_LEN + index * 4;
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn validates_fmrm_header_counts_and_grid_identity() {
        let descriptor = descriptor();
        let (decoded, offset) = validate_fmrm_payload(&payload(), &descriptor)
            .expect("valid FMRM payload should decode");
        assert_eq!(offset, FMRM_HEADER_LEN);
        assert_eq!(decoded.len(), FMRM_HEADER_LEN + 16);

        let mut invalid = payload();
        invalid[20..24].copy_from_slice(&3u32.to_le_bytes());
        assert!(validate_fmrm_payload(&invalid, &descriptor)
            .expect_err("mask length mismatch must reject")
            .message
            .contains("mask length"));
    }

    #[test]
    fn serializes_execution_plan_membership_as_canonical_fmrm_v2() {
        let mut descriptor = descriptor();
        descriptor.schema_version = "fdm_region_membership.v2".to_string();
        descriptor.binary_path = "mesh/fdm_region_membership.v2.bin".to_string();
        descriptor.encoding = "FMRM:u32_membership_le".to_string();
        descriptor.region_legend = vec![FdmRegionLegendEntryResource {
            numeric_id: 7,
            object_id: "film".to_string(),
            region_id: "core".to_string(),
            priority: 0,
        }];
        let resolved = ResolvedFdmMembership {
            grid_fingerprint: descriptor.grid_fingerprint.clone(),
            counts: descriptor.counts,
            origin_m: descriptor.origin_m,
            cell_m: descriptor.cell_m,
            object_ids: vec!["film".to_string()],
            region_legend: descriptor.region_legend.clone(),
            cell_membership: vec![7, u32::MAX, 7, u32::MAX],
        };

        let payload = serialize_resolved_membership_payload(&descriptor, &resolved)
            .expect("planned single-grid membership should serialize");
        let (validated, mask_offset) = validate_fmrm_payload(&payload, &descriptor)
            .expect("planned payload must satisfy the public FMRM contract");

        assert_eq!(&validated[..4], b"FMRM");
        assert_eq!(&validated[4..6], &[2, 2]);
        assert_eq!(u32::from_le_bytes(validated[24..28].try_into().unwrap()), 1);
        assert_eq!(
            validated[mask_offset..]
                .chunks_exact(4)
                .map(|chunk| u32::from_le_bytes(chunk.try_into().unwrap()))
                .collect::<Vec<_>>(),
            resolved.cell_membership
        );
    }

    #[test]
    fn validates_magnetic_support_identity_counts_and_interior_bounds() {
        let mut descriptor = descriptor();
        descriptor.schema_version = "fdm_region_membership.v2".to_string();
        descriptor.encoding = "FMRM:u32_membership_le".to_string();
        descriptor.origin_m = [1.0e-9, -3.0e-9, 7.0e-9];
        descriptor.counts = [4, 3, 2];
        descriptor.cell_m = [2.0e-9, 3.0e-9, 4.0e-9];
        descriptor.cell_count = 24;
        descriptor.magnetic_support = Some(FdmMagneticSupportSummaryResource {
            semantic_role: FdmMagneticSupportSemanticRole::MagneticSupport,
            grid_fingerprint: descriptor.grid_fingerprint.clone(),
            bounds_min_m: [3.0e-9, -3.0e-9, 7.0e-9],
            bounds_max_m: [7.0e-9, 3.0e-9, 11.0e-9],
            active_cell_count: 3,
            inactive_cell_count: 21,
            active_unassigned_cell_count: 1,
        });
        validate_descriptor_summary(&descriptor).expect("valid interior support must pass");

        descriptor
            .magnetic_support
            .as_mut()
            .unwrap()
            .grid_fingerprint = "11".repeat(32);
        assert!(validate_descriptor_summary(&descriptor)
            .expect_err("mismatched summary identity must reject")
            .message
            .contains("identity"));
        descriptor
            .magnetic_support
            .as_mut()
            .unwrap()
            .grid_fingerprint = "00".repeat(32);
        descriptor
            .magnetic_support
            .as_mut()
            .unwrap()
            .inactive_cell_count = 20;
        assert!(validate_descriptor_summary(&descriptor)
            .expect_err("inconsistent summary counts must reject")
            .message
            .contains("counts"));
        descriptor
            .magnetic_support
            .as_mut()
            .unwrap()
            .inactive_cell_count = 21;
        descriptor.magnetic_support.as_mut().unwrap().bounds_min_m[0] = 2.5e-9;
        assert!(validate_descriptor_summary(&descriptor)
            .expect_err("unaligned summary bounds must reject")
            .message
            .contains("bounds"));
    }

    #[test]
    fn rejects_unknown_magnetic_support_semantic_role() {
        let result =
            serde_json::from_value::<FdmMagneticSupportSummaryResource>(serde_json::json!({
                "semantic_role": "airbox",
                "grid_fingerprint": "00".repeat(32),
                "bounds_min_m": [0.0, 0.0, 0.0],
                "bounds_max_m": [1.0, 1.0, 1.0],
                "active_cell_count": 1,
                "inactive_cell_count": 0,
                "active_unassigned_cell_count": 0
            }));
        assert!(result.is_err(), "unknown semantic role must reject");
    }
}
