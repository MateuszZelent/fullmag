//! Engine dispatch: selects between CPU reference and native CUDA backends.
//!
//! Reads `FULLMAG_FDM_EXECUTION` env var:
//! - `auto` (default): use CUDA if compiled and available, else CPU
//! - `cpu`: force CPU reference
//! - `cuda`: force CUDA, fail if unavailable

use fullmag_ir::{FdmPlanIR, OutputIR};

use crate::cpu_reference;
use crate::native_fdm;
use crate::types::{ExecutedRun, RunError};

/// Which execution engine to use for FDM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FdmEngine {
    /// CPU reference engine (fullmag-engine).
    CpuReference,
    /// Native CUDA FDM backend.
    CudaFdm,
}

/// Resolve which FDM engine to use based on environment and availability.
pub(crate) fn resolve_fdm_engine() -> Result<FdmEngine, RunError> {
    let policy = std::env::var("FULLMAG_FDM_EXECUTION").unwrap_or_else(|_| "auto".into());

    match policy.as_str() {
        "cpu" => Ok(FdmEngine::CpuReference),
        "cuda" => {
            if native_fdm::is_cuda_available() {
                Ok(FdmEngine::CudaFdm)
            } else {
                Err(RunError {
                    message: "FULLMAG_FDM_EXECUTION=cuda but CUDA backend is not available"
                        .to_string(),
                })
            }
        }
        "auto" | _ => {
            if native_fdm::is_cuda_available() {
                Ok(FdmEngine::CudaFdm)
            } else {
                Ok(FdmEngine::CpuReference)
            }
        }
    }
}

/// Execute an FDM plan using the selected engine.
pub(crate) fn execute_fdm(
    engine: FdmEngine,
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    match engine {
        FdmEngine::CpuReference => {
            cpu_reference::execute_reference_fdm(plan, until_seconds, outputs)
        }
        FdmEngine::CudaFdm => {
            // Phase 2 WP6: full CUDA execution loop
            // For now, error honestly
            Err(RunError {
                message: "CUDA FDM execution loop not yet implemented (WP5/WP6 pending)"
                    .to_string(),
            })
        }
    }
}
