//! Read-only project-owned historical results, independent of active runtime.
use crate::{
    error::ApiError,
    schemas::{materialized_dataset::MaterializedDatasetResource, solutions::*},
    types::AppState,
};
use axum::{
    extract::{Path, Query, State},
    Json,
};
use fullmag_application::{ProjectId, RunId, RunSpecification};
use fullmag_quantities::{SolutionMember, SolutionSet};
use serde::Serialize;
use std::sync::Arc;

const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

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
    let project =
        ProjectId::parse(project).map_err(|error| ApiError::bad_request(error.to_string()))?;
    let run = RunId::parse(run).map_err(|error| ApiError::bad_request(error.to_string()))?;
    let revision = parse_revision(&revision)?;
    validate_solution_id(&solution_id)?;
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
        let solution = store
            .solution_sets()
            .read_revision(&solution_id, revision)
            .map_err(|error| ApiError::internal(error.to_string()))?
            .ok_or_else(|| ApiError::not_found("solution revision is missing"))?;
        validate_solution_owner(&solution, run.as_str(), &intent.payload_sha256)?;
        bounded_json(build(&store, solution)?)
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
}
