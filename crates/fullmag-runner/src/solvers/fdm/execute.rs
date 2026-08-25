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
    execute_fdm_in_mode(
        engine,
        fullmag_ir::BackendTarget::Fdm,
        if engine == FdmEngine::CudaFdm {
            "gpu"
        } else {
            "cpu"
        },
        fullmag_ir::ExecutionMode::Strict,
        plan,
        until_seconds,
        outputs,
        live,
        artifact_writer,
    )
}

pub(crate) fn execute_fdm_in_mode<'a>(
    engine: FdmEngine,
    requested_backend: fullmag_ir::BackendTarget,
    requested_device: &str,
    execution_mode: fullmag_ir::ExecutionMode,
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    live: Option<LiveStepConsumer<'a>>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    use crate::fdm::gpu::cuda::route::{public_gpu_transport_route, PublicGpuTransportRoute};

    let transport_route = public_gpu_transport_route(plan, matches!(engine, FdmEngine::CudaFdm));
    if matches!(transport_route, PublicGpuTransportRoute::InvalidGpuSpinPlan) {
        let _ = (until_seconds, outputs, live, artifact_writer);
        return Err(RunError {
            message: "public FDM GPU M1 spin execution requires exactly one requested/resolved GPU plan with exactly one fdm_gpu_double descriptor; fallback and partial execution are forbidden"
                .to_string(),
        });
    }
    if matches!(
        transport_route,
        PublicGpuTransportRoute::SpinOnNonCudaForbidden
    ) {
        let _ = (until_seconds, outputs, live, artifact_writer);
        return Err(RunError {
            message: "public FDM GPU M1 spin plan resolved to a non-CUDA engine; hidden fallback is forbidden"
                .to_string(),
        });
    }
    if matches!(transport_route, PublicGpuTransportRoute::ChargeOnly) {
        if !matches!(engine, FdmEngine::CudaFdm) {
            return Err(RunError {
                message: "public FDM GPU charge-only plan resolved to a non-CUDA engine; fallback is forbidden"
                    .to_string(),
            });
        }
        #[cfg(feature = "cuda")]
        {
            let _ = (until_seconds, outputs, live);
            return crate::fdm::gpu::cuda::charge_transport::execute_public_gpu_charge_only(
                plan,
                artifact_writer,
            );
        }
        #[cfg(not(feature = "cuda"))]
        {
            let _ = (until_seconds, outputs, live, artifact_writer);
            return Err(RunError {
                message: "public FDM GPU charge-only execution requires a runner built with the cuda feature; fallback is forbidden"
                    .to_string(),
            });
        }
    }
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
    let mut executed = match engine {
        FdmEngine::CpuReference => cpu_reference::execute_reference_fdm(
            plan,
            until_seconds,
            outputs,
            live,
            artifact_writer,
        ),
        FdmEngine::CudaFdm => execute_cuda_fdm(
            requested_backend,
            requested_device,
            execution_mode,
            plan,
            until_seconds,
            outputs,
            live,
            artifact_writer,
        ),
    }?;
    if let Some(artifact) = crate::regional_field_drive_artifacts::regional_field_drive_artifact(
        &plan.field_drives,
        &plan.time_stage,
        until_seconds,
        outputs,
        &executed.provenance,
    )? {
        executed.auxiliary_artifacts.push(artifact);
    }
    Ok(executed)
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
