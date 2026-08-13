//! Cached-preview helpers for native FEM relaxation.
//!
//! These helpers keep display-quantity switching warm during relaxation
//! without making the dispatch layer own relaxation preview behavior.

use fullmag_ir::FemPlanIR;

use crate::dispatch::{flatten_vectors, FemEngine};
use crate::interactive_runtime::display_is_global_scalar;
use std::collections::{BTreeMap, VecDeque};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};

use crate::native_fem::{
    NativeFemBackend, NativeFemEnergyDensitySnapshot, NativeFemFieldSnapshot,
    NativeFemPreviewSnapshot,
};
use crate::quantities::{active_fem_preview_quantities, field_materialization_quantity_ids};
use crate::solver_profile::{current_thread_cpu_time_ns, elapsed_current_thread_cpu_ns};
use crate::types::{
    LiveFieldMaterializationState, LiveFieldMaterializationStatus, LivePreviewField,
    LivePreviewRequest, RunError,
};
use crate::DisplaySelectionState;

#[allow(unexpected_cfgs)]
mod nvtx_range {
    #[cfg(fullmag_enable_nvtx)]
    pub(super) struct Range(u64);

    #[cfg(not(fullmag_enable_nvtx))]
    pub(super) struct Range;

    impl Range {
        #[cfg(fullmag_enable_nvtx)]
        pub(super) fn new(name: &'static [u8]) -> Self {
            unsafe extern "C" {
                fn fullmag_fem_nvtx_range_start(name: *const std::ffi::c_char) -> u64;
            }
            debug_assert_eq!(name.last(), Some(&0));
            Self(unsafe { fullmag_fem_nvtx_range_start(name.as_ptr().cast()) })
        }

        #[cfg(not(fullmag_enable_nvtx))]
        pub(super) const fn new(_: &'static [u8]) -> Self {
            Self
        }
    }

    #[cfg(fullmag_enable_nvtx)]
    impl Drop for Range {
        fn drop(&mut self) {
            unsafe extern "C" {
                fn fullmag_fem_nvtx_range_end(id: u64);
            }
            unsafe { fullmag_fem_nvtx_range_end(self.0) };
        }
    }
}

#[derive(Default, Clone, Copy)]
pub(crate) struct FemPreviewHandoffTimings {
    pub(crate) harvest_query_wall_time_ns: u64,
    pub(crate) result_promotion_wall_time_ns: u64,
    pub(crate) can_accept_wall_time_ns: u64,
    pub(crate) vector_snapshot_schedule_wall_time_ns: u64,
    pub(crate) energy_snapshot_schedule_wall_time_ns: u64,
    pub(crate) queue_coalescing_wall_time_ns: u64,
    pub(crate) submit_wall_time_ns: u64,
    pub(crate) submit_stage_wall_time_ns: u64,
    pub(crate) submit_descriptor_wall_time_ns: u64,
    pub(crate) submit_channel_alloc_wall_time_ns: u64,
    pub(crate) submit_try_send_wall_time_ns: u64,
    pub(crate) submit_bookkeeping_wall_time_ns: u64,
    pub(crate) submit_thread_cpu_time_ns: u64,
}

impl FemPreviewHandoffTimings {
    pub(crate) fn record_into(self, stats: &mut crate::types::StepStats) {
        stats.preview_harvest_query_wall_time_ns = self.harvest_query_wall_time_ns;
        stats.preview_result_promotion_wall_time_ns = self.result_promotion_wall_time_ns;
        stats.preview_can_accept_wall_time_ns = self.can_accept_wall_time_ns;
        stats.preview_vector_snapshot_schedule_wall_time_ns =
            self.vector_snapshot_schedule_wall_time_ns;
        stats.preview_energy_snapshot_schedule_wall_time_ns =
            self.energy_snapshot_schedule_wall_time_ns;
        stats.preview_queue_coalescing_wall_time_ns = self.queue_coalescing_wall_time_ns;
        stats.preview_submit_wall_time_ns = self.submit_wall_time_ns;
        stats.preview_submit_stage_wall_time_ns = self.submit_stage_wall_time_ns;
        stats.preview_submit_descriptor_wall_time_ns = self.submit_descriptor_wall_time_ns;
        stats.preview_submit_channel_alloc_wall_time_ns = self.submit_channel_alloc_wall_time_ns;
        stats.preview_submit_try_send_wall_time_ns = self.submit_try_send_wall_time_ns;
        stats.preview_submit_bookkeeping_wall_time_ns = self.submit_bookkeeping_wall_time_ns;
        stats.preview_submit_thread_cpu_time_ns = self.submit_thread_cpu_time_ns;
    }
}

fn elapsed_ns(started: std::time::Instant) -> u64 {
    started.elapsed().as_nanos().min(u64::MAX as u128) as u64
}

#[derive(Debug, Clone, Copy)]
enum PreviewDestination {
    Active,
    Cache,
}

enum PendingFemPreviewJob {
    Vector {
        destination: PreviewDestination,
        quantity: String,
        request_revision: u64,
        source_step: u64,
        snapshot: NativeFemPreviewSnapshot,
        nvtx: nvtx_range::Range,
    },
    EnergyDensity {
        destination: PreviewDestination,
        quantity: String,
        request_revision: u64,
        source_step: u64,
        snapshot: NativeFemEnergyDensitySnapshot,
        nvtx: nvtx_range::Range,
    },
    #[cfg(test)]
    Test {
        destination: PreviewDestination,
        request_revision: u64,
        source_step: u64,
        delay: std::time::Duration,
        field: LivePreviewField,
    },
}

struct DeferredFemPreviewJob {
    destination: PreviewDestination,
    request: LivePreviewRequest,
    node_count: usize,
    source_step: u64,
    source_time: f64,
    solver_dt: f64,
}

struct DeferredLiveMagnetization {
    node_count: usize,
    source_step: u64,
    source_revision: u64,
}

struct DeferredFemSnapshotFrame {
    backend_ptr: usize,
    preview: Option<DeferredFemPreviewJob>,
    magnetization: Option<DeferredLiveMagnetization>,
    schedule_tx: SyncSender<()>,
    result_tx: SyncSender<PreviewFrameCompletion>,
    #[cfg(test)]
    scheduled_test_preview: Option<PendingFemPreviewJob>,
    #[cfg(test)]
    test_schedule_error: Option<(String, u64, u64, String)>,
    #[cfg(test)]
    test_schedule_delay: std::time::Duration,
}

impl PendingFemPreviewJob {
    fn pending_identity(&self) -> (&str, u64) {
        match self {
            Self::Vector {
                quantity,
                source_step,
                ..
            }
            | Self::EnergyDensity {
                quantity,
                source_step,
                ..
            } => (quantity, *source_step),
            #[cfg(test)]
            Self::Test {
                source_step, field, ..
            } => (&field.quantity, *source_step),
        }
    }

    fn request_revision(&self) -> u64 {
        match self {
            Self::Vector {
                request_revision, ..
            }
            | Self::EnergyDensity {
                request_revision, ..
            } => *request_revision,
            #[cfg(test)]
            Self::Test {
                request_revision, ..
            } => *request_revision,
        }
    }

    fn materialize(self) -> Result<PreviewResult, RunError> {
        let started = std::time::Instant::now();
        let (destination, request_revision, source_step, mut field) = match self {
            Self::Vector {
                destination,
                quantity: _,
                request_revision,
                source_step,
                snapshot,
                nvtx: _nvtx,
            } => (
                destination,
                request_revision,
                source_step,
                snapshot.into_live_preview_field()?,
            ),
            Self::EnergyDensity {
                destination,
                quantity: _,
                request_revision,
                source_step,
                snapshot,
                nvtx: _nvtx,
            } => (
                destination,
                request_revision,
                source_step,
                snapshot.into_live_preview_field()?,
            ),
            #[cfg(test)]
            Self::Test {
                destination,
                request_revision,
                source_step,
                delay,
                field,
            } => {
                std::thread::sleep(delay);
                (destination, request_revision, source_step, field)
            }
        };
        field.source_step = source_step;
        field.source_revision = request_revision;
        field.materialized_at_unix_ms = unix_time_ms();
        let materialization_wall_time_ns = started.elapsed().as_nanos() as u64;
        field.materialization_wall_time_ns = materialization_wall_time_ns;
        Ok(PreviewResult {
            destination,
            request_revision,
            source_step,
            materialization_wall_time_ns,
            field,
        })
    }
}

struct PreviewResult {
    destination: PreviewDestination,
    request_revision: u64,
    source_step: u64,
    materialization_wall_time_ns: u64,
    field: LivePreviewField,
}

struct PreviewCompletion {
    quantity: String,
    source_step: u64,
    request_revision: u64,
    result: Result<PreviewResult, RunError>,
}

struct PreviewFrameCompletion {
    preview: Option<PreviewCompletion>,
    magnetization: Option<Result<FemLiveMagnetizationPayload, RunError>>,
    magnetization_identity: Option<(u64, u64)>,
}

