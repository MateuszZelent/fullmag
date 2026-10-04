use anyhow::{bail, Context, Result};
use fullmag_application::DecodedStudyArtifact;
use fullmag_authoring::{
    StudyAcceptancePolicy, StudyInputPort, StudyInputSource, StudyOutputPort, StudyPortDataKind,
};
use fullmag_ir::ExecutionPlanIR;
use fullmag_runner::{
    AcceptedStateGeneration, AcceptedStateId, AcceptedStateRef, FdmCpuAcceptedStateSnapshotV1,
    FdmGpuAcceptedStateSnapshotV1, RunResult, RunStatus, StepAction,
    FDM_CPU_ACCEPTED_STATE_SNAPSHOT_FILE, FDM_GPU_ACCEPTED_STATE_SNAPSHOT_FILE,
};
use fullmag_runtime_control::{AcceptedWorkerStep, ObservationSourcePayload, StudyOutputPayload};
use fullmag_session::SessionStore;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const RUNNER_INITIAL_STATE_FILE: &str = "m_initial.json";
const RUNNER_FINAL_STATE_FILE: &str = "m_final.json";
const WORKER_EXECUTION_STARTED_RECEIPT: &str = "worker_execution_started.v1.json";
const WORKER_PRELAUNCH_FAILED_RECEIPT: &str = "worker_prelaunch_failed.v1.json";
const WORKER_EXECUTION_COMPLETED_RECEIPT: &str = "worker_execution_completed.v1.json";
const WORKER_EXECUTION_RECEIPT_SCHEMA: &str = "fullmag.accepted_worker_execution.v1";

pub(crate) struct AcceptedRunnerExecution {
    pub(crate) status: RunStatus,
    pub(crate) completed_step_count: usize,
    pub(crate) outputs: Vec<StudyOutputPayload>,
    pub(crate) attempt_output_dir: PathBuf,
    pub(crate) recovered_from_receipt: bool,
    pub(crate) accepted_state_ref: Option<AcceptedStateRef>,
    pub(crate) observation_source: Option<ObservationSourcePayload>,
}

pub(crate) enum AcceptedWorkerProcessOutcome {
    Completed(AcceptedWorkerProcessResult),
    Stopped { acknowledged_heartbeat_count: usize },
}

struct WorkerControlLoop {
    interrupt_requested: Arc<AtomicBool>,
    execution_finished: Arc<AtomicBool>,
    handle: JoinHandle<Result<WorkerControlLoopResult>>,
}

struct WorkerControlLoopResult {
    stop_received: bool,
    acknowledged_heartbeat_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct WorkerExecutionReceiptIdentity {
    schema_version: String,
    claim: fullmag_application::TaskClaim,
    start_message_id: String,
    start_sequence: u64,
    case_id: String,
    plan_fingerprint: String,
}

impl WorkerExecutionReceiptIdentity {
    fn matches_same_attempt(&self, current: &Self) -> bool {
        self.schema_version == current.schema_version
            && self.claim.is_same_or_renewed_by(&current.claim)
            && self.start_message_id == current.start_message_id
            && self.start_sequence == current.start_sequence
            && self.case_id == current.case_id
            && self.plan_fingerprint == current.plan_fingerprint
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerExecutionStartedReceipt {
    identity: WorkerExecutionReceiptIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerPrelaunchFailedReceipt {
    identity: WorkerExecutionReceiptIdentity,
    error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerExecutionOutputReference {
    port_id: String,
    case_id: String,
    data_kind: String,
    codec_id: String,
    codec_version: String,
    object_ref: String,
    byte_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerObservationSourceReference {
    accepted_state_ref: AcceptedStateRef,
    snapshot_object_ref: String,
    snapshot_byte_count: u64,
    state_object_ref: String,
    state_byte_count: u64,
    grid_cells: [u32; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerExecutionCompletedReceipt {
    schema_version: String,
    identity: WorkerExecutionReceiptIdentity,
    status: RunStatus,
    completed_step_count: usize,
    outputs: Vec<WorkerExecutionOutputReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    accepted_state_ref: Option<AcceptedStateRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    observation_source: Option<WorkerObservationSourceReference>,
}

/// Reserve one private runner output directory for the exact active task
/// attempt. The leaf is exclusive; workers must also pass the durable inbox
/// before invoking the solver, and must reconcile rather than replay a pending
/// command after restart.
pub(crate) fn create_private_attempt_output_dir(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
) -> Result<PathBuf> {
    for (value, label) in [
        (claim.run_id.as_str(), "run_id"),
        (claim.task_id.as_str(), "task_id"),
        (claim.attempt_id.as_str(), "attempt_id"),
    ] {
        fullmag_session::repository_path::validate_store_id(value)
            .with_context(|| format!("worker attempt {label} is invalid"))?;
    }

    let _writer = store
        .write_transaction()
        .context("lock session store before reserving worker attempt output")?;
    let current_claim = fullmag_runtime_control::load_current_task_claim(
        store,
        &claim.run_id,
        claim.task_id.as_str(),
    )
    .context("worker attempt output requires a current durable claim")?;
    if !claim.is_same_or_renewed_by(&current_claim) {
        bail!("worker attempt output claim is stale");
    }

    let root = store.root();
    let runs_root = require_real_directory(&root.join("runs"))?;
    let run_root = require_real_directory(&runs_root.join(claim.run_id.as_str()))?;
    let worker_root = ensure_real_child_directory(&run_root, "worker-attempts")?;
    let task_root = ensure_real_child_directory(&worker_root, claim.task_id.as_str())?;
    let attempt_root = ensure_real_child_directory(&task_root, claim.attempt_id.as_str())?;
    let epoch_dir = attempt_root.join(format!("epoch-{}", claim.ownership_epoch.value()));
    match fs::create_dir(&epoch_dir) {
        Ok(()) => Ok(epoch_dir),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            bail!("worker attempt output directory already exists; reconcile before replay")
        }
        Err(error) => Err(error).with_context(|| {
            format!(
                "create private worker attempt output directory `{}`",
                epoch_dir.display()
            )
        }),
    }
}

fn require_real_directory(path: &Path) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("inspect worker output parent `{}`", path.display()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!(
            "worker output parent `{}` must be a real directory",
            path.display()
        );
    }
    Ok(path.to_path_buf())
}

fn ensure_real_child_directory(parent: &Path, name: &str) -> Result<PathBuf> {
    fullmag_session::repository_path::validate_store_id(name)
        .context("worker output path component is invalid")?;
    let path = parent.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                bail!(
                    "worker output path `{}` must be a real directory",
                    path.display()
                );
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&path)
                .with_context(|| format!("create worker output directory `{}`", path.display()))?;
            let metadata = fs::symlink_metadata(&path).with_context(|| {
                format!("reinspect worker output directory `{}`", path.display())
            })?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                bail!(
                    "worker output path `{}` must be a real directory",
                    path.display()
                );
            }
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("inspect worker output directory `{}`", path.display()));
        }
    }
    Ok(path)
}

fn existing_private_attempt_output_dir(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
) -> Result<PathBuf> {
    for (value, label) in [
        (claim.run_id.as_str(), "run_id"),
        (claim.task_id.as_str(), "task_id"),
        (claim.attempt_id.as_str(), "attempt_id"),
    ] {
        fullmag_session::repository_path::validate_store_id(value)
            .with_context(|| format!("worker attempt {label} is invalid"))?;
    }
    let root = store.root();
    let runs_root = require_real_directory(&root.join("runs"))?;
    let run_root = require_real_directory(&runs_root.join(claim.run_id.as_str()))?;
    let worker_root = require_real_directory(&run_root.join("worker-attempts"))?;
    let task_root = require_real_directory(&worker_root.join(claim.task_id.as_str()))?;
    let attempt_root = require_real_directory(&task_root.join(claim.attempt_id.as_str()))?;
    require_real_directory(&attempt_root.join(format!("epoch-{}", claim.ownership_epoch.value())))
}

fn write_immutable_attempt_receipt<T: Serialize>(
    attempt_output_dir: &Path,
    file_name: &str,
    receipt: &T,
) -> Result<()> {
    let path = attempt_output_dir.join(file_name);
    let bytes = serde_json::to_vec_pretty(receipt).context("serialize worker execution receipt")?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .with_context(|| format!("create immutable worker receipt `{}`", path.display()))?;
    file.write_all(&bytes)
        .with_context(|| format!("write worker receipt `{}`", path.display()))?;
    file.sync_all()
        .with_context(|| format!("sync worker receipt `{}`", path.display()))?;
    drop(file);
    #[cfg(unix)]
    std::fs::File::open(attempt_output_dir)?.sync_all()?;
    Ok(())
}

fn read_attempt_receipt<T: serde::de::DeserializeOwned>(
    attempt_output_dir: &Path,
    file_name: &str,
) -> Result<Option<T>> {
    let path = attempt_output_dir.join(file_name);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("inspect `{}`", path.display())),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("worker receipt `{}` must be a regular file", path.display());
    }
    let bytes = fs::read(&path).with_context(|| format!("read `{}`", path.display()))?;
    let receipt = serde_json::from_slice(&bytes)
        .with_context(|| format!("parse worker receipt `{}`", path.display()))?;
    Ok(Some(receipt))
}

fn worker_execution_receipt_identity(
    start: &fullmag_application::WorkerCommandEnvelope,
    accepted_step: &AcceptedWorkerStep,
    case_id: &str,
) -> Result<WorkerExecutionReceiptIdentity> {
    let plan_fingerprint = fullmag_session::canonical_json_sha256(
        &serde_json::to_value(&accepted_step.execution_plan)
            .context("serialize accepted worker execution plan for receipt")?,
    );
    Ok(WorkerExecutionReceiptIdentity {
        schema_version: WORKER_EXECUTION_RECEIPT_SCHEMA.into(),
        claim: accepted_step.claim.clone(),
        start_message_id: start.message_id.clone(),
        start_sequence: start.sequence,
        case_id: case_id.to_owned(),
        plan_fingerprint,
    })
}

