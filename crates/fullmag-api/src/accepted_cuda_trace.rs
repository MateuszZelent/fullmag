//! Attempt-owned CUDA diagnostics. Diagnostic failure never replaces solver outcome.
use super::cuda_trace::Config;
use super::super::accepted_worker_execution_receipt::WorkerExecutionReceiptIdentity;
use anyhow::{bail, Context, Result};
use fullmag_runner::{FemCudaTrace, FemCudaTraceEnd};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Instant;

const TRACE: &str = "worker_cuda_trace.v1.ndjson";
const RECEIPT: &str = "worker_cuda_trace.v1.json";
const RECEIPT_V2: &str = "worker_cuda_trace.v2.json";

pub(crate) trait Session {
    fn stop(&mut self) -> Result<FemCudaTraceEnd>;
}
impl Session for FemCudaTrace {
    fn stop(&mut self) -> Result<FemCudaTraceEnd> { self.finish().map_err(anyhow::Error::msg) }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    schema_version: String,
    identity: WorkerExecutionReceiptIdentity,
    config: Config,
    config_sha256: String,
    worker_pid: u32,
    gpu_uuid: String,
    solver_outcome: String,
    status: String,
    trace_file: String,
    trace_size_bytes: Option<u64>,
    trace_sha256: Option<String>,
    native: Option<FemCudaTraceEnd>,
    start_wall_seconds: f64,
    stop_wall_seconds: f64,
    total_wall_seconds: f64,
    overhead_scope: String,
    errors: Vec<String>,
}

#[derive(Serialize)]
struct ReceiptV2<'a> {
    schema_version: &'static str,
    identity: &'a WorkerExecutionReceiptIdentity,
    config: &'a Config,
    config_sha256: &'a str,
    worker_pid: u32,
    gpu_uuid: &'a str,
    solver_outcome: &'a str,
    status: &'a str,
    trace_file: &'a str,
    trace_size_bytes: Option<u64>,
    trace_sha256: &'a Option<String>,
    native: &'a Option<FemCudaTraceEnd>,
    start_wall_seconds: f64,
    stop_wall_seconds: f64,
    total_wall_seconds: f64,
    overhead_scope: &'a str,
    errors: &'a [String],
    accepted_step_window: &'a WindowReceipt,
}

#[derive(Debug, Serialize)]
struct WindowReceipt {
    start_after_step: u64,
    end_after_step: u64,
    observed_start_step: Option<u64>,
    observed_end_step: Option<u64>,
    observed_start_time_s: Option<f64>,
    observed_end_time_s: Option<f64>,
    completed: bool,
    completion_reason: &'static str,
    capture_wall_seconds: f64,
}

struct WindowCapture {
    receipt: WindowReceipt,
    last_observation: Option<(u64, f64)>,
    capture_started: Option<Instant>,
    closed: bool,
}

enum WindowAction {
    Ignore,
    Start(u64, f64),
    Stop(u64, f64),
    Close(&'static str),
}

impl WindowCapture {
    fn new(start_after_step: u64, end_after_step: u64) -> Self {
        Self {
            receipt: WindowReceipt {
                start_after_step,
                end_after_step,
                observed_start_step: None,
                observed_end_step: None,
                observed_start_time_s: None,
                observed_end_time_s: None,
                completed: false,
                completion_reason: "solver_finished_before_start",
                capture_wall_seconds: 0.0,
            },
            last_observation: None,
            capture_started: None,
            closed: false,
        }
    }
}

pub(crate) struct Capture<S: Session = FemCudaTrace> {
    session: Option<S>,
    file: File,
    attempt: PathBuf,
    receipt: Receipt,
    window: Option<WindowCapture>,
    started: Instant,
    finalized: bool,
}

impl Capture<FemCudaTrace> {
    pub(crate) fn start(config: Option<&Config>, attempt: &Path,
        identity: &WorkerExecutionReceiptIdentity, gpu_uuid: Option<&str>) -> Result<Option<Self>> {
        if config.is_none() { return Ok(None); }
        if !fullmag_runner::fem_cuda_trace_available() {
            bail!("requested CUDA activity trace is unavailable in this native runtime");
        }
        Self::start_with(config, attempt, identity, gpu_uuid, |file, config|
            FemCudaTrace::start(file, config.max_bytes, config.max_duration_ms).map_err(anyhow::Error::msg))
    }
}

impl<S: Session> Capture<S> {
    fn start_with(config: Option<&Config>, attempt: &Path,
        identity: &WorkerExecutionReceiptIdentity, gpu_uuid: Option<&str>,
        factory: impl FnOnce(&File, &Config) -> Result<S>) -> Result<Option<Self>> {
        let Some(mut capture) = Self::reserve(config, attempt, identity, gpu_uuid)? else {
            return Ok(None);
        };
        if capture.window.is_some() {
            return Ok(Some(capture));
        }
        let result = factory(&capture.file, &capture.receipt.config);
        capture.receipt.start_wall_seconds = capture.started.elapsed().as_secs_f64();
        match result {
            Ok(session) => { capture.session = Some(session); Ok(Some(capture)) }
            Err(error) => {
                capture.note_error(format!("native startup: {error:#}"));
                if let Err(persist) = capture.finish("not_started") {
                    eprintln!("CUDA trace failed-start evidence could not be persisted: {persist:#}");
                }
                Err(error).context("start requested CUDA activity trace before the solver")
            }
        }
    }