fn schedule_preview_job(
    backend: &NativeFemBackend,
    deferred: DeferredFemPreviewJob,
) -> Result<PendingFemPreviewJob, RunError> {
    let nvtx = nvtx_range::Range::new(b"fem.preview.snapshot\0");
    if let Some(snapshot) = backend.begin_energy_density_snapshot(
        &deferred.request,
        deferred.node_count,
        deferred.source_step,
        deferred.source_time,
        deferred.solver_dt,
    )? {
        return Ok(PendingFemPreviewJob::EnergyDensity {
            destination: deferred.destination,
            quantity: deferred.request.quantity,
            request_revision: deferred.request.revision,
            source_step: deferred.source_step,
            snapshot,
            nvtx,
        });
    }
    Ok(PendingFemPreviewJob::Vector {
        destination: deferred.destination,
        quantity: deferred.request.quantity.clone(),
        request_revision: deferred.request.revision,
        source_step: deferred.source_step,
        snapshot: backend.begin_live_preview_snapshot(&deferred.request)?,
        nvtx,
    })
}

fn materialize_magnetization(
    snapshot: NativeFemFieldSnapshot,
    deferred: DeferredLiveMagnetization,
) -> Result<FemLiveMagnetizationPayload, RunError> {
    let copy_start = std::time::Instant::now();
    let magnetization = snapshot.into_vector_field()?;
    if magnetization.len() != deferred.node_count {
        return Err(RunError {
            message: format!(
                "native FEM magnetization payload returned {} nodes, expected {}",
                magnetization.len(),
                deferred.node_count
            ),
        });
    }
    let payload = flatten_vectors(&magnetization);
    let field_copy_wall_time_ns = elapsed_ns(copy_start);
    let field_copy_bytes = (payload.len() as u64).saturating_mul(std::mem::size_of::<f64>() as u64);
    Ok(FemLiveMagnetizationPayload {
        values: payload,
        source_step: deferred.source_step,
        source_revision: deferred.source_revision,
        materialized_at_unix_ms: unix_time_ms(),
        materialization_wall_time_ns: field_copy_wall_time_ns,
        field_copy_bytes,
    })
}

pub(crate) struct PendingFemPreviewState {
    job_tx: Option<SyncSender<DeferredFemSnapshotFrame>>,
    schedule_rx: Option<Receiver<()>>,
    result_rx: Option<Receiver<PreviewFrameCompletion>>,
    in_flight: Option<(String, u64, u64)>,
    magnetization_in_flight: Option<(u64, u64)>,
    staged_preview: Option<DeferredFemPreviewJob>,
    staged_magnetization: Option<DeferredLiveMagnetization>,
    worker: Option<std::thread::JoinHandle<()>>,
}

const MAX_TEST_MATERIALIZATION_DELAY_MS: u64 = 1_000;

fn parse_test_materialization_delay(
    test_hooks_enabled: bool,
    raw_delay_ms: Option<&str>,
) -> Option<std::time::Duration> {
    test_hooks_enabled
        .then_some(raw_delay_ms?)
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|delay_ms| (1..=MAX_TEST_MATERIALIZATION_DELAY_MS).contains(delay_ms))
        .map(std::time::Duration::from_millis)
}

fn configured_test_materialization_delay() -> Option<std::time::Duration> {
    parse_test_materialization_delay(
        std::env::var("FULLMAG_ENABLE_TEST_HOOKS").as_deref() == Ok("1"),
        std::env::var("FULLMAG_TEST_FEM_PREVIEW_MATERIALIZATION_DELAY_MS")
            .ok()
            .as_deref(),
    )
}

fn configured_test_schedule_delay() -> Option<std::time::Duration> {
    parse_test_materialization_delay(
        std::env::var("FULLMAG_ENABLE_TEST_HOOKS").as_deref() == Ok("1"),
        std::env::var("FULLMAG_TEST_FEM_PREVIEW_SCHEDULE_DELAY_MS")
            .ok()
            .as_deref(),
    )
}

fn try_send_worker_output<T>(sender: &SyncSender<T>, value: T) -> bool {
    sender.try_send(value).is_ok()
}

impl Default for PendingFemPreviewState {
    fn default() -> Self {
        let (job_tx, job_rx) = mpsc::sync_channel::<DeferredFemSnapshotFrame>(1);
        let test_materialization_delay = configured_test_materialization_delay();
        let test_schedule_delay = configured_test_schedule_delay();
        let worker = std::thread::Builder::new()
            .name("fullmag-fem-preview-materializer".to_string())
            .spawn(move || {
                while let Ok(mut frame) = job_rx.recv() {
                    if let Some(delay) = test_schedule_delay {
                        std::thread::sleep(delay);
                    }
                    #[cfg(test)]
                    if !frame.test_schedule_delay.is_zero() {
                        std::thread::sleep(frame.test_schedule_delay);
                    }
                    let needs_backend = frame.preview.is_some() || frame.magnetization.is_some();
                    // SAFETY: production frames retain a backend owned by the
                    // solver for the entire handoff lifetime and fence this
                    // scheduling acknowledgement before the next native step
                    // can mutate device-resident state. Test-only pre-scheduled
                    // jobs do not dereference the null sentinel.
                    let backend = needs_backend
                        .then(|| unsafe { &*(frame.backend_ptr as *const NativeFemBackend) });
                    let preview_identity = frame.preview.as_ref().map(|job| {
                        (
                            job.request.quantity.clone(),
                            job.source_step,
                            job.request.revision,
                        )
                    });
                    #[cfg(test)]
                    let preview_identity = frame
                        .test_schedule_error
                        .as_ref()
                        .map(|(quantity, source_step, request_revision, _)| {
                            (quantity.clone(), *source_step, *request_revision)
                        })
                        .or(preview_identity);
                    let magnetization_identity = frame
                        .magnetization
                        .as_ref()
                        .map(|job| (job.source_step, job.source_revision));
                    #[cfg(test)]
                    let scheduled_preview = if let Some(job) = frame.scheduled_test_preview.take() {
                        Some(Ok(job))
                    } else if let Some((_, _, _, message)) = frame.test_schedule_error.take() {
                        Some(Err(RunError { message }))
                    } else {
                        frame.preview.take().map(|deferred| {
                            schedule_preview_job(
                                backend.expect("production preview frame backend"),
                                deferred,
                            )
                        })
                    };
                    #[cfg(not(test))]
                    let scheduled_preview = frame.preview.take().map(|deferred| {
                        schedule_preview_job(
                            backend.expect("production preview frame backend"),
                            deferred,
                        )
                    });
                    let scheduled_magnetization = frame.magnetization.take().map(|deferred| {
                        let nvtx = nvtx_range::Range::new(b"fem.preview.snapshot\0");
                        let scheduled = backend
                            .expect("production magnetization frame backend")
                            .begin_field_snapshot("m", deferred.source_step, 0.0, 0.0);
                        (deferred, scheduled, nvtx)
                    });
                    if !try_send_worker_output(&frame.schedule_tx, ()) {
                        break;
                    }
                    if let Some(delay) = test_materialization_delay {
                        std::thread::sleep(delay);
                    }
                    let preview = scheduled_preview.map(|scheduled| match scheduled {
                        Ok(job) => {
                            let (quantity, source_step) = job.pending_identity();
                            let quantity = quantity.to_string();
                            let request_revision = job.request_revision();
                            PreviewCompletion {
                                quantity,
                                source_step,
                                request_revision,
                                result: job.materialize(),
                            }
                        }
                        Err(error) => {
                            let in_flight = preview_identity
                                .clone()
                                .unwrap_or_else(|| ("preview".to_string(), 0, 0));
                            PreviewCompletion {
                                quantity: in_flight.0,
                                source_step: in_flight.1,
                                request_revision: in_flight.2,
                                result: Err(error),
                            }
                        }
                    });
                    let magnetization =
                        scheduled_magnetization.map(|(deferred, scheduled, _nvtx)| {
                            scheduled
                                .and_then(|snapshot| materialize_magnetization(snapshot, deferred))
                        });
                    let completion = PreviewFrameCompletion {
                        preview,
                        magnetization,
                        magnetization_identity,
                    };
                    if !try_send_worker_output(&frame.result_tx, completion) {
                        break;
                    }
                }
            })
            .expect("spawn bounded FEM preview materializer");
        Self {
            job_tx: Some(job_tx),
            schedule_rx: None,
            result_rx: None,
            in_flight: None,
            magnetization_in_flight: None,
            staged_preview: None,
            staged_magnetization: None,
            worker: Some(worker),
        }
    }
}

