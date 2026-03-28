//! Buffered asynchronous artifact streaming for long-running solver outputs.
//!
//! Public `run_problem*` entry points use this pipeline to move large field
//! snapshots off the hot simulation path as early as possible. The channel is
//! bounded, so the solver gets back-pressure instead of unbounded RAM growth if
//! disk I/O falls behind.

#[cfg(feature = "cuda")]
use crate::artifacts::field_unit;
use crate::artifacts::{
    write_field_file, write_scalar_row, write_scalars_csv_header, FieldArtifactContext,
};
#[cfg(feature = "cuda")]
use crate::native_fdm::{
    NativeFdmFieldSnapshot, NativeFieldSnapshotInfo, NativeFieldSnapshotScalarType,
};
use crate::types::{ExecutionProvenance, FieldSnapshot, RunError, StepStats};

#[cfg(feature = "cuda")]
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, SyncSender};
use std::thread::{self, JoinHandle};

pub(crate) const DEFAULT_ARTIFACT_PIPELINE_CAPACITY: usize = 4;

#[derive(Debug, Clone, Default)]
pub(crate) struct ArtifactPipelineSummary {
    pub scalar_rows_written: usize,
    pub field_snapshots_written: usize,
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
    Shutdown,
}

#[derive(Clone)]
pub(crate) struct ArtifactPipelineSender {
    tx: SyncSender<ArtifactJob>,
}

impl ArtifactPipelineSender {
    fn push(&self, job: ArtifactJob) -> Result<(), RunError> {
        self.tx.send(job).map_err(|_| RunError {
            message: "artifact writer thread became unavailable while streaming solver outputs"
                .to_string(),
        })
    }
}

pub(crate) struct ArtifactPipeline {
    tx: Option<SyncSender<ArtifactJob>>,
    handle: Option<JoinHandle<Result<ArtifactPipelineSummary, String>>>,
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
        let (tx, rx) = mpsc::sync_channel::<ArtifactJob>(capacity.max(1));
        let handle = thread::Builder::new()
            .name("fullmag-artifact-writer".into())
            .spawn(move || writer_loop(&output_dir, field_context, rx))
            .map_err(|error| RunError {
                message: format!("failed to spawn artifact writer thread: {}", error),
            })?;

