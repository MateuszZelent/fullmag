//! Bounded, immutable scalar projection through the canonical study decoder.
use super::{manifest_digest, validate_lookup_id, with_revision};
use crate::{error::ApiError, schemas::solutions::*, types::AppState};
use axum::{
    extract::{Path, State},
    Json,
};
use fullmag_application::{
    decode_study_artifact, DecodedStudyArtifact, ResolvedStudyArtifact, STUDY_SCALAR_CODEC_ID,
    STUDY_SCALAR_CODEC_VERSION,
};
use std::sync::Arc;

#[utoipa::path(get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}/members/{member_id}/artifacts/{artifact_id}/scalar",
    params(("project_id" = String, Path), ("run_id" = String, Path), ("solution_set_id" = String, Path), ("revision" = String, Path, description = "Canonical positive decimal u64"), ("member_id" = String, Path), ("artifact_id" = String, Path)),
    responses((status = 200, body = SolutionScalarResource, description = "Verified bounded scalar; scientific assessment remains independent"), (status = 400, description = "Invalid identity or revision"), (status = 404, description = "Missing run, revision, member or artifact"), (status = 409, description = "Foreign owner or incompatible artifact schema"), (status = 500, description = "Corrupt, oversized or invalid scalar")), tag = "persistence")]
pub async fn get_solution_scalar(
    State(state): State<Arc<AppState>>,
    Path((project_id, run_id, solution_id, revision, member_id, artifact_id)): Path<(
        String,
        String,
        String,
        String,
        String,
        String,
    )>,
) -> Result<Json<SolutionScalarResource>, ApiError> {
    validate_lookup_id(&member_id, "member")?;
    validate_lookup_id(&artifact_id, "artifact")?;
    with_revision(
        state,
        project_id.clone(),
        run_id,
        solution_id,
        revision,
        move |store, solution| {
            let member = solution
                .members
                .iter()
                .find(|member| member.member_id == member_id)
                .ok_or_else(|| ApiError::not_found("solution member is missing"))?;
            let artifact = member
                .artifacts
                .iter()
                .find(|artifact| artifact.artifact_id == artifact_id)
                .ok_or_else(|| ApiError::not_found("solution scalar artifact is missing"))?;
            if artifact.kind != fullmag_quantities::SolutionArtifactKind::Table
                || artifact.schema_id
                    != fullmag_session::solution_scalar_source::SOLUTION_SCALAR_SCHEMA
            {
                return Err(ApiError::conflict(
                    "solution artifact is not a supported scalar",
                ));
            }
            let source = fullmag_session::solution_scalar_source::PinnedSolutionScalarSource {
                run_id: solution.run_id.clone(),
                solution_set_id: solution.solution_set_id.clone(),
                solution_revision: solution.revision,
                member_id: member_id.clone(),
                artifact_id: artifact_id.clone(),
                scalar_object_ref: artifact.object_ref.clone(),
                run_spec_digest: solution.provenance.run_spec_digest.clone(),
            };
            let resolved =
                fullmag_session::solution_scalar_source::resolve_solution_scalar(store, &source)
                    .map_err(|_| ApiError::internal("pinned scalar storage validation failed"))?;
            let scalar = decode_scalar(&resolved.artifact, &resolved.bytes)?;
            Ok(SolutionScalarResource {
                schema_version: "fullmag.analysis.solution_scalar.v1".to_string(),
                project_id,
                run_id: solution.run_id.clone(),
                solution_set_id: solution.solution_set_id.clone(),
                revision: solution.revision.to_string(),
                manifest_digest: manifest_digest(&solution)?,
                member_id,
                task_id: member.task_id.clone(),
                attempt_id: member.attempt_id.clone(),
                ownership_epoch: member.ownership_epoch.to_string(),
                artifact_id,
                object_ref: artifact.object_ref.clone(),
                byte_length: artifact.byte_length.to_string(),
                quantity_id: scalar.quantity_id,
                unit: scalar.unit,
                value_si: scalar.value_si,
                step: scalar.step.to_string(),
                time_s: scalar.time_s,
                integrity: SolutionScalarIntegrityResource::Verified,
                manifest_state: solution.manifest_state.into(),
                execution_status: solution.execution_status.into(),
                member_execution_status: member.execution_status.into(),
                scientific_assessment: (&solution.scientific_assessment).into(),
                member_scientific_assessment: (&member.scientific_assessment).into(),
                provenance: (&solution.provenance).into(),
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
            })
        },
    )
    .await
}

