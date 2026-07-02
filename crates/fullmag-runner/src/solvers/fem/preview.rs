//! FEM preview routing after runtime lane selection.

use fullmag_ir::FemPlanIR;

use crate::fem::pbc::fem_static_periodic_decision;
use crate::fem_baseline;
#[cfg(feature = "fem-gpu")]
use crate::native_fem::NativeFemBackend;
use crate::quantities::active_fem_preview_quantities;
#[cfg(feature = "fem-gpu")]
use crate::quantities::normalized_quantity_name;
use crate::solver_runtime::engine::FemEngine;
use crate::types::{LivePreviewField, LivePreviewRequest, RunError};

pub(crate) fn snapshot_fem_preview(
    engine: FemEngine,
    plan: &FemPlanIR,
    request: &LivePreviewRequest,
) -> Result<LivePreviewField, RunError> {
    let requested = [request.quantity.as_str()];
    if active_fem_preview_quantities(engine, plan, &requested).is_empty() {
        return Err(RunError {
            message: format!(
                "preview quantity '{}' is not active for the current FEM problem",
                request.quantity
            ),
        });
    }
    if !fem_static_periodic_decision(plan).is_native() {
        return fem_baseline::snapshot_preview(plan, request);
    }
    match engine {
        FemEngine::CpuNative => {
            let cpu_plan = fem_plan_for_cpu_native(plan);
            snapshot_native_fem_preview(&cpu_plan, request)
        }
        FemEngine::NativeGpu => {
            let gpu_plan = fem_plan_for_native_gpu(plan);
            snapshot_native_fem_preview(&gpu_plan, request)
        }
    }
}

pub(crate) fn snapshot_fem_vector_fields(
    engine: FemEngine,
    plan: &FemPlanIR,
    quantities: &[&str],
    request: &LivePreviewRequest,
) -> Result<Vec<LivePreviewField>, RunError> {
    let quantities = active_fem_preview_quantities(engine, plan, quantities);
    if !fem_static_periodic_decision(plan).is_native() {
        return fem_baseline::snapshot_vector_fields(plan, &quantities, request);
    }
    match engine {
        FemEngine::CpuNative => {
            let cpu_plan = fem_plan_for_cpu_native(plan);
            snapshot_native_fem_vector_fields(&cpu_plan, &quantities, request)
        }
        FemEngine::NativeGpu => {
            let gpu_plan = fem_plan_for_native_gpu(plan);
            snapshot_native_fem_vector_fields(&gpu_plan, &quantities, request)
        }
    }
}

pub(crate) fn fem_plan_for_cpu_native(plan: &FemPlanIR) -> FemPlanIR {
    let mut cpu_plan = plan.clone();
    if cpu_plan.mfem_device_string.is_none() {
        cpu_plan.mfem_device_string = Some("cpu".to_string());
    }
    cpu_plan
}

pub(crate) fn fem_plan_for_native_gpu(plan: &FemPlanIR) -> FemPlanIR {
    let mut gpu_plan = plan.clone();
    if gpu_plan.mfem_device_string.is_none() {
        let mfem_device = std::env::var("FULLMAG_FEM_MFEM_DEVICE")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| crate::native_fem::native_fem_mfem_device_string_requests_gpu(value))
            .unwrap_or_else(|| "cuda".to_string());
        gpu_plan.mfem_device_string = Some(mfem_device);
    }
    gpu_plan
}

#[cfg(feature = "fem-gpu")]
fn snapshot_native_fem_preview(
    plan: &FemPlanIR,
    request: &LivePreviewRequest,
) -> Result<LivePreviewField, RunError> {
    let mut backend = NativeFemBackend::create(plan)?;
    // Compute effective fields so copy_live_preview_field can serve every observable.
    let node_count = plan.mesh.nodes.len();
    let _ = backend.snapshot_step_stats(node_count)?;
    backend.copy_live_preview_field(request, node_count)
}

#[cfg(feature = "fem-gpu")]
fn snapshot_native_fem_vector_fields(
    plan: &FemPlanIR,
    quantities: &[&str],
    request: &LivePreviewRequest,
) -> Result<Vec<LivePreviewField>, RunError> {
    let mut backend = NativeFemBackend::create(plan)?;
    // Compute effective fields so non-magnetization observables are available.
    let node_count = plan.mesh.nodes.len();
    let _ = backend.snapshot_step_stats(node_count)?;
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
        cached.push(backend.copy_live_preview_field(&preview_request, plan.mesh.nodes.len())?);
    }

    Ok(cached)
}

#[cfg(not(feature = "fem-gpu"))]
fn snapshot_native_fem_preview(
    _plan: &FemPlanIR,
    _request: &LivePreviewRequest,
) -> Result<LivePreviewField, RunError> {
    Err(RunError {
        message: "native FEM preview snapshot requested but fullmag-runner was built without the 'fem-gpu' feature".to_string(),
    })
}

#[cfg(not(feature = "fem-gpu"))]
fn snapshot_native_fem_vector_fields(
    _plan: &FemPlanIR,
    _quantities: &[&str],
    _request: &LivePreviewRequest,
) -> Result<Vec<LivePreviewField>, RunError> {
    Err(RunError {
        message:
            "native FEM vector-field cache requested but fullmag-runner was built without the 'fem-gpu' feature"
                .to_string(),
    })
}
