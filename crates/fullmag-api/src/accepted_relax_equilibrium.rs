//! Exact accepted Relax output and its typed StepOutput consumer.
use anyhow::{bail, Context, Result};
use fullmag_application::{FemEquilibriumHandoff, FemEquilibriumHandoffMember, PreparationBinding};
use fullmag_authoring::{StudyInputSource, StudyPortDataKind};
use fullmag_ir::{BackendPlanIR, ExecutionPlanIR};
use fullmag_runtime_control::{AcceptedStudySnapshot, AcceptedWorkerStep, StudyOutputPayload};
use fullmag_session::SessionStore;
use std::collections::BTreeMap;
use std::path::Path;

pub(crate) fn collect_handoff(
    step: &AcceptedWorkerStep,
    prepared: &crate::accepted_fem_study_worker::AcceptedFemPreparedExecution,
    result: &fullmag_runner::RunResult,
    root: &Path,
) -> Result<StudyOutputPayload> {
    let BackendPlanIR::Fem(source) = &prepared.execution_plan.backend_plan else {
        bail!("equilibrium handoff producer is not FEM");
    };
    if source.relaxation.is_none() || prepared.case_id != "default" {
        bail!("equilibrium handoff requires the exact default-case Relax producer");
    }
    let completion = result
        .completion
        .as_ref()
        .context("Relax output has no completion certificate")?;
    let maximum = fullmag_runtime_control::study_equilibrium::handoff_budget(
        step.claim.lease.budget.storage_bytes,
    );
    let mut raw: BTreeMap<String, Vec<u8>> = BTreeMap::from([
        (
            "source/execution_plan.json".into(),
            serde_json::to_vec(&prepared.execution_plan)?,
        ),
        (
            "source/completion.json".into(),
            serde_json::to_vec(completion)?,
        ),
        (
            "source/m0.json".into(),
            serde_json::to_vec(&result.final_magnetization)?,
        ),
    ]);
    let accepted_path =
        fullmag_runner::CertifiedFemEquilibriumFields::accepted_artifact_path_for_material(
            &source.material,
        );
    let (certified_path, recomputed_path) =
        fullmag_runner::CertifiedFemEquilibriumFields::artifact_paths_for_material(
            &source.material,
        );
    let mut consumed = raw
        .values()
        .try_fold(0usize, |sum, bytes| sum.checked_add(bytes.len()))
        .context("equilibrium source byte budget overflow")?;
    for path in [
        accepted_path,
        certified_path,
        recomputed_path,
        fullmag_runner::FEM_RELAXATION_PRODUCER_PROVENANCE_RELATIVE_PATH,
    ] {
        let remaining = maximum
            .checked_sub(consumed)
            .context("equilibrium source exceeds its byte budget")?;
        let bytes =
            fullmag_session::repository_path::read_bounded_regular_file(root, path, remaining)
                .with_context(|| format!("read exact Relax certificate {path}"))?;
        consumed = consumed
            .checked_add(bytes.len())
            .context("equilibrium source size overflow")?;
        raw.insert(path.into(), bytes);
    }
    let bundle = FemEquilibriumHandoff {
        schema_version: fullmag_application::FEM_EQUILIBRIUM_HANDOFF_SCHEMA.into(),
        run_id: step.claim.run_id.as_str().into(),
        stage_id: step.step_id.clone(),
        preparation: step.resolved_input.preparation.clone(),
        execution_plan_fingerprint: fullmag_session::canonical_json_sha256(&serde_json::to_value(
            &prepared.execution_plan,
        )?),
        members: raw
            .into_iter()
            .map(|(path, bytes)| {
                (
                    path,
                    FemEquilibriumHandoffMember {
                        sha256: format!("sha256:{}", fullmag_session::hex_sha256(&bytes)),
                        bytes,
                    },
                )
            })
            .collect(),
    };
    let bytes = fullmag_application::encode_fem_equilibrium_handoff(&bundle, maximum)?;
    fullmag_runtime_control::study_equilibrium::validate_handoff_bytes(
        &bytes,
        maximum,
        step.claim.run_id.as_str(),
        &step.step_id,
        &step.resolved_input.preparation,
    )
    .context("replay exact accepted Relax certificate before CAS publication")?;
    Ok(StudyOutputPayload {
        port_id: fullmag_application::FEM_EQUILIBRIUM_HANDOFF_PORT.into(),
        case_id: prepared.case_id.clone(),
        codec_id: fullmag_application::FEM_EQUILIBRIUM_HANDOFF_CODEC_ID.into(),
        codec_version: fullmag_application::FEM_EQUILIBRIUM_HANDOFF_CODEC_VERSION.into(),
        bytes,
    })
}

