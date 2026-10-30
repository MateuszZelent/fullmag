//! Accepted FEM CPU/GPU execution adapter.
//!
//! The process lifecycle remains owned by the existing accepted worker and
//! supervisor. This module owns only the FEM-specific admission, native
//! runner call and final-state proof; it has no scheduler or fallback path.

use anyhow::{bail, Context, Result};
use fullmag_application::{DecodedStudyArtifact, PreparationBinding};
use fullmag_authoring::{StudyAcceptancePolicy, StudyOutputPort, StudyPortDataKind};
use fullmag_ir::{
    BackendPlanIR, BackendTarget, ExecutionMode, ExecutionPrecision, RelaxationAlgorithmIR,
    StudyIR,
};
use fullmag_runner::{RunStatus, StageFemMeshAsset, StepAction};
use fullmag_runtime_control::{AcceptedStudySnapshot, AcceptedWorkerStep, StudyOutputPayload};
use fullmag_session::SessionStore;
use serde::Serialize;
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use crate::accepted_fem_state::FemCpuAcceptedStateSnapshotV1;
use crate::accepted_fem_gpu_state::FemGpuAcceptedStateSnapshotV1;

/// Result returned before the common worker publishes typed outputs and emits
/// its terminal completion event.
pub(crate) struct AcceptedFemExecution {
    pub(crate) status: RunStatus,
    pub(crate) completed_step_count: usize,
    pub(crate) outputs: Vec<StudyOutputPayload>,
    pub(crate) attempt_output_dir: std::path::PathBuf,
    pub(crate) accepted_state_ref: fullmag_quantities::AcceptedStateRef,
    pub(crate) terminal_stats: Option<fullmag_runner::StepStats>,
}

/// The solver may acknowledge an interrupt after producing a prefix of steps.
/// Keep that terminal outcome typed so the common worker can run its Stop and
/// completion fencing without treating cancellation as an execution error.
pub(crate) enum AcceptedFemExecutionOutcome {
    Completed(AcceptedFemExecution),
    Cancelled {
        completed_step_count: usize,
        attempt_output_dir: PathBuf,
    },
}

/// Immutable FEM execution input prepared before an attempt directory or
/// started receipt is created. Once the common worker has crossed that durable
/// boundary, the solver consumes this value instead of rereading accepted
/// preparation or mutable process inputs.
pub(crate) struct AcceptedFemPreparedExecution {
    pub(crate) case_id: String,
    pub(crate) problem: fullmag_ir::ProblemIR,
    pub(crate) execution_plan: fullmag_ir::ExecutionPlanIR,
    pub(crate) stage_mesh: StageFemMeshAsset,
    pub(crate) until_seconds: f64,
    pub(crate) output_ports: Vec<StudyOutputPort>,
    pub(crate) preparation_plan_fingerprint: String,
    pub(crate) plan_digest: String,
    pub(crate) resolved_device: String,
    pub(crate) gpu_uuid: Option<String>,
}

/// Resolve and validate every deterministic accepted FEM admission input
/// without creating files or invoking the solver.
pub(crate) fn prepare_accepted_fem_execution(
    store: &SessionStore,
    accepted: &AcceptedStudySnapshot,
    accepted_step: &AcceptedWorkerStep,
    study_step: &fullmag_authoring::StudyStep,
    case_id: &str,
    runtime: &crate::accepted_study_worker::AcceptedFemRuntime,
) -> Result<AcceptedFemPreparedExecution> {
    fullmag_session::repository_path::validate_store_id(case_id)
        .context("accepted FEM CPU case id is invalid")?;
    validate_fem_request(accepted_step, runtime)?;
    if !matches!(&study_step.acceptance, StudyAcceptancePolicy::Any) {
        bail!("accepted FEM producer has no evaluator for the study acceptance policy");
    }
    validate_declared_outputs(&study_step.outputs)?;

    // Receipts are keyed by the durable task id, not the study step id.
    let preparation = accepted
        .read_task_preparation_receipt(store, accepted_step.claim.task_id.as_str())
        .context("load exact accepted FEM preparation receipt")?;
    let preparation_binding = PreparationBinding::from_receipt(&preparation)
        .map_err(|error| anyhow::anyhow!(error.to_string()))
        .context("derive accepted FEM preparation binding")?;
    if preparation_binding != accepted_step.resolved_input.preparation {
        bail!("accepted FEM CPU preparation differs from the durable worker input");
    }
    validate_fem_preparation(&preparation)?;

    let execution_plan =
        crate::accepted_study_worker::materialize_resolved_study_inputs(store, accepted_step)
            .context("materialize accepted FEM CAS inputs for the runner")?;
    let mut problem = accepted_step.problem.clone();
    problem.problem_meta.runtime_metadata.insert(
        "runtime_device_override".into(),
        serde_json::json!({
            "device": runtime.resolved_device.clone(),
            "source": "managed_launcher"
        }),
    );
    validate_native_fem_preflight(&problem, &execution_plan, runtime)?;
    let stage_mesh = StageFemMeshAsset::build_from_backend_plan(&execution_plan.backend_plan)
        .context("accepted FEM plan has no stage mesh identity")?;
    let until_seconds = crate::accepted_study_worker::accepted_runner_horizon(accepted_step)
        .context("accepted FEM step runner horizon")?;

    Ok(AcceptedFemPreparedExecution {
        case_id: case_id.to_owned(),
        problem,
        execution_plan,
        stage_mesh,
        until_seconds,
        output_ports: study_step.outputs.clone(),
        preparation_plan_fingerprint: preparation.plan_fingerprint,
        plan_digest: accepted_plan_digest(accepted_step),
        resolved_device: runtime.resolved_device.clone(),
        gpu_uuid: runtime.gpu_uuid.clone(),
    })
}