    fn reserve(config: Option<&Config>, attempt: &Path,
        identity: &WorkerExecutionReceiptIdentity, gpu_uuid: Option<&str>) -> Result<Option<Self>> {
        let Some(config) = config else { return Ok(None); };
        let value = serde_json::to_value(config)?;
        let config_sha256 = super::cuda_trace::request_digest(&value)?;
        let window = config.accepted_step_window.as_ref().map(|window|
            WindowCapture::new(window.start_after_step, window.end_after_step));
        let gpu_uuid = gpu_uuid.filter(|uuid| !uuid.is_empty()).context("CUDA trace has no accepted GPU UUID")?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        // The managed WSL result mount uses a shared group, like sibling worker
        // receipts. Keep other-user bits closed without denying that group.
        { use std::os::unix::fs::OpenOptionsExt; options.mode(0o660).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC); }
        let file = options.open(attempt.join(TRACE)).context("reserve exclusive CUDA trace output")?;
        let started = Instant::now();
        let capture = Self { session: None, file, attempt: attempt.to_owned(), started, finalized: false,
            window,
            receipt: Receipt { schema_version: if config.accepted_step_window.is_some() { "worker_cuda_trace.v2" } else { "worker_cuda_trace.v1" }.into(), identity: identity.clone(),
                config: config.clone(), config_sha256, worker_pid: std::process::id(), gpu_uuid: gpu_uuid.into(),
                solver_outcome: "not_started".into(), status: "failed".into(), trace_file: TRACE.into(),
                trace_size_bytes: None, trace_sha256: None, native: None,
                start_wall_seconds: 0.0, stop_wall_seconds: 0.0, total_wall_seconds: 0.0,
                overhead_scope: "start/stop host API time only; callback overhead requires matched on/off runs".into(),
                errors: Vec::new() } };
        Ok(Some(capture))
    }

    fn note_error(&mut self, error: String) {
        self.receipt.errors.push(error.chars().take(2048).collect());
    }

    /// Observe only accepted physical clocks. The native collector is opened at N
    /// and closed at M; these diagnostics never affect the runner callback result.
    fn observe_accepted_step_with_factory(
        &mut self,
        stats: &fullmag_runner::StepStats,
        factory: impl FnOnce(&File, &Config) -> Result<S>,
    ) {
        if self.finalized || stats.kind != fullmag_quantities::StepDataKind::PhysicalObservation {
            return;
        }
        let active = self.session.is_some();
        let action = {
            let Some(window) = self.window.as_mut() else { return; };
            if window.closed { return; }
            if !stats.time.is_finite() || stats.time < 0.0 {
                WindowAction::Close("invalid_observation")
            } else if let Some((previous_step, previous_time)) = window.last_observation {
                if stats.step == previous_step {
                    if stats.time.to_bits() == previous_time.to_bits() {
                        WindowAction::Ignore
                    } else {
                        WindowAction::Close("invalid_observation")
                    }
                } else if stats.step < previous_step || stats.time < previous_time {
                    WindowAction::Close("invalid_observation")
                } else {
                    window.last_observation = Some((stats.step, stats.time));
                    Self::window_action(active, window, stats.step, stats.time)
                }
            } else {
                window.last_observation = Some((stats.step, stats.time));
                Self::window_action(active, window, stats.step, stats.time)
            }
        };
        match action {
            WindowAction::Ignore => {}
            WindowAction::Start(step, time_s) => self.start_window(step, time_s, factory),
            WindowAction::Stop(step, time_s) => self.close_window("completed", Some((step, time_s))),
            WindowAction::Close(reason) => self.close_window(reason, None),
        }
    }

    fn window_action(active: bool, window: &WindowCapture, step: u64, time_s: f64) -> WindowAction {
        if active {
            if step == window.receipt.end_after_step { WindowAction::Stop(step, time_s) }
            else if step > window.receipt.end_after_step { WindowAction::Close("invalid_observation") }
            else { WindowAction::Ignore }
        } else if step == window.receipt.start_after_step {
            WindowAction::Start(step, time_s)
        } else if step > window.receipt.start_after_step {
            WindowAction::Close("start_boundary_missed")
        } else {
            WindowAction::Ignore
        }
    }

