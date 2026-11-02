//! Bounded, automatic per-run performance diagnostics.
//!
//! This recorder is intentionally separate from the opt-in detailed solver
//! profiler. The callback only copies scalar fields into a bounded queue; a
//! writer thread streams CSV rows and samples process/device resources.

use crate::StepStats;
use serde_json::{json, Value};
use std::fmt::Display;
use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const STEP_QUEUE_CAPACITY: usize = 512;
const RESOURCE_SAMPLE_INTERVAL: Duration = Duration::from_secs(1);
const FINISH_WAIT: Duration = Duration::from_secs(2);
const MAX_RECORDED_ERRORS: usize = 16;
const HISTOGRAM_BUCKETS: usize = 64;
const LIVE_POINT_CAPACITY: usize = 120;
const TIMING_COLUMN_COUNT: usize = 41;
const COUNTER_COLUMN_COUNT: usize = 30;

const TIMING_COLUMNS: &[&str] = &[
    "backend_create_wall_time_ns",
    "exchange_wall_time_ns",
    "demag_wall_time_ns_inclusive",
    "demag_assemble_wall_time_ns",
    "demag_solve_wall_time_ns",
    "demag_solver_setup_wall_time_ns",
    "demag_solver_apply_wall_time_ns_inclusive",
    "demag_recover_wall_time_ns",
    "demag_energy_wall_time_ns",
    "rhs_wall_time_ns",
    "extra_energy_wall_time_ns",
    "snapshot_wall_time_ns_inclusive",
    "relaxation_preconditioner_wall_time_ns",
    "relaxation_state_copy_wall_time_ns",
    "relaxation_state_upload_wall_time_ns",
    "relaxation_retraction_wall_time_ns",
    "relaxation_gradient_wall_time_ns",
    "relaxation_metric_wall_time_ns",
    "relaxation_line_search_wall_time_ns",
    "relaxation_update_wall_time_ns",
    "native_ffi_overhead_wall_time_ns",
    "preview_wall_time_ns",
    "cached_preview_wall_time_ns",
    "preview_schedule_fence_wall_time_ns",
    "field_copy_wall_time_ns",
    "artifact_enqueue_block_wall_time_ns",
    "artifact_writer_job_wall_time_ns_snapshot",
    "artifact_scalar_row_writer_wall_time_ns_snapshot",
    "artifact_field_snapshot_writer_wall_time_ns_snapshot",
    "artifact_native_field_snapshot_writer_wall_time_ns_snapshot",
    "orchestration_wall_time_ns",
    "mesh_payload_wall_time_ns",
    "finalization_wall_time_ns",
    "demag_hypre_host_api_wall_time_ns_inclusive",
    "demag_hypre_device_elapsed_time_ns",
    "demag_hypre_wait_in_enqueue_wall_time_ns",
    "demag_hypre_wait_out_enqueue_wall_time_ns",
    "rk_transaction_capture_host_wall_time_ns",
    "rk_transaction_capture_device_elapsed_time_ns",
    "rk_transaction_restore_host_wall_time_ns",
    "rk_transaction_restore_device_elapsed_time_ns",
];

const COUNTER_COLUMNS: &[&str] = &[
    "step_rejected_attempts_reported",
    "relaxation_energy_rejected_attempts_reported",
    "relaxation_controller_tightenings_reported",
    "rhs_evals_reported",
    "demag_solves_reported",
    "artifact_enqueue_bytes_reported",
    "artifact_queue_depth_max_snapshot",
    "artifact_queue_depth_current_snapshot",
    "artifact_writer_jobs_completed_snapshot",
    "rk_transaction_capture_bytes_reported",
    "rk_transaction_restore_bytes_reported",
    "rk_transaction_rollback_count_reported",
    "rk_transaction_commit_count_reported",
    "rk_transaction_cpu_snapshot_allocation_count_reported",
    "rk_transaction_peak_rss_bytes_reported",
    "hot_loop_h2d_bytes_snapshot",
    "hot_loop_d2h_bytes_snapshot",
    "hot_loop_exchange_h2d_bytes_snapshot",
    "hot_loop_exchange_d2h_bytes_snapshot",
    "hot_loop_compute_h2d_bytes_snapshot",
    "hot_loop_compute_d2h_bytes_snapshot",
    "hot_loop_control_scalar_d2h_bytes_snapshot",
    "hot_loop_host_read_count_snapshot",
    "hot_loop_host_write_count_snapshot",
    "hot_loop_host_sync_count_snapshot",
    "hot_loop_exchange_host_sync_count_snapshot",
    "hot_loop_compute_host_sync_count_snapshot",
    "hot_loop_control_scalar_host_sync_count_snapshot",
    "demag_hypre_event_wait_count_reported",
    "demag_hypre_timed_solve_count_reported",
];

const STEP_HEADER: &str = "elapsed_monotonic_ns,step_index,time_s,dt_s,step_gap_since_previous,callback_delta_wall_ns,callback_delta_ns_per_step_gap,reported_solver_wall_time_ns,solver_wall_delta_ns,unique_step_callback_count,latest_accepted_step_rejected_attempts,sum_step_reported_rejected_attempts";

const RESOURCE_HEADER: &str =
    "elapsed_monotonic_ns,sample_kind,cpu_process_percent,rss_bytes,gpu_json,resource_errors_json";

/// Collects bounded timing/counter rows for one planned simulation run.
///
/// `output_dir` is the run or stage output root; artifacts are written below
/// `output_dir/performance/`. Failure to create, enqueue, or write diagnostics
/// never changes solver control flow.
pub struct RunPerformanceRecorder {
    started_at: Instant,
    started_at_unix_ms: u64,
    identity: Value,
    realization: String,
    callback_latency_unavailable_reason: Option<&'static str>,
    solver_wall_cumulative: bool,
    sender: Option<SyncSender<StepRow>>,
    finalize_slot: Arc<Mutex<Option<FinalSnapshot>>>,
    done_receiver: Option<Receiver<WriterDiagnostics>>,
    writer_thread: Option<JoinHandle<()>>,
    writer_start_error: Option<String>,
    finished: bool,
    callback_count: u64,
    duplicate_step_callbacks: u64,
    out_of_order_callbacks: u64,
    unique_step_callbacks: u64,
    first_step: Option<u64>,
    last_step: Option<u64>,
    missing_step_indices: u64,
    step_gap_count: u64,
    last_callback_elapsed_ns: Option<u64>,
    last_solver_wall_time_ns: Option<u64>,
    solver_wall_clock_regressions: u64,
    sum_step_reported_rejected_attempts: u64,
    dropped_rows: u64,
    collection_overhead_ns: u64,
    callback_delta: MetricAggregate,
    solver_wall_delta: MetricAggregate,
    timing_nonzero: [bool; TIMING_COLUMN_COUNT],
    counter_nonzero: [bool; COUNTER_COLUMN_COUNT],
    latest_stats_row: Option<StepRow>,
}