/// Execute one already prepared accepted FEM attempt.
///
/// The caller must have consumed/reconciled the durable Start and started the
/// common heartbeat/Stop control loop. The common worker owns the private
/// attempt directory and its immutable started receipt. This adapter must not
/// be replayed after an ambiguous solver side effect; the common receipt
/// recovery owns that decision.
pub(crate) fn execute_accepted_fem_attempt(
    accepted_step: &AcceptedWorkerStep,
    prepared: &AcceptedFemPreparedExecution,
    attempt_output_dir: &Path,
    autosave_root: &Path,
    interrupt_requested: Option<&AtomicBool>,
) -> Result<AcceptedFemExecutionOutcome> {
    let display_selection = fullmag_runner::DisplaySelectionState::default;
    let mut live_observation = crate::accepted_study_worker::AcceptedLiveObservationWriter::new(
        attempt_output_dir,
        accepted_step,
        &prepared.execution_plan,
        format!("fem_{}", prepared.resolved_device),
    );
    let field_sampling_interval = live_observation.field_sampling_interval();
    let runner_result = fullmag_runner::run_planned_problem_with_live_preview_interruptible_with_initial_snapshot_and_fem_mesh_identity_and_autosave_root(
        &prepared.problem,
        &prepared.execution_plan,
        Some(&prepared.stage_mesh.identity),
        prepared.until_seconds,
        attempt_output_dir,
        autosave_root,
        field_sampling_interval,
        &display_selection,
        interrupt_requested,
        false,
        |update| {
            live_observation.observe(&update);
            StepAction::Continue
        },
    );
    // Scalar and mapped live fields share the bounded sidecar; final state is
    // still committed only through the durable output path.
    live_observation.finish();
    let result = runner_result
        .map_err(|error| anyhow::anyhow!(error.to_string()))
        .with_context(|| format!("execute accepted native FEM {} runner plan", prepared.resolved_device))?;
    if result.status == RunStatus::Cancelled {
        return Ok(AcceptedFemExecutionOutcome::Cancelled {
            completed_step_count: result.steps.len(),
            attempt_output_dir: attempt_output_dir.to_path_buf(),
        });
    }
    if result.status != RunStatus::Completed {
        bail!("accepted FEM {} runner did not complete successfully", prepared.resolved_device);
    }
    let terminal_stats = result.steps.last().cloned();

    // The shared output collector performs the metadata-size preflight before
    // allocating each explicit artifact. Reuse its owned state bytes instead
    // of reading m_final.json a second time.
    let outputs = crate::accepted_study_worker::collect_runner_study_outputs(
        &prepared.output_ports,
        &prepared.case_id,
        &result,
        &attempt_output_dir,
        accepted_step.claim.lease.budget.storage_bytes,
    )
    .context("collect bounded typed outputs from accepted FEM attempt")?;
    let state_output = outputs
        .iter()
        .find(|output| output.port_id == "final_state")
        .context("accepted FEM output has no final_state state artifact")?;
    let decoded = fullmag_application::decode_study_artifact_bytes(
        "state",
        &state_output.codec_id,
        &state_output.codec_version,
        &state_output.bytes,
    )
    .map_err(|error| anyhow::anyhow!(error.to_string()))
    .context("decode accepted FEM final state")?;
    let DecodedStudyArtifact::MagnetizationState(state) = decoded else {
        bail!("accepted FEM state output decoded to a non-magnetization artifact");
    };
    let accepted_state_ref = if prepared.resolved_device == "gpu" {
        let algorithm = match &prepared.problem.study {
            StudyIR::Relaxation { algorithm, .. } => *algorithm,
            _ => RelaxationAlgorithmIR::LlgOverdamped,
        };
        validate_projected_gradient_bb_receipt(algorithm, &state.provenance)?;
        let gpu_uuid = prepared
            .gpu_uuid
            .as_deref()
            .context("accepted FEM GPU execution has no authoritative device UUID")?;
        let snapshot = FemGpuAcceptedStateSnapshotV1::from_magnetization_state(&state, gpu_uuid)
            .map_err(anyhow::Error::msg)
            .context("construct accepted FEM GPU state identity")?;
        let accepted_state_ref = snapshot
            .to_accepted_state_ref(
                accepted_step.claim.run_id.as_str(),
                &accepted_step.step_id,
                accepted_step.claim.ownership_epoch.value(),
                &prepared.preparation_plan_fingerprint,
                &prepared.plan_digest,
            )
            .map_err(anyhow::Error::msg)
            .context("bind accepted FEM GPU state to run/step/plan")?;
        persist_accepted_state_snapshot(
            &attempt_output_dir,
            crate::accepted_fem_gpu_state::FEM_GPU_ACCEPTED_STATE_SNAPSHOT_FILE,
            "accepted FEM GPU",
            &snapshot,
        )?;
        accepted_state_ref
    } else {
        let snapshot = FemCpuAcceptedStateSnapshotV1::from_magnetization_state(&state)
            .map_err(anyhow::Error::msg)
            .context("construct accepted FEM CPU state identity")?;
        let accepted_state_ref = snapshot
            .to_accepted_state_ref(
                accepted_step.claim.run_id.as_str(),
                &accepted_step.step_id,
                accepted_step.claim.ownership_epoch.value(),
                &prepared.preparation_plan_fingerprint,
                &prepared.plan_digest,
            )
            .map_err(anyhow::Error::msg)
            .context("bind accepted FEM CPU state to run/step/plan")?;
        persist_accepted_state_snapshot(
            &attempt_output_dir,
            crate::accepted_fem_state::FEM_CPU_ACCEPTED_STATE_SNAPSHOT_FILE,
            "accepted FEM CPU",
            &snapshot,
        )?;
        accepted_state_ref
    };

    Ok(AcceptedFemExecutionOutcome::Completed(
        AcceptedFemExecution {
            status: result.status,
            completed_step_count: result.steps.len(),
            outputs,
            attempt_output_dir: attempt_output_dir.to_path_buf(),
            accepted_state_ref,
            terminal_stats,
        },
    ))
}

