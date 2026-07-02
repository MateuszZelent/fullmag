use super::*;
use crate::preview::build_grid_preview_field;
use crate::relaxation::llg_overdamped_uses_pure_damping;
use crate::types::LivePreviewRequest;
use fullmag_engine::{
    CellSize, CubicAnisotropyConfig, EffectiveFieldTerms, ExchangeLlgProblem, LlgConfig,
    MaterialParameters, TimeIntegrator, UniaxialAnisotropyConfig,
};
use fullmag_ir::{
    AxisBoundary, ExchangeBoundaryCondition, ExecutionPrecision, FdmDemagPeriodicityIR,
    FdmMaterialIR, FdmPeriodicityIR, FdmPlanIR, GridDimensions, IntegratorChoice,
    RelaxationAlgorithmIR, RelaxationControlIR,
};

#[test]
fn native_fdm_snapshot_observable_accepts_anisotropy_field() {
    assert!(
        snapshot_observable("H_ani").is_some(),
        "native CUDA FDM must expose H_ani as a first-class observable"
    );
    assert!(
        snapshot_observable("H_ANI").is_some(),
        "native CUDA FDM must accept ABI-style H_ANI snapshot names"
    );
}

fn make_masked_test_plan(enable_demag: bool, precision: ExecutionPrecision) -> FdmPlanIR {
    FdmPlanIR {
        grid: GridDimensions { cells: [3, 3, 1] },
        cell_size: [5e-9, 5e-9, 10e-9],
        region_mask: vec![0; 9],
        active_mask: Some(vec![true, true, true, true, false, true, true, true, false]),
        initial_magnetization: vec![
            [1.0, 0.0, 0.0],
            [0.9950041652780258, 0.09983341664682815, 0.0],
            [0.9800665778412416, 0.19866933079506122, 0.0],
            [0.9992009587217894, 0.0, 0.03996803834887158],
            [0.9937606691655043, 0.09970865087213879, 0.04972948160146045],
            [0.9778332467629838, 0.19771314245924698, 0.06988589031642899],
            [
                0.9968017063026194,
                -0.039904089712529575,
                0.06972124896577284,
            ],
            [0.9892364775387807, 0.05946310942269411, 0.1338082836649087],
            [0.9711213242426827, 0.15730105252897553, 0.17902957342582418],
        ],
        material: FdmMaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 800e3,
            exchange_stiffness: 13e-12,
            damping: 0.1,
            ..Default::default()
        },
        gyromagnetic_ratio: 2.211e5,
        precision,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: IntegratorChoice::Heun,
        fixed_timestep: Some(2.5e-13),
        adaptive_timestep: None,
        field_refresh: None,
        relaxation: None,
        enable_exchange: true,
        enable_demag,
        external_field: Some([1.5e3, -2.0e3, 7.5e2]),
        inter_region_exchange: vec![],
        periodicity: None,
        boundary_correction: None,
        boundary_phi_floor: None,
        boundary_delta_min: None,
        boundary_geometry: None,
        current_density: None,
        stt_degree: None,
        stt_beta: None,
        stt_spin_polarization: None,
        stt_lambda: None,
        stt_epsilon_prime: None,
        stt_thickness: None,
        stt_fixed_layer_position: None,
        sot_current_density: None,
        sot_xi_dl: None,
        sot_xi_fl: None,
        sot_sigma: None,
        sot_thickness: None,
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
        oersted_realization: None,
        temperature: None,
        interfacial_dmi: None,
        bulk_dmi: None,
        mel_b1: None,
        mel_b2: None,
        mel_uniform_strain: None,
    }
}

fn make_thin_film_demag_plan() -> FdmPlanIR {
    let nx = 8usize;
    let ny = 6usize;
    let nz = 1usize;
    let mut initial_magnetization = Vec::with_capacity(nx * ny * nz);
    for y in 0..ny {
        for x in 0..nx {
            let theta = 0.11 * x as f64;
            let phi = 0.07 * y as f64;
            let mx = theta.cos() * phi.cos();
            let my = theta.sin() * phi.cos();
            let mz = 0.2 * phi.sin();
            let norm = (mx * mx + my * my + mz * mz).sqrt();
            initial_magnetization.push([mx / norm, my / norm, mz / norm]);
        }
    }

    FdmPlanIR {
        grid: GridDimensions {
            cells: [nx as u32, ny as u32, nz as u32],
        },
        cell_size: [4e-9, 4e-9, 10e-9],
        region_mask: vec![0; nx * ny * nz],
        active_mask: None,
        initial_magnetization,
        material: FdmMaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 800e3,
            exchange_stiffness: 13e-12,
            damping: 0.1,
            ..Default::default()
        },
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: IntegratorChoice::Heun,
        fixed_timestep: Some(2.0e-13),
        adaptive_timestep: None,
        field_refresh: None,
        relaxation: None,
        enable_exchange: true,
        enable_demag: true,
        external_field: Some([2.0e3, -1.0e3, 5.0e2]),
        inter_region_exchange: vec![],
        periodicity: None,
        boundary_correction: None,
        boundary_phi_floor: None,
        boundary_delta_min: None,
        boundary_geometry: None,
        current_density: None,
        stt_degree: None,
        stt_beta: None,
        stt_spin_polarization: None,
        stt_lambda: None,
        stt_epsilon_prime: None,
        stt_thickness: None,
        stt_fixed_layer_position: None,
        sot_current_density: None,
        sot_xi_dl: None,
        sot_xi_fl: None,
        sot_sigma: None,
        sot_thickness: None,
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
        oersted_realization: None,
        temperature: None,
        interfacial_dmi: None,
        bulk_dmi: None,
        mel_b1: None,
        mel_b2: None,
        mel_uniform_strain: None,
    }
}

