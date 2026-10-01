//! Project accepted study artifacts into durable, runtime-independent solutions.

use anyhow::{bail, Context, Result};
use fullmag_application::{ScientificAssessment as RuntimeAssessment, TaskClaim, TaskLifecycle};
use fullmag_quantities::{
    ScientificAssessment, ScientificAssessmentStatus, SolutionArtifactCoverage,
    SolutionArtifactKind, SolutionArtifactRef, SolutionCoverageState, SolutionExecutionStatus,
    SolutionMember, SolutionSet, SolutionSetManifestState, SolutionSetProvenance,
    SOLUTION_SET_SCHEMA_VERSION,
};
use fullmag_session::{
    FmsArtifactCatalog, FmsArtifactCatalogEntry, FmsArtifactStatus, SessionStore,
};
use serde::Serialize;
use std::collections::BTreeMap;

use crate::study::AcceptedStudySnapshot;

const RUNNING_ASSESSMENT_REASON: &str =
    "scientific assessment is pending while execution is running";

/// Publish the first portable result revision after the complete typed output
/// manifest and every referenced object have crossed the artifact-catalog
/// barrier. Replaying an identical publication is safe, including after the
/// solution has already been closed by a terminal coordinator event.
pub(crate) fn publish_open_study_solution(
    store: &SessionStore,
    accepted: &AcceptedStudySnapshot,
    claim: &TaskClaim,
    step_id: &str,
    artifact_catalog: &FmsArtifactCatalog,
) -> Result<()> {
    crate::study::validate_study_task_completion(store, claim)?;
    let assessment = unassessed(RUNNING_ASSESSMENT_REASON);
    let solution = build_solution(
        store,
        accepted,
        claim,
        step_id,
        artifact_catalog,
        SolutionExecutionStatus::Running,
        assessment,
    )?
    .context("published study output has no typed output manifest")?;
    publish_revision(store, solution)
}

/// Reconcile a portable solution with the durable coordinator projection.
/// This is called after releasing the run-catalog writer transaction, so a
/// crash after journal/catalog publication is repaired by normal replay.
pub(crate) fn reconcile_study_solution(
    store: &SessionStore,
    claim: &TaskClaim,
    task: &fullmag_application::TaskRecord,
) -> Result<()> {
    let Some(intent) = store.read_run_intent(claim.run_id.as_str())? else {
        return Ok(());
    };
    if intent.study_object_ref.is_none() {
        return Ok(());
    }
    let specification: fullmag_application::RunSpecification =
        serde_json::from_value(intent.specification)
            .context("accepted study solution has an invalid RunSpec")?;
    if specification.run_id != claim.run_id {
        bail!("accepted study solution claim belongs to another run");
    }
    let accepted = crate::study::load_accepted_study_snapshot(
        store,
        &specification.run_id,
        &specification.snapshot.project_id,
    )?;
    let mut accepted_step_id = None;
    for step in &accepted.study.steps {
        let task_id =
            fullmag_session::task_id_for_study_step(specification.run_id.as_str(), &step.step_id)?;
        if task_id == claim.task_id.as_str() {
            accepted_step_id = Some(step.step_id.as_str());
            break;
        }
    }
    let step_id = accepted_step_id
        .context("accepted study solution task is not a step in the accepted plan")?;
    let Some(artifact_catalog) = store.read_artifact_catalog(claim.run_id.as_str())? else {
        return Ok(());
    };
    if !has_attempt_manifest(&artifact_catalog, claim) {
        return Ok(());
    }
    crate::study::validate_study_task_completion(store, claim)?;

    let Some((execution_status, assessment)) = terminal_solution_state(task)? else {
        return Ok(());
    };
    let solution = build_solution(
        store,
        &accepted,
        claim,
        step_id,
        &artifact_catalog,
        execution_status,
        assessment,
    )?
    .context("terminal study output has no typed output manifest")?;
    publish_revision(store, solution)
}

