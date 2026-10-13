//! Parent-side process pool for independent FEM dispersion samples.
//!
//! The pool owns admission and cancellation.  It never calls MFEM/PETSc from
//! a Rust thread and never passes native solver state between samples.  The
//! child protocol lives in `fem::eigen_k_worker` and is intentionally file
//! based so the normal CLI startup banner cannot corrupt the response.

use crate::adaptive_resources::{
    AdaptiveAdmission, AdmissionDecision, ResourceSampler, ResourceSnapshot, WorkerPeak,
    WorkerSampleError,
};
use crate::fem::eigen_k_worker::{
    build_identity_json, executable_sha256, worker_thread_environment, EigenKWorkerHandshakeV1,
    EigenKWorkerRequestV2, EigenKWorkerResponseV1, EigenKWorkerThreadBudgetV1,
    EIGEN_K_WORKER_HANDSHAKE_V1, EIGEN_K_WORKER_PROTOCOL_V2,
};
use crate::types::StepAction;
use fullmag_ir::{ParallelExecutionModeIR, ParallelExecutionPolicyIR};
use serde::Serialize;
use serde_json::Value;
use sha2::Digest;
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const MAX_ADMISSION_EVENTS: usize = 2048;
const TELEMETRY_RETRY_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_WORKER_LOG_BYTES: u64 = 1024 * 1024;
const MAX_ADMISSION_JOURNAL_BYTES: usize = 4 * 1024 * 1024;

fn resolve_serial_thread_budget(
    requested_threads: u32,
    allocation_cpu_cores: f64,
    host_cpu_cores: u32,
) -> Result<EigenKWorkerThreadBudgetV1, String> {
    if requested_threads == 0
        || !allocation_cpu_cores.is_finite()
        || allocation_cpu_cores < 1.0
        || host_cpu_cores == 0
    {
        return Err("serial worker thread budget requires positive task allocation and host capacity".into());
    }
    let allocation_cap = allocation_cpu_cores.floor().min(u32::MAX as f64) as u32;
    let resolved_threads = requested_threads
        .min(allocation_cap)
        .min(host_cpu_cores)
        .max(1);
    let cap_reason = if resolved_threads < requested_threads {
        if allocation_cap < host_cpu_cores {
            "serial_process_pool_capped_by_cpu_allocation"
        } else {
            "serial_process_pool_capped_by_host_parallelism"
        }
    } else {
        "serial_process_pool_requested_threads"
    };
    Ok(EigenKWorkerThreadBudgetV1 {
        requested_threads,
        resolved_threads,
        cap_reason: cap_reason.into(),
        allocation_cpu_cores,
        host_cpu_cores,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingWorkerExitTelemetry {
    since: Instant,
    source: String,
}

#[derive(Debug, PartialEq, Eq)]
enum WorkerExitTelemetryError {
    Other(String),
    TimedOut { elapsed: Duration, source: String },
    MissingTerminalPeak,
    InvalidTerminalPeak,
}

impl WorkerExitTelemetryError {
    fn message(&self) -> String {
        match self {
            Self::Other(error) => error.clone(),
            Self::TimedOut { elapsed, source } => format!(
                "worker exit telemetry unresolved after {} ms: {source}",
                elapsed.as_millis(),
            ),
            Self::MissingTerminalPeak => {
                "pending worker exit telemetry requires a terminal resource measurement".into()
            }
            Self::InvalidTerminalPeak => {
                "pending worker exit telemetry requires finite positive terminal CPU and RSS".into()
            }
        }
    }

    fn is_timeout(&self) -> bool {
        matches!(self, Self::TimedOut { .. })
    }
}

fn transition_worker_exit_telemetry_after_sample(
    pending: Option<&PendingWorkerExitTelemetry>,
    sample_error: Option<&WorkerSampleError>,
    now: Instant,
) -> Result<Option<PendingWorkerExitTelemetry>, WorkerExitTelemetryError> {
    if let Some(pending) = pending {
        let elapsed = now.saturating_duration_since(pending.since);
        if elapsed >= TELEMETRY_RETRY_TIMEOUT {
            return Err(WorkerExitTelemetryError::TimedOut {
                elapsed,
                source: pending.source.clone(),
            });
        }
    }

    match sample_error {
        None => Ok(None),
        Some(WorkerSampleError::ProcessExitRace(source)) => {
            Ok(Some(pending.cloned().unwrap_or_else(|| {
                PendingWorkerExitTelemetry {
                    since: now,
                    source: source.to_string(),
                }
            })))
        }
        Some(WorkerSampleError::Other(error)) => {
            Err(WorkerExitTelemetryError::Other(error.clone()))
        }
    }
}

fn resolve_worker_exit_telemetry_from_terminal(
    pending: Option<&PendingWorkerExitTelemetry>,
    terminal_peak: Option<WorkerPeak>,
    now: Instant,
) -> Result<(), WorkerExitTelemetryError> {
    let Some(pending) = pending else {
        return Ok(());
    };
    let elapsed = now.saturating_duration_since(pending.since);
    if elapsed >= TELEMETRY_RETRY_TIMEOUT {
        return Err(WorkerExitTelemetryError::TimedOut {
            elapsed,
            source: pending.source.clone(),
        });
    }
    let Some(peak) = terminal_peak else {
        return Err(WorkerExitTelemetryError::MissingTerminalPeak);
    };
    if !peak.cpu_cores.is_finite() || peak.cpu_cores <= 0.0 || peak.rss_bytes == 0 {
        return Err(WorkerExitTelemetryError::InvalidTerminalPeak);
    }
    Ok(())
}

fn worker_admission_open(telemetry_open: bool, exit_telemetry_pending: bool) -> bool {
    telemetry_open && !exit_telemetry_pending
}

fn telemetry_retry_expired(since: &mut Option<Instant>, now: Instant) -> bool {
    let started = since.get_or_insert(now);
    now.saturating_duration_since(*started) >= TELEMETRY_RETRY_TIMEOUT
}

/// This is sampling coverage, not a proof that no sub-interval CPU spike exists.
/// Sparse observations retain the child's complete resolved team as a demand envelope.
#[derive(Default, Clone, Copy)]
struct WorkerCpuCoverage {
    intervals: u32,
    duration: Duration,
}
impl WorkerCpuCoverage {
    fn observe(&mut self, interval: Option<Duration>) {
        if let Some(interval) = interval.filter(|value| !value.is_zero() && *value <= Duration::from_secs(1)) {
            self.intervals = self.intervals.saturating_add(1);
            self.duration = self.duration.saturating_add(interval);
        }
    }
    fn sufficient(self) -> bool {
        self.intervals >= 3 && self.duration >= Duration::from_secs(1)
    }
}

fn validate_worker_policy(
    pool: &ParallelExecutionPolicyIR,
    worker: &ParallelExecutionPolicyIR,
    sample_index: usize,
) -> Result<(), String> {
    if pool != worker {
        return Err(format!("eigen worker sample {sample_index} parallel policy differs from its parent pool"));
    }
    Ok(())
}

fn combined_worker_demand(
    sampled: WorkerPeak,
    terminal: WorkerPeak,
    resolved_threads: u32,
    coverage: WorkerCpuCoverage,
) -> WorkerPeak {
    // Terminal CPU is an interval average, not a peak. If the child was too
    // short or too sparsely observed, reserve its complete resolved team.
    let sampled_cpu = if coverage.sufficient() && sampled.cpu_cores > 0.0 {
        sampled.cpu_cores
    } else {
        resolved_threads as f64
    };
    WorkerPeak {
        cpu_cores: sampled_cpu.max(terminal.cpu_cores),
        rss_bytes: sampled.rss_bytes.max(terminal.rss_bytes),
    }
}

fn observe_admission_peak(
    admission: &mut AdaptiveAdmission,
    observed: &mut WorkerPeak,
    measured: WorkerPeak,
) -> Result<(), String> {
    // Update the full-pool envelope while the worker is alive, before the next
    // admission decision. Completion is only needed to certify calibration.
    admission.observe(measured)?;
    observed.cpu_cores = observed.cpu_cores.max(measured.cpu_cores);
    observed.rss_bytes = observed.rss_bytes.max(measured.rss_bytes);
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PermanentAdmissionInfeasibility {
    MemoryReserveConsumesAllowedBudget {
        allowed_memory_bytes: u64,
        reserve_bytes: u64,
    },
    CalibratedWorkerEnvelopeExceedsBudget {
        worker_memory_envelope_bytes: u64,
        pool_memory_budget_bytes: u64,
    },
}

impl PermanentAdmissionInfeasibility {
    fn reason(&self) -> &'static str {
        match self {
            Self::MemoryReserveConsumesAllowedBudget { .. } => {
                "permanent_memory_reserve_consumes_allowed_budget"
            }
            Self::CalibratedWorkerEnvelopeExceedsBudget { .. } => {
                "calibrated_worker_memory_envelope_exceeds_budget"
            }
        }
    }

    fn message(&self) -> String {
        match self {
            Self::MemoryReserveConsumesAllowedBudget {
                allowed_memory_bytes,
                reserve_bytes,
            } => format!(
                "eigen process pool admission impossible ({}): memory reserve {reserve_bytes} bytes consumes the allowed {allowed_memory_bytes} byte memory budget",
                self.reason(),
            ),
            Self::CalibratedWorkerEnvelopeExceedsBudget {
                worker_memory_envelope_bytes,
                pool_memory_budget_bytes,
            } => format!(
                "eigen process pool admission impossible ({}): calibrated worker memory envelope {worker_memory_envelope_bytes} bytes exceeds the {pool_memory_budget_bytes} byte pool budget",
                self.reason(),
            ),
        }
    }
}

fn classify_permanent_admission_infeasibility(
    policy: &ParallelExecutionPolicyIR,
    decision: &AdmissionDecision,
    snapshot: Option<&ResourceSnapshot>,
    observed_peak: WorkerPeak,
    calibrated: bool,
) -> Option<PermanentAdmissionInfeasibility> {
    if decision.desired_workers != 0 {
        return None;
    }
    let expected_memory_block_reason = if calibrated {
        "insufficient_memory_for_worker"
    } else {
        "insufficient_memory_for_probe"
    };
    if decision.reason != expected_memory_block_reason {
        return None;
    }
    let snapshot = snapshot?;
    let allowed_memory_bytes =
        (snapshot.memory_limit_bytes as f64 * policy.max_memory_percent / 100.0) as u64;
    let pool_memory_budget_bytes =
        allowed_memory_bytes.saturating_sub(policy.memory_reserve_bytes);
    if policy.memory_reserve_bytes >= allowed_memory_bytes {
        return Some(
            PermanentAdmissionInfeasibility::MemoryReserveConsumesAllowedBudget {
                allowed_memory_bytes,
                reserve_bytes: policy.memory_reserve_bytes,
            },
        );
    }
    if calibrated {
        // Match AdaptiveAdmission's integer 25% margin exactly. This is a
        // pool-wide policy bound; current memory_available_bytes is pressure
        // telemetry and may recover, so it is deliberately not used here.
        let worker_memory_envelope_bytes = observed_peak
            .rss_bytes
            .saturating_add(observed_peak.rss_bytes / 4)
            .max(1);
        if worker_memory_envelope_bytes > pool_memory_budget_bytes {
            return Some(
                PermanentAdmissionInfeasibility::CalibratedWorkerEnvelopeExceedsBudget {
                    worker_memory_envelope_bytes,
                    pool_memory_budget_bytes,
                },
            );
        }
    }
    None
}

fn permanent_admission_failure_if_running(
    failure: Option<PermanentAdmissionInfeasibility>,
    cancel: &AtomicBool,
    admission_open: bool,
    active_workers: usize,
    pending_samples: usize,
) -> Option<PermanentAdmissionInfeasibility> {
    if cancel.load(Ordering::Relaxed)
        || !admission_open
        || active_workers != 0
        || pending_samples == 0
    {
        return None;
    }
    failure
}

fn bounded_worker_log_tail(reader: &mut (impl Read + Seek)) -> std::io::Result<Vec<u8>> {
    let end = reader.seek(SeekFrom::End(0))?;
    reader.seek(SeekFrom::Start(end.saturating_sub(MAX_WORKER_LOG_BYTES)))?;
    let mut bytes = Vec::with_capacity(end.min(MAX_WORKER_LOG_BYTES) as usize);
    reader.take(MAX_WORKER_LOG_BYTES).read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn admission_may_spawn_worker(cancel: &AtomicBool, control_action: Option<StepAction>) -> bool {
    !cancel.load(Ordering::Relaxed) && control_action.is_none()
}

fn pool_terminal_state(action: StepAction) -> &'static str {
    match action {
        StepAction::Continue => "completed",
        StepAction::Pause => "paused",
        StepAction::Stop => "cancelled",
    }
}

fn pool_control_can_finish(action: StepAction, active_workers: usize) -> bool {
    action == StepAction::Stop || (action == StepAction::Pause && active_workers == 0)
}

fn clean_stop_cancellation_response(
    action: Option<StepAction>,
    response: &EigenKWorkerResponseV1,
) -> bool {
    action == Some(StepAction::Stop)
        && response.ok
        && response.error.is_none()
        && response.run.as_ref().is_some_and(|run| {
            matches!(run.status, crate::types::RunStatus::Cancelled)
        })
}

fn adaptive_pool_outcome(
    action: Option<StepAction>,
    mut responses: Vec<(usize, EigenKWorkerResponseV1)>,
    report: ProcessPoolReportV1,
) -> ProcessPoolOutcome {
    responses.sort_by_key(|(request_index, _)| *request_index);
    let result = ProcessPoolResult {
        responses: responses
            .into_iter()
            .map(|(_, response)| response)
            .collect(),
        report,
    };
    match action {
        Some(action @ (StepAction::Pause | StepAction::Stop)) => {
            ProcessPoolOutcome::Interrupted {
                action,
                partial: result,
            }
        }
        Some(StepAction::Continue) | None => ProcessPoolOutcome::Completed(result),
    }
}

fn requested_control_action(
    cancel: &AtomicBool,
    pending_action: &mut Option<StepAction>,
    check_control: &mut Option<&mut dyn FnMut(Option<&ProcessAdmissionEventV1>) -> StepAction>,
    event: Option<&ProcessAdmissionEventV1>,
) -> Option<StepAction> {
    if *pending_action == Some(StepAction::Stop) {
        return Some(StepAction::Stop);
    }
    let action = if cancel.load(Ordering::Relaxed) {
        StepAction::Stop
    } else {
        check_control
            .as_deref_mut()
            .map(|check| check(event))
            .unwrap_or(StepAction::Continue)
    };
    match action {
        StepAction::Stop => *pending_action = Some(StepAction::Stop),
        StepAction::Pause => {
            *pending_action = Some(StepAction::Pause);
        }
        StepAction::Continue => {}
    }
    *pending_action
}

// Only the manifest beside this exact API bundle can select a managed worker.
// An explicit managed declaration must fail closed; legacy sibling lookup is
// retained only for bundles that do not declare this managed runtime.
fn resolve_managed_worker_sibling(current: &Path) -> Result<Option<PathBuf>, String> {
    let bin = current.parent().ok_or("API executable has no parent")?;
    if bin.file_name().and_then(|name| name.to_str()) != Some("bin") {
        return Ok(None);
    }
    let root = bin.parent().ok_or("managed bin directory has no parent")?;
    let manifest_path = root.join("manifest.json");
    if !manifest_path.try_exists().map_err(|error| format!("inspect managed manifest: {error}"))? {
        return Ok(None);
    }
    let manifest_path = manifest_path.canonicalize()
        .map_err(|error| format!("canonicalize managed manifest: {error}"))?;
    if manifest_path.parent() != Some(root) {
        return Err("managed manifest escapes the API bundle".to_string());
    }
    let file = fs::File::open(&manifest_path)
        .map_err(|error| format!("open managed manifest: {error}"))?;
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1).read_to_end(&mut bytes)
        .map_err(|error| format!("read managed manifest: {error}"))?;
    if bytes.len() > 1024 * 1024 {
        return Err("managed manifest exceeds the bounded byte limit".to_string());
    }
    let manifest: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("decode managed manifest: {error}"))?;
    if manifest.get("runtime").and_then(Value::as_str) != Some("fem-gpu-host") {
        return Ok(None);
    }
    if manifest.get("schema").and_then(Value::as_u64) != Some(3) {
        return Err("unsupported managed worker manifest schema".to_string());
    }
    let binaries = manifest.get("binaries").ok_or("managed manifest has no binaries")?;
    let resolve = |name: &str| -> Result<PathBuf, String> {
        let relative = binaries.get(name).and_then(Value::as_str)
            .ok_or_else(|| format!("managed manifest has no {name} binary"))?;
        let path = Path::new(relative);
        let components: Vec<_> = path.components().collect();
        if components.len() != 2 ||
            components[0] != std::path::Component::Normal(std::ffi::OsStr::new("bin")) ||
            !matches!(components[1], std::path::Component::Normal(_)) {
            return Err(format!("managed {name} binary must be directly inside bin"));
        }
        let canonical = root.join(path).canonicalize()
            .map_err(|error| format!("resolve managed {name} binary: {error}"))?;
        if canonical.parent() != Some(bin) || !canonical.is_file() {
            return Err(format!("managed {name} binary escapes bin or is not a file"));
        }
        if fs::metadata(&canonical).map_err(|error| error.to_string())?.len() == 0 {
            return Err(format!("managed {name} binary is empty"));
        }
        let key = format!("{name}_sha256");
        let expected = manifest.get("integrity").and_then(|value| value.get(&key))
            .and_then(Value::as_str).ok_or_else(|| format!("managed manifest has no {name} digest"))?;
        let observed = executable_sha256(&canonical).map_err(|error| error.message)?;
        if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) ||
            observed.strip_prefix("sha256:") != Some(expected) {
            return Err(format!("managed {name} binary digest mismatch"));
        }
        Ok(canonical)
    };
    if resolve("api")? != current {
        return Err("managed manifest does not identify this API executable".to_string());
    }
    let worker = resolve("worker")?;
    if worker == current {
        return Err("managed worker cannot be the API executable".to_string());
    }
    Ok(Some(worker))
}

