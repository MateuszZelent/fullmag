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
#[cfg(feature = "cuda")]
use crate::fdm::gpu::cuda::native::{
    NativeFdmFieldSnapshot, NativeFieldSnapshotInfo, NativeFieldSnapshotScalarType,
};
#[cfg(feature = "fem-gpu")]
use crate::native_fem::{NativeFemFieldSnapshot, NativeFemFieldSnapshotInfo};
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
}

impl ArtifactPipeline {
    pub(crate) fn start(
        output_dir: PathBuf,
        field_context: FieldArtifactContext,
        capacity: usize,
    ) -> Result<Self, RunError> {
        fs::create_dir_all(&output_dir).map_err(|error| RunError {
            message: format!(
                "failed to create artifact output directory '{}': {}",
                output_dir.display(),
                error
            ),
        })?;
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
                    field_context,
                    rx,
                    writer_queue_depth,
                    writer_diagnostics,
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
}

impl ArtifactRecorder {
    pub(crate) fn in_memory(provenance: ExecutionProvenance) -> Self {
        Self {
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            pipeline: None,
            provenance,
        }
    }

    pub(crate) fn streaming(
        provenance: ExecutionProvenance,
        pipeline: ArtifactPipelineSender,
    ) -> Self {
        Self {
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            pipeline: Some(pipeline),
            provenance,
        }
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
                "provenance": {
                    "problem_name": context.problem_name.clone(),
                    "ir_version": context.ir_version.clone(),
                    "source_hash": context.source_hash.clone(),
                    "execution_mode": context.execution_mode,
                    "execution_engine": provenance.execution_engine.clone(),
                    "precision": provenance.precision.clone(),
                },
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
    field_context: FieldArtifactContext,
    rx: mpsc::Receiver<ArtifactJob>,
    queue_depth: Arc<AtomicUsize>,
    diagnostics: Arc<ArtifactPipelineDiagnosticsState>,
) -> Result<ArtifactPipelineSummary, String> {
    fs::create_dir_all(output_dir)
        .map_err(|error| format!("failed to prepare output directory: {}", error))?;

    let scalars_path = output_dir.join("scalars.csv");
    let fields_dir = output_dir.join("fields");
    let mut summary = ArtifactPipelineSummary::default();
    let mut scalar_writer: Option<BufWriter<File>> = None;
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
