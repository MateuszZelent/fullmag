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
use crate::types::{ExecutionProvenance, FieldSnapshot, RunError, StepStats};

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

pub(crate) const DEFAULT_ARTIFACT_PIPELINE_CAPACITY: usize = 4;

#[derive(Debug, Clone, Default)]
pub(crate) struct ArtifactPipelineSummary {
    pub scalar_rows_written: usize,
    pub field_snapshots_written: usize,
    pub writer_jobs_completed: usize,
    pub artifact_writer_job_wall_time_ns: u64,
    pub scalar_row_writer_wall_time_ns: u64,
    pub field_snapshot_writer_wall_time_ns: u64,
    pub native_field_snapshot_writer_wall_time_ns: u64,
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
    Shutdown,
}

impl ArtifactJob {
    fn estimated_bytes(&self) -> u64 {
        match self {
            ArtifactJob::ScalarRow(_) => std::mem::size_of::<StepStats>() as u64,
            ArtifactJob::FieldSnapshot { snapshot, .. } => snapshot
                .values
                .len()
                .saturating_mul(3)
                .saturating_mul(std::mem::size_of::<f64>())
                as u64,
            #[cfg(feature = "cuda")]
            ArtifactJob::NativeFieldSnapshot { .. } => 0,
            #[cfg(feature = "fem-gpu")]
            ArtifactJob::NativeFemFieldSnapshot { .. } => 0,
            ArtifactJob::Shutdown => 0,
        }
    }
}

#[derive(Clone)]
pub(crate) struct ArtifactPipelineSender {
    tx: SyncSender<ArtifactJob>,
    queue_depth: Arc<AtomicUsize>,
    diagnostics: Arc<ArtifactPipelineDiagnosticsState>,
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
}

pub(crate) struct ArtifactPipeline {
    tx: Option<SyncSender<ArtifactJob>>,
    handle: Option<JoinHandle<Result<ArtifactPipelineSummary, String>>>,
    queue_depth: Arc<AtomicUsize>,
    diagnostics: Arc<ArtifactPipelineDiagnosticsState>,
    #[cfg(feature = "fem-gpu")]
    accepted_step_fields: Arc<Vec<(String, u64)>>,
}

impl ArtifactPipeline {
    pub(crate) fn start_for_problem(
        problem: &fullmag_ir::ProblemIR,
        output_dir: PathBuf,
        field_context: FieldArtifactContext,
        capacity: usize,
    ) -> Result<Self, RunError> {
        Self::start_for_problem_with_autosave_root(
            problem,
            output_dir.clone(),
            output_dir,
            field_context,
            capacity,
        )
    }

    pub(crate) fn start_for_problem_with_autosave_root(
        problem: &fullmag_ir::ProblemIR,
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
        Self::start_with_stage_autosave_roots(
            output_dir,
            autosave_root,
            field_context,
            capacity,
            stage_autosave,
        )
    }

    #[cfg(test)]
    fn start_with_stage_autosave(
        output_dir: PathBuf,
        field_context: FieldArtifactContext,
        capacity: usize,
        stage_autosave: Option<StageAutosavePipelineConfig>,
    ) -> Result<Self, RunError> {
        Self::start_with_stage_autosave_roots(
            output_dir.clone(),
            output_dir,
            field_context,
            capacity,
            stage_autosave,
        )
    }

