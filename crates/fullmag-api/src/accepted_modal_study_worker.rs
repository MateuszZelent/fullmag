//! Accepted FEM CPU modal adapter. Scheduling and durable Start/Stop stay in
//! the common worker; this module binds one native solve to its exact owner.
use anyhow::{bail, Context, Result};
use fullmag_application::PreparationBinding;
use fullmag_authoring::{StudyOutputPort, StudyPortDataKind};
use fullmag_ir::{
    BackendPlanIR, BackendTarget, EigenOperatorIR, ExecutionMode, ExecutionPrecision,
};
use fullmag_runtime_control::{AcceptedStudySnapshot, AcceptedWorkerStep, StudyOutputPayload};
use fullmag_session::SessionStore;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) struct PreparedModalExecution {
    pub problem: fullmag_ir::ProblemIR,
    pub plan: fullmag_ir::ExecutionPlanIR,
    pub mesh: fullmag_runner::StageFemMeshAsset,
    pub maximum_bytes: usize,
    pub case_id: String,
    pub relax_handoff: fullmag_runner::AcceptedFemRelaxStageHandoff,
}
pub(crate) fn validate_declared_outputs(outputs: &[StudyOutputPort]) -> Result<()> {
    if outputs.len() != 1
        || outputs[0].port_id != fullmag_application::MODAL_EIGEN_OUTPUT_PORT
        || outputs[0].data_kind != StudyPortDataKind::Artifact
    {
        bail!("accepted modal execution requires exactly one modal_artifacts/Artifact output");
    }
    Ok(())
}
pub(crate) fn prepare(
    store: &SessionStore,
    accepted: &AcceptedStudySnapshot,
    step: &AcceptedWorkerStep,
    study_step: &fullmag_authoring::StudyStep,
    case_id: &str,
) -> Result<PreparedModalExecution> {
    validate_declared_outputs(&study_step.outputs)?;
    fullmag_session::repository_path::validate_store_id(case_id)?;
    if !matches!(
        study_step.kind,
        fullmag_authoring::StudyStepKind::Primitive {
            stage_kind: fullmag_authoring::StudyPrimitiveStageKind::Eigenmodes
        }
    ) {
        bail!("accepted modal execution requires the eigenmodes primitive");
    }
    let request = &step.resolved_input.requested_execution;
    if request.backend != "fem"
        || request.device != "cpu"
        || request.precision != "double"
        || request.mode != "strict"
        || step.claim.lease.kind != fullmag_application::ResourceKind::Cpu
        || step.claim.lease.budget.gpu_memory_bytes != 0
    {
        bail!("accepted native modal execution requires fem/cpu/double/strict and a CPU lease");
    }
    let preparation = accepted.read_task_preparation_receipt(store, step.claim.task_id.as_str())?;
    if PreparationBinding::from_receipt(&preparation).map_err(|e| anyhow::anyhow!(e.to_string()))?
        != step.resolved_input.preparation
    {
        bail!("accepted modal preparation differs from the exact worker input");
    }
    let plan = crate::accepted_study_worker::materialize_resolved_study_inputs(store, step)?;
    if plan.common.requested_backend != BackendTarget::Fem
        || plan.common.resolved_backend != BackendTarget::Fem
        || plan.common.execution_mode != ExecutionMode::Strict
        || step.problem.backend_policy.execution_precision != ExecutionPrecision::Double
        || step.problem.validation_profile.execution_mode != ExecutionMode::Strict
    {
        bail!("accepted modal plan differs from its strict native FEM request");
    }
    let BackendPlanIR::FemEigen(eigen) = &plan.backend_plan else {
        bail!("accepted modal execution requires a FEM eigen plan");
    };
    if eigen.fe_order != 1 || eigen.operator.kind != EigenOperatorIR::Full2x2 {
        bail!("accepted native modal adapter requires H1/P1 and the full_2x2 operator");
    }
    if std::env::var("FULLMAG_FEM_EXECUTION")
        .is_ok_and(|v| !v.trim().is_empty() && !v.eq_ignore_ascii_case("cpu"))
        || ["FULLMAG_FEM_ALL_IN_GPU", "FULLMAG_FEM_REQUIRE_GPU"]
            .iter()
            .any(|key| {
                std::env::var(key).is_ok_and(|v| {
                    matches!(
                        v.trim().to_ascii_lowercase().as_str(),
                        "1" | "true" | "yes" | "on"
                    )
                })
            })
    {
        bail!("process environment cannot override accepted modal CPU intent");
    }
    let (plan, relax_handoff) =
        crate::accepted_relax_equilibrium::prepare_modal_handoff(store, accepted, step, &plan)
            .context("bind exact accepted Relax-to-Eigen equilibrium")?;
    let mut problem = step.problem.clone();
    let owner = [
        ("producer_run_id", step.claim.run_id.as_str()),
        ("producer_stage_id", step.step_id.as_str()),
        ("producer_stage_kind", "eigenmodes"),
    ];
    for (key, value) in owner {
        if problem
            .problem_meta
            .runtime_metadata
            .get(key)
            .is_some_and(|old| old.as_str() != Some(value))
        {
            bail!("accepted modal producer metadata conflicts with the exact task owner");
        }
        problem
            .problem_meta
            .runtime_metadata
            .insert(key.into(), serde_json::json!(value));
    }
    problem.problem_meta.runtime_metadata.insert(
        "runtime_device_override".into(),
        serde_json::json!({"device":"cpu","source":"managed_launcher"}),
    );
    let runtime = fullmag_runner::resolve_planned_runtime_engine(&problem, &plan)
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    if runtime.backend_family != "fem_eigen"
        || runtime.accelerator != "cpu"
        || runtime.engine_id != "fem_eigen_cpu_baseline"
    {
        bail!("accepted modal plan resolved to another backend or device");
    }
    let maximum_bytes = usize::try_from(step.claim.lease.budget.storage_bytes)
        .unwrap_or(usize::MAX)
        .min(fullmag_application::MODAL_EIGEN_BUNDLE_MAX_BYTES);
    if maximum_bytes == 0 {
        bail!("accepted modal execution has no output byte budget");
    }
    let mesh = fullmag_runner::StageFemMeshAsset::build_from_backend_plan(&plan.backend_plan)
        .context("accepted modal plan has no authoritative FEM mesh identity")?;
    Ok(PreparedModalExecution {
        problem,
        plan,
        mesh,
        maximum_bytes,
        case_id: case_id.into(),
        relax_handoff,
    })
}

