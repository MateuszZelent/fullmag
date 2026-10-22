use anyhow::{bail, Context, Result};
use fullmag_application::DecodedStudyArtifact;
use fullmag_authoring::{
    StudyAcceptancePolicy, StudyInputPort, StudyInputSource, StudyOutputPort, StudyPortDataKind,
};
use fullmag_ir::ExecutionPlanIR;
use fullmag_runner::{
    AcceptedStateGeneration, AcceptedStateId, AcceptedStateRef, FdmCpuAcceptedStateSnapshotV1,
    FdmGpuAcceptedStateSnapshotV1, FdmMultilayerObservationLane,
    FdmMultilayerObservationSnapshotV1, RunResult, RunStatus, StepAction,
    FDM_CPU_ACCEPTED_STATE_SNAPSHOT_FILE, FDM_GPU_ACCEPTED_STATE_SNAPSHOT_FILE,
    FDM_MULTILAYER_OBSERVATION_SNAPSHOT_FILE,
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
pub(crate) const RUNNER_FINAL_STATE_FILE: &str = "m_final.json";
const WORKER_EXECUTION_STARTED_RECEIPT: &str = "worker_execution_started.v1.json";
const WORKER_PRELAUNCH_FAILED_RECEIPT: &str = "worker_prelaunch_failed.v1.json";
const WORKER_EXECUTION_COMPLETED_RECEIPT: &str = "worker_execution_completed.v1.json";
const WORKER_EXECUTION_RECEIPT_SCHEMA: &str = "fullmag.accepted_worker_execution.v1";

// Live observation channel (accepted worker -> current-live projector).
//
// The accepted worker is a separate process. It publishes a bounded,
// overwritten observation sidecar in its private attempt directory; the API
// projector reads that sidecar for a `Running` task and turns it into the
// ordinary current-live resource revisions. The sidecar is not a durable
// output: it is not CAS-pinned, never replaces the final accepted state, and is
// removed when the solver returns. Transfer cost is bounded twice: the runner
// copies magnetization from the device only every
// `ACCEPTED_LIVE_FIELD_EVERY_N` steps, and the worker writes at most one
// scalar header per `ACCEPTED_LIVE_SCALAR_MIN_INTERVAL` and one magnetization
// payload per `ACCEPTED_LIVE_FIELD_MIN_INTERVAL`.
pub(crate) const ACCEPTED_LIVE_OBSERVATION_FILE: &str = "live_observation.v1.json";
pub(crate) const ACCEPTED_LIVE_OBSERVATION_SCHEMA: &str = "fullmag.accepted_live_observation.v1";
const ACCEPTED_LIVE_MAGNETIZATION_PREFIX: &str = "live_observation_m.";
const ACCEPTED_LIVE_MAGNETIZATION_SUFFIX: &str = ".f64le";
pub(crate) const ACCEPTED_LIVE_FIELD_EVERY_N: u64 = 1;
const ACCEPTED_LIVE_SCALAR_MIN_INTERVAL: Duration = Duration::from_millis(500);
const ACCEPTED_LIVE_FIELD_MIN_INTERVAL: Duration = Duration::ZERO;
pub(crate) const ACCEPTED_OBSERVABLE_CAPTURE_FILE: &str = "accepted_observables_capture.v1.json";
const ACCEPTED_LIVE_MAX_FIELD_BYTES: u64 = 128 * 1024 * 1024;
/// Upper bound for one live magnetization payload (2^21 samples = 48 MiB).
pub(crate) const ACCEPTED_LIVE_MAX_MAGNETIZATION_SAMPLES: usize = 1 << 21;
const ACCEPTED_LIVE_HEADER_MAX_BYTES: u64 = 256 * 1024;
const ACCEPTED_LIVE_RECENT_CLOCK_SAMPLES: usize = 256;

/// Bounded live observation header written by an accepted worker attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AcceptedLiveObservationHeader {
    pub(crate) schema_version: String,
    pub(crate) run_id: String,
    pub(crate) task_id: String,
    pub(crate) step_id: String,
    pub(crate) attempt_id: String,
    pub(crate) ownership_epoch: u64,
    /// Requested realization lane, e.g. `fdm_gpu` or `fem_cpu`.
    pub(crate) realization: String,
    pub(crate) sequence: u64,
    pub(crate) written_at_unix_ms: u64,
    /// Bounded scalar runner statistics of the latest accepted step.
    pub(crate) stats: fullmag_runner::StepStats,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) magnetization: Option<AcceptedLiveMagnetizationRef>,
}

/// Reference to the latest bounded live magnetization payload.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct AcceptedLiveMagnetizationRef {
    pub(crate) sequence: u64,
    pub(crate) source_step: u64,
    pub(crate) source_time_s: f64,
    pub(crate) solver_dt_s: f64,
    pub(crate) sample_count: u64,
    pub(crate) file_name: String,
    pub(crate) content_sha256: String,
    /// Exact study layout of the pinned execution plan.
    pub(crate) layout: serde_json::Value,
    pub(crate) space_fingerprint: String,
    /// Present only for native FEM local-node AoS payloads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) fem_local_node_map: Option<fullmag_runner::LiveFemLocalNodeMapIdentity>,
    /// Other complete quantities in the same binary payload and source frame.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) fields: Vec<AcceptedLiveFieldRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct AcceptedLiveFieldRef {
    pub(crate) quantity_id: String,
    pub(crate) n_comp: usize,
    /// Offset in f64 values, after the complete magnetization payload.
    pub(crate) value_offset: u64,
    pub(crate) value_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) spatial_kind: Option<String>,
}

/// Decoded live observation for one running accepted task attempt.
#[derive(Debug, Clone)]
pub(crate) struct AcceptedLiveObservation {
    pub(crate) header: AcceptedLiveObservationHeader,
    /// Present only when the payload referenced by the header was read and
    /// verified in this poll.
    pub(crate) magnetization_values: Option<Vec<[f64; 3]>>,
    pub(crate) fields: Vec<fullmag_runner::AcceptedMaterializedField>,
}

struct AcceptedLiveMagnetizationDomain {
    layout: serde_json::Value,
    space_fingerprint: String,
    sample_count: usize,
    full_generation_bytes: u64,
}

/// Worker-side writer of the bounded live observation sidecar. Every failure
/// is logged and swallowed: live observation never changes solver control,
/// the durable Start/Stop protocol, or the final accepted outputs.
pub(crate) struct AcceptedLiveObservationWriter {
    attempt_output_dir: PathBuf,
    run_id: String,
    task_id: String,
    step_id: String,
    attempt_id: String,
    ownership_epoch: u64,
    realization: String,
    magnetization_domain: Option<AcceptedLiveMagnetizationDomain>,
    max_magnetization_bytes: u64,
    sequence: u64,
    magnetization_sequence: u64,
    last_scalar_write: Option<Instant>,
    last_field_write: Option<Instant>,
    current_magnetization: Option<AcceptedLiveMagnetizationRef>,
    recent_clock: std::collections::VecDeque<(u64, f64, f64)>,
    reported_failure: bool,
    terminal_spool: Option<crate::accepted_observation_spool::TerminalObservationSpool>,
    terminal_storage_budget: u64,
    terminal_field_budget: u64,
}

impl AcceptedLiveObservationWriter {
    pub(crate) fn new(
        attempt_output_dir: &Path,
        accepted_step: &AcceptedWorkerStep,
        execution_plan: &ExecutionPlanIR,
        realization: String,
    ) -> Self {
        let mut magnetization_domain = accepted_live_magnetization_domain(execution_plan);
        if let Some(domain) = magnetization_domain.as_mut() {
            let lane = match realization.as_str() {
                "fdm_cpu" => Some(fullmag_runner::AcceptedMaterializationLane::FdmCpu),
                "fdm_gpu" => Some(fullmag_runner::AcceptedMaterializationLane::FdmGpu),
                "fem_cpu" => Some(fullmag_runner::AcceptedMaterializationLane::FemCpu),
                "fem_gpu" => Some(fullmag_runner::AcceptedMaterializationLane::FemGpu),
                _ => None,
            };
            let components = lane.and_then(|lane| fullmag_runner::accepted_observation_quantity_ids(execution_plan, lane).ok())
                .map(|ids| ids.iter().filter_map(|id| fullmag_quantities::quantity_spec(id))
                    .map(|spec| u64::from(spec.n_comp)).sum::<u64>())
                .unwrap_or(u64::MAX);
            // Include the explicit m payload beside the full field generation.
            domain.full_generation_bytes = (domain.sample_count as u64)
                .saturating_mul(components.saturating_add(3)).saturating_mul(8);
        }
        Self {
            attempt_output_dir: attempt_output_dir.to_path_buf(),
            run_id: accepted_step.claim.run_id.as_str().to_owned(),
            task_id: accepted_step.claim.task_id.as_str().to_owned(),
            step_id: accepted_step.step_id.clone(),
            attempt_id: accepted_step.claim.attempt_id.as_str().to_owned(),
            ownership_epoch: accepted_step.claim.ownership_epoch.value(),
            realization,
            magnetization_domain,
            // Two live payloads may coexist during replacement; keep both well
            // inside the attempt storage budget reserved for real outputs.
            max_magnetization_bytes: (accepted_step.claim.lease.budget.storage_bytes / 8)
                .min(accepted_step.claim.lease.budget.memory_bytes / 8)
                .min(ACCEPTED_LIVE_MAX_FIELD_BYTES),
            sequence: 0,
            magnetization_sequence: 0,
            last_scalar_write: None,
            last_field_write: None,
            current_magnetization: None,
            recent_clock: std::collections::VecDeque::new(),
            reported_failure: false,
            terminal_spool: None,
            terminal_storage_budget: accepted_step.claim.lease.budget.storage_bytes / 4,
            terminal_field_budget: accepted_step.claim.lease.budget.memory_bytes / 16,
        }
    }

    /// Avoid requesting costly device-to-host snapshots when the bounded
    /// observation writer cannot publish this plan's magnetization domain.
    /// Scalar headers remain enabled independently of this cadence.
    pub(crate) fn field_sampling_interval(&self) -> u64 {
        let publishable = self.magnetization_domain.as_ref().is_some_and(|domain| {
            domain.sample_count > 0
                && domain.sample_count <= ACCEPTED_LIVE_MAX_MAGNETIZATION_SAMPLES
                && u64::try_from(domain.sample_count.saturating_mul(3).saturating_mul(8))
                    .is_ok_and(|bytes| bytes <= self.max_magnetization_bytes)
        });
        if publishable {
            if self.magnetization_domain.as_ref().is_some_and(|domain| {
                domain.full_generation_bytes <= self.max_magnetization_bytes
            }) {
                ACCEPTED_LIVE_FIELD_EVERY_N
            } else {
                // Keep the pre-existing bounded m/preview path for domains
                // whose complete generation exceeds the admitted live budget.
                100
            }
        } else {
            u64::MAX
        }
    }

    /// Observe one runner update. Always returns without blocking the solver
    /// on a failed write.
    pub(crate) fn observe(&mut self, update: &fullmag_runner::StepUpdate) {
        if update.terminal_field_snapshot {
            // Keep the original-context endpoint for recovery and later CAS
            // binding. It is validated against m_final, never used as state.
            if let Err(error) = self.write_terminal_capture(update) {
                self.report_failure(&error);
            }
            // Fragments belong to the durable terminal channel. Publishing
            // each fragment as a live generation would expose partial fields
            // and duplicate expensive m writes after the integrator stopped.
            return;
        }
        if update.finished {
            // The final state is committed through the durable output path.
            return;
        }
        let stats = &update.stats;
        self.recent_clock.push_back((stats.step, stats.time, stats.dt));
        while self.recent_clock.len() > ACCEPTED_LIVE_RECENT_CLOCK_SAMPLES {
            self.recent_clock.pop_front();
        }
        let now = Instant::now();
        let field_due = update.magnetization.is_some()
            && self
                .last_field_write
                .is_none_or(|last| now.duration_since(last) >= ACCEPTED_LIVE_FIELD_MIN_INTERVAL);
        let scalar_due = self
            .last_scalar_write
            .is_none_or(|last| now.duration_since(last) >= ACCEPTED_LIVE_SCALAR_MIN_INTERVAL);
        if !field_due && !scalar_due {
            return;
        }
        let mut staged_magnetization = None;
        if field_due {
            match self.write_magnetization(update) {
                Ok(Some(reference)) => staged_magnetization = Some(reference),
                Ok(None) => {}
                Err(error) => self.report_failure(&error),
            }
        }
        let previous_magnetization = staged_magnetization
            .as_ref()
            .and_then(|reference| self.current_magnetization.replace(reference.clone()));
        if let Err(error) = self.write_header(stats) {
            if let Some(staged) = staged_magnetization.as_ref() {
                self.current_magnetization = previous_magnetization;
                let _ = fs::remove_file(self.attempt_output_dir.join(&staged.file_name));
            }
            self.report_failure(&error);
            return;
        }
        self.last_scalar_write = Some(now);
        if staged_magnetization.is_some() {
            self.last_field_write = Some(now);
        }
        if let Some(previous) = previous_magnetization {
            // Best effort: the header no longer references this payload.
            let _ = fs::remove_file(self.attempt_output_dir.join(previous.file_name));
        }
    }

    /// Remove the live sidecar after the solver returned. The durable output
    /// manifest is the only source of the final accepted state.
    pub(crate) fn finish(self) {
        let _ = fs::remove_file(self.attempt_output_dir.join(ACCEPTED_LIVE_OBSERVATION_FILE));
        if let Some(reference) = self.current_magnetization {
            let _ = fs::remove_file(self.attempt_output_dir.join(reference.file_name));
        }
    }