fn make_relaxation_precession_test_plan() -> FdmPlanIR {
    FdmPlanIR {
        grid: GridDimensions { cells: [1, 1, 1] },
        cell_size: [5e-9, 5e-9, 5e-9],
        region_mask: vec![0],
        active_mask: None,
        initial_magnetization: vec![[1.0, 0.0, 0.0]],
        material: FdmMaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 800e3,
            exchange_stiffness: 13e-12,
            damping: 0.1,
            ..Default::default()
        },
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: IntegratorChoice::Rk23,
        fixed_timestep: Some(1e-15),
        adaptive_timestep: None,
        field_refresh: None,
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-6),
                energy_tolerance_j: None,
                max_steps: Some(10),
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        }),
        enable_exchange: false,
        enable_demag: false,
        external_field: Some([0.0, 0.0, 8.0e5]),
        inter_region_exchange: vec![],
        periodicity: None,
        boundary_correction: None,
        boundary_phi_floor: None,
        boundary_delta_min: None,
        boundary_geometry: None,
        current_density: None,
        stt_degree: None,
        stt_beta: None,
        stt_spin_polarization: None,
        stt_lambda: None,
        stt_epsilon_prime: None,
        stt_thickness: None,
        stt_fixed_layer_position: None,
        sot_current_density: None,
        sot_xi_dl: None,
        sot_xi_fl: None,
        sot_sigma: None,
        sot_thickness: None,
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
        oersted_realization: None,
        temperature: None,
        interfacial_dmi: None,
        bulk_dmi: None,
        mel_b1: None,
        mel_b2: None,
        mel_uniform_strain: None,
    }
}

fn assert_scalar_close(label: &str, actual: f64, expected: f64, rel_tol: f64, abs_tol: f64) {
    let diff = (actual - expected).abs();
    let scale = expected.abs().max(actual.abs()).max(1.0);
    assert!(
        diff <= abs_tol.max(rel_tol * scale),
        "{} mismatch: actual={} expected={} diff={}",
        label,
        actual,
        expected,
        diff
    );
}

fn assert_vector_field_close(
    label: &str,
    actual: &[[f64; 3]],
    expected: &[[f64; 3]],
    rel_tol: f64,
    abs_tol: f64,
) {
    assert_eq!(actual.len(), expected.len(), "{} length mismatch", label);
    for (index, (a, e)) in actual.iter().zip(expected.iter()).enumerate() {
        for component in 0..3 {
            assert_scalar_close(
                &format!("{}[{}][{}]", label, index, component),
                a[component],
                e[component],
                rel_tol,
                abs_tol,
            );
        }
    }
}

fn assert_flat_field_close(
    label: &str,
    actual: &[f64],
    expected: &[f64],
    rel_tol: f64,
    abs_tol: f64,
) {
    assert_eq!(actual.len(), expected.len(), "{} length mismatch", label);
    for (index, (actual, expected)) in actual.iter().zip(expected.iter()).enumerate() {
        assert_scalar_close(
            &format!("{}[{}]", label, index),
            *actual,
            *expected,
            rel_tol,
            abs_tol,
        );
    }
}

fn max_vector_component_diff(actual: &[[f64; 3]], expected: &[[f64; 3]]) -> f64 {
    actual
        .iter()
        .zip(expected.iter())
        .flat_map(|(a, e)| (0..3).map(move |component| (a[component] - e[component]).abs()))
        .fold(0.0, f64::max)
}

fn max_vector_component_diff_f32(actual: &[[f32; 3]], expected: &[[f64; 3]]) -> f64 {
    actual
        .iter()
        .zip(expected.iter())
        .flat_map(|(a, e)| {
            (0..3).map(move |component| (f64::from(a[component]) - e[component]).abs())
        })
        .fold(0.0, f64::max)
}

fn masked_oersted_field(plan: &FdmPlanIR) -> Vec<[f64; 3]> {
    let raw = plan
        .oersted_field_xyz
        .clone()
        .expect("test plan should carry oersted field");
    let active_mask = plan
        .active_mask
        .as_ref()
        .expect("test plan should carry active mask");
    raw.into_iter()
        .zip(active_mask.iter())
        .map(|(value, is_active)| if *is_active { value } else { [0.0, 0.0, 0.0] })
        .collect()
}

fn generalized_oersted_preview_request() -> LivePreviewRequest {
    LivePreviewRequest {
        revision: 7,
        quantity: "H_OE".to_string(),
        component: "3D".to_string(),
        layer: 0,
        all_layers: false,
        every_n: 1,
        x_chosen_size: 3,
        y_chosen_size: 3,
        auto_scale_enabled: false,
        max_points: 9,
    }
}

fn anisotropy_preview_request() -> LivePreviewRequest {
    LivePreviewRequest {
        quantity: "H_ani".to_string(),
        ..generalized_oersted_preview_request()
    }
}

