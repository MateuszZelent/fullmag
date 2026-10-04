//! One-shot accepted FEM CPU execution adapter.
//!
//! The process lifecycle remains owned by the existing accepted worker and
//! supervisor. This module owns only the FEM-specific admission, native
//! runner call and final-state proof; it has no scheduler or fallback path.

use anyhow::{bail, Context, Result};
use fullmag_application::{DecodedStudyArtifact, PreparationBinding};
use fullmag_authoring::{StudyAcceptancePolicy, StudyOutputPort, StudyPortDataKind};
use fullmag_ir::{BackendPlanIR, BackendTarget, ExecutionMode, ExecutionPrecision};
use fullmag_runner::{RunStatus, StageFemMeshAsset, StepAction};
use fullmag_runtime_control::{AcceptedStudySnapshot, AcceptedWorkerStep, StudyOutputPayload};
use fullmag_session::SessionStore;
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use crate::accepted_fem_state::FemCpuAcceptedStateSnapshotV1;

/// Result returned before the common worker publishes typed outputs and emits
/// its terminal completion event.
pub(crate) struct AcceptedFemCpuExecution {
    pub(crate) status: RunStatus,
    pub(crate) completed_step_count: usize,
    pub(crate) outputs: Vec<StudyOutputPayload>,
    pub(crate) attempt_output_dir: std::path::PathBuf,
    pub(crate) accepted_state_snapshot: FemCpuAcceptedStateSnapshotV1,
    pub(crate) accepted_state_ref: fullmag_quantities::AcceptedStateRef,
}

/// The solver may acknowledge an interrupt after producing a prefix of steps.
/// Keep that terminal outcome typed so the common worker can run its Stop and
/// completion fencing without treating cancellation as an execution error.
pub(crate) enum AcceptedFemCpuExecutionOutcome {
    Completed(AcceptedFemCpuExecution),
    Cancelled {
        completed_step_count: usize,
        attempt_output_dir: PathBuf,
    },
}

/// Immutable FEM execution input prepared before an attempt directory or
/// started receipt is created. Once the common worker has crossed that durable
/// boundary, the solver consumes this value instead of rereading accepted
/// preparation or mutable process inputs.
pub(crate) struct AcceptedFemCpuPreparedExecution {
    pub(crate) case_id: String,
    pub(crate) problem: fullmag_ir::ProblemIR,
    pub(crate) execution_plan: fullmag_ir::ExecutionPlanIR,
    pub(crate) stage_mesh: StageFemMeshAsset,
    pub(crate) until_seconds: f64,
    pub(crate) output_ports: Vec<StudyOutputPort>,
    pub(crate) preparation_plan_fingerprint: String,
    pub(crate) plan_digest: String,
}

/// Resolve and validate every deterministic accepted FEM admission input
/// without creating files or invoking the solver.
pub(crate) fn prepare_accepted_fem_cpu_execution(
    store: &SessionStore,
    accepted: &AcceptedStudySnapshot,
    accepted_step: &AcceptedWorkerStep,
    study_step: &fullmag_authoring::StudyStep,
    case_id: &str,
) -> Result<AcceptedFemCpuPreparedExecution> {
    fullmag_session::repository_path::validate_store_id(case_id)
        .context("accepted FEM CPU case id is invalid")?;
    validate_fem_cpu_request(accepted_step)?;
    if !matches!(&study_step.acceptance, StudyAcceptancePolicy::Any) {
        bail!("accepted FEM CPU producer has no evaluator for the study acceptance policy");
    }
    validate_declared_outputs(&study_step.outputs)?;

    let preparation = accepted
        .read_task_preparation_receipt(store, &accepted_step.step_id)
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
        "runtime_selection".into(),
        serde_json::json!({"device": "cpu", "precision": "double"}),
    );
    validate_native_fem_cpu_preflight(&problem, &execution_plan)?;
    let stage_mesh = StageFemMeshAsset::build_from_backend_plan(&execution_plan.backend_plan)
        .context("accepted FEM CPU plan has no stage mesh identity")?;
    let until_seconds = accepted_step
        .until_seconds
        .context("accepted FEM CPU step has no pinned runner horizon")?;
    if !until_seconds.is_finite() || until_seconds <= 0.0 {
        bail!("accepted FEM CPU runner horizon is invalid");
    }

    Ok(AcceptedFemCpuPreparedExecution {
        case_id: case_id.to_owned(),
        problem,
        execution_plan,
        stage_mesh,
        until_seconds,
        output_ports: study_step.outputs.clone(),
        preparation_plan_fingerprint: preparation.plan_fingerprint,
        plan_digest: accepted_plan_digest(accepted_step),
    })
}