    fn write_terminal_capture(&mut self, update: &fullmag_runner::StepUpdate) -> Result<()> {
        crate::accepted_observation_spool::write_fragment(
            &self.attempt_output_dir, &mut self.terminal_spool, update,
            self.terminal_storage_budget, self.terminal_field_budget,
        )
    }

    fn write_magnetization(
        &mut self,
        update: &fullmag_runner::StepUpdate,
    ) -> Result<Option<AcceptedLiveMagnetizationRef>> {
        let (Some(domain), Some(values)) =
            (self.magnetization_domain.as_ref(), update.magnetization.as_ref())
        else {
            return Ok(None);
        };
        let Some(carrier) = update.magnetization_carrier.as_ref() else {
            return Ok(None);
        };
        let source_clock = carrier.source_clock;
        let source_step = source_clock.accepted_step;
        let fem_local_node_map = match self.realization.as_str() {
            "fem_cpu" | "fem_gpu" => {
                let Some(map) = carrier.fem_local_node_map.as_ref() else {
                    return Ok(None);
                };
                if map.mesh_generation_id.is_empty()
                    || map.local_node_index_map_sha256.is_empty()
                    || map.node_count != domain.sample_count
                    || update.fem_mesh_generation_id.as_deref()
                        != Some(map.mesh_generation_id.as_str())
                {
                    return Ok(None);
                }
                Some(map.clone())
            }
            "fdm_cpu" | "fdm_gpu" if carrier.fem_local_node_map.is_none() => None,
            _ => return Ok(None),
        };
        if carrier.layout != domain.layout {
            return Ok(None);
        }
        if domain.sample_count == 0
            || domain.sample_count > ACCEPTED_LIVE_MAX_MAGNETIZATION_SAMPLES
            || values.len() != domain.sample_count.saturating_mul(3)
            || values.iter().any(|value| !value.is_finite())
        {
            // A live payload that does not exactly match the pinned study
            // domain is not published; there is no interpolation or remap.
            return Ok(None);
        }
        let byte_count = u64::try_from(values.len().saturating_mul(8)).unwrap_or(u64::MAX);
        if byte_count > self.max_magnetization_bytes {
            return Ok(None);
        }
        // An asynchronous native handoff may deliver magnetization from an
        // earlier accepted step. Bind it to that step's own clock, or skip it.
        if update
            .stats
            .magnetization_source_step
            .is_some_and(|step| step != source_step)
        {
            return Ok(None);
        }
        let Some(&(_, source_time_s, solver_dt_s)) = self
            .recent_clock
            .iter()
            .rev()
            .find(|(step, _, _)| *step == source_step)
        else {
            return Ok(None);
        };
        let expected_dt = (solver_dt_s > 0.0).then_some(solver_dt_s);
        if !source_time_s.is_finite()
            || source_time_s < 0.0
            || source_clock.time_seconds.to_bits() != source_time_s.to_bits()
            || source_clock.dt_seconds != expected_dt
            || source_clock.validate().is_err()
        {
            return Ok(None);
        }
        let capture = fullmag_runner::capture_solver_observables(update)
            .map_err(anyhow::Error::msg)?;
        let mut bytes = Vec::with_capacity(values.len() * 8);
        for value in values {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        let mut fields = Vec::new();
        if let Some(capture) = capture {
            for field in capture.fields {
                if field.quantity_id == "m" { continue; }
                let field_bytes = (field.values.len() as u64).saturating_mul(8);
                if (bytes.len() as u64).saturating_add(field_bytes) > self.max_magnetization_bytes {
                    // A complete quantity is either present or absent. Never
                    // truncate its samples to satisfy the observation budget.
                    continue;
                }
                fields.push(AcceptedLiveFieldRef {
                    quantity_id: field.quantity_id,
                    n_comp: field.n_comp,
                    value_offset: (bytes.len() / 8) as u64,
                    value_count: field.values.len() as u64,
                    spatial_kind: field.spatial_kind,
                });
                for value in field.values { bytes.extend_from_slice(&value.to_le_bytes()); }
            }
        }
        let sequence = self.magnetization_sequence.saturating_add(1);
        let file_name = format!(
            "{ACCEPTED_LIVE_MAGNETIZATION_PREFIX}{sequence}{ACCEPTED_LIVE_MAGNETIZATION_SUFFIX}"
        );
        write_live_file_atomically(&self.attempt_output_dir, &file_name, &bytes)?;
        self.magnetization_sequence = sequence;
        Ok(Some(AcceptedLiveMagnetizationRef {
            sequence,
            source_step,
            source_time_s,
            solver_dt_s,
            sample_count: domain.sample_count as u64,
            file_name,
            content_sha256: fullmag_application::study_artifact_content_sha256(&bytes),
            layout: domain.layout.clone(),
            space_fingerprint: domain.space_fingerprint.clone(),
            fem_local_node_map,
            fields,
        }))
    }

    fn write_header(&mut self, stats: &fullmag_runner::StepStats) -> Result<()> {
        let sequence = self.sequence.saturating_add(1);
        let header = AcceptedLiveObservationHeader {
            schema_version: ACCEPTED_LIVE_OBSERVATION_SCHEMA.to_owned(),
            run_id: self.run_id.clone(),
            task_id: self.task_id.clone(),
            step_id: self.step_id.clone(),
            attempt_id: self.attempt_id.clone(),
            ownership_epoch: self.ownership_epoch,
            realization: self.realization.clone(),
            sequence,
            written_at_unix_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
                .unwrap_or(0),
            stats: stats.clone(),
            magnetization: self.current_magnetization.clone(),
        };
        let bytes = serde_json::to_vec(&header).context("serialize live observation header")?;
        if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > ACCEPTED_LIVE_HEADER_MAX_BYTES {
            bail!("live observation header exceeds its bounded size");
        }
        write_live_file_atomically(&self.attempt_output_dir, ACCEPTED_LIVE_OBSERVATION_FILE, &bytes)?;
        self.sequence = sequence;
        Ok(())
    }

    fn report_failure(&mut self, error: &anyhow::Error) {
        if !self.reported_failure {
            self.reported_failure = true;
            eprintln!(
                "accepted worker live observation disabled for this publication: {error:#}"
            );
        }
    }
}

fn accepted_live_magnetization_domain(
    execution_plan: &ExecutionPlanIR,
) -> Option<AcceptedLiveMagnetizationDomain> {
    let (expected_backend, sample_count) = match &execution_plan.backend_plan {
        fullmag_ir::BackendPlanIR::Fdm(fdm) => ("fdm", fdm.initial_magnetization.len()),
        fullmag_ir::BackendPlanIR::FdmMultilayer(multilayer) => {
            let layout = fullmag_runner::study_magnetization_layout_for_plan(execution_plan).ok()?;
            let layout_layers = layout.get("layers")?.as_array()?;
            if layout_layers.len() != multilayer.layers.len() {
                return None;
            }
            let mut expected_offset = 0usize;
            for (layer, descriptor) in multilayer.layers.iter().zip(layout_layers) {
                let offset = descriptor.get("value_offset")?.as_u64()?;
                let count = descriptor.get("value_count")?.as_u64()?;
                if usize::try_from(offset).ok()? != expected_offset
                    || usize::try_from(count).ok()? != layer.initial_magnetization.len()
                    || descriptor.get("layer_id").and_then(serde_json::Value::as_str)
                        != Some(layer.layer_id.as_str())
                {
                    return None;
                }
                expected_offset = expected_offset.checked_add(layer.initial_magnetization.len())?;
            }
            ("fdm_multilayer", expected_offset)
        }
        fullmag_ir::BackendPlanIR::Fem(fem) if fem.fe_order == 1 => {
            ("fem", fem.mesh.nodes.len())
        }
        _ => return None,
    };
    let layout = fullmag_runner::study_magnetization_layout_for_plan(execution_plan).ok()?;
    if layout.get("backend").and_then(serde_json::Value::as_str) != Some(expected_backend) {
        return None;
    }
    let space_fingerprint = fullmag_application::study_state_layout_sha256(&layout).ok()?;
    Some(AcceptedLiveMagnetizationDomain {
        layout,
        space_fingerprint,
        sample_count,
        full_generation_bytes: u64::MAX,
    })
}

fn validate_accepted_worker_parameters(
    parameters: &serde_json::Value,
    accepted_step_id: &str,
) -> Result<()> {
    let parameters = parameters
        .as_object()
        .context("accepted worker RunSpec parameters must be an object")?;
    for key in parameters.keys() {
        if key != "live_workspace" && key != fullmag_session::ACCEPTED_RUN_START_POLICY_KEY {
            bail!("accepted worker has no binding for RunSpec parameter `{key}`");
        }
    }

    if let Some(policy) = parameters.get(fullmag_session::ACCEPTED_RUN_START_POLICY_KEY) {
        let expected = serde_json::json!({
            "schema_version": "accepted_run_start_policy.v1",
            "mode": "manual",
        });
        if policy != &expected {
            bail!("accepted worker received an unsupported run-start policy");
        }
    }

    if let Some(live_workspace) = parameters.get("live_workspace") {
        let live_workspace = live_workspace
            .as_object()
            .context("accepted worker live_workspace metadata must be an object")?;
        const ALLOWED_LIVE_WORKSPACE_KEYS: &[&str] = &[
            "api_instance_id",
            "session_id",
            "session_epoch",
            "scene_revision",
            "execution_input",
            "command_id",
            "request_idempotency_key",
            "step_id",
            "command",
            "startup_source_sha256",
        ];
        if let Some(key) = live_workspace
            .keys()
            .find(|key| !ALLOWED_LIVE_WORKSPACE_KEYS.contains(&key.as_str()))
        {
            bail!("accepted worker has no binding for live_workspace field `{key}`");
        }
        for key in ["api_instance_id", "session_id"] {
            if live_workspace
                .get(key)
                .and_then(serde_json::Value::as_str)
                .is_none_or(str::is_empty)
            {
                bail!("accepted worker live_workspace field `{key}` is invalid");
            }
        }
        if live_workspace
            .get("session_epoch")
            .and_then(serde_json::Value::as_u64)
            .is_none()
            || live_workspace
                .get("scene_revision")
                .and_then(serde_json::Value::as_u64)
                .is_none()
        {
            bail!("accepted worker live_workspace revision metadata is invalid");
        }
        if let Some(identity) = live_workspace.get("execution_input") {
            let identity = identity
                .as_object()
                .context("accepted worker execution_input metadata must be an object")?;
            if identity.len() != 2
                || identity.get("schema_version").and_then(serde_json::Value::as_str)
                    != Some("fullmag.scene_execution_input.v1")
                || identity
                    .get("sha256")
                    .and_then(serde_json::Value::as_str)
                    .is_none_or(|digest| {
                        digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                    })
            {
                bail!("accepted worker execution_input identity is invalid");
            }
        }
        for key in ["command_id", "request_idempotency_key"] {
            if let Some(value) = live_workspace.get(key) {
                if !value.is_null()
                    && value
                        .as_str()
                        .is_none_or(|value| value.trim().is_empty())
                {
                    bail!("accepted worker live_workspace field `{key}` is invalid");
                }
            }
        }
        if let Some(step_id) = live_workspace.get("step_id") {
            if !step_id.is_null()
                && step_id.as_str().is_none_or(|step_id| step_id != accepted_step_id)
            {
                bail!("accepted worker live_workspace step binding does not match its task");
            }
        }
        if let Some(command) = live_workspace.get("command") {
            if !command.is_null() && !command.is_object() {
                bail!("accepted worker live_workspace command metadata is invalid");
            }
        }
        if let Some(source_digest) = live_workspace.get("startup_source_sha256") {
            if !source_digest.is_null()
                && source_digest.as_str().is_none_or(|digest| {
                    digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
            {
                bail!("accepted worker startup source identity is invalid");
            }
        }
    }

    Ok(())
}

pub(crate) fn write_live_file_atomically(dir: &Path, file_name: &str, bytes: &[u8]) -> Result<()> {
    let temporary = dir.join(format!(".{file_name}.tmp"));
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)
            .with_context(|| format!("open live observation file `{}`", temporary.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("write live observation file `{}`", temporary.display()))?;
    }
    fs::rename(&temporary, dir.join(file_name))
        .with_context(|| format!("publish live observation file `{file_name}`"))
}

/// Read the live observation of one running accepted task attempt. Returns
/// `Ok(None)` when the attempt has not published one. The magnetization
/// payload is read only when its sequence differs from
/// `known_magnetization_sequence`; a payload that was replaced between the
/// header and payload reads is treated as not yet available.
pub(crate) fn read_accepted_live_observation(
    store_root: &Path,
    run_id: &str,
    task_id: &str,
    step_id: &str,
    attempt_id: &str,
    ownership_epoch: u64,
    known_magnetization_sequence: Option<u64>,
) -> Result<Option<AcceptedLiveObservation>> {
    for value in [run_id, task_id, attempt_id] {
        fullmag_session::repository_path::validate_store_id(value)
            .context("accepted live observation identity is invalid")?;
    }
    let attempt_dir = store_root
        .join("runs")
        .join(run_id)
        .join("worker-attempts")
        .join(task_id)
        .join(attempt_id)
        .join(format!("epoch-{ownership_epoch}"));
    match fs::symlink_metadata(attempt_dir.join(ACCEPTED_LIVE_OBSERVATION_FILE)) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("inspect accepted live observation"),
    }
    let header_bytes = match read_explicit_runner_artifact(
        &attempt_dir,
        ACCEPTED_LIVE_OBSERVATION_FILE,
        ACCEPTED_LIVE_HEADER_MAX_BYTES,
    ) {
        Ok(bytes) => bytes,
        // The worker may have removed the sidecar after the solver returned.
        Err(_) => return Ok(None),
    };
    let header: AcceptedLiveObservationHeader = serde_json::from_slice(&header_bytes)
        .context("decode accepted live observation header")?;
    if header.schema_version != ACCEPTED_LIVE_OBSERVATION_SCHEMA
        || header.run_id != run_id
        || header.task_id != task_id
        || header.step_id != step_id
        || header.attempt_id != attempt_id
        || header.ownership_epoch != ownership_epoch
    {
        bail!("accepted live observation identity differs from its task attempt");
    }
    let mut magnetization_values = None;
    let mut fields = Vec::new();
    if let Some(reference) = header.magnetization.as_ref() {
        if known_magnetization_sequence != Some(reference.sequence) {
            if let Some((values, decoded_fields)) = read_live_magnetization(&attempt_dir, reference)? {
                magnetization_values = Some(values);
                fields = decoded_fields;
            }
        }
    }
    Ok(Some(AcceptedLiveObservation {
        header,
        magnetization_values,
        fields,
    }))
}

#[allow(dead_code)]
fn read_live_magnetization(
    attempt_dir: &Path,
    reference: &AcceptedLiveMagnetizationRef,
) -> Result<Option<(Vec<[f64; 3]>, Vec<fullmag_runner::AcceptedMaterializedField>)>> {
    if !reference.file_name.starts_with(ACCEPTED_LIVE_MAGNETIZATION_PREFIX)
        || !reference.file_name.ends_with(ACCEPTED_LIVE_MAGNETIZATION_SUFFIX)
        || reference.file_name.contains(['/', '\\'])
    {
        bail!("accepted live magnetization file name is invalid");
    }
    let sample_count = usize::try_from(reference.sample_count)
        .ok()
        .filter(|count| *count > 0 && *count <= ACCEPTED_LIVE_MAX_MAGNETIZATION_SAMPLES)
        .context("accepted live magnetization sample count is outside its bound")?;
    let mut value_count = sample_count * 3;
    let mut seen = BTreeSet::new();
    for field in &reference.fields {
        let spec = fullmag_quantities::quantity_spec(&field.quantity_id)
            .context("accepted live field quantity is unknown")?;
        if field.quantity_id == "m" || !seen.insert(field.quantity_id.as_str())
            || !matches!(spec.shape, fullmag_quantities::QuantityShape::VectorField | fullmag_quantities::QuantityShape::SpatialScalar)
            || field.n_comp != spec.n_comp as usize || field.n_comp == 0
            || usize::try_from(field.value_offset).ok() != Some(value_count)
            || usize::try_from(field.value_count).ok() != sample_count.checked_mul(field.n_comp)
        { bail!("accepted live quantity shape or binary offset is invalid"); }
        value_count = value_count.checked_add(sample_count.checked_mul(field.n_comp)
            .context("accepted live field value count overflows")?)
            .context("accepted live binary value count overflows")?;
    }
    let expected_bytes = value_count.checked_mul(8).context("accepted live binary size overflows")?;
    if expected_bytes as u64 > ACCEPTED_LIVE_MAX_FIELD_BYTES {
        bail!("accepted live fields exceed their binary payload bound");
    }
    let bytes = match read_explicit_runner_artifact(
        attempt_dir,
        &reference.file_name,
        expected_bytes as u64,
    ) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    if bytes.len() != expected_bytes
        || fullmag_application::study_artifact_content_sha256(&bytes) != reference.content_sha256
    {
        // Replaced or truncated between the header and payload reads.
        return Ok(None);
    }
    let mut values = Vec::with_capacity(sample_count);
    for chunk in bytes[..sample_count * 24].chunks_exact(24) {
        let component = |offset: usize| {
            let mut raw = [0u8; 8];
            raw.copy_from_slice(&chunk[offset..offset + 8]);
            f64::from_le_bytes(raw)
        };
        let value = [component(0), component(8), component(16)];
        if value.iter().any(|item| !item.is_finite()) {
            bail!("accepted live magnetization contains a non-finite sample");
        }
        values.push(value);
    }
    let backend = reference.layout.get("backend").and_then(serde_json::Value::as_str)
        .context("accepted live field layout has no backend")?;
    let (carrier_id, role) = match backend {
        "fdm" => ("fdm:magnetic", "magnetic"),
        "fdm_multilayer" => ("fdm_multilayer:native_layers", "layer_native"),
        "fem" => ("fem:local_nodes", "magnetic"),
        _ => bail!("accepted live field backend is invalid"),
    };
    let mut fields = Vec::with_capacity(reference.fields.len());
    for field in &reference.fields {
        let start = usize::try_from(field.value_offset)?.checked_mul(8).context("field offset overflows")?;
        let len = usize::try_from(field.value_count)?.checked_mul(8).context("field length overflows")?;
        let values = bytes[start..start + len].chunks_exact(8).map(|chunk| {
            let mut raw = [0u8; 8]; raw.copy_from_slice(chunk); f64::from_le_bytes(raw)
        }).collect::<Vec<_>>();
        if values.iter().any(|value| !value.is_finite()) { bail!("accepted live field contains nonfinite values"); }
        fields.push(fullmag_runner::AcceptedMaterializedField {
            quantity_id: field.quantity_id.clone(), carrier_id: carrier_id.into(), role: role.into(),
            n_comp: field.n_comp, values, layout: reference.layout.clone(),
            spatial_kind: field.spatial_kind.clone(),
        });
    }
    Ok(Some((values, fields)))
}

// Claim validation is read-only and idempotent, but it can briefly contend
// with the supervisor heartbeat writer. Keep this retry local to claim
// validation; never replay worker startup or solver effects.
const ACCEPTED_WORKER_CLAIM_RETRY_LIMIT: Duration = Duration::from_secs(30);
const ACCEPTED_WORKER_CLAIM_RETRY_DELAY: Duration = Duration::from_millis(10);

pub(crate) struct AcceptedRunnerExecution {
    pub(crate) terminal_publication: Option<fullmag_runtime_control::PreparedTerminalPublicationV4>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerExecutionCompletedReceiptV2 {
    schema_version: String,
    identity: WorkerExecutionReceiptIdentity,
    status: RunStatus,
    completed_step_count: usize,
    outputs: Vec<WorkerExecutionOutputReference>,
    accepted_state_ref: AcceptedStateRef,
    terminal_publication: fullmag_runtime_control::PreparedTerminalPublicationV4,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WorkerExecutionCompletedReceiptWire {
    V1(WorkerExecutionCompletedReceipt),
    V2(WorkerExecutionCompletedReceiptV2),
}

/// Reserve one private runner output directory for the exact active task
/// attempt. The leaf is exclusive; workers must also pass the durable inbox
/// before invoking the solver, and must reconcile rather than replay a pending
/// command after restart.
pub(crate) fn create_private_attempt_output_dir(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
) -> Result<PathBuf> {
    verify_host_worker_launch(store, claim)?;
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
    let current_claim = retry_worker_claim_store_busy(
        store,
        claim.run_id.as_str(),
        claim.task_id.as_str(),
        || fullmag_runtime_control::load_current_task_claim(
            store,
            &claim.run_id,
            claim.task_id.as_str(),
        ),
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AcceptedFemRuntime {
    pub(crate) resolved_device: String,
    pub(crate) gpu_uuid: Option<String>,
}

/// Resolve the FEM lane from the authoritative lease rather than from a
/// process environment or a resource-id naming convention.
pub(crate) fn resolve_requested_fem_device(
    requested: &str,
    kind: fullmag_session::FmsResourceKind,
    gpu_memory_bytes: u64,
) -> Result<&'static str> {
    match (kind, gpu_memory_bytes) {
        (fullmag_session::FmsResourceKind::Cpu, 0) => match requested {
            "auto" | "cpu" => Ok("cpu"),
            "gpu" => bail!("accepted FEM GPU request has a CPU lease"),
            other => bail!("accepted FEM request has unsupported device `{other}`"),
        },
        (fullmag_session::FmsResourceKind::Gpu, value) if value > 0 => match requested {
            "auto" | "gpu" => Ok("gpu"),
            "cpu" => bail!("accepted FEM CPU request has a GPU lease"),
            other => bail!("accepted FEM request has unsupported device `{other}`"),
        },
        (fullmag_session::FmsResourceKind::Cpu, _) => {
            bail!("CPU FEM lease must have zero GPU budget")
        }
        (fullmag_session::FmsResourceKind::Gpu, 0) => {
            bail!("GPU FEM lease must have a positive GPU budget")
        }
        (kind, _) => bail!("accepted FEM requires a CPU or GPU lease, got {kind:?}"),
    }
}

fn validate_active_fms_lease_matches_claim(
    lease: &fullmag_session::FmsResourceLease,
    claim: &fullmag_application::TaskClaim,
) -> Result<()> {
    if lease.state != fullmag_session::FmsResourceLeaseState::Active {
        bail!("worker execution requires an active local lease");
    }
    let kind_matches = match (&claim.lease.kind, lease.kind) {
        (
            fullmag_application::ResourceKind::Cpu,
            fullmag_session::FmsResourceKind::Cpu,
        )
        | (
            fullmag_application::ResourceKind::Gpu,
            fullmag_session::FmsResourceKind::Gpu,
        )
        | (
            fullmag_application::ResourceKind::Storage,
            fullmag_session::FmsResourceKind::Storage,
        )
        | (
            fullmag_application::ResourceKind::Meshing,
            fullmag_session::FmsResourceKind::Meshing,
        ) => true,
        _ => false,
    };
    let budget_matches = lease.budget.cpu_millis == claim.lease.budget.cpu_millis
        && lease.budget.memory_bytes == claim.lease.budget.memory_bytes
        && lease.budget.gpu_memory_bytes == claim.lease.budget.gpu_memory_bytes
        && lease.budget.storage_bytes == claim.lease.budget.storage_bytes;
    if lease.run_id != claim.run_id.as_str()
        || lease.task_id != claim.task_id.as_str()
        || lease.attempt_id != claim.attempt_id.as_str()
        || lease.ownership_epoch != claim.ownership_epoch.value()
        || lease.resource_id != claim.lease.resource_id
        || lease.lease_token != claim.lease.lease_token.as_str()
        || !kind_matches
        || !budget_matches
        || lease.heartbeat_sequence < claim.lease.heartbeat_sequence
    {
        bail!("active local lease does not match the worker task claim");
    }
    Ok(())
}

/// The durable lease is authoritative; omitting a CLI flag cannot downgrade a
/// host-bound attempt into the legacy execution path. Lock order is host→store.
fn verify_host_worker_launch_for_claim(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
    require_gpu_binding: bool,
) -> Result<Option<String>> {
    let lease = retry_worker_claim_store_busy(
        store,
        claim.run_id.as_str(),
        claim.task_id.as_str(),
        || {
            store.read_active_resource_lease_for_task(
                claim.run_id.as_str(),
                claim.task_id.as_str(),
            )
        },
    )?
    .context("worker execution requires its active local lease")?;
    validate_active_fms_lease_matches_claim(&lease, claim)?;
    let require_gpu_binding =
        requires_gpu_host_binding(lease.kind, require_gpu_binding);
    let Some(binding) = lease.host_launch_binding.as_ref() else {
        if require_gpu_binding {
            bail!("accepted GPU execution requires a host launch binding");
        }
        return Ok(None);
    };
    let token = std::env::var("FULLMAG_HOST_LAUNCH_TOKEN")
        .context("host-bound worker requires its supervisor launch permit")?;
    let ledger = retry_worker_claim_store_busy(
        store,
        claim.run_id.as_str(),
        claim.task_id.as_str(),
        || {
            fullmag_session::host_resource_ledger::HostResourceLedger::open_for_current_application(
                &binding.ledger_root,
                binding.policy.clone(),
            )
        },
    )?;
    if binding.policy.requires_runtime_readiness() {
        let expected_generation = binding.require_runtime_generation_sha256()?;
        retry_worker_claim_store_busy(
            store,
            claim.run_id.as_str(),
            claim.task_id.as_str(),
            || ledger.validate_runtime_generation(expected_generation),
        )?;
    }
    let reservation = retry_worker_claim_store_busy(
        store,
        claim.run_id.as_str(),
        claim.task_id.as_str(),
        || ledger.validate_worker_launch(store, &lease, &token),
    )?;
    if lease.kind == fullmag_session::FmsResourceKind::Gpu {
        if reservation.exclusive_gpu_uuids.len() != 1
            || reservation.gpu_vram_bytes_by_uuid.len() != 1
        {
            bail!("host GPU worker has no exact single-device allocation");
        }
        let uuid = reservation
            .exclusive_gpu_uuids
            .iter()
            .next()
            .context("host GPU worker has no physical allocation")?;
        if reservation.budget.gpu_memory_bytes != lease.budget.gpu_memory_bytes
            || reservation.gpu_vram_bytes_by_uuid.get(uuid)
                != Some(&lease.budget.gpu_memory_bytes)
            || std::env::var("CUDA_VISIBLE_DEVICES").ok().as_deref() != Some(uuid.as_str())
            || std::env::var("FULLMAG_FDM_GPU_INDEX").ok().as_deref() != Some("0")
            || std::env::var("FULLMAG_FEM_GPU_INDEX").ok().as_deref() != Some("0")
        {
            bail!("host GPU worker environment differs from its exact single-device allocation");
        }
        return Ok(Some(uuid.clone()));
    }
    Ok(None)
}

fn requires_gpu_host_binding(
    lease_kind: fullmag_session::FmsResourceKind,
    caller_requires_gpu_binding: bool,
) -> bool {
    caller_requires_gpu_binding || lease_kind == fullmag_session::FmsResourceKind::Gpu
}

fn verify_host_worker_launch(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
) -> Result<()> {
    verify_host_worker_launch_for_claim(store, claim, false).map(|_| ())
}

pub(crate) fn resolve_accepted_fem_runtime(
    store: &SessionStore,
    accepted_step: &AcceptedWorkerStep,
) -> Result<AcceptedFemRuntime> {
    let lease = retry_worker_claim_store_busy(
        store,
        accepted_step.claim.run_id.as_str(),
        accepted_step.claim.task_id.as_str(),
        || {
            store.read_active_resource_lease_for_task(
                accepted_step.claim.run_id.as_str(),
                accepted_step.claim.task_id.as_str(),
            )
        },
    )?
    .context("accepted FEM execution requires its active local lease")?;
    validate_active_fms_lease_matches_claim(&lease, &accepted_step.claim)?;
    let resolved_device = resolve_requested_fem_device(
        accepted_step.resolved_input.requested_execution.device.as_str(),
        lease.kind,
        lease.budget.gpu_memory_bytes,
    )?;
    let gpu_uuid = verify_host_worker_launch_for_claim(
        store,
        &accepted_step.claim,
        resolved_device == "gpu",
    )?;
    if resolved_device == "gpu" && gpu_uuid.is_none() {
        bail!("accepted FEM GPU execution has no authoritative device UUID");
    }
    Ok(AcceptedFemRuntime {
        resolved_device: resolved_device.to_owned(),
        gpu_uuid,
    })
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
    if metadata.len() > fullmag_session::MAX_TERMINAL_CATALOG_METADATA_BYTES {
        bail!("worker receipt exceeds existing control-document metadata budget");
    }
    let bytes = read_explicit_runner_artifact(attempt_output_dir,file_name,
        fullmag_session::MAX_TERMINAL_CATALOG_METADATA_BYTES)?;
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
    if matches!(
        &accepted_step.execution_plan.backend_plan,
        fullmag_ir::BackendPlanIR::FdmMultilayer(_)
    ) {
        return accepted_fdm_multilayer_observation_state_ref(
            attempt_output_dir,
            accepted_step,
            required_for_supported_lane,
        );
    }
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

fn accepted_fdm_multilayer_observation_state_ref(
    attempt_output_dir: &Path,
    accepted_step: &AcceptedWorkerStep,
    required_for_supported_lane: bool,
) -> Result<Option<AcceptedStateRef>> {
    let requested_device = accepted_step
        .resolved_input
        .requested_execution
        .device
        .as_str();
    let snapshot_path = attempt_output_dir.join(FDM_MULTILAYER_OBSERVATION_SNAPSHOT_FILE);
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
                    "inspect FDM multilayer observation snapshot `{}`",
                    snapshot_path.display()
                )
            });
        }
    }
    let snapshot_bytes = read_explicit_runner_artifact(
        attempt_output_dir,
        FDM_MULTILAYER_OBSERVATION_SNAPSHOT_FILE,
        64 * 1024,
    )
    .context("read FDM multilayer observation snapshot")?;
    let snapshot: FdmMultilayerObservationSnapshotV1 =
        serde_json::from_slice(&snapshot_bytes)
            .context("decode FDM multilayer observation snapshot")?;
    snapshot
        .validate()
        .map_err(|error| anyhow::anyhow!(error.to_string()))
        .context("validate FDM multilayer observation snapshot")?;
    let expected_lane = match requested_device {
        "cpu" => FdmMultilayerObservationLane::Cpu,
        "gpu" => FdmMultilayerObservationLane::Gpu,
        _ => return Ok(None),
    };
    if snapshot.execution_lane != expected_lane {
        bail!(
            "accepted FDM multilayer observation has unsupported requested/resolved lane binding ({requested_device}, {})",
            snapshot.execution_engine
        );
    }