impl Drop for PendingFemPreviewState {
    fn drop(&mut self) {
        self.job_tx.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl PendingFemPreviewState {
    pub(crate) fn can_accept(&self) -> bool {
        self.in_flight.is_none()
            && self.magnetization_in_flight.is_none()
            && self.staged_preview.is_none()
    }

    fn can_accept_magnetization(&self) -> bool {
        self.in_flight.is_none()
            && self.magnetization_in_flight.is_none()
            && self.staged_magnetization.is_none()
    }

    fn pending_step(&self, quantity: &str) -> Option<u64> {
        self.in_flight
            .as_ref()
            .filter(|(pending_quantity, _, _)| pending_quantity == quantity)
            .map(|(_, source_step, _)| *source_step)
    }

    fn stage_preview(&mut self, job: DeferredFemPreviewJob) -> Result<(), DeferredFemPreviewJob> {
        if !self.can_accept() {
            return Err(job);
        }
        self.staged_preview = Some(job);
        Ok(())
    }

    fn stage_magnetization(
        &mut self,
        job: DeferredLiveMagnetization,
    ) -> Result<(), DeferredLiveMagnetization> {
        if !self.can_accept_magnetization() {
            return Err(job);
        }
        self.staged_magnetization = Some(job);
        Ok(())
    }

    fn dispatch_staged(
        &mut self,
        backend: &NativeFemBackend,
        timings: &mut FemPreviewHandoffTimings,
    ) -> bool {
        if self.staged_preview.is_none() && self.staged_magnetization.is_none() {
            return true;
        }
        let Some(job_tx) = self.job_tx.as_ref() else {
            let bookkeeping_started = std::time::Instant::now();
            self.staged_preview = None;
            self.staged_magnetization = None;
            timings.submit_bookkeeping_wall_time_ns = timings
                .submit_bookkeeping_wall_time_ns
                .saturating_add(elapsed_ns(bookkeeping_started));
            return false;
        };
        let descriptor_started = std::time::Instant::now();
        let pending_identity = self.staged_preview.as_ref().map(|job| {
            (
                job.request.quantity.clone(),
                job.source_step,
                job.request.revision,
            )
        });
        let pending_magnetization = self
            .staged_magnetization
            .as_ref()
            .map(|job| (job.source_step, job.source_revision));
        timings.submit_descriptor_wall_time_ns = timings
            .submit_descriptor_wall_time_ns
            .saturating_add(elapsed_ns(descriptor_started));
        let channel_alloc_started = std::time::Instant::now();
        let (schedule_tx, schedule_rx) = mpsc::sync_channel(1);
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        timings.submit_channel_alloc_wall_time_ns = timings
            .submit_channel_alloc_wall_time_ns
            .saturating_add(elapsed_ns(channel_alloc_started));
        let descriptor_started = std::time::Instant::now();
        let frame = DeferredFemSnapshotFrame {
            backend_ptr: backend as *const NativeFemBackend as usize,
            preview: self.staged_preview.take(),
            magnetization: self.staged_magnetization.take(),
            schedule_tx,
            result_tx,
            #[cfg(test)]
            scheduled_test_preview: None,
            #[cfg(test)]
            test_schedule_error: None,
            #[cfg(test)]
            test_schedule_delay: std::time::Duration::ZERO,
        };
        timings.submit_descriptor_wall_time_ns = timings
            .submit_descriptor_wall_time_ns
            .saturating_add(elapsed_ns(descriptor_started));
        let try_send_started = std::time::Instant::now();
        let send_result = job_tx.try_send(frame);
        timings.submit_try_send_wall_time_ns = timings
            .submit_try_send_wall_time_ns
            .saturating_add(elapsed_ns(try_send_started));
        let bookkeeping_started = std::time::Instant::now();
        let submitted = match send_result {
            Ok(()) => {
                self.in_flight = pending_identity;
                self.magnetization_in_flight = pending_magnetization;
                self.schedule_rx = Some(schedule_rx);
                self.result_rx = Some(result_rx);
                true
            }
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => false,
        };
        timings.submit_bookkeeping_wall_time_ns = timings
            .submit_bookkeeping_wall_time_ns
            .saturating_add(elapsed_ns(bookkeeping_started));
        submitted
    }

    fn flush_schedule(&mut self) -> u64 {
        let Some(schedule_rx) = self.schedule_rx.take() else {
            return 0;
        };
        let started = std::time::Instant::now();
        let _ = schedule_rx.recv();
        elapsed_ns(started)
    }

    fn take_completed_until(
        &mut self,
        deadline: std::time::Instant,
    ) -> Option<PreviewFrameCompletion> {
        let frame_identity = self
            .in_flight
            .as_ref()
            .map(|(quantity, source_step, request_revision)| {
                format!("{quantity}@{source_step}/r{request_revision}")
            })
            .or_else(|| {
                self.magnetization_in_flight
                    .map(|(source_step, request_revision)| {
                        format!("m@{source_step}/r{request_revision}")
                    })
            })
            .unwrap_or_else(|| "unknown".to_string());
        if let Some(schedule_rx) = self.schedule_rx.take() {
            let ack_started = std::time::Instant::now();
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            match schedule_rx.recv_timeout(remaining) {
                Ok(()) => {
                    eprintln!(
                        "[fullmag-runner] native-fem terminal preview frame: frame={frame_identity} schedule_accepted=true ack=received ack_wait_ns={} deadline_remaining_ms={}",
                        elapsed_ns(ack_started),
                        deadline
                            .saturating_duration_since(std::time::Instant::now())
                            .as_millis(),
                    );
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    eprintln!(
                        "[fullmag-runner] native-fem terminal preview frame: frame={frame_identity} schedule_accepted=true ack=timeout ack_wait_ns={} deadline_remaining_ms=0",
                        elapsed_ns(ack_started),
                    );
                    self.schedule_rx = Some(schedule_rx);
                    return None;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    eprintln!(
                        "[fullmag-runner] native-fem terminal preview frame: frame={frame_identity} schedule_accepted=true ack=disconnected ack_wait_ns={} deadline_remaining_ms={}",
                        elapsed_ns(ack_started),
                        deadline
                            .saturating_duration_since(std::time::Instant::now())
                            .as_millis(),
                    );
                }
            }
        }

        let result_rx = self.result_rx.take()?;
        let result_started = std::time::Instant::now();
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        match result_rx.recv_timeout(remaining) {
            Ok(result) => {
                eprintln!(
                    "[fullmag-runner] native-fem terminal preview frame: frame={frame_identity} completion=received result_wait_ns={} deadline_remaining_ms={}",
                    elapsed_ns(result_started),
                    deadline
                        .saturating_duration_since(std::time::Instant::now())
                        .as_millis(),
                );
                self.in_flight = None;
                self.magnetization_in_flight = None;
                Some(result)
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                eprintln!(
                    "[fullmag-runner] native-fem terminal preview frame: frame={frame_identity} completion=timeout result_wait_ns={} deadline_remaining_ms=0",
                    elapsed_ns(result_started),
                );
                self.result_rx = Some(result_rx);
                None
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                eprintln!(
                    "[fullmag-runner] native-fem terminal preview frame: frame={frame_identity} completion=disconnected result_wait_ns={} deadline_remaining_ms={}",
                    elapsed_ns(result_started),
                    deadline
                        .saturating_duration_since(std::time::Instant::now())
                        .as_millis(),
                );
                let preview =
                    self.in_flight
                        .take()
                        .map(
                            |(quantity, source_step, request_revision)| PreviewCompletion {
                                quantity,
                                source_step,
                                request_revision,
                                result: Err(RunError {
                                    message: "FEM preview materializer disconnected".to_string(),
                                }),
                            },
                        );
                let magnetization_identity = self.magnetization_in_flight.take();
                let magnetization = magnetization_identity.map(|_| {
                    Err(RunError {
                        message: "FEM preview materializer disconnected".to_string(),
                    })
                });
                (preview.is_some() || magnetization.is_some()).then_some(PreviewFrameCompletion {
                    preview,
                    magnetization,
                    magnetization_identity,
                })
            }
        }
    }

    fn has_pending(&self) -> bool {
        self.in_flight.is_some()
            || self.magnetization_in_flight.is_some()
            || self.staged_preview.is_some()
            || self.staged_magnetization.is_some()
            || self.schedule_rx.is_some()
            || self.result_rx.is_some()
    }

    fn try_take_completed(&mut self) -> Option<PreviewFrameCompletion> {
        let result = self.result_rx.as_ref()?.try_recv();
        match result {
            Ok(result) => {
                self.result_rx = None;
                self.in_flight = None;
                self.magnetization_in_flight = None;
                Some(result)
            }
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => {
                self.result_rx = None;
                let preview =
                    self.in_flight
                        .take()
                        .map(
                            |(quantity, source_step, request_revision)| PreviewCompletion {
                                quantity,
                                source_step,
                                request_revision,
                                result: Err(RunError {
                                    message: "FEM preview materializer disconnected".to_string(),
                                }),
                            },
                        );
                let magnetization_identity = self.magnetization_in_flight.take();
                let magnetization = magnetization_identity.map(|_| {
                    Err(RunError {
                        message: "FEM preview materializer disconnected".to_string(),
                    })
                });
                (preview.is_some() || magnetization.is_some()).then_some(PreviewFrameCompletion {
                    preview,
                    magnetization,
                    magnetization_identity,
                })
            }
        }
    }

    #[cfg(test)]
    fn submit_scheduled_test(
        &mut self,
        job: PendingFemPreviewJob,
        schedule_delay: std::time::Duration,
    ) -> bool {
        if !self.can_accept() {
            return false;
        }
        let (quantity, source_step) = job.pending_identity();
        let pending_identity = (quantity.to_string(), source_step, job.request_revision());
        let Some(job_tx) = self.job_tx.as_ref() else {
            return false;
        };
        let (schedule_tx, schedule_rx) = mpsc::sync_channel(1);
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        let frame = DeferredFemSnapshotFrame {
            backend_ptr: 0,
            preview: None,
            magnetization: None,
            schedule_tx,
            result_tx,
            scheduled_test_preview: Some(job),
            test_schedule_error: None,
            test_schedule_delay: schedule_delay,
        };
        if job_tx.try_send(frame).is_err() {
            return false;
        }
        self.in_flight = Some(pending_identity);
        self.schedule_rx = Some(schedule_rx);
        self.result_rx = Some(result_rx);
        true
    }

    #[cfg(test)]
    fn submit_schedule_error_test(
        &mut self,
        quantity: &str,
        source_step: u64,
        request_revision: u64,
        message: &str,
    ) -> bool {
        if !self.can_accept() {
            return false;
        }
        let Some(job_tx) = self.job_tx.as_ref() else {
            return false;
        };
        let (schedule_tx, schedule_rx) = mpsc::sync_channel(1);
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        let frame = DeferredFemSnapshotFrame {
            backend_ptr: 0,
            preview: None,
            magnetization: None,
            schedule_tx,
            result_tx,
            scheduled_test_preview: None,
            test_schedule_error: Some((
                quantity.to_string(),
                source_step,
                request_revision,
                message.to_string(),
            )),
            test_schedule_delay: std::time::Duration::ZERO,
        };
        if job_tx.try_send(frame).is_err() {
            return false;
        }
        self.in_flight = Some((quantity.to_string(), source_step, request_revision));
        self.schedule_rx = Some(schedule_rx);
        self.result_rx = Some(result_rx);
        true
    }
}

fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[derive(Default)]
pub(crate) struct FemPreviewHandoff {
    pending: PendingFemPreviewState,
    cache_queue: VecDeque<LivePreviewRequest>,
    materialization_states: BTreeMap<String, LiveFieldMaterializationStatus>,
    active_ready: Option<LivePreviewField>,
    cached_ready: Vec<LivePreviewField>,
    magnetization_ready: Option<FemLiveMagnetizationPayload>,
    next_magnetization_revision: u64,
    preview_superseded_count: u64,
    timings: FemPreviewHandoffTimings,
}

pub(crate) struct TerminalFemPreviewPublication {
    pub(crate) cached_fields: Option<Vec<LivePreviewField>>,
    pub(crate) magnetization: Option<FemLiveMagnetizationPayload>,
    pub(crate) materialization_states: Vec<LiveFieldMaterializationStatus>,
    pub(crate) wall_time_ns: u64,
}

impl FemPreviewHandoff {
    fn harvest_completed(&mut self) -> Result<(), RunError> {
        let query_started = std::time::Instant::now();
        let completion = self.pending.try_take_completed();
        self.timings.harvest_query_wall_time_ns = self
            .timings
            .harvest_query_wall_time_ns
            .saturating_add(elapsed_ns(query_started));
        let Some(mut completion) = completion else {
            return Ok(());
        };
        self.promote_completion(&mut completion)
    }

    fn promote_completion(
        &mut self,
        completion: &mut PreviewFrameCompletion,
    ) -> Result<(), RunError> {
        let promotion_started = std::time::Instant::now();
        if let Some(magnetization) = completion.magnetization.take() {
            match magnetization {
                Ok(payload) => self.magnetization_ready = Some(payload),
                Err(error) => {
                    let (source_step, request_revision) =
                        completion.magnetization_identity.unwrap_or_default();
                    self.materialization_states.insert(
                        "m".to_string(),
                        LiveFieldMaterializationStatus {
                            quantity: "m".to_string(),
                            source_step,
                            request_revision,
                            state: LiveFieldMaterializationState::Error,
                            error: Some(error.message),
                        },
                    );
                }
            }
        }
        let Some(completion) = completion.preview.take() else {
            self.timings.result_promotion_wall_time_ns = self
                .timings
                .result_promotion_wall_time_ns
                .saturating_add(elapsed_ns(promotion_started));
            return Ok(());
        };
        let result = match completion.result {
            Ok(result) => result,
            Err(error) => {
                self.materialization_states.insert(
                    completion.quantity.clone(),
                    LiveFieldMaterializationStatus {
                        quantity: completion.quantity,
                        source_step: completion.source_step,
                        request_revision: completion.request_revision,
                        state: LiveFieldMaterializationState::Error,
                        error: Some(error.message),
                    },
                );
                self.timings.result_promotion_wall_time_ns = self
                    .timings
                    .result_promotion_wall_time_ns
                    .saturating_add(elapsed_ns(promotion_started));
                return Ok(());
            }
        };
        debug_assert_eq!(result.field.source_revision, result.request_revision);
        debug_assert_eq!(result.field.source_step, result.source_step);
        debug_assert_eq!(
            result.field.materialization_wall_time_ns,
            result.materialization_wall_time_ns
        );
        self.materialization_states.insert(
            result.field.quantity.clone(),
            LiveFieldMaterializationStatus {
                quantity: result.field.quantity.clone(),
                source_step: result.source_step,
                request_revision: result.request_revision,
                state: LiveFieldMaterializationState::Complete,
                error: None,
            },
        );
        match result.destination {
            PreviewDestination::Active => self.active_ready = Some(result.field),
            PreviewDestination::Cache => self.cached_ready.push(result.field),
        }
        self.timings.result_promotion_wall_time_ns = self
            .timings
            .result_promotion_wall_time_ns
            .saturating_add(elapsed_ns(promotion_started));
        Ok(())
    }

    fn submit_request(
        &mut self,
        request: &LivePreviewRequest,
        node_count: usize,
        source_step: u64,
        source_time: f64,
        solver_dt: f64,
        destination: PreviewDestination,
    ) -> Result<(), RunError> {
        let can_accept_started = std::time::Instant::now();
        let can_accept = self.pending.can_accept();
        self.timings.can_accept_wall_time_ns = self
            .timings
            .can_accept_wall_time_ns
            .saturating_add(elapsed_ns(can_accept_started));
        if !can_accept {
            self.preview_superseded_count = self.preview_superseded_count.saturating_add(1);
            self.materialization_states.insert(
                request.quantity.clone(),
                LiveFieldMaterializationStatus {
                    quantity: request.quantity.clone(),
                    source_step,
                    request_revision: request.revision,
                    state: LiveFieldMaterializationState::Superseded,
                    error: None,
                },
            );
            return Ok(());
        }
        let submit_started = std::time::Instant::now();
        let submit_cpu_started = current_thread_cpu_time_ns();
        let descriptor_started = std::time::Instant::now();
        let job = DeferredFemPreviewJob {
            destination,
            request: request.clone(),
            node_count,
            source_step,
            source_time,
            solver_dt,
        };
        self.timings.submit_descriptor_wall_time_ns = self
            .timings
            .submit_descriptor_wall_time_ns
            .saturating_add(elapsed_ns(descriptor_started));
        let stage_started = std::time::Instant::now();
        let submitted = self.pending.stage_preview(job).is_ok();
        self.timings.submit_stage_wall_time_ns = self
            .timings
            .submit_stage_wall_time_ns
            .saturating_add(elapsed_ns(stage_started));
        self.timings.submit_wall_time_ns = self
            .timings
            .submit_wall_time_ns
            .saturating_add(elapsed_ns(submit_started));
        self.timings.submit_thread_cpu_time_ns = self
            .timings
            .submit_thread_cpu_time_ns
            .saturating_add(elapsed_current_thread_cpu_ns(submit_cpu_started));
        if !submitted {
            self.preview_superseded_count = self.preview_superseded_count.saturating_add(1);
            self.materialization_states.insert(
                request.quantity.clone(),
                LiveFieldMaterializationStatus {
                    quantity: request.quantity.clone(),
                    source_step,
                    request_revision: request.revision,
                    state: LiveFieldMaterializationState::Superseded,
                    error: None,
                },
            );
        } else {
            self.materialization_states.insert(
                request.quantity.clone(),
                LiveFieldMaterializationStatus {
                    quantity: request.quantity.clone(),
                    source_step,
                    request_revision: request.revision,
                    state: LiveFieldMaterializationState::Pending,
                    error: None,
                },
            );
        }
        Ok(())
    }

    pub(crate) fn poll_active(&mut self) -> Result<Option<LivePreviewField>, RunError> {
        self.harvest_completed()?;
        Ok(self.active_ready.take())
    }

    pub(crate) fn request_preview(
        &mut self,
        _backend: &NativeFemBackend,
        request: &LivePreviewRequest,
        node_count: usize,
        source_step: u64,
        source_time: f64,
        solver_dt: f64,
    ) -> Result<Option<LivePreviewField>, RunError> {
        self.harvest_completed()?;
        self.submit_request(
            request,
            node_count,
            source_step,
            source_time,
            solver_dt,
            PreviewDestination::Active,
        )?;
        Ok(self.active_ready.take())
    }

    fn submit_next_cached(
        &mut self,
        _backend: &NativeFemBackend,
        node_count: usize,
        source_step: u64,
        source_time: f64,
        solver_dt: f64,
    ) -> Result<(), RunError> {
        let can_accept_started = std::time::Instant::now();
        let can_accept = self.pending.can_accept();
        self.timings.can_accept_wall_time_ns = self
            .timings
            .can_accept_wall_time_ns
            .saturating_add(elapsed_ns(can_accept_started));
        if !can_accept {
            return Ok(());
        }
        let Some(request) = self.cache_queue.pop_front() else {
            return Ok(());
        };
        self.submit_request(
            &request,
            node_count,
            source_step,
            source_time,
            solver_dt,
            PreviewDestination::Cache,
        )
    }

    fn start_cache_cycle(&mut self, requests: VecDeque<LivePreviewRequest>, source_step: u64) {
        let started = std::time::Instant::now();
        let request_order = requests
            .iter()
            .map(|request| request.quantity.clone())
            .collect::<Vec<_>>();
        let mut refreshed = requests
            .into_iter()
            .map(|request| (request.quantity.clone(), request))
            .collect::<BTreeMap<_, _>>();
        let mut next_queue = VecDeque::new();
        for queued in self.cache_queue.drain(..) {
            if let Some(request) = refreshed.remove(&queued.quantity) {
                next_queue.push_back(request);
                continue;
            }
            self.preview_superseded_count = self.preview_superseded_count.saturating_add(1);
            self.materialization_states.insert(
                queued.quantity.clone(),
                LiveFieldMaterializationStatus {
                    quantity: queued.quantity,
                    source_step,
                    request_revision: queued.revision,
                    state: LiveFieldMaterializationState::Superseded,
                    error: None,
                },
            );
        }
        for quantity in request_order {
            if let Some(request) = refreshed.remove(&quantity) {
                next_queue.push_back(request);
            }
        }
        self.cache_queue = next_queue;
        self.timings.queue_coalescing_wall_time_ns = self
            .timings
            .queue_coalescing_wall_time_ns
            .saturating_add(elapsed_ns(started));
    }

    pub(crate) fn poll_cached(
        &mut self,
        backend: &NativeFemBackend,
        node_count: usize,
        source_step: u64,
        source_time: f64,
        solver_dt: f64,
    ) -> Result<Option<Vec<LivePreviewField>>, RunError> {
        self.harvest_completed()?;
        self.submit_next_cached(backend, node_count, source_step, source_time, solver_dt)?;
        if self.cached_ready.is_empty() {
            Ok(None)
        } else {
            Ok(Some(std::mem::take(&mut self.cached_ready)))
        }
    }

    pub(crate) fn request_cached_previews(
        &mut self,
        backend: &NativeFemBackend,
        engine: FemEngine,
        display_selection: &DisplaySelectionState,
        plan: &FemPlanIR,
        node_count: usize,
        source_step: u64,
        source_time: f64,
        solver_dt: f64,
    ) -> Result<Option<Vec<LivePreviewField>>, RunError> {
        self.harvest_completed()?;
        let materialization_quantities = field_materialization_quantity_ids();
        let quantities = active_fem_preview_quantities(engine, plan, &materialization_quantities);
        let base_request = display_selection.preview_request();
        let requests = quantities
            .into_iter()
            .map(|quantity| {
                let mut request = base_request.clone();
                request.quantity = quantity.to_string();
                request
            })
            .collect();
        self.start_cache_cycle(requests, source_step);
        self.submit_next_cached(backend, node_count, source_step, source_time, solver_dt)?;
        if self.cached_ready.is_empty() {
            Ok(None)
        } else {
            Ok(Some(std::mem::take(&mut self.cached_ready)))
        }
    }

    pub(crate) fn take_superseded_count(&mut self) -> u64 {
        std::mem::take(&mut self.preview_superseded_count)
    }

    pub(crate) fn materialization_states(&self) -> Vec<LiveFieldMaterializationStatus> {
        self.materialization_states.values().cloned().collect()
    }

    pub(crate) fn request_magnetization(
        &mut self,
        node_count: usize,
        source_step: u64,
    ) -> Result<Option<FemLiveMagnetizationPayload>, RunError> {
        self.harvest_completed()?;
        let ready = self.magnetization_ready.take();
        self.next_magnetization_revision = self.next_magnetization_revision.saturating_add(1);
        let request_revision = self.next_magnetization_revision;
        let deferred = DeferredLiveMagnetization {
            node_count,
            source_step,
            source_revision: request_revision,
        };
        if self.pending.stage_magnetization(deferred).is_err() {
            self.preview_superseded_count = self.preview_superseded_count.saturating_add(1);
            self.materialization_states.insert(
                "m".to_string(),
                LiveFieldMaterializationStatus {
                    quantity: "m".to_string(),
                    source_step,
                    request_revision,
                    state: LiveFieldMaterializationState::Superseded,
                    error: None,
                },
            );
        } else {
            self.materialization_states.insert(
                "m".to_string(),
                LiveFieldMaterializationStatus {
                    quantity: "m".to_string(),
                    source_step,
                    request_revision,
                    state: LiveFieldMaterializationState::Pending,
                    error: None,
                },
            );
        }
        Ok(ready)
    }

    pub(crate) fn poll_magnetization(
        &mut self,
    ) -> Result<Option<FemLiveMagnetizationPayload>, RunError> {
        self.harvest_completed()?;
        Ok(self.magnetization_ready.take())
    }

    pub(crate) fn dispatch_staged(&mut self, backend: &NativeFemBackend) {
        let submit_started = std::time::Instant::now();
        let submit_cpu_started = current_thread_cpu_time_ns();
        let descriptor_started = std::time::Instant::now();
        let preview_identity = self.pending.staged_preview.as_ref().map(|job| {
            (
                job.request.quantity.clone(),
                job.source_step,
                job.request.revision,
            )
        });
        let magnetization_identity = self
            .pending
            .staged_magnetization
            .as_ref()
            .map(|job| (job.source_step, job.source_revision));
        self.timings.submit_descriptor_wall_time_ns = self
            .timings
            .submit_descriptor_wall_time_ns
            .saturating_add(elapsed_ns(descriptor_started));
        let submitted = self.pending.dispatch_staged(backend, &mut self.timings);
        if !submitted {
            let bookkeeping_started = std::time::Instant::now();
            if let Some((quantity, source_step, request_revision)) = preview_identity {
                self.preview_superseded_count = self.preview_superseded_count.saturating_add(1);
                self.materialization_states.insert(
                    quantity.clone(),
                    LiveFieldMaterializationStatus {
                        quantity,
                        source_step,
                        request_revision,
                        state: LiveFieldMaterializationState::Superseded,
                        error: None,
                    },
                );
            }
            if let Some((source_step, request_revision)) = magnetization_identity {
                self.preview_superseded_count = self.preview_superseded_count.saturating_add(1);
                self.materialization_states.insert(
                    "m".to_string(),
                    LiveFieldMaterializationStatus {
                        quantity: "m".to_string(),
                        source_step,
                        request_revision,
                        state: LiveFieldMaterializationState::Superseded,
                        error: None,
                    },
                );
            }
            self.timings.submit_bookkeeping_wall_time_ns = self
                .timings
                .submit_bookkeeping_wall_time_ns
                .saturating_add(elapsed_ns(bookkeeping_started));
        }
        self.timings.submit_wall_time_ns = self
            .timings
            .submit_wall_time_ns
            .saturating_add(elapsed_ns(submit_started));
        self.timings.submit_thread_cpu_time_ns = self
            .timings
            .submit_thread_cpu_time_ns
            .saturating_add(elapsed_current_thread_cpu_ns(submit_cpu_started));
    }

    pub(crate) fn flush_schedule_fence(&mut self) -> u64 {
        self.pending.flush_schedule()
    }

    fn mark_unresolved_terminal_error(&mut self, message: &str) {
        if let Some((quantity, source_step, request_revision)) = self.pending.in_flight.as_ref() {
            self.materialization_states.insert(
                quantity.clone(),
                LiveFieldMaterializationStatus {
                    quantity: quantity.clone(),
                    source_step: *source_step,
                    request_revision: *request_revision,
                    state: LiveFieldMaterializationState::Error,
                    error: Some(message.to_string()),
                },
            );
        }
        if let Some(job) = self.pending.staged_preview.as_ref() {
            self.materialization_states.insert(
                job.request.quantity.clone(),
                LiveFieldMaterializationStatus {
                    quantity: job.request.quantity.clone(),
                    source_step: job.source_step,
                    request_revision: job.request.revision,
                    state: LiveFieldMaterializationState::Error,
                    error: Some(message.to_string()),
                },
            );
        }
        if let Some((source_step, request_revision)) = self.pending.magnetization_in_flight {
            self.materialization_states.insert(
                "m".to_string(),
                LiveFieldMaterializationStatus {
                    quantity: "m".to_string(),
                    source_step,
                    request_revision,
                    state: LiveFieldMaterializationState::Error,
                    error: Some(message.to_string()),
                },
            );
        }
        if let Some(job) = self.pending.staged_magnetization.as_ref() {
            self.materialization_states.insert(
                "m".to_string(),
                LiveFieldMaterializationStatus {
                    quantity: "m".to_string(),
                    source_step: job.source_step,
                    request_revision: job.source_revision,
                    state: LiveFieldMaterializationState::Error,
                    error: Some(message.to_string()),
                },
            );
        }
    }

    pub(crate) fn finalize_pending_until(&mut self, deadline: std::time::Instant) -> bool {
        if !self.pending.has_pending() {
            return true;
        }
        let Some(mut completion) = self.pending.take_completed_until(deadline) else {
            self.mark_unresolved_terminal_error(
                "FEM preview materializer did not complete before terminal publication",
            );
            return false;
        };
        if self.promote_completion(&mut completion).is_err() {
            self.mark_unresolved_terminal_error(
                "FEM preview result promotion failed before terminal publication",
            );
            return false;
        }
        true
    }

    fn mark_terminal_queue_error(&mut self, source_step: u64, message: &str) {
        for request in self.cache_queue.drain(..) {
            self.materialization_states.insert(
                request.quantity.clone(),
                LiveFieldMaterializationStatus {
                    quantity: request.quantity,
                    source_step,
                    request_revision: request.revision,
                    state: LiveFieldMaterializationState::Error,
                    error: Some(message.to_string()),
                },
            );
        }
        for status in self.materialization_states.values_mut() {
            if matches!(
                status.state,
                LiveFieldMaterializationState::Pending | LiveFieldMaterializationState::Superseded
            ) {
                status.state = LiveFieldMaterializationState::Error;
                status.error = Some(message.to_string());
            }
        }
    }

    fn take_terminal_ready(
        &mut self,
        fields: &mut Vec<LivePreviewField>,
        magnetization: &mut Option<FemLiveMagnetizationPayload>,
    ) {
        if let Some(field) = self.active_ready.take() {
            fields.push(field);
        }
        fields.append(&mut self.cached_ready);
        if let Some(ready) = self.magnetization_ready.take() {
            *magnetization = Some(ready);
        }
    }

    pub(crate) fn take_terminal_publication(
        &mut self,
        wall_time_ns: u64,
    ) -> TerminalFemPreviewPublication {
        let mut fields = Vec::new();
        let mut magnetization = None;
        self.take_terminal_ready(&mut fields, &mut magnetization);
        self.finish_terminal_publication(fields, magnetization, wall_time_ns)
    }

    fn finish_terminal_publication(
        &mut self,
        mut fields: Vec<LivePreviewField>,
        mut magnetization: Option<FemLiveMagnetizationPayload>,
        wall_time_ns: u64,
    ) -> TerminalFemPreviewPublication {
        self.take_terminal_ready(&mut fields, &mut magnetization);
        let mut quantity_positions = BTreeMap::<String, usize>::new();
        let mut latest_fields = Vec::<LivePreviewField>::new();
        for field in fields {
            if let Some(position) = quantity_positions.get(&field.quantity).copied() {
                latest_fields[position] = field;
            } else {
                quantity_positions.insert(field.quantity.clone(), latest_fields.len());
                latest_fields.push(field);
            }
        }
        TerminalFemPreviewPublication {
            cached_fields: (!latest_fields.is_empty()).then_some(latest_fields),
            magnetization,
            materialization_states: self.materialization_states(),
            wall_time_ns,
        }
    }

    pub(crate) fn finalize_terminal_cache(
        &mut self,
        backend: &NativeFemBackend,
        engine: FemEngine,
        display_selection: &DisplaySelectionState,
        plan: &FemPlanIR,
        node_count: usize,
        source_step: u64,
        source_time: f64,
        solver_dt: f64,
        deadline: std::time::Instant,
    ) -> TerminalFemPreviewPublication {
        let started = std::time::Instant::now();
        let mut fields = Vec::new();
        let mut magnetization = None;
        let mut completed = self.finalize_pending_until(deadline);
        self.take_terminal_ready(&mut fields, &mut magnetization);

        if completed {
            let mut quantity_ids = field_materialization_quantity_ids();
            if !display_is_global_scalar(display_selection) {
                quantity_ids.push(display_selection.selection.quantity.as_str());
            }
            quantity_ids.sort_unstable();
            quantity_ids.dedup();
            let base_request = display_selection.preview_request();
            let requests = active_fem_preview_quantities(engine, plan, &quantity_ids)
                .into_iter()
                .map(|quantity| {
                    let mut request = base_request.clone();
                    request.quantity = quantity.to_string();
                    request
                })
                .collect();
            self.start_cache_cycle(requests, source_step);

            if let Ok(ready) = self.request_magnetization(node_count, source_step) {
                if ready.is_some() {
                    magnetization = ready;
                }
            }

            loop {
                if self.pending.can_accept() && !self.cache_queue.is_empty() {
                    if self
                        .submit_next_cached(
                            backend,
                            node_count,
                            source_step,
                            source_time,
                            solver_dt,
                        )
                        .is_err()
                    {
                        completed = false;
                        break;
                    }
                }
                self.dispatch_staged(backend);
                if !self.pending.has_pending() {
                    if self.cache_queue.is_empty() {
                        break;
                    }
                    completed = false;
                    break;
                }
                if !self.finalize_pending_until(deadline) {
                    completed = false;
                    break;
                }
                self.take_terminal_ready(&mut fields, &mut magnetization);
                if self.cache_queue.is_empty() && !self.pending.has_pending() {
                    break;
                }
            }
        }

        if !completed {
            self.mark_unresolved_terminal_error(
                "FEM preview terminal cache did not complete before publication",
            );
            self.mark_terminal_queue_error(
                source_step,
                "FEM preview terminal cache did not complete before publication",
            );
        }
        self.take_terminal_ready(&mut fields, &mut magnetization);

        self.finish_terminal_publication(fields, magnetization, elapsed_ns(started))
    }

    pub(crate) fn reset_timings(&mut self) {
        self.timings = FemPreviewHandoffTimings::default();
    }

    pub(crate) fn take_timings(&mut self) -> FemPreviewHandoffTimings {
        std::mem::take(&mut self.timings)
    }
}

pub(crate) struct FemLiveMagnetizationPayload {
    pub(crate) values: Vec<f64>,
    pub(crate) source_step: u64,
    pub(crate) source_revision: u64,
    pub(crate) materialized_at_unix_ms: u64,
    pub(crate) materialization_wall_time_ns: u64,
    pub(crate) field_copy_bytes: u64,
}

/// Build the active FEM preview field.
///
/// This is intentionally the only relaxation-loop call site that touches the
/// native backend preview copy.  It keeps today's synchronous implementation
/// behind one boundary so the native async snapshot ABI can replace it without
/// editing every FEM relaxation loop.
pub(crate) fn build_fem_live_preview_field(
    backend: &NativeFemBackend,
    request: &crate::LivePreviewRequest,
    node_count: usize,
) -> Result<LivePreviewField, RunError> {
    backend.copy_live_preview_field(request, node_count)
}

/// Build cached preview fields for all non-active FEM quantities.
///
/// This mirrors the cached-preview logic in `CudaInteractiveFdmPreviewRuntime`
/// so that switching display-quantity in the frontend finds data in the cache
/// immediately.
pub(crate) fn build_fem_cached_preview_fields(
    backend: &NativeFemBackend,
    engine: FemEngine,
    display_selection: &crate::DisplaySelectionState,
    plan: &FemPlanIR,
    node_count: usize,
) -> Option<Vec<LivePreviewField>> {
    let materialization_quantities = field_materialization_quantity_ids();
    let quantities = active_fem_preview_quantities(engine, plan, &materialization_quantities);
    if quantities.is_empty() {
        return None;
    }
    let base_request = display_selection.preview_request();
    let mut cached = Vec::new();
    for quantity in quantities {
        let mut req = base_request.clone();
        req.quantity = quantity.to_string();
        match build_fem_live_preview_field(backend, &req, node_count) {
            Ok(field) => cached.push(field),
            Err(_) => { /* quantity not computed yet - skip */ }
        }
    }
    if cached.is_empty() {
        None
    } else {
        Some(cached)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(quantity: &str, source_step: u64) -> LivePreviewField {
        LivePreviewField {
            config_revision: 7,
            source_step,
            source_time_seconds: None,
            source_revision: 7,
            materialized_at_unix_ms: 1,
            materialization_wall_time_ns: 1,
            quantity: quantity.to_string(),
            unit: "A/m".to_string(),
            spatial_kind: "mesh".to_string(),
            quantity_domain: "magnetic_only".to_string(),
            preview_grid: [1, 1, 1],
            original_grid: [0, 0, 0],
            vector_field_values: vec![1.0, 0.0, 0.0],
            x_chosen_size: 0,
            y_chosen_size: 0,
            applied_x_chosen_size: 0,
            applied_y_chosen_size: 0,
            applied_layer_stride: 1,
            auto_downscaled: false,
            auto_downscale_message: None,
            active_mask: Some(vec![true]),
        }
    }

    #[test]
    fn task5_production_defaults_do_not_enable_the_bounded_materialization_delay_hook() {
        assert_eq!(parse_test_materialization_delay(false, Some("80")), None);
        assert_eq!(parse_test_materialization_delay(true, None), None);
        assert_eq!(parse_test_materialization_delay(true, Some("0")), None);
        assert_eq!(parse_test_materialization_delay(true, Some("1001")), None);
        assert_eq!(
            parse_test_materialization_delay(true, Some("80")),
            Some(std::time::Duration::from_millis(80))
        );
    }

    #[test]
    fn optional_materializer_failure_does_not_abort_solver_handoff() {
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        result_tx
            .send(PreviewFrameCompletion {
                preview: Some(PreviewCompletion {
                    quantity: "H_demag".to_string(),
                    source_step: 17,
                    request_revision: 5,
                    result: Err(RunError {
                        message: "intentional preview failure".to_string(),
                    }),
                }),
                magnetization: None,
                magnetization_identity: None,
            })
            .expect("test completion channel should accept one result");
        let (job_tx, _job_rx) = mpsc::sync_channel(1);
        let mut handoff = FemPreviewHandoff {
            pending: PendingFemPreviewState {
                job_tx: Some(job_tx),
                schedule_rx: None,
                result_rx: Some(result_rx),
                in_flight: Some(("H_demag".to_string(), 17, 5)),
                magnetization_in_flight: None,
                staged_preview: None,
                staged_magnetization: None,
                worker: None,
            },
            ..FemPreviewHandoff::default()
        };

        assert!(
            handoff.harvest_completed().is_ok(),
            "an optional display-materialization failure must not abort the solver"
        );
        let status = &handoff.materialization_states()[0];
        assert_eq!(status.quantity, "H_demag");
        assert_eq!(status.source_step, 17);
        assert_eq!(status.request_revision, 5);
        assert_eq!(status.state, LiveFieldMaterializationState::Error);
        assert_eq!(status.error.as_deref(), Some("intentional preview failure"));
    }

    #[test]
    fn scheduler_worker_failure_becomes_optional_error_without_aborting_solver() {
        let mut handoff = FemPreviewHandoff::default();
        assert!(handoff.pending.submit_schedule_error_test(
            "eden_total",
            23,
            11,
            "intentional native schedule failure",
        ));
        handoff.flush_schedule_fence();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while handoff.pending.in_flight.is_some() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(1));
            assert!(
                handoff.harvest_completed().is_ok(),
                "an optional scheduler failure must not abort the solver"
            );
        }

        let status = handoff
            .materialization_states()
            .into_iter()
            .find(|status| status.quantity == "eden_total")
            .expect("scheduler failure status");
        assert_eq!(status.source_step, 23);
        assert_eq!(status.request_revision, 11);
        assert_eq!(status.state, LiveFieldMaterializationState::Error);
        assert_eq!(
            status.error.as_deref(),
            Some("intentional native schedule failure")
        );
    }

    #[test]
    fn heavy_preview_materialization_does_not_block_callback_handoff() {
        let mut handoff = FemPreviewHandoff::default();
        let mut measured = Vec::new();

        for repeat in 0..6 {
            let source_step = 50 + repeat;
            let started = std::time::Instant::now();
            assert!(handoff.pending.submit_scheduled_test(
                PendingFemPreviewJob::Test {
                    destination: PreviewDestination::Active,
                    request_revision: 7,
                    source_step,
                    delay: std::time::Duration::from_millis(80),
                    field: field("H_demag", 0),
                },
                std::time::Duration::ZERO,
            ));
            handoff.harvest_completed().expect("nonblocking poll");
            let handoff_elapsed = started.elapsed();
            if repeat > 0 {
                measured.push(handoff_elapsed);
            }

            assert!(handoff_elapsed < std::time::Duration::from_millis(2));
            assert!(handoff.active_ready.is_none());
            assert_eq!(handoff.pending.pending_step("H_demag"), Some(source_step));
            handoff.pending.flush_schedule();

            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
            while !handoff.pending.can_accept() && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(1));
                handoff
                    .harvest_completed()
                    .expect("completed worker result");
            }
            assert_eq!(
                handoff
                    .active_ready
                    .take()
                    .expect("completed preview should be handed downstream")
                    .source_step,
                source_step
            );
        }

