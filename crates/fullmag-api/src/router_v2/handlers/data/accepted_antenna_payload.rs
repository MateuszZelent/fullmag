//! Durable accepted Study payloads, distinct from the current Live session adapter.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue};
use axum::response::Response;
use fullmag_application::{ProjectId, RunId};
use sha2::{Digest, Sha256};

use super::accepted_antenna_inspection::{
    load_accepted_antenna_inspection, AcceptedAntennaInspectionIdentity,
    AcceptedAntennaPublicationPin,
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

#[utoipa::path(
    get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/antenna-inspections/{step_id}/payloads/{payload_kind}",
    params(
        ("project_id" = String, Path, description = "Pinned project identity"),
        ("run_id" = String, Path, description = "Accepted durable run identity"),
        ("step_id" = String, Path, description = "Exact accepted Study step ID, not the native stage ID"),
        ("payload_kind" = String, Path, description = "Same verified V/J/H and geometry payload kinds as the Live inspection API"),
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
    super::antenna_inspection::validate_payload_kind(&payload_kind)?;
    validate_publication_query(&step_id, &query)?;
    let (etag, bytes) = tokio::task::spawn_blocking(move || {
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
        let (descriptor, bytes) =
            super::antenna_inspection::select_payload(inspection.loaded, &payload_kind)?;
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
            &descriptor.sha256,
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