fn decode_snapshot_payload(info: NativeFieldSnapshotInfo, payload: &[u8]) -> Vec<[f64; 3]> {
    assert_eq!(info.component_count, 3, "expected vector snapshot payload");
    let scalars = match info.scalar_type {
        NativeFieldSnapshotScalarType::F32 => payload
            .chunks_exact(std::mem::size_of::<f32>())
            .map(|chunk| f64::from(f32::from_ne_bytes(chunk.try_into().unwrap())))
            .collect::<Vec<_>>(),
        NativeFieldSnapshotScalarType::F64 => payload
            .chunks_exact(std::mem::size_of::<f64>())
            .map(|chunk| f64::from_ne_bytes(chunk.try_into().unwrap()))
            .collect::<Vec<_>>(),
    };
    assert_eq!(
        scalars.len(),
        info.cell_count * info.component_count,
        "decoded snapshot scalar count should match descriptor"
    );
    let mut vectors = vec![[0.0, 0.0, 0.0]; info.cell_count];
    for cell in 0..info.cell_count {
        vectors[cell][0] = scalars[cell];
        vectors[cell][1] = scalars[info.cell_count + cell];
        vectors[cell][2] = scalars[(2 * info.cell_count) + cell];
    }
    vectors
}

fn cpu_reference_single_step(
    plan: &FdmPlanIR,
) -> (
    Vec<[f64; 3]>,
    Vec<[f64; 3]>,
    Vec<[f64; 3]>,
    Vec<[f64; 3]>,
    Vec<[f64; 3]>,
    Vec<[f64; 3]>,
    fullmag_engine::StepReport,
) {
    let grid = fullmag_engine::GridShape::new(
        plan.grid.cells[0] as usize,
        plan.grid.cells[1] as usize,
        plan.grid.cells[2] as usize,
    )
    .expect("grid");
    let cell_size =
        CellSize::new(plan.cell_size[0], plan.cell_size[1], plan.cell_size[2]).expect("cell");
    let material = MaterialParameters::new(
        plan.material.saturation_magnetisation,
        plan.material.exchange_stiffness,
        plan.material.damping,
    )
    .expect("material");
    let integrator = match plan.integrator {
        fullmag_ir::IntegratorChoice::Heun => TimeIntegrator::Heun,
        fullmag_ir::IntegratorChoice::Rk4 => TimeIntegrator::RK4,
        fullmag_ir::IntegratorChoice::Rk23 => TimeIntegrator::RK23,
        fullmag_ir::IntegratorChoice::Rk45 => TimeIntegrator::RK45,
        fullmag_ir::IntegratorChoice::Abm3 => TimeIntegrator::ABM3,
    };
    let dynamics = LlgConfig::new(plan.gyromagnetic_ratio, integrator)
        .expect("dynamics")
        .with_precession_enabled(!llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()));
    let problem = ExchangeLlgProblem::with_terms_and_mask(
        grid,
        cell_size,
        material,
        dynamics,
        EffectiveFieldTerms {
            exchange: plan.enable_exchange,
            demag: plan.enable_demag,
            external_field: plan.external_field,
            per_node_field: plan.oersted_field_xyz.clone(),
            magnetoelastic: None,
            uniaxial_anisotropy: plan.material.uniaxial_anisotropy_ku1.map(|ku1| {
                UniaxialAnisotropyConfig {
                    ku1,
                    ku2: plan.material.uniaxial_anisotropy_ku2.unwrap_or(0.0),
                    axis: plan.material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0]),
                }
            }),
            cubic_anisotropy: plan
                .material
                .cubic_anisotropy_kc1
                .map(|kc1| CubicAnisotropyConfig {
                    kc1,
                    kc2: plan.material.cubic_anisotropy_kc2.unwrap_or(0.0),
                    axis1: plan
                        .material
                        .cubic_anisotropy_axis1
                        .unwrap_or([1.0, 0.0, 0.0]),
                    axis2: plan
                        .material
                        .cubic_anisotropy_axis2
                        .unwrap_or([0.0, 1.0, 0.0]),
                }),
            interfacial_dmi: plan.interfacial_dmi,
            bulk_dmi: plan.bulk_dmi,
            zhang_li_stt: None,
            slonczewski_stt: None,
            sot: None,
            oersted_cylinder: None,
        },
        plan.active_mask.clone(),
    )
    .expect("problem");

    let mut state = problem
        .new_state(plan.initial_magnetization.clone())
        .expect("state");
    let mut workspace = problem.create_workspace();
    let report = problem
        .step_with_workspace(
            &mut state,
            plan.fixed_timestep.expect("fixed dt"),
            &mut workspace,
        )
        .expect("cpu step");
    let observables = problem.observe(&state).expect("observe");
    let anisotropy_field = problem.anisotropy_field(state.magnetization());
    (
        state.magnetization().to_vec(),
        observables.exchange_field,
        observables.demag_field,
        observables.external_field,
        anisotropy_field,
        observables.effective_field,
        report,
    )
}