/// Execute one already prepared accepted FEM CPU attempt.
///
/// The caller must have consumed/reconciled the durable Start and started the
/// common heartbeat/Stop control loop. The common worker owns the private
/// attempt directory and its immutable started receipt. This adapter must not
/// be replayed after an ambiguous solver side effect; the common receipt
/// recovery owns that decision.
pub(crate) fn execute_accepted_fem_cpu_attempt(
    accepted_step: &AcceptedWorkerStep,
    prepared: &AcceptedFemCpuPreparedExecution,
    attempt_output_dir: &Path,
    interrupt_requested: Option<&AtomicBool>,
) -> Result<AcceptedFemCpuExecutionOutcome> {
    let display_selection = fullmag_runner::DisplaySelectionState::default;
    let result = fullmag_runner::run_planned_problem_with_live_preview_interruptible_with_initial_snapshot_and_fem_mesh_identity_and_autosave_root(
        &prepared.problem,
        &prepared.execution_plan,
        Some(&prepared.stage_mesh.identity),
        prepared.until_seconds,
        attempt_output_dir,
        attempt_output_dir,
        u64::MAX,
        &display_selection,
        interrupt_requested,
        false,
        |_| StepAction::Continue,
    )
    .map_err(|error| anyhow::anyhow!(error.to_string()))
    .context("execute accepted native FEM CPU runner plan")?;
    if result.status == RunStatus::Cancelled {
        return Ok(AcceptedFemCpuExecutionOutcome::Cancelled {
            completed_step_count: result.steps.len(),
            attempt_output_dir: attempt_output_dir.to_path_buf(),
        });
    }
    if result.status != RunStatus::Completed {
        bail!("accepted FEM CPU runner did not complete successfully");
    }

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
    .context("collect bounded typed outputs from accepted FEM CPU attempt")?;
    let state_output = outputs
        .iter()
        .find(|output| output.port_id == "final_state")
        .context("accepted FEM CPU output has no final_state state artifact")?;
    let decoded = fullmag_application::decode_study_artifact_bytes(
        "state",
        &state_output.codec_id,
        &state_output.codec_version,
        &state_output.bytes,
    )
    .map_err(|error| anyhow::anyhow!(error.to_string()))
    .context("decode accepted FEM CPU final state")?;
    let DecodedStudyArtifact::MagnetizationState(state) = decoded else {
        bail!("accepted FEM CPU state output decoded to a non-magnetization artifact");
    };
    let accepted_state_snapshot = FemCpuAcceptedStateSnapshotV1::from_magnetization_state(&state)
        .map_err(anyhow::Error::msg)
        .context("construct accepted FEM CPU state identity")?;
    let accepted_state_ref = accepted_state_snapshot
        .to_accepted_state_ref(
            accepted_step.claim.run_id.as_str(),
            &accepted_step.step_id,
            accepted_step.claim.ownership_epoch.value(),
            &prepared.preparation_plan_fingerprint,
            &prepared.plan_digest,
        )
        .map_err(anyhow::Error::msg)
        .context("bind accepted FEM CPU state to run/step/plan")?;
    persist_accepted_state_snapshot(&attempt_output_dir, &accepted_state_snapshot)
        .context("persist immutable accepted FEM CPU state snapshot")?;

    Ok(AcceptedFemCpuExecutionOutcome::Completed(
        AcceptedFemCpuExecution {
            status: result.status,
            completed_step_count: result.steps.len(),
            outputs,
            attempt_output_dir: attempt_output_dir.to_path_buf(),
            accepted_state_snapshot,
            accepted_state_ref,
        },
    ))
}