fn terminal_solution_state(
    task: &fullmag_application::TaskRecord,
) -> Result<Option<(SolutionExecutionStatus, ScientificAssessment)>> {
    let state = match task.lifecycle {
        TaskLifecycle::Succeeded => {
            let assessment = task
                .assessment
                .context("successful study task has no scientific assessment")?;
            (
                SolutionExecutionStatus::Succeeded,
                map_runtime_assessment(assessment),
            )
        }
        TaskLifecycle::Failed => (
            SolutionExecutionStatus::Failed,
            unassessed("execution failed before a scientific assessment was recorded"),
        ),
        TaskLifecycle::Cancelled => (
            SolutionExecutionStatus::Cancelled,
            unassessed("execution was cancelled before scientific assessment"),
        ),
        TaskLifecycle::Interrupted => (
            SolutionExecutionStatus::Interrupted,
            unassessed("execution was interrupted before scientific assessment"),
        ),
        TaskLifecycle::Accepted
        | TaskLifecycle::Queued
        | TaskLifecycle::Preparing
        | TaskLifecycle::Running
        | TaskLifecycle::Stopping => return Ok(None),
    };
    Ok(Some(state))
}

fn map_runtime_assessment(assessment: RuntimeAssessment) -> ScientificAssessment {
    let (status, reason) = match assessment {
        RuntimeAssessment::Converged => (ScientificAssessmentStatus::Converged, None),
        RuntimeAssessment::ToleranceNotMet => (
            ScientificAssessmentStatus::ToleranceNotMet,
            Some("worker reported that the accepted tolerance was not met".to_string()),
        ),
        RuntimeAssessment::LimitReached => (
            ScientificAssessmentStatus::LimitReached,
            Some("worker reported that an accepted execution limit was reached".to_string()),
        ),
        RuntimeAssessment::Invalid => (
            ScientificAssessmentStatus::Invalid,
            Some("worker reported an invalid scientific result".to_string()),
        ),
        RuntimeAssessment::Unassessed => (
            ScientificAssessmentStatus::Unassessed,
            Some("worker completed without a scientific assessment".to_string()),
        ),
    };
    ScientificAssessment {
        status,
        reason,
        evidence_artifact_ids: Vec::new(),
    }
}

fn unassessed(reason: impl Into<String>) -> ScientificAssessment {
    ScientificAssessment {
        status: ScientificAssessmentStatus::Unassessed,
        reason: Some(reason.into()),
        evidence_artifact_ids: Vec::new(),
    }
}

fn has_attempt_manifest(catalog: &FmsArtifactCatalog, claim: &TaskClaim) -> bool {
    catalog.entries.iter().any(|entry| {
        entry.artifact_type == "study_output_manifest"
            && entry.task_id == claim.task_id.as_str()
            && entry.attempt_id == claim.attempt_id.as_str()
            && entry.ownership_epoch == claim.ownership_epoch.value()
    })
}

