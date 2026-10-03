//! Read-only project-owned historical results, independent of active runtime.

pub mod saved_geometry;
pub mod scalar;
pub use scalar::get_solution_scalar;
pub use saved_geometry::{
    get_saved_field_geometry, get_saved_field_geometry_support,
    get_saved_field_geometry_topology,
};

use crate::schemas::materialized_dataset_slice::{
    MaterializedDatasetSliceBinaryBody, MaterializedDatasetSliceEnvelopeResource,
    MaterializedDatasetSliceQuery, MAX_SLICE_ENVELOPE_METADATA_BYTES,
};
use crate::{
    error::ApiError,
    schemas::{materialized_dataset::MaterializedDatasetResource, solutions::*},
    types::AppState,
};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, Response},
    Json,
};
use base64::Engine;
use fullmag_application::{ProjectId, RunId, RunSpecification};
use fullmag_quantities::{SolutionMember, SolutionSet};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_DISCOVERY_CURSOR_BYTES: usize = 4096;
const DISCOVERY_CURSOR_VERSION: u8 = 1;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SolutionSetDiscoveryCursor {
    version: u8,
    project_id: String,
    run_id: String,
    after_directory: String,
}

#[utoipa::path(get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets",
    params(("project_id" = String, Path), ("run_id" = String, Path), SolutionSetDiscoveryPageQuery),
    responses((status = 200, body = SolutionSetDiscoveryPageResource, description = "Bounded immutable SolutionSet references for one accepted run"), (status = 400, description = "Invalid, foreign, or unknown cursor"), (status = 404, description = "Missing accepted run storage or intent"), (status = 409, description = "Solution ownership or RunSpec mismatch")), tag = "persistence")]
pub async fn get_solution_set_discovery(
    State(state): State<Arc<AppState>>,
    Path((project_id, run_id)): Path<(String, String)>,
    Query(query): Query<SolutionSetDiscoveryPageQuery>,
) -> Result<Json<SolutionSetDiscoveryPageResource>, ApiError> {
    let limit = discovery_page_limit(query.limit)?;
    let after_directory = decode_discovery_cursor(query.cursor.as_deref(), &project_id, &run_id)?;
    let response_project_id = project_id.clone();
    let response_run_id = run_id.clone();
    with_verified_run(state, project_id, run_id, move |store, run_spec_digest| {
        let page = store
            .solution_sets()
            .list_run_page(&response_run_id, after_directory.as_deref(), limit)
            .map_err(map_discovery_storage_error)?;
        let expected_run_spec_digest = format!("sha256:{run_spec_digest}");
        let items = page
            .items
            .into_iter()
            .map(|item| {
                if item.run_id != response_run_id {
                    return Err(ApiError::conflict(
                        "solution discovery item belongs to another run",
                    ));
                }
                if item.run_spec_digest != expected_run_spec_digest {
                    return Err(ApiError::conflict(
                        "solution provenance differs from immutable RunSpec",
                    ));
                }
                Ok(SolutionSetDiscoveryRefResource {
                    solution_set_id: item.solution_set_id,
                    revision: item.revision.to_string(),
                    manifest_digest: item.manifest_digest,
                })
            })
            .collect::<Result<Vec<_>, ApiError>>()?;
        let next_cursor = page.next_after_directory.map(|directory| {
            encode_discovery_cursor(&response_project_id, &response_run_id, directory)
        });
        Ok(SolutionSetDiscoveryPageResource {
            schema_version: SOLUTION_SET_DISCOVERY_RESOURCE_SCHEMA.to_string(),
            project_id: response_project_id,
            run_id: response_run_id,
            items,
            next_cursor,
        })
    })
    .await
}

#[utoipa::path(get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}",
    params(("project_id" = String, Path), ("run_id" = String, Path), ("solution_set_id" = String, Path), ("revision" = String, Path, description = "Canonical positive decimal u64")),
    responses((status = 200, body = SolutionSetResource, description = "Pinned historical metadata; no runtime or CAS payload read"), (status = 400, description = "Invalid identity or revision"), (status = 404, description = "Missing run or solution revision"), (status = 409, description = "Project/run ownership mismatch")), tag = "persistence")]
