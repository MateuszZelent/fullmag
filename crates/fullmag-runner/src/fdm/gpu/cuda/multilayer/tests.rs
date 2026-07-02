use super::*;
use crate::fdm::cpu::multilayer_reference;
use fullmag_ir::{RelaxationAlgorithmIR, RelaxationControlIR};

fn make_plan(enable_demag: bool, precision: ExecutionPrecision) -> FdmMultilayerPlanIR {
    FdmMultilayerPlanIR {
        mode: "two_d_stack".to_string(),
        common_cells: [4, 4, 1],
        layers: vec![
            FdmLayerPlanIR {
                magnet_name: "free".to_string(),
                native_grid: [4, 4, 1],
                native_cell_size: [2e-9, 2e-9, 1e-9],
                native_origin: [-4e-9, -4e-9, 0.0],
                native_active_mask: None,
                initial_magnetization: vec![[1.0, 0.0, 0.0]; 16],
                material: FdmMaterialIR {
                    name: "Py".to_string(),
                    saturation_magnetisation: 800e3,
                    exchange_stiffness: 13e-12,
                    damping: 0.1,
                    ..Default::default()
                },
                convolution_grid: [4, 4, 1],
                convolution_cell_size: [2e-9, 2e-9, 1e-9],
                convolution_origin: [-4e-9, -4e-9, 0.0],
                transfer_kind: "identity".to_string(),
            },
            FdmLayerPlanIR {
                magnet_name: "ref".to_string(),
                native_grid: [4, 4, 1],
                native_cell_size: [2e-9, 2e-9, 1e-9],
                native_origin: [-4e-9, -4e-9, 3e-9],
                native_active_mask: None,
                initial_magnetization: vec![[0.0, 1.0, 0.0]; 16],
                material: FdmMaterialIR {
                    name: "Py".to_string(),
                    saturation_magnetisation: 800e3,
                    exchange_stiffness: 13e-12,
                    damping: 0.1,
                    ..Default::default()
                },
                convolution_grid: [4, 4, 1],
                convolution_cell_size: [2e-9, 2e-9, 1e-9],
                convolution_origin: [-4e-9, -4e-9, 3e-9],
                transfer_kind: "identity".to_string(),
            },
        ],
        enable_exchange: true,
        enable_demag,
        external_field: None,
        interfacial_dmi: None,
        bulk_dmi: None,
        gyromagnetic_ratio: 2.211e5,
        precision,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        periodicity: None,
        integrator: IntegratorChoice::Heun,
        fixed_timestep: Some(1e-13),
        field_refresh: None,
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-4),
                energy_tolerance_j: None,
                max_steps: Some(10),
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        }),
        planner_summary: fullmag_ir::FdmMultilayerSummaryIR {
            requested_strategy: "multilayer_convolution".to_string(),
            selected_strategy: "multilayer_convolution".to_string(),
            eligibility: "eligible".to_string(),
            estimated_pair_kernels: 4,
            estimated_unique_kernels: 3,
            estimated_kernel_bytes: 0,
            warnings: Vec::new(),
        },
    }
}

fn make_assisted_plan(enable_demag: bool, precision: ExecutionPrecision) -> FdmMultilayerPlanIR {
    let mut plan = make_plan(enable_demag, precision);
    plan.layers[1].material.name = "Py_variant".to_string();
    plan
}

