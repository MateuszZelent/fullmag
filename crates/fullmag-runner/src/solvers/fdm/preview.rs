//! FDM preview routing after runtime lane selection.

use fullmag_ir::FdmPlanIR;

use crate::fdm::cpu::reference as cpu_reference;
#[cfg(feature = "cuda")]
use crate::fdm::gpu::cuda::native::NativeFdmBackend;
use crate::quantities::active_fdm_preview_quantities;
#[cfg(feature = "cuda")]
use crate::quantities::normalized_quantity_name;
use crate::solver_runtime::engine::FdmEngine;
use crate::types::{LivePreviewField, LivePreviewRequest, RunError};

pub(crate) fn snapshot_fdm_preview(
    engine: FdmEngine,
    plan: &FdmPlanIR,
    request: &LivePreviewRequest,
) -> Result<LivePreviewField, RunError> {
    let requested = [request.quantity.as_str()];
    if active_fdm_preview_quantities(engine, plan, &requested).is_empty() {
        return Err(RunError {
            message: format!(
                "preview quantity '{}' is not active for the current FDM problem",
                request.quantity
            ),
        });
    }
    match engine {
        FdmEngine::CpuReference => cpu_reference::snapshot_preview(plan, request),
        FdmEngine::CudaFdm => snapshot_native_fdm_preview(plan, request),
    }
}

pub(crate) fn snapshot_fdm_vector_fields(
    engine: FdmEngine,
    plan: &FdmPlanIR,
    quantities: &[&str],
    request: &LivePreviewRequest,
) -> Result<Vec<LivePreviewField>, RunError> {
    let quantities = active_fdm_preview_quantities(engine, plan, quantities);
    match engine {
        FdmEngine::CpuReference => {
            cpu_reference::snapshot_vector_fields(plan, &quantities, request)
        }
        FdmEngine::CudaFdm => snapshot_native_fdm_vector_fields(plan, &quantities, request),
    }
}

#[cfg(feature = "cuda")]
fn snapshot_native_fdm_preview(
    plan: &FdmPlanIR,
    request: &LivePreviewRequest,
) -> Result<LivePreviewField, RunError> {
    let backend = NativeFdmBackend::create(plan)?;
    backend.copy_live_preview_field(request, plan.grid.cells, plan.active_mask.as_deref())
}

#[cfg(feature = "cuda")]
fn snapshot_native_fdm_vector_fields(
    plan: &FdmPlanIR,
    quantities: &[&str],
    request: &LivePreviewRequest,
) -> Result<Vec<LivePreviewField>, RunError> {
    let backend = NativeFdmBackend::create(plan)?;
    let mut cached = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for quantity in quantities
        .iter()
        .filter_map(|quantity| normalized_quantity_name(quantity).ok())
    {
        if !seen.insert(quantity) {
            continue;
        }
        let mut preview_request = request.clone();
        preview_request.quantity = quantity.to_string();
        cached.push(backend.copy_live_preview_field(
            &preview_request,
            plan.grid.cells,
            plan.active_mask.as_deref(),
        )?);
    }

    Ok(cached)
}

#[cfg(not(feature = "cuda"))]
fn snapshot_native_fdm_preview(
    _plan: &FdmPlanIR,
    _request: &LivePreviewRequest,
) -> Result<LivePreviewField, RunError> {
    Err(RunError {
        message: "CUDA FDM preview snapshot requested but fullmag-runner was built without the 'cuda' feature".to_string(),
    })
}

#[cfg(not(feature = "cuda"))]
fn snapshot_native_fdm_vector_fields(
    _plan: &FdmPlanIR,
    _quantities: &[&str],
    _request: &LivePreviewRequest,
) -> Result<Vec<LivePreviewField>, RunError> {
    Err(RunError {
        message: "CUDA FDM vector-field cache requested but fullmag-runner was built without the 'cuda' feature".to_string(),
    })
}
