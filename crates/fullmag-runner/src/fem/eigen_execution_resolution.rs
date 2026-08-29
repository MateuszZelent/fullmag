use crate::native_fem::NativeModalExecutionTarget;
use crate::types::{
    ExecutionProvenance, FemEigenNativeExecutionAttestation, ResolvedFallback, RunError,
};
use fullmag_ir::{
    ExecutionDevice, ExecutionPrecision, FemEigenEngineIR, FemEigenExecutionResolutionIR,
    FemEigenPlanIR,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FemEigenExecutionLane {
    Cpu,
    Gpu,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct PlannedFemEigenExecution<'a> {
    resolution: Option<&'a FemEigenExecutionResolutionIR>,
    lane: FemEigenExecutionLane,
    native_target: Option<NativeModalExecutionTarget>,
}

impl PlannedFemEigenExecution<'_> {
    pub(crate) fn resolution(&self) -> Option<&FemEigenExecutionResolutionIR> {
        self.resolution
    }

    pub(crate) fn lane(&self) -> FemEigenExecutionLane {
        self.lane
    }

    pub(crate) fn native_target(self) -> Option<NativeModalExecutionTarget> {
        self.native_target
    }

    pub(crate) fn engine_id(&self) -> &'static str {
        match self.resolution.map(|value| value.resolved_engine) {
            Some(FemEigenEngineIR::K0PoissonAirboxCpuSchurSlepc) => {
                "k0_poisson_airbox_cpu_schur_slepc"
            }
            Some(FemEigenEngineIR::GpuModalDeviceKrylov) => "gpu_modal_device_krylov",
            Some(FemEigenEngineIR::Auto) => "auto",
            None => match self.lane {
                FemEigenExecutionLane::Cpu => "fem_eigen_cpu_baseline",
                FemEigenExecutionLane::Gpu => "fem_eigen_native_gpu",
            },
        }
    }

    pub(crate) fn runtime_engine_id(&self) -> &'static str {
        match self.lane {
            FemEigenExecutionLane::Cpu => "fem_eigen_cpu_baseline",
            FemEigenExecutionLane::Gpu => "fem_eigen_native_gpu",
        }
    }

    pub(crate) fn bind_execution_provenance(&self, provenance: &mut ExecutionProvenance) {
        provenance.execution_engine = self.runtime_engine_id().to_string();
        let Some(resolution) = self.resolution else {
            return;
        };
        provenance.precision = execution_precision_id(resolution.resolved_precision).to_string();
        provenance.fem_eigen_execution_resolution = Some(resolution.clone());
        provenance.resolved_fallback = resolution.fallback_used.then(|| ResolvedFallback {
            occurred: true,
            original_engine: fem_eigen_engine_id(resolution.requested_engine).to_string(),
            fallback_engine: fem_eigen_engine_id(resolution.resolved_engine).to_string(),
            reason: resolution
                .fallback_reason
                .clone()
                .unwrap_or_else(|| "planner_fallback_reason_missing".to_string()),
            message: resolution.selection_reason.clone(),
        });
    }

    pub(crate) fn native_attestation(
        &self,
        resolved_target: Option<u32>,
        resolved_engine_id: &str,
        resolved_fallback_state: u32,
        resolved_fallback_reason: &str,
    ) -> FemEigenNativeExecutionAttestation {
        FemEigenNativeExecutionAttestation {
            requested_target: native_execution_target_id(self.native_target).to_string(),
            resolved_target: resolved_target
                .map(native_resolved_target_id)
                .unwrap_or("missing")
                .to_string(),
            resolved_engine_id: resolved_engine_id.to_string(),
            fallback_used: resolved_fallback_state != 0,
            fallback_reason: (!resolved_fallback_reason.is_empty()
                && resolved_fallback_reason != "none")
                .then(|| resolved_fallback_reason.to_string()),
        }
    }

    pub(crate) fn legacy(lane: FemEigenExecutionLane) -> Self {
        Self {
            resolution: None,
            lane,
            native_target: None,
        }
    }
}

fn execution_precision_id(precision: ExecutionPrecision) -> &'static str {
    match precision {
        ExecutionPrecision::Single => "single",
        ExecutionPrecision::Double => "double",
    }
}

fn fem_eigen_engine_id(engine: FemEigenEngineIR) -> &'static str {
    match engine {
        FemEigenEngineIR::Auto => "auto",
        FemEigenEngineIR::K0PoissonAirboxCpuSchurSlepc => "k0_poisson_airbox_cpu_schur_slepc",
        FemEigenEngineIR::GpuModalDeviceKrylov => "gpu_modal_device_krylov",
    }
}

fn native_execution_target_id(target: Option<NativeModalExecutionTarget>) -> &'static str {
    match target {
        Some(NativeModalExecutionTarget::ProductionCpu) => "production_cpu",
        Some(NativeModalExecutionTarget::ProductionGpu) => "production_gpu",
        Some(NativeModalExecutionTarget::Auto) => "auto",
        None => "not_attested",
    }
}

fn native_resolved_target_id(target: u32) -> &'static str {
    match target {
        1 => "production_cpu",
        2 => "production_gpu",
        _ => "unknown",
    }
}