    fn start_with_stage_autosave_roots(
        output_dir: PathBuf,
        autosave_root: PathBuf,
        field_context: FieldArtifactContext,
        capacity: usize,
        stage_autosave: Option<StageAutosavePipelineConfig>,
    ) -> Result<Self, RunError> {
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
            policy
                .table
                .as_ref()
                .map(|table| table.quantities.clone())
                .unwrap_or_default(),
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
        let values = snapshot
            .values
            .iter()
            .flat_map(|value| value.iter().copied())
            .collect::<Vec<_>>();
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
    pipeline: Option<ArtifactPipelineSender>,
    provenance: ExecutionProvenance,
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
            pipeline: None,
            provenance,
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
        Self {
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            pipeline: Some(pipeline),
            provenance,
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

    /// Replaces runtime provenance after a run has measured counters that are
    /// unavailable before the first step. Existing queued field snapshots keep
    /// their immutable capture-time provenance.
    pub(crate) fn update_provenance(&mut self, provenance: ExecutionProvenance) {
        self.provenance = provenance;
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
    ) -> Result<Self, String> {
        let root_dir = fields_dir.join(format!("{observable}.zarr"));
        fs::create_dir_all(&root_dir).map_err(|error| {
            format!(
                "failed to create Zarr field store '{}': {}",
                root_dir.display(),
                error
            )
        })?;

        let zattrs_path = root_dir.join(".zattrs");
        let component_order = if info.component_count == 1 {
            serde_json::json!(["scalar"])
        } else {
            serde_json::json!(["x", "y", "z"])
        };
        fs::write(
            &zattrs_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "observable": observable,
                "unit": field_unit(observable),
                "axes": ["sample", "component", "cell"],
                "component_order": component_order,
                "storage_layout": "soa_component_major",
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
            sample_count: 0,
            samples_writer,
        };
        writer.write_zarray_metadata()?;
        Ok(writer)
    }

    #[cfg(feature = "cuda")]
    fn append_fdm_snapshot(&mut self, snapshot: &mut NativeFdmFieldSnapshot) -> Result<(), String> {
        let info = snapshot
            .info()
            .map_err(|error| format!("failed to query CUDA snapshot info: {}", error.message))?;
        let name = snapshot.name.clone();
        self.append_native_payload(
            name.as_str(),
            snapshot.step,
            snapshot.time,
            snapshot.solver_dt,
            info.into(),
            |writer| snapshot.write_payload(writer).map(|_| ()),
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
        self.append_native_payload(
            name.as_str(),
            snapshot.step,
            snapshot.time,
            snapshot.solver_dt,
            info.into(),
            |writer| snapshot.write_payload(writer).map(|_| ()),
        )
    }

    fn append_native_payload<F>(
        &mut self,
        snapshot_name: &str,
        step: u64,
        time: f64,
        solver_dt: f64,
        info: NativeVectorSnapshotInfo,
        write_payload: F,
    ) -> Result<(), String>
    where
        F: FnOnce(&mut BufWriter<File>) -> Result<(), RunError>,
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
        write_payload(&mut chunk_file).map_err(|error| error.message)?;
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
) -> Result<ArtifactPipelineSummary, String> {
    fs::create_dir_all(output_dir)
        .map_err(|error| format!("failed to prepare output directory: {}", error))?;

    let scalars_path = output_dir.join("scalars.csv");
    let fields_dir = output_dir.join("fields");
    let mut summary = ArtifactPipelineSummary::default();
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
                write_field_snapshot_artifact(&fields_dir, &field_context, &provenance, &snapshot)
                    .map_err(|error| {
                        format!(
                            "failed to write field snapshot '{}' step {}: {}",
                            snapshot.name, snapshot.step, error
                        )
                    })?;
                if let Some(runtime) = stage_autosave.as_mut() {
                    runtime.append_field(&snapshot)?;
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
mod stage_autosave_tests {
    use super::*;

    fn context() -> FieldArtifactContext {
        FieldArtifactContext {
            problem_name: "autosave-test".into(),
            ir_version: fullmag_ir::IR_VERSION.into(),
            source_hash: None,
            execution_mode: fullmag_ir::ExecutionMode::Strict,
            layout: serde_json::json!({}),
        }
    }

    fn policy(format: &str, fields: serde_json::Value) -> fullmag_ir::StageAutosaveIR {
        serde_json::from_value(serde_json::json!({
            "kind": "stage_autosave",
            "target": "main",
            "layout": "continuous",
            "format": format,
            "table": {"every_steps": 2, "quantities": ["step", "mx"]},
            "fields": fields
        }))
        .unwrap()
    }

    #[cfg(any(feature = "cuda", feature = "fem-gpu"))]
    #[test]
    fn zarr_field_attrs_preserve_optional_mfem_version() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-zarr-mfem-provenance-{}",
            uuid::Uuid::new_v4()
        ));
        let mut provenance = ExecutionProvenance {
            mfem_version: Some("4.9".into()),
            ..ExecutionProvenance::default()
        };
        let info = NativeVectorSnapshotInfo {
            cell_count: 1,
            component_count: 3,
            scalar_bytes: 8,
            scalar_type: NativeSnapshotScalarType::F64,
        };

        ZarrFieldSeriesWriter::open(&root, &context(), &provenance, "m", info)
            .expect("Zarr attrs must be created");
        let attrs: serde_json::Value = serde_json::from_slice(
            &fs::read(root.join("m.zarr/.zattrs")).expect("Zarr attrs must be readable"),
        )
        .expect("Zarr attrs must be valid JSON");
        assert_eq!(attrs["provenance"]["mfem_version"], "4.9");

        provenance.mfem_version = None;
        ZarrFieldSeriesWriter::open(&root, &context(), &provenance, "H_eff", info)
            .expect("Zarr attrs without MFEM identity must be created");
        let attrs: serde_json::Value = serde_json::from_slice(
            &fs::read(root.join("H_eff.zarr/.zattrs")).expect("Zarr attrs must be readable"),
        )
        .expect("Zarr attrs must be valid JSON");
        assert!(!attrs["provenance"]
            .as_object()
            .expect("Zarr provenance must be an object")
            .contains_key("mfem_version"));

        fs::remove_dir_all(root).expect("Zarr test directory must be removable");
    }

    #[test]
    fn stage_autosave_jobs_are_bounded_and_finish_drains_terminal_relax_state() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-artifact-pipeline-autosave-{}",
            uuid::Uuid::new_v4()
        ));
        let mut pipeline = ArtifactPipeline::start_with_stage_autosave(
            root.clone(),
            context(),
            1,
            Some(StageAutosavePipelineConfig {
                stage_id: "relax".into(),
                policy: policy("zarr", serde_json::json!([])),
            }),
        )
        .unwrap();
        let provenance = ExecutionProvenance::default();
        let mut recorder = ArtifactRecorder::streaming(provenance, pipeline.sender());
        for step in 0..=3 {
            let metrics = recorder
                .record_scalar(&StepStats {
                    step,
                    mx: step as f64,
                    ..StepStats::default()
                })
                .unwrap();
            assert!(metrics.queue_depth_after <= 2);
        }
        let _ = recorder.finish();
        pipeline.finish().unwrap();