fn accepted_state_ref_from_runner_snapshot(
    attempt_output_dir: &Path,
    accepted_step: &AcceptedWorkerStep,
    required_for_supported_lane: bool,
) -> Result<Option<AcceptedStateRef>> {
    let fullmag_ir::BackendPlanIR::Fdm(fdm_plan) = &accepted_step.execution_plan.backend_plan
    else {
        return Ok(None);
    };
    if !fdm_plan.spin_transport_plans.is_empty() || fdm_plan.frozen_spins.is_some() {
        return Ok(None);
    }

    let requested_device = accepted_step
        .resolved_input
        .requested_execution
        .device
        .as_str();
    if requested_device == "gpu"
        && (!fdm_plan.fdm_gpu_charge_transports.is_empty()
            || fdm_plan.temperature.unwrap_or(0.0) > 0.0
            || fdm_plan.thermal_seed_config.is_some())
    {
        return Ok(None);
    }
    let snapshot_file = match requested_device {
        "cpu" => FDM_CPU_ACCEPTED_STATE_SNAPSHOT_FILE,
        "gpu" => FDM_GPU_ACCEPTED_STATE_SNAPSHOT_FILE,
        _ => return Ok(None),
    };
    let snapshot_path = attempt_output_dir.join(snapshot_file);
    match fs::symlink_metadata(&snapshot_path) {
        Ok(_) => {}
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound && !required_for_supported_lane =>
        {
            return Ok(None);
        }
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "inspect accepted state snapshot `{}`",
                    snapshot_path.display()
                )
            });
        }
    }
    let bytes = read_explicit_runner_artifact(attempt_output_dir, snapshot_file, 64 * 1024)
        .with_context(|| format!("read accepted FDM {requested_device} state snapshot"))?;
    let (clock, clock_digest, state_digest) = match requested_device {
        "cpu" => {
            let snapshot: FdmCpuAcceptedStateSnapshotV1 =
                serde_json::from_slice(&bytes).context("decode accepted FDM CPU state snapshot")?;
            snapshot
                .validate()
                .map_err(|error| anyhow::anyhow!(error.to_string()))
                .context("validate accepted FDM CPU state snapshot")?;
            (snapshot.clock, snapshot.clock_digest, snapshot.state_digest)
        }
        "gpu" => {
            let snapshot: FdmGpuAcceptedStateSnapshotV1 =
                serde_json::from_slice(&bytes).context("decode accepted FDM GPU state snapshot")?;
            snapshot
                .validate()
                .map_err(|error| anyhow::anyhow!(error.to_string()))
                .context("validate accepted FDM GPU state snapshot")?;
            (snapshot.clock, snapshot.clock_digest, snapshot.state_digest)
        }
        _ => unreachable!("requested device was matched above"),
    };

    let plan_digest = format!(
        "sha256:{}",
        fullmag_session::canonical_json_sha256(&serde_json::json!({
            "schema_version": "fullmag.accepted-state-plan.v1",
            "problem": &accepted_step.problem,
            "execution_plan": &accepted_step.execution_plan,
            "requested_execution": &accepted_step.resolved_input.requested_execution,
        }))
    );
    let reference = AcceptedStateRef {
        id: AcceptedStateId {
            run_id: accepted_step.claim.run_id.as_str().to_string(),
            stage_id: Some(accepted_step.step_id.clone()),
            accepted_step: clock.accepted_step,
            clock_digest,
            state_digest,
            domain_digest: accepted_step
                .resolved_input
                .preparation
                .plan_fingerprint
                .clone(),
            plan_digest,
        },
        generation: AcceptedStateGeneration {
            runtime_epoch: accepted_step.claim.ownership_epoch.value(),
            accepted_revision: clock.accepted_step,
        },
    };
    reference
        .validate()
        .map_err(|error| anyhow::anyhow!(error.to_string()))
        .with_context(|| format!("validate accepted FDM {requested_device} state reference"))?;
    Ok(Some(reference))
}

fn collect_fdm_cpu_observation_source(
    attempt_output_dir: &Path,
    accepted_step: &AcceptedWorkerStep,
    accepted_state_ref: Option<&AcceptedStateRef>,
    max_output_bytes: u64,
) -> Result<Option<ObservationSourcePayload>> {
    let Some(grid_cells) = fdm_cpu_observation_grid(accepted_step) else {
        return Ok(None);
    };
    let accepted_state_ref = accepted_state_ref
        .cloned()
        .context("supported FDM CPU observation source has no accepted state reference")?;
    let snapshot_bytes = read_explicit_runner_artifact(
        attempt_output_dir,
        FDM_CPU_ACCEPTED_STATE_SNAPSHOT_FILE,
        max_output_bytes,
    )
    .context("read FDM CPU observation accepted-state snapshot")?;
    let state_bytes = read_explicit_runner_artifact(
        attempt_output_dir,
        RUNNER_FINAL_STATE_FILE,
        max_output_bytes,
    )
    .context("read FDM CPU observation terminal state")?;
    let payload = ObservationSourcePayload {
        accepted_state_ref,
        snapshot_bytes,
        state_bytes,
        grid_cells,
    };
    payload
        .validate()
        .context("validate FDM CPU observation source before worker receipt")?;
    let snapshot: FdmCpuAcceptedStateSnapshotV1 =
        serde_json::from_slice(&payload.snapshot_bytes)
            .context("decode FDM CPU observation snapshot for adapter proof")?;
    let state = fullmag_application::decode_study_artifact_bytes(
        "state",
        fullmag_application::STUDY_MAGNETIZATION_CODEC_ID,
        fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION,
        &payload.state_bytes,
    )
    .context("decode FDM CPU observation terminal state for adapter proof")?;
    let DecodedStudyArtifact::MagnetizationState(state) = state else {
        bail!("FDM CPU observation state codec did not produce magnetization");
    };
    fullmag_runner::ObservationRuntime::from_fdm_cpu_accepted_state(
        payload.accepted_state_ref.id.clone(),
        snapshot,
        payload.grid_cells,
        state.values,
    )
    .map_err(|error| anyhow::anyhow!(error.to_string()))
    .context("materialize isolated FDM CPU ObservationRuntime before publication")?;
    Ok(Some(payload))
}

fn fdm_cpu_observation_grid(accepted_step: &AcceptedWorkerStep) -> Option<[u32; 3]> {
    let fullmag_ir::BackendPlanIR::Fdm(fdm_plan) = &accepted_step.execution_plan.backend_plan
    else {
        return None;
    };
    (accepted_step.resolved_input.requested_execution.device == "cpu"
        && fdm_plan.spin_transport_plans.is_empty()
        && fdm_plan.frozen_spins.is_none())
    .then_some(fdm_plan.grid.cells)
}

fn expected_output_binding(
    port: &StudyOutputPort,
) -> Result<(&'static str, &'static str, &'static str)> {
    match port.data_kind {
        StudyPortDataKind::InitialState => Ok((
            "initial_state",
            fullmag_application::STUDY_MAGNETIZATION_CODEC_ID,
            fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION,
        )),
        StudyPortDataKind::State => Ok((
            "state",
            fullmag_application::STUDY_MAGNETIZATION_CODEC_ID,
            fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION,
        )),
        StudyPortDataKind::Scalar if port.port_id == "total_energy" => Ok((
            "scalar",
            fullmag_application::STUDY_SCALAR_CODEC_ID,
            fullmag_application::STUDY_SCALAR_CODEC_VERSION,
        )),
        unsupported => bail!(
            "accepted worker receipt has no output binding for `{unsupported:?}` port `{}`",
            port.port_id
        ),
    }
}

fn persist_completed_worker_execution(
    store: &SessionStore,
    attempt_output_dir: &Path,
    identity: &WorkerExecutionReceiptIdentity,
    declared_outputs: &[StudyOutputPort],
    status: RunStatus,
    completed_step_count: usize,
    outputs: &[StudyOutputPayload],
    accepted_state_ref: Option<&AcceptedStateRef>,
    observation_source: Option<&ObservationSourcePayload>,
) -> Result<()> {
    let mut declared = BTreeMap::new();
    for port in declared_outputs {
        if declared.insert(port.port_id.as_str(), port).is_some() {
            bail!(
                "accepted worker declares duplicate output port `{}`",
                port.port_id
            );
        }
    }
    let mut output_refs = Vec::with_capacity(outputs.len());
    let mut seen = BTreeSet::new();
    let mut unique_object_sizes = BTreeMap::new();
    for output in outputs {
        let object_ref = fullmag_application::study_artifact_content_sha256(&output.bytes);
        unique_object_sizes.entry(object_ref).or_insert(
            u64::try_from(output.bytes.len())
                .context("accepted worker output byte count overflowed")?,
        );
    }
    if let Some(source) = observation_source {
        source.validate()?;
        if accepted_state_ref != Some(&source.accepted_state_ref) {
            bail!("worker observation source differs from accepted state reference");
        }
        for bytes in [&source.snapshot_bytes, &source.state_bytes] {
            let object_ref = fullmag_application::study_artifact_content_sha256(bytes);
            unique_object_sizes.entry(object_ref).or_insert(
                u64::try_from(bytes.len())
                    .context("accepted worker observation byte count overflowed")?,
            );
        }
    }
    let unique_byte_count = unique_object_sizes
        .values()
        .try_fold(0_u64, |total, size| total.checked_add(*size))
        .context("accepted worker persisted byte count overflowed")?;
    if unique_byte_count > identity.claim.lease.budget.storage_bytes {
        bail!("accepted worker persisted artifacts exceed the attempt storage budget");
    }
    for output in outputs {
        if !seen.insert(output.port_id.as_str()) {
            bail!(
                "accepted worker output port `{}` is duplicated",
                output.port_id
            );
        }
        let port = declared.get(output.port_id.as_str()).with_context(|| {
            format!("accepted worker output `{}` is undeclared", output.port_id)
        })?;
        let (data_kind, codec_id, codec_version) = expected_output_binding(port)?;
        if output.case_id != identity.case_id
            || output.codec_id != codec_id
            || output.codec_version != codec_version
        {
            bail!("accepted worker output codec version is not registered");
        }
        let object_ref = retry_store_writer_busy(|| store.cas().put(&output.bytes))?;
        output_refs.push(WorkerExecutionOutputReference {
            port_id: output.port_id.clone(),
            case_id: output.case_id.clone(),
            data_kind: data_kind.into(),
            codec_id: codec_id.into(),
            codec_version: codec_version.into(),
            object_ref,
            byte_count: u64::try_from(output.bytes.len())
                .context("accepted worker output byte count overflowed")?,
        });
    }
    if seen.len() != declared.len() {
        bail!("accepted worker execution produced an incomplete output set");
    }
    let observation_source = observation_source
        .map(|source| -> Result<WorkerObservationSourceReference> {
            let snapshot_object_ref =
                retry_store_writer_busy(|| store.cas().put(&source.snapshot_bytes))?;
            let state_object_ref =
                retry_store_writer_busy(|| store.cas().put(&source.state_bytes))?;
            Ok(WorkerObservationSourceReference {
                accepted_state_ref: source.accepted_state_ref.clone(),
                snapshot_object_ref,
                snapshot_byte_count: u64::try_from(source.snapshot_bytes.len())
                    .context("observation snapshot byte count overflowed")?,
                state_object_ref,
                state_byte_count: u64::try_from(source.state_bytes.len())
                    .context("observation state byte count overflowed")?,
                grid_cells: source.grid_cells,
            })
        })
        .transpose()?;
    let receipt = WorkerExecutionCompletedReceipt {
        schema_version: WORKER_EXECUTION_RECEIPT_SCHEMA.into(),
        identity: identity.clone(),
        status,
        completed_step_count,
        outputs: output_refs,
        accepted_state_ref: accepted_state_ref.cloned(),
        observation_source,
    };
    write_immutable_attempt_receipt(
        attempt_output_dir,
        WORKER_EXECUTION_COMPLETED_RECEIPT,
        &receipt,
    )
}

