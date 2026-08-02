//! Realized single-grid FDM region membership resources.
//!
//! The descriptor is thin JSON; the cell mask is served as a versioned FMRM
//! binary payload and can be filtered to one canonical region ID.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::header::{HeaderName, HeaderValue};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::artifacts::{read_json_artifact_value, resolve_artifact_path};
use crate::error::ApiError;
use crate::schemas::mesh::{FdmRegionLegendEntryResource, FdmRegionMembershipResource};
use crate::session::current_artifact_dir;
use crate::types::{AppState, SessionStateResponse};

const FMRM_HEADER_LEN: usize = 64;

#[derive(Debug, Deserialize)]
struct FdmMembershipArtifactDescriptor {
    schema_version: String,
    binary_path: String,
    grid_fingerprint: String,
    #[serde(default)]
    region_legend_fingerprint: Option<String>,
    origin_m: [f64; 3],
    counts: [u32; 3],
    cell_m: [f64; 3],
    cell_count: u64,
    #[serde(default)]
    object_ids: Vec<String>,
    region_legend: Vec<FdmRegionLegendEntryResource>,
    encoding: String,
}

pub(super) struct ResolvedFdmMembership {
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
    let Some(artifact_dir) = current_artifact_dir(snapshot) else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    if !artifact_dir
        .join("mesh/fdm_region_membership.v2.json")
        .is_file()
        && !artifact_dir
            .join("mesh/fdm_region_membership.v1.json")
            .is_file()
    {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let (descriptor, _) = load_descriptor(snapshot)?;
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
        (status = 200, description = "Binary realized FDM cell membership (FMRM)", content_type = "application/octet-stream"),
        (status = 206, description = "Partial FMRM payload", content_type = "application/octet-stream"),
        (status = 304, description = "FMRM payload not modified for the supplied ETag"),
        (status = 404, description = "No realized FDM region membership artifact"),
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
        ("If-None-Match" = Option<String>, Header, description = "Strong ETag from a previous scoped FMRM response"),
        ("Range" = Option<String>, Header, description = "Optional single byte range for the FMRM payload")
    ),
    responses(
        (status = 200, description = "Scoped binary realized FDM cell membership (FMRM)", content_type = "application/octet-stream"),
        (status = 206, description = "Partial scoped FMRM payload", content_type = "application/octet-stream"),
        (status = 304, description = "Scoped FMRM payload not modified for the supplied ETag"),
        (status = 404, description = "No realized FDM membership or unknown region ID"),
        (status = 416, description = "Requested FMRM byte range is not satisfiable"),
    ),
    tag = "data"
)]
pub async fn get_fdm_region_membership_binary_scoped(
    State(state): State<Arc<AppState>>,
    Path(region_id): Path<String>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    serve_fdm_region_membership_binary(state, headers, Some(region_id)).await
}

async fn serve_fdm_region_membership_binary(
    state: Arc<AppState>,
    headers: HeaderMap,
    region_id: Option<String>,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let (descriptor, artifact_dir) = load_descriptor(snapshot)?;
    let binary_path = resolve_artifact_path(&artifact_dir, &descriptor.binary_path)?;
    let original = std::fs::read(&binary_path)
        .map_err(|error| ApiError::internal(format!("failed to read FMRM artifact: {error}")))?;
    let (mut payload, mask_offset) = validate_fmrm_payload(&original, &descriptor)?;

    let selected_numeric_id = if let Some(region_id) = region_id.as_deref() {
        let entry = descriptor
            .region_legend
            .iter()
            .find(|entry| entry.region_id == region_id)
            .ok_or_else(|| ApiError::not_found(format!("FDM region '{region_id}' not found")))?;
        Some(entry.numeric_id)
    } else {
        None
    };
    if let Some(numeric_id) = selected_numeric_id {
        for chunk in payload[mask_offset..].chunks_exact_mut(4) {
            let value = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            if value != numeric_id {
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
    let scope = region_id.as_deref().unwrap_or("all");
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
    let descriptor: FdmMembershipArtifactDescriptor = serde_json::from_value(descriptor_value)
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
    Ok((descriptor, artifact_dir))
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
        grid_fingerprint: descriptor.grid_fingerprint,
        region_legend_fingerprint: descriptor.region_legend_fingerprint,
        origin_m: descriptor.origin_m,
        counts: descriptor.counts,
        cell_m: descriptor.cell_m,
        cell_count: descriptor.cell_count,
        object_ids: descriptor.object_ids,
        region_legend: descriptor.region_legend,
        encoding: descriptor.encoding,
    }
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
    use super::{validate_fmrm_payload, FMRM_HEADER_LEN};

    fn descriptor() -> super::FdmMembershipArtifactDescriptor {
        super::FdmMembershipArtifactDescriptor {
            schema_version: "fdm_region_membership.v1".to_string(),
            binary_path: "mesh/fdm_region_membership.v1.bin".to_string(),
            grid_fingerprint: "00".repeat(32),
            region_legend_fingerprint: Some("sha256:test".to_string()),
            origin_m: [0.0; 3],
            counts: [2, 2, 1],
            cell_m: [1.0e-9; 3],
            cell_count: 4,
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
}
