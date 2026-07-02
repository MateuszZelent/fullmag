//! Backend-neutral engine identifiers used by dispatch and runtime metadata.

use crate::types::ResolvedFallback;

/// Which execution engine to use for FDM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FdmEngine {
    /// CPU reference engine (fullmag-engine).
    CpuReference,
    /// Native CUDA FDM backend.
    CudaFdm,
}

/// Which public FEM runtime lane to use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FemEngine {
    /// Sole maintained CPU FEM backend (MFEM/libCEED/hypre on host CPU).
    CpuNative,
    /// MFEM-backed GPU FEM backend on CUDA.
    NativeGpu,
}

#[derive(Debug, Clone)]
pub(crate) struct EngineResolution<E> {
    pub engine: E,
    pub fallback: Option<ResolvedFallback>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DispatchEngine {
    Fdm(FdmEngine),
    Fem(FemEngine),
}

#[derive(Debug, Clone)]
pub(crate) struct DispatchEngineResolution {
    pub engine: DispatchEngine,
    pub fallback: Option<ResolvedFallback>,
    pub runtime_family: Option<String>,
    pub worker: Option<String>,
    pub resolved_backend: String,
    pub resolved_device: String,
    pub resolved_precision: String,
}

pub(crate) fn fdm_engine_id(engine: FdmEngine) -> &'static str {
    match engine {
        FdmEngine::CpuReference => "fdm_cpu_reference",
        FdmEngine::CudaFdm => "fdm_cuda",
    }
}

pub(crate) fn fem_engine_id(engine: FemEngine) -> &'static str {
    match engine {
        FemEngine::CpuNative => "fem_cpu_native",
        FemEngine::NativeGpu => "fem_native_gpu",
    }
}

pub(crate) fn fem_eigen_engine_id(engine: FemEngine) -> &'static str {
    match engine {
        FemEngine::CpuNative => "fem_eigen_cpu_baseline",
        FemEngine::NativeGpu => "fem_eigen_native_gpu",
    }
}

/// Human-readable engine label for diagnostics/logging.
pub(crate) fn fem_engine_label(engine: FemEngine) -> &'static str {
    fem_engine_id(engine)
}