pub async fn get_solution_revision(
    State(state): State<Arc<AppState>>,
    Path((project_id, run_id, solution_id, revision)): Path<(String, String, String, String)>,
) -> Result<Json<SolutionSetResource>, ApiError> {
    with_revision(
        state,
        project_id.clone(),
        run_id,
        solution_id,
        revision,
        move |_store, solution| {
            Ok(SolutionSetResource {
                schema_version: SOLUTION_RESOURCE_SCHEMA.to_string(),
                project_id,
                run_id: solution.run_id.clone(),
                solution_set_id: solution.solution_set_id.clone(),
                revision: solution.revision.to_string(),
                manifest_digest: manifest_digest(&solution)?,
                manifest_state: solution.manifest_state.into(),
                execution_status: solution.execution_status.into(),
                scientific_assessment: (&solution.scientific_assessment).into(),
                provenance: (&solution.provenance).into(),
                member_count: solution.members.len() as u64,
                artifact_count: solution
                    .members
                    .iter()
                    .map(|member| member.artifacts.len() as u64)
                    .sum(),
                coverage_count: solution.coverage.len() as u64,
            })
        },
    )
    .await
}
#[utoipa::path(get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}/members",
    params(("project_id" = String, Path), ("run_id" = String, Path), ("solution_set_id" = String, Path), ("revision" = String, Path), SolutionSetMemberPageQuery),
    responses((status = 200, body = SolutionSetMemberPageResource, description = "Bounded members of an immutable revision"), (status = 400, description = "Invalid page boundary"), (status = 404, description = "Missing run or solution revision"), (status = 409, description = "Ownership mismatch")), tag = "persistence")]
pub async fn get_solution_members(
    State(state): State<Arc<AppState>>,
    Path((project_id, run_id, solution_id, revision)): Path<(String, String, String, String)>,
    Query(query): Query<SolutionSetMemberPageQuery>,
) -> Result<Json<SolutionSetMemberPageResource>, ApiError> {
    let limit = page_limit(query.limit)?;
    with_revision(
        state,
        project_id.clone(),
        run_id,
        solution_id,
        revision,
        move |_store, solution| {
            let mut members = solution.members.iter().collect::<Vec<_>>();
            members.sort_unstable_by(|left, right| left.member_id.cmp(&right.member_id));
            let start = page_start(&members, query.after_member_id.as_deref(), |member| {
                member.member_id.as_str()
            })?;
            let items = members
                .iter()
                .skip(start)
                .take(limit)
                .map(|member| member_resource(member))
                .collect::<Vec<_>>();
            let next_after_member_id = (start + items.len() < members.len())
                .then(|| items.last().unwrap().member_id.clone());
            Ok(SolutionSetMemberPageResource {
                schema_version: SOLUTION_RESOURCE_SCHEMA.to_string(),
                project_id,
                run_id: solution.run_id.clone(),
                solution_set_id: solution.solution_set_id.clone(),
                revision: solution.revision.to_string(),
                manifest_digest: manifest_digest(&solution)?,
                items,
                next_after_member_id,
            })
        },
    )
    .await
}
#[utoipa::path(get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}/members/{member_id}/artifacts",
    params(("project_id" = String, Path), ("run_id" = String, Path), ("solution_set_id" = String, Path), ("revision" = String, Path), ("member_id" = String, Path), SolutionSetArtifactPageQuery),
    responses((status = 200, body = SolutionSetArtifactPageResource, description = "Bounded immutable CAS references; integrity is not_verified"), (status = 400, description = "Invalid page boundary"), (status = 404, description = "Missing revision or member"), (status = 409, description = "Ownership mismatch")), tag = "persistence")]
pub async fn get_solution_artifacts(
    State(state): State<Arc<AppState>>,
    Path((project_id, run_id, solution_id, revision, member_id)): Path<(
        String,
        String,
        String,
        String,
        String,
    )>,
    Query(query): Query<SolutionSetArtifactPageQuery>,
) -> Result<Json<SolutionSetArtifactPageResource>, ApiError> {
    let limit = page_limit(query.limit)?;
    with_revision(
        state,
        project_id.clone(),
        run_id,
        solution_id,
        revision,
        move |_store, solution| {
            let member = solution
                .members
                .iter()
                .find(|member| member.member_id == member_id)
                .ok_or_else(|| ApiError::not_found("solution member is missing"))?;
            let mut artifacts = member.artifacts.iter().collect::<Vec<_>>();
            artifacts.sort_unstable_by(|left, right| left.artifact_id.cmp(&right.artifact_id));
            let start = page_start(&artifacts, query.after_artifact_id.as_deref(), |artifact| {
                artifact.artifact_id.as_str()
            })?;
            let items = artifacts
                .iter()
                .skip(start)
                .take(limit)
                .map(|artifact| {
                    let coverage = solution
                        .coverage
                        .iter()
                        .find(|coverage| coverage.artifact_id == artifact.artifact_id);
                    SolutionSetArtifactResource {
                        artifact_id: artifact.artifact_id.clone(),
                        kind: artifact.kind.into(),
                        schema_id: artifact.schema_id.clone(),
                        object_ref: artifact.object_ref.clone(),
                        byte_length: artifact.byte_length.to_string(),
                        accepted_state: artifact.accepted_state.as_ref().map(|id| {
                            SolutionAcceptedStateIdResource {
                                run_id: id.run_id.clone(),
                                stage_id: id.stage_id.clone(),
                                accepted_step: id.accepted_step.to_string(),
                                clock_digest: id.clock_digest.clone(),
                                state_digest: id.state_digest.clone(),
                                domain_digest: id.domain_digest.clone(),
                                plan_digest: id.plan_digest.clone(),
                            }
                        }),
                        integrity: SolutionArtifactIntegrityStatusResource::NotVerified,
                        coverage: coverage.map(|coverage| SolutionCoverageSummaryResource {
                            state: coverage.state.into(),
                            expected_samples: coverage
                                .expected_samples
                                .map(|value| value.to_string()),
                            committed_samples: coverage.committed_samples.to_string(),
                            segment_count: coverage.segments.len() as u64,
                        }),
                        scientific_evidence: solution
                            .scientific_assessment
                            .evidence_artifact_ids
                            .contains(&artifact.artifact_id)
                            || member
                                .scientific_assessment
                                .evidence_artifact_ids
                                .contains(&artifact.artifact_id),
                    }
                })
                .collect::<Vec<_>>();
            let next_after_artifact_id = (start + items.len() < artifacts.len())
                .then(|| items.last().unwrap().artifact_id.clone());
            Ok(SolutionSetArtifactPageResource {
                schema_version: SOLUTION_RESOURCE_SCHEMA.to_string(),
                project_id,
                run_id: solution.run_id.clone(),
                solution_set_id: solution.solution_set_id.clone(),
                revision: solution.revision.to_string(),
                manifest_digest: manifest_digest(&solution)?,
                member_id,
                items,
                next_after_artifact_id,
            })
        },
    )
    .await
}

