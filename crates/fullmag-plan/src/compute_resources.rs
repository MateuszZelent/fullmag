//! Transitional admission capability gate for typed resource authoring.
//! E2/E3 replace each restriction with the corresponding verified adapter.

use fullmag_ir::{
    ComputeParallelismIR, ComputePlacementIR, ComputeResourcesIR, ComputeTargetIR, CpuAffinityIR,
    RequestedThreads,
};

pub(crate) fn validate_current_runtime_support(
    resources: &ComputeResourcesIR,
) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    if resources.target != ComputeTargetIR::Local {
        errors.push(
            "compute_target_requires_resource_admission: node/pool placement is not integrated yet"
                .into(),
        );
    }
    if resources.parallelism != ComputeParallelismIR::SingleProcess {
        errors.push("unsupported_parallelism: distributed solve requires a qualified runtime and gang allocation".into());
    }
    if resources.gpu.is_some()
        || resources.ram.reservation_bytes.is_some()
        || resources.scratch.reservation_bytes.is_some()
        || resources.placement != ComputePlacementIR::Balanced
    {
        errors.push("compute_resources_requires_allocation: GPU selectors, memory reservations and placement require the resource admission adapter".into());
    }
    if resources.cpu.core_policy.is_some()
        || resources.cpu.affinity != CpuAffinityIR::Auto
        || resources.cpu.native_threads != RequestedThreads::default()
        || resources.cpu.blas_threads != RequestedThreads::default()
    {
        errors.push("compute_cpu_policy_requires_enforcement: affinity and native thread policy require the worker allocation adapter".into());
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}