fn build_solution(
    store: &SessionStore,
    accepted: &AcceptedStudySnapshot,
    claim: &TaskClaim,
    step_id: &str,
    artifact_catalog: &FmsArtifactCatalog,
    execution_status: SolutionExecutionStatus,
    assessment: ScientificAssessment,
) -> Result<Option<SolutionSet>> {
    artifact_catalog.validate()?;
    let task_id = claim.task_id.as_str();
    let attempt_id = claim.attempt_id.as_str();
    let ownership_epoch = claim.ownership_epoch.value();
    let mut manifest_entries = artifact_catalog.entries.iter().filter(|entry| {
        entry.artifact_type == "study_output_manifest"
            && entry.task_id == task_id
            && entry.attempt_id == attempt_id
            && entry.ownership_epoch == ownership_epoch
    });
    let Some(manifest_artifact) = manifest_entries.next() else {
        return Ok(None);
    };
    if manifest_entries.next().is_some() {
        bail!("study solution output manifest is ambiguous");
    }
    let manifest_ref = published_object_ref(manifest_artifact)?;
    let manifest_bytes = store
        .cas()
        .get(manifest_ref)?
        .context("study solution output manifest is missing from CAS")?;
    let manifest: fullmag_session::FmsStudyOutputManifest = serde_json::from_slice(&manifest_bytes)
        .context("study solution output manifest is not typed")?;
    manifest.validate()?;
    if manifest.run_id != accepted.run.specification.run_id.as_str()
        || manifest.task_id != task_id
        || manifest.step_id != step_id
        || manifest.attempt_id != attempt_id
        || manifest.ownership_epoch != ownership_epoch
    {
        bail!("study solution manifest identity differs from its accepted attempt");
    }

    let step = accepted
        .study
        .steps
        .iter()
        .find(|step| step.step_id == step_id)
        .with_context(|| format!("accepted study has no step `{step_id}`"))?;
    let lowered_step = accepted
        .lowered
        .steps
        .iter()
        .find(|step| step.step_id == step_id)
        .with_context(|| format!("accepted execution plan has no step `{step_id}`"))?;
    let problem = accepted
        .catalog
        .entries()
        .iter()
        .find(|entry| entry.step_id() == step_id)
        .with_context(|| format!("accepted problem catalog has no step `{step_id}`"))?
        .problem();
    let resolved_plan = lowered_step
        .execution_plan
        .as_ref()
        .with_context(|| format!("accepted study step `{step_id}` has no resolved plan"))?;

    let solution_set_id = format!(
        "solution-{}",
        fullmag_session::canonical_json_sha256(&serde_json::json!({
            "run_id": claim.run_id.as_str(),
            "task_id": task_id,
            "attempt_id": attempt_id,
            "ownership_epoch": ownership_epoch,
        }))
    );
    let provenance = SolutionSetProvenance {
        run_spec_digest: prefixed_digest(accepted.run.specification.fingerprint()?),
        model_digest: canonical_digest(&serde_json::json!({
            "project_definition_sha256": accepted.run.specification.snapshot.definition_sha256,
            "model": &step.model,
        }))?,
        physics_digest: canonical_digest(problem)?,
        discretization_digest: canonical_digest(&step.discretization)?,
        resolved_plan_digest: canonical_digest(resolved_plan)?,
        acquisition_digest: canonical_digest(&serde_json::json!({
            "policy": &step.acquisition,
            "outputs": &step.outputs,
        }))?,
        seed_digest: (!accepted.run.specification.seeds.is_empty())
            .then(|| canonical_digest(&accepted.run.specification.seeds))
            .transpose()?,
    };

    let mut artifacts_by_case: BTreeMap<Option<String>, Vec<SolutionArtifactRef>> = BTreeMap::new();
    let mut coverage = Vec::new();
    for output in &manifest.outputs {
        let entry = exact_artifact(artifact_catalog, claim, &output.artifact_id)?;
        let kind = artifact_kind(&output.data_kind);
        let artifact = solution_artifact(
            store,
            entry,
            kind,
            format!("{}@{}", output.codec_id, output.codec_version),
            accepted_state_for_kind(&manifest, kind),
        )?;
        let field_tensor = crate::study_field_tensor::materialize_study_state_tensor(
            store,
            resolved_plan,
            &artifact,
            output,
            claim.run_id.as_str(),
            &provenance.run_spec_digest,
        )?;
        coverage.push(SolutionArtifactCoverage {
            artifact_id: artifact.artifact_id.clone(),
            state: SolutionCoverageState::Unknown,
            expected_samples: None,
            committed_samples: 0,
            segments: Vec::new(),
        });
        artifacts_by_case
            .entry(Some(output.case_id.clone()))
            .or_default()
            .push(artifact);
        if let Some(field_tensor) = field_tensor {
            artifacts_by_case
                .entry(Some(output.case_id.clone()))
                .or_default()
                .push(field_tensor);
        }
    }

    let metadata = artifacts_by_case.entry(None).or_default();
    metadata.push(solution_artifact(
        store,
        manifest_artifact,
        SolutionArtifactKind::Diagnostic,
        fullmag_session::FMS_STUDY_OUTPUT_MANIFEST_SCHEMA.to_string(),
        None,
    )?);
    if let Some(source) = &manifest.observation_source {
        let snapshot = exact_artifact(artifact_catalog, claim, &source.snapshot_artifact_id)?;
        metadata.push(solution_artifact(
            store,
            snapshot,
            SolutionArtifactKind::Diagnostic,
            source.snapshot_schema_version.clone(),
            Some(source.accepted_state_ref.id.clone()),
        )?);
        let state = exact_artifact(artifact_catalog, claim, &source.state_artifact_id)?;
        metadata.push(solution_artifact(
            store,
            state,
            SolutionArtifactKind::State,
            format!("{}@{}", source.state_codec_id, source.state_codec_version),
            Some(source.accepted_state_ref.id.clone()),
        )?);
    }

    let mut members = Vec::with_capacity(artifacts_by_case.len());
    for (case_id, mut artifacts) in artifacts_by_case {
        artifacts.sort_unstable_by(|left, right| left.artifact_id.cmp(&right.artifact_id));
        let member_id = format!(
            "member-{}",
            fullmag_session::canonical_json_sha256(&serde_json::json!({
                "solution_set_id": solution_set_id,
                "case_id": &case_id,
            }))
        );
        members.push(SolutionMember {
            member_id,
            task_id: task_id.to_string(),
            attempt_id: attempt_id.to_string(),
            ownership_epoch,
            case_id,
            stage_id: step_id.to_string(),
            execution_status,
            scientific_assessment: assessment.clone(),
            artifacts,
        });
    }
    members.sort_unstable_by(|left, right| left.member_id.cmp(&right.member_id));
    coverage.sort_unstable_by(|left, right| left.artifact_id.cmp(&right.artifact_id));

    let mut solution = SolutionSet {
        schema_version: SOLUTION_SET_SCHEMA_VERSION.to_string(),
        solution_set_id,
        revision: 1,
        run_id: claim.run_id.as_str().to_string(),
        manifest_state: if execution_status == SolutionExecutionStatus::Running {
            SolutionSetManifestState::Open
        } else {
            SolutionSetManifestState::Closed
        },
        execution_status,
        scientific_assessment: assessment,
        provenance,
        members,
        coverage,
    };
    crate::study_dataset::attach_recorded_datasets(store, &mut solution, resolved_plan)?;
    Ok(Some(solution))
}