fn resolve_worker_executable() -> Result<PathBuf, String> {
    let current = std::env::current_exe()
        .map_err(|error| format!("resolve current Fullmag executable: {error}"))?
        .canonicalize()
        .map_err(|error| format!("canonicalize current Fullmag executable: {error}"))?;
    let current_name = current
        .file_stem()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "current Fullmag executable has no valid file name".to_string())?;
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let mut candidates = Vec::new();
    match current_name.as_str() {
        "fullmag-bin" | "fullmag" | "fullmag-fem-gpu-bin" => candidates.push(current.clone()),
        "fullmag-api" => {
            if let Some(worker) = resolve_managed_worker_sibling(&current)? {
                return Ok(worker);
            }
            // The API and CLI are shipped as one bundle.  The API process is
            // the normal GUI parent, while the hidden worker command belongs
            // to the CLI binary.  Resolve only its sibling from the same
            // canonical directory; never honor an arbitrary executable path.
            if let Some(parent) = current.parent() {
                candidates.push(parent.join(format!("fullmag-bin{suffix}")));
                candidates.push(parent.join(format!("fullmag{suffix}")));
            }
        }
        _ => {}
    }
    let current_parent = current
        .parent()
        .ok_or_else(|| "current Fullmag executable has no parent directory".to_string())?;
    for candidate in candidates {
        let Ok(canonical) = candidate.canonicalize() else {
            continue;
        };
        if canonical.parent() != Some(current_parent) || !canonical.is_file() {
            continue;
        }
        let metadata = fs::metadata(&canonical)
            .map_err(|error| format!("inspect Fullmag worker candidate {canonical:?}: {error}"))?;
        if metadata.len() == 0 {
            return Err(format!("Fullmag worker candidate is empty: {canonical:?}"));
        }
        return Ok(canonical);
    }
    Err(format!(
        "no allowlisted Fullmag CLI worker sibling found beside {} (current process is {current_name})",
        current.display()
    ))
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ProcessAdmissionEventV1 {
    pub at_unix_ms: u128,
    pub active_workers: usize,
    pub pending_samples: usize,
    pub desired_workers: usize,
    pub reason: String,
    pub cpu_target_kind: String,
    pub snapshot: Option<crate::adaptive_resources::ResourceSnapshot>,
    pub worker_peak: Option<WorkerPeak>,
}