        let store = root.join("main.zarr");
        let index = crate::autosave_zarr::read_logical_index(&store).unwrap();
        assert_eq!(
            index
                .iter()
                .map(|entry| match entry.coordinate {
                    StageSampleCoordinate::AcceptedStep { accepted_step } => accepted_step,
                    _ => panic!("Relax autosave must preserve accepted-step coordinates"),
                })
                .collect::<Vec<_>>(),
            [0, 2, 3]
        );
        let manifest: StageManifest = serde_json::from_slice(
            &fs::read(store.join("stages/stage_0000_relax/manifest.json")).unwrap(),
        )
        .unwrap();
        assert!(manifest.complete);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn consecutive_stage_pipelines_share_autosave_root_without_mixing_stage_artifacts() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-artifact-pipeline-shared-autosave-{}",
            uuid::Uuid::new_v4()
        ));
        let autosave_root = root.join("artifacts");
        for (stage_index, stage_id) in ["relax", "run"].into_iter().enumerate() {
            let stage_output = root.join(format!("stage-{stage_index}"));
            let mut pipeline = ArtifactPipeline::start_with_stage_autosave_roots(
                stage_output.clone(),
                autosave_root.clone(),
                context(),
                1,
                Some(StageAutosavePipelineConfig {
                    stage_id: stage_id.into(),
                    policy: policy("zarr", serde_json::json!([])),
                }),
            )
            .unwrap();
            let mut recorder =
                ArtifactRecorder::streaming(ExecutionProvenance::default(), pipeline.sender());
            recorder
                .record_scalar(&StepStats {
                    step: stage_index as u64,
                    mx: stage_index as f64,
                    ..StepStats::default()
                })
                .unwrap();
            let _ = recorder.finish();
            pipeline.finish().unwrap();
            assert!(stage_output.join("scalars.csv").is_file());
        }

        let manifest: crate::autosave_storage::AutosaveArtifactManifest =
            serde_json::from_slice(&fs::read(autosave_root.join("main.autosave.json")).unwrap())
                .unwrap();
        assert_eq!(
            manifest
                .stages
                .iter()
                .map(|stage| (stage.stage_index, stage.stage_id.as_str()))
                .collect::<Vec<_>>(),
            [(0, "relax"), (1, "run")]
        );
        assert_eq!(
            crate::autosave_zarr::read_logical_index(&autosave_root.join("main.zarr"))
                .unwrap()
                .iter()
                .map(|entry| entry.target_sample_index)
                .collect::<Vec<_>>(),
            [0, 1]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stage_autosave_writer_failure_is_returned_by_pipeline_finish() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-artifact-pipeline-autosave-error-{}",
            uuid::Uuid::new_v4()
        ));
        let mut pipeline = ArtifactPipeline::start_with_stage_autosave(
            root.clone(),
            context(),
            1,
            Some(StageAutosavePipelineConfig {
                stage_id: "run".into(),
                policy: policy(
                    "txt",
                    serde_json::json!([{"quantity": "m", "every_steps": 1}]),
                ),
            }),
        )
        .unwrap();
        let error = pipeline
            .finish()
            .expect_err("writer failure must propagate");
        assert!(error.message.contains("scalar tables only"));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn accepted_step_field_capture_schedule_includes_initial_due_and_final_once() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-artifact-pipeline-field-schedule-{}",
            uuid::Uuid::new_v4()
        ));
        let mut pipeline = ArtifactPipeline::start_with_stage_autosave(
            root.clone(),
            context(),
            1,
            Some(StageAutosavePipelineConfig {
                stage_id: "relax".into(),
                policy: policy(
                    "zarr",
                    serde_json::json!([{"quantity": "m", "every_steps": 2}]),
                ),
            }),
        )
        .unwrap();
        let mut recorder =
            ArtifactRecorder::streaming(ExecutionProvenance::default(), pipeline.sender());
        assert_eq!(recorder.due_accepted_step_fields(0, false), ["m"]);
        assert!(recorder.due_accepted_step_fields(1, false).is_empty());
        assert_eq!(recorder.due_accepted_step_fields(2, false), ["m"]);
        assert!(recorder.due_accepted_step_fields(2, true).is_empty());
        assert_eq!(recorder.due_accepted_step_fields(3, true), ["m"]);
        drop(recorder);
        pipeline.finish().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn accepted_step_operator_fields_include_step0_and_forced_step1_once() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-artifact-pipeline-step0-operator-fields-{}",
            uuid::Uuid::new_v4()
        ));
        let mut pipeline = ArtifactPipeline::start_with_stage_autosave(
            root.clone(),
            context(),
            1,
            Some(StageAutosavePipelineConfig {
                stage_id: "relax".into(),
                policy: policy(
                    "zarr",
                    serde_json::json!([
                        {"quantity": "H_ex", "every_steps": 50_000},
                        {"quantity": "H_demag", "every_steps": 50_000},
                        {"quantity": "H_eff", "every_steps": 50_000}
                    ]),
                ),
            }),
        )
        .unwrap();
        let mut recorder =
            ArtifactRecorder::streaming(ExecutionProvenance::default(), pipeline.sender());
        assert_eq!(
            recorder.due_accepted_step_fields(0, false),
            ["H_demag", "H_eff", "H_ex"]
        );
        assert!(recorder.due_accepted_step_fields(1, false).is_empty());
        assert_eq!(
            recorder.due_accepted_step_fields(1, true),
            ["H_demag", "H_eff", "H_ex"]
        );
        assert!(recorder.due_accepted_step_fields(1, true).is_empty());
        drop(recorder);
        pipeline.finish().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