/// Recover the exact FEM accepted-state reference from the immutable snapshot
/// in a previously started attempt. The common worker calls this before any
/// second solver side effect when the started directory already exists.
pub(crate) fn accepted_state_ref_from_attempt_snapshot(
    attempt_output_dir: &Path,
    accepted_step: &AcceptedWorkerStep,
    runtime: &crate::accepted_study_worker::AcceptedFemRuntime,
) -> Result<fullmag_quantities::AcceptedStateRef> {
    let snapshot_file = match runtime.resolved_device.as_str() {
        "cpu" => crate::accepted_fem_state::FEM_CPU_ACCEPTED_STATE_SNAPSHOT_FILE,
        "gpu" => crate::accepted_fem_gpu_state::FEM_GPU_ACCEPTED_STATE_SNAPSHOT_FILE,
        other => bail!("accepted FEM recovery has unsupported resolved device `{other}`"),
    };
    let bytes = crate::accepted_study_worker::read_explicit_runner_artifact(
        attempt_output_dir,
        snapshot_file,
        64 * 1024,
    )
    .context("read bounded accepted FEM state snapshot for recovery")?;

    if runtime.resolved_device == "gpu" {
        let snapshot: FemGpuAcceptedStateSnapshotV1 = serde_json::from_slice(&bytes)
            .context("decode accepted FEM GPU state snapshot for recovery")?;
        snapshot
            .validate()
            .map_err(anyhow::Error::msg)
            .context("validate accepted FEM GPU state snapshot for recovery")?;
        let gpu_uuid = runtime
            .gpu_uuid
            .as_deref()
            .context("accepted FEM GPU recovery has no authoritative device UUID")?;
        if snapshot.gpu_uuid != gpu_uuid {
            bail!("accepted FEM GPU state snapshot UUID differs from the authoritative lease");
        }
        let final_state_bytes = crate::accepted_study_worker::read_explicit_runner_artifact(
            attempt_output_dir,
            crate::accepted_study_worker::RUNNER_FINAL_STATE_FILE,
            accepted_step.claim.lease.budget.storage_bytes,
        )
        .context("read accepted FEM GPU final state for recovery")?;
        let decoded = fullmag_application::decode_study_artifact_bytes(
            "state",
            fullmag_application::STUDY_MAGNETIZATION_CODEC_ID,
            fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION,
            &final_state_bytes,
        )
        .map_err(|error| anyhow::anyhow!(error.to_string()))
        .context("decode accepted FEM GPU final state for recovery")?;
        let DecodedStudyArtifact::MagnetizationState(state) = decoded else {
            bail!("accepted FEM GPU recovery final state is not a magnetization artifact");
        };
        let algorithm = match &accepted_step.problem.study {
            StudyIR::Relaxation { algorithm, .. } => *algorithm,
            _ => RelaxationAlgorithmIR::LlgOverdamped,
        };
        validate_projected_gradient_bb_receipt(algorithm, &state.provenance)?;
        let rebuilt = FemGpuAcceptedStateSnapshotV1::from_magnetization_state(&state, gpu_uuid)
            .map_err(anyhow::Error::msg)
            .context("rebuild accepted FEM GPU state identity during recovery")?;
        if rebuilt != snapshot {
            bail!("accepted FEM GPU state sidecar differs from the immutable final state receipt");
        }
        rebuilt
            .to_accepted_state_ref(
                accepted_step.claim.run_id.as_str(),
                &accepted_step.step_id,
                accepted_step.claim.ownership_epoch.value(),
                &accepted_step.resolved_input.preparation.plan_fingerprint,
                &accepted_plan_digest(accepted_step),
            )
            .map_err(anyhow::Error::msg)
            .context("bind recovered accepted FEM GPU state to the current claim")
    } else {
        let snapshot: FemCpuAcceptedStateSnapshotV1 = serde_json::from_slice(&bytes)
            .context("decode accepted FEM CPU state snapshot for recovery")?;
        snapshot
            .validate()
            .map_err(anyhow::Error::msg)
            .context("validate accepted FEM CPU state snapshot for recovery")?;
        snapshot
            .to_accepted_state_ref(
                accepted_step.claim.run_id.as_str(),
                &accepted_step.step_id,
                accepted_step.claim.ownership_epoch.value(),
                &accepted_step.resolved_input.preparation.plan_fingerprint,
                &accepted_plan_digest(accepted_step),
            )
            .map_err(anyhow::Error::msg)
            .context("bind recovered accepted FEM CPU state to the current claim")
    }
}