#[utoipa::path(get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}/members/{member_id}/artifacts/{artifact_id}/materialized-dataset",
    params(("project_id" = String, Path), ("run_id" = String, Path), ("solution_set_id" = String, Path), ("revision" = String, Path, description = "Canonical positive decimal u64"), ("member_id" = String, Path), ("artifact_id" = String, Path)),
    responses((status = 200, body = MaterializedDatasetResource, description = "Verified typed materialized dataset manifest"), (status = 400, description = "Invalid identity or revision"), (status = 404, description = "Missing run, solution revision, member, or artifact"), (status = 409, description = "Ownership mismatch"), (status = 500, description = "Invalid or oversized manifest")), tag = "persistence")]
pub async fn get_materialized_dataset(
    State(state): State<Arc<AppState>>,
    Path((project_id, run_id, solution_id, revision, member_id, artifact_id)): Path<(
        String,
        String,
        String,
        String,
        String,
        String,
    )>,
) -> Result<Json<MaterializedDatasetResource>, ApiError> {
    validate_lookup_id(&member_id, "member")?;
    validate_lookup_id(&artifact_id, "artifact")?;
    let response_run_id = run_id.clone();
    with_revision(
        state,
        project_id.clone(),
        run_id,
        solution_id,
        revision,
        move |store, solution| {
            let resolved =
                fullmag_session::materialized_dataset::read_materialized_dataset_artifact(
                    store,
                    &solution,
                    &member_id,
                    &artifact_id,
                )
                .map_err(|error| ApiError::internal(error.to_string()))?
                .ok_or_else(|| ApiError::not_found("materialized dataset artifact is missing"))?;
            MaterializedDatasetResource::from_resolved(project_id, response_run_id, &resolved)
                .map_err(|error| ApiError::internal(error.to_string()))
        },
    )
    .await
}

#[utoipa::path(get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}/members/{member_id}/artifacts/{artifact_id}/materialized-dataset/slice",
    params(("project_id" = String, Path), ("run_id" = String, Path), ("solution_set_id" = String, Path), ("revision" = String, Path, description = "Canonical positive decimal u64"), ("member_id" = String, Path), ("artifact_id" = String, Path), MaterializedDatasetSliceQuery),
    responses((status = 200, body = inline(MaterializedDatasetSliceBinaryBody), content_type = "application/octet-stream", description = "FMDS v1: 12-byte header, bounded JSON MaterializedDatasetSliceEnvelopeResource, then exact raw part bytes"), (status = 400, description = "Invalid identity, canonical counters, bounds or budget"), (status = 404, description = "Missing accepted run, revision, member or artifact"), (status = 409, description = "Pinned manifest, dataset or ownership mismatch"), (status = 422, description = "Requested slice metadata exceeds the 1 MiB envelope budget"), (status = 500, description = "Corrupt, nonfinite or unsupported persisted field")), tag = "persistence")]
