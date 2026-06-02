//! Cached-preview helpers for native FEM relaxation.
//!
//! These helpers keep display-quantity switching warm during relaxation
//! without making the dispatch layer own relaxation preview behavior.

use fullmag_ir::FemPlanIR;

use crate::dispatch::FemEngine;
use crate::interactive_runtime::cached_preview_quantities_for;
use crate::native_fem::NativeFemBackend;
use crate::quantities::active_fem_preview_quantities;

/// Build cached preview fields for all non-active FEM quantities.
///
/// This mirrors the cached-preview logic in `CudaInteractiveFdmPreviewRuntime`
/// so that switching display-quantity in the frontend finds data in the cache
/// immediately.
pub(crate) fn build_fem_cached_preview_fields(
    backend: &NativeFemBackend,
    display_selection: &crate::DisplaySelectionState,
    plan: &FemPlanIR,
    node_count: usize,
) -> Option<Vec<crate::LivePreviewField>> {
    let quantities = active_fem_preview_quantities(
        FemEngine::NativeGpu,
        plan,
        &cached_preview_quantities_for(display_selection),
    );
    if quantities.is_empty() {
        return None;
    }
    let base_request = display_selection.preview_request();
    let mut cached = Vec::new();
    for quantity in quantities {
        let mut req = base_request.clone();
        req.quantity = quantity.to_string();
        match backend.copy_live_preview_field(&req, node_count) {
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