    let canonical_layout = fullmag_runner::study_magnetization_layout_for_plan(
        &accepted_step.execution_plan,
    )
    .map_err(|error| anyhow::anyhow!(error.to_string()))
    .context("resolve canonical accepted FDM multilayer state layout")?;
    let state_bytes = read_explicit_runner_artifact(
        attempt_output_dir,
        RUNNER_FINAL_STATE_FILE,
        accepted_step.claim.lease.budget.storage_bytes,
    )
    .context("read FDM multilayer terminal magnetization artifact")?;
    let decoded = fullmag_application::decode_study_artifact_bytes(
        "state",
        fullmag_application::STUDY_MAGNETIZATION_CODEC_ID,
        fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION,
        &state_bytes,
    )
    .context("decode FDM multilayer terminal magnetization artifact")?;
    let DecodedStudyArtifact::MagnetizationState(state) = decoded else {
        bail!("FDM multilayer state codec did not produce magnetization");
    };
    let state_engine = state
        .provenance
        .get("execution_engine")
        .and_then(serde_json::Value::as_str)
        .context("FDM multilayer terminal magnetization has no actual execution engine")?;
    let lossy_fallback = state
        .provenance
        .get("lossy_fallback_used")
        .and_then(serde_json::Value::as_bool);
    if state_engine != snapshot.execution_engine
        || state
            .provenance
            .get("resolved_fallback")
            .is_some_and(|value| !value.is_null())
        || lossy_fallback != Some(false)
    {
        bail!("FDM multilayer terminal magnetization has a different or fallback execution identity");
    }
    if state.layout != canonical_layout {
        bail!("FDM multilayer terminal magnetization layout differs from the accepted plan");
    }
    fullmag_runner::materialize_study_magnetization_input(
        &accepted_step.execution_plan,
        &state.layout,
        &state.values,
    )
    .map_err(|error| anyhow::anyhow!(error.to_string()))
    .context("validate exact FDM multilayer terminal sample count and layout")?;
    snapshot
        .validate_against(&state.layout, &state.values)
        .map_err(|error| anyhow::anyhow!(error.to_string()))
        .context("bind FDM multilayer observation snapshot to terminal magnetization")?;
    let state_dt = (state.solver_dt_s > 0.0).then_some(state.solver_dt_s);
    if snapshot.clock.accepted_step != state.step
        || snapshot.clock.time_seconds.to_bits() != state.time_s.to_bits()
        || snapshot.clock.dt_seconds.map(f64::to_bits) != state_dt.map(f64::to_bits)
    {
        bail!("FDM multilayer observation clock differs from terminal magnetization artifact");
    }

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
            accepted_step: snapshot.clock.accepted_step,
            clock_digest: snapshot.clock_digest,
            state_digest: snapshot.state_digest,
            domain_digest: accepted_step
                .resolved_input
                .preparation
                .plan_fingerprint
                .clone(),
            plan_digest,
        },
        generation: AcceptedStateGeneration {
            runtime_epoch: accepted_step.claim.ownership_epoch.value(),
            accepted_revision: snapshot.clock.accepted_step,
        },
    };
    reference
        .validate()
        .map_err(|error| anyhow::anyhow!(error.to_string()))
        .context("validate accepted FDM multilayer observation state reference")?;
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


