use super::*;
use fullmag_engine::fem::{FemLlgProblem, FemLlgState, MeshTopology};
use fullmag_engine::{EffectiveFieldTerms, LlgConfig, MaterialParameters, TimeIntegrator};
use fullmag_ir::{
    AdaptiveTimeStepIR, AirBoxConfigIR, ExchangeBoundaryCondition, ExecutionPrecision, FemPlanIR,
    IntegratorChoice, MaterialIR, MeshIR, MeshPeriodicBoundaryPairIR, MeshPeriodicNodePairIR,
    RelaxStopIR, RelaxationAlgorithmIR, RelaxationControlIR, ResolvedFemDemagIR,
};

mod native_source_contracts;
mod parity;
mod plan_contracts;
mod runtime_smoke;

fn make_test_plan() -> FemPlanIR {
    FemPlanIR {
        mesh_name: "unit_tet".to_string(),
        mesh_source: Some("meshes/unit_tet.msh".to_string()),
        mesh: MeshIR {
            mesh_name: "unit_tet".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            elements: vec![[0, 1, 2, 3]],
            element_markers: vec![1],
            boundary_faces: vec![[0, 1, 2]],
            boundary_markers: vec![1],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        },
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        mesh_build_report: None,
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 0.4,
        initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
        material: MaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 800e3,
            exchange_stiffness: 13e-12,
            damping: 0.5,
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
        external_field: Some([1.0, 2.0, 3.0]),
        current_modules: vec![],
        spin_transport_plans: vec![],
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
        dmi_interface_normal: None,
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
        use_consistent_mass: None,
    }
}
fn make_exchange_only_plan() -> FemPlanIR {
    FemPlanIR {
        mesh_name: "two_tets".to_string(),
        mesh_source: Some("meshes/two_tets.msh".to_string()),
        mesh: MeshIR {
            mesh_name: "two_tets".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 1.0, 0.0],
            ],
            elements: vec![[0, 1, 2, 3], [1, 4, 2, 3]],
            element_markers: vec![1, 1],
            boundary_faces: vec![
                [0, 1, 2],
                [0, 1, 3],
                [0, 2, 3],
                [1, 4, 2],
                [1, 4, 3],
                [4, 2, 3],
            ],
            boundary_markers: vec![1; 6],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        },
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        mesh_build_report: None,
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 1.0,
        initial_magnetization: vec![
            [1.0, 0.0, 0.0],
            [0.9992009587217894, 0.03996803834887158, 0.0],
            [0.996815278536125, 0.07974522228289, 0.0],
            [0.992876838486922, 0.11914522061843064, 0.0],
            [0.9874406319167053, 0.15799050110667284, 0.0],
        ],
        material: MaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 800e3,
            exchange_stiffness: 13e-12,
            damping: 0.1,
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
        external_field: Some([1.5e3, -2.0e3, 7.5e2]),
        current_modules: vec![],
        spin_transport_plans: vec![],
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: IntegratorChoice::Heun,
        fixed_timestep: Some(2.5e-13),
        adaptive_timestep: None,
        field_refresh: None,
        relaxation: None,
        demag_realization: None,
        air_box_config: None,
        interfacial_dmi: None,
        dmi_interface_normal: None,
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
        use_consistent_mass: None,
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

fn vector_field_error_norms(actual: &[[f64; 3]], expected: &[[f64; 3]]) -> (f64, f64) {
    assert_eq!(actual.len(), expected.len(), "field length mismatch");
    let mut sum_sq = 0.0;
    let mut linf = 0.0;
    for (a, e) in actual.iter().zip(expected.iter()) {
        for component in 0..3 {
            let diff = (a[component] - e[component]).abs();
            sum_sq += diff * diff;
            if diff > linf {
                linf = diff;
            }
        }
    }
    (sum_sq.sqrt(), linf)
}

