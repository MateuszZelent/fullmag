//! FEM runtime contract and provenance helpers.

use fullmag_engine::fem::FemBackendId;
use fullmag_ir::FemPlanIR;

use crate::native_fem::{
    self, NativeFemDataResidency, NativeFemGpuRkPlanInfo, NativeFemGpuStateInfo,
};
use crate::relaxation::llg_overdamped_uses_pure_damping;
use crate::solver_runtime::selection::all_in_gpu_fem_required;
use crate::types::{ExecutionProvenance, FemPoissonDemagProvenance, RunError, StepStats};

pub(crate) fn native_fem_gpu_ready_log_message(
    gpu_state: &NativeFemGpuStateInfo,
    device_info: &native_fem::DeviceInfo,
    gpu_rk_plan: Option<&NativeFemGpuRkPlanInfo>,
) -> (&'static str, String) {
    if !gpu_state.allocated {
        return (
            "warning",
            format!(
                "native FEM GPU state is not allocated; data residency={}",
                gpu_state.source_of_truth.as_str()
            ),
        );
    }

    let device_gb = gpu_state.device_bytes as f64 / 1e9;
    let reduction_mb = gpu_state.reduction_workspace_bytes as f64 / 1e6;
    let vram_free_gb = device_info.memory_free_bytes as f64 / 1e9;
    let vram_total_gb = device_info.memory_total_bytes as f64 / 1e9;
    let device_stage_ready = gpu_rk_plan.is_some_and(|plan| {
        plan.exchange_only_enabled
            && plan.stage_exchange_device_resident
            && plan.uses_gpu_poisson
            && plan.demag_operator_mode == "device_hypre_poisson"
            && plan.hypre_execution_policy == "device"
            && plan.demag_residency == "device"
    });
    if gpu_state.source_of_truth != NativeFemDataResidency::DeviceSourceOfTruth
        && !device_stage_ready
    {
        return (
            "warning",
            format!(
                "native FEM GPU buffers allocated, but data residency is {}: nodes={} dof={} stages={} device_buffers={:.3} GB reduction_workspace={:.1} MB vram_free={:.3} GB vram_total={:.3} GB",
                gpu_state.source_of_truth.as_str(),
                gpu_state.node_count,
                gpu_state.dof_len,
                gpu_state.stage_count,
                device_gb,
                reduction_mb,
                vram_free_gb,
                vram_total_gb
            ),
        );
    }

    (
        "info",
        format!(
            "native FEM GPU ready: mesh, material fields, magnetization, and demag data are loaded on the CUDA device; nodes={} dof={} stages={} device_buffers={:.3} GB reduction_workspace={:.1} MB vram_free={:.3} GB vram_total={:.3} GB initial_residency={}",
            gpu_state.node_count,
            gpu_state.dof_len,
            gpu_state.stage_count,
            device_gb,
            reduction_mb,
            vram_free_gb,
            vram_total_gb,
            gpu_state.source_of_truth.as_str()
        ),
    )
}

pub(crate) fn native_fem_execution_engine(plan: &FemPlanIR) -> &'static str {
    if native_fem::native_fem_plan_requests_gpu_mfem_device(plan) {
        FemBackendId::GpuNative.provenance_name()
    } else {
        FemBackendId::CpuNative.provenance_name()
    }
}

pub(crate) fn native_fem_execution_mode(plan: &FemPlanIR) -> &'static str {
    if !native_fem::native_fem_plan_requests_gpu_mfem_device(plan) {
        "cpu_native"
    } else if std::env::var("FULLMAG_FEM_GPU_DEMAG_MODE")
        .ok()
        .is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "hybrid_cpu_poisson" | "hybrid" | "compat"
            )
        })
    {
        "hybrid_legacy_sparse"
    } else {
        "all_in_gpu_legacy_sparse"
    }
}

pub(crate) fn native_fem_llg_mode(plan: &FemPlanIR) -> &'static str {
    if llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()) {
        "pure_damping"
    } else {
        "precessional"
    }
}