fn recover_completed_worker_execution(
    store: &SessionStore,
    attempt_output_dir: &Path,
    expected_identity: &WorkerExecutionReceiptIdentity,
    declared_outputs: &[StudyOutputPort],
    max_output_bytes: u64,
    expected_accepted_state_ref: Option<&AcceptedStateRef>,
    expected_observation_grid: Option<[u32; 3]>,
) -> Result<AcceptedRunnerExecution> {
    let started: WorkerExecutionStartedReceipt =
        read_attempt_receipt(attempt_output_dir, WORKER_EXECUTION_STARTED_RECEIPT)?
            .context("existing attempt has no durable started receipt; refusing to rerun")?;
    if !started.identity.matches_same_attempt(expected_identity) {
        bail!("existing worker start receipt belongs to another command or claim");
    }
    let completed: WorkerExecutionCompletedReceipt =
        read_attempt_receipt(attempt_output_dir, WORKER_EXECUTION_COMPLETED_RECEIPT)?.context(
            "worker outcome is unknown because no completed receipt exists; refusing to rerun",
        )?;
    if completed.schema_version != WORKER_EXECUTION_RECEIPT_SCHEMA
        || !completed.identity.matches_same_attempt(expected_identity)
        || completed.status != RunStatus::Completed
        || completed.completed_step_count == 0
        || completed.accepted_state_ref.as_ref() != expected_accepted_state_ref
    {
        bail!("completed worker receipt is invalid for the current accepted Start");
    }

    let mut declared = BTreeMap::new();
    for port in declared_outputs {
        if declared.insert(port.port_id.as_str(), port).is_some() {
            bail!(
                "accepted worker declares duplicate output port `{}`",
                port.port_id
            );
        }
    }
    if completed.outputs.len() != declared.len() {
        bail!("completed worker receipt has an incomplete output set");
    }
    let mut seen = BTreeSet::new();
    let mut unique_object_sizes = BTreeMap::new();
    let mut outputs = Vec::with_capacity(completed.outputs.len());
    for output in &completed.outputs {
        if !seen.insert(output.port_id.as_str()) {
            bail!(
                "completed worker receipt duplicates output `{}`",
                output.port_id
            );
        }
        let port = declared.get(output.port_id.as_str()).with_context(|| {
            format!("completed worker output `{}` is undeclared", output.port_id)
        })?;
        let (data_kind, codec_id, codec_version) = expected_output_binding(port)?;
        if output.case_id != expected_identity.case_id
            || output.data_kind != data_kind
            || output.codec_id != codec_id
            || output.codec_version != codec_version
        {
            bail!(
                "completed worker output `{}` differs from its accepted port",
                output.port_id
            );
        }
        let bytes = store.cas().get(&output.object_ref)?.with_context(|| {
            format!(
                "completed worker CAS output `{}` is missing",
                output.port_id
            )
        })?;
        if u64::try_from(bytes.len()).context("recovered output size overflowed")?
            != output.byte_count
        {
            bail!(
                "completed worker output `{}` has a mismatched byte count",
                output.port_id
            );
        }
        fullmag_application::decode_study_artifact_bytes(
            data_kind,
            codec_id,
            codec_version,
            &bytes,
        )
        .with_context(|| format!("validate recovered worker output `{}`", output.port_id))?;
        outputs.push(StudyOutputPayload {
            port_id: output.port_id.clone(),
            case_id: output.case_id.clone(),
            codec_id: output.codec_id.clone(),
            codec_version: output.codec_version.clone(),
            bytes,
        });
        unique_object_sizes
            .entry(output.object_ref.clone())
            .or_insert(output.byte_count);
    }
    if seen.len() != declared.len() {
        bail!("completed worker receipt omits an accepted output port");
    }
    let observation_source = match (&completed.observation_source, expected_observation_grid) {
        (Some(source), Some(grid_cells)) => {
            if Some(&source.accepted_state_ref) != expected_accepted_state_ref
                || source.grid_cells != grid_cells
            {
                bail!("completed worker observation source differs from the accepted attempt");
            }
            let snapshot_bytes = store
                .cas()
                .get(&source.snapshot_object_ref)?
                .context("completed worker observation snapshot is missing from CAS")?;
            let state_bytes = store
                .cas()
                .get(&source.state_object_ref)?
                .context("completed worker observation state is missing from CAS")?;
            if u64::try_from(snapshot_bytes.len())? != source.snapshot_byte_count
                || u64::try_from(state_bytes.len())? != source.state_byte_count
            {
                bail!("completed worker observation source has a mismatched byte count");
            }
            unique_object_sizes
                .entry(source.snapshot_object_ref.clone())
                .or_insert(source.snapshot_byte_count);
            unique_object_sizes
                .entry(source.state_object_ref.clone())
                .or_insert(source.state_byte_count);
            let payload = ObservationSourcePayload {
                accepted_state_ref: source.accepted_state_ref.clone(),
                snapshot_bytes,
                state_bytes,
                grid_cells,
            };
            payload
                .validate()
                .context("validate recovered worker observation source")?;
            Some(payload)
        }
        (None, None) => None,
        _ => bail!("completed worker receipt has an invalid observation source presence"),
    };
    let unique_byte_count = unique_object_sizes
        .values()
        .try_fold(0_u64, |total, size| total.checked_add(*size))
        .context("recovered worker persisted byte count overflowed")?;
    if unique_byte_count > max_output_bytes {
        bail!("recovered worker artifacts exceed the attempt storage budget");
    }
    Ok(AcceptedRunnerExecution {
        status: completed.status,
        completed_step_count: completed.completed_step_count,
        outputs,
        attempt_output_dir: attempt_output_dir.to_path_buf(),
        recovered_from_receipt: true,
        accepted_state_ref: completed.accepted_state_ref,
        observation_source,
    })
}

/// Read immutable accepted inputs from CAS and apply the supported same-space
/// magnetization state to a copy of the accepted plan. Unsupported required
/// inputs fail closed; the worker must not run with regenerated defaults.
pub(crate) fn materialize_resolved_study_inputs(
    store: &SessionStore,
    accepted_step: &AcceptedWorkerStep,
) -> Result<ExecutionPlanIR> {
    let resolved_input = &accepted_step.resolved_input;
    resolved_input
        .validate()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if resolved_input.run_id != accepted_step.claim.run_id
        || resolved_input.task_id != accepted_step.claim.task_id
        || resolved_input.attempt_id != accepted_step.claim.attempt_id
        || resolved_input.ownership_epoch != accepted_step.claim.ownership_epoch
    {
        bail!("accepted worker inputs differ from the current task claim");
    }
    let plan_fingerprint = fullmag_session::canonical_json_sha256(
        &serde_json::to_value(&accepted_step.execution_plan)
            .context("serialize accepted worker execution plan")?,
    );
    if resolved_input.plan_fingerprint != plan_fingerprint {
        bail!("accepted worker inputs differ from the pinned execution plan");
    }

    let mut declared = BTreeMap::<&str, &StudyInputPort>::new();
    for port in &accepted_step.study_inputs {
        fullmag_session::repository_path::validate_store_id(&port.port_id)
            .with_context(|| format!("accepted study input port `{}` is invalid", port.port_id))?;
        if declared.insert(port.port_id.as_str(), port).is_some() {
            bail!("accepted study input port `{}` is duplicated", port.port_id);
        }
    }
    for port in &accepted_step.study_inputs {
        // Authored initial conditions are already part of the immutable
        // ProblemIR and canonical plan reconstructed by the accepted loader.
        if port.required
            && !resolved_input.inputs.contains_key(&port.port_id)
            && !matches!(&port.source, StudyInputSource::AuthoredInitialState { .. })
        {
            bail!(
                "required accepted study input `{}` has no resolved artifact",
                port.port_id
            );
        }
    }

    let mut execution_plan = accepted_step.execution_plan.clone();
    let mut materialized_state = false;
    for (port_id, input) in &resolved_input.inputs {
        let port = declared.get(port_id.as_str()).with_context(|| {
            format!("resolved input `{port_id}` is not declared by the accepted study")
        })?;
        input
            .validate()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let artifact = input.study_artifact.as_ref().with_context(|| {
            format!("resolved study input `{port_id}` has no typed CAS artifact binding")
        })?;
        let expected_data_kind = match port.data_kind {
            StudyPortDataKind::InitialState => "initial_state",
            StudyPortDataKind::State => "state",
            unsupported => bail!(
                "accepted worker has no solver input binding for `{unsupported:?}` port `{port_id}`"
            ),
        };
        if artifact.data_kind != expected_data_kind {
            bail!(
                "accepted study input `{port_id}` expects `{expected_data_kind}` but its artifact is `{}`",
                artifact.data_kind
            );
        }
        if let StudyInputSource::PinnedArtifact {
            artifact_id,
            content_sha256,
        } = &port.source
        {
            if artifact.artifact_id != *artifact_id || artifact.object_ref != *content_sha256 {
                bail!("pinned artifact input `{port_id}` differs from its accepted identity");
            }
        }
        if materialized_state {
            bail!("accepted worker cannot bind multiple magnetization inputs to one initial state");
        }
        let bytes = store
            .cas()
            .get(&artifact.object_ref)?
            .with_context(|| format!("accepted input `{port_id}` CAS object is missing"))?;
        let decoded = fullmag_application::decode_study_artifact(artifact, &bytes)
            .map_err(|error| anyhow::anyhow!(error.to_string()))
            .with_context(|| format!("decode accepted study input `{port_id}`"))?;
        let DecodedStudyArtifact::MagnetizationState(state) = decoded else {
            bail!("accepted state input `{port_id}` decoded to a non-state artifact");
        };
        execution_plan = fullmag_runner::materialize_study_magnetization_input(
            &execution_plan,
            &state.layout,
            &state.values,
        )
        .with_context(|| {
            format!("materialize accepted state input `{port_id}` into runner plan")
        })?;
        materialized_state = true;
    }

    Ok(execution_plan)
}

