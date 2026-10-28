//! Thin metadata and shared display descriptors for a pinned accepted inspection.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use fullmag_application::{ProjectId, RunId};
use serde::Serialize;
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

use super::accepted_antenna_inspection::{
    discover_accepted_antenna_inspections, load_accepted_antenna_inspection,
    AcceptedAntennaInspectionIdentity, AcceptedAntennaPublicationPin, AcceptedAntennaInspectionData,
};
use super::antenna_inspection::{
    inspection_display_data, manifest_resource, AntennaInspectionDisplayDataResource,
    AntennaInspectionManifestResource, AntennaInspectionDisplayCapabilities,
};
use crate::error::ApiError;
use crate::types::AppState;

#[derive(Debug, Serialize, ToSchema)]
pub struct AcceptedExternalLeadInspectionResource {
    pub schema_version: String,
    pub resource_id: String,
    pub project_id: String,
    pub owner: AcceptedAntennaInspectionIdentity,
    pub port_mode_id: String,
    pub output_id: String,
    pub manifest: AntennaInspectionManifestResource,
    pub display: AntennaInspectionDisplayDataResource,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(untagged)]
pub enum AcceptedAntennaInspectionResource {
    ExternalLead(AcceptedExternalLeadInspectionResource),
    ClosedLoop(AcceptedClosedLoopInspectionResource),
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AcceptedClosedLoopInspectionResource {
    pub schema_version: String,
    pub resource_id: String,
    pub project_id: String,
    pub owner: AcceptedAntennaInspectionIdentity,
    pub port_mode_id: String,
    pub output_id: String,
    pub capabilities: AntennaInspectionDisplayCapabilities,
    pub normalization: String,
    /// Existing verified, bounded closed-loop descriptors; numerical arrays stay binary.
    pub closed_loop_display: serde_json::Value,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AcceptedAntennaInspectionCatalogResource {
    pub schema_version: String,
    pub resource_id: String,
    pub project_id: String,
    pub run_id: String,
    /// Publication evidence only; pinned reads separately validate numerical packages.
    pub validation_scope: String,
    pub entries: Vec<AcceptedAntennaInspectionIdentity>,
}

#[utoipa::path(
    get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/antenna-inspections",
    params(
        ("project_id" = String, Path, description = "Pinned project identity"),
        ("run_id" = String, Path, description = "Accepted durable run identity"),
        ("If-None-Match" = Option<String>, Header, description = "Previous strong ETag")
    ),
    responses(
        (status = 200, description = "Current published inspection identities; no field packages are decoded", body = AcceptedAntennaInspectionCatalogResource),
        (status = 304, description = "Unchanged after accepted publication checks"),
        (status = 400, description = "Invalid identity"),
        (status = 404, description = "Accepted run or catalogs are missing"),
        (status = 409, description = "Project/run mismatch or catalogs changed during read"),
        (status = 500, description = "Invalid accepted state or publication metadata")
    ),
    tag = "persistence"
)]
pub async fn get_accepted_antenna_catalog(
    State(state): State<Arc<AppState>>,
    Path((project_id, run_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let project_id = ProjectId::parse(project_id)
        .map_err(|e| ApiError::bad_request(format!("invalid project_id: {e}")))?;
    let run_id =
        RunId::parse(run_id).map_err(|e| ApiError::bad_request(format!("invalid run_id: {e}")))?;
    let resource = tokio::task::spawn_blocking(move || {
        let root = state
            .submit_store_root
            .as_ref()
            .ok_or_else(|| ApiError::internal("managed project run storage is not configured"))?;
        if !root.exists() {
            return Err(ApiError::not_found("accepted antenna storage is missing"));
        }
        let entries = discover_accepted_antenna_inspections(root, &run_id, &project_id)?;
        Ok::<_, ApiError>(AcceptedAntennaInspectionCatalogResource {
            schema_version: "accepted_antenna_inspection_catalog.v1".into(),
            resource_id: format!(
                "persistence/projects/{}/runs/{}/antenna-inspections",
                project_id.as_str(),
                run_id.as_str()
            ),
            project_id: project_id.as_str().into(),
            run_id: run_id.as_str().into(),
            validation_scope: "published_output_manifest".into(),
            entries,
        })
    })
    .await
    .map_err(|e| ApiError::internal(format!("accepted antenna discovery worker: {e}")))??;
    let bytes = serde_json::to_vec(&resource).map_err(|e| ApiError::internal(e.to_string()))?;
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "{:x}",
        Sha256::digest(&bytes)
    ));
    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &resource))
}