        measured.sort_unstable();
        let p50 = measured[measured.len() / 2];
        println!("task5 preview handoff p50_ns={}", p50.as_nanos());
        assert!(p50 < std::time::Duration::from_millis(2));
        assert!(handoff.pending.can_accept());
    }

    #[test]
    fn delayed_native_schedule_stays_off_callback_and_fence_preserves_source_step() {
        let mut handoff = FemPreviewHandoff::default();
        let callback_started = std::time::Instant::now();
        assert!(handoff.pending.submit_scheduled_test(
            PendingFemPreviewJob::Test {
                destination: PreviewDestination::Active,
                request_revision: 9,
                source_step: 42,
                delay: std::time::Duration::ZERO,
                field: field("m", 0),
            },
            std::time::Duration::from_millis(80),
        ));
        handoff
            .harvest_completed()
            .expect("nonblocking callback poll");
        assert!(callback_started.elapsed() < std::time::Duration::from_millis(2));

        let fence_ns = handoff.flush_schedule_fence();
        assert!(fence_ns >= 70_000_000, "fence_ns={fence_ns}");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while handoff.active_ready.is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(1));
            handoff.harvest_completed().expect("scheduled result");
        }
        assert_eq!(
            handoff
                .active_ready
                .take()
                .expect("same-step result")
                .source_step,
            42
        );
    }

    #[test]
    fn bounded_scheduler_rejects_second_frame_without_blocking() {
        let mut handoff = FemPreviewHandoff::default();
        let job = |source_step| PendingFemPreviewJob::Test {
            destination: PreviewDestination::Active,
            request_revision: 1,
            source_step,
            delay: std::time::Duration::ZERO,
            field: field("H_demag", 0),
        };
        assert!(handoff
            .pending
            .submit_scheduled_test(job(10), std::time::Duration::from_millis(80),));
        let rejected_started = std::time::Instant::now();
        assert!(!handoff
            .pending
            .submit_scheduled_test(job(11), std::time::Duration::ZERO));
        assert!(rejected_started.elapsed() < std::time::Duration::from_millis(2));
        handoff.flush_schedule_fence();
    }

    #[test]
    fn dropping_pending_schedule_joins_worker_without_deadlock() {
        let started = std::time::Instant::now();
        {
            let mut handoff = FemPreviewHandoff::default();
            assert!(handoff.pending.submit_scheduled_test(
                PendingFemPreviewJob::Test {
                    destination: PreviewDestination::Active,
                    request_revision: 1,
                    source_step: 10,
                    delay: std::time::Duration::ZERO,
                    field: field("m", 0),
                },
                std::time::Duration::from_millis(20),
            ));
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn final_frame_worker_output_does_not_block_teardown_when_unread() {
        let (output_tx, output_rx) = mpsc::sync_channel::<()>(1);
        output_tx.send(()).expect("prefill worker output");
        let (done_tx, done_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            assert!(!try_send_worker_output(&output_tx, ()), "full output");
            let _ = done_tx.send(());
        });

        let completed_without_drain = done_rx
            .recv_timeout(std::time::Duration::from_millis(20))
            .is_ok();
        worker.join().expect("worker should be releasable");
        let _ = output_rx.recv();
        assert!(
            completed_without_drain,
            "an unread final schedule/result must not block worker teardown"
        );
    }

    #[test]
    fn task5_terminal_finalization_waits_for_pending_frame_and_preserves_source_step() {
        let mut handoff = FemPreviewHandoff::default();
        assert!(handoff.pending.submit_scheduled_test(
            PendingFemPreviewJob::Test {
                destination: PreviewDestination::Active,
                request_revision: 13,
                source_step: 52,
                delay: std::time::Duration::from_millis(80),
                field: field("H_demag", 0),
            },
            std::time::Duration::ZERO,
        ));

        let callback_started = std::time::Instant::now();
        handoff
            .harvest_completed()
            .expect("callback poll remains nonblocking");
        assert!(callback_started.elapsed() < std::time::Duration::from_millis(2));

        let finalization_started = std::time::Instant::now();
        assert!(handoff
            .finalize_pending_until(std::time::Instant::now() + std::time::Duration::from_secs(1)));
        assert!(finalization_started.elapsed() >= std::time::Duration::from_millis(70));
        let final_field = handoff
            .active_ready
            .take()
            .expect("terminal finalization must promote the final frame");
        assert_eq!(final_field.source_step, 52);
        assert_eq!(
            handoff.materialization_states["H_demag"].state,
            LiveFieldMaterializationState::Complete
        );
        assert!(handoff.pending.can_accept());
    }

    #[test]
    fn task5_terminal_publication_keeps_slow_final_payload_after_old_frame() {
        let mut handoff = FemPreviewHandoff::default();
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
        assert!(handoff.pending.submit_scheduled_test(
            PendingFemPreviewJob::Test {
                destination: PreviewDestination::Cache,
                request_revision: 7,
                source_step: 45,
                delay: std::time::Duration::from_millis(25),
                field: field("H_demag", 45),
            },
            std::time::Duration::from_millis(10),
        ));
        assert!(handoff.finalize_pending_until(deadline));

        let mut terminal_fields = Vec::new();
        let mut terminal_magnetization = None;
        handoff.take_terminal_ready(&mut terminal_fields, &mut terminal_magnetization);

        assert!(handoff.pending.submit_scheduled_test(
            PendingFemPreviewJob::Test {
                destination: PreviewDestination::Cache,
                request_revision: 8,
                source_step: 52,
                delay: std::time::Duration::from_millis(25),
                field: field("H_demag", 52),
            },
            std::time::Duration::from_millis(10),
        ));
        assert!(handoff.finalize_pending_until(deadline));
        handoff.take_terminal_ready(&mut terminal_fields, &mut terminal_magnetization);

        let publication = handoff.finish_terminal_publication(
            terminal_fields,
            terminal_magnetization,
            70_000_000,
        );
        let published = publication
            .cached_fields
            .expect("terminal publication must retain accumulated payloads");
        assert_eq!(published.len(), 1);
        assert_eq!(published.last().expect("final payload").source_step, 52);
        let status = publication
            .materialization_states
            .iter()
            .find(|status| status.quantity == "H_demag")
            .expect("terminal H_demag status");
        assert_eq!(status.source_step, 52);
        assert_eq!(status.state, LiveFieldMaterializationState::Complete);
    }

    #[test]
    fn task5_terminal_publication_replaces_stale_active_payload_with_recomputed_cache_payload() {
        let mut handoff = FemPreviewHandoff::default();
        let mut stale_active = field("H_demag", 52);
        stale_active.vector_field_values = vec![0.0, 0.0, 0.0];
        let mut unrelated_cache = field("H_exch", 52);
        unrelated_cache.vector_field_values = vec![13.0, 0.0, 0.0];
        let mut recomputed_cache = field("H_demag", 52);
        recomputed_cache.vector_field_values = vec![52.0, 0.0, 0.0];
        handoff.active_ready = Some(stale_active);
        handoff.cached_ready.push(unrelated_cache);
        handoff.cached_ready.push(recomputed_cache);

        let publication = handoff.take_terminal_publication(1);
        let fields = publication
            .cached_fields
            .expect("terminal publication should contain H_demag");

        assert_eq!(fields.len(), 2, "unrelated terminal quantities remain");
        assert_eq!(fields[0].quantity, "H_demag");
        assert_eq!(fields[0].source_step, 52);
        assert_eq!(fields[0].vector_field_values, vec![52.0, 0.0, 0.0]);
        assert_eq!(fields[1].quantity, "H_exch");
        assert_eq!(fields[1].vector_field_values, vec![13.0, 0.0, 0.0]);
        assert_eq!(
            fields
                .iter()
                .filter(|field| field.quantity == "H_demag")
                .count(),
            1,
            "terminal publication must expose exactly one H_demag payload",
        );
    }

    #[test]
    fn task5_terminal_publication_marks_slow_final_timeout_instead_of_stale_success() {
        let started = std::time::Instant::now();
        {
            let mut handoff = FemPreviewHandoff::default();
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(60);
            assert!(handoff.pending.submit_scheduled_test(
                PendingFemPreviewJob::Test {
                    destination: PreviewDestination::Cache,
                    request_revision: 7,
                    source_step: 45,
                    delay: std::time::Duration::from_millis(20),
                    field: field("H_demag", 45),
                },
                std::time::Duration::ZERO,
            ));
            assert!(handoff.finalize_pending_until(deadline));

            let mut terminal_fields = Vec::new();
            let mut terminal_magnetization = None;
            handoff.take_terminal_ready(&mut terminal_fields, &mut terminal_magnetization);

            assert!(handoff.pending.submit_scheduled_test(
                PendingFemPreviewJob::Test {
                    destination: PreviewDestination::Cache,
                    request_revision: 8,
                    source_step: 52,
                    delay: std::time::Duration::from_millis(80),
                    field: field("H_demag", 52),
                },
                std::time::Duration::ZERO,
            ));
            assert!(!handoff.finalize_pending_until(deadline));
            let publication = handoff.finish_terminal_publication(
                terminal_fields,
                terminal_magnetization,
                elapsed_ns(started),
            );
            let status = publication
                .materialization_states
                .iter()
                .find(|status| status.quantity == "H_demag")
                .expect("terminal H_demag status");
            assert_eq!(status.source_step, 52);
            assert_eq!(status.request_revision, 8);
            assert_eq!(status.state, LiveFieldMaterializationState::Error);
            assert!(status.error.is_some());
            assert_eq!(
                publication
                    .cached_fields
                    .as_ref()
                    .and_then(|fields| fields.last())
                    .map(|field| field.source_step),
                Some(45),
                "the old payload may remain available, but its terminal status must be Error@52"
            );
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn task5_terminal_finalization_promotes_worker_error_without_aborting_solver() {
        let mut handoff = FemPreviewHandoff::default();
        assert!(handoff.pending.submit_schedule_error_test(
            "eden_total",
            52,
            17,
            "intentional terminal schedule failure",
        ));

        assert!(handoff
            .finalize_pending_until(std::time::Instant::now() + std::time::Duration::from_secs(1)));
        let status = &handoff.materialization_states["eden_total"];
        assert_eq!(status.source_step, 52);
        assert_eq!(status.request_revision, 17);
        assert_eq!(status.state, LiveFieldMaterializationState::Error);
        assert_eq!(
            status.error.as_deref(),
            Some("intentional terminal schedule failure")
        );
        assert!(handoff.pending.can_accept());
    }

    #[test]
    fn task5_terminal_finalization_timeout_is_explicit_and_teardown_is_bounded() {
        let started = std::time::Instant::now();
        {
            let mut handoff = FemPreviewHandoff::default();
            assert!(handoff.pending.submit_scheduled_test(
                PendingFemPreviewJob::Test {
                    destination: PreviewDestination::Cache,
                    request_revision: 19,
                    source_step: 52,
                    delay: std::time::Duration::from_millis(80),
                    field: field("H_demag", 0),
                },
                std::time::Duration::ZERO,
            ));

            assert!(!handoff.finalize_pending_until(
                std::time::Instant::now() + std::time::Duration::from_millis(5)
            ));
            let status = &handoff.materialization_states["H_demag"];
            assert_eq!(status.source_step, 52);
            assert_eq!(status.request_revision, 19);
            assert_eq!(status.state, LiveFieldMaterializationState::Error);
            assert_eq!(
                status.error.as_deref(),
                Some("FEM preview materializer did not complete before terminal publication")
            );
            let publication_started = std::time::Instant::now();
            let publication = handoff.take_terminal_publication(5_000_000);
            assert!(publication_started.elapsed() < std::time::Duration::from_millis(2));
            assert!(publication.cached_fields.is_none());
            assert!(publication.magnetization.is_none());
            assert_eq!(publication.materialization_states.len(), 1);
            assert_eq!(
                publication.materialization_states[0].state,
                LiveFieldMaterializationState::Error
            );
            assert!(handoff.pending.has_pending());
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn task5_preview_enqueue_matrix_p50_stays_below_deadline_without_worker_delay_spike() {
        let modes = [
            ("disabled", None, PreviewDestination::Active),
            ("m", Some("m"), PreviewDestination::Active),
            ("H_demag", Some("H_demag"), PreviewDestination::Active),
            ("full_cache", Some("H_eff"), PreviewDestination::Cache),
        ];
        let cadences = [10_u64, 25, 50];

        for (mode, quantity, destination) in modes {
            for cadence in cadences {
                let mut handoff = FemPreviewHandoff::default();
                let mut measured = Vec::new();
                for repeat in 0..6_u64 {
                    let source_step = cadence.saturating_mul(repeat + 1);
                    let started = std::time::Instant::now();
                    if let Some(quantity) = quantity {
                        let accepted = handoff.pending.submit_scheduled_test(
                            PendingFemPreviewJob::Test {
                                destination,
                                request_revision: 1,
                                source_step,
                                delay: std::time::Duration::from_millis(80),
                                field: field(quantity, 0),
                            },
                            std::time::Duration::ZERO,
                        );
                        assert!(accepted, "bounded worker accepts one job");
                        handoff.harvest_completed().expect("nonblocking poll");
                    }
                    let elapsed = started.elapsed();
                    if repeat > 0 {
                        measured.push(elapsed);
                        println!(
                            "task5 preview enqueue mode={mode} cadence={cadence} repeat={} elapsed_ns={}",
                            repeat,
                            elapsed.as_nanos()
                        );
                    }
                    if quantity.is_some() {
                        handoff.pending.flush_schedule();
                        let deadline =
                            std::time::Instant::now() + std::time::Duration::from_secs(1);
                        while !handoff.pending.can_accept() && std::time::Instant::now() < deadline
                        {
                            std::thread::sleep(std::time::Duration::from_millis(1));
                            handoff.harvest_completed().expect("worker result");
                        }
                        assert!(handoff.pending.can_accept());
                    }
                }
                measured.sort_unstable();
                let p50 = measured[measured.len() / 2];
                println!(
                    "task5 preview enqueue summary mode={mode} cadence={cadence} samples={} p50_ns={} max_ns={}",
                    measured.len(),
                    p50.as_nanos(),
                    measured.last().expect("five samples").as_nanos()
                );
                assert!(p50 < std::time::Duration::from_millis(2));
                assert!(
                    *measured.last().expect("five samples") < std::time::Duration::from_millis(60),
                    "the synthetic 80 ms worker delay must not execute in the callback"
                );
            }
        }
    }

    #[test]
    fn same_revision_cache_cadence_starts_a_fresh_cycle() {
        let mut handoff = FemPreviewHandoff::default();
        let request = LivePreviewRequest {
            revision: 7,
            quantity: "H_demag".to_string(),
            ..LivePreviewRequest::default()
        };

        handoff.start_cache_cycle(VecDeque::from([request.clone()]), 11);
        assert_eq!(handoff.cache_queue.pop_front(), Some(request.clone()));
        assert!(handoff.cache_queue.is_empty());

        handoff.start_cache_cycle(VecDeque::from([request.clone()]), 17);
        assert_eq!(handoff.cache_queue.pop_front(), Some(request));
    }

    #[test]
    fn task5_cache_cycle_refresh_preserves_fair_queue_progress() {
        let request = |quantity: &str, revision: u64| LivePreviewRequest {
            revision,
            quantity: quantity.to_string(),
            ..LivePreviewRequest::default()
        };
        let mut handoff = FemPreviewHandoff::default();
        handoff.start_cache_cycle(
            VecDeque::from([
                request("H_ex", 1),
                request("H_demag", 1),
                request("eden_total", 1),
            ]),
            10,
        );

        handoff.start_cache_cycle(
            VecDeque::from([
                request("eden_total", 2),
                request("H_demag", 2),
                request("H_ex", 2),
            ]),
            20,
        );

        let queued = handoff.cache_queue.iter().collect::<Vec<_>>();
        assert_eq!(
            queued
                .iter()
                .map(|request| request.quantity.as_str())
                .collect::<Vec<_>>(),
            vec!["H_ex", "H_demag", "eden_total"],
            "a cadence refresh must not move the queue tail behind the queue head"
        );
        assert!(queued.iter().all(|request| request.revision == 2));
        assert_eq!(handoff.preview_superseded_count, 0);

        handoff.start_cache_cycle(VecDeque::from([request("eden_total", 3)]), 30);
        assert_eq!(
            handoff
                .cache_queue
                .iter()
                .map(|request| request.quantity.as_str())
                .collect::<Vec<_>>(),
            vec!["eden_total"]
        );
        assert_eq!(handoff.preview_superseded_count, 2);
        assert_eq!(
            handoff.materialization_states["H_demag"].state,
            LiveFieldMaterializationState::Superseded
        );
    }
}
