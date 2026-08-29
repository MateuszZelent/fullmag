//! Buffered asynchronous artifact streaming for long-running solver outputs.
//!
//! Public `run_problem*` entry points use this pipeline to move large field
//! snapshots off the hot simulation path as early as possible. The channel is
//! bounded, so the solver gets back-pressure instead of unbounded RAM growth if
//! disk I/O falls behind.

#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
use crate::artifacts::field_unit;
use crate::artifacts::{
    write_field_snapshot_artifact, write_scalar_row, write_scalars_csv_header, FieldArtifactContext,
};
use crate::autosave_storage::{
    AutosaveTargetState, AutosaveTargetWriter, ContinuousIndexEntry, StageManifest,
    StageSampleCoordinate,
};
#[cfg(feature = "cuda")]
use crate::fdm::gpu::cuda::native::{
    NativeFdmFieldSnapshot, NativeFieldSnapshotInfo, NativeFieldSnapshotScalarType,
};
#[cfg(feature = "fem-gpu")]
use crate::native_fem::{NativeFemFieldSnapshot, NativeFemFieldSnapshotInfo};
use crate::table_autosave::{TableAutosaveConfig, TableStore};
use crate::types::{ExecutionProvenance, FieldSnapshot, RunError, SolverAttemptRecord, StepStats};
use fullmag_engine::{
    AdaptiveAttemptDecision, AdaptiveAttemptReason, AdaptiveAttemptRecord,
    MAX_ADAPTIVE_ATTEMPT_RECORDS,
};

#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, AtomicUsize, Ordering},
    mpsc::{self, SyncSender},
    Arc,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub(crate) const DEFAULT_ARTIFACT_PIPELINE_CAPACITY: usize = 4;

/// Storage for regular (host-materialized) field snapshots.
///
/// JSON remains the compatibility default.  The managed solved-current
/// qualification explicitly selects Zarr so transport readback does not turn
/// every sample into a multi-megabyte pretty-printed document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FieldArtifactStorage {
    Json,
    Zarr,
}

fn configured_field_artifact_storage() -> Result<FieldArtifactStorage, RunError> {
    match std::env::var("FULLMAG_ARTIFACT_FIELD_STORAGE")
        .ok()
        .as_deref()
        .unwrap_or("json")
    {
        "json" => Ok(FieldArtifactStorage::Json),
        "zarr" => Ok(FieldArtifactStorage::Zarr),
        value => Err(RunError {
            message: format!(
                "unsupported FULLMAG_ARTIFACT_FIELD_STORAGE={value:?}; expected json or zarr"
            ),
        }),
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ArtifactPipelineSummary {
    pub scalar_rows_written: usize,
    pub field_snapshots_written: usize,
    pub writer_jobs_completed: usize,
    pub artifact_writer_job_wall_time_ns: u64,
    pub scalar_row_writer_wall_time_ns: u64,
    pub field_snapshot_writer_wall_time_ns: u64,
    pub native_field_snapshot_writer_wall_time_ns: u64,
    /// Root of stage-autosave artifacts when it is distinct from the regular
    /// artifact output.  Final execution resolution is known only after the
    /// solver returns, so the caller must finalize this tree after the writer
    /// thread has flushed it.
    pub autosave_root: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(not(feature = "fem-gpu"), allow(dead_code))]
pub(crate) struct ArtifactPipelineDiagnosticsSnapshot {
    pub current_queue_depth: u64,
    pub max_queue_depth: u64,
    pub writer_jobs_completed: u64,
    pub artifact_writer_job_wall_time_ns: u64,
    pub scalar_row_writer_wall_time_ns: u64,
    pub field_snapshot_writer_wall_time_ns: u64,
    pub native_field_snapshot_writer_wall_time_ns: u64,
}

#[derive(Default)]
struct ArtifactPipelineDiagnosticsState {
    current_queue_depth: AtomicU64,
    max_queue_depth: AtomicU64,
    writer_jobs_completed: AtomicU64,
    artifact_writer_job_wall_time_ns: AtomicU64,
    scalar_row_writer_wall_time_ns: AtomicU64,
    field_snapshot_writer_wall_time_ns: AtomicU64,
    native_field_snapshot_writer_wall_time_ns: AtomicU64,
}

impl ArtifactPipelineDiagnosticsState {
    fn snapshot(&self) -> ArtifactPipelineDiagnosticsSnapshot {
        ArtifactPipelineDiagnosticsSnapshot {
            current_queue_depth: self.current_queue_depth.load(Ordering::Relaxed),
            max_queue_depth: self.max_queue_depth.load(Ordering::Relaxed),
            writer_jobs_completed: self.writer_jobs_completed.load(Ordering::Relaxed),
            artifact_writer_job_wall_time_ns: self
                .artifact_writer_job_wall_time_ns
                .load(Ordering::Relaxed),
            scalar_row_writer_wall_time_ns: self
                .scalar_row_writer_wall_time_ns
                .load(Ordering::Relaxed),
            field_snapshot_writer_wall_time_ns: self
                .field_snapshot_writer_wall_time_ns
                .load(Ordering::Relaxed),
            native_field_snapshot_writer_wall_time_ns: self
                .native_field_snapshot_writer_wall_time_ns
                .load(Ordering::Relaxed),
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(not(feature = "fem-gpu"), allow(dead_code))]
pub(crate) struct ArtifactEnqueueMetrics {
    pub block_wall_time_ns: u64,
    pub estimated_bytes: u64,
    pub queue_depth_after: usize,
    pub diagnostics: ArtifactPipelineDiagnosticsSnapshot,
}

#[cfg_attr(not(feature = "fem-gpu"), allow(dead_code))]
pub(crate) fn apply_artifact_enqueue_metrics(
    stats: &mut StepStats,
    metrics: ArtifactEnqueueMetrics,
) {
    stats.artifact_enqueue_block_wall_time_ns = stats
        .artifact_enqueue_block_wall_time_ns
        .saturating_add(metrics.block_wall_time_ns);
    stats.artifact_enqueue_bytes = stats
        .artifact_enqueue_bytes
        .saturating_add(metrics.estimated_bytes);
    stats.artifact_queue_depth_max = stats
        .artifact_queue_depth_max
        .max(metrics.queue_depth_after as u64)
        .max(metrics.diagnostics.max_queue_depth);
    stats.artifact_queue_depth_current = metrics.diagnostics.current_queue_depth;
    stats.artifact_writer_jobs_completed = metrics.diagnostics.writer_jobs_completed;
    stats.artifact_writer_job_wall_time_ns = metrics.diagnostics.artifact_writer_job_wall_time_ns;
    stats.artifact_scalar_row_writer_wall_time_ns =
        metrics.diagnostics.scalar_row_writer_wall_time_ns;
    stats.artifact_field_snapshot_writer_wall_time_ns =
        metrics.diagnostics.field_snapshot_writer_wall_time_ns;
    stats.artifact_native_field_snapshot_writer_wall_time_ns = metrics
        .diagnostics
        .native_field_snapshot_writer_wall_time_ns;
    stats.wall_time_ns = stats
        .wall_time_ns
        .saturating_add(metrics.block_wall_time_ns);
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct CpuAdaptiveAttemptBatch {
    records: [AdaptiveAttemptRecord; MAX_ADAPTIVE_ATTEMPT_RECORDS],
    count: usize,
    target_step: u64,
    time: f64,
    enable_demag: bool,
    estimator_order: u32,
}

impl CpuAdaptiveAttemptBatch {
    pub(crate) fn new(
        attempts: &[AdaptiveAttemptRecord],
        target_step: u64,
        time: f64,
        enable_demag: bool,
        estimator_order: u32,
    ) -> Self {
        let count = attempts.len().min(MAX_ADAPTIVE_ATTEMPT_RECORDS);
        let mut records = [AdaptiveAttemptRecord::default(); MAX_ADAPTIVE_ATTEMPT_RECORDS];
        records[..count].copy_from_slice(&attempts[..count]);
        Self {
            records,
            count,
            target_step,
            time,
            enable_demag,
            estimator_order,
        }
    }

    fn materialize_into(self, target: &mut Vec<SolverAttemptRecord>) {
        target.clear();
        target.reserve(self.count);
        for record in &self.records[..self.count] {
            target.push(SolverAttemptRecord {
                attempt: u64::from(record.attempt),
                adaptive_controller_policy_version: Some(
                    record.controller_policy_version.to_string(),
                ),
                error_norm_type: None,
                active_node_count: None,
                active_measure: None,
                normalization_denominator: None,
                max_scaled_error: None,
                weighted_rms_error: None,
                target_step: self.target_step,
                time: self.time,
                dt_attempt: record.dt_attempt,
                eta: record.normalized_error,
                max_norm_defect: None,
                max_spin_rotation: None,
                decision: adaptive_attempt_decision_name(record.decision).to_string(),
                reason: adaptive_attempt_reason_name(record.reason).to_string(),
                dt_next: record.dt_next,
                demag_solves: if self.enable_demag {
                    record.rhs_evals
                } else {
                    0
                },
                demag_iterations: 0,
                demag_residual: 0.0,
                rhs_evals: record.rhs_evals,
                estimator_order: self.estimator_order as i32,
            });
        }
    }
}

fn adaptive_attempt_decision_name(decision: AdaptiveAttemptDecision) -> &'static str {
    match decision {
        AdaptiveAttemptDecision::Accepted => "accepted",
        AdaptiveAttemptDecision::Retry => "retry",
        AdaptiveAttemptDecision::Failed => "failed",
    }
}

fn adaptive_attempt_reason_name(reason: AdaptiveAttemptReason) -> &'static str {
    match reason {
        AdaptiveAttemptReason::WithinTolerance => "within_tolerance",
        AdaptiveAttemptReason::ErrorAboveTolerance => "error_above_tolerance",
        AdaptiveAttemptReason::DtMinExhausted => "dt_min_exhausted",
        AdaptiveAttemptReason::NonFiniteError => "non_finite_error",
        AdaptiveAttemptReason::RetryLimitExhausted => "retry_limit_exhausted",
    }
}

enum ArtifactJob {
    ScalarRow(StepStats),
    FieldSnapshot {
        snapshot: FieldSnapshot,
        provenance: ExecutionProvenance,
    },
    #[cfg(feature = "cuda")]
    NativeFieldSnapshot {
        snapshot: NativeFdmFieldSnapshot,
        provenance: ExecutionProvenance,
    },
    #[cfg(feature = "fem-gpu")]
    NativeFemFieldSnapshot {
        snapshot: NativeFemFieldSnapshot,
        provenance: ExecutionProvenance,
    },
    UpdateProvenance {
        provenance: ExecutionProvenance,
        acknowledgement: mpsc::Sender<Result<(), String>>,
    },
    #[cfg(any(feature = "cuda", test))]
    FailedRunProvenance {
        provenance: ExecutionProvenance,
        primary_error: String,
        acknowledgement: mpsc::Sender<Result<(), String>>,
    },
    TerminalCpuAdaptiveAttempts {
        batch: CpuAdaptiveAttemptBatch,
        acknowledgement: mpsc::Sender<Result<(), String>>,
    },
    Shutdown,
}

impl ArtifactJob {
    fn estimated_bytes(&self) -> u64 {
        match self {
            ArtifactJob::ScalarRow(_) => std::mem::size_of::<StepStats>() as u64,
            ArtifactJob::FieldSnapshot { snapshot, .. } => snapshot
                .values
                .len()
                .saturating_mul(std::mem::size_of::<f64>())
                as u64,
            #[cfg(feature = "cuda")]
            ArtifactJob::NativeFieldSnapshot { .. } => 0,
            #[cfg(feature = "fem-gpu")]
            ArtifactJob::NativeFemFieldSnapshot { .. } => 0,
            #[cfg(any(feature = "cuda", test))]
            ArtifactJob::FailedRunProvenance { .. } => 0,
            ArtifactJob::TerminalCpuAdaptiveAttempts { batch, .. } => batch
                .count
                .saturating_mul(std::mem::size_of::<AdaptiveAttemptRecord>())
                as u64,
            ArtifactJob::UpdateProvenance { .. } => 0,
            ArtifactJob::Shutdown => 0,
        }
    }
}

#[derive(Clone)]
pub(crate) struct ArtifactPipelineSender {
    tx: SyncSender<ArtifactJob>,
    queue_depth: Arc<AtomicUsize>,
    diagnostics: Arc<ArtifactPipelineDiagnosticsState>,
    physics_execution_context: Option<crate::physics_graph_execution::PhysicsGraphExecutionContext>,
    #[cfg(feature = "fem-gpu")]
    accepted_step_fields: Arc<Vec<(String, u64)>>,
}

impl ArtifactPipelineSender {
    fn push(&self, job: ArtifactJob) -> Result<ArtifactEnqueueMetrics, RunError> {
        let estimated_bytes = job.estimated_bytes();
        let queue_depth_after = self.queue_depth.fetch_add(1, Ordering::Relaxed) + 1;
        self.diagnostics
            .current_queue_depth
            .store(queue_depth_after as u64, Ordering::Relaxed);
        update_atomic_max(&self.diagnostics.max_queue_depth, queue_depth_after as u64);
        let enqueue_start = std::time::Instant::now();
        self.tx.send(job).map_err(|_| {
            let queue_depth_after_rollback = self
                .queue_depth
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |depth| {
                    Some(depth.saturating_sub(1))
                })
                .map(|previous| previous.saturating_sub(1))
                .unwrap_or(0);
            self.diagnostics
                .current_queue_depth
                .store(queue_depth_after_rollback as u64, Ordering::Relaxed);
            RunError {
                message: "artifact writer thread became unavailable while streaming solver outputs"
                    .to_string(),
            }
        })?;
        let block_wall_time_ns = enqueue_start.elapsed().as_nanos() as u64;
        Ok(ArtifactEnqueueMetrics {
            block_wall_time_ns,
            estimated_bytes,
            queue_depth_after,
            diagnostics: self.diagnostics.snapshot(),
        })
    }

    #[cfg(any(feature = "cuda", test))]
    fn publish_failed_run_provenance(
        &self,
        provenance: ExecutionProvenance,
        primary_error: String,
    ) -> Result<(), RunError> {
        self.publish_failed_run_provenance_with_timeout(
            provenance,
            primary_error,
            Duration::from_secs(10),
        )
    }

    fn publish_terminal_cpu_adaptive_attempts(
        &self,
        batch: CpuAdaptiveAttemptBatch,
    ) -> Result<(), RunError> {
        self.publish_terminal_cpu_adaptive_attempts_with_timeout(batch, Duration::from_secs(10))
    }

    fn publish_terminal_cpu_adaptive_attempts_with_timeout(
        &self,
        batch: CpuAdaptiveAttemptBatch,
        timeout: Duration,
    ) -> Result<(), RunError> {
        let deadline = std::time::Instant::now() + timeout;
        let (acknowledgement, completed) = mpsc::channel();
        let mut job = ArtifactJob::TerminalCpuAdaptiveAttempts {
            batch,
            acknowledgement,
        };
        let queue_depth_after = self.queue_depth.fetch_add(1, Ordering::Relaxed) + 1;
        self.diagnostics
            .current_queue_depth
            .store(queue_depth_after as u64, Ordering::Relaxed);
        update_atomic_max(&self.diagnostics.max_queue_depth, queue_depth_after as u64);
        loop {
            match self.tx.try_send(job) {
                Ok(()) => break,
                Err(mpsc::TrySendError::Full(returned)) => {
                    job = returned;
                    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                    if remaining.is_zero() {
                        self.rollback_queue_depth();
                        return Err(RunError {
                            message: "timed out enqueueing terminal solver attempts".into(),
                        });
                    }
                    thread::park_timeout(remaining.min(Duration::from_millis(1)));
                }
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    self.rollback_queue_depth();
                    return Err(RunError {
                        message:
                            "artifact writer stopped before terminal solver attempts were queued"
                                .into(),
                    });
                }
            }
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        match completed.recv_timeout(remaining) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(message)) => Err(RunError { message }),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(RunError {
                message: "timed out waiting for terminal solver attempts".into(),
            }),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(RunError {
                message: "artifact writer stopped before terminal solver attempts were durable"
                    .into(),
            }),
        }
    }

    fn update_provenance(&self, provenance: ExecutionProvenance) -> Result<(), RunError> {
        self.update_provenance_with_timeout(provenance, Duration::from_secs(10))
    }

    fn update_provenance_with_timeout(
        &self,
        provenance: ExecutionProvenance,
        timeout: Duration,
    ) -> Result<(), RunError> {
        let deadline = std::time::Instant::now() + timeout;
        let (acknowledgement, completed) = mpsc::channel();
        let mut job = ArtifactJob::UpdateProvenance {
            provenance,
            acknowledgement,
        };
        let queue_depth_after = self.queue_depth.fetch_add(1, Ordering::Relaxed) + 1;
        self.diagnostics
            .current_queue_depth
            .store(queue_depth_after as u64, Ordering::Relaxed);
        update_atomic_max(&self.diagnostics.max_queue_depth, queue_depth_after as u64);
        loop {
            match self.tx.try_send(job) {
                Ok(()) => break,
                Err(mpsc::TrySendError::Full(returned)) => {
                    job = returned;
                    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                    if remaining.is_zero() {
                        self.rollback_queue_depth();
                        return Err(RunError {
                            message: "timed out enqueueing artifact provenance update".into(),
                        });
                    }
                    thread::park_timeout(remaining.min(Duration::from_millis(1)));
                }
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    self.rollback_queue_depth();
                    return Err(RunError {
                        message: "artifact writer stopped before provenance update was queued"
                            .into(),
                    });
                }
            }
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        match completed.recv_timeout(remaining) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(message)) => Err(RunError { message }),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(RunError {
                message: "timed out waiting for artifact provenance update".into(),
            }),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(RunError {
                message: "artifact writer stopped before provenance update completed".into(),
            }),
        }
    }

    #[cfg(any(feature = "cuda", test))]
    fn publish_failed_run_provenance_with_timeout(
        &self,
        provenance: ExecutionProvenance,
        primary_error: String,
        timeout: Duration,
    ) -> Result<(), RunError> {
        let deadline = std::time::Instant::now() + timeout;
        let (acknowledgement, completed) = mpsc::channel();
        let mut job = ArtifactJob::FailedRunProvenance {
            provenance,
            primary_error,
            acknowledgement,
        };
        let queue_depth_after = self.queue_depth.fetch_add(1, Ordering::Relaxed) + 1;
        self.diagnostics
            .current_queue_depth
            .store(queue_depth_after as u64, Ordering::Relaxed);
        update_atomic_max(&self.diagnostics.max_queue_depth, queue_depth_after as u64);

        loop {
            match self.tx.try_send(job) {
                Ok(()) => break,
                Err(mpsc::TrySendError::Full(returned_job)) => {
                    job = returned_job;
                    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                    if remaining.is_zero() {
                        self.rollback_queue_depth();
                        return Err(RunError {
                            message:
                                "timed out enqueueing durable failed-run provenance publication"
                                    .into(),
                        });
                    }
                    thread::park_timeout(remaining.min(Duration::from_millis(1)));
                }
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    self.rollback_queue_depth();
                    return Err(RunError {
                        message: "artifact writer became unavailable before failed-run provenance could be queued"
                            .into(),
                    });
                }
            }
        }

        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        match completed.recv_timeout(remaining) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(message)) => Err(RunError { message }),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(RunError {
                message: "timed out waiting for durable failed-run provenance publication".into(),
            }),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(RunError {
                message: "artifact writer stopped before failed-run provenance was durable".into(),
            }),
        }
    }

    fn rollback_queue_depth(&self) {
        let queue_depth_after_rollback = self
            .queue_depth
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |depth| {
                Some(depth.saturating_sub(1))
            })
            .map(|previous| previous.saturating_sub(1))
            .unwrap_or(0);
        self.diagnostics
            .current_queue_depth
            .store(queue_depth_after_rollback as u64, Ordering::Relaxed);
    }
}

