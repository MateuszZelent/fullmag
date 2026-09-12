#[cfg(feature = "fem-gpu")]
use crate::relaxation::llg_overdamped_uses_pure_damping;

#[cfg(feature = "fem-gpu")]
use fullmag_fem_sys as ffi;

#[cfg(feature = "fem-gpu")]
pub(super) fn has_slonczewski_stt(plan: &fullmag_ir::FemPlanIR) -> bool {
    plan.current_density.is_some()
        && plan.stt_degree.is_some()
        && plan.stt_spin_polarization.is_some()
        && plan.stt_lambda.is_some()
}

#[cfg(feature = "fem-gpu")]
pub(super) fn has_zhang_li_stt(plan: &fullmag_ir::FemPlanIR) -> bool {
    plan.current_density.is_some() && plan.stt_degree.is_some() && !has_slonczewski_stt(plan)
}

#[cfg(feature = "fem-gpu")]
pub(super) fn native_fem_precession_enabled(plan: &fullmag_ir::FemPlanIR) -> bool {
    !llg_overdamped_uses_pure_damping(plan.relaxation.as_ref())
}

#[cfg(feature = "fem-gpu")]
pub(super) fn single_precision_rejection(plan: &fullmag_ir::FemPlanIR) -> &'static str {
    if !native_fem_plan_requests_gpu_mfem_device(plan) {
        "MFEM/libCEED/hypre CPU FEM backend currently supports only double precision; single precision is not implemented"
    } else {
        "native FEM GPU backend requires double precision; single-precision CUDA kernels are not yet implemented"
    }
}

#[cfg(feature = "fem-gpu")]
pub(super) fn native_fem_gpu_demag_mode(plan: &fullmag_ir::FemPlanIR) -> i32 {
    if !native_fem_plan_requests_gpu_mfem_device(plan) || !plan.enable_demag {
        return ffi::fullmag_fem_gpu_demag_mode::FULLMAG_FEM_GPU_DEMAG_UNSPECIFIED as i32;
    }
    if plan.demag_realization == Some(fullmag_ir::ResolvedFemDemagIR::FredkinKoehler) {
        return ffi::fullmag_fem_gpu_demag_mode::FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_FEM_BEM
            as i32;
    }
    match std::env::var("FULLMAG_FEM_GPU_DEMAG_MODE")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("hybrid_cpu_poisson") | Some("hybrid") | Some("compat") => {
            ffi::fullmag_fem_gpu_demag_mode::FULLMAG_FEM_GPU_DEMAG_HYBRID_CPU_POISSON as i32
        }
        _ => ffi::fullmag_fem_gpu_demag_mode::FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON as i32,
    }
}

#[cfg(feature = "fem-gpu")]
pub(crate) fn resolved_native_fem_demag_solver_policy(
    plan: &fullmag_ir::FemPlanIR,
) -> fullmag_ir::FemLinearSolverPolicy {
    if let Some(policy) = plan.demag_solver_policy.clone() {
        return policy;
    }

    let mut policy = fullmag_ir::FemLinearSolverPolicy::default();
    if plan.enable_demag && native_fem_plan_requests_gpu_mfem_device(plan) {
        policy.preconditioner = if plan.relaxation.as_ref().is_some_and(|control| {
            matches!(
                control.algorithm,
                fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb
            )
        }) {
            "AMG"
        } else {
            "JACOBI"
        }
        .to_string();
    }
    policy
}

#[allow(dead_code)]
pub(crate) fn native_fem_plan_requests_gpu_mfem_device(plan: &fullmag_ir::FemPlanIR) -> bool {
    if let Some(device) = plan
        .mfem_device_string
        .as_deref()
        .map(str::trim)
        .filter(|device| !device.is_empty())
    {
        return native_fem_mfem_device_string_requests_gpu(device);
    }

    match std::env::var("FULLMAG_FEM_MFEM_DEVICE") {
        Ok(device) => native_fem_mfem_device_string_requests_gpu(device.trim()),
        Err(_) => false,
    }
}

pub(crate) fn native_fem_mfem_device_string_requests_gpu(device: &str) -> bool {
    let device = device.trim().to_ascii_lowercase();
    if device.is_empty() {
        return false;
    }
    if device == "cuda"
        || device == "hip"
        || device.starts_with("raja-cuda")
        || device.starts_with("raja-hip")
        || device.starts_with("occa-cuda")
        || device.starts_with("ceed-cuda")
        || device.starts_with("ceed/cuda")
        || device.contains("/gpu/")
    {
        return true;
    }
    if device == "cpu"
        || device == "omp"
        || device.starts_with("ceed-cpu")
        || device.starts_with("ceed/cpu")
        || device.starts_with("ceed-omp")
        || device.starts_with("ceed/omp")
        || device.starts_with("raja-omp")
    {
        return false;
    }
    true
}