fn make_touching_plan(precision: ExecutionPrecision) -> FdmMultilayerPlanIR {
    FdmMultilayerPlanIR {
        mode: "three_d".to_string(),
        common_cells: [2, 1, 1],
        field_refresh: None,
        layers: vec![
            FdmLayerPlanIR {
                magnet_name: "bottom".to_string(),
                native_grid: [2, 1, 1],
                native_cell_size: [2e-9, 2e-9, 2e-9],
                native_origin: [0.0, 0.0, 0.0],
                native_active_mask: None,
                initial_magnetization: vec![[1.0, 0.0, 0.0]; 2],
                material: FdmMaterialIR {
                    name: "Py".to_string(),
                    saturation_magnetisation: 800e3,
                    exchange_stiffness: 13e-12,
                    damping: 0.1,
                    ..Default::default()
                },
                convolution_grid: [2, 1, 1],
                convolution_cell_size: [2e-9, 2e-9, 2e-9],
                convolution_origin: [0.0, 0.0, 0.0],
                transfer_kind: "identity".to_string(),
            },
            FdmLayerPlanIR {
                magnet_name: "top".to_string(),
                native_grid: [2, 1, 1],
                native_cell_size: [2e-9, 2e-9, 2e-9],
                native_origin: [0.0, 0.0, 2e-9],
                native_active_mask: None,
                initial_magnetization: vec![[0.0, 1.0, 0.0]; 2],
                material: FdmMaterialIR {
                    name: "Py".to_string(),
                    saturation_magnetisation: 800e3,
                    exchange_stiffness: 13e-12,
                    damping: 0.1,
                    ..Default::default()
                },
                convolution_grid: [2, 1, 1],
                convolution_cell_size: [2e-9, 2e-9, 2e-9],
                convolution_origin: [0.0, 0.0, 2e-9],
                transfer_kind: "identity".to_string(),
            },
        ],
        enable_exchange: true,
        enable_demag: true,
        external_field: None,
        interfacial_dmi: None,
        bulk_dmi: None,
        gyromagnetic_ratio: 2.211e5,
        precision,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        periodicity: None,
        integrator: IntegratorChoice::Heun,
        fixed_timestep: Some(1e-13),
        relaxation: None,
        planner_summary: fullmag_ir::FdmMultilayerSummaryIR {
            requested_strategy: "multilayer_convolution".to_string(),
            selected_strategy: "multilayer_convolution".to_string(),
            eligibility: "eligible".to_string(),
            estimated_pair_kernels: 4,
            estimated_unique_kernels: 1,
            estimated_kernel_bytes: 0,
            warnings: Vec::new(),
        },
    }
}

fn max_vector_component_diff(actual: &[[f64; 3]], expected: &[[f64; 3]]) -> f64 {
    actual
        .iter()
        .zip(expected.iter())
        .flat_map(|(a, e)| (0..3).map(move |component| (a[component] - e[component]).abs()))
        .fold(0.0, f64::max)
}

fn add_global_dmi_texture(plan: &mut FdmMultilayerPlanIR) {
    plan.enable_exchange = false;
    plan.interfacial_dmi = Some(1.5e-3);
    plan.bulk_dmi = Some(2.5e-3);
    let layer_nx = plan.layers[0].native_grid[0] as usize;
    for (index, value) in plan.layers[0].initial_magnetization.iter_mut().enumerate() {
        let x = (index % layer_nx) as f64;
        let angle = 0.35 * x;
        *value = [angle.cos(), 0.0, angle.sin()];
    }
}

fn add_uniaxial_anisotropy_texture(plan: &mut FdmMultilayerPlanIR) {
    let tilted = [
        std::f64::consts::FRAC_1_SQRT_2,
        0.0,
        std::f64::consts::FRAC_1_SQRT_2,
    ];
    for layer in &mut plan.layers {
        layer.initial_magnetization.fill(tilted);
        layer.material.uniaxial_anisotropy_ku1 = Some(4.0e5);
        layer.material.anisotropy_axis = Some([0.0, 0.0, 1.0]);
    }
}

#[test]
fn cuda_assisted_layer_contexts_preserve_global_dmi_terms() {
    let mut plan = make_assisted_plan(false, ExecutionPrecision::Double);
    add_global_dmi_texture(&mut plan);

    let (contexts, states) =
        build_contexts_and_states(&plan, false).expect("CUDA-assisted contexts should build");
    let dmi = contexts[0]
        .problem
        .dmi_field(&states[0])
        .expect("DMI field should compute");

    assert!(
        max_norm(&dmi) > 0.0,
        "CUDA-assisted multilayer layer contexts must preserve global DMI"
    );
}

#[test]
fn native_stacked_cuda_plan_preserves_global_dmi_constants() {
    let mut plan = make_plan(false, ExecutionPrecision::Double);
    add_global_dmi_texture(&mut plan);

    let native = build_native_stacked_cuda_plan(&plan)
        .expect("native stacked plan should build")
        .expect("plan should be eligible for native stacked fast path");

    assert_eq!(native.combined_plan.interfacial_dmi, plan.interfacial_dmi);
    assert_eq!(native.combined_plan.bulk_dmi, plan.bulk_dmi);
}

