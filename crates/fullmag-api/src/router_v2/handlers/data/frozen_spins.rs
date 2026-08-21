//! Binary data-plane resources for resolved frozen-spins masks.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::header::{HeaderName, HeaderValue};
use axum::http::HeaderMap;
use axum::response::Response;
use sha2::{Digest, Sha256};

use crate::error::ApiError;
use crate::router_v2::handlers::model::frozen_spins::current_preview_record;
use crate::router_v2::handlers::shared::conditional_binary_response_with_content_type;
use crate::types::AppState;

const FROZEN_MASK_HEADER_LEN: usize = 64;

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/frozen-spins/resolved-masks/{mask_id}",
    params(
        ("mask_id" = String, Path, description = "Resolved preview mask identity"),
        ("If-None-Match" = Option<String>, Header, description = "Strong ETag from a previous mask response"),
        ("Range" = Option<String>, Header, description = "Optional single byte range for the binary payload")
    ),
    responses(
        (status = 200, description = "Versioned bit-packed frozen-spins mask", content_type = "application/vnd.fullmag.frozen-mask", headers(
            ("ETag" = String, description = "Strong identity of the complete FMSK representation"),
            ("Accept-Ranges" = String, description = "Supported byte range unit"),
            ("x-fullmag-mask-sha256" = String, description = "SHA-256 identity of the logical bit mask"),
            ("x-fullmag-topology-fingerprint" = String, description = "Resolved topology identity"),
            ("x-fullmag-source-state-revision" = String, description = "Magnetization source-state revision")
        )),
        (status = 206, description = "Partial frozen-spins mask payload", content_type = "application/vnd.fullmag.frozen-mask", headers(
            ("ETag" = String, description = "Strong identity of the complete FMSK representation"),
            ("Accept-Ranges" = String, description = "Supported byte range unit"),
            ("Content-Range" = String, description = "Returned byte interval"),
            ("x-fullmag-mask-sha256" = String, description = "SHA-256 identity of the logical bit mask"),
            ("x-fullmag-topology-fingerprint" = String, description = "Resolved topology identity"),
            ("x-fullmag-source-state-revision" = String, description = "Magnetization source-state revision")
        )),
        (status = 304, description = "Mask not modified for the supplied ETag", headers(
            ("ETag" = String, description = "Strong identity of the complete FMSK representation")
        )),
        (status = 404, description = "Resolved mask missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Mask source-state or topology is stale", body = crate::schemas::common::ApiErrorResponse),
        (status = 416, description = "Requested byte range is not satisfiable", headers(
            ("Accept-Ranges" = String, description = "Supported byte range unit"),
            ("Content-Range" = String, description = "Unsatisfied complete representation length")
        ))
    ),
    tag = "data"
)]
pub async fn get_frozen_spins_resolved_mask(
    State(state): State<Arc<AppState>>,
    Path(mask_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let record = current_preview_record(&state, &mask_id)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(format!("frozen spins resolved mask not found: {mask_id}"))
        })?;

    let body = encode_frozen_mask(&record)?;
    let etag = format!("\"sha256:{:x}\"", Sha256::digest(&body));
    let mut response = conditional_binary_response_with_content_type(
        &headers,
        &etag,
        body,
        HeaderValue::from_static("application/vnd.fullmag.frozen-mask"),
    );
    insert_header(
        &mut response,
        "x-fullmag-mask-sha256",
        &record.response.mask_sha256,
    );
    insert_header(
        &mut response,
        "x-fullmag-topology-fingerprint",
        &record.topology_fingerprint,
    );
    insert_header(
        &mut response,
        "x-fullmag-source-state-revision",
        &record.source_state_revision.to_string(),
    );
    Ok(response)
}

fn encode_frozen_mask(
    record: &crate::session::FrozenSpinsPreviewRecord,
) -> Result<Vec<u8>, ApiError> {
    let mut bytes = vec![0_u8; FROZEN_MASK_HEADER_LEN + record.frozen_mask.len().div_ceil(8)];
    bytes[0..4].copy_from_slice(b"FMSK");
    bytes[4] = 1;
    bytes[5] = 1;
    bytes[8..16].copy_from_slice(&(record.frozen_mask.len() as u64).to_le_bytes());
    bytes[16..24].copy_from_slice(&record.scene_revision.to_le_bytes());
    bytes[24..32].copy_from_slice(&record.source_state_revision.to_le_bytes());
    bytes[32..64].copy_from_slice(&decode_sha256(&record.response.mask_sha256)?);
    for (index, frozen) in record.frozen_mask.iter().enumerate() {
        if *frozen {
            bytes[FROZEN_MASK_HEADER_LEN + index / 8] |= 1 << (index % 8);
        }
    }
    Ok(bytes)
}

fn decode_sha256(value: &str) -> Result<[u8; 32], ApiError> {
    let hex = value.strip_prefix("sha256:").unwrap_or(value);
    if hex.len() != 64 {
        return Err(ApiError::internal("invalid frozen-spins mask hash"));
    }
    let mut bytes = [0_u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16)
            .map_err(|_| ApiError::internal("invalid frozen-spins mask hash"))?;
    }
    Ok(bytes)
}

fn insert_header(response: &mut Response, name: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        response
            .headers_mut()
            .insert(HeaderName::from_static(name), value);
    }
}