fn assert_vector_field_parity(
    label: &str,
    cpu: &[[f64; 3]],
    gpu: &[[f64; 3]],
    rel_tol: f64,
    abs_tol: f64,
) {
    let (l2, linf) = vector_field_error_norms(gpu, cpu);
    assert_vector_field_close(label, gpu, cpu, rel_tol, abs_tol);
    eprintln!("{label} CPU/GPU parity: L2={l2:.6e} Linf={linf:.6e}");
}

fn native_cpu_gpu_parity_available(require_full_demag: bool) -> bool {
    let availability = native_availability();
    let available = availability.native_fem_cpu_available
        && availability.native_fem_gpu_available
        && (!require_full_demag || availability.native_fem_gpu_full_demag_available);
    if !available {
        eprintln!(
                "skipping native FEM CPU/GPU parity test: cpu={} gpu={} full_demag={} mfem_stack={} cuda_runtime={}",
                availability.native_fem_cpu_available,
                availability.native_fem_gpu_available,
                availability.native_fem_gpu_full_demag_available,
                availability.built_with_mfem_stack,
                availability.built_with_cuda_runtime
            );
    }
    available
}

fn native_plan_for_device(plan: &FemPlanIR, device: &str) -> FemPlanIR {
    let mut copy = plan.clone();
    copy.mfem_device_string = Some(device.to_string());
    copy
}

struct NativeParityStep {
    m: Vec<[f64; 3]>,
    h_ex: Vec<[f64; 3]>,
    h_demag: Vec<[f64; 3]>,
    h_eff: Vec<[f64; 3]>,
    stats: StepStats,
    device_name: String,
}

fn run_native_parity_step(plan: &FemPlanIR) -> NativeParityStep {
    let mut backend = NativeFemBackend::create(plan).expect("native fem parity create");
    let stats = backend
        .step(
            crate::resolve_initial_timestep(plan.fixed_timestep, plan.adaptive_timestep.as_ref())
                .expect("parity plan timestep"),
        )
        .expect("native fem parity step");
    let node_count = plan.mesh.nodes.len();
    let device_name = backend.device_info().expect("device info").name;
    NativeParityStep {
        m: backend.copy_m(node_count).expect("copy m"),
        h_ex: backend.copy_h_ex(node_count).expect("copy H_ex"),
        h_demag: backend.copy_h_demag(node_count).expect("copy H_demag"),
        h_eff: backend.copy_h_eff(node_count).expect("copy H_eff"),
        stats,
        device_name,
    }
}

fn assert_same_parity_mesh(cpu_plan: &FemPlanIR, gpu_plan: &FemPlanIR) {
    assert_eq!(cpu_plan.mesh.mesh_name, gpu_plan.mesh.mesh_name);
    assert_eq!(cpu_plan.mesh.nodes, gpu_plan.mesh.nodes);
    assert_eq!(cpu_plan.mesh.elements, gpu_plan.mesh.elements);
    assert_eq!(cpu_plan.precision, ExecutionPrecision::Double);
    assert_eq!(gpu_plan.precision, ExecutionPrecision::Double);
}

fn with_poisson_demag(mut plan: FemPlanIR) -> FemPlanIR {
    plan.enable_demag = true;
    plan.demag_realization = Some(ResolvedFemDemagIR::PoissonRobin);
    plan.air_box_config = Some(AirBoxConfigIR {
        factor: 1.5,
        grading: 1.0,
        boundary_marker: 99,
        bc_kind: Some("robin".to_string()),
        robin_beta_mode: Some("legacy".to_string()),
        robin_beta_factor: None,
        shape: Some("bbox".to_string()),
        factor_source: Some("parity_fixture".to_string()),
        boundary_marker_source: Some("parity_fixture".to_string()),
    });
    plan
}

