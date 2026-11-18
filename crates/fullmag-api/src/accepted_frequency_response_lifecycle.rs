//! Durable driven-response execution uses the ordinary accepted worker owner.
//! This module neither schedules work nor creates accepted magnetic state.

use super::*;
use crate::accepted_fem_frequency_response_worker as adapter;
use serde_json::Value;

pub(crate) const PROGRESS_FILE: &str = "frequency_response_progress.v1.json";
const PROGRESS_SCHEMA: &str = "fullmag.accepted_frequency_response_progress.v1";

pub(crate) fn read_progress(
    store_root: &Path,
    run_id: &str,
    task_id: &str,
    step_id: &str,
    attempt_id: &str,
    epoch: u64,
) -> Result<Option<ProgressFrame>> {
    let path = match existing_private_attempt_output_dir_for_identity(
        &SessionStore::open_existing(store_root)?,
        run_id,
        task_id,
        attempt_id,
        epoch,
    ) {
        Ok(path) => path,
        Err(error) if is_not_found_error(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let bytes = match fullmag_session::repository_path::read_bounded_regular_file(
        &path,
        PROGRESS_FILE,
        64 * 1024,
    ) {
        Ok(bytes) => bytes,
        Err(error) if is_not_found_error(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let frame: ProgressFrame = serde_json::from_slice(&bytes)?;
    frame.validate()?;
    if frame.run_id != run_id
        || frame.task_id != task_id
        || frame.step_id != step_id
        || frame.attempt_id != attempt_id
        || frame.ownership_epoch != epoch
    {
        bail!("driven-response progress belongs to another worker attempt");
    }
    Ok(Some(frame))
}

pub(crate) fn published_root(
    store: &SessionStore,
    run_id: &str,
    task: &fullmag_session::FmsTaskCatalogEntry,
) -> Result<PathBuf> {
    let attempt_id = task
        .attempt_id
        .as_deref()
        .context("response attempt identity missing")?;
    let epoch = task
        .ownership_epoch
        .context("response attempt epoch missing")?;
    Ok(existing_private_attempt_output_dir_for_identity(
        store,
        run_id,
        &task.task_id,
        attempt_id,
        epoch,
    )?
    .join("analysis"))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProgressFrame {
    pub schema_version: String,
    pub run_id: String,
    pub task_id: String,
    pub step_id: String,
    pub attempt_id: String,
    pub ownership_epoch: u64,
    pub sequence: u64,
    pub frequency_count: u64,
    pub metrics: BTreeMap<String, f64>,
}

impl ProgressFrame {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.schema_version != PROGRESS_SCHEMA
            || self.sequence == 0
            || self.ownership_epoch == 0
            || self.frequency_count == 0
            || self.frequency_count > (1_u64 << 53)
            || self.metrics.len() > 128
            || self
                .metrics
                .iter()
                .any(|(key, value)| key.len() > 128 || !value.is_finite())
        {
            bail!("invalid bounded driven-response progress frame");
        }
        for id in [&self.run_id, &self.task_id, &self.step_id, &self.attempt_id] {
            fullmag_session::repository_path::validate_store_id(id)?;
        }
        let counter = |key: &str| -> Result<u64> {
            let value = *self
                .metrics
                .get(key)
                .with_context(|| format!("missing response {key}"))?;
            if value < 0.0 || value.fract() != 0.0 || value > (1_u64 << 53) as f64 {
                bail!("response counter is not an exact nonnegative integer");
            }
            Ok(value as u64)
        };
        let completed = counter("completed_frequency_count")?;
        let total = counter("total_frequency_count")?;
        let index = counter("frequency_index")?;
        counter("iteration")?;
        if total != self.frequency_count
            || completed > total
            || index > total
            || (completed < total && index == total)
            || self.metrics.get("frequency_hz").is_none_or(|v| *v <= 0.0)
            || self
                .metrics
                .get("relative_residual_l2_norm")
                .is_none_or(|v| *v < 0.0)
        {
            bail!("response progress differs from its declared frequency grid");
        }
        Ok(())
    }
}

struct ProgressWriter<'a> {
    root: &'a Path,
    step: &'a AcceptedWorkerStep,
    frequency_count: u64,
    sequence: u64,
    last_write: Option<Instant>,
}

impl ProgressWriter<'_> {
    fn observe(&mut self, update: fullmag_runner::StepUpdate) -> StepAction {
        let Some(metrics) = update
            .stats
            .per_object_scalars
            .get("fem_frequency_response_progress")
        else {
            return StepAction::Continue;
        };
        if self
            .last_write
            .is_some_and(|time| time.elapsed() < Duration::from_millis(250))
        {
            return StepAction::Continue;
        }
        let result = (|| -> Result<()> {
            let frame = ProgressFrame {
                schema_version: PROGRESS_SCHEMA.into(),
                run_id: self.step.claim.run_id.as_str().into(),
                task_id: self.step.claim.task_id.as_str().into(),
                step_id: self.step.step_id.clone(),
                attempt_id: self.step.claim.attempt_id.as_str().into(),
                ownership_epoch: self.step.claim.ownership_epoch.value(),
                sequence: self
                    .sequence
                    .checked_add(1)
                    .context("response progress sequence overflow")?,
                frequency_count: self.frequency_count,
                metrics: metrics.iter().map(|(k, v)| (k.clone(), *v)).collect(),
            };
            frame.validate()?;
            let bytes = serde_json::to_vec(&frame)?;
            if bytes.len() > 64 * 1024 {
                bail!("response progress exceeds its read bound");
            }
            write_live_file_atomically(self.root, PROGRESS_FILE, &bytes)?;
            self.sequence = frame.sequence;
            self.last_write = Some(Instant::now());
            Ok(())
        })();
        if let Err(error) = result {
            tracing::warn!(%error,"driven-response progress publication failed");
        }
        StepAction::Continue
    }
}

pub(crate) fn execute(
    store: &SessionStore,
    accepted: &fullmag_runtime_control::AcceptedStudySnapshot,
    start: &fullmag_application::WorkerCommandEnvelope,
    step: &AcceptedWorkerStep,
    study_step: &fullmag_authoring::StudyStep,
    case_id: &str,
    interrupt: Option<&AtomicBool>,
) -> Result<AcceptedRunnerExecution> {
    let identity = worker_execution_receipt_identity(start, step, case_id)?;
    let runtime = resolve_accepted_fem_runtime(store, step)?;
    let session_id = accepted
        .run
        .specification
        .parameters
        .get("live_workspace")
        .and_then(|live| live.get("session_id"))
        .and_then(Value::as_str)
        .context("accepted driven response requires its immutable Live session binding")?;
    let artifact_identity = fullmag_runner::eigen::FrequencyDomainArtifactIdentity::try_new(
        session_id,
        step.claim.run_id.as_str(),
        &step.step_id,
        format!(
            "runtime:fr:{}:epoch-{}",
            step.claim.attempt_id.as_str(),
            step.claim.ownership_epoch.value()
        ),
    )?;
    let prepared = adapter::prepare(
        store,
        accepted,
        step,
        study_step,
        case_id,
        &runtime,
        &artifact_identity,
        "scope:driven-response",
    )?;
    let recover = |path: PathBuf| -> Result<AcceptedRunnerExecution> {
        let current = retry_worker_claim_store_busy(
            store,
            step.claim.run_id.as_str(),
            step.claim.task_id.as_str(),
            || {
                fullmag_runtime_control::load_current_task_claim(
                    store,
                    &step.claim.run_id,
                    step.claim.task_id.as_str(),
                )
            },
        )?;
        if !step.claim.is_same_or_renewed_by(&current) {
            bail!("response recovery belongs to a stale claim");
        }
        refuse_known_prelaunch_failure(&path, &identity)?;
        let result = recover_completed_worker_execution(
            store,
            &path,
            &identity,
            &study_step.outputs,
            prepared.output_storage_budget,
            None,
            None,
        )?;
        if result.accepted_state_ref.is_some()
            || result.observation_source.is_some()
            || result.terminal_stats.is_some()
            || result.completion.is_some()
            || result.completed_step_count
                != prepared.frequency_plan().frequencies_hz.values_hz.len()
        {
            bail!("response completed receipt has a state or incomplete sweep");
        }
        adapter::validate_outputs(
            &result.outputs,
            &prepared.bundle_identity,
            prepared.frequency_plan(),
            prepared.output_storage_budget,
            prepared.memory_budget,
        )?;
        adapter::restore_published_closure(&result.outputs, &prepared, &path.join("analysis"))?;
        Ok(result)
    };
    match existing_private_attempt_output_dir(store, &step.claim) {
        Ok(path) => return recover(path),
        Err(error) if is_not_found_error(&error) => {}
        Err(error) => return Err(error).context("inspect existing driven-response attempt"),
    }
    crate::accepted_project_storage::AcceptedProjectStorage::preflight(
        &prepared.problem,
        store,
        &step.claim,
        &step.step_id,
    )?;
    crate::accepted_project_storage::AcceptedProjectStorage::preflight_capacity(
        &prepared.problem,
        store,
        &step.step_id,
        prepared.required_free_storage_bytes,
    )?;
    let attempt =
        match retry_store_writer_busy(|| create_private_attempt_output_dir(store, &step.claim)) {
            Ok(path) => path,
            Err(error) => match existing_private_attempt_output_dir(store, &step.claim) {
                Ok(path) => return recover(path),
                Err(_) => return Err(error).context("reserve driven-response attempt"),
            },
        };
    write_immutable_attempt_receipt(
        &attempt,
        WORKER_EXECUTION_STARTED_RECEIPT,
        &WorkerExecutionStartedReceipt {
            identity: identity.clone(),
        },
    )?;
    let mut storage = prepare_accepted_project_storage(
        &prepared.problem,
        store,
        accepted,
        step,
        &identity,
        &attempt,
    )?;
    let execution: Result<AcceptedRunnerExecution> = (|| {
        let native_root = (|| {
            let root = storage.as_ref()
                .context("driven response requires canonical project output storage")?
                .data_root();
            adapter::validate_native_output_path(root, prepared.frequency_plan().frequencies_hz.values_hz.len())?;
            Ok::<_, anyhow::Error>(root)
        })().map_err(|error| {
            let failure = WorkerPrelaunchFailedReceipt {
                identity: identity.clone(), error: error.to_string(),
            };
            match write_immutable_attempt_receipt(&attempt, WORKER_PRELAUNCH_FAILED_RECEIPT, &failure) {
                Ok(()) => error.context("native path preflight failed before the solver was launched"),
                Err(receipt_error) => receipt_error.context(format!("could not record prelaunch failure: {error:#}")),
            }
        })?;
        let mut progress = ProgressWriter {
            root: &attempt,
            step,
            frequency_count: prepared.frequency_plan().frequencies_hz.values_hz.len() as u64,
            sequence: 0,
            last_write: None,
        };
        let outcome = adapter::execute(
            &prepared,
            step,
            native_root,
            native_root,
            interrupt,
            |update| progress.observe(update),
        )?;
        let (status, count, outputs) = match outcome {
            adapter::FrequencyResponseOutcome::Cancelled {
                completed_frequency_count,
            } => (RunStatus::Cancelled, completed_frequency_count, Vec::new()),
            adapter::FrequencyResponseOutcome::Completed {
                outputs,
                completed_frequency_count,
                ..
            } => (RunStatus::Completed, completed_frequency_count, outputs),
        };
        if status == RunStatus::Completed {
            if let Some(storage) = &mut storage {
                storage.finish(true, &attempt)?;
            }
            persist_completed_worker_execution(
                store,
                &attempt,
                &identity,
                &study_step.outputs,
                status,
                count,
                &outputs,
                None,
                None,
                None,
                None,
            )?;
            adapter::restore_published_closure(&outputs, &prepared, &attempt.join("analysis"))?;
        }
        Ok(AcceptedRunnerExecution {
            terminal_publication: None,
            status,
            completed_step_count: count,
            outputs,
            attempt_output_dir: attempt.clone(),
            recovered_from_receipt: false,
            accepted_state_ref: None,
            observation_source: None,
            terminal_stats: None,
            completion: None,
        })
    })();
    if let Some(storage) = &mut storage {
        match &execution {
            Ok(result) if result.status == RunStatus::Cancelled => {
                storage.note_outcome("cancelled", None)
            }
            Err(error) => storage.note_outcome("failed", Some(format!("{error:#}"))),
            _ => {}
        }
        storage.finish(
            execution
                .as_ref()
                .is_ok_and(|r| r.status == RunStatus::Completed),
            &attempt,
        )?;
    }
    execution
}