fn validate_fem_request(
    accepted_step: &AcceptedWorkerStep,
    runtime: &crate::accepted_study_worker::AcceptedFemRuntime,
) -> Result<()> {
    let request = &accepted_step.resolved_input.requested_execution;
    if request.backend != "fem" || request.precision != "double" || request.mode != "strict" {
        bail!("accepted FEM producer requires fem/<device>/double/strict request");
    }
    if request.device != "auto" && request.device != runtime.resolved_device {
        bail!(
            "accepted FEM request device `{}` differs from resolved `{}`",
            request.device,
            runtime.resolved_device
        );
    }
    match runtime.resolved_device.as_str() {
        "cpu" if runtime.gpu_uuid.is_some() => {
            bail!("accepted FEM CPU runtime unexpectedly carries a GPU UUID")
        }
        "gpu" if runtime.gpu_uuid.is_none() => {
            bail!("accepted FEM GPU runtime has no authoritative device UUID")
        }
        "cpu" | "gpu" => {}
        other => bail!("accepted FEM runtime has unsupported device `{other}`"),
    }
    if accepted_step.problem.backend_policy.requested_backend != BackendTarget::Fem
        || accepted_step.problem.backend_policy.execution_precision != ExecutionPrecision::Double
        || accepted_step.problem.validation_profile.execution_mode != ExecutionMode::Strict
        || accepted_step.execution_plan.common.requested_backend != BackendTarget::Fem
        || accepted_step.execution_plan.common.resolved_backend != BackendTarget::Fem
        || accepted_step.execution_plan.common.execution_mode != ExecutionMode::Strict
    {
        bail!("accepted FEM problem or plan is outside the strict FEM lane");
    }
    let BackendPlanIR::Fem(fem_plan) = &accepted_step.execution_plan.backend_plan else {
        bail!("accepted FEM producer requires a time-domain FEM plan");
    };
    if fem_plan.fe_order != 1 {
        bail!("accepted FEM producer currently requires FEM H1/P1");
    }
    if runtime.resolved_device == "gpu" {
        validate_gpu_study_scope(&accepted_step.problem)?;
    }
    if let Ok(value) = std::env::var("FULLMAG_FEM_EXECUTION") {
        let normalized = value.trim().to_ascii_lowercase();
        let expected = if runtime.resolved_device == "gpu" {
            ["gpu", "cuda", "all_in_gpu"]
        } else {
            ["cpu", "", ""]
        };
        if !normalized.is_empty()
            && !expected
                .iter()
                .any(|candidate| *candidate == normalized.as_str())
        {
            bail!("FULLMAG_FEM_EXECUTION overrides the accepted FEM request");
        }
    }
    if runtime.resolved_device == "cpu" {
        for variable in ["FULLMAG_FEM_ALL_IN_GPU", "FULLMAG_FEM_REQUIRE_GPU"] {
            if std::env::var(variable).is_ok_and(|value| is_truthy(&value)) {
                bail!("{variable} cannot force GPU execution for an accepted FEM CPU task");
            }
        }
    }
    Ok(())
}

