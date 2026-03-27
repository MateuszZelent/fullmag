//! S13: Async artifact pipeline — decouples snapshot I/O from the step loop.
//!
//! The pipeline uses a bounded channel and a dedicated writer thread so that
//! VTK / CSV writes never block the simulation hot path.  The channel capacity
//! limits memory pressure: if the writer falls behind, `push()` blocks the
//! caller (back-pressure).
//!
//! Usage:
//! ```ignore
//! let pipeline = ArtifactPipeline::start(output_dir, 4);
//! // … during simulation loop …
//! pipeline.push(ArtifactJob::FieldSnapshot { step, data });
//! // … after simulation …
//! pipeline.drain();          // wait for all pending writes
//! drop(pipeline);            // joins the writer thread
//! ```

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, SyncSender};
use std::thread::{self, JoinHandle};

/// A single unit of asynchronous I/O work.
pub enum ArtifactJob {
    /// Write a field snapshot (VTK, raw binary, etc.)
    FieldSnapshot {
        step: u64,
        time_s: f64,
        field_name: String,
        data: Vec<f64>,
    },
    /// Append one row to the scalar CSV trace.
    ScalarRow {
        step: u64,
        time_s: f64,
        values: Vec<(String, f64)>,
    },
    /// Sentinel: writer thread should flush and exit.
    Shutdown,
}

/// Handle to the background writer.  Dropping the handle sends `Shutdown`
/// and joins the writer thread.
pub struct ArtifactPipeline {
    tx: Option<SyncSender<ArtifactJob>>,
    handle: Option<JoinHandle<()>>,
}

impl ArtifactPipeline {
    /// Start the background writer thread.
    ///
    /// `capacity` controls how many jobs can be buffered before `push()` blocks.
    pub fn start(output_dir: PathBuf, capacity: usize) -> Self {
        let (tx, rx) = mpsc::sync_channel::<ArtifactJob>(capacity);
        let handle = thread::Builder::new()
            .name("fullmag-artifact-writer".into())
            .spawn(move || {
                writer_loop(&output_dir, rx);
            })
            .expect("failed to spawn artifact writer thread");

        Self {
            tx: Some(tx),
            handle: Some(handle),
        }
    }

    /// Enqueue an artifact job.  Blocks if the channel is full (back-pressure).
    pub fn push(&self, job: ArtifactJob) {
        if let Some(tx) = &self.tx {
            // Ignore SendError — means the writer thread already exited.
            let _ = tx.send(job);
        }
    }

    /// Send `Shutdown` and wait for the writer to finish all pending work.
    pub fn drain(&mut self) {
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(ArtifactJob::Shutdown);
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for ArtifactPipeline {
    fn drop(&mut self) {
        self.drain();
    }
}

// ── Writer thread ─────────────────────────────────────────────────────

fn writer_loop(output_dir: &Path, rx: mpsc::Receiver<ArtifactJob>) {
    let snapshots_dir = output_dir.join("snapshots");
    let scalars_path = output_dir.join("scalars.csv");
    let mut csv_header_written = false;

    for job in rx {
        match job {
            ArtifactJob::FieldSnapshot {
                step,
                time_s: _,
                field_name,
                data,
            } => {
                let _ = fs::create_dir_all(&snapshots_dir);
                let filename =
                    snapshots_dir.join(format!("{}_{:08}.bin", field_name, step));
                if let Ok(mut f) = fs::File::create(&filename) {
                    let bytes: &[u8] = unsafe {
                        std::slice::from_raw_parts(
                            data.as_ptr() as *const u8,
                            data.len() * std::mem::size_of::<f64>(),
                        )
                    };
                    let _ = f.write_all(bytes);
                }
            }
            ArtifactJob::ScalarRow {
                step,
                time_s,
                values,
            } => {
                if let Ok(mut f) = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&scalars_path)
                {
                    if !csv_header_written {
                        let header: Vec<&str> =
                            std::iter::once("step")
                                .chain(std::iter::once("time_s"))
                                .chain(values.iter().map(|(name, _)| name.as_str()))
                                .collect();
                        let _ = writeln!(f, "{}", header.join(","));
                        csv_header_written = true;
                    }
                    let row: Vec<String> = std::iter::once(step.to_string())
                        .chain(std::iter::once(format!("{:.12e}", time_s)))
                        .chain(values.iter().map(|(_, v)| format!("{:.12e}", v)))
                        .collect();
                    let _ = writeln!(f, "{}", row.join(","));
                }
            }
            ArtifactJob::Shutdown => break,
        }
    }
}
