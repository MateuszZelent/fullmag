//! Attach immutable recorded datasets to their first SolutionSet publication.
//!
//! Historical results retain their exact artifacts on replay. The dataset
//! does not introduce another Results store or advance scientific assessment.

use anyhow::{bail, Result};
use fullmag_ir::{BackendPlanIR, ExecutionPlanIR};
use fullmag_quantities::{SolutionArtifactRef, SolutionSet};
use fullmag_session::{
    materialized_dataset::{build_materialized_dataset_artifact, MATERIALIZED_DATASET_SCHEMA},
    solution_field_geometry::{
        build_solution_field_geometry_artifact, SOLUTION_FIELD_GEOMETRY_SCHEMA,
    },
    solution_tensor_source::SOLUTION_TENSOR_SCHEMA,
    SessionStore,
};

pub(crate) fn attach_recorded_datasets(
    store: &SessionStore,
    solution: &mut SolutionSet,
    plan: &ExecutionPlanIR,
) -> Result<()> {
    if let Some(current) = store.solution_sets().read(&solution.solution_set_id)? {
        // Carry the original root and pinned owner revision across terminal
        // publication and replay. Legacy results are never retroactively
        // expanded with new artifacts, including still-open pre-cutover sets.
        return reuse_existing_datasets(&current, solution);
    }

    let mut additions: Vec<(usize, SolutionArtifactRef)> = Vec::new();
    let mut semantics = None;
    for (member_index, member) in solution.members.iter().enumerate() {
        for artifact in &member.artifacts {
            if artifact.schema_id == SOLUTION_TENSOR_SCHEMA {
                let dataset = build_materialized_dataset_artifact(
                    store.cas(),
                    solution,
                    &member.member_id,
                    artifact,
                )?;
                if let Some(dataset) = dataset {
                    additions.push((member_index, dataset));
                    // Plans without a materializable state tensor must not
                    // acquire a new geometry-validation failure on replay.
                    if semantics.is_none() {
                        semantics = Some(
                            fullmag_runner::fem_p1_magnetization_field_semantics(plan)
                                .map_err(|error| anyhow::anyhow!(error))?,
                        );
                    }
                    if let (BackendPlanIR::Fem(fem), Some(Some(semantics))) =
                        (&plan.backend_plan, &semantics)
                    {
                        additions.push((
                            member_index,
                            build_solution_field_geometry_artifact(
                                store.cas(),
                                solution,
                                &member.member_id,
                                artifact,
                                &fem.mesh,
                                semantics,
                            )?,
                        ));
                    }
                }
            }
        }
    }
    for (member_index, artifact) in additions {
        solution.members[member_index].artifacts.push(artifact);
    }
    for member in &mut solution.members {
        member
            .artifacts
            .sort_unstable_by(|left, right| left.artifact_id.cmp(&right.artifact_id));
    }
    Ok(())
}

fn reuse_existing_datasets(current: &SolutionSet, desired: &mut SolutionSet) -> Result<()> {
    for member in &current.members {
        for artifact in &member.artifacts {
            if artifact.schema_id != MATERIALIZED_DATASET_SCHEMA
                && artifact.schema_id != SOLUTION_FIELD_GEOMETRY_SCHEMA
            {
                continue;
            }
            let Some(target) = desired
                .members
                .iter_mut()
                .find(|target| target.member_id == member.member_id)
            else {
                bail!("recorded dataset member disappeared during solution replay");
            };
            if target
                .artifacts
                .iter()
                .any(|existing| existing.artifact_id == artifact.artifact_id)
            {
                bail!("recorded dataset artifact is duplicated during solution replay");
            }
            target.artifacts.push(artifact.clone());
            target
                .artifacts
                .sort_unstable_by(|left, right| left.artifact_id.cmp(&right.artifact_id));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_quantities::{
        ScientificAssessment, ScientificAssessmentStatus, SolutionArtifactKind,
        SolutionExecutionStatus, SolutionMember, SolutionSetManifestState, SolutionSetProvenance,
    };

    fn solution(with_dataset: bool) -> SolutionSet {
        let assessment = ScientificAssessment {
            status: ScientificAssessmentStatus::Unassessed,
            reason: Some("fixture has no scientific qualification".into()),
            evidence_artifact_ids: vec![],
        };
        let artifacts = if with_dataset {
            vec![SolutionArtifactRef {
                artifact_id: "dataset-source-1".into(),
                kind: SolutionArtifactKind::Other,
                schema_id: MATERIALIZED_DATASET_SCHEMA.into(),
                object_ref: "a".repeat(64),
                byte_length: 1,
                accepted_state: None,
            }]
        } else {
            vec![]
        };
        let digest = format!("sha256:{}", "b".repeat(64));
        SolutionSet {
            schema_version: "1.0.0".into(),
            solution_set_id: "solution-fixture".into(),
            revision: 1,
            run_id: "run-fixture".into(),
            manifest_state: SolutionSetManifestState::Open,
            execution_status: SolutionExecutionStatus::Running,
            scientific_assessment: assessment.clone(),
            provenance: SolutionSetProvenance {
                run_spec_digest: digest.clone(),
                model_digest: digest.clone(),
                physics_digest: digest.clone(),
                discretization_digest: digest.clone(),
                resolved_plan_digest: digest.clone(),
                acquisition_digest: digest,
                seed_digest: None,
            },
            members: vec![SolutionMember {
                member_id: "member-fixture".into(),
                task_id: "task-fixture".into(),
                attempt_id: "attempt-fixture".into(),
                ownership_epoch: 1,
                case_id: Some("case-fixture".into()),
                stage_id: "step-fixture".into(),
                execution_status: SolutionExecutionStatus::Running,
                scientific_assessment: assessment,
                artifacts,
            }],
            coverage: vec![],
        }
    }

    #[test]
    fn replay_retains_exact_dataset_artifact_across_terminal_revision() {
        let current = solution(true);
        let mut desired = solution(false);
        desired.revision = 2;
        desired.manifest_state = SolutionSetManifestState::Closed;
        desired.execution_status = SolutionExecutionStatus::Succeeded;
        reuse_existing_datasets(&current, &mut desired).unwrap();
        assert_eq!(desired.members[0].artifacts, current.members[0].artifacts);
        assert_eq!(desired.revision, 2);
        assert_eq!(desired.execution_status, SolutionExecutionStatus::Succeeded);
        assert_eq!(
            desired.scientific_assessment.status,
            ScientificAssessmentStatus::Unassessed
        );
    }

    #[test]
    fn legacy_replay_does_not_create_dataset_artifacts() {
        let current = solution(false);
        let mut desired = current.clone();
        reuse_existing_datasets(&current, &mut desired).unwrap();
        assert_eq!(desired, current);
    }

    #[test]
    fn replay_rejects_missing_member_and_duplicate_dataset() {
        let current = solution(true);
        let mut missing_member = solution(false);
        missing_member.members.clear();
        assert!(reuse_existing_datasets(&current, &mut missing_member).is_err());
        let mut duplicate = current.clone();
        assert!(reuse_existing_datasets(&current, &mut duplicate).is_err());
    }
}
