use super::*;

pub(crate) fn cpu_execution_provenance(plan: &FdmPlanIR) -> Result<ExecutionProvenance, RunError> {
    let fft_backend = cpu_reference::resolve_cpu_fft_backend_name_for_demag(plan.enable_demag)?;
    let timestep_policy = if crate::relaxation::direct_minimizer::direct_minimizer_control(
        plan.relaxation.as_ref(),
    )
    .is_some()
    {
        None
    } else {
        Some(crate::resolve_timestep_policy(
            plan.integrator,
            plan.fixed_timestep,
            plan.adaptive_timestep.as_ref(),
            crate::types::TimestepExecutionLane::fdm_cpu(),
        )?)
    };

    Ok(ExecutionProvenance {
        execution_engine: "cpu_reference".to_string(),
        precision: "double".to_string(),
        demag_operator_kind: if plan.enable_demag {
            Some("tensor_fft_newell".to_string())
        } else {
            None
        },
        fft_backend,
        device_name: None,
        compute_capability: None,
        cuda_driver_version: None,
        cuda_runtime_version: None,
        lossy_fallback_used: false,
        resolved_fallback: None,
        ignored_terms: Vec::new(),
        random_seed: None,
        requested_integrator: None,
        resolved_integrator: None,
        requested_energy_minimizer: None,
        resolved_energy_minimizer: None,
        energy_minimizer_realization: None,
        requested_demag_realization: None,
        resolved_demag_realization: None,
        timestep_policy,
        dt_policy: None,
        llg_mode: None,
        mfem_device: None,
        demag_refresh_interval_s: None,
        fem_assembly_mode: None,
        fem_execution_mode: None,
        fem_gpu_qualification_status: None,
        fem_exchange_operator_mode: None,
        fem_data_residency: None,
        uses_cuda_kernels: None,
        uses_gpu_poisson: None,
        fem_demag_operator_mode: None,
        hypre_execution_policy: None,
        demag_residency: None,
        hot_loop_host_sync_count: None,
        hot_loop_exchange_h2d_bytes: None,
        hot_loop_exchange_d2h_bytes: None,
        hot_loop_exchange_host_sync_count: None,
        hot_loop_compute_h2d_bytes: None,
        hot_loop_compute_d2h_bytes: None,
        hot_loop_compute_host_sync_count: None,
        fem_gpu_state_allocated: None,
        fem_gpu_state_node_count: None,
        fem_gpu_state_dof_len: None,
        fem_gpu_state_stage_count: None,
        fem_gpu_state_device_bytes: None,
        fem_gpu_state_reduction_workspace_bytes: None,
        fem_gpu_rk_exchange_only_enabled: None,
        fem_gpu_rk_stage_count: None,
        fem_gpu_rk_uses_cuda_kernels: None,
        fem_gpu_rk_allows_exchange_host_sync: None,
        fem_gpu_rk_stage_exchange_device_resident: None,
        fem_gpu_rk_block_reason: None,
        requested_cpu_threads: None,
        resolved_cpu_threads: None,
        requested_fem_omp_threads: None,
        effective_fem_omp_threads: None,
        fem_poisson_demag: None,
    })
}