/// Execute the explicitly supported accepted-study lane after a durable Start
/// has entered the worker inbox. This is a narrow adapter: unsupported request
/// semantics, acceptance rules, or device overrides fail closed until they
/// have dedicated bindings and qualification.
pub(crate) fn execute_accepted_worker_start(
    store: &SessionStore,
    project_id: &fullmag_application::ProjectId,
    start: &fullmag_application::WorkerCommandEnvelope,
    accepted_step: &AcceptedWorkerStep,
    case_id: &str,
    interrupt_requested: Option<&AtomicBool>,
) -> Result<AcceptedRunnerExecution> {
    if !matches!(&start.command, fullmag_application::WorkerCommand::Start) {
        bail!("accepted runner execution requires a durable Start command");
    }
    fullmag_session::repository_path::validate_store_id(case_id)
        .context("accepted worker case id is invalid")?;
    if !start.claim.matches_claim(&accepted_step.claim) {
        bail!("accepted Start does not match the worker task claim");
    }
    let inbox_checkpoint = retry_store_writer_busy(|| {
        fullmag_runtime_control::recover_worker_inbox(store, &accepted_step.claim)
    })
    .context("load durable worker inbox before accepted Start execution")?
    .checkpoint();
    let start_is_pending = inbox_checkpoint.pending.as_ref() == Some(start);
    let start_is_applied = inbox_checkpoint
        .applied
        .iter()
        .any(|command| command == start);
    if (!start_is_pending && !start_is_applied)
        || inbox_checkpoint
            .applied
            .iter()
            .filter(|command| {
                matches!(
                    &command.command,
                    fullmag_application::WorkerCommand::Prepare { .. }
                )
            })
            .count()
            != 1
    {
        bail!("accepted Start is not the durable command after one applied Prepare");
    }
    let current_claim = retry_store_writer_busy(|| {
        fullmag_runtime_control::load_current_task_claim(
            store,
            &accepted_step.claim.run_id,
            accepted_step.claim.task_id.as_str(),
        )
    })
    .context("accepted Start no longer owns the current task claim")?;
    if !accepted_step.claim.is_same_or_renewed_by(&current_claim) {
        bail!("accepted Start worker context has a stale task claim");
    }

    let accepted = retry_store_writer_busy(|| {
        fullmag_runtime_control::load_accepted_study_snapshot(
            store,
            &accepted_step.claim.run_id,
            project_id,
        )
    })
    .context("load immutable accepted study for worker execution")?;
    let study_step = accepted
        .study
        .steps
        .iter()
        .find(|step| step.step_id == accepted_step.step_id)
        .context("accepted worker step is missing from its immutable StudyPlan")?;
    if !matches!(&study_step.acceptance, StudyAcceptancePolicy::Any) {
        bail!("accepted worker has no evaluator for this scientific acceptance policy");
    }
    let mut output_ports = BTreeSet::new();
    for port in &study_step.outputs {
        fullmag_session::repository_path::validate_store_id(&port.port_id)
            .with_context(|| format!("accepted output port `{}` is invalid", port.port_id))?;
        if !output_ports.insert(port.port_id.as_str()) {
            bail!(
                "accepted study declares duplicate output port `{}`",
                port.port_id
            );
        }
        expected_output_binding(port)?;
    }

    let specification = &accepted.run.specification;
    let immutable_problem = accepted.catalog.entries().iter()
        .find(|entry| entry.step_id() == accepted_step.step_id)
        .context("accepted worker step has no immutable catalog entry")?
        .problem();
    accepted_step.resolved_input
        .validate_execution_for_problem(specification, immutable_problem)
        .context("validate accepted task execution before dispatch")?;
    let request = &accepted_step.resolved_input.requested_execution;
    if request.backend == "fem" {
        crate::accepted_fem_study_worker::validate_declared_outputs(&study_step.outputs)
            .context("validate accepted FEM output contract before recovery or reservation")?;
        return execute_accepted_fem_worker_start(
            store,
            &accepted,
            start,
            accepted_step,
            study_step,
            case_id,
            interrupt_requested,
        );
    }
    if request.backend != "fdm"
        || !matches!(request.device.as_str(), "cpu" | "gpu")
        || request.precision != "double"
        || request.mode != "strict"
    {
        bail!("accepted worker currently supports only FDM CPU/GPU double strict");
    }
    if !specification
        .parameters
        .as_object()
        .is_some_and(|values| values.is_empty())
        || !specification.seeds.is_empty()
        || !accepted_step.problem.problem_meta.seeds.is_empty()
    {
        bail!("accepted worker has no binding for RunSpec parameters or seeds");
    }
    let lease_matches_request = matches!(
        (
            request.device.as_str(),
            &accepted_step.claim.lease.kind,
            accepted_step.claim.lease.budget.gpu_memory_bytes,
        ),
        ("cpu", fullmag_application::ResourceKind::Cpu, 0)
            | ("gpu", fullmag_application::ResourceKind::Gpu, 1..)
    );
    if !lease_matches_request {
        bail!(
            "accepted FDM {} execution requires a matching {} resource lease and VRAM budget",
            request.device,
            request.device.to_uppercase()
        );
    }
    if accepted_step.problem.backend_policy.requested_backend != fullmag_ir::BackendTarget::Fdm
        || accepted_step.problem.backend_policy.execution_precision
            != fullmag_ir::ExecutionPrecision::Double
        || accepted_step.problem.validation_profile.execution_mode
            != fullmag_ir::ExecutionMode::Strict
        || accepted_step.execution_plan.common.requested_backend != fullmag_ir::BackendTarget::Fdm
        || accepted_step.execution_plan.common.resolved_backend != fullmag_ir::BackendTarget::Fdm
        || accepted_step.execution_plan.common.execution_mode != fullmag_ir::ExecutionMode::Strict
        || !matches!(
            &accepted_step.execution_plan.backend_plan,
            fullmag_ir::BackendPlanIR::Fdm(_)
        )
    {
        bail!("accepted worker execution plan is outside the FDM CPU/GPU double strict lanes");
    }
    if let Ok(value) = std::env::var("FULLMAG_FDM_EXECUTION") {
        let normalized = value.replace("cuda", "gpu");
        if normalized != request.device {
            bail!(
                "FULLMAG_FDM_EXECUTION overrides the accepted {} device request",
                request.device
            );
        }
    }

    let until_seconds = accepted_step
        .until_seconds
        .context("accepted worker step has no pinned runner horizon")?;
    if !until_seconds.is_finite() || until_seconds <= 0.0 {
        bail!("accepted worker runner horizon is invalid");
    }
    let execution_plan = materialize_resolved_study_inputs(store, accepted_step)
        .context("materialize accepted CAS inputs for the runner")?;
    let receipt_identity = worker_execution_receipt_identity(start, accepted_step, case_id)?;
    match existing_private_attempt_output_dir(store, &accepted_step.claim) {
        Ok(existing_path) => {
            return recover_accepted_fdm_worker_attempt(
                store,
                accepted_step,
                &receipt_identity,
                &study_step.outputs,
                existing_path,
            )
        }
        Err(error) if is_not_found_error(&error) => {}
        Err(error) => return Err(error).context("inspect existing accepted FDM attempt"),
    }
    // The verified task input is the accepted device/precision intent. Project
    // that request into the runner adapter while retaining other authored fields;
    // the environment guard above prevents a managed override from changing it.
    let mut problem = accepted_step.problem.clone();
    let selection = problem
        .problem_meta
        .runtime_metadata
        .entry("runtime_selection".into())
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .context("accepted runtime_selection must be an object")?;
    selection.insert("device".into(), serde_json::json!(request.device));
    selection.insert("precision".into(), serde_json::json!(request.precision));
    crate::accepted_project_storage::AcceptedProjectStorage::preflight(
        &problem,
        store,
        &accepted_step.claim,
        &accepted_step.step_id,
    )?;
    let attempt_output_dir = match retry_store_writer_busy(|| {
        create_private_attempt_output_dir(store, &accepted_step.claim)
    }) {
        Ok(path) => {
            write_immutable_attempt_receipt(
                &path,
                WORKER_EXECUTION_STARTED_RECEIPT,
                &WorkerExecutionStartedReceipt {
                    identity: receipt_identity.clone(),
                },
            )
            .context("persist worker start receipt before the solver side effect")?;
            path
        }
        Err(reservation_error) => {
            let Ok(existing_path) =
                existing_private_attempt_output_dir(store, &accepted_step.claim)
            else {
                return Err(reservation_error)
                    .context("reserve output directory for the accepted worker attempt");
            };
            return recover_accepted_fdm_worker_attempt(
                store,
                accepted_step,
                &receipt_identity,
                &study_step.outputs,
                existing_path,
            );
        }
    };

    // Reserve project storage only after the authoritative private attempt.
    // A rejected reservation has a durable no-solver outcome, never a bare STARTED.
    let mut storage = prepare_accepted_project_storage(
        &problem,
        store,
        accepted_step,
        &receipt_identity,
        &attempt_output_dir,
    )?;
    if let Some(storage) = &storage {
        problem.problem_meta.runtime_metadata.insert(
            "resolved_output_storage".into(),
            serde_json::to_value(storage.resolved())?,
        );
    }
    let storage_attempt_dir = attempt_output_dir.clone();
    let execution: Result<AcceptedRunnerExecution> = (|| {
        let display_selection = fullmag_runner::DisplaySelectionState::default;
        let result =
        fullmag_runner::run_planned_problem_with_live_preview_interruptible_with_initial_snapshot_and_fem_mesh_identity_and_autosave_root(
            &problem,
            &execution_plan,
            None,
            until_seconds,
            &attempt_output_dir,
            storage.as_ref().map(|value| value.data_root()).unwrap_or(&attempt_output_dir),
            u64::MAX,
            &display_selection,
            interrupt_requested,
            false,
            |_| StepAction::Continue,
        )
        .map_err(|error| anyhow::anyhow!(error.to_string()))
        .with_context(|| format!("execute accepted FDM {} runner plan", request.device))?;
        if result.status == RunStatus::Cancelled {
            return Ok(AcceptedRunnerExecution {
                status: result.status,
                completed_step_count: result.steps.len(),
                outputs: Vec::new(),
                attempt_output_dir,
                recovered_from_receipt: false,
                accepted_state_ref: None,
                observation_source: None,
            });
        }
        if result.status != RunStatus::Completed {
            bail!(
                "accepted FDM {} runner did not complete successfully",
                request.device
            );
        }
        let outputs = collect_runner_study_outputs(
            &study_step.outputs,
            case_id,
            &result,
            &attempt_output_dir,
            accepted_step.claim.lease.budget.storage_bytes,
        )
        .context("collect explicit typed outputs from the accepted runner attempt")?;
        let accepted_state_ref =
            accepted_state_ref_from_runner_snapshot(&attempt_output_dir, accepted_step, true)?;
        let observation_source = collect_fdm_cpu_observation_source(
            &attempt_output_dir,
            accepted_step,
            accepted_state_ref.as_ref(),
            accepted_step.claim.lease.budget.storage_bytes,
        )?;
        if let Some(storage) = &mut storage {
            storage.finish(true, &attempt_output_dir)?;
        }
        persist_completed_worker_execution(
            store,
            &attempt_output_dir,
            &receipt_identity,
            &study_step.outputs,
            result.status,
            result.steps.len(),
            &outputs,
            accepted_state_ref.as_ref(),
            observation_source.as_ref(),
        )
        .context("persist immutable completed worker output receipt")?;

        Ok(AcceptedRunnerExecution {
            status: result.status,
            completed_step_count: result.steps.len(),
            outputs,
            attempt_output_dir,
            recovered_from_receipt: false,
            accepted_state_ref,
            observation_source,
        })
    })();
    if let Some(storage) = &mut storage {
        let success = execution
            .as_ref()
            .is_ok_and(|result| result.status == RunStatus::Completed);
        storage.finish(success, &storage_attempt_dir)?;
    }
    execution
}