fn validate_gpu_study_scope(problem: &fullmag_ir::ProblemIR) -> Result<()> {
    match &problem.study {
        StudyIR::TimeEvolution { .. } => Ok(()),
        StudyIR::Relaxation { algorithm, .. }
            if accepted_gpu_relaxation_algorithm(*algorithm) => Ok(()),
        StudyIR::Relaxation { algorithm, .. } => bail!(
            "accepted FEM GPU does not have a native execution receipt for relaxation algorithm {algorithm:?}"
        ),
        _ => bail!(
            "accepted FEM GPU requires TimeEvolution, LLG-overdamped Relaxation, or ProjectedGradientBb scope"
        ),
    }
}

fn accepted_gpu_relaxation_algorithm(algorithm: RelaxationAlgorithmIR) -> bool {
    matches!(
        algorithm,
        RelaxationAlgorithmIR::LlgOverdamped | RelaxationAlgorithmIR::ProjectedGradientBb
    )
}

/// Bind the newly accepted FEM GPU PG-BB scope to the runner's typed native
/// receipt and direct-minimizer realization.  The state snapshot constructor
/// remains the authority for the complete strict device receipt; this check
/// adds the algorithm-specific identity that the generic receipt cannot carry.
fn validate_projected_gradient_bb_receipt(
    algorithm: RelaxationAlgorithmIR,
    provenance: &serde_json::Value,
) -> Result<()> {
    if algorithm != RelaxationAlgorithmIR::ProjectedGradientBb {
        return Ok(());
    }

    for (key, expected) in [
        ("execution_engine", "fem_native_gpu"),
        ("execution_mode", "strict"),
        ("requested_energy_minimizer", "projected_gradient_bb"),
        ("resolved_energy_minimizer", "projected_gradient_bb"),
        ("energy_minimizer_realization", "native_cuda_pgbb"),
    ] {
        if provenance.get(key).and_then(serde_json::Value::as_str) != Some(expected) {
            bail!(
                "accepted FEM GPU ProjectedGradientBb receipt has {key} other than `{expected}`"
            );
        }
    }
    if provenance
        .get("resolved_fallback")
        .is_some_and(|fallback| !fallback.is_null())
        || provenance
            .get("lossy_fallback_used")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    {
        bail!("accepted FEM GPU ProjectedGradientBb receipt records a fallback");
    }

    let receipt: fullmag_runner::FemGpuMinimizerExecutionReceipt = serde_json::from_value(
        provenance
            .get("fem_gpu_minimizer_execution_receipt")
            .cloned()
            .context("accepted FEM GPU ProjectedGradientBb receipt is missing")?,
    )
    .context("decode accepted FEM GPU ProjectedGradientBb receipt")?;
    if receipt.algorithm != "projected_gradient_bb"
        || receipt.accounting.requested != "strict_device"
        || receipt.accounting.resolved != "device_resident"
        || receipt.accounting.executed != "cuda_fem"
        || receipt.accounting.precision != "double"
        || receipt.accounting.device_ordinal != 0
        || receipt.accounting.accepted_step_count == 0
    {
        bail!(
            "accepted FEM GPU ProjectedGradientBb receipt is not the strict double CUDA realization"
        );
    }
    receipt
        .validate_strict_device()
        .map_err(|error| anyhow::anyhow!("native FEM GPU receipt rejected: {error}"))?;
    Ok(())
}