impl RunPerformanceRecorder {
    /// Start the best-effort writer and resource sampler.
    pub fn start(output_dir: &Path, identity: Value, realization: &str) -> Self {
        let started_at = Instant::now();
        let started_at_unix_ms = unix_time_millis();
        let callback_latency_unavailable_reason =
            terminal_replay_latency_unavailable(&identity).then_some("terminal_replay_no_callback");
        let solver_wall_cumulative = identity
            .get("solver_wall_time_semantics")
            .and_then(Value::as_str)
            == Some("cumulative");
        let (sender, receiver) = mpsc::sync_channel(STEP_QUEUE_CAPACITY);
        let (done_sender, done_receiver) = mpsc::channel();
        let finalize_slot = Arc::new(Mutex::new(None));
        let worker_finalize_slot = Arc::clone(&finalize_slot);
        let worker_started_at = started_at;
        let worker_output_dir = output_dir.to_path_buf();
        let worker_identity = identity.clone();
        let worker_realization = realization.to_owned();

        let spawn_result = thread::Builder::new()
            .name("fullmag-run-performance".to_owned())
            .spawn(move || {
                let diagnostics = writer_thread(
                    &worker_output_dir,
                    receiver,
                    worker_finalize_slot,
                    worker_started_at,
                    started_at_unix_ms,
                    worker_identity,
                    worker_realization,
                );
                let _ = done_sender.send(diagnostics);
            });

        let (sender, done_receiver, writer_thread, writer_start_error) = match spawn_result {
            Ok(writer_thread) => (Some(sender), Some(done_receiver), Some(writer_thread), None),
            Err(error) => (
                None,
                None,
                None,
                Some(format!("writer_thread_start: {error}")),
            ),
        };

        Self {
            started_at,
            started_at_unix_ms,
            identity,
            realization: realization.to_owned(),
            callback_latency_unavailable_reason,
            solver_wall_cumulative,
            sender,
            finalize_slot,
            done_receiver,
            writer_thread,
            writer_start_error,
            finished: false,
            callback_count: 0,
            duplicate_step_callbacks: 0,
            out_of_order_callbacks: 0,
            unique_step_callbacks: 0,
            first_step: None,
            last_step: None,
            missing_step_indices: 0,
            step_gap_count: 0,
            last_callback_elapsed_ns: None,
            last_solver_wall_time_ns: None,
            solver_wall_clock_regressions: 0,
            sum_step_reported_rejected_attempts: 0,
            dropped_rows: 0,
            collection_overhead_ns: 0,
            callback_delta: MetricAggregate::default(),
            solver_wall_delta: MetricAggregate::default(),
            timing_nonzero: [false; TIMING_COLUMN_COUNT],
            counter_nonzero: [false; COUNTER_COLUMN_COUNT],
            latest_stats_row: None,
        }
    }

    /// Record one scalar callback snapshot without cloning `StepStats`.
    pub fn observe(&mut self, stats: &StepStats) {
        if self.finished {
            return;
        }

        let collection_started = Instant::now();
        self.callback_count = self.callback_count.saturating_add(1);
        if let Some(last_step) = self.last_step {
            if stats.step == last_step {
                self.duplicate_step_callbacks = self.duplicate_step_callbacks.saturating_add(1);
                if self.solver_wall_cumulative
                    && self
                        .last_solver_wall_time_ns
                        .is_some_and(|previous| stats.wall_time_ns < previous)
                {
                    self.solver_wall_clock_regressions =
                        self.solver_wall_clock_regressions.saturating_add(1);
                }
                let latest = StepRow::from_stats(
                    duration_ns(self.started_at.elapsed()),
                    None,
                    None,
                    None,
                    None,
                    self.unique_step_callbacks,
                    self.sum_step_reported_rejected_attempts,
                    stats,
                );
                self.latest_stats_row = Some(latest);
                self.last_solver_wall_time_ns = Some(stats.wall_time_ns);
                self.update_availability(&latest);
                self.add_collection_overhead(collection_started);
                return;
            }
            if stats.step < last_step {
                self.out_of_order_callbacks = self.out_of_order_callbacks.saturating_add(1);
                self.add_collection_overhead(collection_started);
                return;
            }
        }

        let elapsed_monotonic_ns = duration_ns(self.started_at.elapsed());
        let step_gap = self
            .last_step
            .map(|previous| stats.step.saturating_sub(previous));
        if let Some(gap) = step_gap {
            if gap > 1 {
                self.step_gap_count = self.step_gap_count.saturating_add(1);
                self.missing_step_indices = self.missing_step_indices.saturating_add(gap - 1);
            }
        } else {
            self.first_step = Some(stats.step);
        }

        let callback_delta_ns = if self.callback_latency_unavailable_reason.is_some() {
            None
        } else {
            self.last_callback_elapsed_ns
                .map(|previous| elapsed_monotonic_ns.saturating_sub(previous))
        };
        let callback_delta_ns_per_step_gap = callback_delta_ns
            .zip(step_gap)
            .filter(|(_, gap)| *gap > 0)
            .map(|(delta, gap)| delta / gap);
        if let Some(delta) = callback_delta_ns {
            self.callback_delta.observe(delta);
        }

        let solver_wall_delta_ns = if self.solver_wall_cumulative {
            match self.last_solver_wall_time_ns {
                Some(previous) if stats.wall_time_ns >= previous => {
                    let delta = stats.wall_time_ns - previous;
                    self.solver_wall_delta.observe(delta);
                    Some(delta)
                }
                Some(_) => {
                    self.solver_wall_clock_regressions =
                        self.solver_wall_clock_regressions.saturating_add(1);
                    None
                }
                None => None,
            }
        } else {
            None
        };

        let row = StepRow::from_stats(
            elapsed_monotonic_ns,
            step_gap,
            callback_delta_ns,
            callback_delta_ns_per_step_gap,
            solver_wall_delta_ns,
            self.unique_step_callbacks.saturating_add(1),
            self.sum_step_reported_rejected_attempts
                .saturating_add(u64::from(stats.rejected_attempts)),
            stats,
        );

        self.unique_step_callbacks = self.unique_step_callbacks.saturating_add(1);
        self.sum_step_reported_rejected_attempts = self
            .sum_step_reported_rejected_attempts
            .saturating_add(u64::from(stats.rejected_attempts));
        self.last_step = Some(stats.step);
        self.last_callback_elapsed_ns = Some(elapsed_monotonic_ns);
        self.last_solver_wall_time_ns = Some(stats.wall_time_ns);
        self.update_availability(&row);
        self.latest_stats_row = Some(row);

        match self.sender.as_ref().map(|sender| sender.try_send(row)) {
            Some(Ok(())) => {}
            Some(Err(TrySendError::Full(_))) | None => {
                self.dropped_rows = self.dropped_rows.saturating_add(1);
            }
            Some(Err(TrySendError::Disconnected(_))) => {
                self.dropped_rows = self.dropped_rows.saturating_add(1);
                self.sender = None;
            }
        }
        self.add_collection_overhead(collection_started);
    }