pub(crate) struct ArtifactPipeline {
    tx: Option<SyncSender<ArtifactJob>>,
    handle: Option<JoinHandle<Result<ArtifactPipelineSummary, String>>>,
    queue_depth: Arc<AtomicUsize>,
    diagnostics: Arc<ArtifactPipelineDiagnosticsState>,
    physics_execution_context: Option<crate::physics_graph_execution::PhysicsGraphExecutionContext>,
    #[cfg(feature = "fem-gpu")]
    accepted_step_fields: Arc<Vec<(String, u64)>>,
}

impl ArtifactPipeline {
    /// Start the legacy artifact stream used by the unit-test recorder and
    /// older runner call sites.  The production path should prefer
    /// `start_for_problem_with_autosave_root`, but this wrapper preserves the
    /// same writer contract without enabling stage autosave.
    #[cfg(test)]
    pub(crate) fn start(
        output_dir: PathBuf,
        field_context: FieldArtifactContext,
        capacity: usize,
    ) -> Result<Self, RunError> {
        Self::start_with_stage_autosave_roots(
            output_dir.clone(),
            output_dir,
            field_context,
            capacity,
            None,
            None,
        )
    }

    pub(crate) fn start_for_problem_and_plan(
        problem: &fullmag_ir::ProblemIR,
        plan: &fullmag_ir::ExecutionPlanIR,
        output_dir: PathBuf,
        field_context: FieldArtifactContext,
        capacity: usize,
    ) -> Result<Self, RunError> {
        Self::start_for_problem_and_plan_with_autosave_root(
            problem,
            plan,
            output_dir.clone(),
            output_dir,
            field_context,
            capacity,
        )
    }