fn validate_native_fem_preflight(
    problem: &fullmag_ir::ProblemIR,
    execution_plan: &fullmag_ir::ExecutionPlanIR,
    accepted_runtime: &crate::accepted_study_worker::AcceptedFemRuntime,
) -> Result<()> {
    let runtime = fullmag_runner::resolve_session_runtime_for_plan_and_preview(
        problem,
        execution_plan,
        u64::MAX,
    )
    .map_err(|error| anyhow::anyhow!(error.to_string()))
    .context("resolve accepted FEM native runtime before the solver")?;
    let expected_engine = if accepted_runtime.resolved_device == "gpu" {
        "fem_native_gpu"
    } else {
        "fem_cpu_native"
    };
    if runtime.resolved_backend != "fem"
        || runtime.resolved_device != accepted_runtime.resolved_device
        || runtime.resolved_precision != "double"
        || runtime.resolved_engine_id.as_deref() != Some(expected_engine)
    {
        bail!(
            "accepted FEM preflight resolved to an unexpected runtime: backend={}, device={}, precision={}, engine={:?}",
            runtime.resolved_backend,
            runtime.resolved_device,
            runtime.resolved_precision,
            runtime.resolved_engine_id
        );
    }
    if runtime.resolved_fallback.is_some() {
        bail!("accepted FEM preflight rejected a resolved fallback before the solver");
    }

    let BackendPlanIR::Fem(fem_plan) = &execution_plan.backend_plan else {
        bail!("accepted FEM preflight requires a time-domain FEM plan");
    };
    if !fem_plan.mesh.periodic_node_pairs.is_empty() {
        // The runner's FemStaticPbcLane is crate-private and its reference
        // reduction is not an accepted native producer contract. Refuse every
        // periodic lane here until the runner exports an immutable native-lane
        // attestation; this keeps ReferenceReduction and hidden fallback out of
        // the accepted attempt before any solver side effect.
        bail!(
            "accepted FEM preflight rejects static PBC without a native FemStaticPbcLane attestation; ReferenceReduction and fallback are forbidden"
        );
    }
    Ok(())
}

fn validate_fem_preparation(preparation: &fullmag_application::PreparationReceipt) -> Result<()> {
    if preparation.plan.requested_backend != BackendTarget::Fem
        || preparation.plan.resolved_backend != BackendTarget::Fem
    {
        bail!("accepted FEM CPU receipt has a non-FEM preparation plan");
    }
    let mut space_certificates = preparation
        .certificates
        .iter()
        .filter_map(|certificate| certificate.space.as_ref())
        .filter(|space| {
            space.fe_family.as_deref() == Some("H1")
                && space.fe_order == Some(1)
                && space.local_dof_count.is_some_and(|count| count > 0)
                && space.true_dof_count.is_some_and(|count| count > 0)
        });
    if space_certificates.next().is_none() || space_certificates.next().is_some() {
        bail!("accepted FEM CPU receipt must contain exactly one H1/P1 space certificate");
    }
    Ok(())
}

pub(crate) fn validate_declared_outputs(outputs: &[StudyOutputPort]) -> Result<()> {
    let mut seen = BTreeSet::new();
    let mut final_state = false;
    for output in outputs {
        if !seen.insert(output.port_id.as_str()) {
            bail!("accepted FEM CPU study declares duplicate output port");
        }
        match output.data_kind {
            StudyPortDataKind::State if output.port_id == "final_state" => {
                final_state = true;
            }
            StudyPortDataKind::Scalar if output.port_id == "total_energy" => {}
            _ => bail!(
                "accepted FEM CPU study output `{}` is outside final_state/total_energy contract",
                output.port_id
            ),
        }
    }
    if !final_state {
        bail!("accepted FEM CPU study must declare final_state as its State output");
    }
    Ok(())
}