#[utoipa::path(
    get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/antenna-inspections/{step_id}",
    params(
        ("project_id" = String, Path, description = "Pinned project identity"),
        ("run_id" = String, Path, description = "Accepted durable run identity"),
        ("step_id" = String, Path, description = "Exact accepted Study step ID, not the native stage ID"),
        ("attempt_id" = String, Query, description = "Required current successful task attempt"),
        ("ownership_epoch" = u64, Query, description = "Required current task ownership epoch"),
        ("package_object_ref" = String, Query, description = "Required package CAS SHA-256 from the published artifact catalog"),
        ("If-None-Match" = Option<String>, Header, description = "Previous strong ETag")
    ),
    responses(
        (status = 200, description = "Fully verified accepted inspection metadata and display descriptors, no numerical arrays", body = AcceptedAntennaInspectionResource),
        (status = 304, description = "Unchanged after current-attempt and full integrity checks"),
        (status = 400, description = "Invalid identity or query"),
        (status = 404, description = "Selected step has no published inspection"),
        (status = 409, description = "Project/run mismatch or stale publication identity"),
        (status = 500, description = "Invalid accepted state, package or storage failure")
    ),
    tag = "persistence"
)]
pub async fn get_accepted_antenna_inspection(
    State(state): State<Arc<AppState>>,
    Path((project_id, run_id, step_id)): Path<(String, String, String)>,
    query: Result<Query<AcceptedAntennaPublicationPin>, axum::extract::rejection::QueryRejection>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let Query(query) =
        query.map_err(|e| ApiError::bad_request(format!("invalid accepted antenna query: {e}")))?;
    let project_id = ProjectId::parse(project_id)
        .map_err(|e| ApiError::bad_request(format!("invalid project_id: {e}")))?;
    let run_id =
        RunId::parse(run_id).map_err(|e| ApiError::bad_request(format!("invalid run_id: {e}")))?;
    super::accepted_antenna_payload::validate_publication_query(&step_id, &query)?;
    let permit = Arc::clone(&state.quantity_data_plane.accepted_inspection_admission)
        .acquire_owned().await
        .map_err(|_| ApiError::internal("accepted inspection reader admission closed"))?;
    let resource = tokio::task::spawn_blocking(move || {
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
        let resource_id = format!(
            "persistence/projects/{}/runs/{}/antenna-inspections/{}",
            project_id.as_str(), run_id.as_str(), step_id,
        );
        match inspection.loaded {
            AcceptedAntennaInspectionData::ExternalLead(loaded) => {
                let display = inspection_display_data(&loaded)?;
                let port_mode_id = loaded.manifest.port_mode_id.clone();
                let output_id = loaded.manifest.output_id.clone();
                let mut manifest = manifest_resource(loaded.manifest)?;
                // Full byte/plan validation is not scientific drive qualification.
                manifest.validation_scope = "accepted_plan_and_payloads".into();
                Ok::<_, ApiError>(AcceptedAntennaInspectionResource::ExternalLead(AcceptedExternalLeadInspectionResource {
                    schema_version: "accepted_antenna_inspection.v1".into(),
                    resource_id, project_id: project_id.as_str().into(),
                    owner: inspection.identity, port_mode_id, output_id, manifest, display,
                }))
            }
            AcceptedAntennaInspectionData::ClosedLoop { loaded, port_mode_id, output_id } => {
                Ok(AcceptedAntennaInspectionResource::ClosedLoop(AcceptedClosedLoopInspectionResource {
                    schema_version: "accepted_antenna_inspection.closed_loop.v1".into(),
                    resource_id, project_id: project_id.as_str().into(),
                    owner: inspection.identity, port_mode_id, output_id,
                    capabilities: AntennaInspectionDisplayCapabilities {
                        display: true, current_density: true, per_ampere_basis: false,
                        source_fft: false, llg_drive: false,
                    },
                    normalization: "raw_authored_potential_jump".into(),
                    closed_loop_display: loaded.metadata,
                }))
            }
        }
    })
    .await
    .map_err(|e| ApiError::internal(format!("accepted antenna metadata worker: {e}")))??;
    let bytes = serde_json::to_vec(&resource).map_err(|e| ApiError::internal(e.to_string()))?;
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "{:x}",
        Sha256::digest(&bytes)
    ));
    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &resource))
}

#[cfg(test)]
mod tests {
    #[test]
    fn accepted_resources_require_publication_pins_and_do_not_invent_live_scope() {
        let document = <crate::openapi_v2::ApiDoc as utoipa::OpenApi>::openapi();
        let value = serde_json::to_value(document).unwrap();
        let discovery = "/v2/persistence/projects/{project_id}/runs/{run_id}/antenna-inspections";
        assert!(value["paths"][discovery]["get"].is_object());
        let base =
            "/v2/persistence/projects/{project_id}/runs/{run_id}/antenna-inspections/{step_id}";
        for path in [
            base.to_string(),
            format!("{base}/payloads/{{payload_kind}}"),
        ] {
            let parameters = value["paths"][&path]["get"]["parameters"]
                .as_array()
                .unwrap();
            for name in [
                "project_id",
                "run_id",
                "step_id",
                "attempt_id",
                "ownership_epoch",
                "package_object_ref",
            ] {
                assert!(
                    parameters
                        .iter()
                        .any(|p| p["name"] == name && p["required"] == true),
                    "{path}: {name}"
                );
            }
        }
        let properties =
            &value["components"]["schemas"]["AcceptedExternalLeadInspectionResource"]["properties"];
        for field in [
            "project_id",
            "owner",
            "port_mode_id",
            "output_id",
            "manifest",
            "display",
        ] {
            assert!(properties[field].is_object(), "{field}");
        }
        for field in [
            "session_id",
            "session_epoch",
            "runtime_stage_id",
            "record_content_digest",
        ] {
            assert!(
                properties.get(field).is_none(),
                "accepted resource must not invent {field}"
            );
        }
        let display =
            &value["components"]["schemas"]["AntennaInspectionDisplayDataResource"]["properties"];
        for field in [
            "capabilities",
            "device_potential",
            "device_current",
            "magnetic_field",
            "device_topology",
        ] {
            assert!(display[field].is_object(), "shared display: {field}");
        }
    }
}