/// Recover the exact FEM accepted-state reference from the immutable snapshot
/// in a previously started attempt. The common worker calls this before any
/// second solver side effect when the started directory already exists.
pub(crate) fn accepted_state_ref_from_attempt_snapshot(
    attempt_output_dir: &Path,
    accepted_step: &AcceptedWorkerStep,
) -> Result<fullmag_quantities::AcceptedStateRef> {
    let path =
        attempt_output_dir.join(crate::accepted_fem_state::FEM_CPU_ACCEPTED_STATE_SNAPSHOT_FILE);
    let metadata = fs::symlink_metadata(&path).with_context(|| {
        format!(
            "inspect accepted FEM CPU state snapshot `{}`",
            path.display()
        )
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("accepted FEM CPU state snapshot must be a regular file");
    }
    const MAX_SNAPSHOT_BYTES: u64 = 64 * 1024;
    if metadata.len() > MAX_SNAPSHOT_BYTES {
        bail!("accepted FEM CPU state snapshot exceeds the bounded recovery budget");
    }
    let bytes = fs::read(&path)
        .with_context(|| format!("read accepted FEM CPU state snapshot `{}`", path.display()))?;
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

fn validate_fem_cpu_request(accepted_step: &AcceptedWorkerStep) -> Result<()> {
    let request = &accepted_step.resolved_input.requested_execution;
    if request.backend != "fem"
        || request.device != "cpu"
        || request.precision != "double"
        || request.mode != "strict"
    {
        bail!("accepted FEM CPU producer requires fem/cpu/double/strict request");
    }
    if accepted_step.claim.lease.kind != fullmag_application::ResourceKind::Cpu
        || accepted_step.claim.lease.budget.gpu_memory_bytes != 0
    {
        bail!("accepted FEM CPU producer requires a CPU lease with zero GPU budget");
    }
    if accepted_step.problem.backend_policy.requested_backend != BackendTarget::Fem
        || accepted_step.problem.backend_policy.execution_precision != ExecutionPrecision::Double
        || accepted_step.problem.validation_profile.execution_mode != ExecutionMode::Strict
        || accepted_step.execution_plan.common.requested_backend != BackendTarget::Fem
        || accepted_step.execution_plan.common.resolved_backend != BackendTarget::Fem
        || accepted_step.execution_plan.common.execution_mode != ExecutionMode::Strict
    {
        bail!("accepted FEM CPU problem or plan is outside the strict FEM lane");
    }
    let BackendPlanIR::Fem(fem_plan) = &accepted_step.execution_plan.backend_plan else {
        bail!("accepted FEM CPU producer requires a time-domain FEM plan");
    };
    if fem_plan.fe_order != 1 {
        bail!("accepted FEM CPU producer currently requires FEM H1/P1");
    }
    if let Ok(value) = std::env::var("FULLMAG_FEM_EXECUTION") {
        let normalized = value.trim().to_ascii_lowercase();
        if !normalized.is_empty() && normalized != "cpu" {
            bail!("FULLMAG_FEM_EXECUTION overrides the accepted CPU request");
        }
    }
    for variable in ["FULLMAG_FEM_ALL_IN_GPU", "FULLMAG_FEM_REQUIRE_GPU"] {
        if std::env::var(variable).is_ok_and(|value| is_truthy(&value)) {
            bail!("{variable} cannot force GPU execution for an accepted FEM CPU task");
        }
    }
    Ok(())
}

fn validate_native_fem_cpu_preflight(
    problem: &fullmag_ir::ProblemIR,
    execution_plan: &fullmag_ir::ExecutionPlanIR,
) -> Result<()> {
    let runtime = fullmag_runner::resolve_session_runtime_for_plan_and_preview(
        problem,
        execution_plan,
        u64::MAX,
    )
    .map_err(|error| anyhow::anyhow!(error.to_string()))
    .context("resolve accepted FEM CPU native runtime before the solver")?;
    if runtime.resolved_backend != "fem"
        || runtime.resolved_device != "cpu"
        || runtime.resolved_precision != "double"
        || runtime.resolved_engine_id.as_deref() != Some("fem_cpu_native")
    {
        bail!(
            "accepted FEM CPU preflight resolved to an unexpected runtime: backend={}, device={}, precision={}, engine={:?}",
            runtime.resolved_backend,
            runtime.resolved_device,
            runtime.resolved_precision,
            runtime.resolved_engine_id
        );
    }
    if runtime.resolved_fallback.is_some() {
        bail!("accepted FEM CPU preflight rejected a resolved fallback before the solver");
    }

    let BackendPlanIR::Fem(fem_plan) = &execution_plan.backend_plan else {
        bail!("accepted FEM CPU preflight requires a time-domain FEM plan");
    };
    if !fem_plan.mesh.periodic_node_pairs.is_empty() {
        // The runner's FemStaticPbcLane is crate-private and its reference
        // reduction is not an accepted native producer contract. Refuse every
        // periodic lane here until the runner exports an immutable native-lane
        // attestation; this keeps ReferenceReduction and hidden fallback out of
        // the accepted attempt before any solver side effect.
        bail!(
            "accepted FEM CPU preflight rejects static PBC without a native FemStaticPbcLane attestation; ReferenceReduction and fallback are forbidden"
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
        let source = include_str!("accepted_fem_study_worker.rs");
        assert!(source.contains("AcceptedFemCpuExecutionOutcome::Cancelled"));
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
            .find("prepare_accepted_fem_cpu_execution")
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
            .find("pub(crate) fn execute_accepted_fem_cpu_attempt")
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
            assert!(source.contains("mod accepted_fem_study_worker;"));
        }
    }
}

fn persist_accepted_state_snapshot(
    attempt_output_dir: &Path,
    snapshot: &FemCpuAcceptedStateSnapshotV1,
) -> Result<()> {
    let solver_dir = attempt_output_dir.join("solver");
    match fs::symlink_metadata(&solver_dir) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => bail!("accepted FEM CPU solver receipt directory is not a real directory"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&solver_dir)
                .context("create accepted FEM CPU solver receipt directory")?;
        }
        Err(error) => {
            return Err(error).context("inspect accepted FEM CPU solver receipt directory");
        }
    }
    let path =
        attempt_output_dir.join(crate::accepted_fem_state::FEM_CPU_ACCEPTED_STATE_SNAPSHOT_FILE);
    let bytes =
        serde_json::to_vec_pretty(snapshot).context("serialize accepted FEM CPU state snapshot")?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .with_context(|| {
            format!(
                "create accepted FEM CPU state snapshot `{}`",
                path.display()
            )
        })?;
    file.write_all(&bytes)
        .with_context(|| format!("write accepted FEM CPU state snapshot `{}`", path.display()))?;
    file.sync_all()
        .with_context(|| format!("sync accepted FEM CPU state snapshot `{}`", path.display()))?;
    drop(file);
    #[cfg(unix)]
    fs::File::open(&solver_dir)
        .context("open accepted FEM CPU solver receipt directory")?
        .sync_all()
        .context("sync accepted FEM CPU solver receipt directory")?;
    Ok(())
}