pub(crate) fn validate_all_in_gpu_fem_runtime_contract(
    execution_mode: &str,
    gpu_rk_plan: &NativeFemGpuRkPlanInfo,
) -> Result<(), RunError> {
    if !all_in_gpu_fem_required() {
        return Ok(());
    }
    if execution_mode != "all_in_gpu_legacy_sparse"
        || !native_fem_gpu_rk_plan_is_strict_device_resident(gpu_rk_plan)
    {
        return Err(RunError {
            message: format!(
                "ALL_IN_GPU FEM was requested, but native FEM runtime is not all-in GPU \
                 (execution_mode={}, gpu_rk_exchange_only_enabled={}, \
                 stage_exchange_device_resident={}, fem_exchange_operator_mode={}, \
                 uses_gpu_poisson={}, fem_demag_operator_mode={}, hypre_execution_policy={}, \
                 demag_residency={}, \
                 gpu_rk_block_reason={}, fallback_reason=all_in_gpu_contract_unmet)",
                execution_mode,
                gpu_rk_plan.exchange_only_enabled,
                gpu_rk_plan.stage_exchange_device_resident,
                gpu_rk_plan.exchange_operator_mode,
                gpu_rk_plan.uses_gpu_poisson,
                gpu_rk_plan.demag_operator_mode,
                gpu_rk_plan.hypre_execution_policy,
                gpu_rk_plan.demag_residency,
                if gpu_rk_plan.reason.is_empty() {
                    "none"
                } else {
                    gpu_rk_plan.reason.as_str()
                }
            ),
        });
    }
    Ok(())
}

fn native_fem_gpu_rk_plan_is_strict_device_resident(gpu_rk_plan: &NativeFemGpuRkPlanInfo) -> bool {
    gpu_rk_plan.exchange_only_enabled
        && gpu_rk_plan.stage_exchange_device_resident
        && gpu_rk_plan.uses_gpu_poisson
        && gpu_rk_plan.demag_operator_mode == "device_hypre_poisson"
        && gpu_rk_plan.hypre_execution_policy == "device"
        && gpu_rk_plan.demag_residency == "device"
        && matches!(
            gpu_rk_plan.exchange_operator_mode.as_str(),
            "legacy_sparse_gpu" | "partial_assembly_gpu"
        )
}

fn native_fem_data_residency(
    _plan: &FemPlanIR,
    stats: Option<&StepStats>,
    gpu_state: Option<&NativeFemGpuStateInfo>,
) -> &'static str {
    if stats
        .map(|entry| entry.hot_loop_host_sync_count > 0)
        .unwrap_or(false)
    {
        return NativeFemDataResidency::HostSourceOfTruth.as_str();
    }
    gpu_state
        .map(|state| state.source_of_truth.as_str())
        .unwrap_or(NativeFemDataResidency::HostSourceOfTruth.as_str())
}

fn native_fem_uses_cuda_kernels(plan: &FemPlanIR) -> bool {
    native_fem::native_fem_plan_requests_gpu_mfem_device(plan)
}

fn native_fem_uses_gpu_poisson(plan: &FemPlanIR) -> bool {
    native_fem::native_fem_plan_requests_gpu_mfem_device(plan) && plan.enable_demag
}

fn native_fem_gpu_qualification_status(
    plan: &FemPlanIR,
    stats: Option<&StepStats>,
    gpu_rk_plan: Option<&NativeFemGpuRkPlanInfo>,
) -> &'static str {
    if !native_fem::native_fem_plan_requests_gpu_mfem_device(plan) {
        return "unsupported";
    }
    let Some(rk_plan) = gpu_rk_plan else {
        return if native_fem_uses_cuda_kernels(plan) {
            "source_visible"
        } else {
            "unsupported"
        };
    };
    let hot_loop_clean = stats
        .map(|entry| entry.hot_loop_host_sync_count == 0)
        .unwrap_or(true);
    if native_fem_execution_mode(plan) == "all_in_gpu_legacy_sparse"
        && native_fem_gpu_rk_plan_is_strict_device_resident(rk_plan)
        && hot_loop_clean
    {
        "production_executable"
    } else {
        "source_visible"
    }
}