    pub(crate) fn start_for_problem_and_plan_with_autosave_root(
        problem: &fullmag_ir::ProblemIR,
        plan: &fullmag_ir::ExecutionPlanIR,
        output_dir: PathBuf,
        autosave_root: PathBuf,
        field_context: FieldArtifactContext,
        capacity: usize,
    ) -> Result<Self, RunError> {
        let stage_autosave = problem
            .study
            .sampling()
            .stage_autosave
            .clone()
            .map(|policy| StageAutosavePipelineConfig {
                stage_id: problem
                    .problem_meta
                    .runtime_metadata
                    .get("active_stage_id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(&problem.problem_meta.entrypoint_kind)
                    .to_string(),
                policy,
            });
        let physics_execution_context =
            crate::physics_graph_execution::PhysicsGraphExecutionContext::from_problem_and_plan(
                problem, plan,
            )?;
        Self::start_with_stage_autosave_roots(
            output_dir,
            autosave_root,
            field_context,
            capacity,
            stage_autosave,
            Some(physics_execution_context),
        )
    }

    #[cfg(test)]
    fn start_with_physics_execution_context(
        output_dir: PathBuf,
        field_context: FieldArtifactContext,
        capacity: usize,
        physics_execution_context: crate::physics_graph_execution::PhysicsGraphExecutionContext,
    ) -> Result<Self, RunError> {
        Self::start_with_stage_autosave_roots(
            output_dir.clone(),
            output_dir,
            field_context,
            capacity,
            None,
            Some(physics_execution_context),
        )
    }

    fn start_with_stage_autosave_roots(
        output_dir: PathBuf,
        autosave_root: PathBuf,
        field_context: FieldArtifactContext,
        capacity: usize,
        stage_autosave: Option<StageAutosavePipelineConfig>,
        physics_execution_context: Option<
            crate::physics_graph_execution::PhysicsGraphExecutionContext,
        >,
    ) -> Result<Self, RunError> {
        let field_storage = configured_field_artifact_storage()?;
        fs::create_dir_all(&output_dir).map_err(|error| RunError {
            message: format!(
                "failed to create artifact output directory '{}': {}",
                output_dir.display(),
                error
            ),
        })?;
        #[cfg(feature = "fem-gpu")]
        let accepted_step_fields = Arc::new(
            stage_autosave
                .as_ref()
                .map(|config| {
                    config
                        .policy
                        .fields
                        .iter()
                        .filter_map(|field| {
                            field
                                .every_steps
                                .map(|every| (field.quantity.clone(), every))
                        })
                        .collect()
                })
                .unwrap_or_default(),
        );
        let queue_depth = Arc::new(AtomicUsize::new(0));
        let writer_queue_depth = Arc::clone(&queue_depth);
        let diagnostics = Arc::new(ArtifactPipelineDiagnosticsState::default());
        let writer_diagnostics = Arc::clone(&diagnostics);
        let (tx, rx) = mpsc::sync_channel::<ArtifactJob>(capacity.max(1));
        let handle = thread::Builder::new()
            .name("fullmag-artifact-writer".into())
            .spawn(move || {
                writer_loop(
                    &output_dir,
                    &autosave_root,
                    field_context,
                    rx,
                    writer_queue_depth,
                    writer_diagnostics,
                    stage_autosave,
                    field_storage,
                )
            })
            .map_err(|error| RunError {
                message: format!("failed to spawn artifact writer thread: {}", error),
            })?;

        Ok(Self {
            tx: Some(tx),
            handle: Some(handle),
            queue_depth,
            diagnostics,
            physics_execution_context,
            #[cfg(feature = "fem-gpu")]
            accepted_step_fields,
        })
    }

    pub(crate) fn sender(&self) -> ArtifactPipelineSender {
        ArtifactPipelineSender {
            tx: self
                .tx
                .as_ref()
                .expect("artifact pipeline sender requested after finish")
                .clone(),
            queue_depth: Arc::clone(&self.queue_depth),
            diagnostics: Arc::clone(&self.diagnostics),
            physics_execution_context: self.physics_execution_context.clone(),
            #[cfg(feature = "fem-gpu")]
            accepted_step_fields: Arc::clone(&self.accepted_step_fields),
        }
    }

    pub(crate) fn finish(&mut self) -> Result<ArtifactPipelineSummary, RunError> {
        let mut shutdown_send_failed = false;
        if let Some(tx) = self.tx.take() {
            shutdown_send_failed = tx.send(ArtifactJob::Shutdown).is_err();
        }

        let Some(handle) = self.handle.take() else {
            return Ok(ArtifactPipelineSummary::default());
        };
        let result = handle
            .join()
            .map_err(|_| RunError {
                message: "artifact writer thread panicked".to_string(),
            })?
            .map_err(|message| RunError { message });
        if shutdown_send_failed {
            return result.map_err(|error| RunError {
                message: format!(
                    "artifact writer channel closed before shutdown signal: {}",
                    error.message
                ),
            });
        }
        result
    }
}

#[derive(Clone)]
struct StageAutosavePipelineConfig {
    stage_id: String,
    policy: fullmag_ir::StageAutosaveIR,
}

enum StageAutosaveWriter {
    Txt(crate::autosave_txt::TxtAutosaveWriter),
    Zarr(crate::autosave_zarr::ZarrAutosaveWriter),
    #[cfg(feature = "stage-autosave-hdf5")]
    Hdf5(crate::autosave_hdf5::Hdf5AutosaveWriter),
}

impl AutosaveTargetWriter for StageAutosaveWriter {
    fn begin_stage(&mut self, manifest: &StageManifest) -> Result<(), String> {
        match self {
            Self::Txt(writer) => writer.begin_stage(manifest),
            Self::Zarr(writer) => writer.begin_stage(manifest),
            #[cfg(feature = "stage-autosave-hdf5")]
            Self::Hdf5(writer) => writer.begin_stage(manifest),
        }
    }
    fn append_table_row(
        &mut self,
        entry: &ContinuousIndexEntry,
        values: &[f64],
    ) -> Result<(), String> {
        match self {
            Self::Txt(writer) => writer.append_table_row(entry, values),
            Self::Zarr(writer) => writer.append_table_row(entry, values),
            #[cfg(feature = "stage-autosave-hdf5")]
            Self::Hdf5(writer) => writer.append_table_row(entry, values),
        }
    }
    fn append_field_sample(
        &mut self,
        entry: &ContinuousIndexEntry,
        quantity: &str,
        values: &[f64],
    ) -> Result<(), String> {
        match self {
            Self::Txt(writer) => writer.append_field_sample(entry, quantity, values),
            Self::Zarr(writer) => writer.append_field_sample(entry, quantity, values),
            #[cfg(feature = "stage-autosave-hdf5")]
            Self::Hdf5(writer) => writer.append_field_sample(entry, quantity, values),
        }
    }
    fn finish_stage(&mut self, manifest: &StageManifest) -> Result<(), String> {
        match self {
            Self::Txt(writer) => writer.finish_stage(manifest),
            Self::Zarr(writer) => writer.finish_stage(manifest),
            #[cfg(feature = "stage-autosave-hdf5")]
            Self::Hdf5(writer) => writer.finish_stage(manifest),
        }
    }
}

struct StageAutosaveRuntime {
    state: AutosaveTargetState,
    writer: StageAutosaveWriter,
    table: Option<TableStore>,
    fields: std::collections::BTreeMap<String, FieldCadenceState>,
    relaxation_clock: bool,
    last_stats: Option<StepStats>,
}

struct FieldCadenceState {
    every_seconds: Option<f64>,
    every_steps: Option<u64>,
    next_time_s: f64,
    last_step: Option<u64>,
}

impl StageAutosaveRuntime {
    fn update_provenance(&mut self, provenance: &serde_json::Value) -> Result<(), String> {
        self.state.update_active_provenance(provenance.clone())?;
        self.writer.update_provenance(provenance)
    }

    fn new(output_dir: &Path, config: StageAutosavePipelineConfig) -> Result<Self, String> {
        let policy = config.policy;
        let writer = match policy.format {
            fullmag_ir::AutosaveFormatIR::Txt => {
                StageAutosaveWriter::Txt(crate::autosave_txt::TxtAutosaveWriter::new(output_dir))
            }
            fullmag_ir::AutosaveFormatIR::Zarr => {
                StageAutosaveWriter::Zarr(crate::autosave_zarr::ZarrAutosaveWriter::new(output_dir))
            }
            fullmag_ir::AutosaveFormatIR::Hdf5 => {
                #[cfg(feature = "stage-autosave-hdf5")]
                {
                    StageAutosaveWriter::Hdf5(crate::autosave_hdf5::Hdf5AutosaveWriter::new(
                        output_dir,
                    ))
                }
                #[cfg(not(feature = "stage-autosave-hdf5"))]
                {
                    return Err("HDF5 stage autosave requested, but capability 'stage_autosave_hdf5' is unavailable".into());
                }
            }
        };
        let table = policy
            .table
            .as_ref()
            .map(TableAutosaveConfig::from_ir)
            .transpose()?
            .map(TableStore::new);
        let table_quantities = table
            .as_ref()
            .map(TableStore::column_ids)
            .unwrap_or_default();
        let relaxation_clock = policy
            .fields
            .iter()
            .any(|field| field.every_steps.is_some())
            || policy
                .table
                .as_ref()
                .is_some_and(|table| table.every_steps.is_some());
        let fields = policy
            .fields
            .iter()
            .map(|field| {
                (
                    field.quantity.clone(),
                    FieldCadenceState {
                        every_seconds: field.every_seconds,
                        every_steps: field.every_steps,
                        next_time_s: 0.0,
                        last_step: None,
                    },
                )
            })
            .collect();
        let mut runtime = Self {
            state: AutosaveTargetState::resume(output_dir, &policy.target)?,
            writer,
            table,
            fields,
            relaxation_clock,
            last_stats: None,
        };
        runtime.state.begin_stage(
            &mut runtime.writer,
            config.stage_id,
            policy.layout,
            policy.format,
            table_quantities,
            policy
                .fields
                .iter()
                .map(|field| field.quantity.clone())
                .collect(),
        )?;
        Ok(runtime)
    }

    fn append_scalar(&mut self, stats: &StepStats) -> Result<(), String> {
        self.last_stats = Some(stats.clone());
        let Some(table) = self.table.as_mut() else {
            return Ok(());
        };
        if !table.append_if_due(stats)? {
            return Ok(());
        }
        let values = table
            .last_row()
            .expect("due append created a row")
            .values
            .clone();
        let coordinate = coordinate(self.relaxation_clock, stats);
        self.state
            .append_table_row(&mut self.writer, coordinate, &values)?;
        Ok(())
    }

    fn append_field(&mut self, snapshot: &FieldSnapshot) -> Result<(), String> {
        let values = snapshot.values.clone();
        self.append_field_values(
            &snapshot.name,
            snapshot.step,
            snapshot.time,
            snapshot.solver_dt,
            &values,
        )
    }

    fn append_field_values(
        &mut self,
        name: &str,
        step: u64,
        time: f64,
        solver_dt: f64,
        values: &[f64],
    ) -> Result<(), String> {
        let Some(cadence) = self.fields.get_mut(name) else {
            return Ok(());
        };
        let due = if cadence.every_steps.is_some() {
            true
        } else if let Some(every_seconds) = cadence.every_seconds {
            if time + every_seconds.abs() * 1e-9 < cadence.next_time_s {
                false
            } else {
                while cadence.next_time_s <= time + every_seconds.abs() * 1e-9 {
                    cadence.next_time_s += every_seconds;
                }
                true
            }
        } else {
            false
        };
        if !due || cadence.last_step == Some(step) {
            return Ok(());
        }
        cadence.last_step = Some(step);
        self.state.append_field_sample(
            &mut self.writer,
            coordinate(
                self.relaxation_clock,
                &StepStats {
                    step,
                    time,
                    dt: solver_dt,
                    ..StepStats::default()
                },
            ),
            name,
            values,
        )?;
        Ok(())
    }