fn execute_accepted_fem_worker_start(
    store: &SessionStore,
    accepted: &fullmag_runtime_control::AcceptedStudySnapshot,
    start: &fullmag_application::WorkerCommandEnvelope,
    accepted_step: &AcceptedWorkerStep,
    study_step: &fullmag_authoring::StudyStep,
    case_id: &str,
    interrupt_requested: Option<&AtomicBool>,
) -> Result<AcceptedRunnerExecution> {
    let receipt_identity = worker_execution_receipt_identity(start, accepted_step, case_id)?;
    let existing_attempt = match existing_private_attempt_output_dir(store, &accepted_step.claim) {
        Ok(path) => Some(path),
        Err(error) if is_not_found_error(&error) => None,
        Err(error) => return Err(error).context("inspect existing accepted FEM worker attempt"),
    };
    if let Some(existing_path) = existing_attempt {
        return recover_accepted_fem_worker_attempt(
            store,
            accepted_step,
            &receipt_identity,
            &study_step.outputs,
            existing_path,
        )
        .context("recover completed accepted FEM worker attempt without rerunning solver");
    }

    let prepared = crate::accepted_fem_study_worker::prepare_accepted_fem_cpu_execution(
        store,
        accepted,
        accepted_step,
        study_step,
        case_id,
    )
    .context("prepare accepted FEM CPU execution before attempt reservation")?;
    crate::accepted_project_storage::AcceptedProjectStorage::preflight(
        &prepared.problem,
        store,
        &accepted_step.claim,
        &accepted_step.step_id,
    )?;
    let attempt_output_dir = match retry_store_writer_busy(|| {
        create_private_attempt_output_dir(store, &accepted_step.claim)
    }) {
        Ok(path) => {
            write_immutable_attempt_receipt(
                &path,
                WORKER_EXECUTION_STARTED_RECEIPT,
                &WorkerExecutionStartedReceipt {
                    identity: receipt_identity.clone(),
                },
            )
            .context("persist worker start receipt before the FEM solver side effect")?;
            path
        }
        Err(reservation_error) => {
            let existing_path =
                match existing_private_attempt_output_dir(store, &accepted_step.claim) {
                    Ok(path) => path,
                    Err(_error) => {
                        return Err(reservation_error).context(
                            "reserve output directory for the accepted FEM worker attempt",
                        )
                    }
                };
            return recover_accepted_fem_worker_attempt(
                store,
                accepted_step,
                &receipt_identity,
                &prepared.output_ports,
                existing_path,
            )
            .context("recover completed accepted FEM worker attempt without rerunning solver");
        }
    };

    let mut storage = prepare_accepted_project_storage(
        &prepared.problem,
        store,
        accepted_step,
        &receipt_identity,
        &attempt_output_dir,
    )?;
    let storage_attempt_dir = attempt_output_dir.clone();
    let execution: Result<AcceptedRunnerExecution> = (|| {
        let outcome = crate::accepted_fem_study_worker::execute_accepted_fem_cpu_attempt(
            accepted_step,
            &prepared,
            &attempt_output_dir,
            storage
                .as_ref()
                .map(|value| value.data_root())
                .unwrap_or(&attempt_output_dir),
            interrupt_requested,
        )
        .context("execute accepted FEM CPU worker attempt")?;
        match outcome {
            crate::accepted_fem_study_worker::AcceptedFemCpuExecutionOutcome::Cancelled {
                completed_step_count,
                attempt_output_dir,
            } => Ok(AcceptedRunnerExecution {
                status: RunStatus::Cancelled,
                completed_step_count,
                outputs: Vec::new(),
                attempt_output_dir,
                recovered_from_receipt: false,
                accepted_state_ref: None,
                observation_source: None,
            }),
            crate::accepted_fem_study_worker::AcceptedFemCpuExecutionOutcome::Completed(
                execution,
            ) => {
                if let Some(storage) = &mut storage {
                    storage.finish(true, &execution.attempt_output_dir)?;
                }
                persist_completed_worker_execution(
                    store,
                    &execution.attempt_output_dir,
                    &receipt_identity,
                    &prepared.output_ports,
                    execution.status,
                    execution.completed_step_count,
                    &execution.outputs,
                    Some(&execution.accepted_state_ref),
                    None,
                )
                .context("persist immutable completed FEM worker output receipt")?;
                Ok(AcceptedRunnerExecution {
                    status: execution.status,
                    completed_step_count: execution.completed_step_count,
                    outputs: execution.outputs,
                    attempt_output_dir: execution.attempt_output_dir,
                    recovered_from_receipt: false,
                    accepted_state_ref: Some(execution.accepted_state_ref),
                    observation_source: None,
                })
            }
        }
    })();
    if let Some(storage) = &mut storage {
        let success = execution
            .as_ref()
            .is_ok_and(|result| result.status == RunStatus::Completed);
        storage.finish(success, &storage_attempt_dir)?;
    }
    execution
}

fn prepare_accepted_project_storage(
    problem: &fullmag_ir::ProblemIR,
    store: &SessionStore,
    accepted_step: &AcceptedWorkerStep,
    identity: &WorkerExecutionReceiptIdentity,
    attempt: &Path,
) -> Result<Option<crate::accepted_project_storage::AcceptedProjectStorage>> {
    match crate::accepted_project_storage::AcceptedProjectStorage::prepare(
        problem,
        store,
        &accepted_step.claim,
        &accepted_step.step_id,
    ) {
        Ok(storage) => Ok(storage),
        Err(error) => {
            write_immutable_attempt_receipt(
                attempt,
                WORKER_PRELAUNCH_FAILED_RECEIPT,
                &WorkerPrelaunchFailedReceipt {
                    identity: identity.clone(),
                    error: error.to_string(),
                },
            )
            .context("persist known storage preparation failure before any solver side effect")?;
            Err(error).context("project storage preparation failed; no solver was launched")
        }
    }
}

fn refuse_known_prelaunch_failure(
    attempt: &Path,
    identity: &WorkerExecutionReceiptIdentity,
) -> Result<()> {
    if let Some(failure) = read_attempt_receipt::<WorkerPrelaunchFailedReceipt>(
        attempt,
        WORKER_PRELAUNCH_FAILED_RECEIPT,
    )? {
        let started: WorkerExecutionStartedReceipt =
            read_attempt_receipt(attempt, WORKER_EXECUTION_STARTED_RECEIPT)?
                .context("prelaunch failure has no matching durable worker start")?;
        if !started.identity.matches_same_attempt(identity)
            || !failure.identity.matches_same_attempt(identity)
        {
            bail!("prelaunch failure receipt belongs to another accepted Start");
        }
        bail!(
            "accepted worker failed before solver launch: {}",
            failure.error
        );
    }
    Ok(())
}

fn recover_accepted_fdm_worker_attempt(
    store: &SessionStore,
    accepted_step: &AcceptedWorkerStep,
    identity: &WorkerExecutionReceiptIdentity,
    declared_outputs: &[StudyOutputPort],
    existing_path: PathBuf,
) -> Result<AcceptedRunnerExecution> {
    let current_claim = retry_store_writer_busy(|| {
        fullmag_runtime_control::load_current_task_claim(
            store,
            &accepted_step.claim.run_id,
            accepted_step.claim.task_id.as_str(),
        )
    })
    .context("reconcile accepted worker receipt under the current claim")?;
    if !accepted_step.claim.is_same_or_renewed_by(&current_claim) {
        bail!("accepted worker receipt belongs to a stale task claim");
    }
    refuse_known_prelaunch_failure(&existing_path, identity)?;
    let expected_accepted_state_ref =
        accepted_state_ref_from_runner_snapshot(&existing_path, accepted_step, false)?;
    recover_completed_worker_execution(
        store,
        &existing_path,
        identity,
        declared_outputs,
        accepted_step.claim.lease.budget.storage_bytes,
        expected_accepted_state_ref.as_ref(),
        fdm_cpu_observation_grid(accepted_step),
    )
    .context("recover completed accepted worker attempt without rerunning solver")
}