pub async fn get_materialized_dataset_slice(
    State(state): State<Arc<AppState>>,
    Path((project_id, run_id, solution_id, revision, member_id, artifact_id)): Path<(
        String,
        String,
        String,
        String,
        String,
        String,
    )>,
    Query(query): Query<MaterializedDatasetSliceQuery>,
) -> Result<Response<Body>, ApiError> {
    validate_lookup_id(&member_id, "member")?;
    validate_lookup_id(&artifact_id, "artifact")?;
    if !fullmag_quantities::is_canonical_sha256(&format!(
        "sha256:{}",
        query.expected_manifest_object_ref
    )) {
        return Err(ApiError::bad_request(
            "expected manifest object ref must be a bare lowercase SHA-256 hash",
        ));
    }
    let request = slice_request(&query)?;
    let body = with_revision_value(
        state, project_id.clone(), run_id, solution_id, revision,
        move |store, solution| {
            let resolved = fullmag_session::materialized_dataset::read_materialized_dataset_slice(
                store, &solution, &member_id, &artifact_id,
                &query.expected_manifest_object_ref, &request,
            ).map_err(|error| {
                if error.is::<fullmag_session::materialized_dataset::MaterializedDatasetSliceIdentityMismatch>() {
                    ApiError::conflict(error.to_string())
                } else if let Some(slice_error) = error.downcast_ref::<fullmag_quantities::DatasetSliceError>() {
                    if matches!(slice_error, fullmag_quantities::DatasetSliceError::NonFinitePayloadValue { .. }) {
                        ApiError::internal(error.to_string())
                    } else {
                        ApiError::bad_request(error.to_string())
                    }
                } else {
                    ApiError::internal(error.to_string())
                }
            })?.ok_or_else(|| ApiError::not_found("materialized dataset artifact is missing"))?;
            encode_materialized_dataset_slice(project_id, resolved)
        },
    ).await?;
    Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::CONTENT_LENGTH, body.len().to_string())
        .body(Body::from(body))
        .map_err(|error| ApiError::internal(error.to_string()))
}

fn slice_request(
    query: &MaterializedDatasetSliceQuery,
) -> Result<fullmag_quantities::DatasetFieldSliceRequest, ApiError> {
    let request = fullmag_quantities::DatasetFieldSliceRequest {
        schema_version: query.schema_version.clone(),
        dataset: fullmag_quantities::MaterializedDatasetRef {
            dataset_id: query.dataset_id.clone(),
            revision: parse_revision(&query.dataset_revision)?,
        },
        sample_id: query.sample_id.clone(),
        item_id: query.item_id.clone(),
        field_id: query.field_id.clone(),
        element_offset: parse_slice_counter(&query.element_offset)?,
        element_count: parse_slice_counter(&query.element_count)?,
        max_response_bytes: parse_slice_counter(&query.max_response_bytes)?,
    };
    for (kind, value) in [
        ("dataset", &request.dataset.dataset_id),
        ("sample", &request.sample_id),
        ("item", &request.item_id),
        ("field", &request.field_id),
    ] {
        validate_lookup_id(value, kind)?;
    }
    request
        .validate()
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    Ok(request)
}

fn parse_slice_counter(value: &str) -> Result<u64, ApiError> {
    let counter = value
        .parse::<u64>()
        .map_err(|_| ApiError::bad_request("slice counters must be canonical decimal u64"))?;
    if counter.to_string() != value {
        return Err(ApiError::bad_request(
            "slice counters must be canonical decimal u64",
        ));
    }
    Ok(counter)
}

fn encode_materialized_dataset_slice(
    project_id: String,
    resolved: fullmag_session::materialized_dataset::ResolvedMaterializedDatasetSlice,
) -> Result<Vec<u8>, ApiError> {
    let metadata = serialize_slice_metadata(
        &MaterializedDatasetSliceEnvelopeResource::from_resolved(project_id, &resolved),
    )?;
    let payload_len = usize::try_from(resolved.field.slice.manifest.payload_bytes)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let total = 12_usize
        .checked_add(metadata.len())
        .and_then(|length| length.checked_add(payload_len))
        .ok_or_else(|| ApiError::internal("dataset slice envelope length overflow"))?;
    let mut body = Vec::with_capacity(total);
    body.extend_from_slice(b"FMDS");
    body.extend_from_slice(&1_u16.to_le_bytes());
    body.extend_from_slice(&0_u16.to_le_bytes());
    body.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
    body.extend_from_slice(&metadata);
    for part in resolved.field.slice.part_bytes {
        body.extend_from_slice(&part);
    }
    if body.len() != total {
        return Err(ApiError::internal(
            "dataset slice payload differs from declared byte length",
        ));
    }
    Ok(body)
}

fn serialize_slice_metadata<T: Serialize>(value: &T) -> Result<Vec<u8>, ApiError> {
    let metadata =
        serde_json::to_vec(value).map_err(|error| ApiError::internal(error.to_string()))?;
    if metadata.len() > MAX_SLICE_ENVELOPE_METADATA_BYTES {
        return Err(ApiError::unprocessable(
            "DATASET_SLICE_METADATA_BYTE_LIMIT: requested slice metadata exceeds 1 MiB; request fewer elements or use a supported descriptor",
        ));
    }
    Ok(metadata)
}