#[test]
fn staged_v2_cuda_allows_fixed_step_rk23_but_rejects_rk45() {
    let mut plan = make_plan(false, ExecutionPrecision::Double);
    plan.integrator = IntegratorChoice::Rk45;

    let native = resolve_cuda_multilayer_execution_shape(&plan)
        .expect("native stacked RK45 should be a valid CUDA multilayer execution shape")
        .expect("plan should use native single-grid fast path");
    assert_eq!(native.combined_plan.integrator, IntegratorChoice::Rk45);

    let mut assisted = make_assisted_plan(false, ExecutionPrecision::Double);
    assisted.integrator = IntegratorChoice::Rk23;
    assert!(
        resolve_cuda_multilayer_execution_shape(&assisted)
            .expect("heterogeneous staged v2 fixed-step RK23 should be accepted")
            .is_none(),
        "heterogeneous staged v2 should not resolve through the native stacked fast path"
    );

    assisted.integrator = IntegratorChoice::Rk45;
    let err = match resolve_cuda_multilayer_execution_shape(&assisted) {
        Err(err) => err,
        Ok(_) => panic!("heterogeneous staged v2 RK45 should remain unsupported"),
    };
    assert!(
        err.message.contains("staged v2")
            && err.message.contains("'heun', 'rk4', and fixed-step 'rk23'"),
        "unexpected error: {}",
        err.message
    );
}

#[test]
fn native_stacked_observables_include_layer_dmi_outputs() {
    let mut plan = make_plan(false, ExecutionPrecision::Double);
    add_global_dmi_texture(&mut plan);
    let native = build_native_stacked_cuda_plan(&plan)
        .expect("native stacked plan should build")
        .expect("plan should be eligible for native stacked fast path");
    let cell_count = native.combined_plan.initial_magnetization.len();
    let zero_field = vec![[0.0, 0.0, 0.0]; cell_count];

    let observables = observe_native_stacked_fields(
        &native,
        &native.combined_plan.initial_magnetization,
        &zero_field,
        &zero_field,
        &zero_field,
        &zero_field,
    )
    .expect("native stacked field assembly should compute");

    assert_eq!(observables.dmi_field.len(), 32);
    assert!(
        max_norm(&observables.dmi_field) > 0.0,
        "native stacked observables must preserve H_dmi for field snapshots"
    );
    assert!(
        observables.dmi_energy.abs() > 0.0,
        "native stacked observables must preserve DMI scalar energy"
    );
    assert!(
        observables
            .per_object_scalars
            .get("free")
            .and_then(|values| values.get("e_dmi"))
            .is_some_and(|value| value.abs() > 0.0),
        "native stacked per-object scalars must include layer-local DMI energy"
    );
}

#[test]
fn native_stacked_observables_include_layer_anisotropy_outputs() {
    let mut plan = make_plan(false, ExecutionPrecision::Double);
    add_uniaxial_anisotropy_texture(&mut plan);
    let native = build_native_stacked_cuda_plan(&plan)
        .expect("native stacked plan should build")
        .expect("plan should be eligible for native stacked fast path");
    let cell_count = native.combined_plan.initial_magnetization.len();
    let zero_field = vec![[0.0, 0.0, 0.0]; cell_count];

    let observables = observe_native_stacked_fields(
        &native,
        &native.combined_plan.initial_magnetization,
        &zero_field,
        &zero_field,
        &zero_field,
        &zero_field,
    )
    .expect("native stacked field assembly should compute");

    assert_eq!(observables.anisotropy_field.len(), 32);
    assert!(
        max_norm(&observables.anisotropy_field) > 0.0,
        "native stacked observables must preserve H_ani for field snapshots"
    );
    assert!(
        observables.anisotropy_energy.abs() > 0.0,
        "native stacked observables must preserve anisotropy scalar energy"
    );
    let selected = select_state_observable_field(&observables, "H_ani", false)
        .expect("H_ani should be selectable from native stacked observables");
    assert_eq!(
        max_vector_component_diff(&selected, &observables.anisotropy_field),
        0.0
    );
}