pub(crate) fn apply_native_fem_runtime_contract(
    provenance: &mut ExecutionProvenance,
    plan: &FemPlanIR,
    stats: Option<&StepStats>,
    gpu_state: Option<&NativeFemGpuStateInfo>,
    gpu_rk_plan: Option<&NativeFemGpuRkPlanInfo>,
) {
    provenance.fem_execution_mode = Some(native_fem_execution_mode(plan).to_string());
    provenance.fem_gpu_qualification_status =
        Some(native_fem_gpu_qualification_status(plan, stats, gpu_rk_plan).to_string());
    provenance.llg_mode = Some(native_fem_llg_mode(plan).to_string());
    provenance.fem_data_residency =
        Some(native_fem_data_residency(plan, stats, gpu_state).to_string());
    provenance.uses_cuda_kernels = Some(
        gpu_rk_plan
            .map(|plan| plan.uses_cuda_kernels)
            .unwrap_or_else(|| native_fem_uses_cuda_kernels(plan)),
    );
    provenance.uses_gpu_poisson = Some(
        gpu_rk_plan
            .map(|plan| plan.uses_gpu_poisson)
            .unwrap_or_else(|| native_fem_uses_gpu_poisson(plan)),
    );
    provenance.hot_loop_host_sync_count = stats.map(|entry| entry.hot_loop_host_sync_count);
    if let Some(entry) = stats {
        provenance.hot_loop_exchange_h2d_bytes = Some(entry.hot_loop_exchange_h2d_bytes);
        provenance.hot_loop_exchange_d2h_bytes = Some(entry.hot_loop_exchange_d2h_bytes);
        provenance.hot_loop_exchange_host_sync_count =
            Some(entry.hot_loop_exchange_host_sync_count);
        provenance.hot_loop_compute_h2d_bytes = Some(entry.hot_loop_compute_h2d_bytes);
        provenance.hot_loop_compute_d2h_bytes = Some(entry.hot_loop_compute_d2h_bytes);
        provenance.hot_loop_compute_host_sync_count = Some(entry.hot_loop_compute_host_sync_count);
    }
    if let Some(state) = gpu_state {
        provenance.fem_gpu_state_allocated = Some(state.allocated);
        provenance.fem_gpu_state_node_count = Some(state.node_count);
        provenance.fem_gpu_state_dof_len = Some(state.dof_len);
        provenance.fem_gpu_state_stage_count = Some(state.stage_count);
        provenance.fem_gpu_state_device_bytes = Some(state.device_bytes);
        provenance.fem_gpu_state_reduction_workspace_bytes = Some(state.reduction_workspace_bytes);
    }
    if let Some(rk_plan) = gpu_rk_plan {
        provenance.fem_gpu_rk_exchange_only_enabled = Some(rk_plan.exchange_only_enabled);
        provenance.fem_gpu_rk_stage_count = Some(rk_plan.stage_count);
        provenance.fem_gpu_rk_uses_cuda_kernels = Some(rk_plan.uses_cuda_kernels);
        provenance.fem_gpu_rk_allows_exchange_host_sync = Some(rk_plan.allows_exchange_host_sync);
        provenance.fem_gpu_rk_stage_exchange_device_resident =
            Some(rk_plan.stage_exchange_device_resident);
        provenance.fem_exchange_operator_mode = Some(rk_plan.exchange_operator_mode.clone());
        provenance.fem_demag_operator_mode = Some(rk_plan.demag_operator_mode.clone());
        provenance.hypre_execution_policy = Some(rk_plan.hypre_execution_policy.clone());
        provenance.demag_residency = Some(rk_plan.demag_residency.clone());
        provenance.fem_gpu_rk_block_reason =
            (!rk_plan.reason.is_empty()).then(|| rk_plan.reason.clone());
    }
}