fn recover_accepted_fem_worker_attempt(
    store: &SessionStore,
    accepted_step: &AcceptedWorkerStep,
    receipt_identity: &WorkerExecutionReceiptIdentity,
    declared_outputs: &[StudyOutputPort],
    existing_path: PathBuf,
) -> Result<AcceptedRunnerExecution> {
    let current_claim = retry_store_writer_busy(|| {
        fullmag_runtime_control::load_current_task_claim(
            store,
            &accepted_step.claim.run_id,
            accepted_step.claim.task_id.as_str(),
        )
    })
    .context("reconcile accepted FEM worker receipt under the current claim")?;
    if !accepted_step.claim.is_same_or_renewed_by(&current_claim) {
        bail!("accepted FEM worker receipt belongs to a stale task claim");
    }
    refuse_known_prelaunch_failure(&existing_path, receipt_identity)?;
    let expected_accepted_state_ref =
        crate::accepted_fem_study_worker::accepted_state_ref_from_attempt_snapshot(
            &existing_path,
            accepted_step,
        )
        .context("load accepted FEM state identity for receipt recovery")?;
    recover_completed_worker_execution(
        store,
        &existing_path,
        receipt_identity,
        declared_outputs,
        accepted_step.claim.lease.budget.storage_bytes,
        Some(&expected_accepted_state_ref),
        None,
    )
}

fn is_not_found_error(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
    })
}

pub(crate) struct AcceptedWorkerProcessResult {
    pub(crate) execution: AcceptedRunnerExecution,
    pub(crate) output_catalog: fullmag_session::FmsArtifactCatalog,
    pub(crate) receipt_recovered_before_publication: bool,
}

/// Execute one exact, already-claimed durable Start in a worker process.
/// This is deliberately a one-shot adapter, not a scheduler: it never selects
/// a task, claims a resource, retries an ambiguous pending inbox command, or
/// releases the physical resource lease. Those actions require a supervisor
/// that can observe worker-process exit and reconcile uncertain effects.
pub(crate) fn run_pending_accepted_start(
    store: &SessionStore,
    run_id: &str,
    task_id: &str,
) -> Result<AcceptedWorkerProcessOutcome> {
    fullmag_session::repository_path::validate_store_id(run_id)
        .context("accepted worker run id is invalid")?;
    fullmag_session::repository_path::validate_store_id(task_id)
        .context("accepted worker task id is invalid")?;
    let run_id = fullmag_application::RunId::parse(run_id.to_owned())
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let intent = store
        .read_run_intent(run_id.as_str())?
        .context("accepted worker run intent is missing")?;
    let specification: fullmag_application::RunSpecification =
        serde_json::from_value(intent.specification.clone())
            .context("accepted worker RunSpec is invalid")?;
    if specification.run_id != run_id {
        bail!("accepted worker RunSpec belongs to another run");
    }
    let accepted = retry_store_writer_busy(|| {
        fullmag_runtime_control::load_accepted_study_snapshot(
            store,
            &run_id,
            &specification.snapshot.project_id,
        )
    })
    .context("load immutable accepted study for worker process")?;
    let claim = retry_store_writer_busy(|| {
        fullmag_runtime_control::load_current_task_claim(store, &run_id, task_id)
    })
    .context("worker process requires the exact active durable task claim")?;
    let recovered =
        retry_store_writer_busy(|| fullmag_runtime_control::recover_coordinator(store, &claim))
            .context("worker process could not recover the durable coordinator")?;
    let starts = recovered
        .commands
        .iter()
        .filter(|command| {
            command.claim.matches_claim(&claim)
                && matches!(&command.command, fullmag_application::WorkerCommand::Start)
        })
        .collect::<Vec<_>>();
    if starts.len() != 1 {
        bail!("worker process requires exactly one durable Start for its claim");
    }
    let start = starts[0].clone();
    if !matches!(
        recovered.coordinator.phase(),
        fullmag_application::CoordinatorPhase::Preparing
            | fullmag_application::CoordinatorPhase::Running
            | fullmag_application::CoordinatorPhase::Stopping
    ) {
        bail!("worker process cannot execute Start in the recovered coordinator phase");
    }

    let mut inbox = retry_store_writer_busy(|| {
        let worker_store = SessionStore::open_existing(store.root().to_path_buf())
            .context("open the durable worker inbox store")?;
        fullmag_runtime_control::DurableWorkerInbox::recover(worker_store, claim.clone())
            .context("worker process requires an existing durable inbox")
    })?;
    let inbox_checkpoint = inbox.checkpoint();
    if inbox_checkpoint.claim != claim.identity()
        || inbox_checkpoint
            .applied
            .iter()
            .filter(|command| {
                matches!(
                    &command.command,
                    fullmag_application::WorkerCommand::Prepare { .. }
                )
            })
            .count()
            != 1
    {
        bail!("worker inbox does not contain exactly one prepared claim");
    }

    if inbox_checkpoint
        .applied
        .iter()
        .any(|command| command == &start)
    {
        bail!("worker process Start was already consumed; no solver was launched");
    }

    accepted_worker_test_fail_before_start_effect()?;

    if let Some(pending) = inbox_checkpoint.pending.as_ref() {
        if pending != &start {
            bail!("worker inbox has another pending command and requires reconciliation");
        }
        inbox
            .confirm_applied(&start)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        return apply_accepted_start_effect(store, &specification, &accepted, &claim, &start);
    }

    let disposition = inbox
        .receive(&start, |envelope| {
            if envelope != &start {
                return Err(fullmag_application::ExecutionError::ProtocolFenceRejected);
            }
            let current_claim = retry_store_writer_busy(|| {
                fullmag_runtime_control::load_current_task_claim(
                    store,
                    &claim.run_id,
                    claim.task_id.as_str(),
                )
            })
            .map_err(|error| {
                fullmag_application::ExecutionError::Invalid(format!(
                    "revalidate worker process claim: {error:#}"
                ))
            })?;
            if !claim.is_same_or_renewed_by(&current_claim) {
                return Err(fullmag_application::ExecutionError::ProtocolFenceRejected);
            }
            Ok(())
        })
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if disposition != fullmag_application::ProtocolDisposition::Accepted {
        bail!("worker process Start was already consumed; no solver was launched");
    }
    apply_accepted_start_effect(store, &specification, &accepted, &claim, &start)
}

fn apply_accepted_start_effect(
    store: &SessionStore,
    specification: &fullmag_application::RunSpecification,
    accepted: &fullmag_runtime_control::AcceptedStudySnapshot,
    claim: &fullmag_application::TaskClaim,
    start: &fullmag_application::WorkerCommandEnvelope,
) -> Result<AcceptedWorkerProcessOutcome> {
    let accepted_step = retry_store_writer_busy(|| {
        fullmag_runtime_control::load_accepted_worker_step_for_start(
            store,
            &specification.snapshot.project_id,
            start,
        )
    })
    .context("load accepted worker step")?;
    let recovered_coordinator =
        retry_store_writer_busy(|| fullmag_runtime_control::recover_coordinator(store, claim))
            .context("recover worker coordinator before Start")?;
    let mut coordinator =
        fullmag_application::DurableWorkerCoordinator::new(recovered_coordinator.coordinator);
    match coordinator.phase() {
        fullmag_application::CoordinatorPhase::Preparing => {
            commit_worker_event(
                store,
                &mut coordinator,
                fullmag_application::WorkerEvent::Started,
            )
            .context("persist worker Started event")?;
        }
        fullmag_application::CoordinatorPhase::Running
        | fullmag_application::CoordinatorPhase::Terminal => {}
        _ => bail!("accepted Start is no longer runnable"),
    }

    let control = WorkerControlLoop::start(store.root(), claim.clone())?;
    accepted_worker_test_delay_after_started(&control.interrupt_requested)?;

    let execution = execute_accepted_worker_start(
        store,
        &specification.snapshot.project_id,
        start,
        &accepted_step,
        "default",
        Some(&control.interrupt_requested),
    )
    .context("execute accepted worker Start")?;
    if execution.status == RunStatus::Cancelled {
        let control_result = finish_worker_control(store, claim, control)?;
        return publish_worker_stopped(store, claim, control_result);
    }
    let receipt_store = retry_store_writer_busy(|| {
        SessionStore::open_existing(store.root().to_path_buf())
            .context("reopen worker receipt store")
    })?;
    let durable_execution = execute_accepted_worker_start(
        &receipt_store,
        &specification.snapshot.project_id,
        start,
        &accepted_step,
        "default",
        None,
    )
    .context("recover completed worker receipt before publication")?;
    if !durable_execution.recovered_from_receipt
        || durable_execution.outputs != execution.outputs
        || durable_execution.accepted_state_ref != execution.accepted_state_ref
    {
        bail!("worker receipt recovery differs from the completed runner output");
    }
    if control.interrupt_requested.load(Ordering::Acquire) {
        let control_result = finish_worker_control(store, claim, control)?;
        return publish_worker_stopped(store, claim, control_result);
    }
    loop {
        let recovered_before_completing =
            retry_store_writer_busy(|| fullmag_runtime_control::recover_coordinator(store, claim))
                .context("recover worker coordinator before completion barrier")?;
        match recovered_before_completing.coordinator.phase() {
            fullmag_application::CoordinatorPhase::Stopping => {
                let control_result = finish_worker_control(store, claim, control)?;
                return publish_worker_stopped(store, claim, control_result);
            }
            fullmag_application::CoordinatorPhase::Running => {
                let mut coordinator = fullmag_application::DurableWorkerCoordinator::new(
                    recovered_before_completing.coordinator,
                );
                match commit_worker_event(
                    store,
                    &mut coordinator,
                    fullmag_application::WorkerEvent::Completing,
                ) {
                    Ok(()) => break,
                    Err(error) => {
                        let raced = retry_store_writer_busy(|| {
                            fullmag_runtime_control::recover_coordinator(store, claim)
                        })
                        .context("recover worker completion barrier race")?;
                        if raced.coordinator.phase()
                            == fullmag_application::CoordinatorPhase::Stopping
                        {
                            let control_result = finish_worker_control(store, claim, control)?;
                            return publish_worker_stopped(store, claim, control_result);
                        }
                        return Err(error).context("persist worker Completing event");
                    }
                }
            }
            _ => bail!("accepted worker completion barrier requires a running coordinator"),
        }
    }
    let control_result = finish_worker_control(store, claim, control)?;
    if control_result.stop_received {
        return publish_worker_stopped(store, claim, control_result);
    }
    let published = retry_store_writer_busy(|| {
        fullmag_runtime_control::publish_study_outputs(
            store,
            accepted,
            claim,
            &accepted_step.step_id,
            &durable_execution.outputs,
            durable_execution.accepted_state_ref.as_ref(),
            durable_execution.observation_source.as_ref(),
        )
    })
    .context("publish accepted worker outputs")?;
    fullmag_runtime_control::validate_study_task_completion(store, claim)
        .context("validate accepted worker completion barrier")?;
    let recovered_before_completion =
        retry_store_writer_busy(|| fullmag_runtime_control::recover_coordinator(store, claim))
            .context("recover worker coordinator before completion publication")?;
    let mut coordinator =
        fullmag_application::DurableWorkerCoordinator::new(recovered_before_completion.coordinator);
    match coordinator.phase() {
        fullmag_application::CoordinatorPhase::Running => {
            commit_worker_event(
                store,
                &mut coordinator,
                fullmag_application::WorkerEvent::Completed {
                    assessment: fullmag_application::ScientificAssessment::Unassessed,
                },
            )
            .context("persist worker Completed event")?;
        }
        fullmag_application::CoordinatorPhase::Terminal
            if matches!(
                coordinator.checkpoint().task.lifecycle,
                fullmag_application::TaskLifecycle::Succeeded
            ) => {}
        _ => bail!("accepted worker completion requires a running or succeeded coordinator"),
    }
    Ok(AcceptedWorkerProcessOutcome::Completed(
        AcceptedWorkerProcessResult {
            execution,
            output_catalog: published,
            receipt_recovered_before_publication: true,
        },
    ))
}