#[cfg(feature = "cuda")]
pub(crate) fn cuda_execution_provenance(
    plan: &FdmPlanIR,
    device_info: &crate::fdm::gpu::cuda::native::DeviceInfo,
) -> Result<ExecutionProvenance, RunError> {
    let timestep_policy = if crate::fem::relax::algorithm::native_step_control(
        plan.relaxation.as_ref(),
    )
    .is_some()
    {
        None
    } else {
        Some(crate::resolve_timestep_policy(
            plan.integrator,
            plan.fixed_timestep,
            plan.adaptive_timestep.as_ref(),
            crate::types::TimestepExecutionLane::fdm_cuda(plan.precision),
        )?)
    };
    Ok(ExecutionProvenance {
        execution_engine: "cuda_fdm".to_string(),
        precision: match plan.precision {
            fullmag_ir::ExecutionPrecision::Single => "single".to_string(),
            fullmag_ir::ExecutionPrecision::Double => "double".to_string(),
        },
        demag_operator_kind: if plan.enable_demag {
            Some("tensor_fft_newell".to_string())
        } else {
            None
        },
        fft_backend: if plan.enable_demag {
            Some("cuFFT".to_string())
        } else {
            None
        },
        device_name: Some(device_info.name.clone()),
        compute_capability: Some(device_info.compute_capability.clone()),
        cuda_driver_version: Some(device_info.driver_version),
        cuda_runtime_version: Some(device_info.runtime_version),
        lossy_fallback_used: false,
        resolved_fallback: None,
        ignored_terms: Vec::new(),
        random_seed: None,
        requested_integrator: plan.integrator.map(|integrator| format!("{integrator:?}")),
        resolved_integrator: plan.integrator.map(|integrator| format!("{integrator:?}")),
        requested_energy_minimizer: None,
        resolved_energy_minimizer: None,
        energy_minimizer_realization: None,
        requested_demag_realization: None,
        resolved_demag_realization: None,
        timestep_policy,
        dt_policy: None,
        llg_mode: Some(
            if llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()) {
                "pure_damping"
            } else {
                "precessional"
            }
            .to_string(),
        ),
        mfem_device: None,
        demag_refresh_interval_s: None,
        fem_assembly_mode: None,
        fem_execution_mode: None,
        fem_gpu_qualification_status: None,
        fem_exchange_operator_mode: None,
        fem_data_residency: None,
        uses_cuda_kernels: None,
        uses_gpu_poisson: None,
        fem_demag_operator_mode: None,
        hypre_execution_policy: None,
        demag_residency: None,
        hot_loop_host_sync_count: None,
        hot_loop_exchange_h2d_bytes: None,
        hot_loop_exchange_d2h_bytes: None,
        hot_loop_exchange_host_sync_count: None,
        hot_loop_compute_h2d_bytes: None,
        hot_loop_compute_d2h_bytes: None,
        hot_loop_compute_host_sync_count: None,
        fem_gpu_state_allocated: None,
        fem_gpu_state_node_count: None,
        fem_gpu_state_dof_len: None,
        fem_gpu_state_stage_count: None,
        fem_gpu_state_device_bytes: None,
        fem_gpu_state_reduction_workspace_bytes: None,
        fem_gpu_rk_exchange_only_enabled: None,
        fem_gpu_rk_stage_count: None,
        fem_gpu_rk_uses_cuda_kernels: None,
        fem_gpu_rk_allows_exchange_host_sync: None,
        fem_gpu_rk_stage_exchange_device_resident: None,
        fem_gpu_rk_block_reason: None,
        requested_cpu_threads: None,
        resolved_cpu_threads: None,
        requested_fem_omp_threads: None,
        effective_fem_omp_threads: None,
        fem_poisson_demag: None,
    })
}