    /// Finalize the diagnostic artifacts with the supplied lifecycle label.
    /// The value is descriptive only and never changes physics/run status.
    pub fn finish(&mut self, outcome: &str) {
        if self.finished {
            return;
        }
        self.finished = true;
        let snapshot = self.final_snapshot(outcome);
        if let Ok(mut slot) = self.finalize_slot.lock() {
            *slot = Some(snapshot);
        }

        // Closing the only sender lets the worker drain queued records and write
        // the final resource sample/summary. `finish` waits for a bounded time;
        // a stalled filesystem cannot wedge the solver's Drop path indefinitely.
        self.sender.take();
        let worker_finished = self
            .done_receiver
            .take()
            .is_some_and(|receiver| receiver.recv_timeout(FINISH_WAIT).is_ok());
        if worker_finished {
            if let Some(worker) = self.writer_thread.take() {
                let _ = worker.join();
            }
        } else {
            // Dropping JoinHandle detaches a worker that is stuck in OS I/O.
            self.writer_thread.take();
        }
    }

    fn final_snapshot(&self, outcome: &str) -> FinalSnapshot {
        FinalSnapshot {
            identity: self.identity.clone(),
            realization: self.realization.clone(),
            outcome: outcome.to_owned(),
            started_at_unix_ms: self.started_at_unix_ms,
            finished_at_unix_ms: unix_time_millis(),
            elapsed_monotonic_ns: duration_ns(self.started_at.elapsed()),
            callback_count: self.callback_count,
            duplicate_step_callbacks: self.duplicate_step_callbacks,
            out_of_order_callbacks: self.out_of_order_callbacks,
            unique_step_callbacks: self.unique_step_callbacks,
            first_step: self.first_step,
            last_step: self.last_step,
            step_gap_count: self.step_gap_count,
            missing_step_indices: self.missing_step_indices,
            solver_wall_clock_regressions: self.solver_wall_clock_regressions,
            sum_step_reported_rejected_attempts: self.sum_step_reported_rejected_attempts,
            dropped_rows: self.dropped_rows,
            collection_overhead_ns: self.collection_overhead_ns,
            callback_delta: self.callback_delta.clone(),
            solver_wall_delta: self.solver_wall_delta.clone(),
            callback_latency_unavailable_reason: self.callback_latency_unavailable_reason,
            solver_wall_cumulative: self.solver_wall_cumulative,
            timing_nonzero: self.timing_nonzero,
            counter_nonzero: self.counter_nonzero,
            latest_stats_row: self.latest_stats_row,
            writer_start_error: self.writer_start_error.clone(),
        }
    }

    fn add_collection_overhead(&mut self, started: Instant) {
        self.collection_overhead_ns = self
            .collection_overhead_ns
            .saturating_add(duration_ns(started.elapsed()));
    }

    fn update_availability(&mut self, row: &StepRow) {
        for (available, value) in self.timing_nonzero.iter_mut().zip(row.timings_ns) {
            *available |= value > 0;
        }
        for (available, value) in self.counter_nonzero.iter_mut().zip(row.counters) {
            *available |= value > 0;
        }
    }
}

impl Drop for RunPerformanceRecorder {
    fn drop(&mut self) {
        if !self.finished {
            self.finish("interrupted_or_error");
        }
    }
}

#[derive(Clone, Copy)]
struct StepRow {
    elapsed_monotonic_ns: u64,
    step: u64,
    time_s: f64,
    dt_s: f64,
    step_gap: Option<u64>,
    callback_delta_wall_ns: Option<u64>,
    callback_delta_ns_per_step_gap: Option<u64>,
    reported_solver_wall_time_ns: u64,
    solver_wall_delta_ns: Option<u64>,
    unique_step_callback_count: u64,
    rejected_attempts: u32,
    sum_step_reported_rejected_attempts: u64,
    timings_ns: [u64; TIMING_COLUMN_COUNT],
    counters: [u64; COUNTER_COLUMN_COUNT],
}

impl StepRow {
    #[allow(clippy::too_many_arguments)]
    fn from_stats(
        elapsed_monotonic_ns: u64,
        step_gap: Option<u64>,
        callback_delta_wall_ns: Option<u64>,
        callback_delta_ns_per_step_gap: Option<u64>,
        solver_wall_delta_ns: Option<u64>,
        unique_step_callback_count: u64,
        sum_step_reported_rejected_attempts: u64,
        stats: &StepStats,
    ) -> Self {
        Self {
            elapsed_monotonic_ns,
            step: stats.step,
            time_s: stats.time,
            dt_s: stats.dt,
            step_gap,
            callback_delta_wall_ns,
            callback_delta_ns_per_step_gap,
            reported_solver_wall_time_ns: stats.wall_time_ns,
            solver_wall_delta_ns,
            unique_step_callback_count,
            rejected_attempts: stats.rejected_attempts,
            sum_step_reported_rejected_attempts,
            timings_ns: [
                stats.backend_create_wall_time_ns,
                stats.exchange_wall_time_ns,
                stats.demag_wall_time_ns,
                stats.demag_assemble_wall_time_ns,
                stats.demag_solve_wall_time_ns,
                stats.demag_solver_setup_wall_time_ns,
                stats.demag_solver_apply_wall_time_ns,
                stats.demag_recover_wall_time_ns,
                stats.demag_energy_wall_time_ns,
                stats.rhs_wall_time_ns,
                stats.extra_energy_wall_time_ns,
                stats.snapshot_wall_time_ns,
                stats.relaxation_preconditioner_wall_time_ns,
                stats.relaxation_state_copy_wall_time_ns,
                stats.relaxation_state_upload_wall_time_ns,
                stats.relaxation_retraction_wall_time_ns,
                stats.relaxation_gradient_wall_time_ns,
                stats.relaxation_metric_wall_time_ns,
                stats.relaxation_line_search_wall_time_ns,
                stats.relaxation_update_wall_time_ns,
                stats.native_ffi_overhead_wall_time_ns,
                stats.preview_wall_time_ns,
                stats.cached_preview_wall_time_ns,
                stats.preview_schedule_fence_wall_time_ns,
                stats.field_copy_wall_time_ns,
                stats.artifact_enqueue_block_wall_time_ns,
                stats.artifact_writer_job_wall_time_ns,
                stats.artifact_scalar_row_writer_wall_time_ns,
                stats.artifact_field_snapshot_writer_wall_time_ns,
                stats.artifact_native_field_snapshot_writer_wall_time_ns,
                stats.orchestration_wall_time_ns,
                stats.mesh_payload_wall_time_ns,
                stats.finalization_wall_time_ns,
                stats.demag_hypre_host_api_wall_time_ns,
                stats.demag_hypre_device_elapsed_time_ns,
                stats.demag_hypre_wait_in_enqueue_wall_time_ns,
                stats.demag_hypre_wait_out_enqueue_wall_time_ns,
                stats.rk_transaction_capture_host_wall_time_ns,
                stats.rk_transaction_capture_device_elapsed_time_ns,
                stats.rk_transaction_restore_host_wall_time_ns,
                stats.rk_transaction_restore_device_elapsed_time_ns,
            ],
            counters: [
                u64::from(stats.rejected_attempts),
                stats.relaxation_energy_rejected_attempts,
                stats.relaxation_controller_tightenings,
                u64::from(stats.rhs_evals),
                u64::from(stats.demag_solves),
                stats.artifact_enqueue_bytes,
                stats.artifact_queue_depth_max,
                stats.artifact_queue_depth_current,
                stats.artifact_writer_jobs_completed,
                stats.rk_transaction_capture_bytes,
                stats.rk_transaction_restore_bytes,
                stats.rk_transaction_rollback_count,
                stats.rk_transaction_commit_count,
                stats.rk_transaction_cpu_snapshot_allocation_count,
                stats.rk_transaction_peak_rss_bytes,
                stats.hot_loop_h2d_bytes,
                stats.hot_loop_d2h_bytes,
                stats.hot_loop_exchange_h2d_bytes,
                stats.hot_loop_exchange_d2h_bytes,
                stats.hot_loop_compute_h2d_bytes,
                stats.hot_loop_compute_d2h_bytes,
                stats.hot_loop_control_scalar_d2h_bytes,
                stats.hot_loop_host_read_count,
                stats.hot_loop_host_write_count,
                stats.hot_loop_host_sync_count,
                stats.hot_loop_exchange_host_sync_count,
                stats.hot_loop_compute_host_sync_count,
                stats.hot_loop_control_scalar_host_sync_count,
                stats.demag_hypre_event_wait_count,
                stats.demag_hypre_timed_solve_count,
            ],
        }
    }