async fn with_revision<T: Serialize + Send + 'static>(
    state: Arc<AppState>,
    project: String,
    run: String,
    solution_id: String,
    revision: String,
    build: impl FnOnce(&fullmag_session::SessionStore, SolutionSet) -> Result<T, ApiError>
        + Send
        + 'static,
) -> Result<Json<T>, ApiError> {
    bounded_json(with_revision_value(state, project, run, solution_id, revision, build).await?)
}

async fn with_revision_value<T: Send + 'static>(
    state: Arc<AppState>,
    project: String,
    run: String,
    solution_id: String,
    revision: String,
    build: impl FnOnce(&fullmag_session::SessionStore, SolutionSet) -> Result<T, ApiError>
        + Send
        + 'static,
) -> Result<T, ApiError> {
    validate_solution_id(&solution_id)?;
    let revision = parse_revision(&revision)?;
    let expected_run_id = run.clone();
    with_verified_run_value(state, project, run, move |store, run_spec_digest| {
        let solution = store
            .solution_sets()
            .read_revision(&solution_id, revision)
            .map_err(|error| ApiError::internal(error.to_string()))?
            .ok_or_else(|| ApiError::not_found("solution revision is missing"))?;
        validate_solution_owner(&solution, &expected_run_id, run_spec_digest)?;
        build(store, solution)
    })
    .await
}

async fn with_verified_run<T: Serialize + Send + 'static>(
    state: Arc<AppState>,
    project: String,
    run: String,
    build: impl FnOnce(&fullmag_session::SessionStore, &str) -> Result<T, ApiError> + Send + 'static,
) -> Result<Json<T>, ApiError> {
    bounded_json(with_verified_run_value(state, project, run, build).await?)
}

async fn with_verified_run_value<T: Send + 'static>(
    state: Arc<AppState>,
    project: String,
    run: String,
    build: impl FnOnce(&fullmag_session::SessionStore, &str) -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    let project =
        ProjectId::parse(project).map_err(|error| ApiError::bad_request(error.to_string()))?;
    let run = RunId::parse(run).map_err(|error| ApiError::bad_request(error.to_string()))?;
    tokio::task::spawn_blocking(move || {
        let root = state
            .submit_store_root
            .as_ref()
            .ok_or_else(|| ApiError::internal("managed project run storage is not configured"))?;
        match std::fs::symlink_metadata(root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(ApiError::not_found("accepted run storage is missing"))
            }
            Err(error) => return Err(ApiError::internal(error.to_string())),
            Ok(_) => {}
        }
        let store = fullmag_session::SessionStore::open_existing(root)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let intent = store
            .read_run_intent(run.as_str())
            .map_err(|error| ApiError::internal(error.to_string()))?
            .ok_or_else(|| ApiError::not_found("accepted run intent is missing"))?;
        let specification: RunSpecification = serde_json::from_value(intent.specification)
            .map_err(|error| ApiError::internal(format!("invalid durable RunSpec: {error}")))?;
        if specification.snapshot.project_id != project {
            return Err(ApiError::conflict("run belongs to another project"));
        }
        if specification.run_id != run
            || specification
                .fingerprint()
                .map_err(|error| ApiError::internal(error.to_string()))?
                != intent.payload_sha256
        {
            return Err(ApiError::internal(
                "durable run identity or fingerprint is inconsistent",
            ));
        }
        build(&store, &intent.payload_sha256)
    })
    .await
    .map_err(|error| ApiError::internal(format!("solution read task failed: {error}")))?
}

fn validate_solution_owner(
    solution: &SolutionSet,
    run_id: &str,
    run_spec_digest: &str,
) -> Result<(), ApiError> {
    if solution.run_id != run_id {
        return Err(ApiError::conflict("solution belongs to another run"));
    }
    if solution.provenance.run_spec_digest != format!("sha256:{run_spec_digest}") {
        return Err(ApiError::conflict(
            "solution provenance differs from immutable RunSpec",
        ));
    }
    Ok(())
}

fn validate_solution_id(value: &str) -> Result<(), ApiError> {
    validate_lookup_id(value, "solution-set")
}

fn validate_lookup_id(value: &str, kind: &str) -> Result<(), ApiError> {
    if value.trim().is_empty() || value.len() > 1024 || value.chars().any(char::is_control) {
        return Err(ApiError::bad_request(format!("invalid {kind} identity")));
    }
    Ok(())
}

fn discovery_page_limit(value: Option<usize>) -> Result<usize, ApiError> {
    let value = value.unwrap_or(25);
    if !(1..=50).contains(&value) {
        return Err(ApiError::bad_request(
            "solution-set discovery limit must be in 1..=50",
        ));
    }
    Ok(value)
}