    fn start_window(&mut self, step: u64, time_s: f64,
        factory: impl FnOnce(&File, &Config) -> Result<S>) {
        let config = self.receipt.config.clone();
        let start = Instant::now();
        let result = factory(&self.file, &config);
        self.receipt.start_wall_seconds = start.elapsed().as_secs_f64();
        match result {
            Ok(session) => {
                self.session = Some(session);
                if let Some(window) = &mut self.window {
                    window.capture_started = Some(start);
                    window.receipt.observed_start_step = Some(step);
                    window.receipt.observed_start_time_s = Some(time_s);
                }
            }
            Err(error) => {
                self.note_error(format!("native startup: {error:#}"));
                if let Some(window) = &mut self.window {
                    window.receipt.completion_reason = "start_failed";
                    window.closed = true;
                }
            }
        }
    }

    fn close_window(&mut self, reason: &'static str, end_boundary: Option<(u64, f64)>) {
        let stopping = Instant::now();
        self.receipt.stop_wall_seconds = 0.0;
        let result = self.session.take().map(|mut session| session.stop());
        if let Some(result) = result {
            self.receipt.stop_wall_seconds = stopping.elapsed().as_secs_f64();
            match result {
                Ok(report) => {
                    let capture_wall_seconds = self.capture_elapsed_seconds();
                    let native_stop_failed = report.status_code != 0;
                    self.receipt.native = Some(report);
                    if let Some(window) = &mut self.window {
                        window.receipt.capture_wall_seconds = capture_wall_seconds;
                        if native_stop_failed {
                            window.receipt.completion_reason = "stop_failed";
                            window.receipt.completed = false;
                        } else {
                            if reason == "completed" {
                                if let Some((step, time_s)) = end_boundary {
                                    window.receipt.observed_end_step = Some(step);
                                    window.receipt.observed_end_time_s = Some(time_s);
                                    window.receipt.completed = true;
                                }
                            }
                            window.receipt.completion_reason = reason;
                        }
                        window.closed = true;
                    }
                }
                Err(error) => {
                    let capture_wall_seconds = self.capture_elapsed_seconds();
                    self.note_error(format!("native stop: {error:#}"));
                    if let Some(window) = &mut self.window {
                        window.receipt.capture_wall_seconds = capture_wall_seconds;
                        window.receipt.completion_reason = "stop_failed";
                        window.receipt.completed = false;
                        window.closed = true;
                    }
                }
            }
        } else if let Some(window) = &mut self.window {
            window.receipt.completion_reason = reason;
            window.receipt.completed = false;
            window.closed = true;
        }
    }

    fn capture_elapsed_seconds(&self) -> f64 {
        self.window.as_ref().and_then(|window| window.capture_started.as_ref())
            .map(|started| started.elapsed().as_secs_f64()).unwrap_or(0.0)
    }

    pub(crate) fn finish(&mut self, solver_outcome: &str) -> Result<()> {
        if self.finalized { return Ok(()); }
        // No retry of native stop or immutable publication after an uncertain error.
        self.finalized = true;
        self.receipt.solver_outcome = solver_outcome.into();
        let window_needs_finish = self.window.as_ref().is_some_and(|window| !window.closed);
        if window_needs_finish {
            if self.session.is_some() {
                self.close_window("solver_finished_before_end", None);
            } else if let Some(window) = &mut self.window {
                window.receipt.completion_reason = "solver_finished_before_start";
                window.closed = true;
            }
        }
        if self.window.is_none() {
            let stopping = Instant::now();
            if let Some(mut session) = self.session.take() {
                match session.stop() {
                    Ok(report) => self.receipt.native = Some(report),
                    Err(error) => self.note_error(format!("native stop: {error:#}")),
                }
            }
            self.receipt.stop_wall_seconds = stopping.elapsed().as_secs_f64();
        }
        if let Err(error) = self.file.sync_all() { self.note_error(format!("trace fsync: {error}")); }
        match hash_file(&mut self.file, self.receipt.config.max_bytes) {
            Ok((size, sha)) => { self.receipt.trace_size_bytes = Some(size); self.receipt.trace_sha256 = Some(sha); }
            Err(error) => self.note_error(format!("trace hash: {error:#}")),
        }
        if let Some(report) = &self.receipt.native {
            let stats = &report.stats;
            if report.status_code != 0 || stats.schema_version != 1 || stats.cupti_version != 28
                || stats.start_timestamp_ns == 0 || stats.end_timestamp_ns < stats.start_timestamp_ns
                || Some(stats.bytes_written) != self.receipt.trace_size_bytes
                || stats.api_errors != 0 || stats.io_errors != 0 {
                self.note_error("native CUDA trace returned invalid or failed completion evidence".into());
            }
        }
        self.receipt.status = match &self.receipt.native {
            Some(report) if self.receipt.errors.is_empty() => {
                let s = &report.stats;
                if s.limit_flags != 0 || s.dropped_records != 0 || s.buffer_starvations != 0
                    || s.unknown_records != 0 || s.truncated_names != 0 || s.incomplete_records != 0
                    || s.records_written == 0 || solver_outcome == "aborted"
                    || self.window.as_ref().is_some_and(|window| !window.receipt.completed) { "partial" } else { "complete" }
            }
            None if self.window.is_some() && self.receipt.errors.is_empty() => "partial",
            _ => "failed",
        }.into();
        self.receipt.total_wall_seconds = self.started.elapsed().as_secs_f64();
        if let Some(window) = &self.window {
            let receipt = ReceiptV2 {
                schema_version: "worker_cuda_trace.v2",
                identity: &self.receipt.identity,
                config: &self.receipt.config,
                config_sha256: &self.receipt.config_sha256,
                worker_pid: self.receipt.worker_pid,
                gpu_uuid: &self.receipt.gpu_uuid,
                solver_outcome: &self.receipt.solver_outcome,
                status: &self.receipt.status,
                trace_file: &self.receipt.trace_file,
                trace_size_bytes: self.receipt.trace_size_bytes,
                trace_sha256: &self.receipt.trace_sha256,
                native: &self.receipt.native,
                start_wall_seconds: self.receipt.start_wall_seconds,
                stop_wall_seconds: self.receipt.stop_wall_seconds,
                total_wall_seconds: self.receipt.total_wall_seconds,
                overhead_scope: &self.receipt.overhead_scope,
                errors: &self.receipt.errors,
                accepted_step_window: &window.receipt,
            };
            crate::accepted_study_worker::write_immutable_attempt_receipt(&self.attempt, RECEIPT_V2, &receipt)
        } else {
            crate::accepted_study_worker::write_immutable_attempt_receipt(&self.attempt, RECEIPT, &self.receipt)
        }
    }
}