    fn write_csv(self, writer: &mut BufWriter<File>) -> io::Result<()> {
        let mut line = String::with_capacity(2_048);
        push_csv(&mut line, self.elapsed_monotonic_ns);
        push_csv(&mut line, self.step);
        push_csv(&mut line, self.time_s);
        push_csv(&mut line, self.dt_s);
        push_csv_option(&mut line, self.step_gap);
        push_csv_option(&mut line, self.callback_delta_wall_ns);
        push_csv_option(&mut line, self.callback_delta_ns_per_step_gap);
        push_csv(&mut line, self.reported_solver_wall_time_ns);
        push_csv_option(&mut line, self.solver_wall_delta_ns);
        push_csv(&mut line, self.unique_step_callback_count);
        push_csv(&mut line, self.rejected_attempts);
        push_csv(&mut line, self.sum_step_reported_rejected_attempts);
        for value in self.timings_ns {
            push_csv(&mut line, value);
        }
        for value in self.counters {
            push_csv(&mut line, value);
        }
        // StepStats has cumulative byte/access snapshots but no H2D/D2H
        // operation counts. Empty CSV cells preserve unavailable-vs-zero.
        push_csv(&mut line, "");
        push_csv(&mut line, "");
        line.push('\n');
        writer.write_all(line.as_bytes())
    }
}

#[derive(Clone)]
struct MetricAggregate {
    count: u64,
    sum_ns: u128,
    min_ns: Option<u64>,
    max_ns: Option<u64>,
    histogram: [u64; HISTOGRAM_BUCKETS],
}

impl Default for MetricAggregate {
    fn default() -> Self {
        Self { count: 0, sum_ns: 0, min_ns: None, max_ns: None,
            histogram: [0; HISTOGRAM_BUCKETS] }
    }
}

impl MetricAggregate {
    fn observe(&mut self, value_ns: u64) {
        self.count = self.count.saturating_add(1);
        self.sum_ns = self.sum_ns.saturating_add(u128::from(value_ns));
        self.min_ns = Some(
            self.min_ns
                .map_or(value_ns, |current| current.min(value_ns)),
        );
        self.max_ns = Some(
            self.max_ns
                .map_or(value_ns, |current| current.max(value_ns)),
        );
        let bucket = if value_ns == 0 {
            0
        } else {
            (u64::BITS - value_ns.leading_zeros()) as usize - 1
        }
        .min(HISTOGRAM_BUCKETS - 1);
        self.histogram[bucket] = self.histogram[bucket].saturating_add(1);
    }

    fn summary(&self) -> Value {
        json!({
            "count": self.count,
            "sum_ns": self.sum_ns.to_string(),
            "min_ns": self.min_ns,
            "max_ns": self.max_ns,
            "mean_ns": (self.count > 0).then(|| self.sum_ns as f64 / self.count as f64),
            "p50_approx_ns": self.approx_percentile(0.50),
            "p95_approx_ns": self.approx_percentile(0.95),
            "quantile_method": "fixed_log2_histogram_bucket_lower_bound_approximate",
            "histogram_log2_bucket_counts": self.histogram.as_slice(),
        })
    }

    fn approx_percentile(&self, percentile: f64) -> Option<u64> {
        if self.count == 0 {
            return None;
        }
        let rank = ((self.count as f64 * percentile).ceil() as u64).max(1);
        let mut seen = 0_u64;
        for (bucket, count) in self.histogram.iter().copied().enumerate() {
            seen = seen.saturating_add(count);
            if seen >= rank {
                return Some(if bucket == 0 { 0 } else { 1_u64 << bucket });
            }
        }
        self.max_ns
    }
}

#[derive(Clone)]
struct FinalSnapshot {
    identity: Value,
    realization: String,
    outcome: String,
    started_at_unix_ms: u64,
    finished_at_unix_ms: u64,
    elapsed_monotonic_ns: u64,
    callback_count: u64,
    duplicate_step_callbacks: u64,
    out_of_order_callbacks: u64,
    unique_step_callbacks: u64,
    first_step: Option<u64>,
    last_step: Option<u64>,
    step_gap_count: u64,
    missing_step_indices: u64,
    solver_wall_clock_regressions: u64,
    sum_step_reported_rejected_attempts: u64,
    dropped_rows: u64,
    collection_overhead_ns: u64,
    callback_delta: MetricAggregate,
    solver_wall_delta: MetricAggregate,
    callback_latency_unavailable_reason: Option<&'static str>,
    solver_wall_cumulative: bool,
    timing_nonzero: [bool; TIMING_COLUMN_COUNT],
    counter_nonzero: [bool; COUNTER_COLUMN_COUNT],
    latest_stats_row: Option<StepRow>,
    writer_start_error: Option<String>,
}