    fn finish(mut self) -> Result<(), String> {
        if self.relaxation_clock {
            if let (Some(table), Some(stats)) = (self.table.as_mut(), self.last_stats.as_ref()) {
                if table.append_final_if_needed(stats)? {
                    let values = table
                        .last_row()
                        .expect("final append created a row")
                        .values
                        .clone();
                    self.state.append_table_row(
                        &mut self.writer,
                        StageSampleCoordinate::AcceptedStep {
                            accepted_step: stats.step,
                        },
                        &values,
                    )?;
                }
            }
        }
        self.state.finish_stage(&mut self.writer).map(|_| ())
    }
}

fn coordinate(relaxation_clock: bool, stats: &StepStats) -> StageSampleCoordinate {
    if relaxation_clock {
        StageSampleCoordinate::AcceptedStep {
            accepted_step: stats.step,
        }
    } else {
        StageSampleCoordinate::PhysicalTime { time_s: stats.time }
    }
}

impl Drop for ArtifactPipeline {
    fn drop(&mut self) {
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(ArtifactJob::Shutdown);
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

pub(crate) struct ArtifactRecorder {
    field_snapshots: Vec<FieldSnapshot>,
    field_snapshot_count: usize,
    /// Every accepted time-domain solver step, independent of user-visible
    /// scalar/field output cadence.  The diagnostics writer consumes this
    /// trace after execution; it must not be confused with `RunResult.steps`,
    /// which intentionally contains only requested output rows.
    solver_steps: Vec<StepStats>,
    cpu_adaptive_attempts: Vec<CpuAdaptiveAttemptBatch>,
    pipeline: Option<ArtifactPipelineSender>,
    provenance: ExecutionProvenance,
    physics_execution_context: Option<crate::physics_graph_execution::PhysicsGraphExecutionContext>,
    #[cfg(feature = "fem-gpu")]
    accepted_step_fields: Arc<Vec<(String, u64)>>,
    #[cfg(feature = "fem-gpu")]
    accepted_step_field_last_sample: std::collections::BTreeMap<String, u64>,
}

impl ArtifactRecorder {
    pub(crate) fn in_memory(provenance: ExecutionProvenance) -> Self {
        Self {
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            solver_steps: Vec::new(),
            cpu_adaptive_attempts: Vec::new(),
            pipeline: None,
            provenance,
            physics_execution_context: None,
            #[cfg(feature = "fem-gpu")]
            accepted_step_fields: Arc::new(Vec::new()),
            #[cfg(feature = "fem-gpu")]
            accepted_step_field_last_sample: std::collections::BTreeMap::new(),
        }
    }

    pub(crate) fn streaming(
        provenance: ExecutionProvenance,
        pipeline: ArtifactPipelineSender,
    ) -> Self {
        #[cfg(feature = "fem-gpu")]
        let accepted_step_fields = Arc::clone(&pipeline.accepted_step_fields);
        let physics_execution_context = pipeline.physics_execution_context.clone();
        Self {
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            solver_steps: Vec::new(),
            cpu_adaptive_attempts: Vec::new(),
            pipeline: Some(pipeline),
            provenance,
            physics_execution_context,
            #[cfg(feature = "fem-gpu")]
            accepted_step_fields,
            #[cfg(feature = "fem-gpu")]
            accepted_step_field_last_sample: std::collections::BTreeMap::new(),
        }
    }

    #[cfg(feature = "fem-gpu")]
    pub(crate) fn due_accepted_step_fields(
        &mut self,
        accepted_step: u64,
        final_sample: bool,
    ) -> Vec<String> {
        let due = self
            .accepted_step_fields
            .iter()
            .filter(|(name, every)| {
                (final_sample || accepted_step % *every == 0)
                    && self.accepted_step_field_last_sample.get(name) != Some(&accepted_step)
            })
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>();
        for name in &due {
            self.accepted_step_field_last_sample
                .insert(name.clone(), accepted_step);
        }
        due
    }

    pub(crate) fn record_scalar(
        &mut self,
        stats: &StepStats,
    ) -> Result<ArtifactEnqueueMetrics, RunError> {
        if let Some(pipeline) = self.pipeline.as_ref() {
            return pipeline.push(ArtifactJob::ScalarRow(stats.clone()));
        }
        Ok(ArtifactEnqueueMetrics::default())
    }

    /// Retain one accepted solver step for the LLG diagnostics artifacts.
    ///
    /// This is deliberately separate from [`record_scalar`]: output cadence
    /// may be sparse (or absent), while accepted-step telemetry must preserve
    /// every controller decision and its attempt records.
    pub(crate) fn record_solver_step(&mut self, stats: &StepStats) {
        self.observe_physics_execution();
        self.solver_steps.push(stats.clone());
    }

    pub(crate) fn record_cpu_adaptive_attempts(&mut self, batch: CpuAdaptiveAttemptBatch) {
        self.cpu_adaptive_attempts.push(batch);
    }

    pub(crate) fn publish_terminal_cpu_adaptive_attempts(
        &mut self,
        batch: CpuAdaptiveAttemptBatch,
    ) -> Result<(), RunError> {
        if let Some(pipeline) = self.pipeline.as_ref() {
            pipeline.publish_terminal_cpu_adaptive_attempts(batch)?;
        }
        Ok(())
    }

    pub(crate) fn observe_physics_execution(&mut self) {
        if let Some(context) = self.physics_execution_context.as_ref() {
            context.observe_workflow(&mut self.provenance);
        }
    }

    pub(crate) fn observe_energy_evaluation(&mut self) {
        if let Some(context) = self.physics_execution_context.as_ref() {
            context.observe_energy_evaluation(&mut self.provenance);
        }
    }

    pub(crate) fn take_solver_steps(&mut self) -> Vec<StepStats> {
        let mut batches = std::mem::take(&mut self.cpu_adaptive_attempts)
            .into_iter()
            .peekable();
        for step in &mut self.solver_steps {
            if batches
                .peek()
                .is_some_and(|batch| batch.target_step == step.step)
            {
                batches
                    .next()
                    .expect("peeked adaptive attempt batch")
                    .materialize_into(&mut step.solver_attempts);
            }
        }
        assert!(
            batches.next().is_none(),
            "CPU adaptive attempt batch has no matching accepted solver step"
        );
        std::mem::take(&mut self.solver_steps)
    }

    /// Replaces runtime provenance after a run has measured counters that are
    /// unavailable before the first step. Existing queued field snapshots keep
    /// their immutable capture-time provenance.
    #[cfg(any(feature = "cuda", feature = "fem-gpu", test))]
    pub(crate) fn update_provenance(&mut self, provenance: ExecutionProvenance) {
        self.provenance = provenance;
    }

    pub(crate) fn provenance_snapshot(&self) -> ExecutionProvenance {
        self.provenance.clone()
    }

    pub(crate) fn replace_provenance_synchronously(
        &mut self,
        provenance: ExecutionProvenance,
    ) -> Result<(), RunError> {
        if let Some(pipeline) = self.pipeline.as_ref() {
            pipeline.update_provenance(provenance.clone())?;
        }
        self.provenance = provenance;
        Ok(())
    }

    #[cfg(any(feature = "cuda", test))]
    pub(crate) fn publish_failed_run_provenance(
        &mut self,
        primary: &RunError,
    ) -> Result<(), RunError> {
        if let Some(pipeline) = self.pipeline.as_ref() {
            pipeline
                .publish_failed_run_provenance(self.provenance.clone(), primary.message.clone())?;
        }
        Ok(())
    }

    #[cfg(any(feature = "cuda", feature = "fem-gpu"))]
    pub(crate) fn is_streaming(&self) -> bool {
        self.pipeline.is_some()
    }

    pub(crate) fn record_field_snapshot(
        &mut self,
        snapshot: FieldSnapshot,
    ) -> Result<ArtifactEnqueueMetrics, RunError> {
        let mut metrics = ArtifactEnqueueMetrics::default();
        if let Some(pipeline) = self.pipeline.as_ref() {
            metrics = pipeline.push(ArtifactJob::FieldSnapshot {
                snapshot,
                provenance: self.provenance.clone(),
            })?;
        } else {
            self.field_snapshots.push(snapshot);
        }
        self.field_snapshot_count += 1;
        Ok(metrics)
    }

    #[cfg(feature = "cuda")]
    pub(crate) fn record_native_field_snapshot(
        &mut self,
        snapshot: NativeFdmFieldSnapshot,
    ) -> Result<ArtifactEnqueueMetrics, RunError> {
        let Some(pipeline) = self.pipeline.as_ref() else {
            return Err(RunError {
                message: "native CUDA field snapshots require the streaming artifact pipeline"
                    .to_string(),
            });
        };
        let metrics = pipeline.push(ArtifactJob::NativeFieldSnapshot {
            snapshot,
            provenance: self.provenance.clone(),
        })?;
        self.field_snapshot_count += 1;
        Ok(metrics)
    }

    #[cfg(feature = "fem-gpu")]
    pub(crate) fn record_native_fem_field_snapshot(
        &mut self,
        snapshot: NativeFemFieldSnapshot,
    ) -> Result<ArtifactEnqueueMetrics, RunError> {
        let Some(pipeline) = self.pipeline.as_ref() else {
            return Err(RunError {
                message: "native FEM field snapshots require the streaming artifact pipeline"
                    .to_string(),
            });
        };
        let metrics = pipeline.push(ArtifactJob::NativeFemFieldSnapshot {
            snapshot,
            provenance: self.provenance.clone(),
        })?;
        self.field_snapshot_count += 1;
        Ok(metrics)
    }

    pub(crate) fn finish(self) -> (Vec<FieldSnapshot>, usize, ExecutionProvenance) {
        (
            self.field_snapshots,
            self.field_snapshot_count,
            self.provenance,
        )
    }
}

#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeSnapshotScalarType {
    #[allow(dead_code)]
    F32,
    F64,
}

#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
#[derive(Debug, Clone, Copy)]
struct NativeVectorSnapshotInfo {
    cell_count: usize,
    component_count: usize,
    scalar_bytes: usize,
    scalar_type: NativeSnapshotScalarType,
}

#[cfg(feature = "cuda")]
impl From<NativeFieldSnapshotInfo> for NativeVectorSnapshotInfo {
    fn from(info: NativeFieldSnapshotInfo) -> Self {
        Self {
            cell_count: info.cell_count,
            component_count: info.component_count,
            scalar_bytes: info.scalar_bytes,
            scalar_type: match info.scalar_type {
                NativeFieldSnapshotScalarType::F32 => NativeSnapshotScalarType::F32,
                NativeFieldSnapshotScalarType::F64 => NativeSnapshotScalarType::F64,
            },
        }
    }
}

#[cfg(feature = "fem-gpu")]
impl From<NativeFemFieldSnapshotInfo> for NativeVectorSnapshotInfo {
    fn from(info: NativeFemFieldSnapshotInfo) -> Self {
        Self {
            cell_count: info.node_count,
            component_count: info.component_count,
            scalar_bytes: info.scalar_bytes,
            scalar_type: NativeSnapshotScalarType::F64,
        }
    }
}

#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
struct ZarrFieldSeriesWriter {
    root_dir: PathBuf,
    zarray_path: PathBuf,
    info: NativeVectorSnapshotInfo,
    component_order: String,
    location: String,
    scope: String,
    sample_count: usize,
    samples_writer: BufWriter<File>,
}

#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
impl ZarrFieldSeriesWriter {
    fn open(
        fields_dir: &Path,
        context: &FieldArtifactContext,
        provenance: &ExecutionProvenance,
        observable: &str,
        info: NativeVectorSnapshotInfo,
        component_order: impl Into<String>,
        location: impl Into<String>,
        scope: impl Into<String>,
    ) -> Result<Self, String> {
        let component_order = component_order.into();
        let location = location.into();
        let scope = scope.into();
        let root_dir = fields_dir.join(format!("{observable}.zarr"));
        fs::create_dir_all(&root_dir).map_err(|error| {
            format!(
                "failed to create Zarr field store '{}': {}",
                root_dir.display(),
                error
            )
        })?;

        let zattrs_path = root_dir.join(".zattrs");
        let component_order_json = if info.component_count == 1 {
            serde_json::json!(["scalar"])
        } else if component_order == "xyz" {
            serde_json::json!(["x", "y", "z"])
        } else {
            serde_json::Value::String(component_order.clone())
        };
        fs::write(
            &zattrs_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "observable": observable,
                "unit": field_unit(observable),
                "axes": ["sample", "component", "cell"],
                "component_count": info.component_count,
                "component_order": component_order_json,
                "storage_layout": "soa_component_major",
                "location": location,
                "scope": scope,
                "sample_index_file": "samples.csv",
                "layout": context.layout.clone(),
                "provenance": crate::artifacts::artifact_provenance_json(context, provenance),
            }))
            .map_err(|error| format!("failed to serialize Zarr attrs: {}", error))?,
        )
        .map_err(|error| {
            format!(
                "failed to write Zarr attrs '{}': {}",
                zattrs_path.display(),
                error
            )
        })?;

        let samples_path = root_dir.join("samples.csv");
        let mut samples_writer = BufWriter::new(File::create(&samples_path).map_err(|error| {
            format!(
                "failed to create Zarr sample index '{}': {}",
                samples_path.display(),
                error
            )
        })?);
        writeln!(
            samples_writer,
            "sample,step,time,solver_dt,chunk_key,dtype,scalar_bytes,cell_count"
        )
        .map_err(|error| {
            format!(
                "failed to initialize Zarr sample index '{}': {}",
                samples_path.display(),
                error
            )
        })?;