#[cfg(feature = "fem-gpu")]
pub(crate) fn fem_gpu_execution_provenance(
    plan: &FemPlanIR,
    device_info: &FemDeviceInfo,
) -> Result<ExecutionProvenance, RunError> {
    let timestep_policy = if crate::fem::relax::algorithm::native_step_control(
        plan.relaxation.as_ref(),
    )
    .is_some()
    {
        None
    } else {
        Some(crate::resolve_timestep_policy(
            plan.integrator,
            plan.fixed_timestep,
            plan.adaptive_timestep.as_ref(),
            if plan.mfem_device_string.as_deref() == Some("cpu") {
                crate::types::TimestepExecutionLane::fem_cpu(plan.precision)
            } else {
                crate::types::TimestepExecutionLane::fem_gpu(plan.precision)
            },
        )?)
    };
    let execution_engine = native_fem_backend_id(plan).provenance_name();
    let resolved_demag_realization = resolved_native_fem_demag(plan);
    let mut provenance = ExecutionProvenance {
        execution_engine: execution_engine.to_string(),
        precision: match plan.precision {
            fullmag_ir::ExecutionPrecision::Single => "single".to_string(),
            fullmag_ir::ExecutionPrecision::Double => "double".to_string(),
        },
        demag_operator_kind: resolved_demag_realization
            .map(|realization| realization.provenance_name().to_string()),
        fft_backend: None,
        device_name: Some(device_info.name.clone()),
        compute_capability: Some(device_info.compute_capability.clone()),
        cuda_driver_version: Some(device_info.driver_version),
        cuda_runtime_version: Some(device_info.runtime_version),
        lossy_fallback_used: false,
        resolved_fallback: None,
        ignored_terms: Vec::new(),
        random_seed: None,
        requested_integrator: plan.integrator.map(|integrator| format!("{integrator:?}")),
        resolved_integrator: plan.integrator.map(|integrator| format!("{integrator:?}")),
        requested_energy_minimizer: None,
        resolved_energy_minimizer: None,
        energy_minimizer_realization: None,
        requested_demag_realization: plan
            .demag_realization
            .map(|r| r.provenance_name().to_string()),
        resolved_demag_realization: resolved_demag_realization
            .map(|realization| realization.provenance_name().to_string()),
        timestep_policy,
        dt_policy: None,
        llg_mode: Some(
            if llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()) {
                "pure_damping"
            } else {
                "precessional"
            }
            .to_string(),
        ),
        mfem_device: plan.mfem_device_string.clone(),
        demag_refresh_interval_s: plan
            .field_refresh
            .as_ref()
            .and_then(|policy| policy.demag_interval_s),
        fem_assembly_mode: Some("legacy_sparse".to_string()),
        fem_execution_mode: Some(
            if plan.mfem_device_string.as_deref() == Some("cpu") {
                "cpu_native"
            } else {
                "all_in_gpu_legacy_sparse"
            }
            .to_string(),
        ),
        fem_gpu_qualification_status: Some(
            if plan.mfem_device_string.as_deref() == Some("cpu") {
                "unsupported"
            } else {
                "source_visible"
            }
            .to_string(),
        ),
        fem_exchange_operator_mode: Some("unsupported".to_string()),
        fem_demag_operator_mode: Some(
            if plan.mfem_device_string.as_deref() == Some("cpu") {
                "none"
            } else {
                "device_hypre_poisson"
            }
            .to_string(),
        ),
        hypre_execution_policy: Some(
            if plan.mfem_device_string.as_deref() == Some("cpu") {
                "host"
            } else {
                "device"
            }
            .to_string(),
        ),
        demag_residency: Some(
            if plan.mfem_device_string.as_deref() == Some("cpu") {
                "host"
            } else {
                "device"
            }
            .to_string(),
        ),
        fem_data_residency: Some(
            if plan.mfem_device_string.as_deref() == Some("cpu") {
                "host_source_of_truth"
            } else {
                "device_source_of_truth"
            }
            .to_string(),
        ),
        uses_cuda_kernels: Some(plan.mfem_device_string.as_deref() != Some("cpu")),
        uses_gpu_poisson: Some(
            plan.mfem_device_string.as_deref() != Some("cpu") && plan.enable_demag,
        ),
        hot_loop_host_sync_count: None,
        hot_loop_exchange_h2d_bytes: None,
        hot_loop_exchange_d2h_bytes: None,
        hot_loop_exchange_host_sync_count: None,
        hot_loop_compute_h2d_bytes: None,
        hot_loop_compute_d2h_bytes: None,
        hot_loop_compute_host_sync_count: None,
        fem_gpu_state_allocated: None,
        fem_gpu_state_node_count: None,
        fem_gpu_state_dof_len: None,
        fem_gpu_state_stage_count: None,
        fem_gpu_state_device_bytes: None,
        fem_gpu_state_reduction_workspace_bytes: None,
        fem_gpu_rk_exchange_only_enabled: None,
        fem_gpu_rk_stage_count: None,
        fem_gpu_rk_uses_cuda_kernels: None,
        fem_gpu_rk_allows_exchange_host_sync: None,
        fem_gpu_rk_stage_exchange_device_resident: None,
        fem_gpu_rk_block_reason: None,
        requested_cpu_threads: None,
        resolved_cpu_threads: None,
        requested_fem_omp_threads: None,
        effective_fem_omp_threads: None,
        fem_poisson_demag: None,
    };
    crate::relaxation::apply_energy_minimizer_provenance(&mut provenance, plan.relaxation.as_ref());
    Ok(provenance)
}

#[cfg(feature = "fem-gpu")]
pub(crate) fn native_fem_backend_id(plan: &FemPlanIR) -> FemBackendId {
    if plan.mfem_device_string.as_deref() == Some("cpu") {
        FemBackendId::CpuNative
    } else {
        FemBackendId::GpuNative
    }
}

#[cfg(feature = "fem-gpu")]
pub(crate) fn resolved_native_fem_demag(
    plan: &FemPlanIR,
) -> Option<fullmag_ir::ResolvedFemDemagIR> {
    if plan.enable_demag {
        Some(
            plan.demag_realization
                .unwrap_or(fullmag_ir::ResolvedFemDemagIR::PoissonRobin),
        )
    } else {
        None
    }
}
