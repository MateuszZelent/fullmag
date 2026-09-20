//! Bounded native CUDA FDM live-observation handoff.
//!
//! The solver thread owns the native context and starts one full-grid native
//! snapshot per requested quantity at an accepted-step boundary. A single
//! bounded worker waits for those handles and materializes the Rust preview
//! fields. The worker never advances the solver, refreshes observables, or
//! mutates native physics state.

use fullmag_ir::FdmPlanIR;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::dispatch::FdmEngine;
use crate::fdm::gpu::cuda::native::{NativeFdmBackend, NativeFdmPreviewSnapshot};
use crate::quantities::{
    active_fdm_preview_quantities, field_materialization_quantity_ids, normalized_quantity_name,
    quantity_spec, QuantityShape,
};
use crate::types::{
    LiveFieldMaterializationState, LiveFieldMaterializationStatus, LivePreviewField,
    LivePreviewRequest, RunError, StepStats,
};
use crate::DisplaySelectionState;

/// Keep native full-grid observations infrequent enough that a display request
/// cannot turn into a second solver loop. A changed demand bypasses this
/// interval once the previous bounded job has completed.
pub(crate) const LIVE_OBSERVATION_MIN_INTERVAL: Duration = Duration::from_millis(150);

/// Conservative host-side bound for one in-flight observation job. The native
/// snapshot allocation is device-owned, so the estimate accounts for the
/// copied f64 payload, the materialized field, and one conversion transient.
pub(crate) const LIVE_OBSERVATION_MAX_BYTES: u64 = 256 * 1024 * 1024;

