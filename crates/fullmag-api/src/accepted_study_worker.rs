use anyhow::{bail, Context, Result};
use fullmag_application::DecodedStudyArtifact;
use fullmag_authoring::{
    StudyAcceptancePolicy, StudyInputPort, StudyInputSource, StudyOutputPort, StudyPortDataKind,
};
use fullmag_ir::ExecutionPlanIR;
use fullmag_runner::{RunResult, RunStatus};
use fullmag_runtime_control::{AcceptedWorkerStep, StudyOutputPayload};
use fullmag_session::SessionStore;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const RUNNER_INITIAL_STATE_FILE: &str = "m_initial.json";
const RUNNER_FINAL_STATE_FILE: &str = "m_final.json";
const WORKER_EXECUTION_STARTED_RECEIPT: &str = "worker_execution_started.v1.json";
const WORKER_EXECUTION_COMPLETED_RECEIPT: &str = "worker_execution_completed.v1.json";
const WORKER_EXECUTION_RECEIPT_SCHEMA: &str = "fullmag.accepted_worker_execution.v1";

pub(crate) struct AcceptedRunnerExecution {
    pub(crate) status: RunStatus,
    pub(crate) completed_step_count: usize,
    pub(crate) outputs: Vec<StudyOutputPayload>,
    pub(crate) attempt_output_dir: PathBuf,
    pub(crate) recovered_from_receipt: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerExecutionStartedReceipt {
    identity: WorkerExecutionReceiptIdentity,
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
struct WorkerExecutionCompletedReceipt {
    schema_version: String,
    identity: WorkerExecutionReceiptIdentity,
    status: RunStatus,
    completed_step_count: usize,
    outputs: Vec<WorkerExecutionOutputReference>,
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
    if current_claim != *claim {
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
        let object_ref = store.cas().put(&output.bytes)?;
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
    let receipt = WorkerExecutionCompletedReceipt {
        schema_version: WORKER_EXECUTION_RECEIPT_SCHEMA.into(),
        identity: identity.clone(),
        status,
        completed_step_count,
        outputs: output_refs,
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
) -> Result<AcceptedRunnerExecution> {
    let started: WorkerExecutionStartedReceipt =
        read_attempt_receipt(attempt_output_dir, WORKER_EXECUTION_STARTED_RECEIPT)?
            .context("existing attempt has no durable started receipt; refusing to rerun")?;
    if started.identity != *expected_identity {
        bail!("existing worker start receipt belongs to another command or claim");
    }
    let completed: WorkerExecutionCompletedReceipt =
        read_attempt_receipt(attempt_output_dir, WORKER_EXECUTION_COMPLETED_RECEIPT)?.context(
            "worker outcome is unknown because no completed receipt exists; refusing to rerun",
        )?;
    if completed.schema_version != WORKER_EXECUTION_RECEIPT_SCHEMA
        || completed.identity != *expected_identity
        || completed.status != RunStatus::Completed
        || completed.completed_step_count == 0
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
    let mut total_bytes = 0_u64;
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
        let next_total = total_bytes
            .checked_add(output.byte_count)
            .context("recovered worker output byte count overflowed")?;
        if next_total > max_output_bytes {
            bail!("recovered worker outputs exceed the attempt storage budget");
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
        total_bytes = next_total;
    }
    if seen.len() != declared.len() {
        bail!("completed worker receipt omits an accepted output port");
    }
    Ok(AcceptedRunnerExecution {
        status: completed.status,
        completed_step_count: completed.completed_step_count,
        outputs,
        attempt_output_dir: attempt_output_dir.to_path_buf(),
        recovered_from_receipt: true,
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
) -> Result<AcceptedRunnerExecution> {
    if !matches!(&start.command, fullmag_application::WorkerCommand::Start) {
        bail!("accepted runner execution requires a durable Start command");
    }
    fullmag_session::repository_path::validate_store_id(case_id)
        .context("accepted worker case id is invalid")?;
    if !start.claim.matches_claim(&accepted_step.claim) {
        bail!("accepted Start does not match the worker task claim");
    }
    let inbox_checkpoint =
        fullmag_runtime_control::recover_worker_inbox(store, &accepted_step.claim)
            .context("load durable worker inbox before accepted Start execution")?
            .checkpoint();
    if inbox_checkpoint.pending.as_ref() != Some(start)
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
        bail!("accepted Start is not the pending command after one durable Prepare");
    }
    let current_claim = fullmag_runtime_control::load_current_task_claim(
        store,
        &accepted_step.claim.run_id,
        accepted_step.claim.task_id.as_str(),
    )
    .context("accepted Start no longer owns the current task claim")?;
    if current_claim != accepted_step.claim {
        bail!("accepted Start worker context has a stale task claim");
    }

    let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
        store,
        &accepted_step.claim.run_id,
        project_id,
    )
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
    let request = &specification.requested_execution;
    if request.backend != "fdm"
        || request.device != "cpu"
        || request.precision != "double"
        || request.mode != "strict"
    {
        bail!("accepted worker currently supports only FDM CPU double strict");
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
    if !matches!(
        &accepted_step.claim.lease.kind,
        fullmag_application::ResourceKind::Cpu
    ) {
        bail!("accepted FDM CPU execution requires a CPU resource lease");
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
        bail!("accepted worker execution plan is outside the FDM CPU double strict lane");
    }
    if std::env::var("FULLMAG_FDM_EXECUTION")
        .ok()
        .is_some_and(|value| value != "cpu")
    {
        bail!("FULLMAG_FDM_EXECUTION overrides the accepted CPU device request");
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
    let attempt_output_dir = match create_private_attempt_output_dir(store, &accepted_step.claim) {
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
            let current_claim = fullmag_runtime_control::load_current_task_claim(
                store,
                &accepted_step.claim.run_id,
                accepted_step.claim.task_id.as_str(),
            )
            .context("reconcile accepted worker receipt under the current claim")?;
            if current_claim != accepted_step.claim {
                bail!("accepted worker receipt belongs to a stale task claim");
            }
            return recover_completed_worker_execution(
                store,
                &existing_path,
                &receipt_identity,
                &study_step.outputs,
                accepted_step.claim.lease.budget.storage_bytes,
            )
            .context("recover completed accepted worker attempt without rerunning solver");
        }
    };

    // RunSpec is the accepted source for requested device/precision. Project
    // that explicit CPU request into the runner's runtime-selection metadata;
    // the environment guard above prevents a managed override from changing it.
    let mut problem = accepted_step.problem.clone();
    problem.problem_meta.runtime_metadata.insert(
        "runtime_selection".into(),
        serde_json::json!({"device": "cpu", "precision": "double"}),
    );
    let result = fullmag_runner::run_planned_problem(
        &problem,
        &execution_plan,
        until_seconds,
        &attempt_output_dir,
    )
    .map_err(|error| anyhow::anyhow!(error.to_string()))
    .context("execute accepted FDM CPU runner plan")?;
    if result.status != RunStatus::Completed {
        bail!("accepted FDM CPU runner did not complete successfully");
    }
    let outputs = collect_runner_study_outputs(
        &study_step.outputs,
        case_id,
        &result,
        &attempt_output_dir,
        accepted_step.claim.lease.budget.storage_bytes,
    )
    .context("collect explicit typed outputs from the accepted runner attempt")?;
    persist_completed_worker_execution(
        store,
        &attempt_output_dir,
        &receipt_identity,
        &study_step.outputs,
        result.status,
        result.steps.len(),
        &outputs,
    )
    .context("persist immutable completed worker output receipt")?;

    Ok(AcceptedRunnerExecution {
        status: result.status,
        completed_step_count: result.steps.len(),
        outputs,
        attempt_output_dir,
        recovered_from_receipt: false,
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
) -> Result<AcceptedWorkerProcessResult> {
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
    let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
        store,
        &run_id,
        &specification.snapshot.project_id,
    )
    .context("load immutable accepted study for worker process")?;
    let claim = fullmag_runtime_control::load_current_task_claim(store, &run_id, task_id)
        .context("worker process requires the exact active durable task claim")?;
    let recovered = fullmag_runtime_control::recover_coordinator(store, &claim)
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
    if recovered.commands.last() != Some(&start) {
        bail!("worker process refuses a Start superseded by another command");
    }
    if !matches!(
        recovered.coordinator.phase(),
        fullmag_application::CoordinatorPhase::Preparing
            | fullmag_application::CoordinatorPhase::Running
    ) {
        bail!("worker process cannot execute Start in the recovered coordinator phase");
    }

    let worker_store = SessionStore::open_existing(store.root().to_path_buf())
        .context("open the durable worker inbox store")?;
    let mut inbox =
        fullmag_runtime_control::DurableWorkerInbox::recover(worker_store, claim.clone())
            .context("worker process requires an existing durable inbox")?;
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

    if let Some(pending) = inbox_checkpoint.pending.as_ref() {
        if pending != &start {
            bail!("worker inbox has another pending command and requires reconciliation");
        }
        let completed =
            apply_accepted_start_effect(store, &specification, &accepted, &claim, &start)?;
        inbox
            .confirm_applied(&start)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        return Ok(completed);
    }

    let mut completed = None;
    let disposition = inbox
        .receive(&start, |envelope| {
            if envelope != &start {
                return Err(fullmag_application::ExecutionError::ProtocolFenceRejected);
            }
            let current_claim = fullmag_runtime_control::load_current_task_claim(
                store,
                &claim.run_id,
                claim.task_id.as_str(),
            )
            .map_err(|error| {
                fullmag_application::ExecutionError::Invalid(format!(
                    "revalidate worker process claim: {error:#}"
                ))
            })?;
            if current_claim != claim {
                return Err(fullmag_application::ExecutionError::ProtocolFenceRejected);
            }
            completed = Some(
                apply_accepted_start_effect(store, &specification, &accepted, &claim, envelope)
                    .map_err(|error| {
                        fullmag_application::ExecutionError::Invalid(format!("{error:#}"))
                    })?,
            );
            Ok(())
        })
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if disposition != fullmag_application::ProtocolDisposition::Accepted {
        bail!("worker process Start was already consumed; no solver was launched");
    }
    completed.context("worker process accepted Start without a completed execution result")
}

fn apply_accepted_start_effect(
    store: &SessionStore,
    specification: &fullmag_application::RunSpecification,
    accepted: &fullmag_runtime_control::AcceptedStudySnapshot,
    claim: &fullmag_application::TaskClaim,
    start: &fullmag_application::WorkerCommandEnvelope,
) -> Result<AcceptedWorkerProcessResult> {
    let accepted_step = fullmag_runtime_control::load_accepted_worker_step_for_start(
        store,
        &specification.snapshot.project_id,
        start,
    )
    .context("load accepted worker step")?;
    let recovered_coordinator = fullmag_runtime_control::recover_coordinator(store, claim)
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

    let execution = execute_accepted_worker_start(
        store,
        &specification.snapshot.project_id,
        start,
        &accepted_step,
        "default",
    )
    .context("execute accepted worker Start")?;
    let receipt_store = SessionStore::open_existing(store.root().to_path_buf())
        .context("reopen worker receipt store")?;
    let durable_execution = execute_accepted_worker_start(
        &receipt_store,
        &specification.snapshot.project_id,
        start,
        &accepted_step,
        "default",
    )
    .context("recover completed worker receipt before publication")?;
    if !durable_execution.recovered_from_receipt || durable_execution.outputs != execution.outputs {
        bail!("worker receipt recovery differs from the completed runner output");
    }
    let published = fullmag_runtime_control::publish_study_outputs(
        store,
        accepted,
        claim,
        &accepted_step.step_id,
        &durable_execution.outputs,
    )
    .context("publish accepted worker outputs")?;
    fullmag_runtime_control::validate_study_task_completion(store, claim)
        .context("validate accepted worker completion barrier")?;
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
    Ok(AcceptedWorkerProcessResult {
        execution,
        output_catalog: published,
        receipt_recovered_before_publication: true,
    })
}

fn commit_worker_event(
    store: &SessionStore,
    coordinator: &mut fullmag_application::DurableWorkerCoordinator,
    event: fullmag_application::WorkerEvent,
) -> Result<()> {
    let checkpoint = coordinator.checkpoint();
    let sequence = checkpoint
        .event_sequence
        .checked_add(1)
        .context("worker event sequence exhausted")?;
    let envelope = fullmag_application::WorkerEventEnvelope {
        schema_version: fullmag_application::WORKER_PROTOCOL_SCHEMA.into(),
        message_id: uuid::Uuid::new_v4().simple().to_string(),
        sequence,
        claim: checkpoint.claim.identity(),
        event,
    };
    coordinator
        .commit_event(envelope, |transition| {
            fullmag_runtime_control::commit_transition(store, transition)
                .map(|_| ())
                .map_err(|error| {
                    fullmag_application::CoordinatorError::Invalid(format!("{error:#}"))
                })
        })
        .map(|_| ())
        .map_err(|error| anyhow::anyhow!(error.to_string()))
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
    if canonical_file.parent() != Some(root.as_path()) {
        bail!("runner artifact `{file_name}` escapes the private attempt output directory");
    }
    let bytes =
        fs::read(&canonical_file).with_context(|| format!("read runner artifact `{file_name}`"))?;
    if u64::try_from(bytes.len()).ok() != Some(metadata.len()) {
        bail!("runner artifact `{file_name}` changed while it was being read");
    }
    Ok(bytes)
}