fn collect_terminal_study_publication(store: &SessionStore,
    accepted: &fullmag_runtime_control::AcceptedStudySnapshot, step: &AcceptedWorkerStep,
    plan: &ExecutionPlanIR, root: &Path, outputs: &[StudyOutputPayload])
    -> Result<Option<fullmag_runtime_control::PreparedTerminalPublicationV4>> {
    let fullmag_ir::BackendPlanIR::Fdm(fdm) = &plan.backend_plan else { return Ok(None); };
    if !fdm.spin_transport_plans.iter().any(|transport|transport.fdm_cpu_double_transient.is_some()) { return Ok(None); }
    if step.resolved_input.frozen_stage_context.is_none() { bail!("M3 terminal source lacks admitted full activation history"); }
    let maximum = step.claim.lease.budget.storage_bytes.min(64*1024*1024);
    let snapshot_bytes = read_explicit_runner_artifact(root,fullmag_runner::FDM_CPU_ACCEPTED_STATE_SNAPSHOT_FILE_V2,64*1024)?;
    let snapshot = fullmag_runner::FdmCpuAcceptedStateSnapshotV2::decode_metadata(&snapshot_bytes)
        .map_err(|error|anyhow::anyhow!(error.to_string()))?;
    let mut total = snapshot_bytes.len() as u64;
    let mut primary_preimages = Vec::with_capacity(4);
    for (id,_,path) in fullmag_runner::TERMINAL_PRIMARY_ROLES {
        let semantic = snapshot.primary_carriers.iter().find(|carrier|carrier.carrier_id==id).context("terminal semantic role missing")?;
        if semantic.byte_count>maximum { bail!("terminal primary exceeds bounded artifact budget"); }
        total = total.checked_add(semantic.byte_count).context("terminal primary byte count overflow")?;
        if total>step.claim.lease.budget.storage_bytes { bail!("terminal primary package exceeds admitted storage budget"); }
        let bytes = read_explicit_runner_artifact(root,path,semantic.byte_count)?;
        if bytes.len() as u64 != semantic.byte_count || fullmag_session::hex_sha256(&bytes)!=semantic.preimage_sha256 {
            bail!("terminal primary artifact differs from its exact semantic raw binding");
        }
        primary_preimages.push(fullmag_runner::TerminalPrimaryPreimage {carrier_id:id.into(),bytes});
    }
    let legacy_m=read_explicit_runner_artifact(root,RUNNER_FINAL_STATE_FILE,maximum)?;
    let decoded=fullmag_application::decode_study_artifact_bytes("state",fullmag_application::STUDY_MAGNETIZATION_CODEC_ID,
        fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION,&legacy_m)?;
    let DecodedStudyArtifact::MagnetizationState(sample)=decoded else {bail!("terminal raw M has another codec");};
    if sample.step>snapshot.clock.accepted_step || !fullmag_runner::terminal_output_times_coalesce(sample.time_s,snapshot.clock.time_seconds) {
        bail!("legacy sampled M clock is not an alias of the actual terminal primary bundle");
    }
    let state_bytes=fullmag_application::materialize_study_state_at_terminal_clock(&legacy_m,snapshot.clock)?;
    let source = fullmag_runtime_control::ObservationSourcePayloadV2 {snapshot_bytes,
        state_bytes,primary_preimages,
        coverage_bytes:read_explicit_runner_artifact(root,"solver/terminal_output_coverage.v1.json",fullmag_session::MAX_OUTPUT_HISTORY_METADATA_BYTES)?,
    };
    fullmag_runtime_control::prepare_terminal_study_publication(store,accepted,step,plan,&source,outputs,root).map(Some)
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
        StudyPortDataKind::Artifact if port.port_id == "inspection" => Ok((
            "artifact", fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_ID,
            fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_VERSION,
        )),
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
        StudyPortDataKind::Artifact
            if port.port_id == fullmag_authoring::ANTENNA_INSPECTION_OUTPUT_PORT_ID =>
        {
            Ok((
                "artifact",
                fullmag_application::STUDY_ANTENNA_INSPECTION_CODEC_ID,
                fullmag_application::STUDY_ANTENNA_INSPECTION_CODEC_VERSION,
            ))
        }
        unsupported => bail!(
            "accepted worker receipt has no output binding for `{unsupported:?}` port `{}`",
            port.port_id
        ),
    }
}

fn frozen_output_binding(port: &StudyOutputPort, codec_id: &str, version: &str) -> bool {
    matches!(port.data_kind, StudyPortDataKind::State | StudyPortDataKind::InitialState)
        && codec_id == fullmag_application::STUDY_FROZEN_STATE_CODEC_ID
        && version == fullmag_application::STUDY_FROZEN_STATE_CODEC_VERSION
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
    persist_completed_worker_execution_with_terminal(store,attempt_output_dir,identity,declared_outputs,
        status,completed_step_count,outputs,accepted_state_ref,observation_source,None)
}