fn finish_worker_control(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
    control: WorkerControlLoop,
) -> Result<WorkerControlLoopResult> {
    let mut result = control.finish()?;
    let final_interrupt = AtomicBool::new(false);
    let final_result = consume_worker_control_commands(store, claim, &final_interrupt)?;
    result.stop_received |= final_result.stop_received;
    result.acknowledged_heartbeat_count += final_result.acknowledged_heartbeat_count;
    Ok(result)
}

fn publish_worker_stopped(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
    control_result: WorkerControlLoopResult,
) -> Result<AcceptedWorkerProcessOutcome> {
    if !control_result.stop_received {
        bail!("runner cancellation requires an applied durable worker Stop command");
    }
    let recovered =
        retry_store_writer_busy(|| fullmag_runtime_control::recover_coordinator(store, claim))
            .context("recover worker coordinator before Stopped acknowledgement")?;
    let mut coordinator = fullmag_application::DurableWorkerCoordinator::new(recovered.coordinator);
    match coordinator.phase() {
        fullmag_application::CoordinatorPhase::Stopping => {
            commit_worker_event(
                store,
                &mut coordinator,
                fullmag_application::WorkerEvent::Stopped,
            )
            .context("persist worker-originated Stopped event")?;
        }
        fullmag_application::CoordinatorPhase::Terminal
            if matches!(
                coordinator.checkpoint().task.lifecycle,
                fullmag_application::TaskLifecycle::Cancelled
            ) => {}
        _ => bail!("worker Stopped acknowledgement requires a durable Stop command"),
    }
    Ok(AcceptedWorkerProcessOutcome::Stopped {
        acknowledged_heartbeat_count: control_result.acknowledged_heartbeat_count,
    })
}