pub(crate) fn resolve_fem_eigen_execution_resolution<'a>(
    plan: &FemEigenPlanIR,
    resolution: Option<&'a FemEigenExecutionResolutionIR>,
) -> Result<Option<PlannedFemEigenExecution<'a>>, RunError> {
    let bounded_k0 = super::eigen_policy::shared_domain_k0_modal_requested(plan);
    let reference_oracle = fem_eigen_reference_oracle_requested(plan);
    let Some(resolution) = resolution else {
        if bounded_k0 {
            return Err(RunError {
                message: "planned_fem_eigen_resolution_missing: bounded periodic_airbox_k0 plans must be replanned with FemEigenExecutionResolutionIR"
                    .to_string(),
            });
        }
        return Ok(None);
    };

    if reference_oracle {
        return Err(RunError {
            message: "planned_fem_eigen_reference_resolution_forbidden: production execution resolution cannot select an analytic or synthetic reference/oracle path"
                .to_string(),
        });
    }
    if !bounded_k0 {
        return Err(RunError {
            message: "planned_fem_eigen_resolution_scope_mismatch: exact K0 execution resolution is valid only for bounded periodic_airbox_k0"
                .to_string(),
        });
    }
    if resolution.fallback_used != resolution.fallback_reason.is_some() {
        return Err(RunError {
            message: "planned_fem_eigen_fallback_inconsistent: fallback_used must equal fallback_reason presence"
                .to_string(),
        });
    }
    if resolution.fallback_used
        && matches!(
            resolution.requested_device,
            ExecutionDevice::Cpu | ExecutionDevice::Gpu
        )
    {
        return Err(RunError {
            message: "planned_fem_eigen_explicit_fallback_forbidden: explicit CPU/GPU modal requests cannot fall back"
                .to_string(),
        });
    }
    if resolution.fallback_used
        && !(resolution.requested_device == ExecutionDevice::Auto
            && resolution.requested_engine == FemEigenEngineIR::Auto
            && resolution.resolved_device == ExecutionDevice::Cpu
            && resolution.resolved_engine == FemEigenEngineIR::K0PoissonAirboxCpuSchurSlepc
            && resolution.fallback_reason.as_deref() == Some("gpu_modal_device_krylov_unavailable"))
    {
        return Err(RunError {
            message: "planned_fem_eigen_fallback_forbidden: only planner-recorded auto GPU-unavailable to identical-physics CPU resolution is legal"
                .to_string(),
        });
    }
    if resolution.requested_precision != ExecutionPrecision::Double
        || resolution.resolved_precision != ExecutionPrecision::Double
        || plan.precision != resolution.resolved_precision
    {
        return Err(RunError {
            message: "planned_fem_eigen_resolution_mismatch: bounded K0 requires matching double precision in plan and execution resolution"
                .to_string(),
        });
    }

    let (lane, native_target) = match resolution.resolved_engine {
        FemEigenEngineIR::Auto => {
            return Err(RunError {
                message: "planned_fem_eigen_resolved_engine_auto: materialized execution must name one exact CPU or GPU engine"
                    .to_string(),
            });
        }
        FemEigenEngineIR::K0PoissonAirboxCpuSchurSlepc
            if resolution.resolved_device == ExecutionDevice::Cpu =>
        {
            (
                FemEigenExecutionLane::Cpu,
                NativeModalExecutionTarget::ProductionCpu,
            )
        }
        FemEigenEngineIR::GpuModalDeviceKrylov
            if resolution.resolved_device == ExecutionDevice::Gpu =>
        {
            (
                FemEigenExecutionLane::Gpu,
                NativeModalExecutionTarget::ProductionGpu,
            )
        }
        _ => {
            return Err(RunError {
                message: "planned_fem_eigen_resolution_mismatch: resolved device and exact engine disagree"
                    .to_string(),
            });
        }
    };
    validate_bias_field_sample_execution_resolutions(plan, resolution)?;
    Ok(Some(PlannedFemEigenExecution {
        resolution: Some(resolution),
        lane,
        native_target: Some(native_target),
    }))
}

pub(crate) fn resolve_planned_fem_eigen_execution<'a>(
    plan: &'a fullmag_ir::ExecutionPlanIR,
    fem: &FemEigenPlanIR,
) -> Result<Option<PlannedFemEigenExecution<'a>>, RunError> {
    resolve_fem_eigen_execution_resolution(
        fem,
        plan.provenance.fem_eigen_execution_resolution.as_ref(),
    )
}

pub(crate) fn validate_bias_field_sample_execution_resolutions(
    plan: &FemEigenPlanIR,
    resolution: &FemEigenExecutionResolutionIR,
) -> Result<(), RunError> {
    for sample in &plan.bias_field_samples {
        if sample.execution != *resolution {
            return Err(RunError {
                message: format!(
                    "planned_fem_eigen_sweep_resolution_mismatch: sample_index={} does not equal top-level execution resolution",
                    sample.sample_index
                ),
            });
        }
    }
    Ok(())
}

fn fem_eigen_reference_oracle_requested(plan: &FemEigenPlanIR) -> bool {
    let analytic = plan
        .dispersion_validation
        .as_ref()
        .is_some_and(|validation| {
            validation.kind == "thin_film_de_bv_low_k"
                && validation.analytic_model == "kalinikos_slab_n0"
        });
    let synthetic = plan
        .k0_kittel_validation
        .as_ref()
        .is_some_and(|validation| {
            validation.kind == "k0_kittel_field_sweep"
                && validation.case_id.as_deref() == Some("K0-3")
                && validation.demag_kind.as_deref() == Some("synthetic_demag_factor")
                && validation.model == "thin_film_in_plane"
        });
    analytic || synthetic
}