fn accepted_plan_digest(accepted_step: &AcceptedWorkerStep) -> String {
    if accepted_step
        .resolved_input
        .plan_fingerprint
        .starts_with("sha256:")
    {
        accepted_step.resolved_input.plan_fingerprint.clone()
    } else {
        format!("sha256:{}", accepted_step.resolved_input.plan_fingerprint)
    }
}

fn is_truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on" | "y"
    )
}

#[cfg(test)]
mod source_contract_tests {
    use super::{
        accepted_gpu_relaxation_algorithm, validate_projected_gradient_bb_receipt,
    };
    use fullmag_ir::RelaxationAlgorithmIR;
    use serde_json::json;

    #[test]
    fn accepted_gpu_scope_admits_pgbb_and_rejects_unqualified_direct_minimizers() {
        assert!(accepted_gpu_relaxation_algorithm(
            RelaxationAlgorithmIR::ProjectedGradientBb
        ));
        assert!(accepted_gpu_relaxation_algorithm(
            RelaxationAlgorithmIR::LlgOverdamped
        ));
        assert!(!accepted_gpu_relaxation_algorithm(
            RelaxationAlgorithmIR::NonlinearCg
        ));
        assert!(!accepted_gpu_relaxation_algorithm(
            RelaxationAlgorithmIR::TangentPlaneImplicit
        ));
    }

    #[test]
    fn projected_gradient_bb_requires_the_typed_native_cuda_receipt() {
        let provenance = json!({
            "execution_engine": "fem_native_gpu",
            "execution_mode": "strict",
            "requested_energy_minimizer": "projected_gradient_bb",
            "resolved_energy_minimizer": "projected_gradient_bb",
            "energy_minimizer_realization": "native_cuda_pgbb",
            "fem_gpu_minimizer_execution_receipt": {
                "schema_version": "fullmag.fem.gpu.minimizer-execution-receipt.v1",
                "algorithm": "projected_gradient_bb",
                "accounting": {
                "requested": "strict_device",
                "resolved": "device_resident",
                "executed": "cuda_fem",
                "execution_class": "device_resident",
                "device_ordinal": 0,
                "precision": "double",
                "integrator": "not_used",
                "required_operator_mask": 1823,
                "resolved_device_operator_mask": 1823,
                "resolved_host_operator_mask": 0,
                "resolved_unknown_operator_mask": 0,
                "executed_device_operator_mask": 1823,
                "executed_host_operator_mask": 0,
                "executed_unknown_operator_mask": 0,
                "fallback_count": 0,
                "accepted_step_count": 1,
                "rejected_attempt_count": 0,
                "failed_attempt_count": 0,
                "hot_loop_compute_h2d_bytes": 0,
                "hot_loop_compute_d2h_bytes": 0,
                "hot_loop_compute_host_sync_count": 0,
                "accounting_valid": true
                }
            }
        });
        assert!(validate_projected_gradient_bb_receipt(
            RelaxationAlgorithmIR::ProjectedGradientBb,
            &provenance
        )
        .is_ok());
        let mut wrong_realization = provenance.clone();
        wrong_realization["energy_minimizer_realization"] = json!("native_mfem_pgbb");
        assert!(validate_projected_gradient_bb_receipt(
            RelaxationAlgorithmIR::ProjectedGradientBb,
            &wrong_realization
        )
        .is_err());
    }

    #[test]
    fn common_worker_retains_stop_completion_and_recovery_fences() {
        let source = include_str!("accepted_study_worker.rs");
        for needle in [
            "finish_worker_control",
            "publish_worker_stopped",
            "CoordinatorPhase::Stopping",
            "WorkerEvent::Completing",
            "recover_completed_worker_execution",
            "WORKER_EXECUTION_STARTED_RECEIPT",
            "WORKER_EXECUTION_COMPLETED_RECEIPT",
        ] {
            assert!(source.contains(needle), "missing lifecycle fence: {needle}");
        }
    }

    #[test]
    fn cancellation_is_structured_before_common_stop_handling() {
        let source = include_str!("accepted_fem_study_worker.rs")
            .split_once("#[cfg(test)]")
            .expect("source contracts follow the production execution adapter")
            .0;
        assert!(source.contains("AcceptedFemExecutionOutcome::Cancelled"));
        assert!(source.contains("FemStaticPbcLane attestation"));
        assert!(!source.contains("runner was cancelled before final-state publication"));
    }