fn persist_completed_worker_execution_with_terminal(
    store: &SessionStore,
    attempt_output_dir: &Path,
    identity: &WorkerExecutionReceiptIdentity,
    declared_outputs: &[StudyOutputPort],
    status: RunStatus,
    completed_step_count: usize,
    outputs: &[StudyOutputPayload],
    accepted_state_ref: Option<&AcceptedStateRef>,
    observation_source: Option<&ObservationSourcePayload>,
    terminal_publication: Option<&fullmag_runtime_control::PreparedTerminalPublicationV4>,
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
            || ((output.codec_id != codec_id || output.codec_version != codec_version)
                && !frozen_output_binding(port, &output.codec_id, &output.codec_version))
        {
            bail!("accepted worker output codec version is not registered");
        }
        let object_ref = retry_store_writer_busy(|| store.cas().put(&output.bytes))?;
        output_refs.push(WorkerExecutionOutputReference {
            port_id: output.port_id.clone(),
            case_id: output.case_id.clone(),
            data_kind: data_kind.into(),
            codec_id: output.codec_id.clone(),
            codec_version: output.codec_version.clone(),
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
    if let Some(terminal) = terminal_publication {
        if status != RunStatus::Completed || observation_source.is_some()
            || accepted_state_ref != Some(&terminal.manifest.accepted_state_ref) {
            bail!("terminal completed receipt has incompatible legacy observation fields");
        }
        let receipt=WorkerExecutionCompletedReceiptV2 {
            schema_version:"fullmag.accepted_worker_execution.v2".into(),identity:identity.clone(),status,
            completed_step_count,outputs:output_refs,accepted_state_ref:terminal.manifest.accepted_state_ref.clone(),
            terminal_publication:terminal.clone(),
        };
        if serde_json::to_vec_pretty(&receipt)?.len() as u64>fullmag_session::MAX_TERMINAL_CATALOG_METADATA_BYTES {
            bail!("terminal completed receipt exceeds the existing bounded metadata owner");
        }
        return write_immutable_attempt_receipt(attempt_output_dir,WORKER_EXECUTION_COMPLETED_RECEIPT,&receipt);
    }
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

fn read_recovered_worker_object(
    store: &SessionStore,
    object_ref: &str,
    expected_bytes: u64,
    max_bytes: u64,
) -> Result<Vec<u8>> {
    if expected_bytes > max_bytes {
        bail!("recovered worker object exceeds its read budget");
    }
    let length = store
        .cas()
        .verified_length(object_ref)?
        .context("completed worker CAS object is missing")?;
    if length != expected_bytes {
        bail!("completed worker CAS object has a mismatched byte count");
    }
    if length == 0 {
        return Ok(Vec::new());
    }
    let range = store
        .cas()
        .get_verified_range(object_ref, 0, length, max_bytes)?
        .context("completed worker CAS object disappeared during recovery")?;
    if range.object_length != expected_bytes {
        bail!("completed worker CAS object changed length during recovery");
    }
    Ok(range.bytes)
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
    let wire: WorkerExecutionCompletedReceiptWire =
        read_attempt_receipt(attempt_output_dir, WORKER_EXECUTION_COMPLETED_RECEIPT)?.context(
            "worker outcome is unknown because no completed receipt exists; refusing to rerun",
        )?;
    let (completed,terminal_publication)=match wire {
        WorkerExecutionCompletedReceiptWire::V1(receipt)=>(receipt,None),
        WorkerExecutionCompletedReceiptWire::V2(receipt)=>(WorkerExecutionCompletedReceipt {
            schema_version:receipt.schema_version,identity:receipt.identity,status:receipt.status,
            completed_step_count:receipt.completed_step_count,outputs:receipt.outputs,
            accepted_state_ref:Some(receipt.accepted_state_ref),observation_source:None,
        },Some(receipt.terminal_publication)),
    };
    let terminal_receipt = terminal_publication.as_ref();
    let version_valid = match terminal_receipt {
        Some(terminal) => completed.schema_version == "fullmag.accepted_worker_execution.v2"
            && completed.observation_source.is_none() && expected_observation_grid.is_none()
            && expected_accepted_state_ref.is_none()
            && completed.accepted_state_ref.as_ref() == Some(&terminal.manifest.accepted_state_ref),
        None => completed.schema_version == WORKER_EXECUTION_RECEIPT_SCHEMA
            && completed.accepted_state_ref.as_ref() == expected_accepted_state_ref,
    };
    if !version_valid
        || !completed.identity.matches_same_attempt(expected_identity)
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
    // Enforce the aggregate budget before materializing any recovered payload.
    let mut planned_object_sizes = BTreeMap::new();
    let mut record_size = |object_ref: &str, bytes: u64| -> Result<()> {
        if let Some(previous) = planned_object_sizes.insert(object_ref.to_owned(), bytes) {
            if previous != bytes {
                bail!("completed worker receipt has conflicting CAS object sizes");
            }
        }
        Ok(())
    };
    for output in &completed.outputs {
        if output.codec_id == "fullmag.antenna.inspection_package"
            && output.byte_count > u64::try_from(
                fullmag_antenna_artifacts::package::ANTENNA_INSPECTION_PACKAGE_MAX_BYTES,
            )?
        {
            bail!("recovered antenna package exceeds its codec read budget");
        }
        record_size(&output.object_ref, output.byte_count)?;
    }
    if let Some(source) = &completed.observation_source {
        record_size(&source.snapshot_object_ref, source.snapshot_byte_count)?;
        record_size(&source.state_object_ref, source.state_byte_count)?;
    }
    let planned_bytes = planned_object_sizes
        .values()
        .try_fold(0_u64, |total, size| total.checked_add(*size))
        .context("recovered worker planned byte count overflowed")?;
    if planned_bytes > max_output_bytes {
        bail!("recovered worker artifacts exceed the attempt storage budget");
    }
    let mut seen = BTreeSet::new();
    let mut unique_object_sizes = BTreeMap::new();
    let mut planned_bytes=0u64;
    let mut planned_objects=BTreeSet::new();
    for output in &completed.outputs {
        if planned_objects.insert(&output.object_ref) { planned_bytes=planned_bytes.checked_add(output.byte_count).context("receipt bytes overflow")?; }
    }
    if let Some(source)=&completed.observation_source {
        for (hash,size) in [(&source.snapshot_object_ref,source.snapshot_byte_count),(&source.state_object_ref,source.state_byte_count)] {
            if planned_objects.insert(hash) { planned_bytes=planned_bytes.checked_add(size).context("receipt observation bytes overflow")?; }
        }
    }
    if planned_bytes>max_output_bytes { bail!("completed receipt exceeds caller artifact byte budget"); }
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
            || ((output.codec_id != codec_id || output.codec_version != codec_version)
                && !frozen_output_binding(port, &output.codec_id, &output.codec_version))
        {
            bail!(
                "completed worker output `{}` differs from its accepted port",
                output.port_id
            );
        }
        let bytes = read_recovered_worker_object(
            store,
            &output.object_ref,
            output.byte_count,
            max_output_bytes,
        ).with_context(|| {
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
            &output.codec_id,
            &output.codec_version,
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
            let snapshot_bytes = read_recovered_worker_object(
                store,
                &source.snapshot_object_ref,
                source.snapshot_byte_count,
                max_output_bytes,
            )?;
            let state_bytes = read_recovered_worker_object(
                store,
                &source.state_object_ref,
                source.state_byte_count,
                max_output_bytes,
            )?;
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
        terminal_publication,
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
    fullmag_runtime_control::materialize_accepted_worker_execution_plan(store, accepted_step)
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
    let current_claim = retry_worker_claim_store_busy(
        store,
        accepted_step.claim.run_id.as_str(),
        accepted_step.claim.task_id.as_str(),
        || {
            fullmag_runtime_control::load_current_task_claim(
                store,
                &accepted_step.claim.run_id,
                accepted_step.claim.task_id.as_str(),
            )
        },
    )
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
    let immutable_problem = accepted
        .catalog
        .entries()
        .iter()
        .find(|entry| entry.step_id() == accepted_step.step_id)
        .context("accepted worker step has no immutable catalog entry")?
        .problem();
    accepted_step
        .resolved_input
        .validate_execution_for_problem(specification, immutable_problem)
        .context("validate accepted task execution before dispatch")?;
    let request = &accepted_step.resolved_input.requested_execution;
    if matches!(study_step.kind, fullmag_authoring::StudyStepKind::ClosedLoopInspection { .. }) {
        return execute_accepted_closed_loop_worker_start(store, &accepted, start, accepted_step, study_step, case_id, interrupt_requested);
    }
    if matches!(
        &accepted_step.execution_plan.backend_plan,
        fullmag_ir::BackendPlanIR::AntennaExternalLeadInspection(_)
    ) {
        crate::accepted_antenna_inspection_worker::validate_declared_outputs(&study_step.outputs)?;
        return execute_accepted_antenna_worker_start(
            store,
            &accepted,
            start,
            accepted_step,
            study_step,
            case_id,
            interrupt_requested,
        );
    }
    if study_step.outputs.iter().any(|port| port.data_kind == StudyPortDataKind::Artifact) {
        bail!("legacy solver steps cannot publish an inspection artifact");
    }
    // Validate the same bounded RunSpec metadata before backend dispatch;
    // FEM must not bypass the live-workspace/start-policy binding guard.
    validate_accepted_worker_parameters(&specification.parameters, &accepted_step.step_id)?;
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
    if !specification.seeds.is_empty()
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
            fullmag_ir::BackendPlanIR::Fdm(_) | fullmag_ir::BackendPlanIR::FdmMultilayer(_)
        )
    {
        bail!(
            "accepted worker execution plan is outside the supported FDM/FDM multilayer CPU/GPU double strict lanes"
        );
    }
    if let fullmag_ir::BackendPlanIR::FdmMultilayer(plan) =
        &accepted_step.execution_plan.backend_plan
    {
        fullmag_runner::validate_accepted_fdm_multilayer_execution_lane(
            plan,
            request.device.as_str(),
        )
        .map_err(|error| anyhow::anyhow!(error.to_string()))
        .context("validate accepted FDM multilayer lane before attempt reservation")?;
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
    // Keep the authored runtime selection intact. The managed lease is an
    // effective runtime override, recorded separately for provenance.
    let mut problem = accepted_step.problem.clone();
    problem
        .problem_meta
        .runtime_metadata
        .insert(
            "runtime_device_override".into(),
            serde_json::json!({
                "device": request.device.clone(),
                "source": "managed_launcher"
            }),
        );
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
        &accepted,
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
        let mut live_observation = AcceptedLiveObservationWriter::new(
            &attempt_output_dir,
            accepted_step,
            &execution_plan,
            format!("fdm_{}", request.device),
        );
        let field_sampling_interval = live_observation.field_sampling_interval();
        let frozen = match accepted_step.resolved_input.frozen_stage_context.as_ref() {
            Some(binding) => {
                let fullmag_ir::BackendPlanIR::Fdm(plan) = &execution_plan.backend_plan else {
                    bail!("admitted frozen stage does not have an FDM plan");
                };
                Some(fullmag_runtime_control::frozen_stage_lifecycle::load_execution_context(store,
                    &accepted_step.claim.run_id, &accepted_step.step_id, plan,
                    &accepted_step.claim, binding)?)
            }
            None => None,
        };
        let runner_result = if let Some(context) = &frozen {
            fullmag_runner::run_planned_problem_with_live_preview_and_frozen_stage_context_and_observer(
                &problem, &execution_plan, until_seconds, &attempt_output_dir,
                storage.as_ref().map(|value| value.data_root()).unwrap_or(&attempt_output_dir),
                interrupt_requested, &context.frozen, context.source_frozen_plan.as_ref(),
                field_sampling_interval, |update| {
                    live_observation.observe(&update);
                    StepAction::Continue
                })
        } else {
        fullmag_runner::run_planned_problem_with_live_preview_interruptible_with_initial_snapshot_and_fem_mesh_identity_and_autosave_root(
            &problem,
            &execution_plan,
            None,
            until_seconds,
            &attempt_output_dir,
            storage.as_ref().map(|value| value.data_root()).unwrap_or(&attempt_output_dir),
            field_sampling_interval,
            &display_selection,
            interrupt_requested,
            false,
            |update| {
                live_observation.observe(&update);
                StepAction::Continue
            },
        )
        };
        // Drain the live sidecar for both frozen and ordinary execution, including errors.
        live_observation.finish();
        let result = runner_result
        .map_err(|error| anyhow::anyhow!(error.to_string()))
        .with_context(|| format!("execute accepted FDM {} runner plan", request.device))?;
        if result.status == RunStatus::Cancelled {
            return Ok(AcceptedRunnerExecution {
        terminal_publication: None,
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
        let lifecycle = if frozen.is_some() {
            let bytes = read_explicit_runner_artifact(&attempt_output_dir,
                "solver/frozen_output_lifecycle.v1.json", 64 * 1024 * 1024)?;
            Some(fullmag_runner::constraints::FrozenOutputLifecycleV1::decode(&bytes)?)
        } else { None };
        let outputs = collect_runner_study_outputs_with_lifecycle(
            &study_step.outputs,
            case_id,
            &result,
            &attempt_output_dir,
            accepted_step.claim.lease.budget.storage_bytes,
            lifecycle.as_ref(),
        )
        .context("collect explicit typed outputs from the accepted runner attempt")?;
        let terminal_publication = if result.status == RunStatus::Completed {
            collect_terminal_study_publication(store,&accepted,accepted_step,&execution_plan,&attempt_output_dir,&outputs)?
        } else { None };
        let accepted_state_ref = if let Some(terminal) = &terminal_publication {
            Some(terminal.manifest.accepted_state_ref.clone())
        } else { accepted_state_ref_from_runner_snapshot(&attempt_output_dir, accepted_step, true)? };
        let observation_source = collect_fdm_cpu_observation_source(
            &attempt_output_dir,
            accepted_step,
            accepted_state_ref.as_ref(),
            accepted_step.claim.lease.budget.storage_bytes,
        )?;
        if let Some(storage) = &mut storage {
            storage.finish(true, &attempt_output_dir)?;
        }
        persist_completed_worker_execution_with_terminal(
            store,
            &attempt_output_dir,
            &receipt_identity,
            &study_step.outputs,
            result.status,
            result.steps.len(),
            &outputs,
            accepted_state_ref.as_ref(),
            observation_source.as_ref(),
            terminal_publication.as_ref(),
        )
        .context("persist immutable completed worker output receipt")?;

        Ok(AcceptedRunnerExecution {
        terminal_publication,
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
        match &execution {
            Ok(result) if result.status == RunStatus::Cancelled => {
                storage.note_outcome("cancelled", None)
            }
            Err(error) => storage.note_outcome("failed", Some(format!("{error:#}"))),
            _ => {}
        }
        storage.finish(success, &storage_attempt_dir)?;
    }
    execution
}

/// These existing live/start-policy fields describe orchestration only. Physical
/// parameters still have no binding in inspection workers. Validate against
/// immutable acceptance, never the current API incarnation (cold recovery).
pub(crate) fn validate_accepted_inspection_run_parameters(
    specification: &fullmag_application::RunSpecification,
    step_id: &str,
) -> Result<()> {
    validate_accepted_worker_parameters(&specification.parameters, step_id)?;
    let parameters = specification.parameters.as_object()
        .context("inspection RunSpec parameters must be an object")?;
    if parameters.keys().any(|key| {
        key != "live_workspace" && key != fullmag_session::ACCEPTED_RUN_START_POLICY_KEY
    }) {
        bail!("accepted inspection has no binding for physical RunSpec parameters");
    }
    let Some(live) = parameters.get("live_workspace") else { return Ok(()); };
    let live = live.as_object().context("inspection live workspace binding must be an object")?;
    let expected_keys: BTreeSet<_> = [
        "api_instance_id", "session_id", "session_epoch", "scene_revision", "command_id",
        "request_idempotency_key", "step_id", "command", "startup_source_sha256",
    ].into_iter().collect();
    if live.keys().map(String::as_str).filter(|key| *key != "execution_input")
        .collect::<BTreeSet<_>>() != expected_keys {
        bail!("inspection live workspace binding has unsupported fields");
    }
    let text = |key: &str| -> Result<&str> {
        live.get(key).and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .with_context(|| format!("inspection live workspace `{key}` is missing"))
    };
    let api = text("api_instance_id")?;
    let session = text("session_id")?;
    let command = text("command_id")?;
    let epoch = live["session_epoch"].as_u64().context("inspection session epoch is invalid")?;
    let revision = live["scene_revision"].as_u64().context("inspection scene revision is invalid")?;
    let request_key = if live["request_idempotency_key"].is_null() {
        ""
    } else {
        text("request_idempotency_key")?
    };
    if !live["step_id"].is_null() && live["step_id"].as_str() != Some(step_id) {
        bail!("inspection live workspace selects another step");
    }
    let identity = format!("{api}\0{session}\0{epoch}\0{revision}\0{command}\0{request_key}");
    let digest = fullmag_session::hex_sha256(identity.as_bytes());
    let project_digest = fullmag_session::hex_sha256(format!("{api}\0{session}").as_bytes());
    if specification.run_id.as_str() != format!("run-live-{digest}")
        || specification.study.study_id.as_str() != format!("live-study-{digest}")
        || specification.snapshot.project_id.as_str() != format!("project-live-{project_digest}")
        || specification.snapshot.definition_revision != revision
    {
        bail!("inspection live workspace differs from its immutable run/project/study binding");
    }
    let authored_command = &live["command"];
    if live["startup_source_sha256"].is_null() {
        if authored_command.get("command_id").and_then(serde_json::Value::as_str) != Some(command)
            || authored_command.get("kind").and_then(serde_json::Value::as_str) != Some("solve")
        {
            bail!("inspection live command must be the accepted Solve command");
        }
    } else {
        let source = text("startup_source_sha256")?;
        if source.len() != 64 || !source.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || authored_command != &serde_json::json!({
                "kind": "startup_script", "request_id": command, "source_sha256": source,
            })
            || request_key != command || !live["step_id"].is_null()
        {
            bail!("inspection startup source differs from its accepted command");
        }
    }
    Ok(())
}

/// Same supervised Start/Stop/receipt owner as solver tasks; the physical effect remains in the canonical runner.
fn execute_accepted_closed_loop_worker_start(
    store:&SessionStore, accepted:&fullmag_runtime_control::AcceptedStudySnapshot,
    start:&fullmag_application::WorkerCommandEnvelope, accepted_step:&AcceptedWorkerStep,
    study_step:&fullmag_authoring::StudyStep, case_id:&str, interrupt_requested:Option<&AtomicBool>,
) -> Result<AcceptedRunnerExecution> {
    let request=&accepted_step.resolved_input.requested_execution;
    if start.schema_version!=fullmag_application::CLOSED_LOOP_WORKER_PROTOCOL_SCHEMA
        || accepted_step.resolved_input.schema_version!=fullmag_application::CLOSED_LOOP_RESOLVED_TASK_INPUT_SCHEMA
        || request.backend!="fem" || !matches!(request.device.as_str(),"cpu"|"auto") || request.precision!="double" || request.mode!="strict"
        || accepted_step.until_seconds.is_some() || !accepted_step.resolved_input.inputs.is_empty()
        || study_step.outputs.len()!=1 || study_step.outputs[0].port_id!="inspection" || study_step.outputs[0].data_kind!=StudyPortDataKind::Artifact
        || !accepted.run.specification.seeds.is_empty() || !accepted_step.problem.problem_meta.seeds.is_empty() {
        bail!("accepted inspection requires v4 FEM CPU/auto strict double, one artifact, no horizon/state/seeds");
    }
    validate_accepted_inspection_run_parameters(&accepted.run.specification, &study_step.step_id)?;
    if !store.accepted_run_start_permitted(accepted.run.specification.run_id.as_str())? {
        bail!("accepted inspection refuses to execute before explicit Compute release");
    }
    let maximum=fullmag_runtime_control::study_inspection::inspection_bundle_budget(&accepted_step.claim)?;
    let receipt=accepted.read_task_preparation(store, accepted_step.claim.task_id.as_str())?;
    if !matches!(&receipt, fullmag_application::AcceptedPreparationReceipt::ClosedLoop(_)) || receipt.binding()?!=accepted_step.resolved_input.preparation {
        bail!("accepted inspection lacks exact source-mesh native readiness");
    }
    let fullmag_authoring::StudyStepKind::ClosedLoopInspection {stage_id,port_mode_id,output_id}=&study_step.kind else { bail!("inspection kind missing"); };
    let operation=fullmag_plan::validate_closed_loop_operation(&accepted_step.problem,stage_id,port_mode_id,output_id)?;
    let fullmag_plan::AntennaFieldSolveExecutionPlan::ClosedLoopInspection {input,requested_execution,output_id}=operation else { bail!("inspection operation mismatch"); };
    let identity=worker_execution_receipt_identity(start,accepted_step,case_id)?;
    let recover=|path:&Path| -> Result<AcceptedRunnerExecution> {
        let result=recover_completed_worker_execution(store,path,&identity,&study_step.outputs,maximum as u64,None,None)?;
        if result.completed_step_count!=1 || result.outputs.len()!=1 { bail!("inspection receipt has another execution shape"); }
        fullmag_runtime_control::study_inspection::validate_accepted_inspection_bytes(&accepted_step.problem,study_step,&result.outputs[0].bytes,maximum)?;
        Ok(result)
    };
    match existing_private_attempt_output_dir(store,&accepted_step.claim) {
        Ok(path)=>return recover(&path).context("recover inspection without repeating native side effect"),
        Err(error) if is_not_found_error(&error)=>{},
        Err(error)=>return Err(error).context("inspect owned inspection attempt"),
    }
    crate::accepted_project_storage::AcceptedProjectStorage::preflight(&accepted_step.problem,store,&accepted_step.claim,&accepted_step.step_id)?;
    let attempt=match retry_store_writer_busy(||create_private_attempt_output_dir(store,&accepted_step.claim)) {
        Ok(path)=>path,
        Err(error)=>match existing_private_attempt_output_dir(store,&accepted_step.claim) {
            Ok(path)=>return recover(&path),
            Err(_)=>return Err(error).context("reserve inspection attempt before native side effect"),
        },
    };
    write_immutable_attempt_receipt(&attempt,WORKER_EXECUTION_STARTED_RECEIPT,&WorkerExecutionStartedReceipt {identity:identity.clone()})?;
    let mut storage=prepare_accepted_project_storage(&accepted_step.problem,store,accepted,accepted_step,&identity,&attempt)?;
    let execution:Result<AcceptedRunnerExecution>=(|| {
        let artifacts=match fullmag_runner::execute_antenna_closed_loop_inspection(&input,&requested_execution,&output_id,interrupt_requested) {
            Ok(artifacts)=>artifacts,
            Err(_error) if interrupt_requested.is_some_and(|flag|flag.load(Ordering::Acquire))=>return Ok(AcceptedRunnerExecution {
        terminal_publication: None,status:RunStatus::Cancelled,completed_step_count:0,outputs:vec![],attempt_output_dir:attempt.clone(),recovered_from_receipt:false,accepted_state_ref:None,observation_source:None}),
            Err(error)=>return Err(anyhow::anyhow!(error.to_string())).context("execute canonical full-volume inspection"),
        };
        let manifest_path=format!("antenna/field_solutions/{output_id}/manifest.v2.json");
        let mut manifest=None;let mut payloads=BTreeMap::new();let mut total=0usize;
        for artifact in artifacts {
            total=total.checked_add(artifact.bytes.len()).context("inspection output byte overflow")?;
            if total>maximum { bail!("inspection output exceeds admitted byte reserve"); }
            if artifact.relative_path==manifest_path {
                if manifest.replace(artifact.bytes).is_some() { bail!("inspection manifest duplicated"); }
            } else if payloads.insert(artifact.relative_path,artifact.bytes).is_some() { bail!("inspection payload duplicated"); }
        }
        let manifest=manifest.context("canonical inspection manifest absent")?;
        let bytes=fullmag_application::encode_antenna_inspection_bundle(&manifest,&payloads,maximum)?;
        drop(payloads);drop(manifest);
        fullmag_runtime_control::study_inspection::validate_accepted_inspection_bytes(&accepted_step.problem,study_step,&bytes,maximum)?;
        if interrupt_requested.is_some_and(|flag|flag.load(Ordering::Acquire)) {
            return Ok(AcceptedRunnerExecution {
        terminal_publication: None,status:RunStatus::Cancelled,completed_step_count:0,outputs:vec![],attempt_output_dir:attempt.clone(),recovered_from_receipt:false,accepted_state_ref:None,observation_source:None});
        }
        let output=StudyOutputPayload {port_id:"inspection".into(),case_id:case_id.into(),codec_id:fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_ID.into(),codec_version:fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_VERSION.into(),bytes};
        let root=storage.as_ref().map(|value|value.data_root()).unwrap_or(&attempt);
        // One owned framing file; no untrusted payload path is extracted to the filesystem.
        let mut file=OpenOptions::new().write(true).create_new(true).open(root.join("antenna-inspection.bundle"))?;
        file.write_all(&output.bytes)?;file.sync_all()?;drop(file);
        #[cfg(unix)]
        std::fs::File::open(root)?.sync_all()?;
        if let Some(storage)=&mut storage { storage.finish(true,&attempt)?; }
        persist_completed_worker_execution(store,&attempt,&identity,&study_step.outputs,RunStatus::Completed,1,std::slice::from_ref(&output),None,None)?;
        Ok(AcceptedRunnerExecution {
        terminal_publication: None,status:RunStatus::Completed,completed_step_count:1,outputs:vec![output],attempt_output_dir:attempt.clone(),recovered_from_receipt:false,accepted_state_ref:None,observation_source:None})
    })();
    if let Some(storage)=&mut storage {
        match &execution { Ok(result) if result.status==RunStatus::Cancelled=>storage.note_outcome("cancelled",None),Err(error)=>storage.note_outcome("failed",Some(format!("{error:#}"))),_=>{} }
        storage.finish(execution.as_ref().is_ok_and(|result|result.status==RunStatus::Completed),&attempt)?;
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
    let runtime = resolve_accepted_fem_runtime(store, accepted_step)
        .context("resolve accepted FEM CPU/GPU device from the active lease")?;
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
            &runtime,
        )
        .context("recover completed accepted FEM worker attempt without rerunning solver");
    }

    let prepared = crate::accepted_fem_study_worker::prepare_accepted_fem_execution(
        store,
        accepted,
        accepted_step,
        study_step,
        case_id,
        &runtime,
    )
    .context("prepare accepted FEM CPU/GPU execution before attempt reservation")?;
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
                &runtime,
            )
            .context("recover completed accepted FEM worker attempt without rerunning solver");
        }
    };

    let mut storage = prepare_accepted_project_storage(
        &prepared.problem,
        store,
        accepted,
        accepted_step,
        &receipt_identity,
        &attempt_output_dir,
    )?;
    let storage_attempt_dir = attempt_output_dir.clone();
    let execution: Result<AcceptedRunnerExecution> = (|| {
        let outcome = crate::accepted_fem_study_worker::execute_accepted_fem_attempt(
            accepted_step,
            &prepared,
            &attempt_output_dir,
            storage
                .as_ref()
                .map(|value| value.data_root())
                .unwrap_or(&attempt_output_dir),
            interrupt_requested,
        )
        .context("execute accepted FEM CPU/GPU worker attempt")?;
        match outcome {
            crate::accepted_fem_study_worker::AcceptedFemExecutionOutcome::Cancelled {
                completed_step_count,
                attempt_output_dir,
            } => Ok(AcceptedRunnerExecution {
        terminal_publication: None,
                status: RunStatus::Cancelled,
                completed_step_count,
                outputs: Vec::new(),
                attempt_output_dir,
                recovered_from_receipt: false,
                accepted_state_ref: None,
                observation_source: None,
            }),
            crate::accepted_fem_study_worker::AcceptedFemExecutionOutcome::Completed(
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
        terminal_publication: None,
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
        match &execution {
            Ok(result) if result.status == RunStatus::Cancelled => {
                storage.note_outcome("cancelled", None)
            }
            Err(error) => storage.note_outcome("failed", Some(format!("{error:#}"))),
            _ => {}
        }
        storage.finish(success, &storage_attempt_dir)?;
    }
    execution
}

fn execute_accepted_antenna_worker_start(
    store: &SessionStore,
    accepted: &fullmag_runtime_control::AcceptedStudySnapshot,
    start: &fullmag_application::WorkerCommandEnvelope,
    step: &AcceptedWorkerStep,
    study_step: &fullmag_authoring::StudyStep,
    case_id: &str,
    interrupt: Option<&AtomicBool>,
) -> Result<AcceptedRunnerExecution> {
    let identity = worker_execution_receipt_identity(start, step, case_id)?;
    // Preparation is checked on recovery too; a completed receipt is never a
    // substitute for the immutable accepted request/preparation binding.
    let prepared = crate::accepted_antenna_inspection_worker::prepare(
        store, accepted, step, study_step, case_id,
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
            bail!("antenna inspection recovery belongs to a stale claim");
        }
        refuse_known_prelaunch_failure(&path, &identity)?;
        let recovered = recover_completed_worker_execution(
            store,
            &path,
            &identity,
            &prepared.output_ports,
            step.claim.lease.budget.storage_bytes,
            None,
            None,
        )?;
        if recovered.completed_step_count != 1 || recovered.outputs.len() != 1 {
            bail!("antenna inspection completed receipt must contain one solve and one output");
        }
        crate::accepted_antenna_inspection_worker::validate_package(
            &recovered.outputs[0].bytes,
            &prepared.execution_plan,
        )?;
        Ok(recovered)
    };
    match existing_private_attempt_output_dir(store, &step.claim) {
        Ok(path) => return recover(path),
        Err(error) if is_not_found_error(&error) => {}
        Err(error) => return Err(error).context("inspect existing antenna inspection attempt"),
    }
    crate::accepted_project_storage::AcceptedProjectStorage::preflight(
        &prepared.problem,
        store,
        &step.claim,
        &step.step_id,
    )?;
    let attempt =
        match retry_store_writer_busy(|| create_private_attempt_output_dir(store, &step.claim)) {
            Ok(path) => {
                write_immutable_attempt_receipt(
                    &path,
                    WORKER_EXECUTION_STARTED_RECEIPT,
                    &WorkerExecutionStartedReceipt {
                        identity: identity.clone(),
                    },
                )?;
                path
            }
            Err(error) => match existing_private_attempt_output_dir(store, &step.claim) {
                Ok(path) => return recover(path),
                Err(_) => return Err(error).context("reserve antenna inspection attempt"),
            },
        };
    let mut storage = prepare_accepted_project_storage(
        &prepared.problem,
        store,
        accepted,
        step,
        &identity,
        &attempt,
    )?;
    let execution: Result<AcceptedRunnerExecution> = (|| {
        let outcome = crate::accepted_antenna_inspection_worker::execute(
            &prepared,
            step.claim.lease.budget.storage_bytes,
            interrupt,
        )?;
        let (status, count, outputs) = match outcome {
            crate::accepted_antenna_inspection_worker::InspectionOutcome::Cancelled => {
                (RunStatus::Cancelled, 0, Vec::new())
            }
            crate::accepted_antenna_inspection_worker::InspectionOutcome::Completed(outputs) => {
                (RunStatus::Completed, 1, outputs)
            }
        };
        if status == RunStatus::Completed {
            if let Some(storage) = &mut storage {
                crate::accepted_antenna_inspection_worker::stage_project_output(
                    storage.data_root(),
                    &outputs[0].bytes,
                    &prepared.execution_plan,
                )?;
                // Recovery may trust a completed receipt only after project export is durable.
                storage.finish(true, &attempt)?;
            }
            persist_completed_worker_execution(
                store,
                &attempt,
                &identity,
                &prepared.output_ports,
                status,
                count,
                &outputs,
                None,
                None,
            )?;
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
        })
    })();
    if let Some(storage) = &mut storage {
        match &execution {
            Ok(value) if value.status == RunStatus::Cancelled => {
                storage.note_outcome("cancelled", None)
            }
            Err(error) => storage.note_outcome("failed", Some(format!("{error:#}"))),
            _ => {}
        }
        storage.finish(
            execution
                .as_ref()
                .is_ok_and(|v| v.status == RunStatus::Completed),
            &attempt,
        )?;
    }
    execution
}

fn prepare_accepted_project_storage(
    problem: &fullmag_ir::ProblemIR,
    store: &SessionStore,
    accepted: &fullmag_runtime_control::AcceptedStudySnapshot,
    accepted_step: &AcceptedWorkerStep,
    identity: &WorkerExecutionReceiptIdentity,
    attempt: &Path,
) -> Result<Option<crate::accepted_project_storage::AcceptedProjectStorage>> {
    let manifest = crate::accepted_project_storage::accepted_run_manifest(
        &accepted.run.specification.snapshot,
        &accepted_step.resolved_input.requested_execution,
        &accepted_step.resolved_input.specification_fingerprint,
        &accepted_step.claim,
        accepted_step.execution_plan.common.resolved_backend,
    );
    match crate::accepted_project_storage::AcceptedProjectStorage::prepare(
        problem,
        store,
        &accepted_step.claim,
        &accepted_step.step_id,
        manifest,
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
    let current_claim = retry_worker_claim_store_busy(
        store,
        accepted_step.claim.run_id.as_str(),
        accepted_step.claim.task_id.as_str(),
        || {
            fullmag_runtime_control::load_current_task_claim(
                store,
                &accepted_step.claim.run_id,
                accepted_step.claim.task_id.as_str(),
            )
        },
    )
    .context("reconcile accepted worker receipt under the current claim")?;
    if !accepted_step.claim.is_same_or_renewed_by(&current_claim) {
        bail!("accepted worker receipt belongs to a stale task claim");
    }
    refuse_known_prelaunch_failure(&existing_path, identity)?;
    let expected_accepted_state_ref =
        accepted_state_ref_from_runner_snapshot(&existing_path, accepted_step, false)?;
    let recovered = recover_completed_worker_execution(
        store,
        &existing_path,
        identity,
        declared_outputs,
        accepted_step.claim.lease.budget.storage_bytes,
        expected_accepted_state_ref.as_ref(),
        fdm_cpu_observation_grid(accepted_step),
    )
    .context("recover completed accepted worker attempt without rerunning solver")?;
    if let Some(terminal) = &recovered.terminal_publication {
        fullmag_runtime_control::validate_prepared_terminal_publication(store,accepted_step,terminal)?;
    }
    Ok(recovered)
}

fn recover_accepted_fem_worker_attempt(
    store: &SessionStore,
    accepted_step: &AcceptedWorkerStep,
    receipt_identity: &WorkerExecutionReceiptIdentity,
    declared_outputs: &[StudyOutputPort],
    existing_path: PathBuf,
    runtime: &AcceptedFemRuntime,
) -> Result<AcceptedRunnerExecution> {
    let current_claim = retry_worker_claim_store_busy(
        store,
        accepted_step.claim.run_id.as_str(),
        accepted_step.claim.task_id.as_str(),
        || {
            fullmag_runtime_control::load_current_task_claim(
                store,
                &accepted_step.claim.run_id,
                accepted_step.claim.task_id.as_str(),
            )
        },
    )
    .context("reconcile accepted FEM worker receipt under the current claim")?;
    if !accepted_step.claim.is_same_or_renewed_by(&current_claim) {
        bail!("accepted FEM worker receipt belongs to a stale task claim");
    }
    refuse_known_prelaunch_failure(&existing_path, receipt_identity)?;
    let expected_accepted_state_ref =
        crate::accepted_fem_study_worker::accepted_state_ref_from_attempt_snapshot(
            &existing_path,
            accepted_step,
            runtime,
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
    // A worker process may be restored after its scheduler admitted the task.
    // Recheck the immutable Compute release immediately before loading the
    // accepted study or executing a solver. Legacy runs without the optional
    // manual policy remain permitted by the session gate.
    if !store.accepted_run_start_permitted(run_id.as_str())? {
        bail!("accepted worker refuses to execute before explicit Compute release");
    }
    let accepted = retry_store_writer_busy(|| {
        fullmag_runtime_control::load_accepted_study_snapshot(
            store,
            &run_id,
            &specification.snapshot.project_id,
        )
    })
    .context("load immutable accepted study for worker process")?;
    let claim = retry_worker_claim_store_busy(
        store,
        run_id.as_str(),
        task_id,
        || fullmag_runtime_control::load_current_task_claim(store, &run_id, task_id),
    )
    .context("worker process requires the exact active durable task claim")?;
    verify_host_worker_launch(store, &claim)?;
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
            let current_claim = retry_worker_claim_store_busy(
                store,
                claim.run_id.as_str(),
                claim.task_id.as_str(),
                || {
                    fullmag_runtime_control::load_current_task_claim(
                        store,
                        &claim.run_id,
                        claim.task_id.as_str(),
                    )
                },
            )
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
        || durable_execution.terminal_publication != execution.terminal_publication
    {
        bail!("worker receipt recovery differs from the completed runner output");
    }
    // Evaluate immutable terminal observables while this process still owns
    // the solver's resource lease. HTTP handlers only adopt the CAS bundle.
    if !control.interrupt_requested.load(Ordering::Acquire) {
        crate::accepted_field_materialization_worker::prepare_and_publish(
            store, accepted, &accepted_step, &durable_execution,
        )?;
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
        if let Some(terminal) = &durable_execution.terminal_publication {
            fullmag_runtime_control::publish_terminal_study_outputs(store,accepted,claim,
                &accepted_step.step_id,&durable_execution.outputs,terminal)
        } else {
        fullmag_runtime_control::publish_study_outputs(
            store,
            accepted,
            claim,
            &accepted_step.step_id,
            &durable_execution.outputs,
            durable_execution.accepted_state_ref.as_ref(),
            durable_execution.observation_source.as_ref(),
        )
        }
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

/// Retry only idempotent claim/lease validation while honoring a durable
/// cancellation intent. Durable inbox, journal, and solver effects keep
/// their existing reconciliation boundaries and are never replayed here.
fn retry_worker_claim_store_busy<T>(
    store: &SessionStore,
    run_id: &str,
    task_id: &str,
    mut operation: impl FnMut() -> Result<T>,
) -> Result<T> {
    let deadline = Instant::now() + ACCEPTED_WORKER_CLAIM_RETRY_LIMIT;
    loop {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error)
                if is_store_writer_busy(&error) && Instant::now() < deadline =>
            {
                if store
                    .read_task_cancellation_intent(run_id, task_id)?
                    .is_some()
                {
                    bail!("accepted worker claim operation cancelled by durable task cancellation");
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(error);
                }
                std::thread::sleep(ACCEPTED_WORKER_CLAIM_RETRY_DELAY.min(remaining));
            }
            Err(error) => return Err(error),
        }
    }
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
    collect_runner_study_outputs_with_lifecycle(declared, case_id, result, attempt_output_dir,
        max_output_bytes, None)
}

pub(crate) fn collect_runner_study_outputs_with_lifecycle(
    declared: &[StudyOutputPort],
    case_id: &str,
    result: &RunResult,
    attempt_output_dir: &Path,
    max_output_bytes: u64,
    lifecycle: Option<&fullmag_runner::constraints::FrozenOutputLifecycleV1>,
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
                let (bytes, codec_id, codec_version) = if let Some(lifecycle) = lifecycle {
                    let decoded = fullmag_application::decode_study_artifact_bytes("state",
                        fullmag_application::STUDY_MAGNETIZATION_CODEC_ID,
                        fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION, &bytes)?;
                    let DecodedStudyArtifact::MagnetizationState(state) = decoded else {
                        bail!("terminal M codec returned another state kind");
                    };
                    // Runner already validated the child against the actual terminal state.
                    // The envelope binds that state semantically; its raw hash covers the whole envelope.
                    let child = lifecycle.frozen_spins.as_ref().map(serde_json::to_string).transpose()?
                        .map(serde_json::value::RawValue::from_string).transpose()?;
                    let set = serde_json::value::RawValue::from_string(serde_json::to_string(&lifecycle.frozen_activation_set)?)?;
                    if let Some(child) = &lifecycle.frozen_spins {
                        if state.step > child.step || !fullmag_runner::terminal_output_times_coalesce(child.time_s,state.time_s)
                            || child.magnetization.len() != state.values.len()
                            || child.magnetization.iter().flatten().zip(state.values.iter().flatten())
                                .any(|(left, right)| left.to_bits() != right.to_bits())
                        { bail!("terminal lifecycle child differs from final M output"); }
                    }
                    let terminal_clock=lifecycle.frozen_spins.as_ref().map(|child|fullmag_quantities::ObservationClock {
                        accepted_step:child.step,time_seconds:child.time_s,dt_seconds:(child.dt>0.0).then_some(child.dt),
                    });
                    (fullmag_application::encode_frozen_study_state(&bytes, child.as_deref(), &set,terminal_clock)?,
                        fullmag_application::STUDY_FROZEN_STATE_CODEC_ID,
                        fullmag_application::STUDY_FROZEN_STATE_CODEC_VERSION)
                } else { (bytes, fullmag_application::STUDY_MAGNETIZATION_CODEC_ID,
                    fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION) };
                push_typed_output(
                    &mut outputs,
                    &mut total_bytes,
                    max_output_bytes,
                    port,
                    case_id,
                    "state",
                    codec_id,
                    codec_version,
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

pub(crate) fn read_explicit_runner_artifact(
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

#[cfg(test)]
mod closed_loop_run_parameter_tests {
    use super::validate_accepted_inspection_run_parameters;
    use fullmag_application::{ProjectId, ProjectSnapshot, RequestedExecution, RequestedResourceBudget,
        RunId, RunSpecification, StudyId, StudyReference};
    use serde_json::json;

    fn startup() -> RunSpecification {
        let source = "a".repeat(64);
        let identity = fullmag_session::hex_sha256(b"api\0session\01\07\0request\0request");
        let project = fullmag_session::hex_sha256(b"api\0session");
        let mut specification = RunSpecification::new(
            ProjectSnapshot {
                project_id: ProjectId::parse(format!("project-live-{project}")).unwrap(),
                definition_revision: 7,
                definition_sha256: "b".repeat(64),
            },
            StudyReference {
                study_id: StudyId::parse(format!("live-study-{identity}")).unwrap(),
                plan_version: "study_plan.v4".into(),
                plan_sha256: "c".repeat(64),
            },
            "d".repeat(64),
            json!({"live_workspace": {
                "api_instance_id": "api", "session_id": "session", "session_epoch": 1,
                "scene_revision": 7, "command_id": "request", "request_idempotency_key": "request",
                "step_id": null, "startup_source_sha256": source,
                "command": {"kind": "startup_script", "request_id": "request", "source_sha256": source},
            }}),
            RequestedExecution { backend: "fem".into(), device: "cpu".into(),
                precision: "double".into(), mode: "strict".into(),
                minimum_resources: Some(RequestedResourceBudget {
                    cpu_millis: 1000, memory_bytes: 1024, gpu_memory_bytes: 0, storage_bytes: 1024,
                }),
            },
        );
        specification.run_id = RunId::parse(format!("run-live-{identity}")).unwrap();
        specification.validate().unwrap();
        specification
    }

    #[test]
    fn startup_control_metadata_is_not_an_unbound_physics_parameter() {
        let mut specification = startup();
        validate_accepted_inspection_run_parameters(&specification, "inspect").unwrap();
        specification.parameters[fullmag_session::ACCEPTED_RUN_START_POLICY_KEY] = json!({
            "schema_version": "accepted_run_start_policy.v1", "mode": "manual",
        });
        // The existing durable start gate separately requires the exact Compute release.
        validate_accepted_inspection_run_parameters(&specification, "inspect").unwrap();
        specification.parameters = json!({});
        validate_accepted_inspection_run_parameters(&specification, "inspect").unwrap();
    }

    #[test]
    fn startup_and_solve_accept_versioned_input_identity_and_legacy_binding() {
        let mut solve = startup();
        solve.parameters["live_workspace"]["command"] = json!({
            "kind": "solve", "command_id": "request",
        });
        solve.parameters["live_workspace"]["startup_source_sha256"] = json!(null);
        solve.parameters["live_workspace"]["request_idempotency_key"] = json!(null);
        let solve_identity = fullmag_session::hex_sha256(b"api\0session\01\07\0request\0");
        solve.run_id = RunId::parse(format!("run-live-{solve_identity}")).unwrap();
        solve.study.study_id = StudyId::parse(format!("live-study-{solve_identity}")).unwrap();
        for mut specification in [startup(), solve] {
            validate_accepted_inspection_run_parameters(&specification, "inspect").unwrap();
            specification.parameters["live_workspace"]["execution_input"] = json!({
                "schema_version": fullmag_authoring::SCENE_EXECUTION_INPUT_SCHEMA,
                "sha256": "f".repeat(64),
            });
            validate_accepted_inspection_run_parameters(&specification, "inspect").unwrap();
            specification.parameters[fullmag_session::ACCEPTED_RUN_START_POLICY_KEY] = json!({
                "schema_version": "accepted_run_start_policy.v1", "mode": "manual",
            });
            validate_accepted_inspection_run_parameters(&specification, "inspect").unwrap();
        }
    }

    #[test]
    fn malformed_versioned_input_identity_and_start_policy_are_rejected() {
        for identity in [
            json!(null),
            json!({"schema_version": "unknown", "sha256": "f".repeat(64)}),
            json!({"schema_version": fullmag_authoring::SCENE_EXECUTION_INPUT_SCHEMA,
                "sha256": "not-a-digest"}),
            json!({"schema_version": fullmag_authoring::SCENE_EXECUTION_INPUT_SCHEMA,
                "sha256": "g".repeat(64)}),
            json!({"schema_version": fullmag_authoring::SCENE_EXECUTION_INPUT_SCHEMA,
                "sha256": "f".repeat(64), "extra": true}),
        ] {
            let mut specification = startup();
            specification.parameters["live_workspace"]["execution_input"] = identity;
            assert!(validate_accepted_inspection_run_parameters(&specification, "inspect").is_err());
        }
        let mut specification = startup();
        specification.parameters[fullmag_session::ACCEPTED_RUN_START_POLICY_KEY] = json!({
            "schema_version": "accepted_run_start_policy.v1", "mode": "automatic",
        });
        assert!(validate_accepted_inspection_run_parameters(&specification, "inspect").is_err());
    }

    #[test]
    fn unknown_physics_foreign_live_context_and_source_substitution_are_rejected() {
        let original = startup();
        for (pointer, value) in [
            ("/parameters/temperature", json!(300)),
            ("/parameters/live_workspace/extra", json!(true)),
            ("/parameters/live_workspace/session_epoch", json!(2)),
            ("/parameters/live_workspace/scene_revision", json!(8)),
            ("/parameters/live_workspace/step_id", json!("foreign")),
            ("/parameters/live_workspace/startup_source_sha256", json!("e".repeat(64))),
        ] {
            let mut value_spec = serde_json::to_value(&original).unwrap();
            let (parent, key) = pointer.rsplit_once('/').unwrap();
            value_spec.pointer_mut(parent).unwrap().as_object_mut().unwrap().insert(key.into(), value);
            let changed: RunSpecification = serde_json::from_value(value_spec).unwrap();
            assert!(validate_accepted_inspection_run_parameters(&changed, "inspect").is_err(), "{pointer}");
        }
    }
}

#[cfg(test)]
mod accepted_fem_runtime_tests {
    use super::resolve_requested_fem_device;

    #[test]
    fn auto_resolves_from_authoritative_cpu_or_gpu_lease() {
        assert_eq!(
            resolve_requested_fem_device(
                "auto",
                fullmag_session::FmsResourceKind::Cpu,
                0
            )
            .unwrap(),
            "cpu"
        );
        assert_eq!(
            resolve_requested_fem_device(
                "auto",
                fullmag_session::FmsResourceKind::Gpu,
                8 * 1024 * 1024
            )
            .unwrap(),
            "gpu"
        );
    }

    #[test]
    fn explicit_device_mismatch_and_invalid_budget_fail_closed() {
        assert!(resolve_requested_fem_device(
            "gpu",
            fullmag_session::FmsResourceKind::Cpu,
            0
        )
        .is_err());
        assert!(resolve_requested_fem_device(
            "cpu",
            fullmag_session::FmsResourceKind::Gpu,
            8 * 1024 * 1024
        )
        .is_err());
        assert!(resolve_requested_fem_device(
            "auto",
            fullmag_session::FmsResourceKind::Cpu,
            1
        )
        .is_err());
        assert!(resolve_requested_fem_device(
            "auto",
            fullmag_session::FmsResourceKind::Gpu,
            0
        )
        .is_err());
    }

    #[test]
    fn gpu_lane_is_scoped_to_receipted_time_evolution_or_llg() {
        let source = include_str!("accepted_fem_study_worker.rs");
        assert!(source.contains("StudyIR::TimeEvolution { .. }"));
        assert!(source.contains("RelaxationAlgorithmIR::LlgOverdamped"));
        assert!(source.contains("does not have a native execution receipt"));
    }

    #[test]
    fn host_gpu_admission_keeps_claim_lease_and_environment_fences() {
        let source = include_str!("accepted_study_worker.rs");
        for needle in [
            "validate_active_fms_lease_matches_claim",
            "lease.heartbeat_sequence < claim.lease.heartbeat_sequence",
            "require_gpu_binding",
            "gpu_vram_bytes_by_uuid",
            "FULLMAG_FEM_GPU_INDEX",
        ] {
            assert!(source.contains(needle), "missing host GPU fence: {needle}");
        }
    }

    #[test]
    fn common_host_launch_gate_requires_binding_for_gpu_but_not_cpu() {
        assert!(super::requires_gpu_host_binding(
            fullmag_session::FmsResourceKind::Gpu,
            false
        ));
        assert!(!super::requires_gpu_host_binding(
            fullmag_session::FmsResourceKind::Cpu,
            false
        ));
        assert!(super::requires_gpu_host_binding(
            fullmag_session::FmsResourceKind::Cpu,
            true
        ));
    }

    #[test]
    fn restored_manual_worker_requires_exact_compute_release_before_claim_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let store = fullmag_session::SessionStore::open(directory.path().join("store")).unwrap();
        let run_id = "run-manual-worker-recovery";
        let task_id = "task-recovered";
        let intent = fullmag_session::FmsRunIntent::new(
            run_id,
            "intent-manual-worker-recovery",
            serde_json::json!({
                "schema_version": "run_spec.v2",
                "run_id": run_id,
                "snapshot": {
                    "project_id": "project-manual-worker-recovery",
                    "definition_revision": 1,
                    "definition_sha256": "a".repeat(64)
                },
                "study": {
                    "study_id": "study-manual-worker-recovery",
                    "plan_version": "study_plan.v2",
                    "plan_sha256": "b".repeat(64)
                },
                "study_catalog_sha256": "c".repeat(64),
                "parameters": {
                    (fullmag_session::ACCEPTED_RUN_START_POLICY_KEY): {
                        "schema_version": "accepted_run_start_policy.v1",
                        "mode": "manual"
                    }
                },
                "seeds": {},
                "dependencies": [],
                "immutable_assets": [],
                "requested_execution": {
                    "backend": "fdm",
                    "device": "cpu",
                    "precision": "double",
                    "mode": "strict",
                    "minimum_resources": {
                        "cpu_millis": 100,
                        "memory_bytes": 1,
                        "gpu_memory_bytes": 0,
                        "storage_bytes": 1
                    }
                }
            }),
        );
        store.commit_run_intent(&intent).unwrap();
        store
            .commit_run_catalog(&fullmag_session::FmsRunCatalog {
                schema_version: fullmag_session::FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: chrono::Utc::now(),
                tasks: vec![fullmag_session::FmsTaskCatalogEntry {
                    task_id: task_id.into(),
                    input_fingerprint: "d".repeat(64),
                    lifecycle: fullmag_session::FmsTaskLifecycle::Preparing,
                    readiness: fullmag_session::FmsTaskReadiness::Ready,
                    observation: None,
                    attempt_id: Some("attempt-recovered".into()),
                    ownership_epoch: Some(1),
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: Some("resource-cpu".into()),
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();

        let error = match super::run_pending_accepted_start(&store, run_id, task_id) {
            Ok(_) => panic!("manual worker recovery must not execute without a release"),
            Err(error) => error,
        };
        assert!(
            format!("{error:#}").contains("explicit Compute release"),
            "missing exact release must fail before claim recovery: {error:#}"
        );
    }
}

#[cfg(test)]
mod accepted_worker_claim_retry_tests {
    use super::*;
    use std::sync::mpsc::sync_channel;
    use std::thread;
    use std::time::Duration;

    fn unclaimed_task(task_id: &str) -> fullmag_session::FmsTaskCatalogEntry {
        fullmag_session::FmsTaskCatalogEntry {
            task_id: task_id.into(),
            input_fingerprint: "a".repeat(64),
            lifecycle: fullmag_session::FmsTaskLifecycle::Queued,
            readiness: fullmag_session::FmsTaskReadiness::Ready,
            observation: None,
            attempt_id: None,
            ownership_epoch: Some(1),
            resolved_input_fingerprint: None,
            artifact_ids: Vec::new(),
            resource_id: None,
            coordinator_watermark: None,
            coordinator_genesis: None,
        }
    }

    fn cancellation_store() -> (tempfile::TempDir, SessionStore) {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let run_id = "run-worker-claim-cancel";
        let task_id = "task-worker-claim-cancel";
        store
            .commit_run_catalog(&fullmag_session::FmsRunCatalog {
                schema_version: fullmag_session::FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: chrono::Utc::now(),
                tasks: vec![unclaimed_task(task_id)],
            })
            .unwrap();
        store
            .request_task_cancellation_intent(
                run_id,
                task_id,
                "cancel-worker-claim",
                1,
                "operator requested cancellation",
            )
            .unwrap();
        (directory, store)
    }

    #[test]
    fn typed_native_writer_conflict_retries_after_release() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let holder_store = SessionStore::open(store.root().to_path_buf()).unwrap();
        let (acquired_sender, acquired_receiver) = sync_channel(1);
        let (release_sender, release_receiver) = sync_channel(1);
        let holder = thread::spawn(move || {
            let transaction = holder_store.write_transaction().unwrap();
            acquired_sender.send(()).unwrap();
            release_receiver
                .recv_timeout(Duration::from_secs(2))
                .unwrap();
            drop(transaction);
        });
        acquired_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        let mut busy_count = 0_u32;
        let mut release_sender = Some(release_sender);
        let result = retry_worker_claim_store_busy(
            &store,
            "run-worker-claim-retry",
            "task-worker-claim-retry",
            || match store.write_transaction() {
                Ok(transaction) => {
                    drop(transaction);
                    Ok(())
                }
                Err(error) => {
                    busy_count = busy_count.saturating_add(1);
                    if busy_count == 1 {
                        release_sender.take().unwrap().send(()).unwrap();
                    }
                    Err(error)
                }
            },
        );
        if let Some(sender) = release_sender.take() {
            sender.send(()).unwrap();
        }
        holder.join().unwrap();

        assert!(result.is_ok(), "typed writer conflict should retry: {result:#?}");
        assert!(
            busy_count > 0,
            "the fixture must observe a native typed StoreWriterBusy conflict"
        );
    }

    #[test]
    fn textual_busy_and_nonbusy_errors_are_not_retried() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        for message in [
            "session store writer is busy: fake textual error",
            "claim validation failed permanently",
        ] {
            let mut attempts = 0_u32;
            let error = retry_worker_claim_store_busy(
                &store,
                "run-worker-claim-error",
                "task-worker-claim-error",
                || {
                    attempts = attempts.saturating_add(1);
                    Err::<(), _>(anyhow::anyhow!(message))
                },
            )
            .unwrap_err();
            assert_eq!(attempts, 1, "error must fail closed without replay: {message}");
            assert!(format!("{error:#}").contains(message));
        }
    }

    #[test]
    fn durable_cancellation_stops_a_typed_busy_retry() {
        let (_directory, store) = cancellation_store();
        let mut attempts = 0_u32;
        let error = retry_worker_claim_store_busy(
            &store,
            "run-worker-claim-cancel",
            "task-worker-claim-cancel",
            || {
                attempts = attempts.saturating_add(1);
                Err::<(), _>(anyhow::Error::new(fullmag_session::StoreWriterBusy))
            },
        )
        .unwrap_err();

        assert_eq!(attempts, 1, "durable cancellation must stop before retry");
        assert!(format!("{error:#}").contains("cancelled by durable task cancellation"));
    }
}