#[derive(Default)]
struct WriterDiagnostics {
    step_rows_written: u64,
    resource_rows_written: u64,
    cpu_percent_samples: u64,
    rss_samples: u64,
    gpu_samples: u64,
    gpu_uuid_samples: u64,
    gpu_error_entries: u64,
    resource_error_count: u64,
    writer_error_count: u64,
    writer_errors: Vec<String>,
    steps_file_opened: bool,
    resources_file_opened: bool,
}

fn writer_thread(
    output_dir: &Path,
    receiver: Receiver<StepRow>,
    finalize_slot: Arc<Mutex<Option<FinalSnapshot>>>,
    started_at: Instant,
    started_at_unix_ms: u64,
    identity: Value,
    realization: String,
) -> WriterDiagnostics {
    let performance_dir = output_dir.join("performance");
    let mut diagnostics = WriterDiagnostics::default();
    if let Err(error) = fs::create_dir_all(&performance_dir) {
        record_writer_error(&mut diagnostics, format!("create_performance_dir: {error}"));
    }

    let mut steps = open_csv(
        &performance_dir.join("steps.csv"),
        &step_header(),
        "steps.csv",
        &mut diagnostics,
    );
    let mut resources = open_csv(
        &performance_dir.join("resources.csv"),
        &resource_header(),
        "resources.csv",
        &mut diagnostics,
    );
    diagnostics.steps_file_opened = steps.is_some();
    diagnostics.resources_file_opened = resources.is_some();

    let mut gpu_sampler =
        std::panic::catch_unwind(|| crate::run_performance_gpu::GpuSampler::new(&realization)).ok();
    let mut process_sampler = ProcessResourceSampler::new();
    let mut live_points = VecDeque::with_capacity(LIVE_POINT_CAPACITY);
    let mut live_sequence = 0_u64;
    let mut latest_row = None;
    let mut first_step = None;
    let mut received_rows = 0_u64;
    let resource = write_resource_sample(
        &mut resources,
        &mut diagnostics,
        &mut process_sampler,
        &mut gpu_sampler,
        started_at,
        "start",
    );
    publish_live_performance(&performance_dir, &identity, &mut live_points, &mut live_sequence,
        resource, latest_row, first_step, received_rows, None, &mut diagnostics);

    let mut next_sample = Instant::now() + RESOURCE_SAMPLE_INTERVAL;
    loop {
        let now = Instant::now();
        if now >= next_sample {
            let resource = write_resource_sample(
                &mut resources,
                &mut diagnostics,
                &mut process_sampler,
                &mut gpu_sampler,
                started_at,
                "interval",
            );
            publish_live_performance(&performance_dir, &identity, &mut live_points, &mut live_sequence,
                resource, latest_row, first_step, received_rows, None, &mut diagnostics);
            flush_writer(&mut steps, "steps.csv", &mut diagnostics);
            flush_writer(&mut resources, "resources.csv", &mut diagnostics);
            next_sample = Instant::now() + RESOURCE_SAMPLE_INTERVAL;
        }
        let timeout = next_sample.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(timeout) {
            Ok(row) => {
                first_step.get_or_insert(row.step);
                latest_row = Some(row);
                received_rows = received_rows.saturating_add(1);
                match steps.as_mut() {
                Some(writer) => match row.write_csv(writer) {
                    Ok(()) => {
                        diagnostics.step_rows_written =
                            diagnostics.step_rows_written.saturating_add(1);
                    }
                    Err(error) => {
                        record_writer_error(&mut diagnostics, format!("write steps.csv: {error}"));
                        steps = None;
                    }
                },
                None => {}
                }
            },
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    let final_resource = write_resource_sample(
        &mut resources,
        &mut diagnostics,
        &mut process_sampler,
        &mut gpu_sampler,
        started_at,
        "final",
    );
    flush_writer(&mut steps, "steps.csv", &mut diagnostics);
    flush_writer(&mut resources, "resources.csv", &mut diagnostics);

    let final_snapshot = finalize_slot
        .lock()
        .map(|mut slot| slot.take())
        .unwrap_or_default()
        .unwrap_or_else(|| {
            fallback_final_snapshot(identity.clone(), realization, started_at, started_at_unix_ms)
        });
    publish_live_performance(&performance_dir, &identity, &mut live_points, &mut live_sequence,
        final_resource, latest_row, first_step, received_rows, Some(&final_snapshot), &mut diagnostics);
    let _ = write_summary(&performance_dir, &final_snapshot, &diagnostics);
    diagnostics
}

fn fallback_final_snapshot(
    identity: Value,
    realization: String,
    started_at: Instant,
    started_at_unix_ms: u64,
) -> FinalSnapshot {
    FinalSnapshot {
        identity,
        realization,
        outcome: "interrupted_or_error".to_owned(),
        started_at_unix_ms,
        finished_at_unix_ms: unix_time_millis(),
        elapsed_monotonic_ns: duration_ns(started_at.elapsed()),
        callback_count: 0,
        duplicate_step_callbacks: 0,
        out_of_order_callbacks: 0,
        unique_step_callbacks: 0,
        first_step: None,
        last_step: None,
        step_gap_count: 0,
        missing_step_indices: 0,
        solver_wall_clock_regressions: 0,
        sum_step_reported_rejected_attempts: 0,
        dropped_rows: 0,
        collection_overhead_ns: 0,
        callback_delta: MetricAggregate::default(),
        solver_wall_delta: MetricAggregate::default(),
        callback_latency_unavailable_reason: Some("recorder_finalized_without_finish_snapshot"),
        solver_wall_cumulative: false,
        timing_nonzero: [false; TIMING_COLUMN_COUNT],
        counter_nonzero: [false; COUNTER_COLUMN_COUNT],
        latest_stats_row: None,
        writer_start_error: Some("recorder_finalized_without_finish_snapshot".to_owned()),
    }
}

fn resource_header() -> String {
    RESOURCE_HEADER.to_owned()
}

fn step_header() -> String {
    let mut header = String::with_capacity(2_048);
    header.push_str(STEP_HEADER);
    for column in TIMING_COLUMNS.iter().chain(COUNTER_COLUMNS) {
        header.push(',');
        header.push_str(column);
    }
    header.push_str(",gpu_h2d_transfer_count,gpu_d2h_transfer_count");
    header
}

fn open_csv(
    path: &Path,
    header: &str,
    label: &str,
    diagnostics: &mut WriterDiagnostics,
) -> Option<BufWriter<File>> {
    match File::create(path) {
        Ok(file) => {
            let mut writer = BufWriter::new(file);
            if let Err(error) = writeln!(writer, "{header}") {
                record_writer_error(diagnostics, format!("write {label} header: {error}"));
                None
            } else {
                Some(writer)
            }
        }
        Err(error) => {
            record_writer_error(diagnostics, format!("open {label}: {error}"));
            None
        }
    }
}

fn write_resource_sample(
    writer: &mut Option<BufWriter<File>>,
    diagnostics: &mut WriterDiagnostics,
    process_sampler: &mut ProcessResourceSampler,
    gpu_sampler: &mut Option<crate::run_performance_gpu::GpuSampler>,
    started_at: Instant,
    sample_kind: &str,
) -> Value {
    let elapsed_ns = duration_ns(started_at.elapsed());
    let process_sample = process_sampler.sample();
    if process_sample.cpu_percent.is_some() {
        diagnostics.cpu_percent_samples = diagnostics.cpu_percent_samples.saturating_add(1);
    }
    if process_sample.rss_bytes.is_some() {
        diagnostics.rss_samples = diagnostics.rss_samples.saturating_add(1);
    }
    diagnostics.resource_error_count = diagnostics
        .resource_error_count
        .saturating_add(process_sample.errors.len() as u64);

    let gpu = match gpu_sampler {
        Some(sampler) => {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sampler.sample()))
                .unwrap_or_else(|_| {
                    json!({
                        "uuid": null,
                        "scope": "unavailable",
                        "utilization_percent": null,
                        "memory_utilization_percent": null,
                        "memory_used_bytes": null,
                        "memory_total_bytes": null,
                        "power_watts": null,
                        "temp_c": null,
                        "errors": {"sampler": "gpu_sampler_panicked"}
                    })
                })
        }
        None => json!({
            "uuid": null,
            "scope": "unavailable",
            "utilization_percent": null,
            "memory_utilization_percent": null,
            "memory_used_bytes": null,
            "memory_total_bytes": null,
            "power_watts": null,
            "temp_c": null,
            "errors": {"sampler": "gpu_sampler_initialization_failed"}
        }),
    };
    diagnostics.gpu_samples = diagnostics.gpu_samples.saturating_add(1);
    if gpu.get("uuid").and_then(Value::as_str).is_some() {
        diagnostics.gpu_uuid_samples = diagnostics.gpu_uuid_samples.saturating_add(1);
    }
    if let Some(errors) = gpu.get("errors").and_then(Value::as_object) {
        diagnostics.gpu_error_entries = diagnostics
            .gpu_error_entries
            .saturating_add(errors.len() as u64);
    }

    let mut error_json = serde_json::Map::new();
    for (name, error) in process_sample.errors {
        error_json.insert(name.to_owned(), Value::String(error));
    }
    let mut line = String::with_capacity(512);
    push_csv(&mut line, elapsed_ns);
    push_csv_quoted(&mut line, sample_kind);
    push_csv_option(&mut line, process_sample.cpu_percent);
    push_csv_option(&mut line, process_sample.rss_bytes);
    push_csv_quoted(
        &mut line,
        &serde_json::to_string(&gpu).unwrap_or_else(|_| "null".to_owned()),
    );
    push_csv_quoted(
        &mut line,
        &serde_json::to_string(&Value::Object(error_json)).unwrap_or_else(|_| "{}".to_owned()),
    );
    line.push('\n');
    if let Some(csv_writer) = writer.as_mut() {
        match csv_writer.write_all(line.as_bytes()) {
            Ok(()) => {
                diagnostics.resource_rows_written =
                    diagnostics.resource_rows_written.saturating_add(1);
            }
            Err(error) => {
                record_writer_error(diagnostics, format!("write resources.csv: {error}"));
                *writer = None;
            }
        }
    }
    json!({
        "elapsed_monotonic_ns": elapsed_ns,
        "cpu_percent": process_sample.cpu_percent,
        "rss_bytes": process_sample.rss_bytes,
        "gpu_percent": gpu.get("utilization_percent").cloned().unwrap_or(Value::Null),
        "gpu_memory_bytes": gpu.get("memory_used_bytes").cloned().unwrap_or(Value::Null),
        "gpu_power_watts": gpu.get("power_watts").cloned().unwrap_or(Value::Null),
        "gpu_uuid": gpu.get("uuid").cloned().unwrap_or(Value::Null),
        "gpu_unavailable_reason": gpu.get("reason").cloned().or_else(||
            gpu.get("errors").filter(|v| v.as_object().is_some_and(|m| !m.is_empty()))
                .map(|v| Value::String(v.to_string()))).unwrap_or(Value::Null),
    })
}