        let mut writer = Self {
            zarray_path: root_dir.join(".zarray"),
            root_dir,
            info,
            component_order,
            location,
            scope,
            sample_count: 0,
            samples_writer,
        };
        writer.write_zarray_metadata()?;
        Ok(writer)
    }

    fn update_provenance(
        &self,
        context: &FieldArtifactContext,
        provenance: &ExecutionProvenance,
    ) -> Result<(), String> {
        let path = self.root_dir.join(".zattrs");
        let mut attrs: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).map_err(|error| {
                format!("failed to read Zarr attrs '{}': {error}", path.display())
            })?)
            .map_err(|error| {
                format!("failed to decode Zarr attrs '{}': {error}", path.display())
            })?;
        attrs["provenance"] = crate::artifacts::artifact_provenance_json(context, provenance);
        crate::autosave_zarr::write_json_atomic(&path, &attrs)
            .map_err(|error| format!("failed to update Zarr attrs '{}': {error}", path.display()))
    }

    #[cfg(feature = "cuda")]
    fn append_fdm_snapshot(&mut self, snapshot: &mut NativeFdmFieldSnapshot) -> Result<(), String> {
        let info = snapshot
            .info()
            .map_err(|error| format!("failed to query CUDA snapshot info: {}", error.message))?;
        let name = snapshot.name.clone();
        self.append_payload(
            name.as_str(),
            snapshot.step,
            snapshot.time,
            snapshot.solver_dt,
            info.into(),
            |writer| {
                snapshot
                    .write_payload(writer)
                    .map(|_| ())
                    .map_err(|error| error.message)
            },
        )
    }

    #[cfg(feature = "fem-gpu")]
    fn append_fem_snapshot(&mut self, snapshot: &mut NativeFemFieldSnapshot) -> Result<(), String> {
        let info = snapshot.info().map_err(|error| {
            format!(
                "failed to query native FEM snapshot info: {}",
                error.message
            )
        })?;
        let name = snapshot.name.clone();
        self.append_payload(
            name.as_str(),
            snapshot.step,
            snapshot.time,
            snapshot.solver_dt,
            info.into(),
            |writer| {
                snapshot
                    .write_payload(writer)
                    .map(|_| ())
                    .map_err(|error| error.message)
            },
        )
    }

    fn append_field_snapshot(&mut self, snapshot: &FieldSnapshot) -> Result<(), String> {
        let component_count = usize::from(snapshot.component_count);
        let cell_count = snapshot.sample_count();
        let info = NativeVectorSnapshotInfo {
            cell_count,
            component_count,
            scalar_bytes: std::mem::size_of::<f64>(),
            scalar_type: NativeSnapshotScalarType::F64,
        };
        if snapshot.component_order != self.component_order
            || snapshot.location != self.location
            || snapshot.scope != self.scope
        {
            return Err(format!(
                "inconsistent Zarr snapshot metadata for '{}'",
                snapshot.name
            ));
        }
        self.append_payload(
            &snapshot.name,
            snapshot.step,
            snapshot.time,
            snapshot.solver_dt,
            info,
            |writer| {
                for component in 0..component_count {
                    for cell in 0..cell_count {
                        writer
                            .write_all(
                                &snapshot.values[cell * component_count + component].to_le_bytes(),
                            )
                            .map_err(|error| error.to_string())?;
                    }
                }
                Ok(())
            },
        )
    }

    fn append_payload<F>(
        &mut self,
        snapshot_name: &str,
        step: u64,
        time: f64,
        solver_dt: f64,
        info: NativeVectorSnapshotInfo,
        write_payload: F,
    ) -> Result<(), String>
    where
        F: FnOnce(&mut BufWriter<File>) -> Result<(), String>,
    {
        if info.cell_count != self.info.cell_count
            || info.component_count != self.info.component_count
            || info.scalar_bytes != self.info.scalar_bytes
            || info.scalar_type != self.info.scalar_type
        {
            return Err(format!(
                "inconsistent Zarr snapshot payload for '{}'",
                snapshot_name
            ));
        }

        let chunk_key = format!("{}.0.0", self.sample_count);
        let chunk_path = self.root_dir.join(&chunk_key);
        let mut chunk_file = BufWriter::new(File::create(&chunk_path).map_err(|error| {
            format!(
                "failed to create Zarr chunk '{}': {}",
                chunk_path.display(),
                error
            )
        })?);
        write_payload(&mut chunk_file)?;
        chunk_file.flush().map_err(|error| {
            format!(
                "failed to flush Zarr chunk '{}': {}",
                chunk_path.display(),
                error
            )
        })?;

        writeln!(
            self.samples_writer,
            "{},{},{:.15e},{:.15e},{},{},{},{}",
            self.sample_count,
            step,
            time,
            solver_dt,
            chunk_key,
            zarr_dtype(self.info.scalar_type),
            self.info.scalar_bytes,
            self.info.cell_count
        )
        .map_err(|error| {
            format!(
                "failed to append Zarr sample index '{}': {}",
                self.root_dir.join("samples.csv").display(),
                error
            )
        })?;

        self.sample_count += 1;
        self.write_zarray_metadata()?;
        Ok(())
    }

    fn last_chunk_values_f64(&self) -> Result<Vec<f64>, String> {
        let sample_index = self
            .sample_count
            .checked_sub(1)
            .ok_or_else(|| "native Zarr writer has no completed sample".to_string())?;
        let bytes = fs::read(self.root_dir.join(format!("{sample_index}.0.0")))
            .map_err(|error| error.to_string())?;
        if self.info.scalar_bytes == 0 || bytes.len() % self.info.scalar_bytes != 0 {
            return Err("native field snapshot chunk has invalid byte length".into());
        }
        match self.info.scalar_type {
            NativeSnapshotScalarType::F64 => bytes
                .chunks_exact(8)
                .map(|chunk| {
                    <[u8; 8]>::try_from(chunk)
                        .map(f64::from_le_bytes)
                        .map_err(|_| "invalid f64 snapshot chunk".to_string())
                })
                .collect(),
            NativeSnapshotScalarType::F32 => bytes
                .chunks_exact(4)
                .map(|chunk| {
                    <[u8; 4]>::try_from(chunk)
                        .map(|bytes| f32::from_le_bytes(bytes) as f64)
                        .map_err(|_| "invalid f32 snapshot chunk".to_string())
                })
                .collect(),
        }
    }

    fn write_zarray_metadata(&mut self) -> Result<(), String> {
        fs::write(
            &self.zarray_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "zarr_format": 2,
                "shape": [self.sample_count, self.info.component_count, self.info.cell_count],
                "chunks": [1, self.info.component_count, self.info.cell_count],
                "dtype": zarr_dtype(self.info.scalar_type),
                "compressor": serde_json::Value::Null,
                "fill_value": 0.0,
                "order": "C",
                "filters": serde_json::Value::Null,
                "dimension_separator": ".",
            }))
            .map_err(|error| format!("failed to serialize Zarr metadata: {}", error))?,
        )
        .map_err(|error| {
            format!(
                "failed to write Zarr metadata '{}': {}",
                self.zarray_path.display(),
                error
            )
        })
    }
}

#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
fn zarr_dtype(scalar_type: NativeSnapshotScalarType) -> &'static str {
    match scalar_type {
        NativeSnapshotScalarType::F32 => "<f4",
        NativeSnapshotScalarType::F64 => "<f8",
    }
}

fn writer_loop(
    output_dir: &Path,
    autosave_root: &Path,
    field_context: FieldArtifactContext,
    rx: mpsc::Receiver<ArtifactJob>,
    queue_depth: Arc<AtomicUsize>,
    diagnostics: Arc<ArtifactPipelineDiagnosticsState>,
    stage_autosave_config: Option<StageAutosavePipelineConfig>,
    field_storage: FieldArtifactStorage,
) -> Result<ArtifactPipelineSummary, String> {
    fs::create_dir_all(output_dir)
        .map_err(|error| format!("failed to prepare output directory: {}", error))?;

    let scalars_path = output_dir.join("scalars.csv");
    let fields_dir = output_dir.join("fields");
    fs::write(
        output_dir.join("field-storage.v1.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": "fullmag_field_storage.v1",
            "storage": match field_storage {
                FieldArtifactStorage::Json => "json_snapshot_files",
                FieldArtifactStorage::Zarr => "zarr_v2_uncompressed",
            },
            "authoritative": true,
        }))
        .map_err(|error| format!("failed to serialize field storage metadata: {error}"))?,
    )
    .map_err(|error| format!("failed to write field storage metadata: {error}"))?;
    let mut summary = ArtifactPipelineSummary {
        autosave_root: stage_autosave_config
            .as_ref()
            .map(|_| autosave_root.to_path_buf()),
        ..ArtifactPipelineSummary::default()
    };
    let mut scalar_writer: Option<BufWriter<File>> = None;
    let mut stage_autosave = stage_autosave_config
        .map(|config| StageAutosaveRuntime::new(autosave_root, config))
        .transpose()?;
    #[cfg(any(feature = "cuda", feature = "fem-gpu"))]
    let mut zarr_writers: HashMap<String, ZarrFieldSeriesWriter> = HashMap::new();

    for job in rx {
        queue_depth
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |depth| {
                Some(depth.saturating_sub(1))
            })
            .ok();
        diagnostics.current_queue_depth.store(
            queue_depth.load(Ordering::Relaxed) as u64,
            Ordering::Relaxed,
        );
        match job {
            ArtifactJob::ScalarRow(stats) => {
                let job_start = std::time::Instant::now();
                if scalar_writer.is_none() {
                    let file = File::create(&scalars_path).map_err(|error| {
                        format!(
                            "failed to create scalar trace '{}': {}",
                            scalars_path.display(),
                            error
                        )
                    })?;
                    let mut writer = BufWriter::new(file);
                    write_scalars_csv_header(&mut writer).map_err(|error| {
                        format!(
                            "failed to write scalar trace header '{}': {}",
                            scalars_path.display(),
                            error
                        )
                    })?;
                    scalar_writer = Some(writer);
                }
                write_scalar_row(
                    scalar_writer
                        .as_mut()
                        .expect("scalar writer initialized before row write"),
                    &stats,
                )
                .map_err(|error| {
                    format!(
                        "failed to append scalar trace row to '{}': {}",
                        scalars_path.display(),
                        error
                    )
                })?;
                if let Some(runtime) = stage_autosave.as_mut() {
                    runtime.append_scalar(&stats)?;
                }
                summary.scalar_rows_written += 1;
                record_writer_job_time(
                    &mut summary,
                    &diagnostics,
                    ArtifactWriterJobKind::ScalarRow,
                    job_start.elapsed(),
                );
            }
            ArtifactJob::FieldSnapshot {
                snapshot,
                provenance,
            } => {
                let job_start = std::time::Instant::now();
                match field_storage {
                    FieldArtifactStorage::Json => {
                        write_field_snapshot_artifact(
                            &fields_dir,
                            &field_context,
                            &provenance,
                            &snapshot,
                        )
                        .map_err(|error| {
                            format!(
                                "failed to write field snapshot '{}' step {}: {}",
                                snapshot.name, snapshot.step, error
                            )
                        })?;
                    }
                    FieldArtifactStorage::Zarr => {
                        #[cfg(any(feature = "cuda", feature = "fem-gpu"))]
                        {
                            let info = NativeVectorSnapshotInfo {
                                cell_count: snapshot.sample_count(),
                                component_count: usize::from(snapshot.component_count),
                                scalar_bytes: std::mem::size_of::<f64>(),
                                scalar_type: NativeSnapshotScalarType::F64,
                            };
                            let writer = zarr_writers.entry(snapshot.name.clone()).or_insert(
                                ZarrFieldSeriesWriter::open(
                                    &fields_dir,
                                    &field_context,
                                    &provenance,
                                    &snapshot.name,
                                    info,
                                    snapshot.component_order.clone(),
                                    snapshot.location.clone(),
                                    snapshot.scope.clone(),
                                )?,
                            );
                            writer.append_field_snapshot(&snapshot)?;
                        }
                        #[cfg(not(any(feature = "cuda", feature = "fem-gpu")))]
                        {
                            return Err(
                                "Zarr field artifacts require a native CUDA or FEM-GPU build"
                                    .into(),
                            );
                        }
                    }
                }
                if let Some(runtime) = stage_autosave.as_mut() {
                    match field_storage {
                        FieldArtifactStorage::Json => runtime.append_field(&snapshot)?,
                        FieldArtifactStorage::Zarr => {
                            #[cfg(any(feature = "cuda", feature = "fem-gpu"))]
                            if let Some(writer) = zarr_writers.get(&snapshot.name) {
                                let values = writer.last_chunk_values_f64()?;
                                runtime.append_field_values(
                                    &snapshot.name,
                                    snapshot.step,
                                    snapshot.time,
                                    snapshot.solver_dt,
                                    &values,
                                )?;
                            }
                        }
                    }
                }
                summary.field_snapshots_written += 1;
                record_writer_job_time(
                    &mut summary,
                    &diagnostics,
                    ArtifactWriterJobKind::FieldSnapshot,
                    job_start.elapsed(),
                );
            }
            #[cfg(feature = "cuda")]
            ArtifactJob::NativeFieldSnapshot {
                mut snapshot,
                provenance,
            } => {
                let job_start = std::time::Instant::now();
                let info = snapshot.info().map_err(|error| {
                    format!("failed to query CUDA snapshot info: {}", error.message)
                })?;
                let writer = zarr_writers.entry(snapshot.name.clone()).or_insert(
                    ZarrFieldSeriesWriter::open(
                        &fields_dir,
                        &field_context,
                        &provenance,
                        &snapshot.name,
                        info.into(),
                        "xyz",
                        "sample",
                        "full",
                    )?,
                );
                writer.append_fdm_snapshot(&mut snapshot)?;
                if let Some(runtime) = stage_autosave.as_mut() {
                    let values = writer.last_chunk_values_f64()?;
                    runtime.append_field_values(
                        &snapshot.name,
                        snapshot.step,
                        snapshot.time,
                        snapshot.solver_dt,
                        &values,
                    )?;
                }
                summary.field_snapshots_written += 1;
                record_writer_job_time(
                    &mut summary,
                    &diagnostics,
                    ArtifactWriterJobKind::NativeFieldSnapshot,
                    job_start.elapsed(),
                );
            }
            #[cfg(feature = "fem-gpu")]
            ArtifactJob::NativeFemFieldSnapshot {
                mut snapshot,
                provenance,
            } => {
                let job_start = std::time::Instant::now();
                let info = snapshot.info().map_err(|error| {
                    format!(
                        "failed to query native FEM snapshot info: {}",
                        error.message
                    )
                })?;
                let writer = zarr_writers.entry(snapshot.name.clone()).or_insert(
                    ZarrFieldSeriesWriter::open(
                        &fields_dir,
                        &field_context,
                        &provenance,
                        &snapshot.name,
                        info.into(),
                        "xyz",
                        "node",
                        "full",
                    )?,
                );
                writer.append_fem_snapshot(&mut snapshot)?;
                if let Some(runtime) = stage_autosave.as_mut() {
                    let values = writer.last_chunk_values_f64()?;
                    runtime.append_field_values(
                        &snapshot.name,
                        snapshot.step,
                        snapshot.time,
                        snapshot.solver_dt,
                        &values,
                    )?;
                }
                summary.field_snapshots_written += 1;
                record_writer_job_time(
                    &mut summary,
                    &diagnostics,
                    ArtifactWriterJobKind::NativeFieldSnapshot,
                    job_start.elapsed(),
                );
            }
            #[cfg(any(feature = "cuda", test))]
            ArtifactJob::FailedRunProvenance {
                provenance,
                primary_error,
                acknowledgement,
            } => {
                let result =
                    write_failed_run_provenance_atomic(output_dir, &provenance, &primary_error);
                let _ = acknowledgement.send(result);
            }
            ArtifactJob::TerminalCpuAdaptiveAttempts {
                batch,
                acknowledgement,
            } => {
                let result = write_terminal_cpu_adaptive_attempts(output_dir, &batch);
                let _ = acknowledgement.send(result);
            }
            ArtifactJob::UpdateProvenance {
                provenance,
                acknowledgement,
            } => {
                let artifact_provenance =
                    crate::artifacts::artifact_provenance_json(&field_context, &provenance);
                let result = (|| -> Result<(), String> {
                    #[cfg(any(feature = "cuda", feature = "fem-gpu"))]
                    for writer in zarr_writers.values() {
                        writer.update_provenance(&field_context, &provenance)?;
                    }
                    if let Some(runtime) = stage_autosave.as_mut() {
                        runtime.update_provenance(&artifact_provenance)?;
                    }
                    Ok(())
                })();
                let _ = acknowledgement.send(result);
            }
            ArtifactJob::Shutdown => break,
        }
    }

    if let Some(mut writer) = scalar_writer {
        writer.flush().map_err(|error| {
            format!(
                "failed to flush scalar trace '{}': {}",
                scalars_path.display(),
                error
            )
        })?;
    }

    #[cfg(any(feature = "cuda", feature = "fem-gpu"))]
    for (observable, writer) in &mut zarr_writers {
        writer.samples_writer.flush().map_err(|error| {
            format!(
                "failed to flush Zarr sample index for '{}': {}",
                observable, error
            )
        })?;
    }

    if let Some(runtime) = stage_autosave {
        runtime.finish()?;
    }

    Ok(summary)
}