pub(crate) fn collect_bundle(
    root: &Path,
    run_id: &str,
    stage_id: &str,
    maximum: usize,
) -> Result<Vec<u8>> {
    let capture = fullmag_session::frequency_domain_artifact_generation::capture(root)?
        .context("completed modal solver has no committed artifact generation")?;
    if !capture.is_immutable() {
        bail!("accepted modal outputs require an immutable v2 generation");
    }
    let owner = capture
        .commit
        .content
        .producer
        .as_ref()
        .context("modal generation has no owner")?;
    if owner.run_id != run_id || owner.stage_id != stage_id || owner.stage_kind != "eigenmodes" {
        bail!("modal generation belongs to another accepted run or stage");
    }
    let commit = serde_json::to_vec_pretty(&capture.commit)?;
    let mut total = commit
        .len()
        .checked_add(20)
        .context("modal framing budget overflow")?;
    for (path, member) in &capture.commit.content.members {
        total = total
            .checked_add(path.len())
            .and_then(|n| n.checked_add(10))
            .and_then(|n| {
                usize::try_from(member.byte_length)
                    .ok()
                    .and_then(|size| n.checked_add(size))
            })
            .context("modal output byte count overflow")?;
    }
    if total > maximum {
        bail!("modal output generation exceeds the admitted byte budget");
    }
    let mut payloads = BTreeMap::new();
    for (path, member) in &capture.commit.content.members {
        payloads.insert(
            path.clone(),
            capture.read_member_bounded(root, path, member.byte_length)?,
        );
    }
    capture.ensure_current(root)?;
    fullmag_runner::validate_modal_artifact_closure(&payloads)?;
    fullmag_application::encode_modal_eigen_bundle(&commit, &payloads, maximum)
        .map_err(|e| anyhow::anyhow!(e.to_string()))
}
pub(crate) fn validate_bundle(
    bytes: &[u8],
    run_id: &str,
    stage_id: &str,
    maximum: usize,
) -> Result<()> {
    let bundle = fullmag_application::decode_modal_eigen_bundle(bytes, maximum)
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    fullmag_runner::validate_modal_artifact_closure(&bundle.payloads)?;
    if bundle.run_id != run_id || bundle.stage_id != stage_id {
        bail!("modal CAS output belongs to another task owner");
    }
    Ok(())
}
/// Returns None only after the canonical runner acknowledged cancellation.
pub(crate) fn execute(
    prepared: &PreparedModalExecution,
    step: &AcceptedWorkerStep,
    root: &Path,
    autosave_root: &Path,
    interrupted: Option<&AtomicBool>,
) -> Result<Option<StudyOutputPayload>> {
    let mut observation = crate::accepted_study_worker::AcceptedLiveObservationWriter::new(
        root,
        step,
        &prepared.plan,
        "fem_eigen_cpu".into(),
    );
    let display = fullmag_runner::DisplaySelectionState::default;
    let result = fullmag_runner::run_planned_problem_with_live_preview_and_relax_handoff(
        &prepared.problem,
        &prepared.plan,
        Some(&prepared.mesh.identity),
        0.0,
        root,
        autosave_root,
        observation.field_sampling_interval(),
        &display,
        interrupted,
        false,
        &prepared.relax_handoff,
        |update| {
            observation.observe(&update);
            if interrupted.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                fullmag_runner::StepAction::Stop
            } else {
                fullmag_runner::StepAction::Continue
            }
        },
    );
    observation.finish();
    let result = result
        .map_err(|e| anyhow::anyhow!(e.to_string()))
        .context("execute exact accepted native modal plan")?;
    if result.status == fullmag_runner::RunStatus::Cancelled {
        return Ok(None);
    }
    if result.status != fullmag_runner::RunStatus::Completed {
        bail!("native modal runner did not complete");
    }
    if interrupted.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Ok(None);
    }
    let bytes = collect_bundle(
        root,
        step.claim.run_id.as_str(),
        &step.step_id,
        prepared.maximum_bytes,
    )?;
    validate_bundle(
        &bytes,
        step.claim.run_id.as_str(),
        &step.step_id,
        prepared.maximum_bytes,
    )?;
    Ok(Some(StudyOutputPayload {
        port_id: fullmag_application::MODAL_EIGEN_OUTPUT_PORT.into(),
        case_id: prepared.case_id.clone(),
        codec_id: fullmag_application::MODAL_EIGEN_BUNDLE_CODEC_ID.into(),
        codec_version: fullmag_application::MODAL_EIGEN_BUNDLE_CODEC_VERSION.into(),
        bytes,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modal_output_contract_rejects_magnetic_and_empty_output_sets() {
        assert!(validate_declared_outputs(&[]).is_err());
        assert!(validate_declared_outputs(&[StudyOutputPort {
            port_id: "final_state".into(),
            data_kind: StudyPortDataKind::State
        }])
        .is_err());
        assert!(validate_declared_outputs(&[StudyOutputPort {
            port_id: fullmag_application::MODAL_EIGEN_OUTPUT_PORT.into(),
            data_kind: StudyPortDataKind::Artifact
        }])
        .is_ok());
    }
    #[test]
    fn modal_codec_matches_authoritative_generation_wire_format_and_owner() {
        use fullmag_session::frequency_domain_artifact_generation::{
            digest, generation_id, GenerationBody, GenerationCommit, GenerationMember,
            PublicationOwner,
        };
        let payloads: BTreeMap<String, Vec<u8>> = BTreeMap::from([
            ("metadata.json".into(), br#"{"material_field_assets":[]}"#.to_vec()),
            ("frequency_domain/manifest.v1.json".into(), br#"{"schema_version":"frequency_domain_manifest.v1","study_product":"modal_eigen","run_id":"run-exact","stage_id":"eigen","artifacts":{"spectrum_v2_path":"eigen/spectrum.v2.json"}}"#.to_vec()),
            ("eigen/spectrum.v2.json".into(), br#"{"schema_version":"eigen_spectrum.v2","modes":[]}"#.to_vec()),
        ]);
        let content = GenerationBody {
            schema_version: "frequency_domain_artifact_generation.v2".into(),
            producer: Some(PublicationOwner {
                run_id: "run-exact".into(),
                stage_id: "eigen".into(),
                stage_kind: "eigenmodes".into(),
            }),
            members: payloads
                .iter()
                .map(|(p, b)| {
                    (
                        p.clone(),
                        GenerationMember {
                            byte_length: b.len() as u64,
                            sha256: digest(b),
                        },
                    )
                })
                .collect(),
        };
        let commit = GenerationCommit {
            generation_id: generation_id(&content).unwrap(),
            content,
        };
        let bytes = fullmag_application::encode_modal_eigen_bundle(
            &serde_json::to_vec_pretty(&commit).unwrap(),
            &payloads,
            4096,
        )
        .unwrap();
        validate_bundle(&bytes, "run-exact", "eigen", 4096).unwrap();
        assert!(validate_bundle(&bytes, "run-foreign", "eigen", 4096).is_err());
        assert!(validate_bundle(&bytes, "run-exact", "foreign", 4096).is_err());
    }
}