#[test]
fn native_fdm_masked_exchange_only_matches_cpu_reference_when_cuda_is_available() {
    if !is_cuda_available() {
        eprintln!(
                "skipping native CUDA FDM masked parity test: CUDA backend is not available on this host"
            );
        return;
    }

    let plan = make_masked_test_plan(false, ExecutionPrecision::Double);
    let active_mask = plan.active_mask.clone().expect("active mask");
    let cell_count = plan.initial_magnetization.len();
    let (
        expected_m,
        expected_h_ex,
        _expected_h_demag,
        expected_h_ext,
        _expected_h_ani,
        expected_h_eff,
        expected_report,
    ) = cpu_reference_single_step(&plan);

    let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
    let stats = backend
        .step(plan.fixed_timestep.expect("fixed dt"))
        .expect("native fdm step");
    let actual_m = backend.copy_m(cell_count).expect("copy m");
    let actual_h_ex = backend.copy_h_ex(cell_count).expect("copy H_ex");
    let actual_h_ext = backend.copy_h_ext(cell_count).expect("copy H_ext");
    let actual_h_eff = backend.copy_h_eff(cell_count).expect("copy H_eff");

    assert_vector_field_close("m", &actual_m, &expected_m, 5e-6, 1e-8);
    assert_vector_field_close("H_ex", &actual_h_ex, &expected_h_ex, 5e-5, 1e-2);
    assert_vector_field_close("H_ext", &actual_h_ext, &expected_h_ext, 1e-12, 1e-12);
    assert_vector_field_close("H_eff", &actual_h_eff, &expected_h_eff, 5e-5, 1e-2);

    for (index, is_active) in active_mask.iter().enumerate() {
        if !is_active {
            assert_eq!(
                actual_m[index],
                [0.0, 0.0, 0.0],
                "inactive m leak at {index}"
            );
            assert_eq!(
                actual_h_ex[index],
                [0.0, 0.0, 0.0],
                "inactive H_ex leak at {index}"
            );
            assert_eq!(
                actual_h_ext[index],
                [0.0, 0.0, 0.0],
                "inactive H_ext leak at {index}"
            );
            assert_eq!(
                actual_h_eff[index],
                [0.0, 0.0, 0.0],
                "inactive H_eff leak at {index}"
            );
        }
    }

    assert_scalar_close(
        "time_seconds",
        stats.time,
        expected_report.time_seconds,
        1e-12,
        1e-18,
    );
    assert_scalar_close(
        "exchange_energy_joules",
        stats.e_ex,
        expected_report.exchange_energy_joules,
        5e-6,
        1e-18,
    );
    assert_scalar_close(
        "external_energy_joules",
        stats.e_ext,
        expected_report.external_energy_joules,
        1e-6,
        1e-18,
    );
    assert_scalar_close(
        "total_energy_joules",
        stats.e_total,
        expected_report.total_energy_joules,
        5e-6,
        1e-18,
    );
    assert_scalar_close(
        "max_effective_field_amplitude",
        stats.max_h_eff,
        expected_report.max_effective_field_amplitude,
        5e-5,
        1e-4,
    );
    assert_scalar_close(
        "max_rhs_amplitude",
        stats.max_dm_dt,
        expected_report.max_rhs_amplitude,
        5e-5,
        1e-4,
    );
}

#[test]
fn native_fdm_anisotropy_copy_preview_and_snapshot_match_cpu_reference_when_cuda_is_available() {
    if !is_cuda_available() {
        eprintln!(
                "skipping native CUDA FDM anisotropy observable test: CUDA backend is not available on this host"
            );
        return;
    }

    let mut plan = make_masked_test_plan(false, ExecutionPrecision::Double);
    plan.material.uniaxial_anisotropy_ku1 = Some(8.0e4);
    plan.material.uniaxial_anisotropy_ku2 = Some(1.0e4);
    plan.material.anisotropy_axis = Some([0.0, 0.0, 1.0]);
    let cell_count = plan.initial_magnetization.len();
    let (_, _, _, _, expected_h_ani, _, _) = cpu_reference_single_step(&plan);

    let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
    backend
        .step(plan.fixed_timestep.expect("fixed dt"))
        .expect("native fdm step");

    let actual_h_ani = backend.copy_h_ani(cell_count).expect("copy H_ani");
    assert_vector_field_close("H_ani", &actual_h_ani, &expected_h_ani, 5e-5, 1e-2);

    let request = anisotropy_preview_request();
    let expected_preview = build_grid_preview_field(
        &request,
        &expected_h_ani,
        plan.grid.cells,
        plan.active_mask.as_deref(),
    );
    let actual_sync = backend
        .copy_live_preview_field(&request, plan.grid.cells, plan.active_mask.as_deref())
        .expect("copy H_ani preview");
    let actual_async = backend
        .begin_live_preview_snapshot(&request, plan.grid.cells)
        .expect("begin H_ani preview snapshot")
        .into_live_preview_field(plan.active_mask.as_deref())
        .expect("collect H_ani preview snapshot");

    assert_eq!(actual_sync.quantity, "H_ani");
    assert_eq!(actual_sync.unit, expected_preview.unit);
    assert_eq!(actual_sync.preview_grid, expected_preview.preview_grid);
    assert_flat_field_close(
        "H_ani.preview",
        &actual_sync.vector_field_values,
        &expected_preview.vector_field_values,
        5e-5,
        1e-2,
    );
    assert_flat_field_close(
        "H_ani.preview_async",
        &actual_async.vector_field_values,
        &expected_preview.vector_field_values,
        5e-5,
        1e-2,
    );

    let mut snapshot = backend
        .begin_field_snapshot("H_ani", 3, 0.0, plan.fixed_timestep.unwrap_or(0.0))
        .expect("begin H_ani field snapshot");
    let mut payload = Vec::new();
    let written_info = snapshot
        .write_payload(&mut payload)
        .expect("H_ani snapshot payload");
    let decoded = decode_snapshot_payload(written_info, &payload);
    assert_vector_field_close("H_ani.snapshot", &decoded, &expected_h_ani, 5e-5, 1e-2);
}

