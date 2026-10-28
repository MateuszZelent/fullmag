//! Explicit publication recovery retains the failed execution and its immutable scientific output.
use super::*;
use crate::study::StudyOutputPayload;
use fullmag_application::{AcceptedPreparationReceipt, ResourceKind, WorkerEvent};
use fullmag_authoring::{StudyPortDataKind, StudyStepKind};
use fullmag_session::{FmsResourceLeaseState, FmsTaskLifecycle};
use serde_json::{json, Value};

const RECOVERY_SCHEMA: &str = "fullmag.completed_inspection_publication_recovery.v1";
const MAX_EVIDENCE_BYTES: usize = 4 * 1024 * 1024;

/// Publish only a verified completed inspection as a new, failed saved result.
/// The caller must hold one writer transaction across immutable worker receipt
/// verification and this call. This producer never changes scheduler history,
/// grants execution authority, or publishes lease-owned study output entries.
pub fn publish_recovered_inspection_solution(
    store: &SessionStore, accepted: &AcceptedStudySnapshot, claim: &TaskClaim,
    step_id: &str, output: &StudyOutputPayload, evidence: &Value,
) -> Result<SolutionSet> {
    let _transaction = store.write_transaction()?;
    let run_id = claim.run_id.as_str();
    let task_id = claim.task_id.as_str();
    if accepted.run.specification.run_id != claim.run_id
        || store.read_run_intent(run_id)?.as_ref() != Some(&accepted.run.intent)
        || fullmag_session::task_id_for_study_step(run_id, step_id)? != task_id {
        bail!("publication recovery immutable run or step differs");
    }
    let step = accepted.study.steps.iter().find(|step| step.step_id == step_id)
        .context("publication recovery step absent")?;
    if !step.enabled || !matches!(&step.kind, StudyStepKind::ClosedLoopInspection { .. })
        || step.outputs.len() != 1 || step.outputs[0].port_id != "inspection"
        || step.outputs[0].data_kind != StudyPortDataKind::Artifact
        || output.port_id != "inspection" || output.case_id != "default"
        || output.codec_id != fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_ID
        || output.codec_version != fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_VERSION {
        bail!("publication recovery requires the exact single closed-loop inspection output");
    }
    let lowered = accepted.lowered.steps.iter().find(|record| record.step_id == step_id)
        .context("publication recovery lowered step absent")?;
    let plan = lowered.execution_plan.as_ref().context("publication recovery plan absent")?;
    let problem = accepted.catalog.entries().iter().find(|entry| entry.step_id() == step_id)
        .context("publication recovery ProblemIR absent")?.problem();
    let catalog = store.read_run_catalog(run_id)?.context("publication recovery run catalog absent")?;
    let task = catalog.tasks.iter().find(|task| task.task_id == task_id)
        .context("publication recovery task absent")?;
    if task.lifecycle != FmsTaskLifecycle::Failed
        || task.attempt_id.as_deref() != Some(claim.attempt_id.as_str())
        || task.ownership_epoch != Some(claim.ownership_epoch.value())
        || task.resource_id.as_deref() != Some(claim.lease.resource_id.as_str())
        || task.input_fingerprint != fullmag_application::study_task_input_fingerprint(&accepted.run.specification, lowered)? {
        bail!("publication recovery requires the exact current failed attempt");
    }
    let lease = store.read_resource_lease(run_id, claim.lease.resource_id.as_str(), claim.lease.lease_token.as_str())?
        .context("publication recovery released lease absent")?;
    if lease.state != FmsResourceLeaseState::Released || lease.released_at.is_none()
        || lease.run_id != run_id || lease.task_id != task_id
        || lease.attempt_id != claim.attempt_id.as_str() || lease.ownership_epoch != claim.ownership_epoch.value()
        || lease.resource_id != claim.lease.resource_id || lease.lease_token != claim.lease.lease_token.as_str()
        || lease.heartbeat_sequence < claim.lease.heartbeat_sequence || claim.lease.kind != ResourceKind::Cpu
        || lease.kind != fullmag_session::FmsResourceKind::Cpu
        || lease.budget.cpu_millis != claim.lease.budget.cpu_millis
        || lease.budget.memory_bytes != claim.lease.budget.memory_bytes
        || lease.budget.gpu_memory_bytes != claim.lease.budget.gpu_memory_bytes
        || lease.budget.storage_bytes != claim.lease.budget.storage_bytes {
        bail!("publication recovery requires an exactly matching released CPU lease");
    }
    let recovered = crate::recover_coordinator_locked(store, claim)?;
    if recovered.coordinator.task().lifecycle != TaskLifecycle::Failed
        || !recovered.events.iter().any(|event| matches!(&event.event, WorkerEvent::Failed { .. }))
        || recovered.events.iter().any(|event| matches!(&event.event, WorkerEvent::Completed { .. })) {
        bail!("publication recovery requires durable failed coordinator history");
    }
    let preparation = accepted.read_task_preparation(store, task_id)?;
    let AcceptedPreparationReceipt::ClosedLoop(ref receipt) = preparation else {
        bail!("publication recovery requires closed-loop preparation");
    };
    if receipt.preparation_id != format!("prep-{task_id}") {
        bail!("publication recovery preparation identity differs");
    }
    let maximum = crate::study_inspection::inspection_bundle_budget(claim)?;
    crate::study_inspection::validate_accepted_inspection_bytes(problem, step, &output.bytes, maximum)?;
    let object_ref = fullmag_session::hex_sha256(&output.bytes);
    let bytes = store.cas().get_bounded(&object_ref, maximum as u64)?
        .context("publication recovery original output CAS absent")?;
    if bytes != output.bytes { bail!("publication recovery output CAS bytes differ"); }
    drop(bytes);
    validate_evidence(evidence, claim, accepted, plan, receipt, &object_ref, output.bytes.len())?;
    let request_sha256 = evidence["request_sha256"].as_str().context("recovery request hash absent")?;
    let solution_set_id = format!("recovered-solution-{}", fullmag_session::canonical_json_sha256(&json!({
        "run_id":run_id, "task_id":task_id, "attempt_id":claim.attempt_id.as_str(),
        "ownership_epoch":claim.ownership_epoch.value(), "request_sha256":request_sha256})));
    reject_other_recovery(store, claim, &solution_set_id)?;
    // These are bundle identities for the existing tensor producer, not a
    // fabricated FmsArtifactCatalog publication or a task artifact assignment.
    let source = SolutionArtifactRef { artifact_id:format!("recovered-source-{object_ref}"),
        kind:SolutionArtifactKind::Other, schema_id:format!("{}@{}", output.codec_id, output.codec_version),
        object_ref:object_ref.clone(), byte_length:output.bytes.len() as u64, accepted_state:None };
    let manifest_output = fullmag_session::FmsStudyOutputManifestEntry {
        port_id:output.port_id.clone(), case_id:output.case_id.clone(), data_kind:"artifact".into(),
        codec_id:output.codec_id.clone(), codec_version:output.codec_version.clone(),
        artifact_id:source.artifact_id.clone(), object_ref:object_ref.clone(), content_sha256:object_ref };
    let provenance = solution_provenance(accepted, step, problem, plan)?;
    let mut artifacts = crate::study_inspection_tensor::materialize(store, problem, step, &source,
        &manifest_output, claim, &provenance.run_spec_digest, &solution_set_id)?;
    artifacts.push(source);
    let evidence_bytes = serde_json::to_vec(evidence)?;
    let evidence_ref = store.cas().put(&evidence_bytes)?;
    let diagnostic_id = format!("publication-recovery-{evidence_ref}");
    artifacts.push(SolutionArtifactRef { artifact_id:diagnostic_id.clone(), kind:SolutionArtifactKind::Diagnostic,
        schema_id:RECOVERY_SCHEMA.into(), object_ref:evidence_ref,
        byte_length:evidence_bytes.len() as u64, accepted_state:None });
    artifacts.sort_unstable_by(|a,b| a.artifact_id.cmp(&b.artifact_id));
    let mut assessment = unassessed("numerical output recovered after publication failure; original execution remains failed; inspection only, no basis qualification");
    assessment.evidence_artifact_ids.push(diagnostic_id);
    let mut solution = SolutionSet { schema_version:SOLUTION_SET_SCHEMA_VERSION.into(), solution_set_id:solution_set_id.clone(),
        revision:1, run_id:run_id.into(), manifest_state:SolutionSetManifestState::Closed,
        execution_status:SolutionExecutionStatus::Failed, scientific_assessment:assessment.clone(), provenance,
        members:vec![SolutionMember { member_id:format!("member-{}", fullmag_session::canonical_json_sha256(&json!({
            "solution_set_id":solution_set_id, "case_id":output.case_id}))), task_id:task_id.into(),
            attempt_id:claim.attempt_id.as_str().into(), ownership_epoch:claim.ownership_epoch.value(),
            case_id:Some(output.case_id.clone()), stage_id:step_id.into(), execution_status:SolutionExecutionStatus::Failed,
            scientific_assessment:assessment, artifacts }], coverage:Vec::new() };
    // Recreate the same deterministic dataset/geometry graph even on replay.
    // The normal history helper intentionally preserves legacy graphs instead.
    let mut derived = Vec::new();
    let member = &solution.members[0];
    for artifact in &member.artifacts {
        if artifact.schema_id != fullmag_session::solution_tensor_source::SOLUTION_TENSOR_SCHEMA { continue; }
        let dataset = fullmag_session::materialized_dataset::build_materialized_dataset_artifact(
            store.cas(), &solution, &member.member_id, artifact)?.context("recovered inspection dataset absent")?;
        let tensor = fullmag_session::solution_tensor_source::read_solution_tensor_artifact(store.cas(), artifact)?;
        let geometry = crate::study_inspection_sample_geometry::build(store, &solution, member, artifact, &tensor)?
            .context("recovered inspection geometry absent")?;
        derived.extend([dataset, geometry]);
    }
    if derived.len() != 6 { bail!("publication recovery requires V/J/H datasets and owned geometry"); }
    solution.members[0].artifacts.extend(derived);
    solution.members[0].artifacts.sort_unstable_by(|a,b| a.artifact_id.cmp(&b.artifact_id));
    if let Some(existing) = store.solution_sets().read(&solution.solution_set_id)? {
        if existing != solution { bail!("publication recovery collides with a different saved result"); }
    }
    store.publish_solution_set(&solution)?;
    Ok(solution)
}