fn publish_revision(store: &SessionStore, desired: SolutionSet) -> Result<()> {
    let current = store.solution_sets().read(&desired.solution_set_id)?;
    match current {
        None if desired.execution_status == SolutionExecutionStatus::Running => {
            store.publish_solution_set(&desired)
        }
        None => {
            let mut open = desired.clone();
            open.revision = 1;
            open.manifest_state = SolutionSetManifestState::Open;
            open.execution_status = SolutionExecutionStatus::Running;
            open.scientific_assessment = unassessed(RUNNING_ASSESSMENT_REASON);
            for member in &mut open.members {
                member.execution_status = SolutionExecutionStatus::Running;
                member.scientific_assessment = open.scientific_assessment.clone();
            }
            store.publish_solution_set(&open)?;
            let mut closed = desired;
            closed.revision = 2;
            store.publish_solution_set(&closed)
        }
        Some(current) if current.manifest_state == SolutionSetManifestState::Closed => {
            ensure_same_solution_payload(&current, &desired)?;
            if desired.execution_status != SolutionExecutionStatus::Running
                && (current.execution_status != desired.execution_status
                    || current.scientific_assessment != desired.scientific_assessment)
            {
                bail!("closed study solution differs from the terminal coordinator result");
            }
            if desired.execution_status != SolutionExecutionStatus::Running
                && current.members.iter().any(|member| {
                    member.execution_status != desired.execution_status
                        || member.scientific_assessment != desired.scientific_assessment
                })
            {
                bail!("closed study solution member differs from the terminal coordinator result");
            }
            Ok(())
        }
        Some(current) if desired.execution_status == SolutionExecutionStatus::Running => {
            ensure_same_solution_payload(&current, &desired)
        }
        Some(current) => {
            ensure_same_solution_payload(&current, &desired)?;
            let mut closed = desired;
            closed.revision = current
                .revision
                .checked_add(1)
                .context("study solution revision exhausted")?;
            store.publish_solution_set(&closed)
        }
    }
}

