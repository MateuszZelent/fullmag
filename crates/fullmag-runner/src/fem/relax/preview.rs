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
use crate::types::{LivePreviewField, LivePreviewRequest, RunError};
use crate::DisplaySelectionState;

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
    },
    EnergyDensity {
        destination: PreviewDestination,
        quantity: String,
        request_revision: u64,
        source_step: u64,
        snapshot: NativeFemEnergyDensitySnapshot,
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

    fn materialize(self) -> Result<PreviewResult, RunError> {
        let started = std::time::Instant::now();
        let (destination, request_revision, source_step, mut field) = match self {
            Self::Vector {
                destination,
                quantity: _,
                request_revision,
                source_step,
                snapshot,
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
        // Keep the retained frame clone on the materializer thread. The solver
        // callback only moves the two completed owners into their destinations.
        let mut last_good_field = field.clone();
        let materialization_wall_time_ns = started.elapsed().as_nanos() as u64;
        field.materialization_wall_time_ns = materialization_wall_time_ns;
        last_good_field.materialization_wall_time_ns = materialization_wall_time_ns;
        Ok(PreviewResult {
            destination,
            request_revision,
            source_step,
            materialization_wall_time_ns,
            field,
            last_good_field,
        })
    }
}

struct PreviewResult {
    destination: PreviewDestination,
    request_revision: u64,
    source_step: u64,
    materialization_wall_time_ns: u64,
    field: LivePreviewField,
    last_good_field: LivePreviewField,
}

pub(crate) struct PendingFemPreviewState {
    job_tx: Option<SyncSender<PendingFemPreviewJob>>,
    result_rx: Receiver<Result<PreviewResult, RunError>>,
    in_flight: Option<(String, u64)>,
}

impl Default for PendingFemPreviewState {
    fn default() -> Self {
        let (job_tx, job_rx) = mpsc::sync_channel::<PendingFemPreviewJob>(1);
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("fullmag-fem-preview-materializer".to_string())
            .spawn(move || {
                while let Ok(job) = job_rx.recv() {
                    if result_tx.send(job.materialize()).is_err() {
                        break;
                    }
                }
            })
            .expect("spawn bounded FEM preview materializer");
        Self {
            job_tx: Some(job_tx),
            result_rx,
            in_flight: None,
        }
    }
}

impl PendingFemPreviewState {
    pub(crate) fn can_accept(&self) -> bool {
        self.in_flight.is_none()
    }

    fn pending_step(&self, quantity: &str) -> Option<u64> {
        self.in_flight
            .as_ref()
            .filter(|(pending_quantity, _)| pending_quantity == quantity)
            .map(|(_, source_step)| *source_step)
    }

    fn submit(&mut self, job: PendingFemPreviewJob) -> Result<(), PendingFemPreviewJob> {
        if !self.can_accept() {
            return Err(job);
        }
        let Some(job_tx) = self.job_tx.as_ref() else {
            return Err(job);
        };
        let (quantity, source_step) = job.pending_identity();
        let pending_identity = (quantity.to_string(), source_step);
        match job_tx.try_send(job) {
            Ok(()) => {
                self.in_flight = Some(pending_identity);
                Ok(())
            }
            Err(TrySendError::Full(job) | TrySendError::Disconnected(job)) => Err(job),
        }
    }

    fn try_take_completed(&mut self) -> Option<Result<PreviewResult, RunError>> {
        match self.result_rx.try_recv() {
            Ok(result) => {
                self.in_flight = None;
                Some(result)
            }
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => self.in_flight.take().map(|_| {
                Err(RunError {
                    message: "FEM preview materializer disconnected".to_string(),
                })
            }),
        }
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
    last_good: BTreeMap<String, LivePreviewField>,
    active_ready: Option<LivePreviewField>,
    cached_ready: Vec<LivePreviewField>,
    preview_superseded_count: u64,
}

impl FemPreviewHandoff {
    fn harvest_completed(&mut self) -> Result<(), RunError> {
        let Some(result) = self.pending.try_take_completed() else {
            return Ok(());
        };
        let result = result?;
        debug_assert_eq!(result.field.source_revision, result.request_revision);
        debug_assert_eq!(result.field.source_step, result.source_step);
        debug_assert_eq!(
            result.field.materialization_wall_time_ns,
            result.materialization_wall_time_ns
        );
        self.last_good.insert(
            result.last_good_field.quantity.clone(),
            result.last_good_field,
        );
        match result.destination {
            PreviewDestination::Active => self.active_ready = Some(result.field),
            PreviewDestination::Cache => self.cached_ready.push(result.field),
        }
        Ok(())
    }

    fn begin_job(
        backend: &NativeFemBackend,
        request: &LivePreviewRequest,
        node_count: usize,
        source_step: u64,
        source_time: f64,
        solver_dt: f64,
        destination: PreviewDestination,
    ) -> Result<PendingFemPreviewJob, RunError> {
        if let Some(snapshot) = backend.begin_energy_density_snapshot(
            request,
            node_count,
            source_step,
            source_time,
            solver_dt,
        )? {
            return Ok(PendingFemPreviewJob::EnergyDensity {
                destination,
                quantity: request.quantity.clone(),
                request_revision: request.revision,
                source_step,
                snapshot,
            });
        }
        Ok(PendingFemPreviewJob::Vector {
            destination,
            quantity: request.quantity.clone(),
            request_revision: request.revision,
            source_step,
            snapshot: backend.begin_live_preview_snapshot(request)?,
        })
    }

    fn submit_request(
        &mut self,
        backend: &NativeFemBackend,
        request: &LivePreviewRequest,
        node_count: usize,
        source_step: u64,
        source_time: f64,
        solver_dt: f64,
        destination: PreviewDestination,
    ) -> Result<(), RunError> {
        if !self.pending.can_accept() {
            self.preview_superseded_count = self.preview_superseded_count.saturating_add(1);
            return Ok(());
        }
        let job = Self::begin_job(
            backend,
            request,
            node_count,
            source_step,
            source_time,
            solver_dt,
            destination,
        )?;
        if self.pending.submit(job).is_err() {
            self.preview_superseded_count = self.preview_superseded_count.saturating_add(1);
        }
        Ok(())
    }

    pub(crate) fn poll_active(&mut self) -> Result<Option<LivePreviewField>, RunError> {
        self.harvest_completed()?;
        Ok(self.active_ready.take())
    }

    pub(crate) fn request_preview(
        &mut self,
        backend: &NativeFemBackend,
        request: &LivePreviewRequest,
        node_count: usize,
        source_step: u64,
        source_time: f64,
        solver_dt: f64,
    ) -> Result<Option<LivePreviewField>, RunError> {
        self.harvest_completed()?;
        self.submit_request(
            backend,
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
        backend: &NativeFemBackend,
        node_count: usize,
        source_step: u64,
        source_time: f64,
        solver_dt: f64,
    ) -> Result<(), RunError> {
        if !self.pending.can_accept() {
            return Ok(());
        }
        let Some(request) = self.cache_queue.pop_front() else {
            return Ok(());
        };
        self.submit_request(
            backend,
            &request,
            node_count,
            source_step,
            source_time,
            solver_dt,
            PreviewDestination::Cache,
        )
    }

    fn start_cache_cycle(&mut self, requests: VecDeque<LivePreviewRequest>) {
        self.preview_superseded_count = self
            .preview_superseded_count
            .saturating_add(self.cache_queue.len() as u64);
        self.cache_queue = requests;
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
        self.start_cache_cycle(requests);
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
}

#[derive(Default)]
pub(crate) struct FemLiveMagnetizationHandoff {
    pending: Option<NativeFemFieldSnapshot>,
}

impl FemLiveMagnetizationHandoff {
    pub(crate) fn poll_completed(
        &mut self,
        node_count: usize,
    ) -> Result<Option<(Vec<f64>, u64, u64)>, RunError> {
        if !self
            .pending
            .as_ref()
            .map(|snapshot| snapshot.is_ready())
            .unwrap_or(false)
        {
            return Ok(None);
        }
        let copy_start = std::time::Instant::now();
        let snapshot = self.pending.take().expect("checked pending snapshot");
        let magnetization = snapshot.into_vector_field()?;
        if magnetization.len() != node_count {
            return Err(RunError {
                message: format!(
                    "native FEM magnetization payload returned {} nodes, expected {}",
                    magnetization.len(),
                    node_count
                ),
            });
        }
        let payload = flatten_vectors(&magnetization);
        let field_copy_wall_time_ns = copy_start.elapsed().as_nanos() as u64;
        let field_copy_bytes =
            (payload.len() as u64).saturating_mul(std::mem::size_of::<f64>() as u64);
        Ok(Some((payload, field_copy_wall_time_ns, field_copy_bytes)))
    }

    pub(crate) fn request_magnetization(
        &mut self,
        backend: &NativeFemBackend,
        node_count: usize,
    ) -> Result<Option<(Vec<f64>, u64, u64)>, RunError> {
        if let Some(payload) = self.poll_completed(node_count)? {
            return Ok(Some(payload));
        }
        if self.pending.is_none() {
            self.pending = Some(backend.begin_field_snapshot("m", 0, 0.0, 0.0)?);
        }
        self.poll_completed(node_count)
    }
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

/// Build final FEM preview cache for all cacheable quantities, including the
/// currently active vector field.
///
/// During live stepping the active field is delivered through `preview_field`,
/// so `build_fem_cached_preview_fields` intentionally excludes it. At stage
/// finalization there may be no later active preview update before the next
/// solver phase starts, so the final handoff must persist the active field too.
pub(crate) fn build_fem_final_cached_preview_fields(
    backend: &NativeFemBackend,
    engine: FemEngine,
    display_selection: &crate::DisplaySelectionState,
    plan: &FemPlanIR,
    node_count: usize,
    source_step: u64,
) -> Option<Vec<LivePreviewField>> {
    let mut quantity_ids = field_materialization_quantity_ids();
    if !display_is_global_scalar(display_selection) {
        quantity_ids.push(display_selection.selection.quantity.as_str());
    }
    quantity_ids.sort_unstable();
    quantity_ids.dedup();

    let quantities = active_fem_preview_quantities(engine, plan, &quantity_ids);
    if quantities.is_empty() {
        return None;
    }
    let base_request = display_selection.preview_request();
    let mut cached = Vec::new();
    for quantity in quantities {
        let mut req = base_request.clone();
        req.quantity = quantity.to_string();
        let materialization_start = std::time::Instant::now();
        match build_fem_live_preview_field(backend, &req, node_count) {
            Ok(mut field) => {
                stamp_final_preview_field(
                    &mut field,
                    source_step,
                    req.revision,
                    materialization_start.elapsed().as_nanos() as u64,
                );
                cached.push(field);
            }
            Err(_) => { /* quantity not computed yet - skip */ }
        }
    }
    if cached.is_empty() {
        None
    } else {
        Some(cached)
    }
}

fn stamp_final_preview_field(
    field: &mut LivePreviewField,
    source_step: u64,
    source_revision: u64,
    materialization_wall_time_ns: u64,
) {
    field.source_step = source_step;
    field.source_revision = source_revision;
    field.materialized_at_unix_ms = unix_time_ms();
    field.materialization_wall_time_ns = materialization_wall_time_ns;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(quantity: &str, source_step: u64) -> LivePreviewField {
        LivePreviewField {
            config_revision: 7,
            source_step,
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
    fn final_preview_field_records_terminal_source_provenance() {
        let mut preview = field("H_demag", 0);
        preview.source_revision = 0;
        preview.materialized_at_unix_ms = 0;
        preview.materialization_wall_time_ns = 0;

        stamp_final_preview_field(&mut preview, 52, 9, 123);

        assert_eq!(preview.source_step, 52);
        assert_eq!(preview.source_revision, 9);
        assert!(preview.materialized_at_unix_ms > 0);
        assert_eq!(preview.materialization_wall_time_ns, 123);
    }

    #[test]
    fn heavy_preview_materialization_does_not_block_callback_handoff() {
        let mut handoff = FemPreviewHandoff::default();
        handoff
            .last_good
            .insert("H_demag".to_string(), field("H_demag", 40));
        let mut measured = Vec::new();

        for repeat in 0..6 {
            let source_step = 50 + repeat;
            let previous_step = handoff.last_good["H_demag"].source_step;
            let started = std::time::Instant::now();
            assert!(handoff
                .pending
                .submit(PendingFemPreviewJob::Test {
                    destination: PreviewDestination::Active,
                    request_revision: 7,
                    source_step,
                    delay: std::time::Duration::from_millis(80),
                    field: field("H_demag", 0),
                })
                .is_ok());
            handoff.harvest_completed().expect("nonblocking poll");
            let handoff_elapsed = started.elapsed();
            if repeat > 0 {
                measured.push(handoff_elapsed);
            }

            assert!(handoff_elapsed < std::time::Duration::from_millis(2));
            assert_eq!(handoff.last_good["H_demag"].source_step, previous_step);
            assert_eq!(handoff.pending.pending_step("H_demag"), Some(source_step));

            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
            while !handoff.pending.can_accept() && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(1));
                handoff
                    .harvest_completed()
                    .expect("completed worker result");
            }
            assert_eq!(handoff.last_good["H_demag"].source_step, source_step);
        }

        measured.sort_unstable();
        let p50 = measured[measured.len() / 2];
        println!("task5 preview handoff p50_ns={}", p50.as_nanos());
        assert!(p50 < std::time::Duration::from_millis(2));
        assert!(handoff.pending.can_accept());
    }

    #[test]
    fn preview_enqueue_matrix_stays_below_solver_deadline() {
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
                        let accepted = handoff
                            .pending
                            .submit(PendingFemPreviewJob::Test {
                                destination,
                                request_revision: 1,
                                source_step,
                                delay: std::time::Duration::from_millis(80),
                                field: field(quantity, 0),
                            })
                            .is_ok();
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
                    assert!(elapsed < std::time::Duration::from_millis(2));

                    if quantity.is_some() {
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

        handoff.start_cache_cycle(VecDeque::from([request.clone()]));
        assert_eq!(handoff.cache_queue.pop_front(), Some(request.clone()));
        assert!(handoff.cache_queue.is_empty());

        handoff.start_cache_cycle(VecDeque::from([request.clone()]));
        assert_eq!(handoff.cache_queue.pop_front(), Some(request));
    }
}