const TERMINAL_HARVEST_BUDGET: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct FdmLiveObservationTimings {
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

impl FdmLiveObservationTimings {
    pub(crate) fn record_into(self, stats: &mut StepStats) {
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

#[derive(Debug, Default)]
pub(crate) struct FdmLiveObservationPublication {
    pub(crate) preview_field: Option<LivePreviewField>,
    pub(crate) cached_preview_fields: Option<Vec<LivePreviewField>>,
    pub(crate) materialization_states: Vec<LiveFieldMaterializationStatus>,
    pub(crate) superseded_count: u64,
    pub(crate) wall_time_ns: u64,
    pub(crate) timings: FdmLiveObservationTimings,
}

impl FdmLiveObservationPublication {
    pub(crate) fn apply_to_stats(&mut self, stats: &mut StepStats) {
        stats.preview_wall_time_ns = self.wall_time_ns;
        stats.preview_superseded_count = self.superseded_count;
        stats.field_materialization_states = std::mem::take(&mut self.materialization_states);
        self.timings.record_into(stats);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ObservationDemand {
    revision: u64,
    quantities: Vec<String>,
    active_quantity: Option<String>,
}

impl ObservationDemand {
    fn matches_request(&self, identity: &ObservationJobIdentity) -> bool {
        // A display revision identifies presentation/configuration state, not
        // the physical observation demand. Palette/HSL changes must not
        // supersede an otherwise identical full-grid capture.
        self.quantities == identity.quantities
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ObservationJobIdentity {
    request_revision: u64,
    source_step: u64,
    source_time_bits: u64,
    quantities: Vec<String>,
}

struct ObservationSnapshot {
    quantity: String,
    snapshot: NativeFdmPreviewSnapshot,
}

struct ObservationJob {
    identity: ObservationJobIdentity,
    original_grid: [u32; 3],
    snapshots: Vec<ObservationSnapshot>,
    active_mask: Option<Vec<bool>>,
}

struct ObservationMaterializationError {
    quantity: String,
    message: String,
}

struct ObservationWorkerResult {
    identity: ObservationJobIdentity,
    fields: Vec<LivePreviewField>,
    errors: Vec<ObservationMaterializationError>,
}

#[derive(Debug, Clone, Copy)]
struct SourceStamp {
    revision: u64,
    step: u64,
    time: f64,
}

fn elapsed_ns(started: Instant) -> u64 {
    started.elapsed().as_nanos().min(u64::MAX as u128) as u64
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn full_grid_request(
    display_state: &DisplaySelectionState,
    quantity: &str,
    original_grid: [u32; 3],
) -> LivePreviewRequest {
    let mut request = display_state.preview_request();
    request.quantity = quantity.to_string();
    request.component = "3D".to_string();
    request.layer = 0;
    request.all_layers = true;
    request.every_n = 1;
    request.x_chosen_size = original_grid[0];
    request.y_chosen_size = original_grid[1];
    request.auto_scale_enabled = false;
    // `max_points = 0` means no preview fitting. The resulting payload must
    // be full-grid or it is rejected by the worker instead of being relabeled.
    request.max_points = 0;
    request
}

fn quantity_payload_bytes(quantity: &str, cell_count: usize) -> u64 {
    let component_count = quantity_spec(quantity)
        .map(|spec| spec.n_comp as usize)
        .unwrap_or(3);
    let values = cell_count
        .checked_mul(component_count)
        .and_then(|count| count.checked_mul(std::mem::size_of::<f64>()))
        .unwrap_or(usize::MAX);
    (values.min(u64::MAX as usize)) as u64
}

fn estimated_peak_bytes(
    quantities: &[String],
    original_grid: [u32; 3],
    active_mask_len: usize,
) -> u64 {
    let cell_count = (original_grid[0] as usize)
        .saturating_mul(original_grid[1] as usize)
        .saturating_mul(original_grid[2] as usize);
    quantities.iter().fold(active_mask_len as u64, |total, quantity| {
        // Derived torque retains two captured inputs plus decoded vectors and
        // output/conversion buffers; budget them before starting the batch.
        let copies = if quantity == "torque" { 10 } else { 3 };
        total.saturating_add(quantity_payload_bytes(quantity, cell_count).saturating_mul(copies))
    })
}

fn stamp_captured_field(
    field: &mut LivePreviewField,
    identity: &ObservationJobIdentity,
    materialization_wall_time_ns: u64,
) {
    field.config_revision = identity.request_revision;
    field.source_step = identity.source_step;
    // This Some(0.0) is intentional: an explicitly captured step-0 source
    // must not be treated as an old producer with an unknown source time.
    field.source_time_seconds = Some(f64::from_bits(identity.source_time_bits));
    field.source_revision = identity.request_revision;
    field.materialized_at_unix_ms = unix_time_ms();
    field.materialization_wall_time_ns = materialization_wall_time_ns;
}

fn source_stamp_is_newer(stamp: SourceStamp, previous: SourceStamp) -> bool {
    // Accepted step/time identify the physical state. The display revision is
    // only a deterministic tie-breaker when two captures describe that same
    // accepted state.
    stamp.step > previous.step
        || (stamp.step == previous.step
            && (stamp.time.total_cmp(&previous.time) == std::cmp::Ordering::Greater
                || (stamp.time.total_cmp(&previous.time) == std::cmp::Ordering::Equal
                    && stamp.revision >= previous.revision)))
}

fn validate_full_grid_field(
    field: &LivePreviewField,
    original_grid: [u32; 3],
) -> Result<(), RunError> {
    if field.original_grid != original_grid || field.preview_grid != original_grid {
        return Err(RunError {
            message: format!(
                "native CUDA live observation '{}' returned grid {:?} for required full grid {:?}",
                field.quantity, field.preview_grid, original_grid
            ),
        });
    }
    if field.auto_downscaled {
        return Err(RunError {
            message: format!(
                "native CUDA live observation '{}' was auto-downscaled; reduced payloads are not published as full grid",
                field.quantity
            ),
        });
    }
    let expected_cells = (original_grid[0] as usize)
        .saturating_mul(original_grid[1] as usize)
        .saturating_mul(original_grid[2] as usize);
    let expected_components = quantity_spec(&field.quantity)
        .map(|spec| spec.n_comp as usize)
        .unwrap_or(3);
    let expected_values = expected_cells.saturating_mul(expected_components);
    if field.vector_field_values.len() != expected_values {
        return Err(RunError {
            message: format!(
                "native CUDA live observation '{}' returned {} values, expected {}",
                field.quantity,
                field.vector_field_values.len(),
                expected_values
            ),
        });
    }
    Ok(())
}

fn materialize_observation_job(job: ObservationJob) -> ObservationWorkerResult {
    let mut fields = Vec::new();
    let mut errors = Vec::new();
    for pending in job.snapshots {
        let materialization_started = Instant::now();
        match pending
            .snapshot
            .into_live_preview_field(job.active_mask.as_deref())
        {
            Ok(mut field) => {
                let materialization_wall_time_ns = elapsed_ns(materialization_started);
                if let Err(error) = validate_full_grid_field(&field, job.original_grid) {
                    errors.push(ObservationMaterializationError {
                        quantity: pending.quantity,
                        message: error.message,
                    });
                    continue;
                }
                stamp_captured_field(
                    &mut field,
                    &job.identity,
                    materialization_wall_time_ns,
                );
                fields.push(field);
            }
            Err(error) => errors.push(ObservationMaterializationError {
                quantity: pending.quantity,
                message: error.message,
            }),
        }
    }
    ObservationWorkerResult {
        identity: job.identity,
        fields,
        errors,
    }
}

fn observation_worker(
    job_rx: Receiver<ObservationJob>,
    result_tx: SyncSender<ObservationWorkerResult>,
) {
    while let Ok(job) = job_rx.recv() {
        let result = materialize_observation_job(job);
        if result_tx.send(result).is_err() {
            break;
        }
    }
}

fn requested_observation_demand(
    display_state: &DisplaySelectionState,
    supported: &BTreeSet<String>,
) -> (ObservationDemand, Vec<(String, String)>) {
    let mut requested = display_state.observation_quantities.clone();
    // Keep the active selection in the union while older callers are still
    // producing only `selection.quantity`.
    requested.push(display_state.selection.quantity.clone());

    let mut quantities = Vec::new();
    let mut errors = BTreeMap::<String, String>::new();
    let mut active_quantity = None;
    for raw in requested {
        let canonical = match normalized_quantity_name(&raw) {
            Ok(name) => name,
            Err(error) => {
                errors.entry(raw.clone()).or_insert(error.message);
                continue;
            }
        };
        if quantity_spec(canonical).is_some_and(|spec| spec.shape == QuantityShape::GlobalScalar) {
            continue;
        }
        if !supported.contains(canonical) {
            errors.entry(canonical.to_string()).or_insert_with(|| {
                "quantity is unavailable for the active native CUDA FDM observation adapter"
                    .to_string()
            });
            continue;
        }
        if display_state.selection.quantity == raw {
            active_quantity = Some(canonical.to_string());
        }
        if !quantities.iter().any(|quantity| quantity == canonical) {
            quantities.push(canonical.to_string());
        }
    }
    (
        ObservationDemand {
            revision: display_state.revision,
            quantities,
            active_quantity,
        },
        errors.into_iter().collect(),
    )
}

pub(crate) struct FdmLiveObservationScheduler {
    original_grid: [u32; 3],
    active_mask: Option<Vec<bool>>,
    supported: BTreeSet<String>,
    job_tx: Option<SyncSender<ObservationJob>>,
    result_rx: Receiver<ObservationWorkerResult>,
    worker: Option<JoinHandle<()>>,
    in_flight: Option<ObservationJobIdentity>,
    in_flight_was_superseded: bool,
    current_demand: Option<ObservationDemand>,
    current_demand_errors: Vec<(String, String)>,
    statuses: BTreeMap<String, LiveFieldMaterializationStatus>,
    ready: BTreeMap<String, LivePreviewField>,
    last_source: BTreeMap<String, SourceStamp>,
    last_submit: Option<Instant>,
    force_schedule: bool,
    superseded_count: u64,
    worker_error: Option<String>,
    terminal: bool,
}

impl FdmLiveObservationScheduler {
    pub(crate) fn new(plan: &FdmPlanIR, original_grid: [u32; 3]) -> Self {
        let supported = field_materialization_quantity_ids()
            .into_iter()
            .filter(|quantity| {
                active_fdm_preview_quantities(FdmEngine::CudaFdm, plan, &[*quantity])
                    .into_iter()
                    .any(|candidate| candidate == *quantity)
            })
            .map(str::to_string)
            .collect::<BTreeSet<_>>();
        let active_mask = plan.active_mask.clone();
        let (job_tx, job_rx) = mpsc::sync_channel(1);
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("fullmag-fdm-cuda-live-observations".to_string())
            .spawn(move || observation_worker(job_rx, result_tx));
        let (worker, worker_error) = match worker {
            Ok(worker) => (Some(worker), None),
            Err(error) => (
                None,
                Some(format!("starting native CUDA live observation worker failed: {error}")),
            ),
        };
        Self {
            original_grid,
            active_mask,
            supported,
            job_tx: worker.as_ref().map(|_| job_tx),
            result_rx,
            worker,
            in_flight: None,
            in_flight_was_superseded: false,
            current_demand: None,
            current_demand_errors: Vec::new(),
            statuses: BTreeMap::new(),
            ready: BTreeMap::new(),
            last_source: BTreeMap::new(),
            last_submit: None,
            force_schedule: false,
            superseded_count: 0,
            worker_error,
            terminal: false,
        }
    }

    pub(crate) fn observe(
        &mut self,
        backend: &NativeFdmBackend,
        display_state: &DisplaySelectionState,
        capture_step: u64,
        capture_time: f64,
        _solver_dt: f64,
    ) -> FdmLiveObservationPublication {
        let started = Instant::now();
        if self.terminal {
            return FdmLiveObservationPublication::default();
        }
        let mut timings = FdmLiveObservationTimings::default();
        self.service(
            backend,
            display_state,
            capture_step,
            capture_time,
            &mut timings,
        );
        self.take_publication(started, timings)
    }

    /// Finish while the native backend is still alive. Completed results are
    /// harvested after the bounded wait as well as after worker join, so a
    /// short run does not silently drop its only outstanding observation.
    pub(crate) fn finish(
        &mut self,
        backend: &NativeFdmBackend,
        display_state: &DisplaySelectionState,
        capture_step: u64,
        capture_time: f64,
        _solver_dt: f64,
    ) -> FdmLiveObservationPublication {
        let started = Instant::now();
        if self.terminal {
            return FdmLiveObservationPublication::default();
        }
        let mut timings = FdmLiveObservationTimings::default();
        self.service(
            backend,
            display_state,
            capture_step,
            capture_time,
            &mut timings,
        );

        let deadline = Instant::now() + TERMINAL_HARVEST_BUDGET;
        while self.in_flight.is_some() {
            self.harvest(&mut timings);
            if self.in_flight.is_none() {
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match self.result_rx.recv_timeout(remaining.min(Duration::from_millis(20))) {
                Ok(result) => self.promote_result(result, &mut timings),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.worker_error = Some(
                        "native CUDA live observation worker disconnected during terminal harvest"
                            .to_string(),
                    );
                    break;
                }
            }
        }

        self.job_tx.take();
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() {
                self.worker_error = Some(
                    "native CUDA live observation worker panicked during terminal harvest"
                        .to_string(),
                );
            }
        }
        self.harvest(&mut timings);
        if self.in_flight.is_some() {
            self.mark_in_flight_error(
                "native CUDA live observation did not complete before backend teardown",
            );
        }
        self.terminal = true;
        self.take_publication(started, timings)
    }

    fn service(
        &mut self,
        backend: &NativeFdmBackend,
        display_state: &DisplaySelectionState,
        capture_step: u64,
        capture_time: f64,
        timings: &mut FdmLiveObservationTimings,
    ) {
        let harvest_started = Instant::now();
        self.harvest(timings);
        timings.harvest_query_wall_time_ns = elapsed_ns(harvest_started);

        let coalescing_started = Instant::now();
        // Display revisions are monotonic request/configuration identities.
        // Reuse the normalized demand while the revision is unchanged; when
        // only presentation changed, re-read no quantity data and keep the
        // physical capture state below.
        let (demand, requested_errors) = match self.current_demand.as_ref() {
            Some(current) if current.revision == display_state.revision => (
                current.clone(),
                self.current_demand_errors.clone(),
            ),
            _ => requested_observation_demand(display_state, &self.supported),
        };
        let quantity_set_changed = self
            .current_demand
            .as_ref()
            .is_none_or(|current| current.quantities != demand.quantities);
        if quantity_set_changed {
            self.current_demand = Some(demand.clone());
            self.current_demand_errors = requested_errors.clone();
            self.force_schedule = demand
                .quantities
                .iter()
                .any(|quantity| !self.ready.contains_key(quantity));
            self.ready.retain(|quantity, _field| {
                demand.quantities.iter().any(|requested| requested == quantity)
            });
            self.statuses.clear();
            for (quantity, message) in &requested_errors {
                self.statuses.insert(
                    quantity.clone(),
                    LiveFieldMaterializationStatus {
                        quantity: quantity.clone(),
                        source_step: capture_step,
                        request_revision: demand.revision,
                        state: LiveFieldMaterializationState::Error,
                        error: Some(message.clone()),
                    },
                );
            }
            for quantity in &demand.quantities {
                let status = self.ready.get(quantity).map(|field| {
                    LiveFieldMaterializationStatus {
                        quantity: quantity.clone(),
                        source_step: field.source_step,
                        request_revision: demand.revision,
                        state: LiveFieldMaterializationState::Complete,
                        error: None,
                    }
                });
                self.statuses.insert(
                    quantity.clone(),
                    status.unwrap_or_else(|| pending_status(quantity, capture_step, demand.revision)),
                );
            }
        } else {
            // The quantity set is unchanged. Carry a new display revision for
            // status/configuration consumers, but preserve every physical
            // source stamp and every in-flight/ready science payload.
            self.current_demand = Some(demand.clone());
            self.current_demand_errors = requested_errors.clone();
            for (quantity, message) in &requested_errors {
                self.statuses.insert(
                    quantity.clone(),
                    LiveFieldMaterializationStatus {
                        quantity: quantity.clone(),
                        source_step: capture_step,
                        request_revision: demand.revision,
                        state: LiveFieldMaterializationState::Error,
                        error: Some(message.clone()),
                    },
                );
            }
            for quantity in &demand.quantities {
                if let Some(field) = self.ready.get(quantity) {
                    self.statuses.insert(
                        quantity.clone(),
                        LiveFieldMaterializationStatus {
                            quantity: quantity.clone(),
                            source_step: field.source_step,
                            request_revision: demand.revision,
                            state: LiveFieldMaterializationState::Complete,
                            error: None,
                        },
                    );
                } else if let Some(status) = self.statuses.get_mut(quantity) {
                    status.request_revision = demand.revision;
                } else {
                    self.statuses.insert(
                        quantity.clone(),
                        pending_status(quantity, capture_step, demand.revision),
                    );
                }
            }
        }
        timings.queue_coalescing_wall_time_ns = elapsed_ns(coalescing_started);

        if let Some(in_flight) = self.in_flight.as_ref() {
            if !demand.matches_request(in_flight) && !self.in_flight_was_superseded {
                self.in_flight_was_superseded = true;
                self.superseded_count = self.superseded_count.saturating_add(1);
                self.force_schedule = true;
                for status in self.statuses.values_mut() {
                    if status.state == LiveFieldMaterializationState::Pending {
                        status.state = LiveFieldMaterializationState::Superseded;
                        status.error = Some(
                            "observation demand was superseded by a newer visible request"
                                .to_string(),
                        );
                    }
                }
                // New-demand statuses are restored below, so only old
                // in-flight ownership is reported as Superseded.
                for quantity in &demand.quantities {
                    if !self.ready.contains_key(quantity) {
                        self.statuses.insert(
                            quantity.clone(),
                            pending_status(quantity, capture_step, demand.revision),
                        );
                    }
                }
            }
        }

        let can_accept_started = Instant::now();
        let can_accept = self.in_flight.is_none() && self.worker_error.is_none();
        timings.can_accept_wall_time_ns = elapsed_ns(can_accept_started);
        let due_by_rate = self
            .last_submit
            .is_none_or(|submitted| submitted.elapsed() >= LIVE_OBSERVATION_MIN_INTERVAL);
        if can_accept
            && !demand.quantities.is_empty()
            && (self.force_schedule || due_by_rate)
        {
            self.schedule(
                backend,
                display_state,
                &demand,
                capture_step,
                capture_time,
                timings,
            );
        } else if self.worker_error.is_some() {
            let message = self
                .worker_error
                .clone()
                .unwrap_or_else(|| "native CUDA live observation worker unavailable".to_string());
            for quantity in &demand.quantities {
                self.statuses.insert(
                    quantity.clone(),
                    LiveFieldMaterializationStatus {
                        quantity: quantity.clone(),
                        source_step: capture_step,
                        request_revision: demand.revision,
                        state: LiveFieldMaterializationState::Error,
                        error: Some(message.clone()),
                    },
                );
            }
        }
    }

    fn schedule(
        &mut self,
        backend: &NativeFdmBackend,
        display_state: &DisplaySelectionState,
        demand: &ObservationDemand,
        capture_step: u64,
        capture_time: f64,
        timings: &mut FdmLiveObservationTimings,
    ) {
        let schedule_started = Instant::now();
        let descriptor_started = Instant::now();
        let identity = ObservationJobIdentity {
            request_revision: demand.revision,
            source_step: capture_step,
            source_time_bits: capture_time.to_bits(),
            quantities: demand.quantities.clone(),
        };
        timings.submit_descriptor_wall_time_ns = elapsed_ns(descriptor_started);
        let active_mask_len = self.active_mask.as_ref().map_or(0, Vec::len);
        if estimated_peak_bytes(&demand.quantities, self.original_grid, active_mask_len)
            > LIVE_OBSERVATION_MAX_BYTES
        {
            let message = format!(
                "native CUDA live observation exceeds the {} MiB full-grid memory budget",
                LIVE_OBSERVATION_MAX_BYTES / (1024 * 1024)
            );
            for quantity in &demand.quantities {
                self.statuses.insert(
                    quantity.clone(),
                    LiveFieldMaterializationStatus {
                        quantity: quantity.clone(),
                        source_step: capture_step,
                        request_revision: demand.revision,
                        state: LiveFieldMaterializationState::Error,
                        error: Some(message.clone()),
                    },
                );
            }
            self.last_submit = Some(Instant::now());
            self.force_schedule = false;
            timings.submit_wall_time_ns = elapsed_ns(schedule_started);
            return;
        }

        let mut snapshots = Vec::with_capacity(demand.quantities.len());
        let mut schedule_vector_ns: u64 = 0;
        let mut schedule_energy_ns: u64 = 0;
        for quantity in &demand.quantities {
            let request = full_grid_request(display_state, quantity, self.original_grid);
            let started = Instant::now();
            match backend.begin_live_preview_snapshot(&request, self.original_grid) {
                Ok(snapshot) => snapshots.push(ObservationSnapshot {
                    quantity: quantity.clone(),
                    snapshot,
                }),
                Err(error) => {
                    self.statuses.insert(
                        quantity.clone(),
                        LiveFieldMaterializationStatus {
                            quantity: quantity.clone(),
                            source_step: capture_step,
                            request_revision: demand.revision,
                            state: LiveFieldMaterializationState::Error,
                            error: Some(error.message),
                        },
                    );
                }
            }
            let elapsed = elapsed_ns(started);
            if quantity_spec(quantity)
                .is_some_and(|spec| spec.shape == QuantityShape::SpatialScalar)
            {
                schedule_energy_ns = schedule_energy_ns.saturating_add(elapsed);
            } else {
                schedule_vector_ns = schedule_vector_ns.saturating_add(elapsed);
            }
        }
        timings.vector_snapshot_schedule_wall_time_ns = schedule_vector_ns;
        timings.energy_snapshot_schedule_wall_time_ns = schedule_energy_ns;
        timings.submit_stage_wall_time_ns = elapsed_ns(schedule_started);
        if snapshots.is_empty() {
            self.last_submit = Some(Instant::now());
            self.force_schedule = false;
            timings.submit_wall_time_ns = elapsed_ns(schedule_started);
            return;
        }

        let active_mask = self.active_mask.clone();
        let job = ObservationJob {
            identity: identity.clone(),
            original_grid: self.original_grid,
            snapshots,
            active_mask,
        };
        let channel_alloc_started = Instant::now();
        timings.submit_channel_alloc_wall_time_ns = elapsed_ns(channel_alloc_started);
        let Some(job_tx) = self.job_tx.as_ref() else {
            self.worker_error = Some("native CUDA live observation worker unavailable".to_string());
            self.last_submit = Some(Instant::now());
            self.force_schedule = false;
            timings.submit_wall_time_ns = elapsed_ns(schedule_started);
            return;
        };
        let try_send_started = Instant::now();
        match job_tx.try_send(job) {
            Ok(()) => {
                timings.submit_try_send_wall_time_ns = elapsed_ns(try_send_started);
                self.in_flight = Some(identity);
                self.in_flight_was_superseded = false;
                self.last_submit = Some(Instant::now());
                self.force_schedule = false;
                for quantity in &demand.quantities {
                    if self.statuses.get(quantity).is_none_or(|status| {
                        status.state != LiveFieldMaterializationState::Error
                    }) {
                        self.statuses.insert(
                            quantity.clone(),
                            pending_status(quantity, capture_step, demand.revision),
                        );
                    }
                }
            }
            Err(TrySendError::Full(_job)) => {
                self.last_submit = Some(Instant::now());
                self.force_schedule = false;
                let message =
                    "native CUDA live observation worker is busy; request was coalesced".to_string();
                for quantity in &demand.quantities {
                    self.statuses.insert(
                        quantity.clone(),
                        LiveFieldMaterializationStatus {
                            quantity: quantity.clone(),
                            source_step: capture_step,
                            request_revision: demand.revision,
                            state: LiveFieldMaterializationState::Error,
                            error: Some(message.clone()),
                        },
                    );
                }
            }
            Err(TrySendError::Disconnected(_job)) => {
                self.worker_error = Some(
                    "native CUDA live observation worker disconnected while submitting a job"
                        .to_string(),
                );
                self.last_submit = Some(Instant::now());
                self.force_schedule = false;
            }
        }
        timings.submit_try_send_wall_time_ns = elapsed_ns(try_send_started);
        timings.submit_bookkeeping_wall_time_ns = elapsed_ns(schedule_started);
        timings.submit_wall_time_ns = elapsed_ns(schedule_started);
    }

    fn harvest(&mut self, timings: &mut FdmLiveObservationTimings) {
        loop {
            match self.result_rx.try_recv() {
                Ok(result) => self.promote_result(result, timings),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.worker_error = Some(
                        "native CUDA live observation worker disconnected".to_string(),
                    );
                    break;
                }
            }
        }
    }

    fn promote_result(
        &mut self,
        result: ObservationWorkerResult,
        timings: &mut FdmLiveObservationTimings,
    ) {
        let promotion_started = Instant::now();
        let current = self
            .current_demand
            .as_ref()
            .is_some_and(|demand| demand.matches_request(&result.identity));
        let owns_result = self
            .in_flight
            .as_ref()
            .is_some_and(|identity| identity == &result.identity);
        if owns_result {
            self.in_flight = None;
            self.in_flight_was_superseded = false;
        }
        if !current || !owns_result {
            self.force_schedule = true;
            timings.result_promotion_wall_time_ns = timings
                .result_promotion_wall_time_ns
                .saturating_add(elapsed_ns(promotion_started));
            return;
        }
        for mut field in result.fields {
            if !self
                .current_demand
                .as_ref()
                .is_some_and(|demand| demand.quantities.iter().any(|q| q == &field.quantity))
            {
                continue;
            }
            let stamp = SourceStamp {
                revision: field.source_revision,
                step: field.source_step,
                time: field.source_time_seconds.unwrap_or_default(),
            };
            let newer = self
                .last_source
                .get(&field.quantity)
                .is_none_or(|previous| source_stamp_is_newer(stamp, *previous));
            if !newer {
                continue;
            }
            let current_revision = self
                .current_demand
                .as_ref()
                .map_or(field.config_revision, |demand| demand.revision);
            // Keep the accepted-state source stamp from the capture. Only the
            // presentation/config revision follows a newer display request.
            field.config_revision = current_revision;
            self.last_source.insert(field.quantity.clone(), stamp);
            self.statuses.insert(
                field.quantity.clone(),
                LiveFieldMaterializationStatus {
                    quantity: field.quantity.clone(),
                    source_step: field.source_step,
                    request_revision: current_revision,
                    state: LiveFieldMaterializationState::Complete,
                    error: None,
                },
            );
            self.ready.insert(field.quantity.clone(), field);
        }
        for error in result.errors {
            let current_revision = self
                .current_demand
                .as_ref()
                .map_or(result.identity.request_revision, |demand| demand.revision);
            self.statuses.insert(
                error.quantity.clone(),
                LiveFieldMaterializationStatus {
                    quantity: error.quantity,
                    source_step: result.identity.source_step,
                    request_revision: current_revision,
                    state: LiveFieldMaterializationState::Error,
                    error: Some(error.message),
                },
            );
        }
        timings.result_promotion_wall_time_ns = timings
            .result_promotion_wall_time_ns
            .saturating_add(elapsed_ns(promotion_started));
    }

    fn mark_in_flight_error(&mut self, message: &str) {
        let Some(identity) = self.in_flight.take() else {
            return;
        };
        if let Some(demand) = self.current_demand.as_ref() {
            for quantity in &demand.quantities {
                self.statuses.insert(
                    quantity.clone(),
                    LiveFieldMaterializationStatus {
                        quantity: quantity.clone(),
                        source_step: identity.source_step,
                        request_revision: identity.request_revision,
                        state: LiveFieldMaterializationState::Error,
                        error: Some(message.to_string()),
                    },
                );
            }
        }
    }

    fn take_publication(
        &mut self,
        started: Instant,
        timings: FdmLiveObservationTimings,
    ) -> FdmLiveObservationPublication {
        let display_revision = self.current_demand.as_ref().map(|demand| demand.revision);
        let active_quantity = self
            .current_demand
            .as_ref()
            .and_then(|demand| demand.active_quantity.as_deref());
        let preview_field = active_quantity
            .filter(|quantity| *quantity != "m")
            .and_then(|quantity| self.ready.remove(quantity))
            .map(|mut field| {
                if let Some(revision) = display_revision {
                    field.config_revision = revision;
                }
                field
            });
        let mut cached = Vec::new();
        if let Some(demand) = self.current_demand.as_ref() {
            for quantity in &demand.quantities {
                if Some(quantity.as_str()) == active_quantity && quantity != "m" {
                    continue;
                }
                if let Some(field) = self.ready.remove(quantity) {
                    let mut field = field;
                    if let Some(revision) = display_revision {
                        field.config_revision = revision;
                    }
                    cached.push(field);
                }
            }
        }
        FdmLiveObservationPublication {
            preview_field,
            cached_preview_fields: (!cached.is_empty()).then_some(cached),
            materialization_states: self.statuses.values().cloned().collect(),
            superseded_count: std::mem::take(&mut self.superseded_count),
            wall_time_ns: elapsed_ns(started),
            timings,
        }
    }
}

fn pending_status(
    quantity: &str,
    source_step: u64,
    request_revision: u64,
) -> LiveFieldMaterializationStatus {
    LiveFieldMaterializationStatus {
        quantity: quantity.to_string(),
        source_step,
        request_revision,
        state: LiveFieldMaterializationState::Pending,
        error: None,
    }
}

impl Drop for FdmLiveObservationScheduler {
    fn drop(&mut self) {
        // Callers must use `finish` while the backend is alive. This fallback
        // only closes the bounded channel and joins the materializer so no
        // worker or native snapshot handle escapes the scheduler.
        self.job_tx.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        estimated_peak_bytes, full_grid_request, requested_observation_demand,
        source_stamp_is_newer, stamp_captured_field, ObservationDemand, ObservationJobIdentity,
        SourceStamp, LIVE_OBSERVATION_MAX_BYTES,
    };
    use crate::types::LivePreviewField;
    use crate::DisplaySelectionState;
    use std::collections::BTreeSet;

    #[test]
    fn demand_consumes_visible_union_and_keeps_active_selection() {
        let mut display = DisplaySelectionState::default();
        display.revision = 11;
        display.observation_quantities = vec!["H_demag".to_string(), "m".to_string()];
        display.selection.quantity = "H_eff".to_string();
        let supported = ["m", "H_demag", "H_eff"]
            .into_iter()
            .map(str::to_string)
            .collect::<BTreeSet<_>>();

        let (demand, errors) = requested_observation_demand(&display, &supported);

        assert!(errors.is_empty());
        assert_eq!(demand.revision, 11);
        assert_eq!(demand.quantities, ["H_demag", "m", "H_eff"]);
        assert_eq!(demand.active_quantity.as_deref(), Some("H_eff"));
    }

    #[test]
    fn full_grid_request_disables_preview_reduction() {
        let mut display = DisplaySelectionState::default();
        display.revision = 9;
        display.selection.quantity = "H_eff".to_string();
        display.selection.max_points = 1;
        let request = full_grid_request(&display, "H_eff", [8, 4, 2]);

        assert_eq!(request.component, "3D");
        assert_eq!(request.x_chosen_size, 8);
        assert_eq!(request.y_chosen_size, 4);
        assert!(!request.auto_scale_enabled);
        assert_eq!(request.max_points, 0);
        assert!(request.all_layers);
    }

    #[test]
    fn full_grid_budget_is_explicit_and_bounded() {
        let quantities = vec!["m".to_string(), "H_eff".to_string()];
        assert!(estimated_peak_bytes(&quantities, [32, 32, 1], 0) < LIVE_OBSERVATION_MAX_BYTES);
        assert!(estimated_peak_bytes(&quantities, [8192, 8192, 4], 0) > LIVE_OBSERVATION_MAX_BYTES);
    }

    #[test]
    fn captured_step_zero_keeps_explicit_source_time_and_revision() {
        let mut field = LivePreviewField {
            config_revision: 0,
            source_step: 0,
            source_time_seconds: None,
            source_revision: 0,
            materialized_at_unix_ms: 0,
            materialization_wall_time_ns: 0,
            quantity: "m".to_string(),
            unit: "1".to_string(),
            spatial_kind: "grid".to_string(),
            quantity_domain: "magnetic_only".to_string(),
            preview_grid: [1, 1, 1],
            original_grid: [1, 1, 1],
            vector_field_values: vec![0.0, 0.0, 1.0],
            x_chosen_size: 1,
            y_chosen_size: 1,
            applied_x_chosen_size: 1,
            applied_y_chosen_size: 1,
            applied_layer_stride: 1,
            auto_downscaled: false,
            auto_downscale_message: None,
            active_mask: None,
        };
        let identity = super::ObservationJobIdentity {
            request_revision: 23,
            source_step: 0,
            source_time_bits: 0.0f64.to_bits(),
            quantities: vec!["m".to_string()],
        };
        stamp_captured_field(&mut field, &identity, 17);

        assert_eq!(field.source_step, 0);
        assert_eq!(field.source_time_seconds, Some(0.0));
        assert_eq!(field.source_revision, 23);
        assert_eq!(field.materialization_wall_time_ns, 17);
    }

    #[test]
    fn presentation_revision_does_not_supersede_same_quantity_demand() {
        let demand = ObservationDemand {
            revision: 23,
            quantities: vec!["H_eff".to_string()],
            active_quantity: Some("H_eff".to_string()),
        };
        let identity = ObservationJobIdentity {
            request_revision: 7,
            source_step: 4,
            source_time_bits: 4.0f64.to_bits(),
            quantities: vec!["H_eff".to_string()],
        };
        assert!(demand.matches_request(&identity));

        let changed_quantity = ObservationJobIdentity {
            quantities: vec!["H_demag".to_string()],
            ..identity
        };
        assert!(!demand.matches_request(&changed_quantity));
    }

    #[test]
    fn accepted_state_precedes_display_revision_in_source_ordering() {
        let older_state_with_newer_display_revision = SourceStamp {
            revision: 99,
            step: 3,
            time: 3.0,
        };
        let newer_accepted_state = SourceStamp {
            revision: 1,
            step: 4,
            time: 4.0,
        };
        assert!(source_stamp_is_newer(
            newer_accepted_state,
            older_state_with_newer_display_revision,
        ));
        assert!(!source_stamp_is_newer(
            older_state_with_newer_display_revision,
            newer_accepted_state,
        ));
    }
}