fn validate_evidence(
    evidence: &Value, claim: &TaskClaim, accepted: &AcceptedStudySnapshot,
    plan: &fullmag_ir::ExecutionPlanIR, preparation: &fullmag_application::ClosedLoopPreparationReceipt,
    object_ref: &str, byte_count: usize,
) -> Result<()> {
    if serde_json::to_vec(evidence)?.len() > MAX_EVIDENCE_BYTES
        || evidence["schema_version"] != RECOVERY_SCHEMA
        || evidence["original_task_status"] != "failed"
        || evidence["action"] != "recover_inspection_only"
        || evidence["scientific_assessment"] != "unassessed"
        || evidence["run_id"] != claim.run_id.as_str()
        || evidence["task_id"] != claim.task_id.as_str()
        || evidence["attempt_id"] != claim.attempt_id.as_str()
        || evidence["ownership_epoch"].as_u64() != Some(claim.ownership_epoch.value())
        || evidence["output_byte_count"].as_u64() != Some(byte_count as u64) {
        bail!("publication recovery evidence identity or byte budget differs");
    }
    let request = evidence.get("request").filter(|value| value.is_object()).context("recovery request absent")?;
    if evidence["request_sha256"].as_str() != Some(fullmag_session::canonical_json_sha256(request).as_str()) {
        bail!("publication recovery request digest differs");
    }
    let package = evidence["package_object_ref"].as_str().context("recovery package identity absent")?;
    if package != object_ref {
        bail!("publication recovery package differs from the verified output CAS");
    }
    if request["schema_version"] != "fullmag.completed_inspection_publication_recovery_request.v1"
        || request["run_id"] != claim.run_id.as_str()
        || request["task_id"] != claim.task_id.as_str()
        || request["attempt_id"] != claim.attempt_id.as_str()
        || request["ownership_epoch"].as_u64() != Some(claim.ownership_epoch.value())
        || request["package_object_ref"].as_str() != Some(object_ref)
        || request.get("expected_evidence") != evidence.get("verified_evidence") {
        bail!("publication recovery request differs from the verified attempt, output or evidence");
    }
    let verified = evidence["verified_evidence"].as_object().context("recovery verified digests absent")?;
    for (key, expected) in [
        ("run_spec_sha256", accepted.run.specification.fingerprint()?),
        ("plan_sha256", fullmag_session::canonical_json_sha256(&serde_json::to_value(plan)?)),
        ("preparation_sha256", fullmag_session::canonical_json_sha256(&serde_json::to_value(preparation)?)),
        ("output_sha256", object_ref.to_owned()),
    ] {
        if verified.get(key).and_then(Value::as_str) != Some(expected.as_str()) {
            bail!("publication recovery verified digest `{key}` differs");
        }
    }
    Ok(())
}

fn reject_other_recovery(store: &SessionStore, claim: &TaskClaim, expected_id: &str) -> Result<()> {
    let mut after = None;
    // Bound discovery independently of the number of runs in this repository.
    for _ in 0..64 {
        let page = store.solution_sets().list_run_page(claim.run_id.as_str(), after.as_deref(), 50)?;
        for reference in page.items {
            if reference.solution_set_id == expected_id { continue; }
            let solution = store.solution_sets().read_revision(&reference.solution_set_id, reference.revision)?
                .context("publication recovery discovery revision absent")?;
            if solution.members.iter().any(|member| member.task_id == claim.task_id.as_str()
                && member.attempt_id == claim.attempt_id.as_str()
                && member.ownership_epoch == claim.ownership_epoch.value()
                && member.artifacts.iter().any(|artifact| artifact.schema_id == RECOVERY_SCHEMA)) {
                bail!("this attempt already has a publication recovery under another request");
            }
        }
        let Some(next) = page.next_after_directory else { return Ok(()); };
        after = Some(next);
    }
    bail!("publication recovery discovery exceeds its bounded run catalog budget")
}