fn same_admission_state(last: &ProcessAdmissionEventV1, event: &ProcessAdmissionEventV1) -> bool {
    // Ignore sampling timestamps, but retain every resource value used by admission.
    last.active_workers == event.active_workers
        && last.pending_samples == event.pending_samples
        && last.desired_workers == event.desired_workers
        && last.reason == event.reason
        && last.cpu_target_kind == event.cpu_target_kind
        && match (&last.worker_peak, &event.worker_peak) {
            (None, None) => true,
            (Some(a), Some(b)) => a.cpu_cores == b.cpu_cores && a.rss_bytes == b.rss_bytes,
            _ => false,
        }
        && match (&last.snapshot, &event.snapshot) {
            (None, None) => true,
            (Some(a), Some(b)) => {
                a.allocated_cpu_cores == b.allocated_cpu_cores
                    && a.cpu_busy_percent == b.cpu_busy_percent
                    && a.cpu_available_cores == b.cpu_available_cores
                    && a.memory_limit_bytes == b.memory_limit_bytes
                    && a.memory_available_bytes == b.memory_available_bytes
                    && a.allocation_sources == b.allocation_sources
            }
            _ => false,
        }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ProcessPoolInputBindingV1 {
    pub sample_index: usize,
    pub plan_sha256: String,
    pub equilibrium_artifact_sha256: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ProcessPoolThreadBindingV1 {
    pub sample_index: usize,
    pub budget: EigenKWorkerThreadBudgetV1,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ProcessPoolCpuObservationV1 {
    pub sample_index: usize,
    pub valid_intervals: u32,
    pub observed_seconds: f64,
    pub demand_source: String,
    pub sampled_peak_cpu_cores: f64,
    pub terminal_average_cpu_cores: f64,
    pub resolved_threads: u32,
    pub demand_cpu_cores: f64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ProcessPoolReportV1 {
    pub protocol: String,
    pub requested_mode: ParallelExecutionModeIR,
    pub resolved_mode: String,
    pub resolved_workers: usize,
    pub policy: ParallelExecutionPolicyIR,
    pub inputs: Vec<ProcessPoolInputBindingV1>,
    pub thread_bindings: Vec<ProcessPoolThreadBindingV1>,
    pub cpu_observations: Vec<ProcessPoolCpuObservationV1>,
    pub worker_logs: Vec<ProcessPoolWorkerLogV1>,
    pub events: Vec<ProcessAdmissionEventV1>,
    pub events_truncated: bool,
    pub telemetry_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ProcessPoolWorkerLogV1 {
    pub sample_index: usize,
    pub stdout_path: PathBuf,
    pub stderr_path: PathBuf,
    pub handshake_path: PathBuf,
    pub worker_executable_sha256: String,
    pub worker_build_identity: Value,
}

#[derive(Debug)]
pub(crate) struct ProcessPoolResult {
    pub responses: Vec<EigenKWorkerResponseV1>,
    pub report: ProcessPoolReportV1,
}

#[derive(Debug)]
pub(crate) enum ProcessPoolOutcome {
    Completed(ProcessPoolResult),
    Interrupted {
        action: StepAction,
        partial: ProcessPoolResult,
    },
}

#[derive(Debug)]
enum WorkerWaitOutcome {
    Completed(EigenKWorkerResponseV1),
    CompletedInterrupted {
        action: StepAction,
        response: EigenKWorkerResponseV1,
    },
    Interrupted(StepAction),
}

/// Best-effort bounded evidence retained in the private pool root even when
/// execution returns an error before the normal report artifact is emitted.
/// The journal is deliberately throttled; it is not a per-sample event log.
struct AdmissionJournalGuard {
    path: PathBuf,
    report: ProcessPoolReportV1,
    terminal_state: String,
    last_write: Instant,
    finished: bool,
}

impl AdmissionJournalGuard {
    fn new(root: &Path, report: &ProcessPoolReportV1) -> Self {
        let mut journal = Self {
            path: root.join("admission-journal.v1.json"),
            report: report.clone(),
            terminal_state: "running".to_string(),
            last_write: Instant::now(),
            finished: false,
        };
        journal.write_now();
        journal
    }

    fn update(&mut self, report: &ProcessPoolReportV1) {
        if self.last_write.elapsed() < Duration::from_secs(5) {
            return;
        }
        self.report = report.clone();
        self.write_now();
    }

    fn finish(&mut self, report: &ProcessPoolReportV1, terminal_state: &str) {
        self.report = report.clone();
        self.terminal_state = terminal_state.to_string();
        self.finished = true;
        self.write_now();
    }

    fn write_now(&mut self) {
        let mut value = serde_json::json!({
            "schema_version": "fullmag.eigen.admission_journal.v1",
            "terminal_state": &self.terminal_state,
            "events_truncated": self.report.events_truncated,
            "report": &self.report,
        });
        let mut encoded = serde_json::to_vec_pretty(&value).unwrap_or_else(|_| b"{}".to_vec());
        if encoded.len() > MAX_ADMISSION_JOURNAL_BYTES {
            while encoded.len() > MAX_ADMISSION_JOURNAL_BYTES {
                // End the mutable array borrow before serializing the document.
                let removed = value
                    .get_mut("report")
                    .and_then(|report| report.get_mut("events"))
                    .and_then(serde_json::Value::as_array_mut)
                    .is_some_and(|events| {
                        if events.is_empty() {
                            false
                        } else {
                            events.remove(0);
                            true
                        }
                    });
                if !removed {
                    break;
                }
                match serde_json::to_vec_pretty(&value) {
                    Ok(next) => encoded = next,
                    Err(_) => break,
                }
            }
            if let Some(report) = value.get_mut("report") {
                report["events_truncated"] = serde_json::Value::Bool(true);
            }
            encoded = serde_json::to_vec_pretty(&value).unwrap_or_else(|_| b"{}".to_vec());
            if encoded.len() > MAX_ADMISSION_JOURNAL_BYTES {
                value = serde_json::json!({
                    "schema_version": "fullmag.eigen.admission_journal.v1",
                    "terminal_state": &self.terminal_state,
                    "events_truncated": true,
                });
                encoded = serde_json::to_vec_pretty(&value).unwrap_or_else(|_| b"{}".to_vec());
            }
        }
        let temporary = self
            .path
            .with_extension(format!("tmp-{}", std::process::id()));
        if fs::write(&temporary, encoded).is_ok() {
            let _ = fs::rename(&temporary, &self.path);
        }
        self.last_write = Instant::now();
    }
}

impl Drop for AdmissionJournalGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.terminal_state = "failed_or_cancelled".to_string();
            self.write_now();
        }
    }
}

struct ActiveWorker {
    request_index: usize,
    pid: u32,
    child: Child,
    peak: WorkerPeak,
    cpu_coverage: WorkerCpuCoverage,
    exit_telemetry_pending: Option<PendingWorkerExitTelemetry>,
    stdout_path: PathBuf,
    stderr_path: PathBuf,
    cancel_path: PathBuf,
    handshake_path: PathBuf,
    resolved_threads: u32,
}

impl Drop for ActiveWorker {
    fn drop(&mut self) {
        // Every error and cancellation path owns an ActiveWorker until it is
        // dropped.  Kill+wait here so a failed admission/read/telemetry path
        // cannot leak a native solver child or leave a PID for reuse.
        let _ = self.child.kill();
        let _ = self.child.wait();
        EigenKProcessPool::cap_worker_logs(self);
    }
}

pub(crate) struct EigenKProcessPool {
    root: PathBuf,
    executable: PathBuf,
    worker_executable_sha256: String,
    worker_build_identity: Value,
    policy: ParallelExecutionPolicyIR,
}

impl EigenKProcessPool {
    pub(crate) fn new(
        root: impl Into<PathBuf>,
        policy: ParallelExecutionPolicyIR,
    ) -> Result<Self, String> {
        policy.validate()?;
        let base_root = root.into();
        if !base_root.is_absolute() {
            return Err(
                "adaptive eigen process pool requires an absolute managed staging root".into(),
            );
        }
        fs::create_dir_all(&base_root)
            .map_err(|error| format!("create eigen process pool root: {error}"))?;
        let run_nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let root = base_root.join(format!("run-{run_nonce}-{}", std::process::id()));
        fs::create_dir_all(&root)
            .map_err(|error| format!("create eigen process pool run root: {error}"))?;
        let executable = resolve_worker_executable()?;
        let worker_executable_sha256 =
            executable_sha256(&executable).map_err(|error| error.message)?;
        let worker_build_identity = build_identity_json();
        Ok(Self {
            root,
            executable,
            worker_executable_sha256,
            worker_build_identity,
            policy,
        })
    }

    fn prepare_request(
        &self,
        source: &EigenKWorkerRequestV2,
        request_index: usize,
    ) -> Result<(EigenKWorkerRequestV2, PathBuf, PathBuf), String> {
        if source.protocol != EIGEN_K_WORKER_PROTOCOL_V2 {
            return Err(format!(
                "worker request {} has unsupported protocol {}",
                source.sample_index, source.protocol
            ));
        }
        let namespace = self.root.join(format!("worker-{request_index:06}"));
        let artifact_dir = namespace.join("artifacts");
        let request_path = namespace.join("request.json");
        let response_path = namespace.join("response.json");
        let worker_cancel_path = namespace.join("cancel.flag");
        fs::create_dir_all(&artifact_dir)
            .map_err(|error| format!("create worker namespace: {error}"))?;
        let mut request = source.clone();
        request.artifact_dir = artifact_dir.clone();
        request.response_path = response_path.clone();
        request.cancel_path = Some(worker_cancel_path);
        Ok((request, request_path, artifact_dir))
    }

    fn spawn_worker(
        &self,
        source: &EigenKWorkerRequestV2,
        request_index: usize,
        thread_budget: EigenKWorkerThreadBudgetV1,
    ) -> Result<ActiveWorker, String> {
        let (mut request, request_path, _artifact_dir) =
            self.prepare_request(source, request_index)?;
        let namespace = request_path
            .parent()
            .ok_or_else(|| "worker request has no private namespace".to_string())?;
        request.thread_budget = thread_budget;
        let handshake_path = namespace.join("handshake.json");
        let handshake = EigenKWorkerHandshakeV1 {
            protocol: EIGEN_K_WORKER_HANDSHAKE_V1.to_string(),
            request_index,
            sample_index: request.sample_index,
            executable_sha256: self.worker_executable_sha256.clone(),
            build_identity: self.worker_build_identity.clone(),
            expected_plan_sha256: request.expected_plan_sha256.clone(),
            expected_equilibrium_artifact_sha256: request
                .expected_equilibrium_artifact_sha256
                .clone(),
        };
        let handshake_bytes = serde_json::to_vec_pretty(&handshake)
            .map_err(|error| format!("encode eigen k worker handshake: {error}"))?;
        let handshake_temporary =
            handshake_path.with_extension(format!("tmp-{}", std::process::id()));
        fs::write(&handshake_temporary, handshake_bytes)
            .map_err(|error| format!("write eigen k worker handshake: {error}"))?;
        fs::rename(&handshake_temporary, &handshake_path)
            .map_err(|error| format!("publish eigen k worker handshake: {error}"))?;
        let encoded = serde_json::to_vec(&request)
            .map_err(|error| format!("encode worker request: {error}"))?;
        let temporary = request_path.with_extension(format!("tmp-{}", std::process::id()));
        fs::write(&temporary, encoded).map_err(|error| format!("write worker request: {error}"))?;
        fs::rename(&temporary, &request_path)
            .map_err(|error| format!("publish worker request: {error}"))?;
        // Set only the child's environment before exec: ELF constructors and
        // BLAS/OpenMP initialization must not observe the host's larger team.
        let child = Command::new(&self.executable)
            .envs(worker_thread_environment(&request.thread_budget))
            .arg("__eigen-k-worker")
            .arg("--request")
            .arg(&request_path)
            .stdin(Stdio::null())
            .stdout(Stdio::from(
                fs::File::create(namespace.join("stdout.log"))
                    .map_err(|error| format!("create eigen k worker stdout log: {error}"))?,
            ))
            .stderr(Stdio::from(
                fs::File::create(namespace.join("stderr.log"))
                    .map_err(|error| format!("create eigen k worker stderr log: {error}"))?,
            ))
            .spawn()
            .map_err(|error| format!("spawn eigen k worker: {error}"))?;
        let pid = child.id();
        Ok(ActiveWorker {
            request_index,
            pid,
            child,
            peak: WorkerPeak::default(),
            cpu_coverage: WorkerCpuCoverage::default(),
            exit_telemetry_pending: None,
            stdout_path: namespace.join("stdout.log"),
            stderr_path: namespace.join("stderr.log"),
            cancel_path: request.cancel_path.clone().ok_or_else(|| {
                "eigen k worker request did not retain its private cancellation path".to_string()
            })?,
            handshake_path,
            resolved_threads: request.thread_budget.resolved_threads,
        })
    }

    fn cap_worker_log(path: &Path) {
        let Ok(metadata) = fs::metadata(path) else {
            return;
        };
        if metadata.len() <= MAX_WORKER_LOG_BYTES {
            return;
        }
        let Ok(mut file) = fs::File::open(path) else {
            return;
        };
        let Ok(bytes) = bounded_worker_log_tail(&mut file) else {
            return;
        };
        drop(file);
        let temporary = path.with_extension(format!("trim-{}", std::process::id()));
        if fs::write(&temporary, &bytes).is_ok() {
            let _ = fs::rename(temporary, path);
        }
    }

    fn cap_worker_logs(worker: &ActiveWorker) {
        Self::cap_worker_log(&worker.stdout_path);
        Self::cap_worker_log(&worker.stderr_path);
    }

    fn append_admission_event(
        report: &mut ProcessPoolReportV1,
        event: ProcessAdmissionEventV1,
    ) -> bool {
        let duplicate = report
            .events
            .last()
            .is_some_and(|last| same_admission_state(last, &event));
        if duplicate {
            return false;
        }
        if report.events.len() >= MAX_ADMISSION_EVENTS {
            // Keep the first state and the latest state while bounding an
            // otherwise unbounded 100 ms admission history.
            if report.events.len() > 1 {
                report.events.remove(1);
            }
            report.events_truncated = true;
        }
        report.events.push(event);
        true
    }

    fn read_response(&self, request_index: usize) -> Result<EigenKWorkerResponseV1, String> {
        let path = self
            .root
            .join(format!("worker-{request_index:06}"))
            .join("response.json");
        let bytes =
            fs::read(&path).map_err(|error| format!("read worker response {path:?}: {error}"))?;
        let response: EigenKWorkerResponseV1 = serde_json::from_slice(&bytes)
            .map_err(|error| format!("parse worker response {path:?}: {error}"))?;
        if response.worker_request_index != request_index {
            return Err(format!(
                "worker response request index {} does not match namespace {}",
                response.worker_request_index, request_index
            ));
        }
        Ok(response)
    }

    pub(crate) fn load_artifacts(
        &self,
        response: &EigenKWorkerResponseV1,
    ) -> Result<Vec<crate::types::AuxiliaryArtifact>, String> {
        if response.protocol != EIGEN_K_WORKER_PROTOCOL_V2 {
            return Err("worker response protocol mismatch".into());
        }
        let Some(run) = response.run.as_ref() else {
            return Err(response
                .error
                .clone()
                .unwrap_or_else(|| "worker returned no run payload".into()));
        };
        if !response.ok || !matches!(run.status, crate::types::RunStatus::Completed) {
            return Err(response.error.clone().unwrap_or_else(|| {
                format!("worker sample {} did not complete", response.sample_index)
            }));
        }
        let namespace = self
            .root
            .join(format!("worker-{:06}", response.worker_request_index))
            .canonicalize()
            .map_err(|error| format!("canonicalize worker namespace: {error}"))?;
        let artifact_root = namespace
            .join("artifacts")
            .canonicalize()
            .map_err(|error| format!("canonicalize worker artifact namespace: {error}"))?;
        let mut artifacts = Vec::with_capacity(run.artifacts.len());
        for reference in &run.artifacts {
            let canonical = reference
                .path
                .canonicalize()
                .map_err(|error| format!("canonicalize worker artifact: {error}"))?;
            if !canonical.starts_with(&artifact_root) {
                return Err(format!(
                    "worker artifact {} escapes its private worker namespace",
                    reference.relative_path
                ));
            }
            let relative = canonical.strip_prefix(&artifact_root).map_err(|_| {
                format!(
                    "worker artifact {} cannot be relativized to its private namespace",
                    reference.relative_path
                )
            })?;
            if relative != Path::new(&reference.relative_path) {
                return Err(format!(
                    "worker artifact {} path does not match its private relative path",
                    reference.relative_path
                ));
            }
            let bytes = fs::read(&canonical).map_err(|error| {
                format!("read worker artifact {}: {error}", reference.relative_path)
            })?;
            if bytes.len() as u64 != reference.byte_len {
                return Err(format!(
                    "worker artifact {} length changed after publication",
                    reference.relative_path
                ));
            }
            let mut digest = sha2::Sha256::new();
            digest.update(&bytes);
            let actual = format!("sha256:{:x}", digest.finalize());
            if actual != reference.sha256 {
                return Err(format!(
                    "worker artifact {} digest changed after publication",
                    reference.relative_path
                ));
            }
            artifacts.push(crate::types::AuxiliaryArtifact {
                relative_path: reference.relative_path.clone(),
                bytes,
            });
        }
        Ok(artifacts)
    }

    /// Validate a terminal child response before it can be used for
    /// admission calibration.  The later parent parser still performs mode
    /// tracking and seam checks; this earlier gate binds the response to the
    /// exact request and verifies that the published artifact bytes really
    /// contain at least one accepted finite mode.
    fn validate_terminal_response(
        &self,
        request: &EigenKWorkerRequestV2,
        response: &EigenKWorkerResponseV1,
    ) -> Result<(), String> {
        if response.protocol != EIGEN_K_WORKER_PROTOCOL_V2 {
            return Err("worker response protocol mismatch".into());
        }
        if response.sample_index != request.sample_index {
            return Err(format!(
                "worker response sample index {} does not match request {}",
                response.sample_index, request.sample_index
            ));
        }
        if !response.ok || response.error.is_some() {
            return Err(response
                .error
                .clone()
                .unwrap_or_else(|| "worker response was not accepted".into()));
        }
        let run = response
            .run
            .as_ref()
            .ok_or_else(|| "worker response has no run payload".to_string())?;
        if !matches!(run.status, crate::types::RunStatus::Completed) {
            return Err(format!(
                "worker sample {} has terminal status {:?}",
                request.sample_index, run.status
            ));
        }
        if run.plan_sha256 != request.expected_plan_sha256 {
            return Err(format!(
                "worker sample {} plan digest does not match its request",
                request.sample_index
            ));
        }
        if run.equilibrium_artifact_sha256 != request.expected_equilibrium_artifact_sha256 {
            return Err(format!(
                "worker sample {} equilibrium artifact digest does not match its request",
                request.sample_index
            ));
        }
        if response.worker_executable_sha256.as_deref()
            != Some(self.worker_executable_sha256.as_str())
        {
            return Err(format!(
                "worker sample {} executable digest does not match the parent bundle",
                request.sample_index
            ));
        }
        if response.worker_build_identity.as_ref() != Some(&self.worker_build_identity) {
            return Err(format!(
                "worker sample {} build identity does not match the parent bundle",
                request.sample_index
            ));
        }
        if request.parallel_policy.mode == ParallelExecutionModeIR::Adaptive {
            let terminal_peak = response.terminal_peak.ok_or_else(|| {
                format!(
                    "worker sample {} has no terminal resource measurement",
                    request.sample_index
                )
            })?;
            if !terminal_peak.cpu_cores.is_finite()
                || terminal_peak.cpu_cores <= 0.0
                || terminal_peak.rss_bytes == 0
            {
                return Err(format!(
                    "worker sample {} has invalid terminal resource measurement",
                    request.sample_index
                ));
            }
        }
        if run.final_magnetization.is_empty()
            || run
                .final_magnetization
                .iter()
                .flatten()
                .any(|value| !value.is_finite())
        {
            return Err(format!(
                "worker sample {} has no finite final magnetization",
                request.sample_index
            ));
        }
        let artifacts = self.load_artifacts(response)?;
        crate::fem::validate_worker_spectrum_artifact(&artifacts, request.sample_index)
            .map_err(|error| error.message)
    }

    fn record_peak(
        sampler: &mut ResourceSampler,
        worker: &mut ActiveWorker,
    ) -> Result<(), WorkerSampleError> {
        match sampler.worker_peak(worker.pid) {
            Ok(measured) => {
                worker.cpu_coverage.observe(measured.cpu_interval);
                worker.peak.cpu_cores = worker.peak.cpu_cores.max(measured.peak.cpu_cores);
                worker.peak.rss_bytes = worker.peak.rss_bytes.max(measured.peak.rss_bytes);
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    fn telemetry_error_is_retryable(error: &str) -> bool {
        let normalized = error.to_ascii_lowercase();
        normalized.contains("warming up")
            || normalized.contains("no valid interval")
            || normalized.contains("counter reset")
            || normalized.contains("invalid cgroup cpu interval")
    }

    fn unix_ms() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0)
    }

    fn terminate_all(active: &mut Vec<ActiveWorker>) {
        active.clear();
    }

    fn take_terminal_workers(active: &mut Vec<ActiveWorker>) -> Result<Vec<ActiveWorker>, String> {
        let mut completed = Vec::new();
        let mut index = active.len();
        while index > 0 {
            index -= 1;
            if active[index]
                .child
                .try_wait()
                .map_err(|error| {
                    format!(
                        "poll eigen k worker {}: {error}",
                        active[index].request_index
                    )
                })?
                .is_some()
            {
                completed.push(active.swap_remove(index));
            }
        }
        Ok(completed)
    }

    fn resolve_thread_budget(
        &self,
        resources: &crate::adaptive_resources::ResourceSnapshot,
        workers_after_spawn: usize,
    ) -> Result<EigenKWorkerThreadBudgetV1, String> {
        let requested = self.policy.threads_per_worker;
        let host_cpu_cores = std::thread::available_parallelism()
            .map(|value| value.get())
            .unwrap_or(1);
        let host_cap = host_cpu_cores.min(u32::MAX as usize) as u32;
        if !resources.allocated_cpu_cores.is_finite() || resources.allocated_cpu_cores <= 0.0 {
            return Err("cannot resolve worker threads without a positive CPU allocation".into());
        }
        let workers = workers_after_spawn.max(1) as f64;
        let per_worker_allocation = resources.allocated_cpu_cores / workers;
        if per_worker_allocation < 1.0 {
            return Err("cannot admit an eigen worker without one allocated CPU per worker".into());
        }
        let allocation_cap = per_worker_allocation.floor();
        let allocation_cap = allocation_cap.min(u32::MAX as f64) as u32;
        let resolved = requested.min(host_cap).min(allocation_cap).max(1);
        let cap_reason = if resolved < requested {
            if allocation_cap <= host_cap {
                "capped_by_cpu_allocation_per_worker"
            } else {
                "capped_by_host_parallelism"
            }
        } else {
            "requested_threads_within_cpu_allocation"
        };
        Ok(EigenKWorkerThreadBudgetV1 {
            requested_threads: requested,
            resolved_threads: resolved,
            cap_reason: cap_reason.to_string(),
            allocation_cpu_cores: resources.allocated_cpu_cores,
            host_cpu_cores: host_cap,
        })
    }

    fn finish_child_at_status(
        &self,
        worker: ActiveWorker,
        status: std::process::ExitStatus,
    ) -> Result<EigenKWorkerResponseV1, String> {
        let request_index = worker.request_index;
        Self::cap_worker_logs(&worker);
        let response = self.read_response(request_index);
        match response {
            Ok(response) if status.success() => Ok(response),
            Ok(response) if response.error.is_some() => Err(format!(
                "eigen k worker {request_index} exited with {status}: {}",
                response.error.as_deref().unwrap_or_default()
            )),
            Ok(_) => Err(format!(
                "eigen k worker {request_index} exited with {status} despite publishing a response"
            )),
            Err(error) if !status.success() => Err(format!(
                "eigen k worker {request_index} exited with {status} without a response: {error}"
            )),
            Err(error) => Err(error),
        }
    }

    fn finish_child(&self, mut worker: ActiveWorker) -> Result<EigenKWorkerResponseV1, String> {
        let status = worker
            .child
            .wait()
            .map_err(|error| format!("wait eigen k worker {}: {error}", worker.request_index))?;
        self.finish_child_at_status(worker, status)
    }

    fn finish_child_with_cancel(
        &self,
        mut worker: ActiveWorker,
        cancel: &Arc<AtomicBool>,
        pending_action: &mut Option<StepAction>,
        check_control: &mut Option<&mut dyn FnMut(Option<&ProcessAdmissionEventV1>) -> StepAction>,
    ) -> Result<WorkerWaitOutcome, String> {
        let mut pause_requested = false;
        loop {
            if let Some(action) =
                requested_control_action(cancel, pending_action, check_control, None)
            {
                match action {
                    StepAction::Stop => {
                        // Stop is latched, but collect an already-terminal child before signaling it.
                        match worker.child.try_wait() {
                            Ok(Some(status)) => {
                                let response = self.finish_child_at_status(worker, status)?;
                                return Ok(WorkerWaitOutcome::CompletedInterrupted {
                                    action: StepAction::Stop,
                                    response,
                                });
                            }
                            Ok(None) => {
                                let _ = fs::write(&worker.cancel_path, b"cancelled");
                            }
                            Err(error) => {
                                let request_index = worker.request_index;
                                let _ = fs::write(&worker.cancel_path, b"cancelled");
                                let _ = worker.child.kill();
                                let _ = worker.child.wait();
                                Self::cap_worker_logs(&worker);
                                return Err(format!(
                                    "poll eigen k worker {request_index}: {error}"
                                ));
                            }
                        }

                        match worker.child.kill() {
                            Ok(()) => {
                                let status = worker.child.wait().map_err(|error| {
                                    format!(
                                        "wait for stopped eigen k worker {}: {error}",
                                        worker.request_index
                                    )
                                })?;
                                if status.success() {
                                    let response = self.finish_child_at_status(worker, status)?;
                                    return Ok(WorkerWaitOutcome::CompletedInterrupted {
                                        action: StepAction::Stop,
                                        response,
                                    });
                                }
                                Self::cap_worker_logs(&worker);
                                if let Ok(response) = self.read_response(worker.request_index) {
                                    if !response.ok || response.error.is_some() {
                                        let error = response.error.unwrap_or_else(|| {
                                            "worker response was not accepted".into()
                                        });
                                        return Err(format!(
                                            "eigen k worker {} reported an error while Stop was pending: {error}",
                                            worker.request_index
                                        ));
                                    }
                                }
                                return Ok(WorkerWaitOutcome::Interrupted(StepAction::Stop));
                            }
                            Err(kill_error) => match worker.child.try_wait() {
                                Ok(Some(status)) => {
                                    let response = self.finish_child_at_status(worker, status)?;
                                    return Ok(WorkerWaitOutcome::CompletedInterrupted {
                                        action: StepAction::Stop,
                                        response,
                                    });
                                }
                                Ok(None) => {
                                    Self::cap_worker_logs(&worker);
                                    return Err(format!(
                                        "kill eigen k worker {} after Stop: {kill_error}",
                                        worker.request_index
                                    ));
                                }
                                Err(poll_error) => {
                                    let request_index = worker.request_index;
                                    let _ = worker.child.kill();
                                    let _ = worker.child.wait();
                                    Self::cap_worker_logs(&worker);
                                    return Err(format!(
                                        "kill eigen k worker {request_index} after Stop: {kill_error}; poll child: {poll_error}"
                                    ));
                                }
                            },
                        }
                    }
                    StepAction::Pause => pause_requested = true,
                    StepAction::Continue => {}
                }
            }
            match worker.child.try_wait() {
                Ok(Some(status)) => {
                    let response = self.finish_child_at_status(worker, status)?;
                    return if pause_requested {
                        Ok(WorkerWaitOutcome::CompletedInterrupted {
                            action: StepAction::Pause,
                            response,
                        })
                    } else {
                        Ok(WorkerWaitOutcome::Completed(response))
                    };
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(error) => {
                    let _ = worker.child.kill();
                    let _ = worker.child.wait();
                    Self::cap_worker_logs(&worker);
                    return Err(format!(
                        "poll eigen k worker {}: {error}",
                        worker.request_index
                    ));
                }
            }
        }
    }

    /// Execute requests as isolated workers.  Results are returned in request
    /// order even though completion order is arbitrary.
    pub(crate) fn execute(
        &self,
        requests: &[EigenKWorkerRequestV2],
        cancel: Arc<AtomicBool>,
        mut check_control: Option<&mut dyn FnMut(Option<&ProcessAdmissionEventV1>) -> StepAction>,
    ) -> Result<ProcessPoolOutcome, String> {
        if requests.is_empty() {
            return Err("eigen process pool received zero requests".into());
        }
        for request in requests {
            request.validate().map_err(|error| error.message)?;
            validate_worker_policy(&self.policy, &request.parallel_policy, request.sample_index)?;
        }
        let mut sample_indices = HashSet::with_capacity(requests.len());
        for request in requests {
            if !sample_indices.insert(request.sample_index) {
                return Err(format!(
                    "eigen process pool received duplicate sample_index {}",
                    request.sample_index
                ));
            }
        }
        let mut report = ProcessPoolReportV1 {
            protocol: EIGEN_K_WORKER_PROTOCOL_V2.to_string(),
            requested_mode: self.policy.mode,
            resolved_mode: "serial_processes".to_string(),
            resolved_workers: 0,
            policy: self.policy.clone(),
            inputs: requests
                .iter()
                .map(|request| ProcessPoolInputBindingV1 {
                    sample_index: request.sample_index,
                    plan_sha256: request.expected_plan_sha256.clone(),
                    equilibrium_artifact_sha256: request
                        .expected_equilibrium_artifact_sha256
                        .clone(),
                })
                .collect(),
            thread_bindings: Vec::new(),
            cpu_observations: Vec::new(),
            worker_logs: Vec::new(),
            events: Vec::new(),
            events_truncated: false,
            telemetry_reason: None,
        };
        let mut journal = AdmissionJournalGuard::new(&self.root, &report);
        let mut pending_action = None;

        if self.policy.mode == ParallelExecutionModeIR::Serial {
            let mut responses = Vec::with_capacity(requests.len());
            let host_cpu_cores = std::thread::available_parallelism()
                .map(|value| value.get().min(u32::MAX as usize) as u32)
                .unwrap_or(1);
            let scheduler_allocation =
                crate::adaptive_resources::scheduler_process_cpu_allocation()?;
            #[cfg(target_os = "linux")]
            let allocation_cpu_cores = ResourceSampler::new()
                .map_err(|error| {
                    format!("serial pool cannot verify effective Linux CPU allocation: {error}")
                })?
                .cpu_allocation_cores(scheduler_allocation.map(|(cores, _source)| cores))?;
            #[cfg(not(target_os = "linux"))]
            let allocation_cpu_cores = scheduler_allocation
                .map(|(cores, _source)| cores as f64)
                .unwrap_or(host_cpu_cores as f64);
            for (index, request) in requests.iter().enumerate() {
                if let Some(action) = requested_control_action(
                    &cancel,
                    &mut pending_action,
                    &mut check_control,
                    None,
                ) {
                    journal.finish(&report, pool_terminal_state(action));
                    return Ok(ProcessPoolOutcome::Interrupted {
                        action,
                        partial: ProcessPoolResult { responses, report },
                    });
                }
                let requested_threads = self.policy.threads_per_worker;
                let thread_budget = resolve_serial_thread_budget(
                    requested_threads,
                    allocation_cpu_cores,
                    host_cpu_cores,
                )?;
                let worker =
                    self.spawn_worker(request, index, thread_budget.clone())?;
                report.resolved_workers = report.resolved_workers.max(1);
                report.worker_logs.push(ProcessPoolWorkerLogV1 {
                    sample_index: request.sample_index,
                    stdout_path: worker.stdout_path.clone(),
                    stderr_path: worker.stderr_path.clone(),
                    handshake_path: worker.handshake_path.clone(),
                    worker_executable_sha256: self.worker_executable_sha256.clone(),
                    worker_build_identity: self.worker_build_identity.clone(),
                });
                journal.update(&report);
                report.thread_bindings.push(ProcessPoolThreadBindingV1 {
                    sample_index: request.sample_index,
                    budget: thread_budget,
                });
                let (response, after_response_action) = match self.finish_child_with_cancel(
                    worker,
                    &cancel,
                    &mut pending_action,
                    &mut check_control,
                )? {
                    WorkerWaitOutcome::Completed(response) => (response, None),
                    WorkerWaitOutcome::CompletedInterrupted { action, response } => {
                        (response, Some(action))
                    }
                    WorkerWaitOutcome::Interrupted(action) => {
                        journal.finish(&report, pool_terminal_state(action));
                        return Ok(ProcessPoolOutcome::Interrupted {
                            action,
                            partial: ProcessPoolResult { responses, report },
                        });
                    }
                };
                // A cooperative worker may publish its Cancelled result after seeing Stop.
                // Keep that as an interruption rather than validating it as a completed sample.
                if clean_stop_cancellation_response(after_response_action, &response) {
                    journal.finish(&report, pool_terminal_state(StepAction::Stop));
                    return Ok(ProcessPoolOutcome::Interrupted {
                        action: StepAction::Stop,
                        partial: ProcessPoolResult { responses, report },
                    });
                }
                self.validate_terminal_response(request, &response)?;
                responses.push(response);
                journal.update(&report);
                if let Some(action) = after_response_action {
                    journal.finish(&report, pool_terminal_state(action));
                    return Ok(ProcessPoolOutcome::Interrupted {
                        action,
                        partial: ProcessPoolResult { responses, report },
                    });
                }
            }
            journal.finish(&report, "completed");
            return Ok(ProcessPoolOutcome::Completed(ProcessPoolResult {
                responses,
                report,
            }));
        }

        let mut sampler = ResourceSampler::new().map_err(|error| {
            report.telemetry_reason = Some(error.clone());
            error
        })?;
        let mut telemetry_open = true;
        let mut telemetry_retry_since = None;
        // The first cgroup/proc sample warms counters.  A transient warm-up
        // failure is retried in the admission loop; it never means that the
        // host is idle or that telemetry can be closed permanently.
        if let Err(error) = sampler.sample() {
            if Self::telemetry_error_is_retryable(&error) {
                telemetry_retry_since = Some(Instant::now());
            } else {
                telemetry_open = false;
                report.telemetry_reason = Some(error);
            }
        }
        let mut admission = AdaptiveAdmission::new(self.policy.clone())
            .map_err(|error| format!("adaptive admission policy: {error}"))?;
        let mut active = Vec::<ActiveWorker>::new();
        let mut responses = Vec::<(usize, EigenKWorkerResponseV1)>::with_capacity(requests.len());
        let mut next_request = 0usize;
        let mut observed_peak = WorkerPeak::default();

        while next_request < requests.len() || !active.is_empty() {
            let mut stop_after_terminal_harvest = false;
            if let Some(action) = requested_control_action(
                &cancel,
                &mut pending_action,
                &mut check_control,
                None,
            ) {
                if pool_control_can_finish(action, active.len()) {
                    if action == StepAction::Stop && !active.is_empty() {
                        // Close admission immediately, then reap children that
                        // are already terminal before killing the remaining
                        // active workers. No solver is awaited on this path.
                        stop_after_terminal_harvest = true;
                    } else {
                        journal.finish(&report, pool_terminal_state(action));
                        responses.sort_by_key(|(index, _)| *index);
                        return Ok(ProcessPoolOutcome::Interrupted {
                            action,
                            partial: ProcessPoolResult {
                                responses: responses
                                    .into_iter()
                                    .map(|(_, response)| response)
                                    .collect(),
                                report,
                            },
                        });
                    }
                }
            }

            // Skip proc sampling for children already confirmed terminal.
            // For live children, only typed worker-owned /proc exit races may
            // pend; parent cgroup, allocation, identity, and parse errors fail closed.
            let mut telemetry_resolution_sources = Vec::<String>::new();
            let mut exit_telemetry_timeout = None;
            for worker in active.iter_mut().filter(|_| !stop_after_terminal_harvest) {
                // If the child is already terminal, its validated response is
                // the authoritative peak source; avoid sampling a vanished PID.
                if worker
                    .child
                    .try_wait()
                    .map_err(|error| {
                        format!("poll eigen k worker {}: {error}", worker.request_index)
                    })?
                    .is_some()
                {
                    continue;
                }
                let pending_before = worker.exit_telemetry_pending.clone();
                let sample = Self::record_peak(&mut sampler, worker);
                let sample_error = sample.as_ref().err();
                let now = Instant::now();
                match transition_worker_exit_telemetry_after_sample(
                    pending_before.as_ref(),
                    sample_error,
                    now,
                ) {
                    Ok(pending_after) => {
                        worker.exit_telemetry_pending = pending_after;
                        if pending_before.is_some() && worker.exit_telemetry_pending.is_none() {
                            let pending = pending_before.as_ref().unwrap();
                            let sample_index = requests
                                .get(worker.request_index)
                                .map(|request| request.sample_index)
                                .unwrap_or(worker.request_index);
                            telemetry_resolution_sources.push(format!(
                                "worker_exit_telemetry_recovered_by_proc_sample_{}_sample_{sample_index}_after_{}s",
                                pending.source,
                                now.saturating_duration_since(pending.since).as_secs()
                            ));
                        }
                        if sample.is_ok() {
                            if let Err(error) = observe_admission_peak(
                                &mut admission,
                                &mut observed_peak,
                                worker.peak,
                            ) {
                                telemetry_open = false;
                                report
                                    .telemetry_reason
                                    .get_or_insert_with(|| format!("worker telemetry: {error}"));
                            }
                        }
                    }
                    Err(error) => {
                        let message = error.message();
                        telemetry_open = false;
                        if error.is_timeout() {
                            report.telemetry_reason = Some(message.clone());
                            exit_telemetry_timeout.get_or_insert(message);
                        } else {
                            report.telemetry_reason.get_or_insert(message);
                        }
                    }
                }
            }
            if !stop_after_terminal_harvest {
                if let Some(error) = exit_telemetry_timeout {
                    // No admission decision runs after the deadline. Finishing the
                    // journal here records the worker-local /proc source and elapsed
                    // reconciliation duration before ActiveWorker drops reap children.
                    journal.finish(&report, "failed");
                    return Err(error);
                }
            }

            let completed = Self::take_terminal_workers(&mut active)?;
            for worker in completed {
                let request_index = worker.request_index;
                let peak = worker.peak;
                let resolved_threads = worker.resolved_threads;
                let cpu_coverage = worker.cpu_coverage;
                let pending_exit_telemetry = worker.exit_telemetry_pending.clone();
                sampler.forget_worker(worker.pid);
                let response = self.finish_child(worker)?;
                let request = requests.get(request_index).ok_or_else(|| {
                    format!("eigen k worker request index {request_index} is out of range")
                })?;
                if let Err(error) = self.validate_terminal_response(request, &response) {
                    if pending_exit_telemetry.is_some() {
                        let message = format!(
                            "worker exit telemetry terminal response failed validation: {error}"
                        );
                        report.telemetry_reason = Some(message.clone());
                        journal.finish(&report, "failed");
                        return Err(message);
                    }
                    return Err(error);
                }
                if let Err(error) = resolve_worker_exit_telemetry_from_terminal(
                    pending_exit_telemetry.as_ref(),
                    response.terminal_peak,
                    Instant::now(),
                ) {
                    let message = error.message();
                    report.telemetry_reason = Some(message.clone());
                    journal.finish(&report, "failed");
                    return Err(message);
                }
                if let Some(pending) = pending_exit_telemetry.as_ref() {
                    telemetry_resolution_sources.push(format!(
                        "worker_exit_telemetry_resolved_by_terminal_rss_{}_after_{}s",
                        pending.source,
                        Instant::now()
                            .saturating_duration_since(pending.since)
                            .as_secs()
                    ));
                }
                responses.push((request_index, response));
                let terminal_peak = responses
                    .last()
                    .and_then(|(_, response)| response.terminal_peak)
                    .unwrap_or_default();
                let combined_peak = combined_worker_demand(peak, terminal_peak, resolved_threads, cpu_coverage);
                report.cpu_observations.push(ProcessPoolCpuObservationV1 {
                    sample_index: request.sample_index,
                    valid_intervals: cpu_coverage.intervals,
                    observed_seconds: cpu_coverage.duration.as_secs_f64(),
                    demand_source: if cpu_coverage.sufficient() && peak.cpu_cores > 0.0 {
                        "periodic_peak_with_terminal_average"
                    } else {
                        "resolved_team_envelope_with_terminal_average"
                    }.into(),
                    sampled_peak_cpu_cores: peak.cpu_cores,
                    terminal_average_cpu_cores: terminal_peak.cpu_cores,
                    resolved_threads,
                    demand_cpu_cores: combined_peak.cpu_cores,
                });
                let has_terminal_peak =
                    combined_peak.rss_bytes > 0 || combined_peak.cpu_cores > 0.0;
                let telemetry_valid = has_terminal_peak && telemetry_open;
                if telemetry_valid {
                    observe_admission_peak(&mut admission, &mut observed_peak, combined_peak)
                        .map_err(|error| format!("worker telemetry: {error}"))?;
                } else {
                    telemetry_open = false;
                    report
                        .telemetry_reason
                        .get_or_insert("worker telemetry unavailable".into());
                }
                // The first successful worker is the only calibration probe.
                // Never calibrate from a zero peak or a sampler that has
                // entered a fail-closed state. A worker-local /proc exit race must
                // first recover from /proc or a validated terminal RSS peak.
                if responses.len() == 1 && !telemetry_valid {
                    journal.finish(&report, "failed");
                    return Err(report.telemetry_reason.clone().unwrap_or_else(|| {
                        "eigen process pool refused admission calibration without terminal worker telemetry"
                            .into()
                    }));
                }
                if responses.len() == 1 && telemetry_valid {
                    if let Err(error) = admission.completed_probe() {
                        telemetry_open = false;
                        report.telemetry_reason.get_or_insert(error.clone());
                        journal.finish(&report, "failed");
                        return Err(error);
                    }
                }
            }

            if stop_after_terminal_harvest {
                for worker in &active {
                    let _ = fs::write(&worker.cancel_path, b"cancelled");
                    sampler.forget_worker(worker.pid);
                }
                Self::terminate_all(&mut active);
                journal.finish(&report, pool_terminal_state(StepAction::Stop));
                responses.sort_by_key(|(index, _)| *index);
                return Ok(ProcessPoolOutcome::Interrupted {
                    action: StepAction::Stop,
                    partial: ProcessPoolResult {
                        responses: responses
                            .into_iter()
                            .map(|(_, response)| response)
                            .collect(),
                        report,
                    },
                });
            }

            // Keep live resource samples and worker counts current after the
            // final admission, including the iteration that reaps the last child.
            {
                let own_cpu = active.iter().map(|worker| worker.peak.cpu_cores).sum();
                let own_rss = active
                    .iter()
                    .map(|worker| worker.peak.rss_bytes)
                    .sum::<u64>();
                let snapshot = if telemetry_open {
                    match sampler.sample() {
                        Ok(snapshot) => {
                            telemetry_retry_since = None;
                            Some(snapshot)
                        }
                        Err(error) => {
                            if next_request == requests.len() && active.is_empty() {
                                // A terminal solver result does not imply that
                                // the final resource sample was available.
                                report.telemetry_reason.get_or_insert_with(|| {
                                    format!("terminal_telemetry_unavailable: {error}")
                                });
                            }
                            if !Self::telemetry_error_is_retryable(&error) {
                                report.telemetry_reason.get_or_insert(error.clone());
                                telemetry_open = false;
                            } else if telemetry_retry_expired(
                                &mut telemetry_retry_since,
                                Instant::now(),
                            ) {
                                report.telemetry_reason.get_or_insert_with(|| {
                                    format!("telemetry_retry_timeout: {error}")
                                });
                                telemetry_open = false;
                            }
                            None
                        }
                    }
                } else {
                    None
                };
                let pending_exit_details = active
                    .iter()
                    .filter_map(|worker| {
                        worker.exit_telemetry_pending.as_ref().map(|pending| {
                            let sample_index = requests
                                .get(worker.request_index)
                                .map(|request| request.sample_index)
                                .unwrap_or(worker.request_index);
                            format!(
                                "{}_sample_{sample_index}_elapsed_{}s",
                                pending.source,
                                Instant::now()
                                    .saturating_duration_since(pending.since)
                                    .as_secs()
                            )
                        })
                    })
                    .collect::<Vec<_>>();
                let exit_telemetry_pending = !pending_exit_details.is_empty();
                let admission_open = worker_admission_open(telemetry_open, exit_telemetry_pending)
                    && pending_action.is_none();
                let pending_samples = requests.len().saturating_sub(next_request);
                let decision = if admission_open {
                    admission.decide(
                        snapshot.as_ref(),
                        active.len(),
                        own_cpu,
                        own_rss,
                        pending_samples,
                        Instant::now(),
                    )
                } else if exit_telemetry_pending {
                    AdmissionDecision {
                        desired_workers: active.len(),
                        reason: format!(
                            "worker_exit_telemetry_pending:{}",
                            pending_exit_details.join(",")
                        ),
                        cpu_target_kind: "soft_admission_target".into(),
                    }
                } else {
                    AdmissionDecision {
                        desired_workers: active.len(),
                        reason: "telemetry_unavailable_no_new_admission".into(),
                        cpu_target_kind: "soft_admission_target".into(),
                    }
                };
                // A zero target may be caused by temporary headroom pressure or
                // by policy capacity that cannot admit even one worker. Only
                // classify the latter, with valid telemetry and no active workers.
                let permanent_admission_failure =
                    if admission_open && active.is_empty() && pending_samples > 0 {
                        classify_permanent_admission_infeasibility(
                            &self.policy,
                            &decision,
                            snapshot.as_ref(),
                            observed_peak,
                            !responses.is_empty(),
                        )
                    } else {
                        None
                    };
                let admission_reason = match permanent_admission_failure.as_ref() {
                    Some(failure) => failure.reason(),
                    None => decision.reason.as_str(),
                };
                let budget = if admission_open && decision.desired_workers > active.len() {
                    Some(self.resolve_thread_budget(
                        snapshot.as_ref().ok_or_else(|| {
                            "adaptive worker admission has no current CPU allocation".to_string()
                        })?,
                        active.len().saturating_add(1),
                    )?)
                } else {
                    None
                };
                let event = ProcessAdmissionEventV1 {
                    at_unix_ms: Self::unix_ms(),
                    active_workers: active.len(),
                    pending_samples,
                    desired_workers: decision.desired_workers,
                    reason: if telemetry_resolution_sources.is_empty() {
                        admission_reason.to_string()
                    } else {
                        format!(
                            "{}; {}",
                            admission_reason,
                            telemetry_resolution_sources.join(",")
                        )
                    },
                    cpu_target_kind: decision.cpu_target_kind.to_string(),
                    snapshot: snapshot.clone(),
                    worker_peak: (observed_peak.rss_bytes > 0 || observed_peak.cpu_cores > 0.0)
                        .then_some(observed_peak),
                };
                Self::append_admission_event(&mut report, event.clone());
                // The report is deduplicated for bounded evidence, while the
                // live callback still sees fresh measurements.  Its caller
                // throttles these duplicate events to roughly one second and
                // publishes reason changes immediately.
                let control_action = requested_control_action(
                    &cancel,
                    &mut pending_action,
                    &mut check_control,
                    Some(&event),
                );
                if !admission_may_spawn_worker(&cancel, control_action) {
                    // A callback can request control in the same admission
                    // iteration that produced a positive budget. Close
                    // admission before that budget reaches spawn_worker; Stop
                    // tears down active workers and Pause lets them finish at
                    // the current sample boundary.
                    journal.update(&report);
                    continue;
                }
                journal.update(&report);
                if let Some(failure) = permanent_admission_failure_if_running(
                    permanent_admission_failure,
                    &cancel,
                    admission_open,
                    active.len(),
                    pending_samples,
                ) {
                    journal.finish(&report, "failed");
                    return Err(failure.message());
                }
                if let Some(budget) = budget {
                    report.thread_bindings.push(ProcessPoolThreadBindingV1 {
                        sample_index: requests[next_request].sample_index,
                        budget: budget.clone(),
                    });
                    let worker =
                        self.spawn_worker(&requests[next_request], next_request, budget)?;
                    report.worker_logs.push(ProcessPoolWorkerLogV1 {
                        sample_index: requests[next_request].sample_index,
                        stdout_path: worker.stdout_path.clone(),
                        stderr_path: worker.stderr_path.clone(),
                        handshake_path: worker.handshake_path.clone(),
                        worker_executable_sha256: self.worker_executable_sha256.clone(),
                        worker_build_identity: self.worker_build_identity.clone(),
                    });
                    next_request += 1;
                    active.push(worker);
                    report.resolved_mode = "adaptive_processes".to_string();
                    report.resolved_workers = report.resolved_workers.max(active.len());
                    continue;
                }
            }

            if next_request >= requests.len() && active.is_empty() {
                break;
            }
            if next_request < requests.len() && active.is_empty() && !telemetry_open {
                journal.finish(&report, "failed");
                return Err(report.telemetry_reason.unwrap_or_else(|| {
                    "adaptive worker admission closed without a terminal telemetry sample".into()
                }));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        journal.finish(
            &report,
            pending_action
                .map(pool_terminal_state)
                .unwrap_or("completed"),
        );
        Ok(adaptive_pool_outcome(pending_action, responses, report))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        admission_may_spawn_worker, bounded_worker_log_tail,
        classify_permanent_admission_infeasibility,
        permanent_admission_failure_if_running, pool_control_can_finish, pool_terminal_state,
        requested_control_action, ActiveWorker, EigenKProcessPool,
        PermanentAdmissionInfeasibility,
        MAX_WORKER_LOG_BYTES,
    };
    use crate::adaptive_resources::{
        AdaptiveAdmission, ResourceSnapshot, WorkerPeak,
    };
    use fullmag_ir::{ParallelExecutionModeIR, ParallelExecutionPolicyIR};
    use crate::types::StepAction;
    use std::cell::Cell;
    use std::io::Cursor;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn managed_worker_fixture() -> (StopHarvestTempDir, PathBuf, serde_json::Value) {
        let root = StopHarvestTempDir::new();
        let bin = root.0.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let api = bin.join("fullmag-api");
        let worker = bin.join("fullmag-fem-gpu-bin");
        std::fs::write(&api, b"api fixture").unwrap();
        std::fs::write(&worker, b"worker fixture").unwrap();
        let manifest = serde_json::json!({
            "schema": 3, "runtime": "fem-gpu-host",
            "binaries": {"api": "bin/fullmag-api", "worker": "bin/fullmag-fem-gpu-bin"},
            "integrity": {
                "api_sha256": super::executable_sha256(&api).unwrap().trim_start_matches("sha256:"),
                "worker_sha256": super::executable_sha256(&worker).unwrap().trim_start_matches("sha256:")
            }
        });
        (root, api.canonicalize().unwrap(), manifest)
    }

    #[test]
    fn managed_bundle_worker_resolution_without_legacy_cli() {
        let (root, api, manifest) = managed_worker_fixture();
        std::fs::write(root.0.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        let worker = super::resolve_managed_worker_sibling(&api).unwrap().unwrap();
        assert_eq!(worker, root.0.join("bin/fullmag-fem-gpu-bin").canonicalize().unwrap());
        assert!(!root.0.join("bin/fullmag-bin").exists());
    }

    #[test]
    fn managed_bundle_worker_resolution_rejects_missing_escape_and_bad_digest() {
        for mode in ["missing", "escape", "digest", "wrong_api"] {
            let (root, api, mut manifest) = managed_worker_fixture();
            match mode {
                "missing" => { std::fs::remove_file(root.0.join("bin/fullmag-fem-gpu-bin")).unwrap(); },
                "escape" => { manifest["binaries"]["worker"] = serde_json::json!("bin/../fullmag-fem-gpu-bin"); },
                "digest" => { manifest["integrity"]["worker_sha256"] = serde_json::json!("0".repeat(64)); },
                "wrong_api" => { manifest["binaries"]["api"] = serde_json::json!("bin/fullmag-fem-gpu-bin"); },
                _ => unreachable!(),
            }
            std::fs::write(root.0.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
            assert!(super::resolve_managed_worker_sibling(&api).is_err(), "{mode}");
        }
    }

    fn adaptive_policy() -> ParallelExecutionPolicyIR {
        ParallelExecutionPolicyIR {
            mode: ParallelExecutionModeIR::Adaptive,
            ..Default::default()
        }
    }

    struct StopHarvestTempDir(PathBuf);

    impl StopHarvestTempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "fullmag-k-pool-stop-harvest-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).expect("create stop-harvest fixture directory");
            Self(path)
        }
    }

    impl Drop for StopHarvestTempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn test_active_worker(
        root: &Path,
        request_index: usize,
        child: std::process::Child,
    ) -> ActiveWorker {
        let namespace = root.join(format!("worker-{request_index:06}"));
        std::fs::create_dir_all(&namespace).expect("create worker namespace");
        ActiveWorker {
            request_index,
            pid: child.id(),
            child,
            peak: WorkerPeak::default(),
            cpu_coverage: super::WorkerCpuCoverage::default(),
            exit_telemetry_pending: None,
            stdout_path: namespace.join("stdout.log"),
            stderr_path: namespace.join("stderr.log"),
            cancel_path: namespace.join("cancel.flag"),
            handshake_path: namespace.join("handshake.json"),
            resolved_threads: 1,
        }
    }

    fn serial_policy() -> ParallelExecutionPolicyIR {
        ParallelExecutionPolicyIR {
            mode: ParallelExecutionModeIR::Serial,
            ..Default::default()
        }
    }

    #[test]
    fn serial_thread_budget_uses_task_allocation_before_host_parallelism() {
        let budget = super::resolve_serial_thread_budget(8, 2.0, 32).unwrap();
        assert_eq!(budget.requested_threads, 8);
        assert_eq!(budget.resolved_threads, 2);
        assert_eq!(budget.allocation_cpu_cores, 2.0);
        assert_eq!(budget.host_cpu_cores, 32);
        assert_eq!(
            budget.cap_reason,
            "serial_process_pool_capped_by_cpu_allocation"
        );
    }

    #[test]
    fn serial_thread_budget_keeps_host_parallelism_as_an_additional_cap() {
        let budget = super::resolve_serial_thread_budget(8, 8.0, 2).unwrap();
        assert_eq!(budget.resolved_threads, 2);
        assert_eq!(budget.allocation_cpu_cores, 8.0);
        assert_eq!(budget.host_cpu_cores, 2);
        assert_eq!(
            budget.cap_reason,
            "serial_process_pool_capped_by_host_parallelism"
        );
    }

    #[test]
    fn serial_thread_budget_rejects_fractional_allocation_below_one_thread() {
        assert!(super::resolve_serial_thread_budget(8, 0.5, 32).is_err());
    }

    fn serial_test_pool(root: &Path) -> EigenKProcessPool {
        EigenKProcessPool {
            root: root.to_path_buf(),
            executable: std::env::current_exe().expect("resolve test executable"),
            worker_executable_sha256: String::new(),
            worker_build_identity: serde_json::Value::Null,
            policy: serial_policy(),
        }
    }

    fn spawn_serial_control_child(root: &Path, mode: &str) -> (ActiveWorker, PathBuf) {
        let current_exe = std::env::current_exe().expect("resolve test executable");
        let namespace = root.join("worker-000000");
        std::fs::create_dir_all(&namespace).expect("create serial child namespace");
        let ready_path = root.join("serial-child.ready");
        let release_path = root.join("serial-child.release");
        let response_path = namespace.join("response.json");
        let child = Command::new(current_exe)
            .arg("stop_harvest_child_helper")
            .arg("--nocapture")
            .env("FULLMAG_K_POOL_SERIAL_CHILD_MODE", mode)
            .env("FULLMAG_K_POOL_SERIAL_CHILD_READY", &ready_path)
            .env("FULLMAG_K_POOL_SERIAL_CHILD_RELEASE", &release_path)
            .env("FULLMAG_K_POOL_SERIAL_CHILD_RESPONSE", &response_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn serial control fixture child");
        let mut worker = test_active_worker(root, 0, child);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready_path.exists() {
            assert!(
                Instant::now() < deadline,
                "serial child readiness timed out"
            );
            assert!(
                worker
                    .child
                    .try_wait()
                    .expect("poll serial child before readiness")
                    .is_none(),
                "serial child exited before publishing readiness"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            worker
                .child
                .try_wait()
                .expect("confirm serial child is live")
                .is_none(),
            "serial child must remain active at the ready barrier"
        );
        (worker, release_path)
    }

    fn wait_for_child_exit(worker: &mut ActiveWorker) -> std::process::ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = worker.child.try_wait().expect("poll fixture child exit") {
                return status;
            }
            assert!(Instant::now() < deadline, "fixture child exit timed out");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    #[test]
    fn stop_harvests_terminal_child_and_kills_active_child_without_response() {
        let fixture = StopHarvestTempDir::new();
        let current_exe = std::env::current_exe().expect("resolve test executable");
        let mut completed_child = Command::new(&current_exe)
            .arg("stop_harvest_child_helper")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn immediately completing child");
        assert!(
            completed_child
                .wait()
                .expect("wait completed fixture child")
                .success()
        );

        let completed_namespace = fixture.0.join("worker-000000");
        std::fs::create_dir_all(&completed_namespace).expect("create completed namespace");
        std::fs::write(
            completed_namespace.join("response.json"),
            serde_json::to_vec(&serde_json::json!({
                "protocol": super::EIGEN_K_WORKER_PROTOCOL_V2,
                "sample_index": 17,
                "worker_request_index": 0,
                "ok": true,
            }))
            .expect("encode terminal worker response"),
        )
        .expect("write terminal worker response");

        let ready_path = fixture.0.join("active-child.ready");
        let active_child = Command::new(&current_exe)
            .arg("stop_harvest_child_helper")
            .arg("--nocapture")
            .env("FULLMAG_K_POOL_STOP_HARVEST_READY", &ready_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn active child without a response");
        let mut active = vec![
            test_active_worker(&fixture.0, 0, completed_child),
            test_active_worker(&fixture.0, 1, active_child),
        ];
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready_path.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ready_path.exists(), "active child must start before Stop");
        assert!(active[1].child.try_wait().unwrap().is_none());

        let completed = EigenKProcessPool::take_terminal_workers(&mut active)
            .expect("inspect terminal children without waiting");
        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0].request_index, 0);
        assert_eq!(active.len(), 1);
        let pool = EigenKProcessPool {
            root: fixture.0.clone(),
            executable: current_exe,
            worker_executable_sha256: String::new(),
            worker_build_identity: serde_json::Value::Null,
            policy: adaptive_policy(),
        };
        let response = pool
            .finish_child(completed.into_iter().next().unwrap())
            .expect("retain the already-terminal child response");
        assert_eq!(response.worker_request_index, 0);
        assert_eq!(response.sample_index, 17);

        assert!(
            !fixture.0.join("worker-000001/response.json").exists(),
            "the still-active child has no fabricated response"
        );
        for worker in &active {
            let _ = std::fs::write(&worker.cancel_path, b"cancelled");
        }
        let teardown_started = Instant::now();
        EigenKProcessPool::terminate_all(&mut active);
        assert!(active.is_empty(), "Stop teardown must not wait for the solver");
        assert!(
            teardown_started.elapsed() < Duration::from_secs(5),
            "Stop teardown must kill the active child instead of waiting for its solve"
        );
    }

    #[test]
    fn stop_harvest_child_helper() {
        if let Some(mode) = std::env::var_os("FULLMAG_K_POOL_SERIAL_CHILD_MODE") {
            let mode = mode.to_string_lossy();
            let ready_path = PathBuf::from(
                std::env::var_os("FULLMAG_K_POOL_SERIAL_CHILD_READY")
                    .expect("serial fixture ready path"),
            );
            let release_path = PathBuf::from(
                std::env::var_os("FULLMAG_K_POOL_SERIAL_CHILD_RELEASE")
                    .expect("serial fixture release path"),
            );
            let response_path = PathBuf::from(
                std::env::var_os("FULLMAG_K_POOL_SERIAL_CHILD_RESPONSE")
                    .expect("serial fixture response path"),
            );
            std::fs::write(&ready_path, b"ready").expect("publish serial child readiness");
            if mode == "live" {
                loop {
                    std::thread::sleep(Duration::from_secs(60));
                }
            }
            assert!(
                mode == "success" || mode == "error",
                "unsupported serial fixture mode"
            );
            let deadline = Instant::now() + Duration::from_secs(15);
            while !release_path.exists() {
                assert!(Instant::now() < deadline, "serial fixture release timed out");
                std::thread::sleep(Duration::from_millis(5));
            }
            let is_error = mode == "error";
            let run = if is_error {
                None
            } else {
                Some(serde_json::json!({
                    "status": "completed",
                    "final_magnetization": [[1.0, 0.0, 0.0]],
                    "plan_sha256": "fixture-plan",
                    "equilibrium_artifact_sha256": "fixture-equilibrium",
                    "thread_budget": {
                        "requested_threads": 1,
                        "resolved_threads": 1,
                        "cap_reason": "fixture",
                        "allocation_cpu_cores": 1.0,
                        "host_cpu_cores": 1
                    },
                    "artifacts": []
                }))
            };
            let response = serde_json::json!({
                "protocol": super::EIGEN_K_WORKER_PROTOCOL_V2,
                "sample_index": 17,
                "worker_request_index": 0,
                "ok": !is_error,
                "run": run,
                "error": if is_error { Some("fixture worker error") } else { None },
            });
            std::fs::write(
                response_path,
                serde_json::to_vec(&response).expect("encode serial fixture response"),
            )
            .expect("publish serial fixture response");
            if is_error {
                panic!("exit after publishing the fixture worker error");
            }
            return;
        }

        let Some(ready_path) = std::env::var_os("FULLMAG_K_POOL_STOP_HARVEST_READY") else {
            return;
        };
        std::fs::write(PathBuf::from(ready_path), b"ready").expect("publish child readiness");
        std::thread::sleep(Duration::from_secs(60));
    }

    #[test]
    fn serial_stop_harvests_terminal_success_before_killing() {
        let fixture = StopHarvestTempDir::new();
        let (mut worker, release_path) = spawn_serial_control_child(&fixture.0, "success");
        std::fs::write(&release_path, b"release").expect("release successful child");
        let status = wait_for_child_exit(&mut worker);
        assert!(
            status.success(),
            "successful fixture must be terminal before Stop"
        );
        let cancel_path = worker.cancel_path.clone();
        let pool = serial_test_pool(&fixture.0);
        let cancel = Arc::new(AtomicBool::new(false));
        let mut callback = |_: Option<&super::ProcessAdmissionEventV1>| StepAction::Stop;
        let mut check_control = Some(
            &mut callback
                as &mut dyn FnMut(Option<&super::ProcessAdmissionEventV1>) -> StepAction,
        );
        let mut pending_action = None;

        let outcome = pool
            .finish_child_with_cancel(
                worker,
                &cancel,
                &mut pending_action,
                &mut check_control,
            )
            .expect("harvest completed worker after Stop");
        let super::WorkerWaitOutcome::CompletedInterrupted { action, response } = outcome else {
            panic!("terminal success must be retained as a Stop-interrupted completion");
        };
        assert_eq!(action, StepAction::Stop);
        assert_eq!(pending_action, Some(StepAction::Stop));
        assert_eq!(response.sample_index, 17);
        assert!(response.run.as_ref().is_some_and(|run| {
            matches!(run.status, crate::types::RunStatus::Completed)
        }));
        assert!(
            !cancel_path.exists(),
            "terminal success must not be cancelled"
        );
    }

    #[test]
    fn serial_stop_preserves_terminal_worker_error_before_killing() {
        let fixture = StopHarvestTempDir::new();
        let (mut worker, release_path) = spawn_serial_control_child(&fixture.0, "error");
        std::fs::write(&release_path, b"release").expect("release failed child");
        let status = wait_for_child_exit(&mut worker);
        assert!(
            !status.success(),
            "error fixture must be terminal before Stop"
        );
        let cancel_path = worker.cancel_path.clone();
        let pool = serial_test_pool(&fixture.0);
        let cancel = Arc::new(AtomicBool::new(false));
        let mut callback = |_: Option<&super::ProcessAdmissionEventV1>| StepAction::Stop;
        let mut check_control = Some(
            &mut callback
                as &mut dyn FnMut(Option<&super::ProcessAdmissionEventV1>) -> StepAction,
        );
        let mut pending_action = None;

        let error = pool
            .finish_child_with_cancel(
                worker,
                &cancel,
                &mut pending_action,
                &mut check_control,
            )
            .expect_err("terminal worker failure must not become an ordinary Stop");
        assert!(error.contains("fixture worker error"), "{error}");
        assert!(
            !cancel_path.exists(),
            "terminal failure must not be cancelled"
        );
    }

    #[test]
    fn serial_stop_kills_a_live_child_with_bounded_wait() {
        let fixture = StopHarvestTempDir::new();
        let (worker, _) = spawn_serial_control_child(&fixture.0, "live");
        let cancel_path = worker.cancel_path.clone();
        let response_path = fixture.0.join("worker-000000/response.json");
        let pool = serial_test_pool(&fixture.0);
        let cancel = Arc::new(AtomicBool::new(false));
        let mut callback = |_: Option<&super::ProcessAdmissionEventV1>| StepAction::Stop;
        let mut check_control = Some(
            &mut callback
                as &mut dyn FnMut(Option<&super::ProcessAdmissionEventV1>) -> StepAction,
        );
        let mut pending_action = None;
        let started = Instant::now();

        let outcome = pool
            .finish_child_with_cancel(
                worker,
                &cancel,
                &mut pending_action,
                &mut check_control,
            )
            .expect("Stop should terminate the live fixture child");
        assert!(matches!(
            outcome,
            super::WorkerWaitOutcome::Interrupted(StepAction::Stop)
        ));
        assert!(
            cancel_path.exists(),
            "live child must receive cancellation first"
        );
        assert!(
            !response_path.exists(),
            "live child must not fabricate a response"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "Stop must kill the active child instead of waiting for its blocked work"
        );
    }

    #[test]
    fn serial_pause_drains_current_child_before_interrupting() {
        let pause_fixture = StopHarvestTempDir::new();
        let (worker, release_path) = spawn_serial_control_child(&pause_fixture.0, "success");
        let cancel_path = worker.cancel_path.clone();
        let pool = serial_test_pool(&pause_fixture.0);
        let cancel = Arc::new(AtomicBool::new(false));
        let mut pause_callback = move |_: Option<&super::ProcessAdmissionEventV1>| {
            std::fs::write(&release_path, b"release")
                .expect("release child during Pause drain");
            StepAction::Pause
        };
        let mut pause_control = Some(
            &mut pause_callback
                as &mut dyn FnMut(Option<&super::ProcessAdmissionEventV1>) -> StepAction,
        );
        let mut pending_action = None;
        let outcome = pool
            .finish_child_with_cancel(worker, &cancel, &mut pending_action, &mut pause_control)
            .expect("Pause should drain the current sample");
        let super::WorkerWaitOutcome::CompletedInterrupted { action, response } = outcome else {
            panic!("Pause must keep the completed current sample");
        };
        assert_eq!(action, StepAction::Pause);
        assert_eq!(pending_action, Some(StepAction::Pause));
        assert_eq!(response.sample_index, 17);
        assert!(
            !cancel_path.exists(),
            "Pause drain must not cancel its active child"
        );
    }

    #[test]
    fn serial_stop_upgrades_a_pending_pause_and_kills_live_child() {
        let stop_fixture = StopHarvestTempDir::new();
        let (worker, _) = spawn_serial_control_child(&stop_fixture.0, "live");
        let stop_cancel_path = worker.cancel_path.clone();
        let pool = serial_test_pool(&stop_fixture.0);
        let cancel = Arc::new(AtomicBool::new(false));
        let calls = Cell::new(0usize);
        let mut pause_then_stop = |_: Option<&super::ProcessAdmissionEventV1>| {
            let call = calls.get();
            calls.set(call + 1);
            if call == 0 {
                StepAction::Pause
            } else {
                StepAction::Stop
            }
        };
        let mut stop_control = Some(
            &mut pause_then_stop
                as &mut dyn FnMut(Option<&super::ProcessAdmissionEventV1>) -> StepAction,
        );
        let mut pending_action = None;
        let started = Instant::now();
        let outcome = pool
            .finish_child_with_cancel(worker, &cancel, &mut pending_action, &mut stop_control)
            .expect("Stop must upgrade a pending Pause and terminate the live child");
        assert!(matches!(
            outcome,
            super::WorkerWaitOutcome::Interrupted(StepAction::Stop)
        ));
        assert_eq!(calls.get(), 2, "the fixture must exercise Pause then Stop");
        assert_eq!(pending_action, Some(StepAction::Stop));
        assert!(stop_cancel_path.exists());
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "Pause→Stop must not wait for the blocked child to finish"
        );
    }

    #[test]
    fn adaptive_pool_completion_keeps_latched_pause_and_all_drained_responses() {
        let response = |request_index: usize, sample_index: usize| {
            super::EigenKWorkerResponseV1 {
                protocol: super::EIGEN_K_WORKER_PROTOCOL_V2.into(),
                sample_index,
                worker_request_index: request_index,
                ok: true,
                worker_executable_sha256: None,
                worker_build_identity: None,
                terminal_peak: None,
                run: None,
                error: None,
            }
        };
        let report = super::ProcessPoolReportV1 {
            protocol: super::EIGEN_K_WORKER_PROTOCOL_V2.into(),
            requested_mode: ParallelExecutionModeIR::Adaptive,
            resolved_mode: "adaptive_processes".into(),
            resolved_workers: 2,
            policy: adaptive_policy(),
            inputs: Vec::new(),
            thread_bindings: Vec::new(),
            cpu_observations: Vec::new(),
            worker_logs: Vec::new(),
            events: Vec::new(),
            events_truncated: false,
            telemetry_reason: None,
        };

        let outcome = super::adaptive_pool_outcome(
            Some(StepAction::Pause),
            vec![(1, response(1, 31)), (0, response(0, 30))],
            report,
        );
        let super::ProcessPoolOutcome::Interrupted { action, partial } = outcome else {
            panic!("a latched Pause must survive the final completed-worker drain");
        };
        assert_eq!(action, StepAction::Pause);
        assert_eq!(
            partial
                .responses
                .iter()
                .map(|response| response.sample_index)
                .collect::<Vec<_>>(),
            vec![30, 31]
        );
    }

    fn memory_snapshot(now: Instant, memory_available_bytes: u64) -> ResourceSnapshot {
        ResourceSnapshot {
            sampled_at: now,
            sampled_at_unix_ms: 1,
            allocated_cpu_cores: 8.0,
            cpu_busy_percent: 10.0,
            cpu_available_cores: 7.2,
            memory_limit_bytes: 16 << 30,
            memory_available_bytes,
            allocation_sources: vec!["fixture".into()],
        }
    }

    #[test]
    fn reserve_that_consumes_allowed_memory_budget_is_typed_before_calibration() {
        let now = Instant::now();
        let mut policy = adaptive_policy();
        policy.memory_reserve_bytes = 13 << 30;
        let resources = memory_snapshot(now, 16 << 30);
        let mut admission = AdaptiveAdmission::new(policy.clone()).unwrap();
        let decision = admission.decide(Some(&resources), 0, 0.0, 0, 2, now);
        assert_eq!(decision.reason, "insufficient_memory_for_probe");
        let allowed_memory_bytes =
            (resources.memory_limit_bytes as f64 * policy.max_memory_percent / 100.0) as u64;
        assert_eq!(
            classify_permanent_admission_infeasibility(
                &policy,
                &decision,
                Some(&resources),
                WorkerPeak::default(),
                false,
            ),
            Some(PermanentAdmissionInfeasibility::MemoryReserveConsumesAllowedBudget {
                allowed_memory_bytes,
                reserve_bytes: policy.memory_reserve_bytes,
            })
        );
    }

    #[test]
    fn temporary_memory_pressure_waits_before_and_after_calibration() {
        let now = Instant::now();
        let policy = adaptive_policy();

        // This leaves no probe headroom now, but the allowed pool budget is
        // still positive and can recover when neighboring work releases memory.
        let before_calibration_resources = memory_snapshot(now, 4 << 30);
        let mut before_calibration = AdaptiveAdmission::new(policy.clone()).unwrap();
        let before_decision = before_calibration.decide(
            Some(&before_calibration_resources),
            0,
            0.0,
            0,
            2,
            now,
        );
        assert_eq!(before_decision.reason, "insufficient_memory_for_probe");
        assert_eq!(
            classify_permanent_admission_infeasibility(
                &policy,
                &before_decision,
                Some(&before_calibration_resources),
                WorkerPeak::default(),
                false,
            ),
            None
        );

        let calibrated_peak = WorkerPeak {
            cpu_cores: 1.0,
            rss_bytes: 4 << 30,
        };
        let after_calibration_resources = memory_snapshot(now, 7 << 30);
        let mut after_calibration = AdaptiveAdmission::new(policy.clone()).unwrap();
        after_calibration.observe(calibrated_peak).unwrap();
        after_calibration.completed_probe().unwrap();
        let after_decision = after_calibration.decide(
            Some(&after_calibration_resources),
            0,
            0.0,
            0,
            2,
            now,
        );
        assert_eq!(after_decision.reason, "insufficient_memory_for_worker");
        assert_eq!(
            classify_permanent_admission_infeasibility(
                &policy,
                &after_decision,
                Some(&after_calibration_resources),
                calibrated_peak,
                true,
            ),
            None
        );
    }

    #[test]
    fn calibrated_worker_envelope_over_budget_is_typed() {
        let now = Instant::now();
        let policy = adaptive_policy();
        let resources = memory_snapshot(now, 16 << 30);
        let calibrated_peak = WorkerPeak {
            cpu_cores: 1.0,
            rss_bytes: 10 << 30,
        };
        let mut admission = AdaptiveAdmission::new(policy.clone()).unwrap();
        admission.observe(calibrated_peak).unwrap();
        admission.completed_probe().unwrap();
        let decision = admission.decide(Some(&resources), 0, 0.0, 0, 2, now);
        assert_eq!(decision.reason, "insufficient_memory_for_worker");
        let allowed_memory_bytes =
            (resources.memory_limit_bytes as f64 * policy.max_memory_percent / 100.0) as u64;
        let pool_memory_budget_bytes =
            allowed_memory_bytes.saturating_sub(policy.memory_reserve_bytes);
        assert_eq!(
            classify_permanent_admission_infeasibility(
                &policy,
                &decision,
                Some(&resources),
                calibrated_peak,
                true,
            ),
            Some(
                PermanentAdmissionInfeasibility::CalibratedWorkerEnvelopeExceedsBudget {
                    worker_memory_envelope_bytes: (10 << 30) + ((10 << 30) / 4),
                    pool_memory_budget_bytes,
                }
            )
        );
    }

    #[test]
    fn callback_cancellation_takes_precedence_over_permanent_admission_failure() {
        let cancel = AtomicBool::new(false);
        let action = StepAction::Pause;
        let failure =
            Some(PermanentAdmissionInfeasibility::MemoryReserveConsumesAllowedBudget {
                allowed_memory_bytes: 100,
                reserve_bytes: 100,
            });
        assert!(!admission_may_spawn_worker(&cancel, Some(action)));
        assert!(!cancel.load(Ordering::Relaxed));
        assert_eq!(
            permanent_admission_failure_if_running(failure, &cancel, false, 0, 2),
            None
        );
    }

    #[test]
    fn live_worker_peak_closes_admission_before_completion_and_keeps_calibration_closed() {
        use crate::adaptive_resources::{AdaptiveAdmission, ResourceSnapshot, WorkerPeak};
        use fullmag_ir::{ParallelExecutionModeIR, ParallelExecutionPolicyIR};
        use std::time::Instant;
        let mut admission = AdaptiveAdmission::new(ParallelExecutionPolicyIR {
            mode: ParallelExecutionModeIR::Adaptive,
            ..Default::default()
        }).unwrap();
        let mut observed = WorkerPeak::default();
        let now = Instant::now();
        let resources = ResourceSnapshot {
            sampled_at: now, sampled_at_unix_ms: 1,
            allocated_cpu_cores: 8.0, cpu_busy_percent: 0.0,
            cpu_available_cores: 8.0,
            memory_limit_bytes: 16 << 30, memory_available_bytes: 16 << 30,
            allocation_sources: vec!["fixture".into()],
        };
        super::observe_admission_peak(&mut admission, &mut observed,
            WorkerPeak { cpu_cores: 1.0, rss_bytes: 1 << 30 }).unwrap();
        assert_eq!(admission.decide(Some(&resources), 1, 0.0, 0, 10, now).desired_workers, 1);
        admission.completed_probe().unwrap();
        // A still-running later sample now needs a much larger workspace.
        super::observe_admission_peak(&mut admission, &mut observed,
            WorkerPeak { cpu_cores: 4.0, rss_bytes: 8 << 30 }).unwrap();
        assert_eq!(admission.decide(Some(&resources), 2, 0.0, 0, 10, now).desired_workers, 1);
        assert_eq!(observed.cpu_cores, 4.0);
        assert_eq!(observed.rss_bytes, 8 << 30);
        super::observe_admission_peak(&mut admission, &mut observed,
            WorkerPeak { cpu_cores: 0.0, rss_bytes: 1 }).unwrap();
        assert_eq!(observed.rss_bytes, 8 << 30);
        assert_eq!(observed.cpu_cores, 4.0);
        let before = observed;
        assert!(super::observe_admission_peak(&mut admission, &mut observed,
            WorkerPeak { cpu_cores: f64::NAN, rss_bytes: 99 << 30 }).is_err());
        assert_eq!(observed.cpu_cores, before.cpu_cores);
        assert_eq!(observed.rss_bytes, before.rss_bytes);
    }

    #[test]
    fn admission_deduplication_retains_free_capacity_and_worker_peak_changes() {
        use crate::adaptive_resources::{ResourceSnapshot, WorkerPeak};
        let mut event = super::ProcessAdmissionEventV1 {
            at_unix_ms: 1,
            active_workers: 1,
            pending_samples: 3,
            desired_workers: 1,
            reason: "measured_cpu_and_memory_budget".into(),
            cpu_target_kind: "soft_admission_target".into(),
            snapshot: Some(ResourceSnapshot {
                sampled_at: std::time::Instant::now(),
                sampled_at_unix_ms: 1,
                allocated_cpu_cores: 4.0,
                cpu_busy_percent: 25.0,
                cpu_available_cores: 3.0,
                memory_limit_bytes: 8192,
                memory_available_bytes: 4096,
                allocation_sources: vec!["fixture".into()],
            }),
            worker_peak: None,
        };
        let original = event.clone();
        event.at_unix_ms = 2;
        event.snapshot.as_mut().unwrap().sampled_at_unix_ms = 2;
        assert!(super::same_admission_state(&original, &event));
        event.snapshot.as_mut().unwrap().cpu_available_cores = 2.0;
        assert!(!super::same_admission_state(&original, &event));
        event = original.clone();
        event.worker_peak = Some(WorkerPeak {
            cpu_cores: 1.0,
            rss_bytes: 1024,
        });
        assert!(!super::same_admission_state(&original, &event));
        let measured = event.clone();
        event.worker_peak.as_mut().unwrap().rss_bytes = 2048;
        assert!(!super::same_admission_state(&measured, &event));
        event = measured.clone();
        event.worker_peak.as_mut().unwrap().cpu_cores = 2.0;
        assert!(!super::same_admission_state(&measured, &event));
        let mut report = super::ProcessPoolReportV1 {
            protocol: super::EIGEN_K_WORKER_PROTOCOL_V2.into(),
            requested_mode: super::ParallelExecutionModeIR::Adaptive,
            resolved_mode: "adaptive".into(),
            resolved_workers: 1,
            policy: super::ParallelExecutionPolicyIR::default(),
            inputs: vec![],
            thread_bindings: vec![],
            cpu_observations: vec![],
            worker_logs: vec![],
            events: vec![],
            events_truncated: false,
            telemetry_reason: None,
        };
        assert!(super::EigenKProcessPool::append_admission_event(
            &mut report,
            original.clone()
        ));
        let mut timestamp_only = original.clone();
        timestamp_only.at_unix_ms = 2;
        assert!(!super::EigenKProcessPool::append_admission_event(
            &mut report,
            timestamp_only
        ));
        assert!(super::EigenKProcessPool::append_admission_event(
            &mut report,
            event.clone()
        ));
        for index in 2..super::MAX_ADMISSION_EVENTS + 5 {
            event.at_unix_ms = index as u128;
            event.worker_peak.as_mut().unwrap().rss_bytes = index as u64;
            assert!(super::EigenKProcessPool::append_admission_event(
                &mut report,
                event.clone()
            ));
        }
        assert_eq!(report.events.len(), super::MAX_ADMISSION_EVENTS);
        assert!(report.events_truncated);
        assert_eq!(
            report.events.first().unwrap().at_unix_ms,
            original.at_unix_ms
        );
        assert_eq!(
            report.events.last().unwrap().at_unix_ms,
            (super::MAX_ADMISSION_EVENTS + 4) as u128
        );
    }

    #[test]
    fn telemetry_retries_are_bounded_and_reset_after_recovery() {
        let now = std::time::Instant::now();
        let mut since = None;
        assert!(!super::telemetry_retry_expired(&mut since, now));
        assert!(super::telemetry_retry_expired(
            &mut since,
            now + super::TELEMETRY_RETRY_TIMEOUT
        ));
        since = None;
        assert!(!super::telemetry_retry_expired(
            &mut since,
            now + super::TELEMETRY_RETRY_TIMEOUT
        ));
    }

    #[test]
    fn worker_proc_exit_races_are_narrow_and_require_real_telemetry() {
        use super::{
            resolve_worker_exit_telemetry_from_terminal,
            transition_worker_exit_telemetry_after_sample, worker_admission_open,
            PendingWorkerExitTelemetry, WorkerExitTelemetryError, TELEMETRY_RETRY_TIMEOUT,
        };
        use crate::adaptive_resources::{WorkerPeak, WorkerProcessExitRace, WorkerSampleError};
        use std::time::{Duration, Instant};

        let started = Instant::now();
        let missing_vmhwm =
            WorkerSampleError::ProcessExitRace(WorkerProcessExitRace::HighWaterMarkUnavailable);
        let process_disappeared = WorkerSampleError::ProcessExitRace(
            WorkerProcessExitRace::ProcFileNotFound("/proc/123/stat".into()),
        );
        for unrelated in [
            "invalid worker memory high water mark units",
            "worker allocation differs from its parent pool",
            "worker PID identity changed",
            "read /proc/self/cgroup: No such file or directory",
        ] {
            let error = WorkerSampleError::Other(unrelated.into());
            assert_eq!(
                transition_worker_exit_telemetry_after_sample(None, Some(&error), started),
                Err(WorkerExitTelemetryError::Other(unrelated.into()))
            );
        }
        assert_eq!(
            WorkerSampleError::from("allocation changed"),
            WorkerSampleError::Other("allocation changed".into())
        );
        assert_eq!(
            WorkerSampleError::from(String::from("identity changed")),
            WorkerSampleError::Other("identity changed".into())
        );

        let pending =
            transition_worker_exit_telemetry_after_sample(None, Some(&missing_vmhwm), started)
                .unwrap()
                .unwrap();
        assert_eq!(
            pending,
            PendingWorkerExitTelemetry {
                since: started,
                source: "worker memory high water mark unavailable".into(),
            }
        );
        assert!(!worker_admission_open(true, true));
        assert!(!worker_admission_open(false, false));
        let repeated_pending = transition_worker_exit_telemetry_after_sample(
            Some(&pending),
            Some(&process_disappeared),
            started + Duration::from_secs(1),
        )
        .unwrap()
        .unwrap();
        assert_eq!(repeated_pending, pending);

        let recovered = transition_worker_exit_telemetry_after_sample(
            Some(&pending),
            None,
            started + Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(recovered, None);
        assert!(worker_admission_open(true, recovered.is_some()));

        let terminal_peak = WorkerPeak {
            cpu_cores: 1.05345,
            rss_bytes: 358_105_088,
        };
        assert!(resolve_worker_exit_telemetry_from_terminal(
            Some(&pending),
            Some(terminal_peak),
            started + Duration::from_secs(2),
        )
        .is_ok());
        assert_eq!(
            resolve_worker_exit_telemetry_from_terminal(
                Some(&pending),
                Some(WorkerPeak {
                    cpu_cores: 1.0,
                    rss_bytes: 0,
                }),
                started + Duration::from_secs(2),
            ),
            Err(WorkerExitTelemetryError::InvalidTerminalPeak)
        );
        assert_eq!(
            resolve_worker_exit_telemetry_from_terminal(
                Some(&pending),
                None,
                started + Duration::from_secs(2),
            ),
            Err(WorkerExitTelemetryError::MissingTerminalPeak)
        );
        assert_eq!(
            resolve_worker_exit_telemetry_from_terminal(
                Some(&pending),
                Some(WorkerPeak {
                    cpu_cores: f64::NAN,
                    rss_bytes: 4096,
                }),
                started + Duration::from_secs(2),
            ),
            Err(WorkerExitTelemetryError::InvalidTerminalPeak)
        );

        let deadline = started + TELEMETRY_RETRY_TIMEOUT;
        assert!(matches!(
            transition_worker_exit_telemetry_after_sample(
                Some(&pending),
                Some(&missing_vmhwm),
                deadline,
            ),
            Err(WorkerExitTelemetryError::TimedOut { .. })
        ));
        assert!(matches!(
            transition_worker_exit_telemetry_after_sample(Some(&pending), None, deadline),
            Err(WorkerExitTelemetryError::TimedOut { .. })
        ));
        assert!(matches!(
            resolve_worker_exit_telemetry_from_terminal(
                Some(&pending),
                Some(terminal_peak),
                deadline,
            ),
            Err(WorkerExitTelemetryError::TimedOut { .. })
        ));
    }

    #[test]
    fn short_worker_cpu_average_cannot_replace_its_unmeasured_peak() {
        let demand = super::combined_worker_demand(
            crate::adaptive_resources::WorkerPeak::default(),
            crate::adaptive_resources::WorkerPeak {
                cpu_cores: 0.1,
                rss_bytes: 4096,
            },
            2,
            super::WorkerCpuCoverage::default(),
        );
        assert_eq!(demand.cpu_cores, 2.0);
        assert_eq!(demand.rss_bytes, 4096);
        let sampled = super::combined_worker_demand(
            crate::adaptive_resources::WorkerPeak {
                cpu_cores: 3.0,
                rss_bytes: 8192,
            },
            crate::adaptive_resources::WorkerPeak {
                cpu_cores: 0.1,
                rss_bytes: 4096,
            },
            2,
            super::WorkerCpuCoverage { intervals: 3, duration: std::time::Duration::from_secs(1) },
        );
        assert_eq!(sampled.cpu_cores, 3.0);
        assert_eq!(sampled.rss_bytes, 8192);
    }

    #[test]
    fn a_positive_short_cpu_sample_does_not_certify_peak_coverage() {
        use crate::adaptive_resources::WorkerPeak;
        use std::time::Duration;
        let measured = WorkerPeak { cpu_cores: 0.1, rss_bytes: 4096 };
        let mut coverage = super::WorkerCpuCoverage::default();
        coverage.observe(Some(Duration::from_millis(200)));
        let demand = super::combined_worker_demand(measured, measured, 2, coverage);
        assert_eq!(demand.cpu_cores, 2.0);
        coverage.observe(Some(Duration::from_secs(4))); // A long averaged interval is insufficient.
        assert!(!coverage.sufficient());
        coverage.observe(None);
        coverage.observe(Some(Duration::ZERO));
        coverage.observe(Some(Duration::from_millis(400)));
        assert!(!coverage.sufficient());
        coverage.observe(Some(Duration::from_millis(400)));
        assert!(coverage.sufficient());
        let demand = super::combined_worker_demand(measured, measured, 2, coverage);
        assert_eq!(demand.cpu_cores, 0.1);
        assert_eq!(demand.rss_bytes, 4096);
    }

    #[test]
    fn mismatched_worker_policy_is_rejected_before_spawn() {
        use fullmag_ir::ParallelExecutionPolicyIR;
        let parent = ParallelExecutionPolicyIR::default();
        assert!(super::validate_worker_policy(&parent, &parent, 0).is_ok());
        let mut other = parent.clone();
        other.max_cpu_percent = 75.0;
        let error = super::validate_worker_policy(&parent, &other, 7).unwrap_err();
        assert!(error.contains("sample 7"));
        other = parent.clone(); other.max_memory_percent = 50.0;
        assert!(super::validate_worker_policy(&parent, &other, 1).is_err());
        other = parent.clone(); other.threads_per_worker = 2;
        assert!(super::validate_worker_policy(&parent, &other, 1).is_err());
        other = parent.clone(); other.mode = super::ParallelExecutionModeIR::Adaptive;
        assert!(super::validate_worker_policy(&parent, &other, 1).is_err());
    }

    #[test]
    fn worker_environment_uses_resolved_budget_before_exec() {
        use crate::fem::eigen_k_worker::{worker_thread_environment, EigenKWorkerThreadBudgetV1};
        let budget = EigenKWorkerThreadBudgetV1 {
            requested_threads: 8,
            resolved_threads: 2,
            cap_reason: "allocation_cap".into(),
            allocation_cpu_cores: 2.0,
            host_cpu_cores: 16,
        };
        let environment = worker_thread_environment(&budget);
        let mut command = std::process::Command::new("unused-worker");
        command.envs(environment.clone());
        for (name, value) in environment {
            let configured = command
                .get_envs()
                .find(|(key, _)| *key == name)
                .unwrap()
                .1
                .unwrap();
            assert_eq!(configured, value.as_str());
            match name {
                "OMP_DYNAMIC" | "MKL_DYNAMIC" => assert_eq!(value, "FALSE"),
                _ => assert_eq!(value, "2"),
            }
        }
    }

    #[test]
    fn log_tail_reads_only_the_bounded_suffix() {
        let limit = MAX_WORKER_LOG_BYTES as usize;
        let mut bytes = vec![1; limit * 3];
        bytes[limit * 2..].fill(7);
        let tail = bounded_worker_log_tail(&mut Cursor::new(bytes)).unwrap();
        assert_eq!(tail, vec![7; limit]);
        assert_eq!(
            bounded_worker_log_tail(&mut Cursor::new(b"short")).unwrap(),
            b"short"
        );
        assert!(bounded_worker_log_tail(&mut Cursor::new(Vec::<u8>::new()))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn cancellation_callback_closes_worker_admission_before_spawn() {
        let cancel = AtomicBool::new(false);
        assert!(!admission_may_spawn_worker(&cancel, Some(StepAction::Stop)));
        assert!(!cancel.load(Ordering::Relaxed));

        let already_cancelled = AtomicBool::new(true);
        assert!(!admission_may_spawn_worker(&already_cancelled, None));

        let active = AtomicBool::new(false);
        assert!(admission_may_spawn_worker(&active, None));
    }

    #[test]
    fn only_a_clean_cancelled_response_after_stop_is_an_interruption() {
        let response = super::EigenKWorkerResponseV1 {
            protocol: super::EIGEN_K_WORKER_PROTOCOL_V2.into(),
            sample_index: 17,
            worker_request_index: 0,
            ok: true,
            worker_executable_sha256: None,
            worker_build_identity: None,
            terminal_peak: None,
            run: Some(crate::fem::eigen_k_worker::EigenKWorkerRunV1 {
                status: crate::types::RunStatus::Cancelled,
                final_magnetization: Vec::new(),
                plan_sha256: "fixture-plan".into(),
                equilibrium_artifact_sha256: "fixture-equilibrium".into(),
                thread_budget: crate::fem::eigen_k_worker::EigenKWorkerThreadBudgetV1 {
                    requested_threads: 1,
                    resolved_threads: 1,
                    cap_reason: "fixture".into(),
                    allocation_cpu_cores: 1.0,
                    host_cpu_cores: 1,
                },
                artifacts: Vec::new(),
            }),
            error: None,
        };
        assert!(super::clean_stop_cancellation_response(
            Some(StepAction::Stop),
            &response
        ));
        assert!(!super::clean_stop_cancellation_response(
            Some(StepAction::Pause),
            &response
        ));

        let mut worker_error = response.clone();
        worker_error.error = Some("fixture worker error".into());
        assert!(!super::clean_stop_cancellation_response(
            Some(StepAction::Stop),
            &worker_error
        ));

        let mut failed_run = response.clone();
        failed_run.run.as_mut().unwrap().status = crate::types::RunStatus::Failed;
        assert!(!super::clean_stop_cancellation_response(
            Some(StepAction::Stop),
            &failed_run
        ));
    }

    #[test]
    fn controlled_pause_and_stop_keep_distinct_pool_terminal_states() {
        let cancel = AtomicBool::new(false);
        for (action, expected_state) in [
            (StepAction::Pause, "paused"),
            (StepAction::Stop, "cancelled"),
        ] {
            let mut callback = move |_event: Option<&super::ProcessAdmissionEventV1>| action;
            let mut callback = Some(
                &mut callback
                    as &mut dyn FnMut(Option<&super::ProcessAdmissionEventV1>) -> StepAction,
            );
            let mut pending_action = None;
            assert_eq!(
                requested_control_action(&cancel, &mut pending_action, &mut callback, None),
                Some(action)
            );
            assert_eq!(pool_terminal_state(action), expected_state);
            assert!(!admission_may_spawn_worker(&cancel, Some(action)));
        }
        assert!(!pool_control_can_finish(StepAction::Pause, 1));
        assert!(pool_control_can_finish(StepAction::Pause, 0));
        assert!(pool_control_can_finish(StepAction::Stop, 1));
    }

    #[test]
    fn stop_upgrades_a_pending_pause_without_losing_the_terminal_action() {
        let cancel = AtomicBool::new(false);
        let callback_action = Cell::new(StepAction::Pause);
        let mut callback = |_: Option<&super::ProcessAdmissionEventV1>| callback_action.get();
        let mut callback = Some(
            &mut callback
                as &mut dyn FnMut(Option<&super::ProcessAdmissionEventV1>) -> StepAction,
        );
        let mut pending_action = None;

        assert_eq!(
            requested_control_action(&cancel, &mut pending_action, &mut callback, None),
            Some(StepAction::Pause)
        );
        callback_action.set(StepAction::Stop);
        assert_eq!(
            requested_control_action(&cancel, &mut pending_action, &mut callback, None),
            Some(StepAction::Stop)
        );
        assert_eq!(pool_terminal_state(pending_action.expect("latched action")), "cancelled");
    }
}