#[test]
fn native_fdm_slonczewski_matches_cpu_reference_without_zhang_li_when_cuda_is_available() {
    if !is_cuda_available() {
        eprintln!(
                "skipping native CUDA FDM Slonczewski parity test: CUDA backend is not available on this host"
            );
        return;
    }

    let mut plan = make_masked_test_plan(false, ExecutionPrecision::Double);
    plan.current_density = Some([1.4e11, 0.0, 0.0]);
    plan.stt_degree = Some(0.62);
    plan.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
    plan.stt_lambda = Some(1.8);
    plan.stt_epsilon_prime = Some(0.03);

    let expected =
        crate::fdm::cpu::reference::execute_reference_fdm(&plan, 2.5e-13, &[], None, None)
            .expect("cpu reference slonczewski run");
    let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
    backend
        .step(plan.fixed_timestep.expect("fixed dt"))
        .expect("native fdm slonczewski step");
    let actual_m = backend
        .copy_m(plan.initial_magnetization.len())
        .expect("copy m");

    assert_vector_field_close(
        "m",
        &actual_m,
        &expected.result.final_magnetization,
        5e-8,
        1e-10,
    );
}

#[test]
fn native_fdm_masked_demag_fields_stay_zero_outside_active_domain_when_cuda_is_available() {
    if !is_cuda_available() {
        eprintln!(
                "skipping native CUDA FDM masked demag test: CUDA backend is not available on this host"
            );
        return;
    }

    let plan = make_masked_test_plan(true, ExecutionPrecision::Double);
    let active_mask = plan.active_mask.clone().expect("active mask");
    let cell_count = plan.initial_magnetization.len();

    let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
    backend
        .step(plan.fixed_timestep.expect("fixed dt"))
        .expect("native fdm step");

    let actual_m = backend.copy_m(cell_count).expect("copy m");
    let actual_h_demag = backend.copy_h_demag(cell_count).expect("copy H_demag");
    let actual_h_ext = backend.copy_h_ext(cell_count).expect("copy H_ext");
    let actual_h_eff = backend.copy_h_eff(cell_count).expect("copy H_eff");

    for (index, is_active) in active_mask.iter().enumerate() {
        if !is_active {
            assert_eq!(
                actual_m[index],
                [0.0, 0.0, 0.0],
                "inactive m leak at {index}"
            );
            assert_eq!(
                actual_h_demag[index],
                [0.0, 0.0, 0.0],
                "inactive H_demag leak at {index}"
            );
            assert_eq!(
                actual_h_ext[index],
                [0.0, 0.0, 0.0],
                "inactive H_ext leak at {index}"
            );
            assert_eq!(
                actual_h_eff[index],
                [0.0, 0.0, 0.0],
                "inactive H_eff leak at {index}"
            );
        } else {
            assert_eq!(
                actual_h_ext[index],
                plan.external_field.expect("external field"),
                "active H_ext mismatch at {index}"
            );
        }
    }

    assert!(
        actual_h_demag
            .iter()
            .zip(active_mask.iter())
            .any(|(value, is_active)| *is_active && *value != [0.0, 0.0, 0.0]),
        "expected at least one active cell to carry non-zero H_demag"
    );
}

#[test]
fn native_fdm_generalized_oersted_matches_cpu_reference_when_cuda_is_available() {
    if !is_cuda_available() {
        eprintln!(
                "skipping native CUDA FDM generalized Oersted parity test: CUDA backend is not available on this host"
            );
        return;
    }

    let mut plan = make_masked_test_plan(false, ExecutionPrecision::Double);
    plan.oersted_field_xyz = Some(vec![
        [0.0, 0.0, 1.0],
        [0.0, 1.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.5, 0.5, 0.5],
        [0.0, 0.0, 0.0],
        [0.0, -1.0, 0.0],
        [-1.0, 0.0, 0.0],
        [-0.5, -0.5, -0.5],
        [0.25, 0.0, 0.0],
    ]);
    plan.oersted_realization = Some(fullmag_ir::OerstedRealization::BiotSavartMidpoint);
    let cell_count = plan.initial_magnetization.len();

    let (
        expected_m,
        expected_h_ex,
        _expected_h_demag,
        expected_h_ext,
        _expected_h_ani,
        expected_h_eff,
        expected_report,
    ) = cpu_reference_single_step(&plan);
    let expected_h_oe = plan.oersted_field_xyz.clone().expect("oersted field");

    let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
    let stats = backend
        .step(plan.fixed_timestep.expect("fixed dt"))
        .expect("native fdm step");
    let actual_m = backend.copy_m(cell_count).expect("copy m");
    let actual_h_ex = backend.copy_h_ex(cell_count).expect("copy H_ex");
    let actual_h_ext = backend.copy_h_ext(cell_count).expect("copy H_ext");
    let actual_h_oe = backend.copy_h_oe(cell_count).expect("copy H_OE");
    let actual_h_eff = backend.copy_h_eff(cell_count).expect("copy H_eff");

    assert_vector_field_close("m", &actual_m, &expected_m, 5e-6, 1e-8);
    assert_vector_field_close("H_ex", &actual_h_ex, &expected_h_ex, 5e-5, 1e-2);
    assert_vector_field_close("H_ext", &actual_h_ext, &expected_h_ext, 1e-12, 1e-12);
    assert_vector_field_close("H_OE", &actual_h_oe, &expected_h_oe, 1e-12, 1e-12);
    assert_vector_field_close("H_eff", &actual_h_eff, &expected_h_eff, 5e-5, 1e-2);

    assert_scalar_close(
        "time_seconds",
        stats.time,
        expected_report.time_seconds,
        1e-12,
        1e-18,
    );
}