        Ok(Self {
            tx: Some(tx),
            handle: Some(handle),
        })
    }

    pub(crate) fn sender(&self) -> ArtifactPipelineSender {
        ArtifactPipelineSender {
            tx: self
                .tx
                .as_ref()
                .expect("artifact pipeline sender requested after finish")
                .clone(),
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

    pub(crate) fn record_scalar(&mut self, stats: &StepStats) -> Result<(), RunError> {
        if let Some(pipeline) = self.pipeline.as_ref() {
            pipeline.push(ArtifactJob::ScalarRow(stats.clone()))?;
        }
        Ok(())
    }

    #[cfg(feature = "cuda")]
    pub(crate) fn is_streaming(&self) -> bool {
        self.pipeline.is_some()
    }

    pub(crate) fn record_field_snapshot(
        &mut self,
        snapshot: FieldSnapshot,
    ) -> Result<(), RunError> {
        if let Some(pipeline) = self.pipeline.as_ref() {
            pipeline.push(ArtifactJob::FieldSnapshot {
                snapshot,
                provenance: self.provenance.clone(),
            })?;
        } else {
            self.field_snapshots.push(snapshot);
        }
        self.field_snapshot_count += 1;
        Ok(())
    }

    #[cfg(feature = "cuda")]
    pub(crate) fn record_native_field_snapshot(
        &mut self,
        snapshot: NativeFdmFieldSnapshot,
    ) -> Result<(), RunError> {
        let Some(pipeline) = self.pipeline.as_ref() else {
            return Err(RunError {
                message: "native CUDA field snapshots require the streaming artifact pipeline"
                    .to_string(),
            });
        };
        pipeline.push(ArtifactJob::NativeFieldSnapshot {
            snapshot,
            provenance: self.provenance.clone(),
        })?;
        self.field_snapshot_count += 1;
        Ok(())
    }

    pub(crate) fn finish(self) -> (Vec<FieldSnapshot>, usize, ExecutionProvenance) {
        (
            self.field_snapshots,
            self.field_snapshot_count,
            self.provenance,
        )
    }
}

#[cfg(feature = "cuda")]
struct ZarrFieldSeriesWriter {
    root_dir: PathBuf,
    zarray_path: PathBuf,
    info: NativeFieldSnapshotInfo,
    sample_count: usize,
    samples_writer: BufWriter<File>,
}

#[cfg(feature = "cuda")]
impl ZarrFieldSeriesWriter {
    fn open(
        fields_dir: &Path,
        context: &FieldArtifactContext,
        provenance: &ExecutionProvenance,
        observable: &str,
        info: NativeFieldSnapshotInfo,
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
        fs::write(
            &zattrs_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "observable": observable,
                "unit": field_unit(observable),
                "axes": ["sample", "component", "cell"],
                "component_order": ["x", "y", "z"],
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

    fn append_snapshot(&mut self, snapshot: &mut NativeFdmFieldSnapshot) -> Result<(), String> {
        let info = snapshot
            .info()
            .map_err(|error| format!("failed to query CUDA snapshot info: {}", error.message))?;
        if info.cell_count != self.info.cell_count
            || info.component_count != self.info.component_count
            || info.scalar_bytes != self.info.scalar_bytes
            || info.scalar_type != self.info.scalar_type
        {
            return Err(format!(
                "inconsistent Zarr snapshot payload for '{}'",
                snapshot.name
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
        snapshot
            .write_payload(&mut chunk_file)
            .map_err(|error| error.message)?;
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
            snapshot.step,
            snapshot.time,
            snapshot.solver_dt,
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

#[cfg(feature = "cuda")]
fn zarr_dtype(scalar_type: NativeFieldSnapshotScalarType) -> &'static str {
    match scalar_type {
        NativeFieldSnapshotScalarType::F32 => "<f4",
        NativeFieldSnapshotScalarType::F64 => "<f8",
    }
}

fn writer_loop(
    output_dir: &Path,
    field_context: FieldArtifactContext,
    rx: mpsc::Receiver<ArtifactJob>,
) -> Result<ArtifactPipelineSummary, String> {
    fs::create_dir_all(output_dir)
        .map_err(|error| format!("failed to prepare output directory: {}", error))?;

    let scalars_path = output_dir.join("scalars.csv");
    let fields_dir = output_dir.join("fields");
    let mut summary = ArtifactPipelineSummary::default();
    let mut scalar_writer: Option<BufWriter<File>> = None;
    #[cfg(feature = "cuda")]
    let mut zarr_writers: HashMap<String, ZarrFieldSeriesWriter> = HashMap::new();

    for job in rx {
        match job {
            ArtifactJob::ScalarRow(stats) => {
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
            }
            ArtifactJob::FieldSnapshot {
                snapshot,
                provenance,
            } => {
                let observable_dir = fields_dir.join(&snapshot.name);
                fs::create_dir_all(&observable_dir).map_err(|error| {
                    format!(
                        "failed to create field snapshot directory '{}': {}",
                        observable_dir.display(),
                        error
                    )
                })?;
                let snapshot_path = observable_dir.join(format!("step_{:06}.json", snapshot.step));
                write_field_file(
                    &snapshot_path,
                    &field_context,
                    &provenance,
                    &snapshot.name,
                    snapshot.step,
                    snapshot.time,
                    snapshot.solver_dt,
                    &snapshot.values,
                )
                .map_err(|error| {
                    format!(
                        "failed to write field snapshot '{}': {}",
                        snapshot_path.display(),
                        error
                    )
                })?;
                summary.field_snapshots_written += 1;
            }
            #[cfg(feature = "cuda")]
            ArtifactJob::NativeFieldSnapshot {
                mut snapshot,
                provenance,
            } => {
                let info = snapshot.info().map_err(|error| {
                    format!("failed to query CUDA snapshot info: {}", error.message)
                })?;
                let writer = zarr_writers.entry(snapshot.name.clone()).or_insert(
                    ZarrFieldSeriesWriter::open(
                        &fields_dir,
                        &field_context,
                        &provenance,
                        &snapshot.name,
                        info,
                    )?,
                );
                writer.append_snapshot(&mut snapshot)?;
                summary.field_snapshots_written += 1;
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

    #[cfg(feature = "cuda")]
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