fn ensure_same_solution_payload(current: &SolutionSet, desired: &SolutionSet) -> Result<()> {
    let mut normalized = current.clone();
    normalized.revision = 1;
    normalized.manifest_state = desired.manifest_state;
    normalized.execution_status = desired.execution_status;
    normalized.scientific_assessment = desired.scientific_assessment.clone();
    for member in &mut normalized.members {
        member.execution_status = desired.execution_status;
        member.scientific_assessment = desired.scientific_assessment.clone();
    }
    let mut expected = desired.clone();
    expected.revision = 1;
    if normalized != expected {
        bail!("study solution identity, provenance, or immutable artifacts changed");
    }
    Ok(())
}

fn exact_artifact<'a>(
    catalog: &'a FmsArtifactCatalog,
    claim: &TaskClaim,
    artifact_id: &str,
) -> Result<&'a FmsArtifactCatalogEntry> {
    let mut entries = catalog.entries.iter().filter(|entry| {
        entry.artifact_id == artifact_id
            && entry.task_id == claim.task_id.as_str()
            && entry.attempt_id == claim.attempt_id.as_str()
            && entry.ownership_epoch == claim.ownership_epoch.value()
    });
    let entry = entries
        .next()
        .with_context(|| format!("study solution artifact `{artifact_id}` is missing"))?;
    if entries.next().is_some() {
        bail!("study solution artifact `{artifact_id}` is ambiguous");
    }
    Ok(entry)
}

fn solution_artifact(
    store: &SessionStore,
    entry: &FmsArtifactCatalogEntry,
    kind: SolutionArtifactKind,
    schema_id: String,
    accepted_state: Option<fullmag_quantities::AcceptedStateId>,
) -> Result<SolutionArtifactRef> {
    let object_ref = published_object_ref(entry)?;
    let byte_length = store
        .cas()
        .verified_length(object_ref)?
        .with_context(|| format!("study solution object `{object_ref}` is missing"))?;
    Ok(SolutionArtifactRef {
        artifact_id: entry.artifact_id.clone(),
        kind,
        schema_id,
        object_ref: object_ref.to_string(),
        byte_length,
        accepted_state,
    })
}

fn published_object_ref(entry: &FmsArtifactCatalogEntry) -> Result<&str> {
    let object_ref = entry
        .object_ref
        .as_deref()
        .context("study solution artifact has no CAS object reference")?;
    if entry.status != FmsArtifactStatus::Published || entry.content_sha256 != object_ref {
        bail!("study solution artifact is not an exact published CAS object");
    }
    Ok(object_ref)
}

fn accepted_state_for_kind(
    manifest: &fullmag_session::FmsStudyOutputManifest,
    kind: SolutionArtifactKind,
) -> Option<fullmag_quantities::AcceptedStateId> {
    (kind == SolutionArtifactKind::State)
        .then(|| {
            manifest
                .accepted_state_ref
                .as_ref()
                .map(|reference| reference.id.clone())
        })
        .flatten()
}

fn artifact_kind(data_kind: &str) -> SolutionArtifactKind {
    match data_kind {
        "initial_state" | "state" => SolutionArtifactKind::State,
        "table" | "scalar" => SolutionArtifactKind::Table,
        _ => SolutionArtifactKind::Other,
    }
}

fn canonical_digest(value: &impl Serialize) -> Result<String> {
    let value = serde_json::to_value(value)?;
    Ok(prefixed_digest(fullmag_session::canonical_json_sha256(
        &value,
    )))
}

fn prefixed_digest(hex: String) -> String {
    format!("sha256:{hex}")
}