#[test]
fn native_fdm_generalized_oersted_preview_matches_expected_when_cuda_is_available() {
    if !is_cuda_available() {
        eprintln!(
                "skipping native CUDA FDM generalized Oersted preview test: CUDA backend is not available on this host"
            );
        return;
    }

    let mut plan = make_masked_test_plan(false, ExecutionPrecision::Double);
    plan.oersted_field_xyz = Some(vec![
        [0.0, 0.0, 1.0],
        [0.0, 1.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.5, 0.5, 0.5],
        [0.0, 0.0, 0.0],
        [0.0, -1.0, 0.0],
        [-1.0, 0.0, 0.0],
        [-0.5, -0.5, -0.5],
        [0.25, 0.0, 0.0],
    ]);
    plan.oersted_realization = Some(fullmag_ir::OerstedRealization::BiotSavartMidpoint);

    let request = generalized_oersted_preview_request();
    let expected_preview = build_grid_preview_field(
        &request,
        &masked_oersted_field(&plan),
        plan.grid.cells,
        plan.active_mask.as_deref(),
    );

    let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
    backend
        .step(plan.fixed_timestep.expect("fixed dt"))
        .expect("native fdm step");

    let actual_sync = backend
        .copy_live_preview_field(&request, plan.grid.cells, plan.active_mask.as_deref())
        .expect("copy preview");
    let actual_async = backend
        .begin_live_preview_snapshot(&request, plan.grid.cells)
        .expect("begin preview snapshot")
        .into_live_preview_field(plan.active_mask.as_deref())
        .expect("collect preview snapshot");

    assert_eq!(actual_sync.quantity, "H_OE");
    assert_eq!(actual_sync.unit, expected_preview.unit);
    assert_eq!(
        actual_sync.quantity_domain,
        expected_preview.quantity_domain
    );
    assert_eq!(actual_sync.preview_grid, expected_preview.preview_grid);
    assert_eq!(actual_sync.active_mask, expected_preview.active_mask);
    assert_eq!(actual_async.active_mask, expected_preview.active_mask);
    assert_eq!(
        actual_sync.vector_field_values, expected_preview.vector_field_values,
        "synchronous preview should preserve H_OE values"
    );
    assert_eq!(
        actual_async.vector_field_values, expected_preview.vector_field_values,
        "async preview snapshot should preserve H_OE values"
    );
}

#[test]
fn native_fdm_generalized_oersted_field_snapshot_matches_expected_when_cuda_is_available() {
    if !is_cuda_available() {
        eprintln!(
                "skipping native CUDA FDM generalized Oersted field snapshot test: CUDA backend is not available on this host"
            );
        return;
    }

    let mut plan = make_masked_test_plan(false, ExecutionPrecision::Double);
    plan.oersted_field_xyz = Some(vec![
        [0.0, 0.0, 1.0],
        [0.0, 1.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.5, 0.5, 0.5],
        [0.0, 0.0, 0.0],
        [0.0, -1.0, 0.0],
        [-1.0, 0.0, 0.0],
        [-0.5, -0.5, -0.5],
        [0.25, 0.0, 0.0],
    ]);
    plan.oersted_realization = Some(fullmag_ir::OerstedRealization::BiotSavartMidpoint);

    let expected_h_oe = masked_oersted_field(&plan);
    let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
    backend
        .step(plan.fixed_timestep.expect("fixed dt"))
        .expect("native fdm step");

    let mut snapshot = backend
        .begin_field_snapshot("H_OE", 3, 0.0, plan.fixed_timestep.unwrap_or(0.0))
        .expect("begin H_OE field snapshot");
    let _info = snapshot.info().expect("snapshot info");
    let mut payload = Vec::new();
    let written_info = snapshot
        .write_payload(&mut payload)
        .expect("snapshot payload");
    assert_eq!(written_info.cell_count, expected_h_oe.len());
    assert_eq!(written_info.component_count, 3);
    let decoded = decode_snapshot_payload(written_info, &payload);
    assert_vector_field_close("H_OE.snapshot", &decoded, &expected_h_oe, 1e-12, 1e-12);
}

#[test]
fn native_fdm_single_precision_stays_close_to_double_when_cuda_is_available() {
    if !is_cuda_available() {
        eprintln!(
                "skipping native CUDA FDM single-precision parity test: CUDA backend is not available on this host"
            );
        return;
    }

    let double_plan = make_masked_test_plan(true, ExecutionPrecision::Double);
    let mut single_plan = double_plan.clone();
    single_plan.precision = ExecutionPrecision::Single;
    let cell_count = double_plan.initial_magnetization.len();

    let mut backend_double =
        NativeFdmBackend::create(&double_plan).expect("native fdm create double");
    let stats_double = backend_double
        .step(double_plan.fixed_timestep.expect("fixed dt"))
        .expect("native fdm double step");
    let m_double = backend_double.copy_m(cell_count).expect("copy m double");
    let h_eff_double = backend_double
        .copy_h_eff(cell_count)
        .expect("copy H_eff double");

    let mut backend_single =
        NativeFdmBackend::create(&single_plan).expect("native fdm create single");
    let stats_single = backend_single
        .step(single_plan.fixed_timestep.expect("fixed dt"))
        .expect("native fdm single step");
    let m_single = backend_single.copy_m(cell_count).expect("copy m single");
    let h_eff_single = backend_single
        .copy_h_eff(cell_count)
        .expect("copy H_eff single");

    let max_m_diff = max_vector_component_diff(&m_single, &m_double);
    assert!(
        max_m_diff <= 1e-5,
        "single precision magnetization drift too large: {max_m_diff:.6e}"
    );

    let max_h_eff_diff = max_vector_component_diff(&h_eff_single, &h_eff_double);
    assert!(
        max_h_eff_diff <= 5e-1,
        "single precision H_eff drift too large: {max_h_eff_diff:.6e}"
    );

    assert_scalar_close(
        "single_vs_double.exchange_energy",
        stats_single.e_ex,
        stats_double.e_ex,
        1e-4,
        1e-18,
    );
    assert_scalar_close(
        "single_vs_double.demag_energy",
        stats_single.e_demag,
        stats_double.e_demag,
        1e-4,
        1e-18,
    );
    assert_scalar_close(
        "single_vs_double.total_energy",
        stats_single.e_total,
        stats_double.e_total,
        1e-4,
        1e-18,
    );
    assert_scalar_close(
        "single_vs_double.max_rhs",
        stats_single.max_dm_dt,
        stats_double.max_dm_dt,
        1e-4,
        1e-8,
    );
}