    #[test]
    fn fem_outputs_keep_the_fixture_public_port_names() {
        let source = include_str!("accepted_fem_study_worker.rs");
        assert!(source.contains("StudyPortDataKind::State if output.port_id == \"final_state\""));
        assert!(source.contains("StudyPortDataKind::Scalar if output.port_id == \"total_energy\""));
    }

    #[test]
    fn deterministic_fem_preflight_precedes_attempt_receipt() {
        let worker = include_str!("accepted_study_worker.rs");
        let fem_start = worker
            .find("fn execute_accepted_fem_worker_start")
            .expect("FEM lifecycle adapter is wired");
        let fem_source = &worker[fem_start..];
        let prepare = fem_source
            .find("prepare_accepted_fem_execution")
            .expect("FEM preparation is explicit");
        let reserve = fem_source
            .find("create_private_attempt_output_dir")
            .expect("FEM lifecycle reserves an attempt directory");
        let started = fem_source
            .find("WORKER_EXECUTION_STARTED_RECEIPT")
            .expect("FEM lifecycle persists a started receipt");
        assert!(prepare < reserve);
        assert!(prepare < started);

        let adapter = include_str!("accepted_fem_study_worker.rs");
        let execute_start = adapter
            .find("pub(crate) fn execute_accepted_fem_attempt")
            .expect("prepared FEM execution entrypoint is present");
        let execute_end = adapter
            .find("pub(crate) fn accepted_state_ref_from_attempt_snapshot")
            .expect("FEM recovery entrypoint is present");
        let execute_source = &adapter[execute_start..execute_end];
        assert!(!execute_source.contains("read_task_preparation_receipt"));
        assert!(!execute_source.contains("materialize_resolved_study_inputs"));
        assert!(!execute_source.contains("resolve_session_runtime_for_plan_and_preview"));
    }

    #[test]
    fn both_api_binary_roots_register_the_fem_modules() {
        for source in [
            include_str!("main.rs"),
            include_str!("accepted_worker_main.rs"),
        ] {
            assert!(source.contains("mod accepted_fem_state;"));
            assert!(source.contains("mod accepted_fem_gpu_state;"));
            assert!(source.contains("mod accepted_fem_study_worker;"));
        }
    }

    #[test]
    fn gpu_recovery_rebuilds_against_the_immutable_final_state() {
        let source = include_str!("accepted_fem_study_worker.rs");
        for needle in [
            "RUNNER_FINAL_STATE_FILE",
            "read_explicit_runner_artifact",
            "FemGpuAcceptedStateSnapshotV1::from_magnetization_state",
            "validate_projected_gradient_bb_receipt",
            "rebuilt != snapshot",
            "authoritative device UUID",
        ] {
            assert!(source.contains(needle), "missing GPU recovery fence: {needle}");
        }
    }

    #[test]
    fn gpu_execution_preserves_authored_selection_and_records_managed_override() {
        let source = include_str!("accepted_fem_study_worker.rs");
        assert!(source.contains("runtime_device_override"));
        assert!(source.contains("\"source\": \"managed_launcher\""));
        assert!(source.contains("validate_gpu_study_scope"));
        assert!(!source
            .split_once("#[cfg(test)]")
            .expect("source tests follow the adapter")
            .0
            .contains("runtime_selection"));
    }
}

fn persist_accepted_state_snapshot<T: Serialize>(
    attempt_output_dir: &Path,
    snapshot_file: &str,
    label: &str,
    snapshot: &T,
) -> Result<()> {
    let solver_dir = attempt_output_dir.join("solver");
    match fs::symlink_metadata(&solver_dir) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => bail!("accepted FEM solver receipt directory is not a real directory"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&solver_dir)
                .context("create accepted FEM solver receipt directory")?;
        }
        Err(error) => {
            return Err(error).context("inspect accepted FEM solver receipt directory");
        }
    }
    let path = attempt_output_dir.join(snapshot_file);
    let bytes = serde_json::to_vec_pretty(snapshot)
        .with_context(|| format!("serialize {label} state snapshot"))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .with_context(|| {
            format!(
                "create {label} state snapshot `{}`",
                path.display()
            )
        })?;
    file.write_all(&bytes)
        .with_context(|| format!("write {label} state snapshot `{}`", path.display()))?;
    file.sync_all()
        .with_context(|| format!("sync {label} state snapshot `{}`", path.display()))?;
    drop(file);
    #[cfg(unix)]
    fs::File::open(&solver_dir)
        .context("open accepted FEM solver receipt directory")?
        .sync_all()
        .context("sync accepted FEM solver receipt directory")?;
    Ok(())
}
