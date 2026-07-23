//! FEM relaxation entry point and algorithm dispatch.
//!
//! This module owns the top-level orchestration of FEM relaxation stages.
//! It maps `RelaxationAlgorithmIR` variants to their FEM-specific execution
//! lanes and delegates stop-criteria evaluation to [`stop`].
//!
//! # Algorithm support matrix (FEM)
//!
//! | Algorithm               | CPU MFEM | GPU native | Notes                               |
//! |-------------------------|----------|------------|-------------------------------------|
//! | `LlgOverdamped`         | ✓        | ✓          | primary production path             |
//! | `ProjectedGradientBb`   | ✓        | ✓          | native MFEM/CUDA relaxation ABI     |
//! | `NonlinearCg`           | ✓        | ✓          | native MFEM/CUDA relaxation ABI     |
//! | `TangentPlaneImplicit`  | dev      | dev        | under development; not production-qualified |

pub mod algorithm;
#[cfg(feature = "fem-gpu")]
pub(crate) mod direct_minimizer;
#[cfg(feature = "fem-gpu")]
pub(crate) mod finalize;
pub mod llg_overdamped;
#[cfg(feature = "fem-gpu")]
pub(crate) mod preview;
#[cfg(feature = "fem-gpu")]
pub(crate) mod scalars;
#[cfg(feature = "fem-gpu")]
pub(crate) mod snapshots;
pub mod stop;

use fullmag_ir::{FemPlanIR, OutputIR};

use crate::artifact_pipeline::ArtifactPipelineSender;
use crate::dispatch::{execute_fem, execute_fem_with_context, FemEngine};
use crate::types::FemStageExecutionContext;
use crate::types::{ExecutedRun, LiveStepConsumer, RunError};

use super::engine::FemEngineKind;

// ── Public entry point ────────────────────────────────────────────────────────

/// Execute a FEM relaxation stage.
///
/// This is the single entry point for all FEM relaxation algorithms.
/// It validates that the requested algorithm is supported on the chosen
/// engine, applies algorithm-specific provenance fields, then delegates
/// to the underlying backend.
///
/// # Errors
///
/// Returns [`RunError`] if:
/// * the selected engine cannot execute the requested algorithm,
/// * the backend returns an execution error.
pub fn execute_fem_relax<'a>(
    engine: FemEngineKind,
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    live: Option<LiveStepConsumer<'a>>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    // Validate algorithm support on the requested engine.
    algorithm::check_algorithm_support(plan.relaxation.as_ref(), engine)?;

    // Map our local engine kind back to the dispatch enum that execute_fem()
    // expects.  This bridge will shrink as dispatch.rs is split further.
    let dispatch_engine = match engine {
        FemEngineKind::CpuNative => FemEngine::CpuNative,
        FemEngineKind::NativeGpu => FemEngine::NativeGpu,
    };

    execute_fem(
        dispatch_engine,
        plan,
        until_seconds,
        outputs,
        live,
        artifact_writer,
    )
}

pub(crate) fn execute_fem_relax_with_context<'a>(
    engine: FemEngineKind,
    plan: &FemPlanIR,
    stage_context: &FemStageExecutionContext,
    until_seconds: f64,
    outputs: &[OutputIR],
    live: Option<LiveStepConsumer<'a>>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    algorithm::check_algorithm_support(plan.relaxation.as_ref(), engine)?;
    let dispatch_engine = match engine {
        FemEngineKind::CpuNative => FemEngine::CpuNative,
        FemEngineKind::NativeGpu => FemEngine::NativeGpu,
    };
    execute_fem_with_context(
        dispatch_engine,
        plan,
        stage_context,
        until_seconds,
        outputs,
        live,
        artifact_writer,
    )
}