/// One bounded control-plane snapshot from the writer, never the solver thread.
/// Points cover the most recent 120 resource samples; full history stays in CSV.
#[allow(clippy::too_many_arguments)]
fn publish_live_performance(
    directory: &Path,
    identity: &Value,
    points: &mut VecDeque<Value>,
    sequence: &mut u64,
    resource: Value,
    latest: Option<StepRow>,
    first_step: Option<u64>,
    received_rows: u64,
    final_snapshot: Option<&FinalSnapshot>,
    diagnostics: &mut WriterDiagnostics,
) {
    // The queue may drop its newest rows under backpressure. A terminal clock
    // must carry metrics from that same terminal step, never a delivered prefix.
    let latest = final_snapshot.map(|snapshot| snapshot.latest_stats_row).unwrap_or(latest);
    let step = final_snapshot.and_then(|s| s.last_step).or(latest.map(|s| s.step));
    let observed = final_snapshot.map(|s| s.unique_step_callbacks)
        .or(latest.map(|s| s.unique_step_callback_count)).unwrap_or(0);
    let gpu_reason = resource.get("gpu_unavailable_reason").cloned().unwrap_or(Value::Null);
    let gpu_uuid = resource.get("gpu_uuid").cloned().unwrap_or(Value::Null);
    let resource_elapsed = resource.get("elapsed_monotonic_ns").and_then(Value::as_u64).unwrap_or(0);
    let elapsed = final_snapshot.map(|s| s.elapsed_monotonic_ns.max(resource_elapsed))
        .unwrap_or(resource_elapsed);
    let mut point = resource;
    if let Some(object) = point.as_object_mut() {
        object.insert("step_index".into(), json!(step));
        object.remove("gpu_unavailable_reason");
        object.remove("gpu_uuid");
    }
    if points.len() == LIVE_POINT_CAPACITY { points.pop_front(); }
    points.push_back(point);
    *sequence = sequence.saturating_add(1);
    let value = json!({
        "schema_version": "fullmag.run_performance_live.v1", "identity": identity,
        "sample_sequence": sequence, "state": final_snapshot.map(|s| match s.outcome.as_str() {
            "completed" => "completed", "cancelled" => "cancelled", _ => "error",
        }).unwrap_or("running"),
        "elapsed_monotonic_ns": elapsed,
        "first_step_index": final_snapshot.and_then(|s| s.first_step).or(first_step),
        "step_index": step, "unique_step_callback_records": observed,
        "rows_dropped": final_snapshot.map(|s| s.dropped_rows).unwrap_or_else(|| observed.saturating_sub(received_rows)),
        "collection_overhead_ns": final_snapshot.map(|s| s.collection_overhead_ns),
        "latest_step_wall_ns": latest.and_then(|s| s.callback_delta_ns_per_step_gap),
        "latest_rejected_attempts": latest.map(|s| s.rejected_attempts),
        "latest_evaluate_host_wall_ns": latest.and_then(|s| (s.timings_ns[18] > 0).then_some(s.timings_ns[18])),
        "gpu_scope": "whole_device", "gpu_uuid": gpu_uuid,
        "gpu_unavailable_reason": gpu_reason, "points": points,
    });
    let result = (|| -> io::Result<()> {
        let bytes = serde_json::to_vec(&value).map_err(io::Error::other)?;
        if bytes.len() > 128 * 1024 { return Err(io::Error::other("performance live snapshot exceeds 128 KiB")); }
        let temporary = directory.join("live.v1.json.partial");
        fs::write(&temporary, bytes)?;
        fs::rename(temporary, directory.join("live.v1.json"))
    })();
    if let Err(error) = result { record_writer_error(diagnostics, format!("publish performance live snapshot: {error}")); }
}