impl WorkerControlLoop {
    fn start(store_root: &Path, claim: fullmag_application::TaskClaim) -> Result<Self> {
        let interrupt_requested = Arc::new(AtomicBool::new(false));
        let execution_finished = Arc::new(AtomicBool::new(false));
        let thread_interrupt = Arc::clone(&interrupt_requested);
        let thread_finished = Arc::clone(&execution_finished);
        let store_root = store_root.to_path_buf();
        let handle = std::thread::Builder::new()
            .name("fullmag-accepted-worker-control".into())
            .spawn(move || {
                let store = SessionStore::open_existing(store_root)
                    .context("open session store for worker control loop")?;
                let mut acknowledged_heartbeat_count = 0_usize;
                loop {
                    let consumed =
                        consume_worker_control_commands(&store, &claim, &thread_interrupt)?;
                    acknowledged_heartbeat_count += consumed.acknowledged_heartbeat_count;
                    if consumed.stop_received {
                        return Ok(WorkerControlLoopResult {
                            stop_received: true,
                            acknowledged_heartbeat_count,
                        });
                    }
                    if thread_finished.load(Ordering::Acquire) {
                        return Ok(WorkerControlLoopResult {
                            stop_received: false,
                            acknowledged_heartbeat_count,
                        });
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            })
            .context("spawn accepted worker control loop")?;
        Ok(Self {
            interrupt_requested,
            execution_finished,
            handle,
        })
    }

    fn finish(self) -> Result<WorkerControlLoopResult> {
        self.execution_finished.store(true, Ordering::Release);
        self.handle
            .join()
            .map_err(|_| anyhow::anyhow!("accepted worker control loop panicked"))?
    }
}

fn consume_worker_control_commands(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
    interrupt_requested: &AtomicBool,
) -> Result<WorkerControlLoopResult> {
    let store_root = store.root().to_path_buf();
    let mut inbox = retry_store_writer_busy(|| {
        let worker_store = SessionStore::open_existing(store_root.clone())
            .context("open durable worker inbox store for control command")?;
        fullmag_runtime_control::DurableWorkerInbox::recover(worker_store, claim.clone())
    })
    .context("recover durable worker inbox for control command")?;
    let mut acknowledged_heartbeat_count = 0_usize;
    loop {
        let checkpoint = inbox.checkpoint();
        if checkpoint.pending.is_some() {
            bail!("worker control inbox has an uncertain pending command");
        }
        let catalog = store
            .read_run_catalog(claim.run_id.as_str())?
            .context("worker control command requires its run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == claim.task_id.as_str())
            .context("worker control command task is missing from its run catalog")?;
        let durable_command_count = task
            .coordinator_watermark
            .as_ref()
            .map_or(0, |watermark| watermark.command_sequence);
        if durable_command_count <= checkpoint.applied.len() as u64 {
            return Ok(WorkerControlLoopResult {
                stop_received: false,
                acknowledged_heartbeat_count,
            });
        }
        let recovered =
            retry_store_writer_busy(|| fullmag_runtime_control::recover_coordinator(store, claim))
                .context("recover coordinator for worker control command")?;
        let Some(command) = recovered.commands.get(checkpoint.applied.len()).cloned() else {
            return Ok(WorkerControlLoopResult {
                stop_received: false,
                acknowledged_heartbeat_count,
            });
        };
        match &command.command {
            fullmag_application::WorkerCommand::Heartbeat {
                lease_heartbeat_sequence,
            } => {
                inbox
                    .receive(&command, |_| Ok(()))
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                let recovered_after_apply = retry_store_writer_busy(|| {
                    fullmag_runtime_control::recover_coordinator(store, claim)
                })
                .context("recover coordinator before worker HeartbeatAck")?;
                if !recovered_after_apply.events.iter().any(|event| {
                    matches!(
                        &event.event,
                        fullmag_application::WorkerEvent::HeartbeatAck {
                            lease_heartbeat_sequence: acknowledged
                        } if acknowledged == lease_heartbeat_sequence
                    )
                }) {
                    let mut coordinator = fullmag_application::DurableWorkerCoordinator::new(
                        recovered_after_apply.coordinator,
                    );
                    commit_worker_event(
                        store,
                        &mut coordinator,
                        fullmag_application::WorkerEvent::HeartbeatAck {
                            lease_heartbeat_sequence: *lease_heartbeat_sequence,
                        },
                    )
                    .context("persist worker-originated HeartbeatAck")?;
                }
                acknowledged_heartbeat_count += 1;
            }
            fullmag_application::WorkerCommand::Stop { .. } => {
                inbox
                    .receive(&command, |_| {
                        interrupt_requested.store(true, Ordering::Release);
                        Ok(())
                    })
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                return Ok(WorkerControlLoopResult {
                    stop_received: true,
                    acknowledged_heartbeat_count,
                });
            }
            fullmag_application::WorkerCommand::Prepare { .. }
            | fullmag_application::WorkerCommand::Start => {
                bail!("worker control loop found an unapplied startup command")
            }
            fullmag_application::WorkerCommand::Release => {
                bail!("worker control loop received Release before terminal process exit")
            }
        }
    }
}

fn accepted_worker_test_fail_before_start_effect() -> Result<()> {
    if std::env::var("FULLMAG_ENABLE_TEST_HOOKS").as_deref() == Ok("1")
        && std::env::var("FULLMAG_TEST_ACCEPTED_WORKER_FAIL_BEFORE_EFFECT").as_deref() == Ok("1")
    {
        bail!("controlled accepted worker failure before durable side effect");
    }
    Ok(())
}

fn retry_store_writer_busy<T>(mut operation: impl FnMut() -> Result<T>) -> Result<T> {
    fullmag_runtime_control::retry_store_writer_busy(&mut operation)
}

fn accepted_worker_test_delay_after_started(interrupt_requested: &AtomicBool) -> Result<()> {
    if std::env::var("FULLMAG_ENABLE_TEST_HOOKS").as_deref() != Ok("1") {
        return Ok(());
    }
    let Some(value) = std::env::var_os("FULLMAG_TEST_ACCEPTED_WORKER_AFTER_STARTED_DELAY_MS")
    else {
        return Ok(());
    };
    let milliseconds = value
        .to_str()
        .context("accepted worker test delay must be valid UTF-8")?
        .parse::<u64>()
        .context("accepted worker test delay must be an integer")?;
    if milliseconds == 0 || milliseconds > 30_000 {
        bail!("accepted worker test delay must be within 1..=30000 milliseconds");
    }
    let deadline = Instant::now() + Duration::from_millis(milliseconds);
    while Instant::now() < deadline && !interrupt_requested.load(Ordering::Acquire) {
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

fn commit_worker_event(
    store: &SessionStore,
    coordinator: &mut fullmag_application::DurableWorkerCoordinator,
    event: fullmag_application::WorkerEvent,
) -> Result<()> {
    for _ in 0..8 {
        let checkpoint = coordinator.checkpoint();
        let sequence = checkpoint
            .event_sequence
            .checked_add(1)
            .context("worker event sequence exhausted")?;
        let envelope = fullmag_application::WorkerEventEnvelope {
            schema_version: coordinator.protocol_schema().into(),
            message_id: uuid::Uuid::new_v4().simple().to_string(),
            sequence,
            claim: checkpoint.claim.identity(),
            event: event.clone(),
        };
        let expected = envelope.clone();
        let mut publication_error = None;
        let result = coordinator.commit_event(envelope, |transition| {
            fullmag_runtime_control::commit_transition(store, transition)
                .map(|_| ())
                .map_err(|error| {
                    publication_error = Some(error);
                    fullmag_application::CoordinatorError::Invalid(
                        "durable worker event publication failed".into(),
                    )
                })
        });
        match (result, publication_error) {
            (Ok(_), None) => return Ok(()),
            (_, Some(error)) if is_store_writer_busy(&error) => {
                match retry_pending_worker_event(store, coordinator, &expected) {
                    Ok(()) => return Ok(()),
                    Err(error) if is_coordinator_watermark_conflict(&error) => {
                        let claim = coordinator.claim().clone();
                        let recovered = retry_store_writer_busy(|| {
                            fullmag_runtime_control::recover_coordinator(store, &claim)
                        })
                        .context("recover worker coordinator after retried transition race")?;
                        *coordinator = fullmag_application::DurableWorkerCoordinator::new(
                            recovered.coordinator,
                        );
                    }
                    Err(error) => return Err(error),
                }
            }
            (_, Some(error)) if is_coordinator_watermark_conflict(&error) => {
                let claim = coordinator.claim().clone();
                let recovered = retry_store_writer_busy(|| {
                    fullmag_runtime_control::recover_coordinator(store, &claim)
                })
                .context("recover worker coordinator after concurrent transition")?;
                *coordinator =
                    fullmag_application::DurableWorkerCoordinator::new(recovered.coordinator);
            }
            (_, Some(error)) => return Err(error).context("publish durable worker event"),
            (Err(error), None) => {
                return Err(anyhow::Error::new(error)).context("commit worker event");
            }
        }
    }
    bail!("worker event publication exceeded concurrent transition retry limit")
}

fn retry_pending_worker_event(
    store: &SessionStore,
    coordinator: &mut fullmag_application::DurableWorkerCoordinator,
    expected: &fullmag_application::WorkerEventEnvelope,
) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let mut publication_error = None;
        let result = coordinator.retry_publication(|transition| {
            fullmag_runtime_control::commit_transition(store, transition)
                .map(|_| ())
                .map_err(|error| {
                    publication_error = Some(error);
                    fullmag_application::CoordinatorError::Invalid(
                        "durable worker event publication retry failed".into(),
                    )
                })
        });
        match (result, publication_error) {
            (Ok(fullmag_application::CoordinatorMessage::Event(envelope)), None)
                if envelope == *expected =>
            {
                return Ok(());
            }
            (Ok(fullmag_application::CoordinatorMessage::Event(_)), None) => {
                bail!("retried worker event differs from the retained publication");
            }
            (Ok(fullmag_application::CoordinatorMessage::Command(_)), None) => {
                bail!("retried worker publication is not an event");
            }
            (_, Some(error)) if is_store_writer_busy(&error) && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            (_, Some(error)) => return Err(error).context("publish durable worker event"),
            (Err(error), None) => {
                return Err(anyhow::Error::new(error)).context("publish durable worker event");
            }
        }
    }
}

fn is_store_writer_busy(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
}

fn is_coordinator_watermark_conflict(error: &anyhow::Error) -> bool {
    format!("{error:#}").contains("coordinator journal cross-stream watermark changed")
}

/// Convert the runner's explicit output files and terminal result into the
/// typed allow-list required by accepted study publication.
pub(crate) fn collect_runner_study_outputs(
    declared: &[StudyOutputPort],
    case_id: &str,
    result: &RunResult,
    attempt_output_dir: &Path,
    max_output_bytes: u64,
) -> Result<Vec<StudyOutputPayload>> {
    if result.status != RunStatus::Completed {
        bail!("accepted study outputs require a completed runner result");
    }
    fullmag_session::repository_path::validate_store_id(case_id)
        .context("accepted worker case id is invalid")?;

    let mut seen_ports = BTreeSet::new();
    let mut outputs = Vec::with_capacity(declared.len());
    let mut total_bytes = 0_u64;
    for port in declared {
        fullmag_session::repository_path::validate_store_id(&port.port_id).with_context(|| {
            format!("accepted worker output port `{}` is invalid", port.port_id)
        })?;
        if !seen_ports.insert(port.port_id.as_str()) {
            bail!(
                "accepted worker output port `{}` is duplicated",
                port.port_id
            );
        }

        match port.data_kind {
            StudyPortDataKind::InitialState => {
                let bytes = read_explicit_runner_artifact(
                    attempt_output_dir,
                    RUNNER_INITIAL_STATE_FILE,
                    max_output_bytes.saturating_sub(total_bytes),
                )?;
                push_typed_output(
                    &mut outputs,
                    &mut total_bytes,
                    max_output_bytes,
                    port,
                    case_id,
                    "initial_state",
                    fullmag_application::STUDY_MAGNETIZATION_CODEC_ID,
                    fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION,
                    bytes,
                )?;
            }
            StudyPortDataKind::State => {
                let bytes = read_explicit_runner_artifact(
                    attempt_output_dir,
                    RUNNER_FINAL_STATE_FILE,
                    max_output_bytes.saturating_sub(total_bytes),
                )?;
                push_typed_output(
                    &mut outputs,
                    &mut total_bytes,
                    max_output_bytes,
                    port,
                    case_id,
                    "state",
                    fullmag_application::STUDY_MAGNETIZATION_CODEC_ID,
                    fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION,
                    bytes,
                )?;
            }
            StudyPortDataKind::Scalar if port.port_id == "total_energy" => {
                let final_step = result
                    .steps
                    .last()
                    .context("total_energy output requires a final runner step")?;
                let bytes = fullmag_application::encode_study_scalar_artifact(
                    "E_total",
                    "J",
                    final_step.e_total,
                    final_step.step,
                    final_step.time,
                )?;
                push_typed_output(
                    &mut outputs,
                    &mut total_bytes,
                    max_output_bytes,
                    port,
                    case_id,
                    "scalar",
                    fullmag_application::STUDY_SCALAR_CODEC_ID,
                    fullmag_application::STUDY_SCALAR_CODEC_VERSION,
                    bytes,
                )?;
            }
            StudyPortDataKind::Scalar => {
                bail!(
                    "accepted worker has no explicit runner binding for scalar output port `{}`",
                    port.port_id
                );
            }
            unsupported => bail!(
                "accepted worker output kind `{unsupported:?}` has no registered runner binding"
            ),
        }
    }

    Ok(outputs)
}

fn push_typed_output(
    outputs: &mut Vec<StudyOutputPayload>,
    total_bytes: &mut u64,
    max_output_bytes: u64,
    port: &StudyOutputPort,
    case_id: &str,
    data_kind: &str,
    codec_id: &str,
    codec_version: &str,
    bytes: Vec<u8>,
) -> Result<()> {
    let byte_count = u64::try_from(bytes.len()).context("study output byte count overflowed")?;
    let next_total = total_bytes
        .checked_add(byte_count)
        .context("study output aggregate byte count overflowed")?;
    if next_total > max_output_bytes {
        bail!(
            "accepted study outputs exceed the attempt storage budget ({next_total} > {max_output_bytes} bytes)"
        );
    }
    fullmag_application::decode_study_artifact_bytes(data_kind, codec_id, codec_version, &bytes)
        .with_context(|| {
            format!(
                "runner bytes for output port `{}` are invalid",
                port.port_id
            )
        })?;
    outputs.push(StudyOutputPayload {
        port_id: port.port_id.clone(),
        case_id: case_id.to_owned(),
        codec_id: codec_id.to_owned(),
        codec_version: codec_version.to_owned(),
        bytes,
    });
    *total_bytes = next_total;
    Ok(())
}

fn read_explicit_runner_artifact(
    attempt_output_dir: &Path,
    file_name: &str,
    max_bytes: u64,
) -> Result<Vec<u8>> {
    let root_metadata = fs::symlink_metadata(attempt_output_dir).with_context(|| {
        format!(
            "inspect worker attempt output directory `{}`",
            attempt_output_dir.display()
        )
    })?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        bail!("worker attempt output root must be a real directory");
    }
    let root = attempt_output_dir.canonicalize().with_context(|| {
        format!(
            "canonicalize worker attempt output directory `{}`",
            attempt_output_dir.display()
        )
    })?;
    let path = attempt_output_dir.join(file_name);
    let metadata = fs::symlink_metadata(&path)
        .with_context(|| format!("required runner artifact `{file_name}` is missing"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("required runner artifact `{file_name}` must be a regular file");
    }
    if metadata.len() == 0 || metadata.len() > max_bytes {
        bail!(
            "runner artifact `{file_name}` size {} is outside the remaining attempt storage budget {max_bytes}",
            metadata.len()
        );
    }
    let canonical_file = path
        .canonicalize()
        .with_context(|| format!("canonicalize runner artifact `{file_name}`"))?;
    if !canonical_file.starts_with(&root) {
        bail!("runner artifact `{file_name}` escapes the private attempt output directory");
    }
    let bytes =
        fs::read(&canonical_file).with_context(|| format!("read runner artifact `{file_name}`"))?;
    if u64::try_from(bytes.len()).ok() != Some(metadata.len()) {
        bail!("runner artifact `{file_name}` changed while it was being read");
    }
    Ok(bytes)
}
