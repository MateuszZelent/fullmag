//! Cached-preview helpers for native FEM relaxation.
//!
//! These helpers keep display-quantity switching warm during relaxation
//! without making the dispatch layer own relaxation preview behavior.

use fullmag_ir::FemPlanIR;

use crate::dispatch::{flatten_vectors, FemEngine};
use crate::interactive_runtime::display_is_global_scalar;
use crate::native_fem::{NativeFemBackend, NativeFemFieldSnapshot, NativeFemPreviewSnapshot};
use crate::quantities::{active_fem_preview_quantities, field_materialization_quantity_ids};
use crate::types::{LivePreviewField, LivePreviewRequest, RunError};
use crate::DisplaySelectionState;

fn is_fem_energy_density_quantity(quantity: &str) -> bool {
    matches!(
        crate::quantities::normalized_quantity_name(quantity),
        Ok("eden_ex" | "eden_demag" | "eden_ext" | "eden_ani" | "eden_dmi" | "eden_total")
    )
}

#[derive(Default)]
pub(crate) struct FemLivePreviewHandoff {
    pending: Option<NativeFemPreviewSnapshot>,
    pending_request: Option<LivePreviewRequest>,
    last_good: Option<LivePreviewField>,
    last_good_request: Option<LivePreviewRequest>,
}

impl FemLivePreviewHandoff {
    pub(crate) fn poll_completed(&mut self) -> Result<Option<LivePreviewField>, RunError> {
        if !self
            .pending
            .as_ref()
            .map(|snapshot| snapshot.is_ready())
            .unwrap_or(false)
        {
            return Ok(None);
        }
        let request = self.pending_request.take();
        let snapshot = self.pending.take().expect("checked pending snapshot");
        let field = snapshot.into_live_preview_field()?;
        self.last_good = Some(field.clone());
        self.last_good_request = request;
        Ok(Some(field))
    }

    pub(crate) fn request_preview(
        &mut self,
        backend: &NativeFemBackend,
        request: &LivePreviewRequest,
        node_count: usize,
    ) -> Result<Option<LivePreviewField>, RunError> {
        if is_fem_energy_density_quantity(&request.quantity) {
            let field = backend.copy_live_preview_field(request, node_count)?;
            self.pending = None;
            self.pending_request = None;
            self.last_good = Some(field.clone());
            self.last_good_request = Some(request.clone());
            return Ok(Some(field));
        }
        if self
            .pending_request
            .as_ref()
            .is_some_and(|pending| pending != request)
        {
            self.pending = None;
            self.pending_request = None;
        }
        if let Some(field) = self.poll_completed()? {
            return Ok(Some(field));
        }
        if self.pending.is_none() {
            self.pending = Some(backend.begin_live_preview_snapshot(request)?);
            self.pending_request = Some(request.clone());
        }
        if let Some(field) = self.poll_completed()? {
            return Ok(Some(field));
        }
        if self
            .last_good_request
            .as_ref()
            .is_some_and(|last_good| last_good == request)
        {
            return Ok(self.last_good.clone());
        }
        Ok(None)
    }
}

#[derive(Default)]
pub(crate) struct FemCachedPreviewHandoff {
    pending_revision: Option<u64>,
    pending: Vec<(LivePreviewRequest, NativeFemPreviewSnapshot)>,
}

impl FemCachedPreviewHandoff {
    pub(crate) fn poll_completed(&mut self) -> Result<Option<Vec<LivePreviewField>>, RunError> {
        if self.pending.is_empty() {
            self.pending_revision = None;
            return Ok(None);
        }

        let mut completed = Vec::new();
        let mut still_pending = Vec::new();
        for (request, snapshot) in self.pending.drain(..) {
            if snapshot.is_ready() {
                match snapshot.into_live_preview_field() {
                    Ok(field) => completed.push(field),
                    Err(_) => { /* quantity not computed yet - skip */ }
                }
            } else {
                still_pending.push((request, snapshot));
            }
        }
        self.pending = still_pending;
        if self.pending.is_empty() {
            self.pending_revision = None;
        }
        if completed.is_empty() {
            Ok(None)
        } else {
            Ok(Some(completed))
        }
    }

    pub(crate) fn request_cached_previews(
        &mut self,
        backend: &NativeFemBackend,
        engine: FemEngine,
        display_selection: &DisplaySelectionState,
        plan: &FemPlanIR,
        node_count: usize,
    ) -> Result<Option<Vec<LivePreviewField>>, RunError> {
        if self
            .pending_revision
            .is_some_and(|revision| revision != display_selection.revision)
        {
            self.pending.clear();
            self.pending_revision = None;
        }

        let mut completed = self.poll_completed()?.unwrap_or_default();
        if self.pending.is_empty() && self.pending_revision != Some(display_selection.revision) {
            let materialization_quantities = field_materialization_quantity_ids();
            let quantities =
                active_fem_preview_quantities(engine, plan, &materialization_quantities);
            let base_request = display_selection.preview_request();
            for quantity in quantities {
                let mut request = base_request.clone();
                request.quantity = quantity.to_string();
                if is_fem_energy_density_quantity(&request.quantity) {
                    if let Ok(field) = backend.copy_live_preview_field(&request, node_count) {
                        completed.push(field);
                    }
                    continue;
                }
                if let Ok(snapshot) = backend.begin_live_preview_snapshot(&request) {
                    self.pending.push((request, snapshot));
                }
            }
            if !self.pending.is_empty() {
                self.pending_revision = Some(display_selection.revision);
            }
        }
        if let Some(mut ready) = self.poll_completed()? {
            completed.append(&mut ready);
        }
        if completed.is_empty() {
            Ok(None)
        } else {
            Ok(Some(completed))
        }
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