impl Capture<FemCudaTrace> {
    pub(crate) fn observe_accepted_step(&mut self, stats: &fullmag_runner::StepStats) {
        self.observe_accepted_step_with_factory(stats, |file, config|
            FemCudaTrace::start(file, config.max_bytes, config.max_duration_ms).map_err(anyhow::Error::msg));
    }
}

impl<S: Session> Drop for Capture<S> {
    fn drop(&mut self) {
        if !self.finalized {
            if let Err(error) = self.finish("aborted") {
                eprintln!("CUDA trace unwind evidence could not be persisted: {error:#}");
            }
        }
    }
}

fn hash_file(file: &mut File, max_bytes: u64) -> Result<(u64, String)> {
    let expected = file.metadata()?.len();
    if expected > max_bytes { bail!("trace exceeds its admitted byte budget"); }
    file.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut size = 0u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 { break; }
        size += count as u64;
        if size > max_bytes { bail!("trace grew beyond its admitted byte budget"); }
        hash.update(&buffer[..count]);
    }
    if size != expected || file.metadata()?.len() != expected { bail!("trace changed after native stop"); }
    Ok((size, format!("{:x}", hash.finalize())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;
    use std::io::Write;
    use std::time::Duration;
    use fullmag_runner::FemCudaTraceStats;

    struct Fake {
        stops: Rc<Cell<usize>>,
        dropped: u64,
        fail: bool,
        cupti_version: u64,
        status_code: i32,
        stop_delay: Duration,
    }
    impl Session for Fake {
        fn stop(&mut self) -> Result<FemCudaTraceEnd> {
            self.stops.set(self.stops.get() + 1);
            std::thread::sleep(self.stop_delay);
            if self.fail { bail!("mock stop failure"); }
            Ok(FemCudaTraceEnd { status_code: self.status_code, stats: FemCudaTraceStats {
                schema_version: 1, cupti_version: self.cupti_version, start_timestamp_ns: 1, end_timestamp_ns: 2,
                records_written: 1, bytes_written: 3, dropped_records: self.dropped, ..Default::default() } })
        }
    }
    #[derive(Clone, Copy)]
    struct FakeBehavior {
        fail_start: bool,
        fail_stop: bool,
        dropped: u64,
        status_code: i32,
        start_delay: Duration,
        stop_delay: Duration,
    }
    impl Default for FakeBehavior {
        fn default() -> Self {
            Self { fail_start: false, fail_stop: false, dropped: 0, status_code: 0,
                start_delay: Duration::ZERO, stop_delay: Duration::ZERO }
        }
    }

    struct WindowedFakeCapture {
        capture: Capture<Fake>,
        starts: Rc<Cell<usize>>,
        stops: Rc<Cell<usize>>,
        behavior: FakeBehavior,
    }
    impl WindowedFakeCapture {
        fn observe_accepted_step(&mut self, stats: &fullmag_runner::StepStats) {
            let starts = self.starts.clone();
            let stops = self.stops.clone();
            let behavior = self.behavior;
            self.capture.observe_accepted_step_with_factory(stats, move |file, _| {
                starts.set(starts.get() + 1);
                if behavior.fail_start { bail!("mock delayed start failure"); }
                std::thread::sleep(behavior.start_delay);
                file.try_clone()?.write_all(b"{}\n")?;
                Ok(Fake { stops, dropped: behavior.dropped, fail: behavior.fail_stop,
                    cupti_version: 28, status_code: behavior.status_code, stop_delay: behavior.stop_delay })
            });
        }

        fn finish(&mut self, outcome: &str) -> Result<()> {
            self.capture.finish(outcome)
        }
    }
    fn config() -> Config { Config { schema_version: super::super::cuda_trace::SCHEMA.into(), max_bytes: 4096, max_duration_ms: 1000, accepted_step_window: None } }
    fn windowed_config() -> Config { Config { schema_version: super::super::cuda_trace::SCHEMA_V2.into(), max_bytes: 4096, max_duration_ms: 1000,
        accepted_step_window: Some(super::super::cuda_trace::AcceptedStepWindow { start_after_step: 16, end_after_step: 32 }) } }
    fn identity() -> WorkerExecutionReceiptIdentity {
        use fullmag_application::*;
        WorkerExecutionReceiptIdentity { schema_version: "fullmag.accepted_worker_execution.v1".into(),
            claim: TaskClaim { run_id: RunId::parse("run-trace").unwrap(), task_id: TaskId::parse("task-trace").unwrap(),
                attempt_id: AttemptId::parse("attempt-trace").unwrap(), ownership_epoch: OwnershipEpoch::INITIAL,
                lease: ResourceLease { resource_id: "gpu".into(), kind: ResourceKind::Gpu,
                    budget: ResourceBudget { cpu_millis: 1000, memory_bytes: 1024, gpu_memory_bytes: 1024, storage_bytes: 1024 },
                    lease_token: LeaseToken::parse("lease-trace").unwrap(), heartbeat_sequence: 0 } },
            start_message_id: "start-trace".into(), start_sequence: 1, case_id: "default".into(), plan_fingerprint: "a".repeat(64) }
    }
    fn make(path: &Path, stops: Rc<Cell<usize>>, dropped: u64, fail: bool) -> Capture<Fake> {
        Capture::start_with(Some(&config()), path, &identity(), Some("gpu-test"), move |file, _| {
            file.try_clone()?.write_all(b"{}\n")?;
            Ok(Fake { stops, dropped, fail, cupti_version: 28, status_code: 0, stop_delay: Duration::ZERO })
        }).unwrap().unwrap()
    }
    fn read(path: &Path) -> Receipt { serde_json::from_slice(&std::fs::read(path.join(RECEIPT)).unwrap()).unwrap() }
    fn read_v2(path: &Path) -> serde_json::Value { serde_json::from_slice(&std::fs::read(path.join(RECEIPT_V2)).unwrap()).unwrap() }

    fn step(step: u64, time: f64, kind: fullmag_quantities::StepDataKind) -> fullmag_runner::StepStats {
        fullmag_runner::StepStats { step, time, kind, ..Default::default() }
    }

    fn make_v2(path: &Path, starts: Rc<Cell<usize>>, stops: Rc<Cell<usize>>,
        behavior: FakeBehavior) -> WindowedFakeCapture {
        let capture = Capture::<Fake>::reserve(Some(&windowed_config()), path, &identity(), Some("gpu-test"))
            .unwrap().unwrap();
        WindowedFakeCapture { capture, starts, stops, behavior }
    }

    #[test]
    fn absent_trace_creates_nothing_and_never_calls_native() {
        let dir = tempfile::tempdir().unwrap();
        let result = Capture::<Fake>::start_with(None, dir.path(), &identity(), None, |_, _| panic!("off must not start"));
        assert!(result.unwrap().is_none());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn production_capture_remains_send_for_runner_callbacks() {
        fn assert_send<T: Send>() {}
        assert_send::<Capture<FemCudaTrace>>();
    }
    #[test]
    fn normal_failure_and_cancel_keep_solver_outcome_and_stop_once() {
        for outcome in ["completed", "failed", "cancelled"] {
            let dir = tempfile::tempdir().unwrap(); let stops = Rc::new(Cell::new(0));
            let mut capture = make(dir.path(), stops.clone(), 0, false);
            capture.finish(outcome).unwrap(); capture.finish(outcome).unwrap(); drop(capture);
            assert_eq!(stops.get(), 1);
            let receipt = read(dir.path()); assert_eq!(receipt.status, "complete");
            assert_eq!(receipt.solver_outcome, outcome); assert!(receipt.trace_sha256.is_some());
            assert!(receipt.identity.matches_same_attempt(&identity()));
            let serialized: serde_json::Value = serde_json::from_slice(
                &std::fs::read(dir.path().join(RECEIPT)).unwrap()).unwrap();
            assert!(serialized.get("accepted_step_window").is_none());
            assert!(serialized["config"].get("accepted_step_window").is_none());
        }
    }
    #[test]
    fn incompatible_native_cupti_version_cannot_claim_a_complete_trace() {
        for version in [24, 27] {
            let dir = tempfile::tempdir().unwrap(); let stops = Rc::new(Cell::new(0));
            let mut capture = make(dir.path(), stops.clone(), 0, false);
            capture.session.as_mut().unwrap().cupti_version = version;
            capture.finish("completed").unwrap(); drop(capture);
            let receipt = read(dir.path());
            assert_eq!(receipt.status, "failed");
            assert_eq!(receipt.solver_outcome, "completed");
            assert_eq!(stops.get(), 1);
            assert!(!receipt.errors.is_empty());
        }
    }
    #[test]
    fn loss_and_native_failure_cannot_claim_a_complete_trace() {
        for (dropped, fail, status) in [(1, false, "partial"), (0, true, "failed")] {
            let dir = tempfile::tempdir().unwrap(); let stops = Rc::new(Cell::new(0));
            let mut capture = make(dir.path(), stops.clone(), dropped, fail);
            capture.finish("failed").unwrap(); drop(capture);
            let receipt = read(dir.path()); assert_eq!(receipt.status, status);
            assert_eq!(receipt.solver_outcome, "failed"); assert_eq!(stops.get(), 1);
        }
    }
    #[test]
    fn unwind_retains_partial_trace_and_existing_output_is_never_replaced() {
        let dir = tempfile::tempdir().unwrap(); let stops = Rc::new(Cell::new(0));
        drop(make(dir.path(), stops.clone(), 0, false));
        assert_eq!(stops.get(), 1); assert_eq!(read(dir.path()).status, "partial");
        let original = std::fs::read(dir.path().join(TRACE)).unwrap();
        assert!(Capture::<Fake>::start_with(Some(&config()), dir.path(), &identity(), Some("gpu-test"),
            |_, _| panic!("existing output must refuse before native startup")).is_err());
        assert_eq!(std::fs::read(dir.path().join(TRACE)).unwrap(), original);
    }
    #[test]
    fn failed_start_is_persisted_without_claiming_solver_execution() {
        let dir = tempfile::tempdir().unwrap();
        let result = Capture::<Fake>::start_with(Some(&config()), dir.path(), &identity(), Some("gpu-test"),
            |_, _| anyhow::bail!("mock unavailable"));
        assert!(result.is_err()); let receipt = read(dir.path());
        assert_eq!(receipt.status, "failed"); assert_eq!(receipt.solver_outcome, "not_started");
    }

    #[cfg(unix)]
    #[test]
    fn trace_keeps_the_same_group_access_as_sibling_attempt_receipts() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let mut capture = make(dir.path(), Rc::new(Cell::new(0)), 0, false);
        capture.finish("completed").unwrap();
        let trace_mode = std::fs::metadata(dir.path().join(TRACE)).unwrap().permissions().mode();
        let receipt_mode = std::fs::metadata(dir.path().join(RECEIPT)).unwrap().permissions().mode();
        assert_eq!(trace_mode & 0o070, receipt_mode & 0o070);
        assert_eq!(trace_mode & 0o007, 0);
    }

    #[test]
    fn v2_starts_only_at_n_and_stops_once_at_m_with_idempotent_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let starts = Rc::new(Cell::new(0));
        let stops = Rc::new(Cell::new(0));
        let mut capture = make_v2(dir.path(), starts.clone(), stops.clone(), FakeBehavior::default());
        assert_eq!(starts.get(), 0);
        capture.observe_accepted_step(&step(15, 0.15, fullmag_quantities::StepDataKind::PhysicalObservation));
        capture.observe_accepted_step(&step(16, 0.16, fullmag_quantities::StepDataKind::SolverProgress));
        assert_eq!(starts.get(), 0);
        capture.observe_accepted_step(&step(16, 0.16, fullmag_quantities::StepDataKind::PhysicalObservation));
        capture.observe_accepted_step(&step(16, 0.16, fullmag_quantities::StepDataKind::PhysicalObservation));
        assert_eq!(starts.get(), 1);
        assert_eq!(stops.get(), 0);
        capture.observe_accepted_step(&step(32, 0.32, fullmag_quantities::StepDataKind::PhysicalObservation));
        capture.observe_accepted_step(&step(32, 0.32, fullmag_quantities::StepDataKind::PhysicalObservation));
        assert_eq!(stops.get(), 1);
        capture.finish("failed").unwrap();
        let receipt = read_v2(dir.path());
        assert_eq!(receipt["schema_version"], "worker_cuda_trace.v2");
        assert_eq!(receipt["trace_file"], TRACE);
        assert_eq!(receipt["solver_outcome"], "failed");
        assert_eq!(receipt["status"], "complete");
        assert_eq!(receipt["accepted_step_window"]["observed_start_step"], 16);
        assert_eq!(receipt["accepted_step_window"]["observed_end_step"], 32);
        assert_eq!(receipt["accepted_step_window"]["completion_reason"], "completed");
        assert_eq!(receipt["accepted_step_window"]["completed"], true);
        assert!(receipt["accepted_step_window"]["capture_wall_seconds"].as_f64().unwrap() >= 0.0);
        assert!(!dir.path().join(RECEIPT).exists());
    }

    #[test]
    fn v2_missed_start_and_early_finish_are_partial_without_native_start() {
        for (observations, reason) in [
            (vec![(17, 0.17)], "start_boundary_missed"),
            (vec![(15, 0.15)], "solver_finished_before_start"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let starts = Rc::new(Cell::new(0));
            let stops = Rc::new(Cell::new(0));
            let mut capture = make_v2(dir.path(), starts.clone(), stops.clone(), FakeBehavior::default());
            for (step_number, time) in observations {
                capture.observe_accepted_step(&step(step_number, time, fullmag_quantities::StepDataKind::PhysicalObservation));
            }
            capture.finish("completed").unwrap();
            let receipt = read_v2(dir.path());
            assert_eq!(starts.get(), 0);
            assert_eq!(stops.get(), 0);
            assert_eq!(receipt["status"], "partial");
            assert_eq!(receipt["native"], serde_json::Value::Null);
            assert_eq!(receipt["accepted_step_window"]["completion_reason"], reason);
            assert_eq!(receipt["accepted_step_window"]["observed_start_step"], serde_json::Value::Null);
            assert_eq!(receipt["accepted_step_window"]["capture_wall_seconds"], 0.0);
            assert_eq!(receipt["trace_size_bytes"], 0);
            assert_eq!(receipt["trace_sha256"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        }
    }

    #[test]
    fn v2_finish_before_m_stops_once_but_does_not_claim_an_end_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let starts = Rc::new(Cell::new(0));
        let stops = Rc::new(Cell::new(0));
        let mut capture = make_v2(dir.path(), starts.clone(), stops.clone(), FakeBehavior::default());
        capture.observe_accepted_step(&step(16, 0.16, fullmag_quantities::StepDataKind::PhysicalObservation));
        capture.observe_accepted_step(&step(20, 0.20, fullmag_quantities::StepDataKind::PhysicalObservation));
        capture.finish("cancelled").unwrap();
        drop(capture);
        let receipt = read_v2(dir.path());
        assert_eq!(starts.get(), 1);
        assert_eq!(stops.get(), 1);
        assert_eq!(receipt["status"], "partial");
        assert_eq!(receipt["solver_outcome"], "cancelled");
        assert_eq!(receipt["accepted_step_window"]["completion_reason"], "solver_finished_before_end");
        assert_eq!(receipt["accepted_step_window"]["observed_end_step"], serde_json::Value::Null);
        assert_eq!(receipt["accepted_step_window"]["completed"], false);
    }

    #[test]
    fn v2_invalid_clock_rewind_or_skipped_end_closes_without_false_completion() {
        for (invalid_step, invalid_time) in [(33, 0.33), (32, 0.15), (15, 0.17), (16, 0.17), (20, f64::NAN)] {
            let dir = tempfile::tempdir().unwrap();
            let starts = Rc::new(Cell::new(0));
            let stops = Rc::new(Cell::new(0));
            let mut capture = make_v2(dir.path(), starts.clone(), stops.clone(), FakeBehavior::default());
            capture.observe_accepted_step(&step(16, 0.16, fullmag_quantities::StepDataKind::PhysicalObservation));
            capture.observe_accepted_step(&step(invalid_step, invalid_time, fullmag_quantities::StepDataKind::PhysicalObservation));
            capture.finish("completed").unwrap();
            let receipt = read_v2(dir.path());
            assert_eq!(starts.get(), 1);
            assert_eq!(stops.get(), 1);
            assert_eq!(receipt["status"], "partial");
            assert_eq!(receipt["accepted_step_window"]["completion_reason"], "invalid_observation");
            assert_eq!(receipt["accepted_step_window"]["observed_end_step"], serde_json::Value::Null);
            assert_eq!(receipt["accepted_step_window"]["completed"], false);
        }
    }

    #[test]
    fn v2_delayed_start_and_stop_failures_are_recorded_without_replacement_or_retry() {
        let dir = tempfile::tempdir().unwrap();
        let starts = Rc::new(Cell::new(0));
        let stops = Rc::new(Cell::new(0));
        let mut capture = make_v2(dir.path(), starts.clone(), stops.clone(), FakeBehavior { fail_start: true, ..Default::default() });
        capture.observe_accepted_step(&step(16, 0.16, fullmag_quantities::StepDataKind::PhysicalObservation));
        capture.observe_accepted_step(&step(17, 0.17, fullmag_quantities::StepDataKind::PhysicalObservation));
        capture.finish("completed").unwrap();
        let receipt = read_v2(dir.path());
        assert_eq!(starts.get(), 1);
        assert_eq!(stops.get(), 0);
        assert_eq!(receipt["status"], "failed");
        assert_eq!(receipt["solver_outcome"], "completed");
        assert_eq!(receipt["accepted_step_window"]["completion_reason"], "start_failed");
        assert_eq!(receipt["accepted_step_window"]["observed_start_step"], serde_json::Value::Null);
        assert!(!receipt["errors"].as_array().unwrap().is_empty());

        let dir = tempfile::tempdir().unwrap();
        let starts = Rc::new(Cell::new(0));
        let stops = Rc::new(Cell::new(0));
        let mut capture = make_v2(dir.path(), starts.clone(), stops.clone(), FakeBehavior { fail_stop: true, ..Default::default() });
        capture.observe_accepted_step(&step(16, 0.16, fullmag_quantities::StepDataKind::PhysicalObservation));
        capture.observe_accepted_step(&step(32, 0.32, fullmag_quantities::StepDataKind::PhysicalObservation));
        capture.observe_accepted_step(&step(32, 0.32, fullmag_quantities::StepDataKind::PhysicalObservation));
        capture.finish("completed").unwrap();
        let receipt = read_v2(dir.path());
        assert_eq!(starts.get(), 1);
        assert_eq!(stops.get(), 1);
        assert_eq!(receipt["status"], "failed");
        assert_eq!(receipt["accepted_step_window"]["completion_reason"], "stop_failed");
        assert_eq!(receipt["native"], serde_json::Value::Null);
        assert_eq!(receipt["accepted_step_window"]["observed_start_step"], 16);
        assert_eq!(receipt["accepted_step_window"]["observed_end_step"], serde_json::Value::Null);
        assert!(receipt["accepted_step_window"]["capture_wall_seconds"].as_f64().unwrap() >= 0.0);
        assert!(receipt["trace_sha256"].as_str().is_some());
    }

    #[test]
    fn v2_drop_stops_an_active_capture_once_and_progress_never_advances_the_window() {
        let dir = tempfile::tempdir().unwrap();
        let starts = Rc::new(Cell::new(0));
        let stops = Rc::new(Cell::new(0));
        let mut capture = make_v2(dir.path(), starts.clone(), stops.clone(), FakeBehavior::default());
        capture.observe_accepted_step(&step(32, 0.32, fullmag_quantities::StepDataKind::SolverProgress));
        assert_eq!(starts.get(), 0);
        capture.observe_accepted_step(&step(16, 0.16, fullmag_quantities::StepDataKind::PhysicalObservation));
        drop(capture);
        let receipt = read_v2(dir.path());
        assert_eq!(starts.get(), 1);
        assert_eq!(stops.get(), 1);
        assert_eq!(receipt["solver_outcome"], "aborted");
        assert_eq!(receipt["accepted_step_window"]["completion_reason"], "solver_finished_before_end");
        assert_eq!(receipt["status"], "partial");
    }

    #[test]
    fn v2_native_loss_is_partial_even_when_both_boundaries_are_observed() {
        let dir = tempfile::tempdir().unwrap();
        let starts = Rc::new(Cell::new(0));
        let stops = Rc::new(Cell::new(0));
        let mut capture = make_v2(dir.path(), starts.clone(), stops.clone(), FakeBehavior { dropped: 1, ..Default::default() });
        capture.observe_accepted_step(&step(16, 0.16, fullmag_quantities::StepDataKind::PhysicalObservation));
        capture.observe_accepted_step(&step(32, 0.32, fullmag_quantities::StepDataKind::PhysicalObservation));
        capture.finish("completed").unwrap();
        let receipt = read_v2(dir.path());
        assert_eq!(starts.get(), 1);
        assert_eq!(stops.get(), 1);
        assert_eq!(receipt["status"], "partial");
        assert_eq!(receipt["accepted_step_window"]["completed"], true);
        assert_eq!(receipt["accepted_step_window"]["completion_reason"], "completed");
        assert_eq!(receipt["native"]["stats"]["dropped_records"], 1);
    }

    #[test]
    fn v2_nonzero_stop_status_fails_window_and_capture_clock_brackets_native_calls() {
        let dir = tempfile::tempdir().unwrap();
        let starts = Rc::new(Cell::new(0));
        let stops = Rc::new(Cell::new(0));
        let delay = Duration::from_millis(25);
        let mut capture = make_v2(dir.path(), starts.clone(), stops.clone(), FakeBehavior {
            status_code: 7,
            start_delay: delay,
            stop_delay: delay,
            ..Default::default()
        });
        capture.observe_accepted_step(&step(16, 0.16, fullmag_quantities::StepDataKind::PhysicalObservation));
        capture.observe_accepted_step(&step(32, 0.32, fullmag_quantities::StepDataKind::PhysicalObservation));
        capture.finish("completed").unwrap();

        let receipt = read_v2(dir.path());
        assert_eq!(starts.get(), 1);
        assert_eq!(stops.get(), 1);
        assert_eq!(receipt["status"], "failed");
        assert_eq!(receipt["accepted_step_window"]["completion_reason"], "stop_failed");
        assert_eq!(receipt["accepted_step_window"]["completed"], false);
        assert_eq!(receipt["accepted_step_window"]["observed_start_step"], 16);
        assert_eq!(receipt["accepted_step_window"]["observed_end_step"], serde_json::Value::Null);
        assert_eq!(receipt["native"]["status_code"], 7);
        assert!(!receipt["errors"].as_array().unwrap().is_empty());
        assert!(receipt["start_wall_seconds"].as_f64().unwrap() >= 0.02);
        assert!(receipt["stop_wall_seconds"].as_f64().unwrap() >= 0.02);
        assert!(receipt["accepted_step_window"]["capture_wall_seconds"].as_f64().unwrap() >= 0.04);
    }
}