struct ProcessSample {
    cpu_percent: Option<f64>,
    rss_bytes: Option<u64>,
    errors: Vec<(&'static str, String)>,
}

struct ProcessResourceSampler {
    previous_cpu_ns: Option<u128>,
    previous_sample_at: Instant,
}

impl ProcessResourceSampler {
    fn new() -> Self {
        Self {
            previous_cpu_ns: process_cpu_time_ns().ok(),
            previous_sample_at: Instant::now(),
        }
    }

    fn sample(&mut self) -> ProcessSample {
        let sampled_at = Instant::now();
        let wall_delta_ns = sampled_at
            .saturating_duration_since(self.previous_sample_at)
            .as_nanos();
        self.previous_sample_at = sampled_at;
        let mut errors = Vec::new();
        let current_cpu_ns = match process_cpu_time_ns() {
            Ok(value) => Some(value),
            Err(error) => {
                errors.push(("cpu_process", error.to_string()));
                None
            }
        };
        let cpu_percent = match (self.previous_cpu_ns, current_cpu_ns, wall_delta_ns) {
            (Some(previous), Some(current), wall) if current >= previous && wall > 0 => {
                Some((current - previous) as f64 / wall as f64 * 100.0)
            }
            _ => None,
        };
        if let Some(current) = current_cpu_ns {
            self.previous_cpu_ns = Some(current);
        }

        let rss_bytes = match current_rss_bytes() {
            Ok(value) => Some(value),
            Err(error) => {
                errors.push(("rss", error.to_string()));
                None
            }
        };
        ProcessSample {
            cpu_percent,
            rss_bytes,
            errors,
        }
    }
}

#[cfg(unix)]
fn process_cpu_time_ns() -> io::Result<u128> {
    let mut usage = unsafe { std::mem::zeroed::<libc::rusage>() };
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    let user = timeval_ns(usage.ru_utime)?;
    let system = timeval_ns(usage.ru_stime)?;
    Ok(user.saturating_add(system))
}

#[cfg(not(unix))]
fn process_cpu_time_ns() -> io::Result<u128> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process CPU sampling is unavailable on this platform",
    ))
}

#[cfg(unix)]
fn timeval_ns(value: libc::timeval) -> io::Result<u128> {
    if value.tv_sec < 0 || value.tv_usec < 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "getrusage returned a negative CPU time",
        ));
    }
    Ok((value.tv_sec as u128)
        .saturating_mul(1_000_000_000)
        .saturating_add((value.tv_usec as u128).saturating_mul(1_000)))
}

#[cfg(target_os = "linux")]
fn current_rss_bytes() -> io::Result<u64> {
    let status = fs::read_to_string("/proc/self/status")?;
    let rss_kib = status
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))
        .and_then(|value| value.split_whitespace().next())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "VmRSS was not present"))?;
    Ok(rss_kib.saturating_mul(1024))
}

#[cfg(not(target_os = "linux"))]
fn current_rss_bytes() -> io::Result<u64> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "current RSS sampling is unavailable on this platform",
    ))
}

fn write_summary(
    performance_dir: &Path,
    final_snapshot: &FinalSnapshot,
    diagnostics: &WriterDiagnostics,
) -> bool {
    let summary = summary_json(final_snapshot, diagnostics);
    let temporary_path = performance_dir.join("summary.json.partial");
    let final_path = performance_dir.join("summary.json");
    let write_result = (|| -> io::Result<()> {
        let file = File::create(&temporary_path)?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, &summary)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        writer.write_all(b"\n")?;
        writer.flush()?;
        fs::rename(&temporary_path, &final_path)
    })();
    write_result.is_ok()
}