pub(crate) fn fem_poisson_demag_provenance(
    plan: &FemPlanIR,
    stats: Option<&StepStats>,
) -> Option<FemPoissonDemagProvenance> {
    if !plan.enable_demag {
        return None;
    }

    let resolved_demag = plan
        .demag_realization
        .unwrap_or(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
    let boundary_condition = match resolved_demag {
        fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet => "dirichlet",
        fullmag_ir::ResolvedFemDemagIR::PoissonRobin => "robin",
        fullmag_ir::ResolvedFemDemagIR::FredkinKoehler => "fredkin_koehler_fem_bem",
        _ => return None,
    };
    let policy = plan.demag_solver_policy.clone().unwrap_or_default();

    Some(FemPoissonDemagProvenance {
        linear_solver: policy.solver,
        preconditioner: policy.preconditioner,
        rtol: policy.rtol,
        max_iterations: policy.max_iterations,
        actual_iterations: stats.map(|entry| entry.poisson_iterations),
        final_residual: stats.and_then(|entry| {
            entry
                .poisson_final_residual
                .is_finite()
                .then_some(entry.poisson_final_residual)
        }),
        boundary_condition: boundary_condition.to_string(),
        robin_beta: plan
            .air_box_config
            .as_ref()
            .and_then(|config| config.robin_beta_factor),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        AirBoxConfigIR, ExchangeBoundaryCondition, ExecutionPrecision, FemDomainMeshModeIR,
        FemLinearSolverPolicy, FemPlanIR, IntegratorChoice, MaterialIR, MeshIR, RelaxStopIR,
        RelaxationAlgorithmIR, RelaxationControlIR, ResolvedFemDemagIR,
    };
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn tiny_fem_plan() -> FemPlanIR {
        FemPlanIR {
            mesh_name: "unit_tet".to_string(),
            mesh_source: None,
            mesh: MeshIR {
                mesh_name: "unit_tet".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: HashMap::new(),
            },
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            mesh_build_report: None,
            domain_mesh_mode: FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 0.4,
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            material: MaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.02,
                uniaxial_anisotropy: None,
                anisotropy_axis: None,
                uniaxial_anisotropy_k2: None,
                cubic_anisotropy_kc1: None,
                cubic_anisotropy_kc2: None,
                cubic_anisotropy_kc3: None,
                cubic_anisotropy_axis1: None,
                cubic_anisotropy_axis2: None,
                ms_field: None,
                a_field: None,
                alpha_field: None,
                ku_field: None,
                ku2_field: None,
                kc1_field: None,
                kc2_field: None,
                kc3_field: None,
                interfacial_dmi: None,
                bulk_dmi: None,
                dind_field: None,
                dbulk_field: None,
            },
            region_materials: Vec::new(),
            enable_exchange: true,
            enable_demag: false,
            external_field: None,
            current_modules: Vec::new(),
            spin_transport_plans: Vec::new(),
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            field_refresh: None,
            relaxation: None,
            demag_realization: None,
            air_box_config: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            dind_field: None,
            dbulk_field: None,
            temperature: None,
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            oersted_axis: None,
            oersted_field_xyz: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            magnetoelastic: None,
            mechanics: None,
            demag_solver_policy: None,
            thermal_seed_config: None,
            oersted_realization: None,
            gpu_device_index: None,
            mfem_device_string: None,
            dmi_interface_normal: None,
            use_consistent_mass: None,
        }
    }

    fn gpu_device_info_for_log_test() -> native_fem::DeviceInfo {
        native_fem::DeviceInfo {
            name: "NVIDIA test GPU".to_string(),
            compute_capability: "8.9".to_string(),
            driver_version: 13010,
            runtime_version: 12060,
            memory_free_bytes: 8_000_000_000,
            memory_total_bytes: 12_000_000_000,
        }
    }

    fn gpu_rk_ready_plan_for_log_test() -> NativeFemGpuRkPlanInfo {
        NativeFemGpuRkPlanInfo {
            exchange_only_enabled: true,
            stage_count: 2,
            uses_cuda_kernels: true,
            allows_exchange_host_sync: false,
            stage_exchange_device_resident: true,
            uses_gpu_poisson: true,
            exchange_operator_mode: "legacy_sparse_gpu".to_string(),
            demag_operator_mode: "device_hypre_poisson".to_string(),
            hypre_execution_policy: "device".to_string(),
            demag_residency: "device".to_string(),
            reason: String::new(),
        }
    }

    #[test]
    fn poisson_demag_provenance_records_policy_and_solve_stats() {
        let mut plan = tiny_fem_plan();
        plan.enable_demag = true;
        plan.demag_realization = Some(ResolvedFemDemagIR::PoissonRobin);
        plan.demag_solver_policy = Some(FemLinearSolverPolicy {
            solver: "GMRES".to_string(),
            preconditioner: "Jacobi".to_string(),
            rtol: 1e-6,
            max_iterations: 77,
            ..Default::default()
        });
        plan.air_box_config = Some(AirBoxConfigIR {
            factor: 4.0,
            grading: 1.4,
            boundary_marker: 99,
            bc_kind: Some("robin".to_string()),
            robin_beta_mode: Some("user".to_string()),
            robin_beta_factor: Some(2.5),
            shape: Some("bbox".to_string()),
            factor_source: Some("user".to_string()),
            boundary_marker_source: Some("mesh_marker_99".to_string()),
        });
        let stats = StepStats {
            poisson_iterations: 13,
            poisson_final_residual: 4.0e-9,
            ..StepStats::default()
        };

        let provenance = fem_poisson_demag_provenance(&plan, Some(&stats))
            .expect("poisson demag provenance should be present");

        assert_eq!(provenance.linear_solver, "GMRES");
        assert_eq!(provenance.preconditioner, "Jacobi");
        assert_eq!(provenance.rtol, 1e-6);
        assert_eq!(provenance.max_iterations, 77);
        assert_eq!(provenance.actual_iterations, Some(13));
        assert_eq!(provenance.final_residual, Some(4.0e-9));
        assert_eq!(provenance.boundary_condition, "robin");
        assert_eq!(provenance.robin_beta, Some(2.5));
    }

    #[test]
    fn fredkin_koehler_demag_provenance_records_method_and_solve_stats() {
        let mut plan = tiny_fem_plan();
        plan.enable_demag = true;
        plan.demag_realization = Some(ResolvedFemDemagIR::FredkinKoehler);
        let stats = StepStats {
            poisson_iterations: 21,
            poisson_final_residual: 7.0e-8,
            ..StepStats::default()
        };

        let provenance = fem_poisson_demag_provenance(&plan, Some(&stats))
            .expect("Fredkin-Koehler demag provenance should be present");

        assert_eq!(provenance.boundary_condition, "fredkin_koehler_fem_bem");
        assert_eq!(provenance.actual_iterations, Some(21));
        assert_eq!(provenance.final_residual, Some(7.0e-8));
        assert_eq!(provenance.robin_beta, None);
    }

    #[test]
    fn runtime_contract_uses_gpu_state_and_llg_mode() {
        let mut plan = tiny_fem_plan();
        plan.mfem_device_string = Some("cuda".to_string());
        plan.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: None,
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        });
        let stats = StepStats {
            hot_loop_host_sync_count: 0,
            ..StepStats::default()
        };
        let gpu_state = NativeFemGpuStateInfo {
            allocated: true,
            node_count: 8,
            dof_len: 24,
            stage_count: 4,
            device_bytes: 32768,
            reduction_workspace_bytes: 512,
            source_of_truth: NativeFemDataResidency::DeviceSourceOfTruth,
        };
        let rk_plan = gpu_rk_ready_plan_for_log_test();
        let mut provenance = ExecutionProvenance::default();

        apply_native_fem_runtime_contract(
            &mut provenance,
            &plan,
            Some(&stats),
            Some(&gpu_state),
            Some(&rk_plan),
        );

        assert_eq!(
            provenance.fem_data_residency.as_deref(),
            Some("device_source_of_truth")
        );
        assert_eq!(provenance.llg_mode.as_deref(), Some("pure_damping"));
        assert_eq!(provenance.fem_gpu_state_allocated, Some(true));
        assert_eq!(provenance.fem_gpu_state_node_count, Some(8));
        assert_eq!(provenance.fem_gpu_rk_stage_count, Some(2));
        assert_eq!(
            provenance.fem_gpu_qualification_status.as_deref(),
            Some("production_executable")
        );
        assert_ne!(
            provenance.fem_gpu_qualification_status.as_deref(),
            Some("validated")
        );
    }

    #[test]
    fn runtime_contract_does_not_publish_device_residency_with_hot_loop_sync() {
        let mut plan = tiny_fem_plan();
        plan.mfem_device_string = Some("cuda".to_string());
        let stats = StepStats {
            hot_loop_host_sync_count: 3,
            ..StepStats::default()
        };
        let gpu_state = NativeFemGpuStateInfo {
            allocated: true,
            node_count: 8,
            dof_len: 24,
            stage_count: 4,
            device_bytes: 32768,
            reduction_workspace_bytes: 512,
            source_of_truth: NativeFemDataResidency::DeviceSourceOfTruth,
        };
        let mut provenance = ExecutionProvenance::default();

        apply_native_fem_runtime_contract(
            &mut provenance,
            &plan,
            Some(&stats),
            Some(&gpu_state),
            None,
        );

        assert_eq!(
            provenance.fem_data_residency.as_deref(),
            Some("host_source_of_truth")
        );
        assert_eq!(provenance.hot_loop_host_sync_count, Some(3));
        assert_eq!(
            provenance.fem_gpu_qualification_status.as_deref(),
            Some("source_visible")
        );
    }

    #[test]
    fn runtime_contract_treats_cpu_mfem_variants_as_unsupported() {
        let mut plan = tiny_fem_plan();
        plan.enable_demag = true;
        plan.mfem_device_string = Some("ceed-cpu".to_string());
        let mut provenance = ExecutionProvenance::default();

        apply_native_fem_runtime_contract(&mut provenance, &plan, None, None, None);

        assert_eq!(provenance.fem_execution_mode.as_deref(), Some("cpu_native"));
        assert_eq!(
            provenance.fem_gpu_qualification_status.as_deref(),
            Some("unsupported")
        );
        assert_eq!(provenance.uses_cuda_kernels, Some(false));
        assert_eq!(provenance.uses_gpu_poisson, Some(false));
    }

    #[test]
    fn gpu_ready_log_distinguishes_device_residency_and_warnings() {
        let device_info = gpu_device_info_for_log_test();
        let rk_plan = gpu_rk_ready_plan_for_log_test();
        let device_state = NativeFemGpuStateInfo {
            allocated: true,
            node_count: 16_502,
            dof_len: 49_506,
            stage_count: 7,
            device_bytes: 275_000_000,
            reduction_workspace_bytes: 2_000_000,
            source_of_truth: NativeFemDataResidency::DeviceSourceOfTruth,
        };
        let (level, message) =
            native_fem_gpu_ready_log_message(&device_state, &device_info, Some(&rk_plan));

        assert_eq!(level, "info");
        assert!(message.contains("demag data are loaded on the CUDA device"));
        assert!(message.contains("initial_residency=device_source_of_truth"));
        assert!(message.contains("vram_free=8.000 GB vram_total=12.000 GB"));

        let mixed_state = NativeFemGpuStateInfo {
            source_of_truth: NativeFemDataResidency::Mixed,
            ..device_state
        };
        let (level, message) = native_fem_gpu_ready_log_message(&mixed_state, &device_info, None);
        assert_eq!(level, "warning");
        assert!(message.contains("data residency is mixed"));
    }

    #[test]
    fn all_in_gpu_request_rejects_non_strict_runtime_contracts() {
        let _guard = env_lock().lock().expect("env mutex");
        unsafe {
            std::env::set_var("FULLMAG_FEM_ALL_IN_GPU", "1");
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
        }

        let hybrid = NativeFemGpuRkPlanInfo {
            exchange_only_enabled: false,
            stage_count: 2,
            uses_cuda_kernels: true,
            allows_exchange_host_sync: true,
            stage_exchange_device_resident: false,
            uses_gpu_poisson: false,
            exchange_operator_mode: "unsupported".to_string(),
            demag_operator_mode: "hybrid_cpu_poisson".to_string(),
            hypre_execution_policy: "host".to_string(),
            demag_residency: "host_device_roundtrip".to_string(),
            reason: "stage H_ex is not device-resident".to_string(),
        };
        let err = validate_all_in_gpu_fem_runtime_contract("hybrid_legacy_sparse", &hybrid)
            .expect_err("ALL_IN_GPU must reject hybrid native FEM runtime");
        assert!(err.message.contains("all_in_gpu_contract_unmet"));
        assert!(err.message.contains("stage_exchange_device_resident=false"));
        assert!(err
            .message
            .contains("gpu_rk_block_reason=stage H_ex is not device-resident"));

        let unsupported_exchange = NativeFemGpuRkPlanInfo {
            exchange_only_enabled: true,
            uses_gpu_poisson: true,
            stage_exchange_device_resident: true,
            exchange_operator_mode: "unsupported".to_string(),
            demag_operator_mode: "device_hypre_poisson".to_string(),
            hypre_execution_policy: "device".to_string(),
            demag_residency: "device".to_string(),
            reason: String::new(),
            ..hybrid.clone()
        };
        let err = validate_all_in_gpu_fem_runtime_contract(
            "all_in_gpu_legacy_sparse",
            &unsupported_exchange,
        )
        .expect_err("ALL_IN_GPU must reject unsupported exchange operator mode");
        assert!(err
            .message
            .contains("fem_exchange_operator_mode=unsupported"));
        assert!(err.message.contains("gpu_rk_block_reason=none"));

        let missing_poisson = NativeFemGpuRkPlanInfo {
            exchange_operator_mode: "legacy_sparse_gpu".to_string(),
            demag_operator_mode: "hybrid_cpu_poisson".to_string(),
            hypre_execution_policy: "host".to_string(),
            demag_residency: "host_device_roundtrip".to_string(),
            uses_gpu_poisson: false,
            ..unsupported_exchange
        };
        let err =
            validate_all_in_gpu_fem_runtime_contract("all_in_gpu_legacy_sparse", &missing_poisson)
                .expect_err("ALL_IN_GPU must reject non-device Poisson demag");
        assert!(err.message.contains("uses_gpu_poisson=false"));
        assert!(err
            .message
            .contains("fem_demag_operator_mode=hybrid_cpu_poisson"));
        assert!(err.message.contains("hypre_execution_policy=host"));

        unsafe {
            std::env::remove_var("FULLMAG_FEM_ALL_IN_GPU");
        }
    }
}
