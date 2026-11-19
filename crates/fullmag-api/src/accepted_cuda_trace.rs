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

pub(crate) struct Capture<S: Session = FemCudaTrace> {
    session: Option<S>,
    file: File,
    attempt: PathBuf,
    receipt: Receipt,
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
        let Some(config) = config else { return Ok(None); };
        let value = serde_json::to_value(config)?;
        let config_sha256 = super::cuda_trace::request_digest(&value)?;
        let gpu_uuid = gpu_uuid.filter(|uuid| !uuid.is_empty()).context("CUDA trace has no accepted GPU UUID")?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        // The managed WSL result mount uses a shared group, like sibling worker
        // receipts. Keep other-user bits closed without denying that group.
        { use std::os::unix::fs::OpenOptionsExt; options.mode(0o660).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC); }
        let file = options.open(attempt.join(TRACE)).context("reserve exclusive CUDA trace output")?;
        let started = Instant::now();
        let mut capture = Self { session: None, file, attempt: attempt.to_owned(), started, finalized: false,
            receipt: Receipt { schema_version: "worker_cuda_trace.v1".into(), identity: identity.clone(),
                config: config.clone(), config_sha256, worker_pid: std::process::id(), gpu_uuid: gpu_uuid.into(),
                solver_outcome: "not_started".into(), status: "failed".into(), trace_file: TRACE.into(),
                trace_size_bytes: None, trace_sha256: None, native: None,
                start_wall_seconds: 0.0, stop_wall_seconds: 0.0, total_wall_seconds: 0.0,
                overhead_scope: "start/stop host API time only; callback overhead requires matched on/off runs".into(),
                errors: Vec::new() } };
        let result = factory(&capture.file, config);
        capture.receipt.start_wall_seconds = started.elapsed().as_secs_f64();
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

    fn note_error(&mut self, error: String) {
        self.receipt.errors.push(error.chars().take(2048).collect());
    }

    pub(crate) fn finish(&mut self, solver_outcome: &str) -> Result<()> {
        if self.finalized { return Ok(()); }
        // No retry of native stop or immutable publication after an uncertain error.
        self.finalized = true;
        self.receipt.solver_outcome = solver_outcome.into();
        let stopping = Instant::now();
        if let Some(mut session) = self.session.take() {
            match session.stop() {
                Ok(report) => self.receipt.native = Some(report),
                Err(error) => self.note_error(format!("native stop: {error:#}")),
            }
        }
        self.receipt.stop_wall_seconds = stopping.elapsed().as_secs_f64();
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
                    || s.records_written == 0 || solver_outcome == "aborted" { "partial" } else { "complete" }
            }
            _ => "failed",
        }.into();
        self.receipt.total_wall_seconds = self.started.elapsed().as_secs_f64();
        crate::accepted_study_worker::write_immutable_attempt_receipt(&self.attempt, RECEIPT, &self.receipt)
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
    use fullmag_runner::FemCudaTraceStats;

    struct Fake { stops: Rc<Cell<usize>>, dropped: u64, fail: bool, cupti_version: u64 }
    impl Session for Fake {
        fn stop(&mut self) -> Result<FemCudaTraceEnd> {
            self.stops.set(self.stops.get() + 1);
            if self.fail { bail!("mock stop failure"); }
            Ok(FemCudaTraceEnd { status_code: 0, stats: FemCudaTraceStats {
                schema_version: 1, cupti_version: self.cupti_version, start_timestamp_ns: 1, end_timestamp_ns: 2,
                records_written: 1, bytes_written: 3, dropped_records: self.dropped, ..Default::default() } })
        }
    }
    fn config() -> Config { Config { schema_version: super::super::cuda_trace::SCHEMA.into(), max_bytes: 4096, max_duration_ms: 1000 } }
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
        Capture::start_with(Some(&config()), path, &identity(), Some("gpu-test"), |file, _| {
            file.try_clone()?.write_all(b"{}\n")?;
            Ok(Fake { stops, dropped, fail, cupti_version: 28 })
        }).unwrap().unwrap()
    }
    fn read(path: &Path) -> Receipt { serde_json::from_slice(&std::fs::read(path.join(RECEIPT)).unwrap()).unwrap() }

    #[test]
    fn absent_trace_creates_nothing_and_never_calls_native() {
        let dir = tempfile::tempdir().unwrap();
        let result = Capture::<Fake>::start_with(None, dir.path(), &identity(), None, |_, _| panic!("off must not start"));
        assert!(result.unwrap().is_none());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
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
}
