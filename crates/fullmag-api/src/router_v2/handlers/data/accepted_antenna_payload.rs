//! Durable accepted Study payloads, distinct from the current Live session adapter.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue};
use axum::response::Response;
use fullmag_application::{ProjectId, RunId};
use sha2::{Digest, Sha256};

use super::accepted_antenna_inspection::{
    load_accepted_antenna_inspection, AcceptedAntennaInspectionIdentity,
    AcceptedAntennaPublicationPin, AcceptedAntennaInspectionData,
};
use crate::error::ApiError;
use crate::types::AppState;

fn validate_pin(
    identity: &AcceptedAntennaInspectionIdentity,
    query: &AcceptedAntennaPublicationPin,
) -> Result<(), ApiError> {
    if identity.attempt_id != query.attempt_id
        || identity.ownership_epoch != query.ownership_epoch
        || identity.package_object_ref != query.package_object_ref
    {
        return Err(ApiError::conflict_with_code(
            "antenna_source_conflict",
            "requested antenna package is not the current published attempt",
        ));
    }
    Ok(())
}

pub(super) fn validate_publication_query(
    step_id: &str,
    query: &AcceptedAntennaPublicationPin,
) -> Result<(), ApiError> {
    if step_id.is_empty()
        || query.attempt_id.is_empty()
        || query.package_object_ref.len() != 64
        || !query
            .package_object_ref
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(ApiError::bad_request(
            "invalid accepted antenna publication identity",
        ));
    }
    Ok(())
}

// The new evidence name belongs only to accepted H-only results, not the Live families.
fn validate_accepted_payload_kind(kind: &str) -> Result<(), ApiError> {
    if kind == "evidence" { return Ok(()); }
    super::antenna_inspection::validate_family_payload_kind(kind)
}

fn retained_payload_descriptor<'a>(
    payloads: &'a fullmag_antenna_artifacts::retained_current::RetainedCurrentPayloads,
    kind: &str,
) -> Result<&'a fullmag_antenna_artifacts::retained_current::RetainedCurrentPayloadRef, ApiError> {
    match kind {
        "sample_xyz" => Ok(&payloads.sample_xyz),
        "sample_cells" => Ok(&payloads.sample_cells),
        "h_raw" => Ok(&payloads.h_raw),
        "evidence" => Ok(&payloads.evidence),
        _ => Err(ApiError::bad_request("unknown retained-current H-only payload kind")),
    }
}

fn select_retained_payload(
    mut loaded: fullmag_antenna_artifacts::retained_current::RetainedCurrentFieldBundleAny,
    kind: &str,
) -> Result<(String, Vec<u8>), ApiError> {
    let descriptor = retained_payload_descriptor(loaded.manifest().payloads(), kind)?.clone();
    let payloads = match &mut loaded {
        fullmag_antenna_artifacts::retained_current::RetainedCurrentFieldBundleAny::SurfaceV1(bundle) => &mut bundle.payloads,
        fullmag_antenna_artifacts::retained_current::RetainedCurrentFieldBundleAny::DirectV2(bundle) => &mut bundle.payloads,
    };
    let bytes = payloads.remove(kind)
        .ok_or_else(|| ApiError::internal("verified retained-current payload is missing"))?;
    if bytes.len() as u64 != descriptor.byte_count || format!("{:x}", Sha256::digest(&bytes)) != descriptor.sha256 {
        return Err(ApiError::internal("verified retained-current payload identity differs"));
    }
    Ok((descriptor.sha256.clone(), bytes))
}