/// Resolve only the explicit StepOutput already pinned by accepted scheduling.
/// Read-model selection, directory discovery and a latest Relax are never inputs.
pub(crate) fn prepare_modal_handoff(
    store: &SessionStore,
    accepted: &AcceptedStudySnapshot,
    step: &AcceptedWorkerStep,
    target: &ExecutionPlanIR,
) -> Result<(
    ExecutionPlanIR,
    fullmag_runner::AcceptedFemRelaxStageHandoff,
)> {
    let mut ports = step
        .study_inputs
        .iter()
        .filter(|port| port.port_id == fullmag_application::FEM_EQUILIBRIUM_HANDOFF_PORT);
    let port = ports
        .next()
        .context("accepted FEM eigen has no explicit equilibrium_handoff input")?;
    if ports.next().is_some() || !port.required || port.data_kind != StudyPortDataKind::Artifact {
        bail!("accepted equilibrium input differs from its single required Artifact contract");
    }
    let StudyInputSource::StepOutput {
        step_id: producer_step,
        port: producer_port,
        case_id,
    } = &port.source
    else {
        bail!("accepted equilibrium requires an exact Relax StepOutput");
    };
    if producer_port != fullmag_application::FEM_EQUILIBRIUM_HANDOFF_PORT || case_id != "default" {
        bail!("accepted equilibrium source port/case differs");
    }
    let input = step
        .resolved_input
        .inputs
        .get(&port.port_id)
        .context("required equilibrium CAS input was not resolved")?;
    input.validate()?;
    let artifact = input
        .study_artifact
        .as_ref()
        .context("equilibrium input has no typed CAS binding")?;
    if artifact.data_kind != "artifact"
        || artifact.codec_id != fullmag_application::FEM_EQUILIBRIUM_HANDOFF_CODEC_ID
        || artifact.codec_version != fullmag_application::FEM_EQUILIBRIUM_HANDOFF_CODEC_VERSION
    {
        bail!("equilibrium input codec differs from its declared contract");
    }
    let run_id = step.claim.run_id.as_str();
    let producer_task_id = fullmag_session::task_id_for_study_step(run_id, producer_step)?;
    let tasks = store
        .read_run_catalog(run_id)?
        .context("equilibrium source run catalog missing")?;
    let producer = tasks
        .tasks
        .iter()
        .find(|task| task.task_id == producer_task_id)
        .context("exact equilibrium source task missing")?;
    if producer.lifecycle != fullmag_session::FmsTaskLifecycle::Succeeded {
        bail!("equilibrium source task has not succeeded");
    }
    let catalog = store
        .read_artifact_catalog(run_id)?
        .context("equilibrium source artifact catalog missing")?;
    let mut entries = catalog
        .entries
        .iter()
        .filter(|entry| entry.artifact_id == artifact.artifact_id);
    let entry = entries
        .next()
        .context("equilibrium input artifact missing from exact run catalog")?;
    if entries.next().is_some()
        || entry.task_id != producer_task_id
        || producer.attempt_id.as_deref() != Some(entry.attempt_id.as_str())
        || producer.ownership_epoch != Some(entry.ownership_epoch)
        || entry.status != fullmag_session::FmsArtifactStatus::Published
        || entry.artifact_type != "artifact"
        || entry.object_ref.as_deref() != Some(artifact.object_ref.as_str())
        || entry.content_sha256 != artifact.object_ref
    {
        bail!("equilibrium CAS object differs from the successful exact source attempt");
    }
    let lineage = entry
        .study_output
        .as_ref()
        .context("equilibrium artifact has no typed lineage")?;
    if lineage.step_id != *producer_step
        || lineage.port_id != *producer_port
        || lineage.case_id != *case_id
    {
        bail!("equilibrium artifact lineage differs from the declared StepOutput");
    }
    let receipt = accepted.read_task_preparation_receipt(store, &producer_task_id)?;
    let preparation = PreparationBinding::from_receipt(&receipt)?;
    let maximum = fullmag_runtime_control::study_equilibrium::handoff_budget(
        step.claim.lease.budget.storage_bytes,
    );
    let bytes = store
        .cas()
        .get_bounded(&artifact.object_ref, maximum as u64)?
        .context("equilibrium CAS object missing")?;
    if fullmag_application::study_artifact_content_sha256(&bytes) != artifact.object_ref {
        bail!("equilibrium CAS bytes differ from their pinned digest");
    }
    let replayed = fullmag_runtime_control::study_equilibrium::validate_handoff_bytes(
        &bytes,
        maximum,
        run_id,
        producer_step,
        &preparation,
    )?;
    let plan = fullmag_runner::materialize_accepted_fem_relaxation_target(target, &replayed)?;
    Ok((plan, replayed.handoff))
}