fn decode_discovery_cursor(
    value: Option<&str>,
    project_id: &str,
    run_id: &str,
) -> Result<Option<String>, ApiError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_empty() || value.len() > MAX_DISCOVERY_CURSOR_BYTES {
        return Err(ApiError::bad_request(
            "solution-set discovery cursor is oversized",
        ));
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value.as_bytes())
        .map_err(|_| {
            ApiError::bad_request("solution-set discovery cursor is not valid base64url")
        })?;
    if bytes.len() > MAX_DISCOVERY_CURSOR_BYTES {
        return Err(ApiError::bad_request(
            "solution-set discovery cursor is oversized",
        ));
    }
    let cursor: SolutionSetDiscoveryCursor = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::bad_request("solution-set discovery cursor payload is invalid"))?;
    if cursor.version != DISCOVERY_CURSOR_VERSION {
        return Err(ApiError::bad_request(
            "solution-set discovery cursor version is unsupported",
        ));
    }
    if cursor.project_id != project_id || cursor.run_id != run_id {
        return Err(ApiError::bad_request(
            "solution-set discovery cursor belongs to another project or run",
        ));
    }
    validate_directory_cursor(&cursor.after_directory)?;
    let canonical =
        serde_json::to_vec(&cursor).map_err(|error| ApiError::internal(error.to_string()))?;
    let canonical_encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&canonical);
    if canonical_encoded != value {
        return Err(ApiError::bad_request(
            "solution-set discovery cursor is not canonical",
        ));
    }
    Ok(Some(cursor.after_directory))
}

fn encode_discovery_cursor(project_id: &str, run_id: &str, after_directory: String) -> String {
    let cursor = SolutionSetDiscoveryCursor {
        version: DISCOVERY_CURSOR_VERSION,
        project_id: project_id.to_string(),
        run_id: run_id.to_string(),
        after_directory,
    };
    let bytes = serde_json::to_vec(&cursor).expect("discovery cursor serializes");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn validate_directory_cursor(value: &str) -> Result<(), ApiError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ApiError::bad_request(
            "solution-set discovery cursor boundary is not a canonical directory hash",
        ));
    }
    Ok(())
}

fn map_discovery_storage_error(error: anyhow::Error) -> ApiError {
    let message = error.to_string();
    if message.contains("solution-set discovery cursor is unknown") {
        ApiError::bad_request("solution-set discovery cursor is unknown")
    } else {
        ApiError::internal(message)
    }
}