#[utoipa::path(
    get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/antenna-inspections/{step_id}/payloads/{payload_kind}",
    params(
        ("project_id" = String, Path, description = "Pinned project identity"),
        ("run_id" = String, Path, description = "Accepted durable run identity"),
        ("step_id" = String, Path, description = "Exact accepted Study step ID, not the native stage ID"),
        ("payload_kind" = String, Path, description = "Verified payload kind for the accepted family; H-only permits sample_xyz, sample_cells, h_raw and evidence"),
        ("attempt_id" = String, Query, description = "Required current successful task attempt"),
        ("ownership_epoch" = u64, Query, description = "Required current task ownership epoch"),
        ("package_object_ref" = String, Query, description = "Required package CAS SHA-256 from the published artifact catalog"),
        ("If-None-Match" = Option<String>, Header, description = "Previous strong ETag"),
        ("Range" = Option<String>, Header, description = "One byte range")
    ),
    responses(
        (status = 200, description = "Verified accepted antenna payload", content_type = "application/octet-stream"),
        (status = 206, description = "Verified payload byte range", content_type = "application/octet-stream"),
        (status = 304, description = "Unchanged after current-attempt and full integrity checks"),
        (status = 400, description = "Invalid identity, query or payload kind"),
        (status = 404, description = "Selected step has no published inspection"),
        (status = 409, description = "Project/run mismatch or stale publication identity"),
        (status = 416, description = "Invalid byte range"),
        (status = 500, description = "Invalid accepted state, package or storage failure")
    ),
    tag = "persistence"
)]
pub async fn get_accepted_antenna_payload(
    State(state): State<Arc<AppState>>,
    Path((project_id, run_id, step_id, payload_kind)): Path<(String, String, String, String)>,
    query: Result<Query<AcceptedAntennaPublicationPin>, axum::extract::rejection::QueryRejection>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let Query(query) =
        query.map_err(|e| ApiError::bad_request(format!("invalid accepted antenna query: {e}")))?;
    let project_id = ProjectId::parse(project_id)
        .map_err(|e| ApiError::bad_request(format!("invalid project_id: {e}")))?;
    let run_id =
        RunId::parse(run_id).map_err(|e| ApiError::bad_request(format!("invalid run_id: {e}")))?;
    validate_accepted_payload_kind(&payload_kind)?;
    validate_publication_query(&step_id, &query)?;
    let permit = Arc::clone(&state.quantity_data_plane.accepted_inspection_admission)
        .acquire_owned().await
        .map_err(|_| ApiError::internal("accepted inspection reader admission closed"))?;
    let (etag, bytes) = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let root = state
            .submit_store_root
            .as_ref()
            .ok_or_else(|| ApiError::internal("managed project run storage is not configured"))?;
        if !root.exists() {
            return Err(ApiError::not_found("accepted antenna storage is missing"));
        }
        let inspection =
            load_accepted_antenna_inspection(root, &run_id, &project_id, &step_id, &query)?;
        validate_pin(&inspection.identity, &query)?;
        let (payload_sha256, bytes) = match inspection.loaded {
            AcceptedAntennaInspectionData::ExternalLead(loaded) => {
                let (descriptor, bytes) = super::antenna_inspection::select_payload(loaded, &payload_kind)?;
                (descriptor.sha256, bytes)
            }
            AcceptedAntennaInspectionData::ClosedLoop { loaded, .. } =>
                super::antenna_inspection::select_closed_payload(loaded, &payload_kind)?,
            AcceptedAntennaInspectionData::RetainedCurrent { loaded, .. } =>
                select_retained_payload(loaded, &payload_kind)?,
        };
        // The cache identity includes ownership, not just numerical content.
        let token = serde_json::to_vec(&(
            project_id.as_str(),
            &inspection.identity.run_id,
            &inspection.identity.study_step_id,
            &inspection.identity.native_stage_id,
            &inspection.identity.task_id,
            &inspection.identity.attempt_id,
            inspection.identity.ownership_epoch,
            &inspection.identity.manifest_object_ref,
            &inspection.identity.artifact_id,
            &inspection.identity.package_object_ref,
            &payload_kind,
            &payload_sha256,
        ))
        .map_err(|e| ApiError::internal(e.to_string()))?;
        let digest = format!("{:x}", Sha256::digest(&token));
        Ok::<_, ApiError>((
            crate::router_v2::handlers::shared::stable_strong_etag(&digest),
            bytes,
        ))
    })
    .await
    .map_err(|e| ApiError::internal(format!("accepted antenna payload worker: {e}")))??;
    Ok(
        crate::router_v2::handlers::shared::conditional_binary_response_with_content_type(
            &headers,
            &etag,
            bytes,
            HeaderValue::from_static("application/octet-stream"),
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_dtq_v2_payload_allowlist_stays_four() {
        use fullmag_antenna_artifacts::retained_current::{RetainedCurrentPayloadRef, RetainedCurrentPayloads};
        // Descriptor routing fixture only, never physical evidence.
        let descriptor = RetainedCurrentPayloadRef { sha256: "a".repeat(64), byte_count: 24,
            layout: "sample_xyz_f64_le".into(), unit: "A/m".into() };
        let payloads = RetainedCurrentPayloads { sample_xyz: descriptor.clone(), sample_cells: descriptor.clone(),
            h_raw: descriptor.clone(), evidence: descriptor };
        for kind in ["sample_xyz", "sample_cells", "h_raw", "evidence"] {
            assert!(retained_payload_descriptor(&payloads, kind).is_ok());
            assert!(validate_accepted_payload_kind(kind).is_ok());
        }
        for kind in ["v_raw", "j_local_raw", "h_per_a", "m", "H_ant_basis", "direct_evidence", "source_preimage", "bundle", "unknown"] {
            assert!(retained_payload_descriptor(&payloads, kind).is_err(), "{kind}");
        }
        assert!(super::super::antenna_inspection::validate_family_payload_kind("evidence").is_err());
        assert!(validate_accepted_payload_kind("unknown").is_err());
    }

    #[test]
    fn publication_query_requires_exact_nonempty_lowercase_cas_identity() {
        for (step, attempt, digest, accepted) in [
            ("step", "attempt", "a".repeat(64), true),
            ("", "attempt", "a".repeat(64), false),
            ("step", "", "a".repeat(64), false),
            ("step", "attempt", "A".repeat(64), false),
            ("step", "attempt", "g".repeat(64), false),
            ("step", "attempt", "a".repeat(63), false),
        ] {
            let query = AcceptedAntennaPublicationPin {
                attempt_id: attempt.into(),
                ownership_epoch: 2,
                package_object_ref: digest,
            };
            assert_eq!(validate_publication_query(step, &query).is_ok(), accepted);
        }
    }

    #[test]
    fn pin_rejects_retry_and_identical_content_from_another_owner() {
        let identity = AcceptedAntennaInspectionIdentity {
            run_id: "run".into(),
            task_id: "task".into(),
            study_step_id: "step".into(),
            native_stage_id: "native".into(),
            attempt_id: "attempt".into(),
            ownership_epoch: 2,
            manifest_artifact_id: "manifest".into(),
            manifest_object_ref: "b".repeat(64),
            artifact_id: "artifact".into(),
            package_object_ref: "a".repeat(64),
            case_id: "default".into(),
        };
        for (attempt, epoch, digest, accepted) in [
            ("attempt", 2, "a", true),
            ("old", 2, "a", false),
            ("attempt", 1, "a", false),
            ("attempt", 2, "b", false),
        ] {
            let query = AcceptedAntennaPublicationPin {
                attempt_id: attempt.into(),
                ownership_epoch: epoch,
                package_object_ref: digest.repeat(64),
            };
            assert_eq!(validate_pin(&identity, &query).is_ok(), accepted);
        }
    }
}