#[test]
fn native_stacked_stats_use_layer_observables_instead_of_combined_grid_scalars() {
    let mut per_object_scalars = std::collections::HashMap::new();
    per_object_scalars.insert(
        "bottom".to_string(),
        std::collections::HashMap::from([("e_total".to_string(), 4.0), ("mx".to_string(), 1.0)]),
    );
    per_object_scalars.insert(
        "top".to_string(),
        std::collections::HashMap::from([("e_total".to_string(), 6.0), ("my".to_string(), 1.0)]),
    );
    let observables = StateObservables {
        magnetization: vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        torque_field: Vec::new(),
        exchange_field: Vec::new(),
        demag_field: Vec::new(),
        external_field: Vec::new(),
        antenna_field: Vec::new(),
        effective_field: Vec::new(),
        anisotropy_field: Vec::new(),
        dmi_field: Vec::new(),
        magnetoelastic_field: Vec::new(),
        cubic_anisotropy_field: Vec::new(),
        bulk_dmi_field: Vec::new(),
        oersted_field: Vec::new(),
        thermal_field: Vec::new(),
        exchange_energy: 1.0,
        demag_energy: 2.0,
        external_energy: 3.0,
        anisotropy_energy: 0.5,
        dmi_energy: 0.25,
        total_energy: 6.75,
        max_dm_dt: 7.0,
        max_h_eff: 8.0,
        max_h_demag: 9.0,
        max_torque_Apm: 10.0,
        per_object_scalars,
    };
    let native_step = StepStats {
        step: 12,
        time: 3.0e-13,
        dt: 1.0e-13,
        e_total: 999.0,
        wall_time_ns: 42,
        dt_suggested: Some(2.0e-13),
        per_object_scalars: std::collections::HashMap::from([(
            "free".to_string(),
            std::collections::HashMap::from([("e_total".to_string(), 999.0)]),
        )]),
        ..StepStats::default()
    };

    let stats = make_native_stacked_step_stats(&native_step, &observables);

    assert_eq!(stats.step, native_step.step);
    assert_eq!(stats.time, native_step.time);
    assert_eq!(stats.dt, native_step.dt);
    assert_eq!(stats.wall_time_ns, native_step.wall_time_ns);
    assert_eq!(stats.dt_suggested, native_step.dt_suggested);
    assert_eq!(stats.e_total, observables.total_energy);
    assert_eq!(stats.e_ex, observables.exchange_energy);
    assert_eq!(stats.e_demag, observables.demag_energy);
    assert_eq!(stats.e_ani, observables.anisotropy_energy);
    assert_eq!(stats.e_dmi, observables.dmi_energy);
    assert_eq!(stats.max_torque_Apm, observables.max_torque_Apm);
    assert_eq!(stats.max_torque_T, observables.max_torque_Apm * crate::MU0);
    assert_eq!(stats.per_object_scalars.len(), 2);
    assert!(stats.per_object_scalars.contains_key("bottom"));
    assert!(stats.per_object_scalars.contains_key("top"));
    assert!(!stats.per_object_scalars.contains_key("free"));
}

#[test]
fn cuda_assisted_multilayer_tracks_cpu_reference_when_cuda_is_available() {
    if !is_cuda_available() {
        eprintln!("skipping cuda-assisted multilayer test: CUDA backend is not available");
        return;
    }

    let plan = make_plan(true, ExecutionPrecision::Double);
    let cpu = multilayer_reference::execute_reference_fdm_multilayer(&plan, 2e-13, &[], None, None)
        .expect("cpu multilayer");
    let cuda = execute_cuda_fdm_multilayer(&plan, 2e-13, &[]).expect("cuda-assisted multilayer");

    let cpu_final = cpu.result.steps.last().expect("cpu final");
    let cuda_final = cuda.result.steps.last().expect("cuda final");
    let rel_gap =
        (cuda_final.e_total - cpu_final.e_total).abs() / cpu_final.e_total.abs().max(1e-30);
    assert!(
            rel_gap < 5e-3,
            "cuda-assisted multilayer should stay close to cpu reference; rel_gap={rel_gap} cpu={} cuda={}",
            cpu_final.e_total,
            cuda_final.e_total
        );
    assert_eq!(
        cuda.provenance.execution_engine,
        "cuda_native_multilayer_single_grid"
    );
}