fn decode_scalar(
    artifact: &fullmag_quantities::SolutionArtifactRef,
    bytes: &[u8],
) -> Result<fullmag_application::StudyScalarArtifact, ApiError> {
    let descriptor = ResolvedStudyArtifact {
        artifact_id: artifact.artifact_id.clone(),
        object_ref: artifact.object_ref.clone(),
        data_kind: "scalar".to_string(),
        codec_id: STUDY_SCALAR_CODEC_ID.to_string(),
        codec_version: STUDY_SCALAR_CODEC_VERSION.to_string(),
    };
    match decode_study_artifact(&descriptor, bytes)
        .map_err(|_| ApiError::internal("persisted scalar payload is invalid"))?
    {
        DecodedStudyArtifact::Scalar(scalar) => Ok(scalar),
        _ => Err(ApiError::internal(
            "persisted scalar codec returned another data kind",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalar_artifact_schema_matches_the_existing_producer_codec_tuple() {
        assert_eq!(
            fullmag_session::solution_scalar_source::SOLUTION_SCALAR_SCHEMA,
            format!("{STUDY_SCALAR_CODEC_ID}@{STUDY_SCALAR_CODEC_VERSION}")
        );
    }

    #[test]
    fn openapi_registers_scalar_with_lossless_counters_and_independent_assessment() {
        let document = crate::openapi_v2::openapi_json();
        let path = "/v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}/members/{member_id}/artifacts/{artifact_id}/scalar";
        assert_eq!(
            document["paths"][path]["get"]["responses"]["200"]["content"]["application/json"]
                ["schema"]["$ref"],
            "#/components/schemas/SolutionScalarResource"
        );
        let properties = &document["components"]["schemas"]["SolutionScalarResource"]["properties"];
        for field in ["step", "revision", "byte_length", "ownership_epoch"] {
            assert_eq!(properties[field]["type"], "string");
        }
        for field in [
            "accepted_state",
            "scientific_assessment",
            "member_scientific_assessment",
            "provenance",
            "integrity",
        ] {
            assert!(!properties[field].is_null(), "{field}");
        }
    }

    fn fixture(bytes: &[u8]) -> fullmag_quantities::SolutionArtifactRef {
        fullmag_quantities::SolutionArtifactRef {
            artifact_id: "artifact-energy".to_string(),
            kind: fullmag_quantities::SolutionArtifactKind::Table,
            schema_id: fullmag_session::solution_scalar_source::SOLUTION_SCALAR_SCHEMA.to_string(),
            object_ref: fullmag_application::study_artifact_content_sha256(bytes),
            byte_length: bytes.len() as u64,
            accepted_state: None,
        }
    }

    #[test]
    fn scalar_projection_preserves_si_and_exact_step_without_inventing_acceptance() {
        let bytes = br#"{"schema_version":"study_scalar.v1","quantity_id":"total_energy","unit":"J","value_si":-1.25e-18,"step":9007199254740993,"time_s":2e-9}"#;
        let artifact = fixture(bytes);
        let scalar = decode_scalar(&artifact, bytes).unwrap();
        assert_eq!(scalar.quantity_id, "total_energy");
        assert_eq!(scalar.unit, "J");
        assert_eq!(scalar.value_si, -1.25e-18);
        assert_eq!(scalar.step.to_string(), "9007199254740993");
        assert_eq!(scalar.time_s, 2e-9);
        assert!(artifact.accepted_state.is_none());
    }

    #[test]
    fn corrupt_identity_or_invalid_scalar_is_rejected() {
        let bytes = br#"{"schema_version":"study_scalar.v1","quantity_id":"total_energy","unit":"J","value_si":1,"step":0,"time_s":0}"#;
        let mut artifact = fixture(bytes);
        artifact.object_ref = "0".repeat(64);
        assert!(decode_scalar(&artifact, bytes).is_err());
        for bytes in [
            br#"{"schema_version":"study_scalar.v2","quantity_id":"total_energy","unit":"J","value_si":1,"step":0,"time_s":0}"#.as_slice(),
            br#"{"schema_version":"study_scalar.v1","quantity_id":"total_energy","unit":"","value_si":1,"step":0,"time_s":0}"#.as_slice(),
            br#"{"schema_version":"study_scalar.v1","quantity_id":"total_energy","unit":"J","value_si":1,"step":0,"time_s":-1}"#.as_slice(),
            br#"{"schema_version":"study_scalar.v1","quantity_id":"total_energy","unit":"J","value_si":1e999,"step":0,"time_s":0}"#.as_slice(),
        ] {
            assert!(decode_scalar(&fixture(bytes), bytes).is_err());
        }
    }
}