#[test]
fn native_fdm_single_precision_f32_transfers_match_f64_exports_when_cuda_is_available() {
    if !is_cuda_available() {
        eprintln!(
                "skipping native CUDA FDM single-precision transfer test: CUDA backend is not available on this host"
            );
        return;
    }

    let plan = make_masked_test_plan(true, ExecutionPrecision::Single);
    let active_mask = plan.active_mask.clone().expect("active mask");
    let cell_count = plan.initial_magnetization.len();

    let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create single");
    backend
        .step(plan.fixed_timestep.expect("fixed dt"))
        .expect("native fdm single step");

    let m_f64 = backend.copy_m(cell_count).expect("copy m f64");
    let h_eff_f64 = backend.copy_h_eff(cell_count).expect("copy H_eff f64");
    let m_f32 = backend.copy_m_f32(cell_count).expect("copy m f32");
    let h_eff_f32 = backend.copy_h_eff_f32(cell_count).expect("copy H_eff f32");

    assert!(
        max_vector_component_diff_f32(&m_f32, &m_f64) <= 1e-6,
        "f32 m export diverged from f64 export"
    );
    assert!(
        max_vector_component_diff_f32(&h_eff_f32, &h_eff_f64) <= 1e-3,
        "f32 H_eff export diverged from f64 export"
    );

    let upload = plan
        .initial_magnetization
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let sign = if index % 2 == 0 { -1.0f32 } else { 1.0f32 };
            [
                sign * value[0] as f32,
                sign * value[1] as f32,
                sign * value[2] as f32,
            ]
        })
        .collect::<Vec<_>>();

    backend
        .upload_magnetization_f32(&upload)
        .expect("upload f32 magnetization");
    backend
        .refresh_observables()
        .expect("refresh observables after f32 upload");
    let roundtrip = backend
        .copy_m_f32(cell_count)
        .expect("roundtrip copy m f32");

    for (index, is_active) in active_mask.iter().enumerate() {
        let expected = if *is_active {
            upload[index]
        } else {
            [0.0, 0.0, 0.0]
        };
        for component in 0..3 {
            let diff = (roundtrip[index][component] - expected[component]).abs();
            assert!(
                diff <= 1e-6,
                "roundtrip mismatch at cell {index} component {component}: actual={} expected={}",
                roundtrip[index][component],
                expected[component]
            );
        }
    }
}

#[test]
fn native_fdm_thin_film_demag_matches_cpu_reference_when_cuda_is_available() {
    if !is_cuda_available() {
        eprintln!(
                "skipping native CUDA FDM thin-film demag parity test: CUDA backend is not available on this host"
            );
        return;
    }

    let plan = make_thin_film_demag_plan();
    let cell_count = plan.initial_magnetization.len();
    let (
        expected_m,
        expected_h_ex,
        expected_h_demag,
        expected_h_ext,
        _expected_h_ani,
        expected_h_eff,
        expected_report,
    ) = cpu_reference_single_step(&plan);

    let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
    let stats = backend
        .step(plan.fixed_timestep.expect("fixed dt"))
        .expect("native fdm step");
    let actual_m = backend.copy_m(cell_count).expect("copy m");
    let actual_h_ex = backend.copy_h_ex(cell_count).expect("copy H_ex");
    let actual_h_demag = backend.copy_h_demag(cell_count).expect("copy H_demag");
    let actual_h_ext = backend.copy_h_ext(cell_count).expect("copy H_ext");
    let actual_h_eff = backend.copy_h_eff(cell_count).expect("copy H_eff");

    assert_vector_field_close("thin.m", &actual_m, &expected_m, 5e-6, 1e-8);
    assert_vector_field_close("thin.H_ex", &actual_h_ex, &expected_h_ex, 5e-5, 5e-2);
    assert_vector_field_close(
        "thin.H_demag",
        &actual_h_demag,
        &expected_h_demag,
        5e-4,
        1e-1,
    );
    assert_vector_field_close("thin.H_ext", &actual_h_ext, &expected_h_ext, 1e-12, 1e-12);
    assert_vector_field_close("thin.H_eff", &actual_h_eff, &expected_h_eff, 5e-4, 1e-1);

    assert_scalar_close(
        "thin.exchange_energy",
        stats.e_ex,
        expected_report.exchange_energy_joules,
        5e-5,
        1e-21,
    );
    assert_scalar_close(
        "thin.demag_energy",
        stats.e_demag,
        expected_report.demag_energy_joules,
        5e-4,
        1e-21,
    );
    assert_scalar_close(
        "thin.external_energy",
        stats.e_ext,
        expected_report.external_energy_joules,
        5e-6,
        1e-21,
    );
    assert_scalar_close(
        "thin.total_energy",
        stats.e_total,
        expected_report.total_energy_joules,
        5e-4,
        1e-21,
    );
}