impl StageAutosaveWriter {
    fn update_provenance(&mut self, provenance: &serde_json::Value) -> Result<(), String> {
        match self {
            Self::Zarr(writer) => writer.update_provenance(provenance),
            Self::Txt(_) => Ok(()),
            #[cfg(feature = "stage-autosave-hdf5")]
            Self::Hdf5(_) => Ok(()),
        }
    }
}

#[cfg(any(feature = "cuda", test))]
fn write_failed_run_provenance_atomic(
    output_dir: &Path,
    provenance: &ExecutionProvenance,
    primary_error: &str,
) -> Result<(), String> {
    static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let final_path = output_dir.join("failed-run-provenance.v1.json");
    let temporary_path = output_dir.join(format!(
        ".failed-run-provenance.v1.json.{}.{}.tmp",
        std::process::id(),
        TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let payload = serde_json::to_vec_pretty(&serde_json::json!({
        "schema_version": "fullmag_failed_run_provenance.v1",
        "primary_error": primary_error,
        "execution_provenance": provenance,
    }))
    .map_err(|error| format!("failed to serialize failed-run provenance: {error}"))?;
    let result = (|| -> Result<(), String> {
        let file = File::create(&temporary_path).map_err(|error| {
            format!(
                "failed to create temporary failed-run provenance '{}': {error}",
                temporary_path.display()
            )
        })?;
        let mut writer = BufWriter::new(file);
        writer
            .write_all(&payload)
            .map_err(|error| format!("failed to write failed-run provenance: {error}"))?;
        writer
            .write_all(b"\n")
            .map_err(|error| format!("failed to terminate failed-run provenance: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("failed to flush failed-run provenance: {error}"))?;
        writer
            .get_ref()
            .sync_all()
            .map_err(|error| format!("failed to sync failed-run provenance: {error}"))?;
        fs::rename(&temporary_path, &final_path).map_err(|error| {
            format!(
                "failed to atomically publish failed-run provenance '{}': {error}",
                final_path.display()
            )
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn write_terminal_cpu_adaptive_attempts(
    output_dir: &Path,
    batch: &CpuAdaptiveAttemptBatch,
) -> Result<(), String> {
    let path = output_dir.join("solver_attempts.csv");
    let write_header = fs::metadata(&path)
        .map(|meta| meta.len() == 0)
        .unwrap_or(true);
    let file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("failed to open '{}': {error}", path.display()))?;
    let mut attempts = BufWriter::new(file);
    if write_header {
        writeln!(attempts, "attempt,target_step,t_s,dt_attempt_s,eta,max_norm_defect,max_spin_rotation_rad,decision,reason,dt_next_s,demag_solves,demag_iterations,demag_residual,rhs_evals,estimator_order,adaptive_controller_policy_version,error_norm_type,active_node_count,active_measure,normalization_denominator,max_scaled_error,weighted_rms_error")
            .map_err(|error| format!("failed to write '{}': {error}", path.display()))?;
    }
    for record in &batch.records[..batch.count] {
        let decision = adaptive_attempt_decision_name(record.decision);
        let reason = adaptive_attempt_reason_name(record.reason);
        let demag_solves = if batch.enable_demag {
            record.rhs_evals
        } else {
            0
        };
        writeln!(
            attempts,
            "{},{},{:.17e},{:.17e},{:.17e},,,{},{},{:.17e},{},0,{:.17e},{},{},{},,,,,,",
            record.attempt,
            batch.target_step,
            batch.time,
            record.dt_attempt,
            record.normalized_error,
            decision,
            reason,
            record.dt_next,
            demag_solves,
            0.0,
            record.rhs_evals,
            batch.estimator_order,
            record.controller_policy_version,
        )
        .map_err(|error| format!("failed to write '{}': {error}", path.display()))?;
    }
    attempts
        .flush()
        .map_err(|error| format!("failed to flush '{}': {error}", path.display()))?;
    attempts
        .get_ref()
        .sync_all()
        .map_err(|error| format!("failed to sync '{}': {error}", path.display()))
}

enum ArtifactWriterJobKind {
    ScalarRow,
    FieldSnapshot,
    #[cfg(any(feature = "cuda", feature = "fem-gpu"))]
    NativeFieldSnapshot,
}

fn record_writer_job_time(
    summary: &mut ArtifactPipelineSummary,
    diagnostics: &ArtifactPipelineDiagnosticsState,
    kind: ArtifactWriterJobKind,
    duration: std::time::Duration,
) {
    let wall_time_ns = duration.as_nanos().min(u128::from(u64::MAX)) as u64;
    summary.writer_jobs_completed = summary.writer_jobs_completed.saturating_add(1);
    summary.artifact_writer_job_wall_time_ns = summary
        .artifact_writer_job_wall_time_ns
        .saturating_add(wall_time_ns);
    diagnostics
        .writer_jobs_completed
        .fetch_add(1, Ordering::Relaxed);
    diagnostics
        .artifact_writer_job_wall_time_ns
        .fetch_add(wall_time_ns, Ordering::Relaxed);
    match kind {
        ArtifactWriterJobKind::ScalarRow => {
            summary.scalar_row_writer_wall_time_ns = summary
                .scalar_row_writer_wall_time_ns
                .saturating_add(wall_time_ns);
            diagnostics
                .scalar_row_writer_wall_time_ns
                .fetch_add(wall_time_ns, Ordering::Relaxed);
        }
        ArtifactWriterJobKind::FieldSnapshot => {
            summary.field_snapshot_writer_wall_time_ns = summary
                .field_snapshot_writer_wall_time_ns
                .saturating_add(wall_time_ns);
            diagnostics
                .field_snapshot_writer_wall_time_ns
                .fetch_add(wall_time_ns, Ordering::Relaxed);
        }
        #[cfg(any(feature = "cuda", feature = "fem-gpu"))]
        ArtifactWriterJobKind::NativeFieldSnapshot => {
            summary.native_field_snapshot_writer_wall_time_ns = summary
                .native_field_snapshot_writer_wall_time_ns
                .saturating_add(wall_time_ns);
            diagnostics
                .native_field_snapshot_writer_wall_time_ns
                .fetch_add(wall_time_ns, Ordering::Relaxed);
        }
    }
}

fn update_atomic_max(target: &AtomicU64, value: u64) {
    let mut current = target.load(Ordering::Relaxed);
    while value > current {
        match target.compare_exchange_weak(current, value, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(next) => current = next,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn flat_field_snapshot_estimate_counts_each_stored_scalar_once() {
        let job = ArtifactJob::FieldSnapshot {
            snapshot: FieldSnapshot::new(
                "spin_current_tensor",
                0,
                0.0,
                0.0,
                9,
                "row_major_Q_ia",
                "node",
                "full",
                1,
                vec![0.0; 18],
            )
            .expect("valid flat tensor snapshot"),
            provenance: ExecutionProvenance::default(),
        };

        assert_eq!(
            job.estimated_bytes(),
            18 * std::mem::size_of::<f64>() as u64
        );
    }

    #[test]
    fn failed_run_provenance_is_durable_without_success_finish() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-failed-run-provenance-{}-{unique}",
            std::process::id()
        ));
        let context = FieldArtifactContext {
            problem_name: "failed-fdm-gpu-run".into(),
            ir_version: "v0".into(),
            source_hash: None,
            execution_mode: fullmag_ir::ExecutionMode::Strict,
            layout: serde_json::json!({"kind": "fdm", "cell_count": 1}),
            execution_resolution: None,
        };
        let pipeline = ArtifactPipeline::start(output_dir.clone(), context, 2)
            .expect("start artifact pipeline");
        let mut provenance = ExecutionProvenance {
            execution_engine: "cuda_fdm".into(),
            precision: "double".into(),
            ..ExecutionProvenance::default()
        };
        provenance.fdm_gpu_execution_receipt = Some(
            crate::types::FdmGpuExecutionReceipt::strict_unvalidated("double"),
        );
        let mut recorder = ArtifactRecorder::streaming(provenance, pipeline.sender());
        let primary = RunError {
            message: "injected failure after create/step".into(),
        };

        recorder
            .publish_failed_run_provenance(&primary)
            .expect("failed-run provenance publication");
        drop(recorder);
        drop(pipeline);

        let document: serde_json::Value = serde_json::from_slice(
            &fs::read(output_dir.join("failed-run-provenance.v1.json"))
                .expect("durable failed-run provenance"),
        )
        .expect("valid failed-run provenance JSON");
        assert_eq!(
            document["schema_version"],
            "fullmag_failed_run_provenance.v1"
        );
        assert_eq!(document["primary_error"], primary.message);
        assert_eq!(
            document["execution_provenance"]["fdm_gpu_execution_receipt"]["validation_state"],
            "unvalidated"
        );
        for success_marker in ["metadata.json", "manifest.json", "run-result.json"] {
            assert!(
                !output_dir.join(success_marker).exists(),
                "failed-run publication must not create {success_marker}"
            );
        }
        fs::remove_dir_all(output_dir).expect("remove failed-run fixture");
    }

    fn isolated_pipeline_sender(
        tx: SyncSender<ArtifactJob>,
        initial_depth: usize,
    ) -> ArtifactPipelineSender {
        ArtifactPipelineSender {
            tx,
            queue_depth: Arc::new(AtomicUsize::new(initial_depth)),
            diagnostics: Arc::new(ArtifactPipelineDiagnosticsState::default()),
            physics_execution_context: None,
            #[cfg(feature = "fem-gpu")]
            accepted_step_fields: Arc::new(Vec::new()),
        }
    }

    fn terminal_attempt_batch(target_step: u64) -> CpuAdaptiveAttemptBatch {
        CpuAdaptiveAttemptBatch::new(
            &[AdaptiveAttemptRecord {
                controller_policy_version: fullmag_engine::FDM_ADAPTIVE_CONTROLLER_POLICY_VERSION,
                attempt: 1,
                dt_attempt: 1e-12,
                normalized_error: 2.0,
                decision: AdaptiveAttemptDecision::Failed,
                reason: AdaptiveAttemptReason::DtMinExhausted,
                dt_next: 1e-12,
                rhs_evals: 4,
            }],
            target_step,
            0.0,
            false,
            2,
        )
    }

    #[test]
    fn terminal_attempt_full_queue_timeout_rolls_back_depth() {
        let (tx, receiver) = mpsc::sync_channel(1);
        tx.send(ArtifactJob::Shutdown).expect("fill test queue");
        let sender = isolated_pipeline_sender(tx, 1);
        let error = sender
            .publish_terminal_cpu_adaptive_attempts_with_timeout(
                terminal_attempt_batch(1),
                Duration::from_millis(25),
            )
            .expect_err("full queue must time out");
        assert!(error.message.contains("timed out enqueueing"));
        assert_eq!(sender.queue_depth.load(Ordering::Relaxed), 1);
        assert_eq!(
            sender
                .diagnostics
                .current_queue_depth
                .load(Ordering::Relaxed),
            1
        );
        drop(receiver);
    }

    #[test]
    fn terminal_attempt_disconnected_queue_rolls_back_depth() {
        let (tx, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        let sender = isolated_pipeline_sender(tx, 0);
        let error = sender
            .publish_terminal_cpu_adaptive_attempts_with_timeout(
                terminal_attempt_batch(1),
                Duration::from_millis(25),
            )
            .expect_err("disconnected queue must fail");
        assert!(error
            .message
            .contains("before terminal solver attempts were queued"));
        assert_eq!(sender.queue_depth.load(Ordering::Relaxed), 0);
        assert_eq!(
            sender
                .diagnostics
                .current_queue_depth
                .load(Ordering::Relaxed),
            0
        );
    }

    #[test]
    fn terminal_attempt_stalled_ack_uses_remaining_deadline() {
        let (tx, receiver) = mpsc::sync_channel(1);
        let sender = isolated_pipeline_sender(tx, 0);
        let stalled = thread::spawn(move || {
            let job = receiver.recv().expect("receive terminal attempt job");
            thread::sleep(Duration::from_millis(75));
            drop(job);
        });
        let error = sender
            .publish_terminal_cpu_adaptive_attempts_with_timeout(
                terminal_attempt_batch(1),
                Duration::from_millis(25),
            )
            .expect_err("stalled acknowledgement must time out");
        assert!(error
            .message
            .contains("waiting for terminal solver attempts"));
        stalled.join().expect("stalled receiver exits");
    }

    #[test]
    fn recorder_materializes_multiple_adaptive_batches_in_step_order() {
        let mut recorder = ArtifactRecorder::in_memory(ExecutionProvenance::default());
        for step in 1..=2 {
            recorder.record_cpu_adaptive_attempts(terminal_attempt_batch(step));
            recorder.record_solver_step(&StepStats {
                step,
                time: step as f64 * 1e-12,
                dt: 1e-12,
                ..StepStats::default()
            });
        }

        let steps = recorder.take_solver_steps();

        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].solver_attempts[0].target_step, 1);
        assert_eq!(steps[1].solver_attempts[0].target_step, 2);
        assert_eq!(steps[0].solver_attempts[0].decision, "failed");
        assert_eq!(steps[1].solver_attempts[0].reason, "dt_min_exhausted");
    }

    #[test]
    #[should_panic(expected = "no matching accepted solver step")]
    fn recorder_rejects_unmatched_adaptive_batch_in_release_visible_path() {
        let mut recorder = ArtifactRecorder::in_memory(ExecutionProvenance::default());
        recorder.record_cpu_adaptive_attempts(terminal_attempt_batch(2));
        recorder.record_solver_step(&StepStats {
            step: 1,
            ..StepStats::default()
        });

        let _ = recorder.take_solver_steps();
    }

    #[test]
    fn failed_run_provenance_full_queue_obeys_one_bounded_deadline() {
        let (tx, receiver) = mpsc::sync_channel(1);
        tx.send(ArtifactJob::Shutdown).expect("fill test queue");
        let sender = isolated_pipeline_sender(tx, 1);
        let deadline = Duration::from_millis(25);
        let started = std::time::Instant::now();
        let error = sender
            .publish_failed_run_provenance_with_timeout(
                ExecutionProvenance::default(),
                "primary".into(),
                deadline,
            )
            .expect_err("full queue must time out without blocking forever");
        assert!(error.message.contains("timed out"));
        assert!(started.elapsed() < Duration::from_millis(250));
        drop(receiver);
    }

    #[test]
    fn failed_run_provenance_disconnected_queue_returns_immediately() {
        let (tx, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        let sender = isolated_pipeline_sender(tx, 0);
        let started = std::time::Instant::now();
        let error = sender
            .publish_failed_run_provenance_with_timeout(
                ExecutionProvenance::default(),
                "primary".into(),
                Duration::from_millis(100),
            )
            .expect_err("disconnected queue must fail");
        assert!(error.message.contains("unavailable"));
        assert!(started.elapsed() < Duration::from_millis(50));
    }

    #[test]
    fn provenance_update_full_queue_obeys_one_deadline() {
        let (tx, receiver) = mpsc::sync_channel(1);
        tx.send(ArtifactJob::Shutdown).expect("fill queue");
        let sender = isolated_pipeline_sender(tx, 1);
        let error = sender
            .update_provenance_with_timeout(
                ExecutionProvenance::default(),
                Duration::from_millis(25),
            )
            .expect_err("full queue must time out");
        assert!(error
            .message
            .contains("enqueueing artifact provenance update"));
        drop(receiver);
    }

    #[test]
    fn provenance_update_disconnected_queue_fails_without_waiting_for_ack() {
        let (tx, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        let sender = isolated_pipeline_sender(tx, 0);
        let error = sender
            .update_provenance_with_timeout(
                ExecutionProvenance::default(),
                Duration::from_millis(25),
            )
            .expect_err("disconnected queue must fail");
        assert!(error
            .message
            .contains("before provenance update was queued"));
    }

    #[test]
    fn provenance_update_stalled_ack_uses_remaining_deadline() {
        let (tx, receiver) = mpsc::sync_channel(1);
        let sender = isolated_pipeline_sender(tx, 0);
        let stalled = thread::spawn(move || {
            let job = receiver.recv().expect("receive update job");
            thread::sleep(Duration::from_millis(75));
            drop(job);
        });
        let error = sender
            .update_provenance_with_timeout(
                ExecutionProvenance::default(),
                Duration::from_millis(25),
            )
            .expect_err("stalled acknowledgement must time out");
        assert!(error
            .message
            .contains("waiting for artifact provenance update"));
        stalled.join().expect("stalled receiver exits");
    }

    #[test]
    fn recorder_streams_transport_scalar_vector_and_tensor_fields() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-transport-streaming-{}-{unique}",
            std::process::id()
        ));
        let context = FieldArtifactContext {
            problem_name: "transport".into(),
            ir_version: "v0".into(),
            source_hash: None,
            execution_mode: fullmag_ir::ExecutionMode::Strict,
            layout: serde_json::json!({"kind": "fem", "node_count": 2}),
            execution_resolution: None,
        };
        let mut pipeline = ArtifactPipeline::start(output_dir.clone(), context, 2)
            .expect("start artifact pipeline");
        let mut recorder = ArtifactRecorder::streaming(
            ExecutionProvenance {
                execution_engine: "fem_cpu_native".into(),
                precision: "double".into(),
                ..ExecutionProvenance::default()
            },
            pipeline.sender(),
        );
        for (name, components, order, values, revision) in [
            ("V_electric", 1, "scalar", vec![1.0, 0.0], 1),
            ("J_charge", 3, "xyz", vec![1.0; 6], 2),
            ("spin_current_tensor", 9, "row_major_Q_ia", vec![1.0; 18], 3),
        ] {
            recorder
                .record_field_snapshot(
                    FieldSnapshot::new(
                        name,
                        0,
                        0.0,
                        0.0,
                        components,
                        order,
                        "node",
                        "transport_module:spin:full_solve_domain",
                        revision,
                        values,
                    )
                    .expect("valid transport snapshot"),
                )
                .expect("enqueue transport snapshot");
        }
        assert_eq!(recorder.finish().1, 3);
        let summary = pipeline.finish().expect("finish artifact pipeline");
        assert_eq!(summary.field_snapshots_written, 3);
        for (name, components, unit) in [
            ("V_electric", 1, "V"),
            ("J_charge", 3, "A/m^2"),
            ("spin_current_tensor", 9, "A/m^2"),
        ] {
            let bytes = fs::read(
                output_dir
                    .join("fields")
                    .join(name)
                    .join("step_000000.json"),
            )
            .expect("streamed transport field");
            let payload: serde_json::Value =
                serde_json::from_slice(&bytes).expect("transport field JSON");
            assert_eq!(payload["component_count"], components);
            assert_eq!(payload["unit"], unit);
        }
        fs::remove_dir_all(output_dir).expect("remove transport artifact fixture");
    }

    #[cfg(feature = "cuda")]
    #[test]
    fn zarr_writer_preserves_regular_transport_snapshot_shape_and_soa_order() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let fields_dir = std::env::temp_dir().join(format!(
            "fullmag-transport-zarr-{}-{unique}",
            std::process::id()
        ));
        let context = FieldArtifactContext {
            problem_name: "transport-zarr".into(),
            ir_version: "v0".into(),
            source_hash: None,
            execution_mode: fullmag_ir::ExecutionMode::Strict,
            layout: serde_json::json!({"kind": "fdm", "grid": [2, 1, 1]}),
            execution_resolution: None,
        };
        let info = NativeVectorSnapshotInfo {
            cell_count: 2,
            component_count: 3,
            scalar_bytes: 8,
            scalar_type: NativeSnapshotScalarType::F64,
        };
        let mut writer = ZarrFieldSeriesWriter::open(
            &fields_dir,
            &context,
            &ExecutionProvenance::default(),
            "J_charge",
            info,
            "xyz",
            "sample",
            "full",
        )
        .expect("open Zarr writer");
        let snapshot = FieldSnapshot::new(
            "J_charge",
            4,
            2.0e-12,
            5.0e-15,
            3,
            "xyz",
            "sample",
            "full",
            5,
            vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
        )
        .expect("valid snapshot");
        writer
            .append_field_snapshot(&snapshot)
            .expect("append regular snapshot");
        writer.samples_writer.flush().expect("flush sample index");

        let payload = fs::read(fields_dir.join("J_charge.zarr/0.0.0")).expect("read chunk");
        let values = payload
            .chunks_exact(8)
            .map(|chunk| f64::from_le_bytes(chunk.try_into().expect("f64 chunk")))
            .collect::<Vec<_>>();
        assert_eq!(values, vec![1.0, 4.0, 2.0, 5.0, 3.0, 6.0]);
        let zattrs: serde_json::Value = serde_json::from_slice(
            &fs::read(fields_dir.join("J_charge.zarr/.zattrs")).expect("read zattrs"),
        )
        .expect("decode zattrs");
        assert_eq!(zattrs["storage_layout"], "soa_component_major");
        assert_eq!(
            zattrs["component_order"],
            serde_json::json!(["x", "y", "z"])
        );
        fs::remove_dir_all(fields_dir).expect("remove Zarr fixture");
    }

    #[test]
    fn streaming_field_metadata_captures_exact_ids_after_owner_observation() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-exact-physics-streaming-{}-{unique}",
            std::process::id()
        ));
        let field_context = FieldArtifactContext {
            problem_name: "exact-physics-streaming".into(),
            ir_version: "v0".into(),
            source_hash: None,
            execution_mode: fullmag_ir::ExecutionMode::Strict,
            layout: serde_json::json!({"kind": "fdm", "grid": [1, 1, 1]}),
            execution_resolution: None,
        };
        let execution_context =
            crate::physics_graph_execution::PhysicsGraphExecutionContext::from_exact_ids_for_test(
                ["torque:strip"],
            );
        let mut pipeline = ArtifactPipeline::start_with_physics_execution_context(
            output_dir.clone(),
            field_context,
            2,
            execution_context,
        )
        .expect("start artifact pipeline");
        let mut recorder =
            ArtifactRecorder::streaming(ExecutionProvenance::default(), pipeline.sender());

        recorder.observe_physics_execution();
        recorder
            .record_field_snapshot(
                FieldSnapshot::new(
                    "m",
                    1,
                    1.0e-13,
                    1.0e-13,
                    3,
                    "xyz",
                    "cell",
                    "full",
                    1,
                    vec![1.0, 0.0, 0.0],
                )
                .expect("valid field snapshot"),
            )
            .expect("enqueue field snapshot");
        let (_, _, provenance) = recorder.finish();
        assert_eq!(provenance.executed_physics_module_ids, vec!["torque:strip"]);
        pipeline.finish().expect("finish artifact pipeline");

        let bytes = fs::read(output_dir.join("fields/m/step_000001.json"))
            .expect("streamed field metadata");
        let payload: serde_json::Value =
            serde_json::from_slice(&bytes).expect("field artifact JSON");
        assert_eq!(
            payload["provenance"]["executed_physics_module_ids"],
            serde_json::json!(["torque:strip"])
        );
        let request = || crate::types::ExecutionRequestProvenance {
            backend: "fdm".into(),
            device: "cpu".into(),
            precision: "double".into(),
            mode: "strict".into(),
        };
        let resolution = crate::types::FinalExecutionResolutionProvenance {
            authored_request: request(),
            effective_request: request(),
            resolved_execution: request(),
            resolution_mode: "exact".into(),
            fallback_occurred: false,
            fallback_reason: None,
        };
        crate::artifacts::finalize_streamed_artifact_provenance(&output_dir, &resolution)
            .expect("finalize streamed execution provenance");
        let finalized: serde_json::Value = serde_json::from_slice(
            &fs::read(output_dir.join("fields/m/step_000001.json"))
                .expect("read finalized field metadata"),
        )
        .expect("decode finalized field artifact");
        assert_eq!(
            finalized["provenance"]["execution_resolution"],
            serde_json::to_value(resolution).expect("serialize execution resolution")
        );
        fs::remove_dir_all(output_dir).expect("remove exact physics fixture");
    }

    #[test]
    fn separate_stage_autosave_root_is_recorded_for_final_provenance() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-autosave-provenance-output-{}-{unique}",
            std::process::id()
        ));
        let autosave_root = std::env::temp_dir().join(format!(
            "fullmag-autosave-provenance-root-{}-{unique}",
            std::process::id()
        ));
        let field_context = FieldArtifactContext {
            problem_name: "autosave-provenance".into(),
            ir_version: "v0".into(),
            source_hash: None,
            execution_mode: fullmag_ir::ExecutionMode::Strict,
            layout: serde_json::json!({"kind": "fdm", "grid": [1, 1, 1]}),
            execution_resolution: None,
        };
        let stage_autosave = StageAutosavePipelineConfig {
            stage_id: "relax".into(),
            policy: fullmag_ir::StageAutosaveIR {
                kind: "stage_autosave".into(),
                target: "state".into(),
                layout: fullmag_ir::AutosaveLayoutIR::Separate,
                format: fullmag_ir::AutosaveFormatIR::Zarr,
                table: None,
                fields: vec![fullmag_ir::FieldAutosaveIR {
                    kind: "field_autosave".into(),
                    quantity: "m".into(),
                    every_seconds: None,
                    sample_period_policy: None,
                    every_steps: Some(1),
                }],
            },
        };
        let mut pipeline = ArtifactPipeline::start_with_stage_autosave_roots(
            output_dir.clone(),
            autosave_root.clone(),
            field_context,
            2,
            Some(stage_autosave),
            None,
        )
        .expect("start artifact pipeline");
        let mut recorder =
            ArtifactRecorder::streaming(ExecutionProvenance::default(), pipeline.sender());
        recorder
            .record_field_snapshot(
                FieldSnapshot::new(
                    "m",
                    1,
                    1.0e-13,
                    1.0e-13,
                    3,
                    "xyz",
                    "cell",
                    "full",
                    1,
                    vec![1.0, 0.0, 0.0],
                )
                .expect("valid field snapshot"),
            )
            .expect("enqueue field snapshot");
        let summary = pipeline.finish().expect("finish artifact pipeline");
        assert_eq!(summary.autosave_root, Some(autosave_root.clone()));

        let request = || crate::types::ExecutionRequestProvenance {
            backend: "fdm".into(),
            device: "cpu".into(),
            precision: "double".into(),
            mode: "strict".into(),
        };
        let resolution = crate::types::FinalExecutionResolutionProvenance {
            authored_request: request(),
            effective_request: request(),
            resolved_execution: request(),
            resolution_mode: "exact".into(),
            fallback_occurred: false,
            fallback_reason: None,
        };
        crate::artifacts::finalize_stage_autosave_provenance(&autosave_root, &resolution)
            .expect("finalize separate stage autosave provenance");

        let root_zattrs: serde_json::Value = serde_json::from_slice(
            &fs::read(autosave_root.join("state.zarr/.zattrs")).expect("read root zattrs"),
        )
        .expect("decode root zattrs");
        let stage_manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(autosave_root.join("state.zarr/stages/stage_0000_relax/manifest.json"))
                .expect("read stage manifest"),
        )
        .expect("decode stage manifest");
        let field_zattrs: serde_json::Value = serde_json::from_slice(
            &fs::read(autosave_root.join("state.zarr/stages/stage_0000_relax/fields/m/.zattrs"))
                .expect("read field zattrs"),
        )
        .expect("decode field zattrs");
        let expected = serde_json::to_value(&resolution).expect("serialize resolution");
        assert_eq!(root_zattrs["provenance"]["execution_resolution"], expected);
        assert_eq!(
            stage_manifest["provenance"]["execution_resolution"],
            serde_json::to_value(&resolution).expect("serialize resolution")
        );
        assert_eq!(
            field_zattrs["provenance"]["execution_resolution"],
            serde_json::to_value(&resolution).expect("serialize resolution")
        );
        fs::remove_dir_all(output_dir).expect("remove autosave output fixture");
        fs::remove_dir_all(autosave_root).expect("remove autosave provenance fixture");
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn streaming_capture_writes_fem_gpu_receipt_to_field_zattrs() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-fem-receipt-stream-output-{}-{unique}",
            std::process::id()
        ));
        let autosave_root = std::env::temp_dir().join(format!(
            "fullmag-fem-receipt-stream-autosave-{}-{unique}",
            std::process::id()
        ));
        let context = FieldArtifactContext {
            problem_name: "fem-receipt-stream".into(),
            ir_version: "v0".into(),
            source_hash: None,
            execution_mode: fullmag_ir::ExecutionMode::Strict,
            layout: serde_json::json!({"kind": "fem", "node_count": 1}),
            execution_resolution: None,
        };
        let stage_autosave = StageAutosavePipelineConfig {
            stage_id: "relax".into(),
            policy: fullmag_ir::StageAutosaveIR {
                kind: "stage_autosave".into(),
                target: "state".into(),
                layout: fullmag_ir::AutosaveLayoutIR::Separate,
                format: fullmag_ir::AutosaveFormatIR::Zarr,
                table: None,
                fields: vec![fullmag_ir::FieldAutosaveIR {
                    kind: "field_autosave".into(),
                    quantity: "m".into(),
                    every_seconds: None,
                    sample_period_policy: None,
                    every_steps: Some(1),
                }],
            },
        };
        let mut pipeline = ArtifactPipeline::start_with_stage_autosave_roots(
            output_dir.clone(),
            autosave_root.clone(),
            context.clone(),
            2,
            Some(stage_autosave),
            None,
        )
        .expect("start streaming pipeline");
        let mut recorder =
            ArtifactRecorder::streaming(ExecutionProvenance::default(), pipeline.sender());
        let receipt = crate::types::FemGpuExecutionReceipt {
            requested: "strict_device".into(),
            resolved: "device_resident".into(),
            executed: "cuda_fem".into(),
            execution_class: crate::types::FemGpuExecutionClass::DeviceResident,
            device_ordinal: 0,
            precision: "double".into(),
            integrator: "heun".into(),
            required_operator_mask: 0x3ff,
            resolved_device_operator_mask: 0x3ff,
            resolved_host_operator_mask: 0,
            resolved_unknown_operator_mask: 0,
            executed_device_operator_mask: 0x3ff,
            executed_host_operator_mask: 0,
            executed_unknown_operator_mask: 0,
            fallback_count: 0,
            accepted_step_count: 1,
            rejected_attempt_count: 0,
            failed_attempt_count: 0,
            hot_loop_compute_h2d_bytes: 0,
            hot_loop_compute_d2h_bytes: 0,
            hot_loop_compute_host_sync_count: 0,
            accounting_valid: true,
        };
        recorder
            .record_field_snapshot(
                FieldSnapshot::new(
                    "m",
                    1,
                    1.0e-13,
                    1.0e-13,
                    3,
                    "xyz",
                    "node",
                    "full",
                    1,
                    vec![1.0, 0.0, 0.0],
                )
                .expect("valid FEM snapshot"),
            )
            .expect("enqueue accepted FEM snapshot before receipt");
        let mut final_provenance = recorder.provenance_snapshot();
        final_provenance.fem_gpu_execution_receipt = Some(receipt.clone());
        recorder
            .replace_provenance_synchronously(final_provenance)
            .expect("update already-open stores before terminal capture");
        recorder
            .record_field_snapshot(
                FieldSnapshot::new(
                    "m",
                    2,
                    2.0e-13,
                    1.0e-13,
                    3,
                    "xyz",
                    "node",
                    "full",
                    2,
                    vec![0.0, 1.0, 0.0],
                )
                .expect("valid terminal FEM snapshot"),
            )
            .expect("enqueue terminal FEM snapshot after receipt update");
        let expected_full_provenance =
            crate::artifacts::artifact_provenance_json(&context, &recorder.provenance_snapshot());
        drop(recorder);
        pipeline.finish().expect("finish streaming pipeline");

        let zattrs: serde_json::Value = serde_json::from_slice(
            &fs::read(autosave_root.join("state.zarr/stages/stage_0000_relax/fields/m/.zattrs"))
                .expect("read streamed FEM field zattrs"),
        )
        .expect("decode streamed FEM field zattrs");
        let root_zattrs: serde_json::Value = serde_json::from_slice(
            &fs::read(autosave_root.join("state.zarr/.zattrs"))
                .expect("read existing autosave root zattrs"),
        )
        .expect("decode existing autosave root zattrs");
        let stage_manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(autosave_root.join("state.zarr/stages/stage_0000_relax/manifest.json"))
                .expect("read finished stage manifest"),
        )
        .expect("decode finished stage manifest");
        assert_eq!(root_zattrs["provenance"], expected_full_provenance);
        assert_eq!(stage_manifest["provenance"], root_zattrs["provenance"]);
        assert_eq!(zattrs["provenance"], root_zattrs["provenance"]);
        assert_eq!(
            zattrs["provenance"]["fem_gpu_execution_receipt"],
            serde_json::to_value(receipt).expect("serialize FEM receipt")
        );
        assert_eq!(
            root_zattrs["provenance"]["fem_gpu_execution_receipt"],
            zattrs["provenance"]["fem_gpu_execution_receipt"]
        );
        fs::remove_dir_all(output_dir).expect("remove streaming output fixture");
        fs::remove_dir_all(autosave_root).expect("remove streaming autosave fixture");
    }
}