fn with_adaptive_dt(mut plan: FemPlanIR) -> FemPlanIR {
    plan.fixed_timestep = None;
    plan.adaptive_timestep = Some(AdaptiveTimeStepIR {
        atol: 1e-8,
        rtol: 1e-5,
        dt_initial: Some(2.5e-13),
        dt_min: 1e-16,
        dt_max: Some(1e-12),
        safety: 0.9,
        growth_limit: 2.0,
        shrink_limit: 0.5,
        max_spin_rotation: None,
        norm_tolerance: None,
    });
    plan
}

fn cpu_reference_single_step(
    plan: &FemPlanIR,
) -> (
    Vec<[f64; 3]>,
    Vec<[f64; 3]>,
    Vec<[f64; 3]>,
    fullmag_engine::StepReport,
) {
    let topology = MeshTopology::from_ir(&plan.mesh).expect("topology");
    let material = MaterialParameters::new(
        plan.material.saturation_magnetisation,
        plan.material.exchange_stiffness,
        plan.material.damping,
    )
    .expect("material");
    let dynamics = LlgConfig::new(plan.gyromagnetic_ratio, TimeIntegrator::Heun).expect("dynamics");
    let problem = FemLlgProblem::with_terms(
        topology,
        material,
        dynamics,
        EffectiveFieldTerms {
            exchange: plan.enable_exchange,
            demag: plan.enable_demag,
            external_field: plan.external_field,
            per_node_field: plan.oersted_field_xyz.as_ref().map(|field_xyz| {
                field_xyz
                    .chunks_exact(3)
                    .map(|chunk| [chunk[0], chunk[1], chunk[2]])
                    .collect()
            }),
            magnetoelastic: None,
            uniaxial_anisotropy: None,
            cubic_anisotropy: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            zhang_li_stt: if has_zhang_li_stt(plan) {
                Some(fullmag_engine::ZhangLiSttConfig {
                    current_density: plan.current_density.expect("current density"),
                    spin_polarization: plan.stt_degree.expect("stt degree"),
                    non_adiabaticity: plan.stt_beta.unwrap_or(0.0),
                })
            } else {
                None
            },
            slonczewski_stt: if has_slonczewski_stt(plan) {
                Some(fullmag_engine::SlonczewskiSttConfig {
                    formula: fullmag_engine::SlonczewskiFormula::LegacyFullmagV0,
                    current_density_magnitude: {
                        let j = plan.current_density.expect("current density");
                        (j[0] * j[0] + j[1] * j[1] + j[2] * j[2]).sqrt()
                    },
                    spin_polarization_axis: plan
                        .stt_spin_polarization
                        .expect("stt spin polarization"),
                    lambda: plan.stt_lambda.expect("stt lambda"),
                    epsilon_prime: plan.stt_epsilon_prime.unwrap_or(0.0),
                    degree: plan.stt_degree.expect("stt degree"),
                    thickness: plan
                        .stt_thickness
                        .unwrap_or_else(|| effective_magnetic_thickness(&plan.mesh)),
                    current_sign: match plan.stt_fixed_layer_position.as_deref().unwrap_or("top") {
                        "bottom" => -1.0,
                        _ => 1.0,
                    },
                })
            } else {
                None
            },
            sot: None,
            oersted_cylinder: None,
        },
    );
    let mut state =
        FemLlgState::new(&problem.topology, plan.initial_magnetization.clone()).expect("state");
    let report = problem
        .step(&mut state, plan.fixed_timestep.expect("fixed dt"))
        .expect("cpu fem step");
    let observables = problem.observe(&state).expect("observe");
    (
        state.magnetization().to_vec(),
        observables.exchange_field,
        observables.effective_field,
        report,
    )
}

fn effective_magnetic_thickness(mesh: &MeshIR) -> f64 {
    let (min_z, max_z) = mesh.nodes.iter().fold(
        (f64::INFINITY, f64::NEG_INFINITY),
        |(min_z, max_z), node| (min_z.min(node[2]), max_z.max(node[2])),
    );
    (max_z - min_z).abs().max(1e-12)
}