fn summary_json(snapshot: &FinalSnapshot, diagnostics: &WriterDiagnostics) -> Value {
    let mut timing_states = serde_json::Map::new();
    for (name, nonzero) in TIMING_COLUMNS.iter().zip(snapshot.timing_nonzero) {
        timing_states.insert(
            (*name).to_owned(),
            Value::String(if nonzero {
                "observed_nonzero".to_owned()
            } else {
                "reported_zero_may_be_uninstrumented_or_true_zero".to_owned()
            }),
        );
    }
    let mut counter_states = serde_json::Map::new();
    for (name, nonzero) in COUNTER_COLUMNS.iter().zip(snapshot.counter_nonzero) {
        counter_states.insert(
            (*name).to_owned(),
            Value::String(if nonzero {
                "observed_nonzero".to_owned()
            } else {
                "reported_zero_may_be_uninstrumented_or_true_zero".to_owned()
            }),
        );
    }
    let latest_timing_snapshot = snapshot.latest_stats_row.map(|row| {
        let timings = TIMING_COLUMNS
            .iter()
            .zip(row.timings_ns)
            .map(|(name, value)| ((*name).to_owned(), Value::from(value)))
            .collect::<serde_json::Map<_, _>>();
        let counters = COUNTER_COLUMNS
            .iter()
            .zip(row.counters)
            .map(|(name, value)| ((*name).to_owned(), Value::from(value)))
            .collect::<serde_json::Map<_, _>>();
        json!({
            "step_index": row.step,
            "time_s": row.time_s,
            "dt_s": row.dt_s,
            "reported_solver_wall_time_ns": row.reported_solver_wall_time_ns,
            "reported_step_rejected_attempts": row.rejected_attempts,
            "timings_ns": timings,
            "counters": counters
        })
    });
    let accepted_step_index_span = snapshot
        .first_step
        .zip(snapshot.last_step)
        .map(|(first, last)| last.saturating_sub(first));
    let elapsed_seconds = snapshot.elapsed_monotonic_ns as f64 / 1_000_000_000.0;
    let callback_latency_availability = match snapshot.callback_latency_unavailable_reason {
        Some(reason) => reason,
        None if snapshot.callback_delta.count > 0 => "available_for_observed_callback_intervals",
        None => "no_unique_step_interval_observed",
    };

    json!({
        "schema": "fullmag.run_performance.v1",
        "identity": snapshot.identity,
        "realization": snapshot.realization,
        "outcome": snapshot.outcome,
        "started_at_unix_ms": snapshot.started_at_unix_ms,
        "finished_at_unix_ms": snapshot.finished_at_unix_ms,
        "elapsed_monotonic_ns": snapshot.elapsed_monotonic_ns,
        "clock_semantics": {
            "duration_and_rates": "monotonic",
            "utc_timestamps": "metadata_only",
            "cpu_process_percent": "process_cpu_time_over_monotonic_interval; may exceed 100"
        },
        "coverage": {
            "callbacks_seen": snapshot.callback_count,
            "duplicate_step_callbacks_skipped": snapshot.duplicate_step_callbacks,
            "out_of_order_step_callbacks_skipped": snapshot.out_of_order_callbacks,
            "unique_step_callback_records": snapshot.unique_step_callbacks,
            "first_step_index": snapshot.first_step,
            "last_step_index": snapshot.last_step,
            "accepted_step_index_span": accepted_step_index_span,
            "step_gap_count": snapshot.step_gap_count,
            "missing_step_indices_not_synthesized": snapshot.missing_step_indices,
            "csv_rows_dropped_by_bounded_queue": snapshot.dropped_rows,
            "csv_rows_written": diagnostics.step_rows_written,
            "solver_wall_clock_regressions": snapshot
                .solver_wall_cumulative
                .then_some(snapshot.solver_wall_clock_regressions),
            "step_rows_are_observed_callbacks_only": true
        },
        "rates_per_monotonic_second": {
            "unique_step_callback_records": (elapsed_seconds > 0.0).then(|| snapshot.unique_step_callbacks as f64 / elapsed_seconds),
            "accepted_step_index_span": (elapsed_seconds > 0.0).then(|| accepted_step_index_span.unwrap_or(0) as f64 / elapsed_seconds)
        },
        "callback_delta_wall_ns": snapshot.callback_delta.summary(),
        "callback_latency_availability": callback_latency_availability,
        "callback_delta_semantics": "monotonic interval between unique step callbacks; per-step-gap column is a span average, not synthesized individual-step data",
        "solver_wall_delta_ns": snapshot
            .solver_wall_cumulative
            .then(|| snapshot.solver_wall_delta.summary()),
        "solver_wall_time_semantics": if snapshot.solver_wall_cumulative {
            "cumulative"
        } else {
            "backend_dependent_unknown"
        },
        "solver_wall_delta_availability": if snapshot.solver_wall_cumulative {
            "available_for_cumulative_semantics"
        } else {
            "unknown_not_computed"
        },
        "solver_wall_snapshot_semantics": "reported_solver_wall_time_ns preserves raw StepStats.wall_time_ns without assuming per-step or cumulative semantics",
        "terminal_stats_snapshot": latest_timing_snapshot,
        "step_reported_counters": {
            "sum_step_reported_rejected_attempts": snapshot.sum_step_reported_rejected_attempts,
            "meaning": "sum of rejected_attempts on observed unique callbacks; step gaps are not inferred"
        },
        "collection_overhead_ns": snapshot.collection_overhead_ns,
        "collection_overhead_semantics": "time spent inside RunPerformanceRecorder.observe on the solver callback thread",
        "metric_availability": {
            "phase_timings": timing_states,
            "step_counters": counter_states,
            "gpu_transfer_operation_counts": "unavailable_in_StepStats; CSV cells intentionally empty",
            "transfer_snapshot_semantics": "raw StepStats snapshots; hot-loop fields are cumulative",
            "phase_timing_semantics": "wall-time columns are host wall unless named device_elapsed; inclusive and device elapsed values remain separate and can overlap",
            "zero_semantics": "reported zero does not prove measured zero; treat as unavailable unless the realization wires that field"
        },
        "resources": {
            "sample_interval_seconds": 1,
            "samples_written": diagnostics.resource_rows_written,
            "cpu_percent_samples": diagnostics.cpu_percent_samples,
            "rss_samples": diagnostics.rss_samples,
            "gpu_samples": diagnostics.gpu_samples,
            "gpu_uuid_samples": diagnostics.gpu_uuid_samples,
            "gpu_error_entries": diagnostics.gpu_error_entries,
            "resource_error_count": diagnostics.resource_error_count,
            "gpu_scope": "whole_device_when_available",
            "gpu_unavailable_values": "JSON null with sampler errors preserved"
        },
        "artifacts": {
            "steps_csv": "performance/steps.csv",
            "resources_csv": "performance/resources.csv",
            "summary_json": "performance/summary.json",
            "steps_csv_opened": diagnostics.steps_file_opened,
            "resources_csv_opened": diagnostics.resources_file_opened
        },
        "writer": {
            "writer_error_count": diagnostics.writer_error_count,
            "writer_errors": diagnostics.writer_errors,
            "writer_start_error": snapshot.writer_start_error
        }
    })
}

fn flush_writer(
    writer: &mut Option<BufWriter<File>>,
    label: &str,
    diagnostics: &mut WriterDiagnostics,
) {
    let error = writer.as_mut().and_then(|stream| stream.flush().err());
    if let Some(error) = error {
        record_writer_error(diagnostics, format!("flush {label}: {error}"));
        *writer = None;
    }
}

fn record_writer_error(diagnostics: &mut WriterDiagnostics, message: String) {
    diagnostics.writer_error_count = diagnostics.writer_error_count.saturating_add(1);
    if diagnostics.writer_errors.len() < MAX_RECORDED_ERRORS {
        diagnostics.writer_errors.push(message);
    }
}

fn push_csv<T: Display>(line: &mut String, value: T) {
    use std::fmt::Write as _;
    if !line.is_empty() {
        line.push(',');
    }
    let _ = write!(line, "{value}");
}

fn push_csv_option<T: Display>(line: &mut String, value: Option<T>) {
    match value {
        Some(value) => push_csv(line, value),
        None => push_csv(line, ""),
    }
}

fn push_csv_quoted(line: &mut String, value: &str) {
    if !line.is_empty() {
        line.push(',');
    }
    line.push('"');
    for character in value.chars() {
        if character == '"' {
            line.push('"');
        }
        line.push(character);
    }
    line.push('"');
}

fn duration_ns(duration: Duration) -> u64 {
    duration.as_nanos().min(u128::from(u64::MAX)) as u64
}

fn unix_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn terminal_replay_latency_unavailable(identity: &Value) -> bool {
    let Some(step_capture) = identity.get("step_capture") else {
        return identity.get("step_capture_kind").and_then(Value::as_str)
            == Some("terminal_replay_no_callback");
    };
    if step_capture.as_str() == Some("terminal_replay_no_callback") {
        return true;
    }
    step_capture
        .as_object()
        .map(|fields| {
            fields
                .values()
                .any(|value| value.as_str() == Some("terminal_replay_no_callback"))
        })
        .unwrap_or(false)
}