#[test]
fn native_fdm_periodic_truncated_demag_matches_cpu_reference_when_cuda_is_available() {
    if !is_cuda_available() {
        eprintln!(
                "skipping native CUDA FDM periodic demag parity test: CUDA backend is not available on this host"
            );
        return;
    }

    let mut plan = make_thin_film_demag_plan();
    plan.periodicity = Some(FdmPeriodicityIR {
        axes: [
            AxisBoundary::Periodic,
            AxisBoundary::Periodic,
            AxisBoundary::Open,
        ],
        demag: FdmDemagPeriodicityIR::TruncatedImages,
        image_counts: Some([2, 2, 0]),
    });
    let cell_count = plan.initial_magnetization.len();
    let (
        expected_m,
        _expected_h_ex,
        expected_h_demag,
        _expected_h_ext,
        _expected_h_ani,
        _expected_h_eff,
        expected_report,
    ) = cpu_reference_single_step(&plan);

    let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
    let stats = backend
        .step(plan.fixed_timestep.expect("fixed dt"))
        .expect("native fdm step");
    let actual_m = backend.copy_m(cell_count).expect("copy m");
    let actual_h_demag = backend.copy_h_demag(cell_count).expect("copy H_demag");

    assert_vector_field_close("periodic_demag.m", &actual_m, &expected_m, 5e-6, 1e-8);
    assert_vector_field_close(
        "periodic_demag.H_demag",
        &actual_h_demag,
        &expected_h_demag,
        1e-3,
        1e-1,
    );
    assert_scalar_close(
        "periodic_demag.demag_energy",
        stats.e_demag,
        expected_report.demag_energy_joules,
        1e-3,
        1e-21,
    );
}

#[test]
fn native_fdm_periodic_exchange_matches_cpu_reference_when_cuda_is_available() {
    if !is_cuda_available() {
        eprintln!(
                "skipping native CUDA FDM periodic exchange parity test: CUDA backend is not available on this host"
            );
        return;
    }

    let mut plan = make_thin_film_demag_plan();
    plan.enable_demag = false;
    plan.periodicity = Some(FdmPeriodicityIR {
        axes: [
            AxisBoundary::Periodic,
            AxisBoundary::Periodic,
            AxisBoundary::Open,
        ],
        demag: FdmDemagPeriodicityIR::Open,
        image_counts: None,
    });
    let cell_count = plan.initial_magnetization.len();
    let (
        expected_m,
        expected_h_ex,
        _expected_h_demag,
        expected_h_ext,
        _expected_h_ani,
        expected_h_eff,
        expected_report,
    ) = cpu_reference_single_step(&plan);

    let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
    let stats = backend
        .step(plan.fixed_timestep.expect("fixed dt"))
        .expect("native fdm step");
    let actual_m = backend.copy_m(cell_count).expect("copy m");
    let actual_h_ex = backend.copy_h_ex(cell_count).expect("copy H_ex");
    let actual_h_ext = backend.copy_h_ext(cell_count).expect("copy H_ext");
    let actual_h_eff = backend.copy_h_eff(cell_count).expect("copy H_eff");

    assert_vector_field_close("periodic_exchange.m", &actual_m, &expected_m, 5e-6, 1e-8);
    assert_vector_field_close(
        "periodic_exchange.H_ex",
        &actual_h_ex,
        &expected_h_ex,
        5e-5,
        5e-2,
    );
    assert_vector_field_close(
        "periodic_exchange.H_ext",
        &actual_h_ext,
        &expected_h_ext,
        1e-12,
        1e-12,
    );
    assert_vector_field_close(
        "periodic_exchange.H_eff",
        &actual_h_eff,
        &expected_h_eff,
        5e-5,
        5e-2,
    );
    assert_scalar_close(
        "periodic_exchange.exchange_energy",
        stats.e_ex,
        expected_report.exchange_energy_joules,
        5e-5,
        1e-21,
    );
}

#[test]
fn native_fdm_relaxation_disables_precession_when_cuda_is_available() {
    if !is_cuda_available() {
        eprintln!(
            "skipping native CUDA FDM relaxation test: CUDA backend is not available on this host"
        );
        return;
    }

    let plan = make_relaxation_precession_test_plan();
    let cell_count = plan.initial_magnetization.len();
    let (expected_m, _, _, _, _, _, expected_report) = cpu_reference_single_step(&plan);

    let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
    let stats = backend
        .step(plan.fixed_timestep.expect("fixed dt"))
        .expect("native fdm step");
    let actual_m = backend.copy_m(cell_count).expect("copy m");

    assert_vector_field_close("relax.m", &actual_m, &expected_m, 5e-6, 1e-10);
    assert!(
        actual_m[0][1].abs() <= 1e-10,
        "relaxation should not precess into y, got {:?}",
        actual_m[0]
    );
    assert!(
        actual_m[0][2] > 0.0,
        "relaxation should move toward +z field, got {:?}",
        actual_m[0]
    );
    assert_scalar_close(
        "relax.max_rhs",
        stats.max_dm_dt,
        expected_report.max_rhs_amplitude,
        5e-6,
        1e-10,
    );
}