fn parse_revision(value: &str) -> Result<u64, ApiError> {
    let revision = value
        .parse::<u64>()
        .map_err(|_| ApiError::bad_request("revision must be a canonical positive decimal u64"))?;
    if revision == 0 || revision.to_string() != value {
        return Err(ApiError::bad_request(
            "revision must be a canonical positive decimal u64",
        ));
    }
    Ok(revision)
}
fn manifest_digest(solution: &SolutionSet) -> Result<String, ApiError> {
    let value =
        serde_json::to_value(solution).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(format!(
        "sha256:{}",
        fullmag_session::canonical_json_sha256(&value)
    ))
}
fn page_limit(value: Option<usize>) -> Result<usize, ApiError> {
    let value = value.unwrap_or(50);
    if !(1..=100).contains(&value) {
        return Err(ApiError::bad_request(
            "solution page limit must be in 1..=100",
        ));
    }
    Ok(value)
}
fn page_start<T>(
    items: &[T],
    after: Option<&str>,
    identity: impl Fn(&T) -> &str,
) -> Result<usize, ApiError> {
    match after {
        None => Ok(0),
        Some(after) => items
            .iter()
            .position(|item| identity(item) == after)
            .map(|index| index + 1)
            .ok_or_else(|| {
                ApiError::bad_request("page boundary does not belong to this pinned resource")
            }),
    }
}
fn bounded_json<T: Serialize>(value: T) -> Result<Json<T>, ApiError> {
    let bytes =
        serde_json::to_vec(&value).map_err(|error| ApiError::internal(error.to_string()))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(ApiError::internal(
            "SOLUTION_RESPONSE_BYTE_LIMIT: metadata response exceeds 1 MiB",
        ));
    }
    Ok(Json(value))
}
fn member_resource(member: &SolutionMember) -> SolutionSetMemberResource {
    SolutionSetMemberResource {
        member_id: member.member_id.clone(),
        task_id: member.task_id.clone(),
        attempt_id: member.attempt_id.clone(),
        ownership_epoch: member.ownership_epoch.to_string(),
        case_id: member.case_id.clone(),
        stage_id: member.stage_id.clone(),
        execution_status: member.execution_status.into(),
        scientific_assessment: (&member.scientific_assessment).into(),
        artifact_count: member.artifacts.len() as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dataset_slice_counters_preserve_u64_without_accepting_noncanonical_input() {
        assert_eq!(parse_slice_counter("0").unwrap(), 0);
        assert_eq!(
            parse_slice_counter("9007199254740993").unwrap(),
            9007199254740993
        );
        assert_eq!(
            parse_slice_counter("18446744073709551615").unwrap(),
            u64::MAX
        );
        for value in ["01", "+1", "-1", " 1", "1.0", "18446744073709551616"] {
            assert_eq!(
                parse_slice_counter(value).unwrap_err().status,
                axum::http::StatusCode::BAD_REQUEST
            );
        }
    }

    #[test]
    fn dataset_slice_query_rejects_unknown_fields_and_zero_budget() {
        let mut query = serde_json::json!({
            "schema_version": "1.0.0", "dataset_id": "dataset", "dataset_revision": "1",
            "sample_id": "sample", "item_id": "item", "field_id": "field",
            "expected_manifest_object_ref": "a".repeat(64), "element_offset": "0", "element_count": "1", "max_response_bytes": "8",
        });
        let parsed: MaterializedDatasetSliceQuery = serde_json::from_value(query.clone()).unwrap();
        assert!(slice_request(&parsed).is_ok());
        query["max_response_bytes"] = serde_json::json!("0");
        let parsed: MaterializedDatasetSliceQuery = serde_json::from_value(query.clone()).unwrap();
        assert_eq!(
            slice_request(&parsed).unwrap_err().status,
            axum::http::StatusCode::BAD_REQUEST
        );
        query["unscoped_source"] = serde_json::json!("current");
        assert!(serde_json::from_value::<MaterializedDatasetSliceQuery>(query).is_err());
    }

    #[test]
    fn legal_fragmented_slice_exceeding_http_metadata_budget_is_not_storage_corruption() {
        use crate::schemas::materialized_dataset_slice::{
            MaterializedDatasetSliceByteOrderResource, MaterializedDatasetSliceManifestResource,
            MaterializedDatasetSlicePartResource, MaterializedDatasetSlicePrecisionResource,
        };
        let value = MaterializedDatasetSliceManifestResource {
            schema_version: "1.0.0".to_string(), dataset_id: "dataset".to_string(), dataset_revision: "1".to_string(),
            sample_id: "sample".to_string(), item_id: "item".to_string(), field_id: "field".to_string(),
            field_layout_digest: format!("sha256:{}", "a".repeat(64)), element_offset: "0".to_string(),
            element_count: "4096".to_string(), total_elements: "4096".to_string(), component_count: "1".to_string(),
            precision: MaterializedDatasetSlicePrecisionResource::F64,
            byte_order: MaterializedDatasetSliceByteOrderResource::LittleEndian, payload_bytes: "32768".to_string(),
            parts: (0..4096).map(|index| MaterializedDatasetSlicePartResource {
                plane: crate::schemas::materialized_dataset::MaterializedDatasetPlaneResource::Values,
                object_ref: "a".repeat(64), object_offset_bytes: "0".to_string(),
                plane_offset_bytes: (index * 8).to_string(), byte_length: "8".to_string(),
                range_sha256: format!("sha256:{}", "b".repeat(64)),
            }).collect(),
        };
        let error = serialize_slice_metadata(&value).unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::UNPROCESSABLE_ENTITY);
        assert!(error.message.contains("DATASET_SLICE_METADATA_BYTE_LIMIT"));
    }
    #[test]
    fn invalid_logical_identity_is_bad_request_without_storage_access() {
        for value in ["", " ", "solution:\n", "solution:\u{0085}"] {
            assert_eq!(
                validate_solution_id(value).unwrap_err().status,
                axum::http::StatusCode::BAD_REQUEST
            );
        }
        assert!(validate_solution_id(&"x".repeat(1025)).is_err());
        assert!(validate_solution_id(&"ą".repeat(513)).is_err());
        assert!(validate_solution_id("solution:opaque/with\\separator").is_ok());
    }

    #[test]
    fn materialized_dataset_lookup_ids_are_fenced_before_storage_access() {
        for value in ["", " ", "member:\n", "artifact:\u{0085}"] {
            assert_eq!(
                validate_lookup_id(value, "member").unwrap_err().status,
                axum::http::StatusCode::BAD_REQUEST
            );
            assert_eq!(
                validate_lookup_id(value, "artifact").unwrap_err().status,
                axum::http::StatusCode::BAD_REQUEST
            );
        }
        assert!(validate_lookup_id("member:opaque/with\\separator", "member").is_ok());
        assert!(validate_lookup_id(&"x".repeat(1025), "artifact").is_err());
    }
    #[test]
    fn oversized_metadata_is_an_error_not_a_truncated_success() {
        assert!(bounded_json("x".repeat(MAX_RESPONSE_BYTES))
            .unwrap_err()
            .message
            .starts_with("SOLUTION_RESPONSE_BYTE_LIMIT:"));
    }
    #[test]
    fn solution_owner_and_pinned_digest_survive_later_revisions() {
        let digest = |c: char| format!("sha256:{}", c.to_string().repeat(64));
        let mut solution = SolutionSet {
            schema_version: fullmag_quantities::SOLUTION_SET_SCHEMA_VERSION.to_string(),
            solution_set_id: "solution:test".to_string(),
            revision: 1,
            run_id: "run:test".to_string(),
            manifest_state: fullmag_quantities::SolutionSetManifestState::Open,
            execution_status: fullmag_quantities::SolutionExecutionStatus::Running,
            scientific_assessment: fullmag_quantities::ScientificAssessment {
                status: fullmag_quantities::ScientificAssessmentStatus::Unassessed,
                reason: Some("pending".to_string()),
                evidence_artifact_ids: Vec::new(),
            },
            provenance: fullmag_quantities::SolutionSetProvenance {
                run_spec_digest: digest('a'),
                model_digest: digest('b'),
                physics_digest: digest('c'),
                discretization_digest: digest('d'),
                resolved_plan_digest: digest('e'),
                acquisition_digest: digest('f'),
                seed_digest: None,
            },
            members: Vec::new(),
            coverage: Vec::new(),
        };
        assert!(validate_solution_owner(&solution, "run:test", &"a".repeat(64)).is_ok());
        assert_eq!(
            validate_solution_owner(&solution, "run:foreign", &"a".repeat(64))
                .unwrap_err()
                .status,
            axum::http::StatusCode::CONFLICT
        );
        assert!(validate_solution_owner(&solution, "run:test", &"b".repeat(64)).is_err());
        let pinned = solution.clone();
        let digest = manifest_digest(&pinned).unwrap();
        solution.revision = 2;
        assert_ne!(manifest_digest(&solution).unwrap(), digest);
        assert_eq!(manifest_digest(&pinned).unwrap(), digest);
    }

    #[test]
    fn revision_strings_preserve_u64_and_reject_noncanonical_aliases() {
        assert_eq!(parse_revision("18446744073709551615").unwrap(), u64::MAX);
        assert_eq!(
            parse_revision("9007199254740993").unwrap(),
            9007199254740993
        );
        for value in ["", "0", "01", "+1", "1.0", " 1", "18446744073709551616"] {
            assert!(parse_revision(value).is_err(), "{value}");
        }
    }
    #[test]
    fn pages_are_bounded_and_boundaries_must_belong_to_pinned_resource() {
        assert_eq!(page_limit(None).unwrap(), 50);
        assert!(page_limit(Some(0)).is_err());
        assert!(page_limit(Some(101)).is_err());
        let items = ["a", "b", "c"];
        assert_eq!(page_start(&items, Some("b"), |value| value).unwrap(), 2);
        assert!(page_start(&items, Some("foreign"), |value| value).is_err());
    }

    #[test]
    fn discovery_cursor_round_trip_is_project_run_bound_and_preserves_u64_boundaries() {
        let project_id = "project:discovery";
        let run_id = "run:discovery";
        let directory = "a".repeat(64);
        let encoded = encode_discovery_cursor(project_id, run_id, directory.clone());
        assert!(!encoded.contains('='));
        assert_eq!(
            decode_discovery_cursor(Some(&encoded), project_id, run_id).unwrap(),
            Some(directory)
        );
        assert!(decode_discovery_cursor(Some(&encoded), "project:other", run_id).is_err());
        assert!(decode_discovery_cursor(Some(&encoded), project_id, "run:other").is_err());
        assert_eq!(u64::MAX.to_string(), "18446744073709551615");
        assert_eq!(discovery_page_limit(None).unwrap(), 25);
        assert_eq!(discovery_page_limit(Some(50)).unwrap(), 50);
        assert!(discovery_page_limit(Some(51)).is_err());
    }

    #[test]
    fn discovery_cursor_rejects_noncanonical_payload_and_bad_boundaries() {
        let directory = "b".repeat(64);
        let cursor = SolutionSetDiscoveryCursor {
            version: DISCOVERY_CURSOR_VERSION,
            project_id: "project:discovery".to_string(),
            run_id: "run:discovery".to_string(),
            after_directory: directory,
        };
        let pretty = serde_json::to_vec_pretty(&cursor).unwrap();
        let noncanonical = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(pretty);
        assert!(
            decode_discovery_cursor(Some(&noncanonical), "project:discovery", "run:discovery")
                .is_err()
        );
        let malformed = encode_discovery_cursor(
            "project:discovery",
            "run:discovery",
            "not-a-directory-hash".to_string(),
        );
        assert!(
            decode_discovery_cursor(Some(&malformed), "project:discovery", "run:discovery")
                .is_err()
        );
        assert!(decode_discovery_cursor(
            Some(&"x".repeat(4097)),
            "project:discovery",
            "run:discovery"
        )
        .is_err());
    }

    #[test]
    fn discovery_storage_unknown_cursor_is_client_error_but_corruption_is_server_error() {
        assert_eq!(
            map_discovery_storage_error(anyhow::anyhow!(
                "solution-set discovery cursor is unknown"
            ))
            .status,
            axum::http::StatusCode::BAD_REQUEST
        );
        assert_eq!(
            map_discovery_storage_error(anyhow::anyhow!("corrupt solution-set manifest")).status,
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