#[test]
fn native_single_grid_multilayer_preserves_inter_body_exchange_barrier() {
    if !is_cuda_available() {
        eprintln!("skipping touching multilayer test: CUDA backend is not available");
        return;
    }

    let plan = make_touching_plan(ExecutionPrecision::Double);
    let cpu = multilayer_reference::execute_reference_fdm_multilayer(&plan, 1e-13, &[], None, None)
        .expect("cpu multilayer");
    let cuda = execute_cuda_fdm_multilayer(&plan, 1e-13, &[]).expect("cuda multilayer");

    let cpu_initial = cpu.result.steps.first().expect("cpu initial");
    let cuda_initial = cuda.result.steps.first().expect("cuda initial");
    assert!(
        cpu_initial.e_ex.abs() <= 1e-24,
        "touching CPU baseline should have zero inter-body exchange, got {}",
        cpu_initial.e_ex
    );
    assert!(
            cuda_initial.e_ex.abs() <= 1e-24,
            "native CUDA combined-grid path should keep exchange barrier across touching bodies, got {}",
            cuda_initial.e_ex
        );

    let cpu_final = cpu.result.steps.last().expect("cpu final");
    let cuda_final = cuda.result.steps.last().expect("cuda final");
    let rel_gap =
        (cuda_final.e_total - cpu_final.e_total).abs() / cpu_final.e_total.abs().max(1e-30);
    assert!(
            rel_gap < 5e-3,
            "touching-body native CUDA path should stay close to CPU multilayer reference; rel_gap={rel_gap} cpu={} cuda={}",
            cpu_final.e_total,
            cuda_final.e_total
        );
}

#[test]
fn native_single_grid_multilayer_single_precision_stays_close_to_double_when_cuda_is_available() {
    if !is_cuda_available() {
        eprintln!(
            "skipping native multilayer single-precision test: CUDA backend is not available"
        );
        return;
    }

    let double_plan = make_plan(true, ExecutionPrecision::Double);
    let single_plan = make_plan(true, ExecutionPrecision::Single);
    let double_run =
        execute_cuda_fdm_multilayer(&double_plan, 2e-13, &[]).expect("double multilayer");
    let single_run =
        execute_cuda_fdm_multilayer(&single_plan, 2e-13, &[]).expect("single multilayer");

    assert_eq!(
        double_run.provenance.execution_engine,
        "cuda_native_multilayer_single_grid"
    );
    assert_eq!(
        single_run.provenance.execution_engine,
        "cuda_native_multilayer_single_grid"
    );
    assert_eq!(single_run.provenance.precision, "single");

    let max_m_diff = max_vector_component_diff(
        &single_run.result.final_magnetization,
        &double_run.result.final_magnetization,
    );
    assert!(
        max_m_diff <= 1e-5,
        "native multilayer single precision magnetization drift too large: {max_m_diff:.6e}"
    );

    let double_final = double_run.result.steps.last().expect("double final");
    let single_final = single_run.result.steps.last().expect("single final");
    let rel_gap =
        (single_final.e_total - double_final.e_total).abs() / double_final.e_total.abs().max(1e-30);
    assert!(
        rel_gap <= 1e-4,
        "native multilayer single precision total-energy drift too large: rel_gap={rel_gap}"
    );
}

#[test]
fn cuda_assisted_multilayer_single_precision_stays_close_to_double_when_cuda_is_available() {
    if !is_cuda_available() {
        eprintln!(
            "skipping assisted multilayer single-precision test: CUDA backend is not available"
        );
        return;
    }

    let double_plan = make_assisted_plan(true, ExecutionPrecision::Double);
    let single_plan = make_assisted_plan(true, ExecutionPrecision::Single);
    let double_run =
        execute_cuda_fdm_multilayer(&double_plan, 2e-13, &[]).expect("double assisted multilayer");
    let single_run =
        execute_cuda_fdm_multilayer(&single_plan, 2e-13, &[]).expect("single assisted multilayer");

    assert_eq!(
        double_run.provenance.execution_engine,
        "cuda_assisted_multilayer"
    );
    assert_eq!(
        single_run.provenance.execution_engine,
        "cuda_assisted_multilayer"
    );
    assert_eq!(
        double_run.provenance.demag_operator_kind.as_deref(),
        Some("native_multilayer_tensor_fft_newell")
    );
    assert_eq!(double_run.provenance.fft_backend.as_deref(), Some("cuFFT"));
    assert_eq!(single_run.provenance.precision, "single");

    let max_m_diff = max_vector_component_diff(
        &single_run.result.final_magnetization,
        &double_run.result.final_magnetization,
    );
    assert!(
        max_m_diff <= 1e-5,
        "assisted multilayer single precision magnetization drift too large: {max_m_diff:.6e}"
    );

    let double_final = double_run.result.steps.last().expect("double final");
    let single_final = single_run.result.steps.last().expect("single final");
    let rel_gap =
        (single_final.e_total - double_final.e_total).abs() / double_final.e_total.abs().max(1e-30);
    assert!(
        rel_gap <= 1e-4,
        "assisted multilayer single precision total-energy drift too large: rel_gap={rel_gap}"
    );
}
