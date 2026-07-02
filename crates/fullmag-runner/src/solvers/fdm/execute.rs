//! FDM execution routing between CPU reference and native CUDA backends.

use fullmag_ir::{FdmMultilayerPlanIR, FdmPlanIR, OutputIR};

use crate::artifact_pipeline::ArtifactPipelineSender;
use crate::fdm::cpu::multilayer_reference;
use crate::fdm::cpu::reference as cpu_reference;
use crate::fdm::gpu::cuda::execute::execute_cuda_fdm;
#[cfg(feature = "cuda")]
use crate::fdm::gpu::cuda::multilayer as multilayer_cuda;
use crate::solver_runtime::engine::FdmEngine;
use crate::solvers::fdm::interactions::capabilities::unsupported_cpu_fdm_terms;
use crate::types::{ExecutedRun, LiveStepConsumer, RunError, StepAction, StepUpdate};

/// Execute an FDM plan using the selected engine.
pub(crate) fn execute_fdm<'a>(
    engine: FdmEngine,
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    live: Option<LiveStepConsumer<'a>>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    if matches!(engine, FdmEngine::CpuReference) {
        let unsupported = unsupported_cpu_fdm_terms(plan, outputs);
        if !unsupported.is_empty() {
            return Err(RunError {
                message: format!(
                    "CPU reference FDM engine cannot execute this plan faithfully; unsupported terms: [{}]",
                    unsupported.join(", ")
                ),
            });
        }
    }
    match engine {
        FdmEngine::CpuReference => cpu_reference::execute_reference_fdm(
            plan,
            until_seconds,
            outputs,
            live,
            artifact_writer,
        ),
        FdmEngine::CudaFdm => execute_cuda_fdm(plan, until_seconds, outputs, live, artifact_writer),
    }
}

/// Execute a multilayer FDM plan using the selected engine.
pub(crate) fn execute_fdm_multilayer<'a>(
    engine: FdmEngine,
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    live: Option<(&'a [u32; 3], &'a mut dyn FnMut(StepUpdate) -> StepAction)>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    match engine {
        FdmEngine::CpuReference => multilayer_reference::execute_reference_fdm_multilayer(
            plan,
            until_seconds,
            outputs,
            live,
            artifact_writer,
        ),
        FdmEngine::CudaFdm => {
            #[cfg(feature = "cuda")]
            {
                return multilayer_cuda::execute_cuda_fdm_multilayer_with_live(
                    plan,
                    until_seconds,
                    outputs,
                    live,
                    artifact_writer,
                );
            }
            #[cfg(not(feature = "cuda"))]
            {
                return Err(RunError {
                    message:
                        "FULLMAG_FDM_EXECUTION=cuda requested for multilayer FDM, but fullmag-runner was built without the cuda feature"
                            .to_string(),
                });
            }
        }
    }
}
