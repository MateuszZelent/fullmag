//! FEM engine selection — which backend (CPU MFEM vs GPU) handles a plan.
//!
//! This module re-exports `FemEngine` from the dispatch layer and adds
//! FEM-specific availability helpers so that the rest of the `fem/` package
//! does not import from `dispatch` directly.

use fullmag_ir::FemPlanIR;

use crate::native_fem::{is_cpu_available, is_gpu_available, native_availability, GpuAvailability};
use crate::types::RunError;

// ── Engine variant ────────────────────────────────────────────────────────────

/// Which runtime lane executes a FEM plan.
///
/// Prefer `resolve_engine` over constructing this directly; the variant must
/// match what the native C ABI and MFEM/libCEED/hypre stack actually support.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FemEngineKind {
    /// MFEM / libCEED / hypre on host CPU.
    CpuNative,
    /// MFEM stack on a CUDA device.
    NativeGpu,
}

impl FemEngineKind {
    /// Stable string identifier used in provenance and log messages.
    pub fn id(self) -> &'static str {
        match self {
            FemEngineKind::CpuNative => "fem_cpu_native",
            FemEngineKind::NativeGpu => "fem_native_gpu",
        }
    }

    /// Human-readable label for UI and CLI output.
    pub fn label(self) -> &'static str {
        match self {
            FemEngineKind::CpuNative => "FEM CPU (MFEM/libCEED/hypre)",
            FemEngineKind::NativeGpu => "FEM GPU (native CUDA)",
        }
    }
}

impl std::fmt::Display for FemEngineKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.id())
    }
}

// ── Availability ──────────────────────────────────────────────────────────────

/// Checks whether the CPU FEM native backend (MFEM/libCEED/hypre) is compiled
/// in and available at runtime.
pub fn cpu_available() -> bool {
    is_cpu_available()
}

/// Checks whether the GPU FEM native backend (CUDA) is compiled in and
/// available at runtime.
pub fn gpu_available() -> bool {
    is_gpu_available()
}

/// Returns the full availability struct, including build flags, device counts,
/// and GPU memory.
pub fn availability() -> GpuAvailability {
    native_availability()
}

/// Returns the first plan-level reason why the native device-resident explicit
/// RK path cannot execute `plan`.
///
/// Runtime-owned prerequisites such as successful `FemGpuState` allocation,
/// uploaded geometry, and hypre-device workspace are still checked by the
/// native `gpu_rk_plan_device_resident` contract before provenance is built.
pub(crate) fn gpu_rk_plan_preflight_block_reason(plan: &FemPlanIR) -> Option<&'static str> {
    if let Some(contract) = plan.spin_torque_contract.as_ref() {
        match contract.formula_version.as_str() {
            "slonczewski.fullmag.v1" => {
                return Some("canonical FEM STT formula_version=slonczewski.fullmag.v1 is CPU-only until an identical qualified device realization exists");
            }
            "zhang_li.fullmag.v1" => {
                return Some("canonical FEM STT formula_version=zhang_li.fullmag.v1 is CPU-only until an identical qualified device realization exists");
            }
            _ => {}
        }
    }
    if !plan.enable_exchange {
        return Some("GPU RK device-resident path requires enable_exchange=true");
    }
    if matches!(plan.integrator, Some(fullmag_ir::IntegratorChoice::Abm3)) {
        return Some(
            "GPU RK device-resident path currently supports Heun, RK4, RK23, and RK45 only",
        );
    }
    None
}

// ── Engine resolution ─────────────────────────────────────────────────────────

/// Reads `FULLMAG_FEM_EXECUTION` from the environment and returns the
/// appropriate `FemEngineKind`, honouring the requested device/precision in
/// `plan`.
///
/// Mirrors the logic that lives in `dispatch::resolve_fem_engine` but scoped
/// to the `fem/` package so other code in this module does not need to import
/// from `dispatch`.
pub fn resolve_engine_for_plan(
    problem: &fullmag_ir::ProblemIR,
    plan: &FemPlanIR,
) -> Result<FemEngineKind, RunError> {
    use crate::dispatch::FemEngine;
    let engine =
        crate::dispatch::resolve_fem_engine_for_plan_with_trail(problem, plan).map(|r| r.engine)?;
    Ok(match engine {
        FemEngine::CpuNative => FemEngineKind::CpuNative,
        FemEngine::NativeGpu => FemEngineKind::NativeGpu,
    })
}

// ── Device label helpers ──────────────────────────────────────────────────────

/// Returns a short device label used in run diagnostics
/// (e.g. ``"cpu"`` or ``"gpu:NVIDIA A100"``) for the resolved engine.
pub fn device_label(kind: FemEngineKind) -> &'static str {
    match kind {
        FemEngineKind::CpuNative => "cpu",
        FemEngineKind::NativeGpu => "gpu",
    }
}
