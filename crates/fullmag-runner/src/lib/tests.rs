use super::*;
use fullmag_ir::{
    CurrentModuleIR, CurrentTransportModelIR, ExchangeBoundaryCondition, ExecutionPrecision,
    FdmMaterialIR, GridDimensions, IntegratorChoice, MeshIR,
};
#[cfg(feature = "cuda")]
use fullmag_ir::{FdmGridAssetIR, GeometryAssetsIR, GeometryEntryIR};
use serde_json::json;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn fem_relaxation_entrypoints_route_through_fem_relax_module() {
    let source = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("read lib.rs");
    let route_count = source.matches("fem::relax::execute_fem_relax(").count()
        + source
            .matches("fem::relax::execute_fem_relax_with_context(")
            .count();
    assert!(
            route_count >= 3,
            "run entrypoints should route FEM relaxation through fem::relax::execute_fem_relax, found {route_count}"
        );
}

#[test]
fn fem_relaxation_vector_math_is_owned_by_relax_module() {
    let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
        .expect("read dispatch.rs");
    assert!(
        !dispatch.contains("fn tangent_gradient_from_field("),
        "dispatch.rs must not own FEM direct-minimizer tangent-gradient math"
    );
    assert!(
        !dispatch.contains("fn project_tangent("),
        "dispatch.rs must not own FEM direct-minimizer tangent projection"
    );
    assert!(
        !dispatch.contains("fn max_torque_from_field("),
        "dispatch.rs must not own FEM direct-minimizer torque math"
    );
    assert!(
        !dispatch.contains("use crate::fem::relax::vector_math"),
        "dispatch.rs must not route shared FDM/FEM direct-minimizer math through the FEM module"
    );

    let vector_math = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/relaxation/vector_math.rs"
    ))
    .expect("read relaxation/vector_math.rs");
    for symbol in [
        "pub(crate) fn tangent_gradient_from_field(",
        "pub(crate) fn project_tangent(",
        "pub(crate) fn max_torque_from_field(",
    ] {
        assert!(
            vector_math.contains(symbol),
            "relaxation_vector_math.rs must own {symbol}"
        );
    }
}

#[test]
fn direct_minimizer_algorithm_policy_is_owned_by_relaxation_module() {
    let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
        .expect("read dispatch.rs");
    assert!(
        !dispatch.contains("let direct_minimization_relax = plan.relaxation.as_ref().filter"),
        "dispatch.rs must not own direct-minimizer algorithm classification"
    );
    assert!(
        !dispatch.contains("let lambda_min: f64 = 1e-15;"),
        "dispatch.rs must not own shared direct-minimizer step-size constants"
    );

    let module = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/relaxation/direct_minimizer.rs"
    ))
    .expect("read relaxation/direct_minimizer.rs");
    for symbol in [
        "pub(crate) fn direct_minimizer_control(",
        "pub(crate) fn initial_search_direction(",
        "pub(crate) const DEFAULT_STEP_SIZE",
        "pub(crate) const MIN_STEP_SIZE",
        "pub(crate) const MAX_STEP_SIZE",
    ] {
        assert!(
            module.contains(symbol),
            "relaxation_direct_minimizer.rs must own {symbol}"
        );
    }
}

#[test]
fn direct_minimizer_state_update_math_is_owned_by_relaxation_module() {
    let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
        .expect("read dispatch.rs");
    assert!(
        !dispatch.contains("let scale_factor = 1e-6;"),
        "dispatch.rs must not own Barzilai-Borwein direct-minimizer scaling policy"
    );
    assert!(
        !dispatch.contains("NONLINEAR_CG_RESTART_INTERVAL"),
        "dispatch.rs must not own nonlinear-CG restart policy"
    );

    let module = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/relaxation/direct_minimizer.rs"
    ))
    .expect("read relaxation/direct_minimizer.rs");
    for symbol in [
        "pub(crate) fn projected_gradient_step_size_update(",
        "pub(crate) fn nonlinear_cg_initial_step_size(",
        "pub(crate) fn nonlinear_cg_next_direction(",
    ] {
        assert!(
            module.contains(symbol),
            "relaxation_direct_minimizer.rs must own {symbol}"
        );
    }
}

#[test]
fn direct_minimizer_step_metrics_are_owned_by_relaxation_module() {
    let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
        .expect("read dispatch.rs");
    assert!(
        !dispatch.contains("accepted_stats.max_dm_dt = 0.0"),
        "dispatch.rs must not stamp direct-minimizer dm/dt metrics in backend branches"
    );
    assert!(
        !dispatch.contains("accepted_stats.max_h_eff = h_eff"),
        "dispatch.rs must not duplicate direct-minimizer effective-field metrics"
    );

    let module = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/relaxation/direct_minimizer.rs"
    ))
    .expect("read relaxation/direct_minimizer.rs");
    assert!(
        module.contains("pub(crate) fn apply_direct_minimizer_step_metrics("),
        "relaxation_direct_minimizer.rs must own direct-minimizer StepStats metric stamping"
    );
}

#[test]
fn direct_minimizer_trial_projection_is_owned_by_relaxation_module() {
    let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
        .expect("read dispatch.rs");
    assert!(
        !dispatch.contains("normalized_vec3(sub_vec3("),
        "dispatch.rs must not own projected-gradient trial magnetization projection"
    );
    assert!(
        !dispatch.contains("normalized_vec3(add_vec3("),
        "dispatch.rs must not own nonlinear-CG trial magnetization projection"
    );

    let module = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/relaxation/direct_minimizer.rs"
    ))
    .expect("read relaxation/direct_minimizer.rs");
    for symbol in [
        "pub(crate) fn projected_gradient_trial_magnetization(",
        "pub(crate) fn nonlinear_cg_trial_magnetization(",
    ] {
        assert!(
            module.contains(symbol),
            "relaxation_direct_minimizer.rs must own {symbol}"
        );
    }
}

#[test]
fn direct_minimizer_armijo_policy_is_owned_by_relaxation_module() {
    let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
        .expect("read dispatch.rs");
    assert!(
        !dispatch.contains("energy - ARMIJO_COEFFICIENT"),
        "dispatch.rs must not own projected-gradient Armijo acceptance policy"
    );
    assert!(
        !dispatch.contains("energy + ARMIJO_COEFFICIENT"),
        "dispatch.rs must not own nonlinear-CG Armijo acceptance policy"
    );

    let module = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/relaxation/direct_minimizer.rs"
    ))
    .expect("read relaxation/direct_minimizer.rs");
    for symbol in [
        "pub(crate) fn projected_gradient_armijo_accepts(",
        "pub(crate) fn nonlinear_cg_armijo_accepts(",
    ] {
        assert!(
            module.contains(symbol),
            "relaxation_direct_minimizer.rs must own {symbol}"
        );
    }
}

#[test]
fn direct_minimizer_backtracking_policy_is_owned_by_relaxation_module() {
    let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
        .expect("read dispatch.rs");
    assert!(
        !dispatch.contains("trial_lambda *= 0.5"),
        "dispatch.rs must not own direct-minimizer backtrack step-size reduction"
    );
    assert!(
        !dispatch.contains("PROJECTED_GRADIENT_MAX_BACKTRACK"),
        "dispatch.rs must not own projected-gradient max-backtrack policy"
    );
    assert!(
        !dispatch.contains("NONLINEAR_CG_MAX_BACKTRACK"),
        "dispatch.rs must not own nonlinear-CG max-backtrack policy"
    );

    let module = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/relaxation/direct_minimizer.rs"
    ))
    .expect("read relaxation/direct_minimizer.rs");
    for symbol in [
        "pub(crate) fn backtracked_step_size(",
        "pub(crate) fn direct_minimizer_backtrack_exhausted(",
    ] {
        assert!(
            module.contains(symbol),
            "relaxation_direct_minimizer.rs must own {symbol}"
        );
    }
}

#[test]
fn direct_minimizer_nonlinear_cg_descent_reset_is_owned_by_relaxation_module() {
    let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
        .expect("read dispatch.rs");
    assert!(
        !dispatch.contains("p_dot_g >= 0.0"),
        "dispatch.rs must not own nonlinear-CG descent-direction reset policy"
    );

    let module = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/relaxation/direct_minimizer.rs"
    ))
    .expect("read relaxation/direct_minimizer.rs");
    assert!(
        module.contains("pub(crate) fn nonlinear_cg_descent_direction_dot("),
        "relaxation_direct_minimizer.rs must own nonlinear-CG descent-direction reset policy"
    );
}

#[test]
fn direct_minimizer_gradient_degeneracy_is_owned_by_relaxation_module() {
    let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
        .expect("read dispatch.rs");
    assert!(
        !dispatch.contains("g_norm_sq < 1e-30"),
        "dispatch.rs must not own direct-minimizer gradient-degeneracy policy"
    );

    let module = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/relaxation/direct_minimizer.rs"
    ))
    .expect("read relaxation/direct_minimizer.rs");
    for symbol in [
        "pub(crate) fn direct_minimizer_gradient_norm_sq(",
        "pub(crate) fn direct_minimizer_gradient_degenerate(",
    ] {
        assert!(
            module.contains(symbol),
            "relaxation_direct_minimizer.rs must own {symbol}"
        );
    }
}

#[test]
fn direct_minimizer_step_budget_is_owned_by_relaxation_module() {
    let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
        .expect("read dispatch.rs");
    assert!(
        !dispatch.contains("direct_step < control.stop.max_steps.unwrap_or(u64::MAX)"),
        "dispatch.rs must not own direct-minimizer step-budget fallback policy"
    );

    let module = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/relaxation/direct_minimizer.rs"
    ))
    .expect("read relaxation/direct_minimizer.rs");
    assert!(
        module.contains("pub(crate) fn direct_minimizer_step_budget("),
        "relaxation_direct_minimizer.rs must own direct-minimizer step-budget fallback policy"
    );
}

#[test]
fn direct_minimizer_line_search_is_owned_by_relaxation_module() {
    let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
        .expect("read dispatch.rs");
    assert!(
        !dispatch.contains("let (trial_stats, m_trial) = loop"),
        "dispatch.rs must not own direct-minimizer trial line-search loops"
    );
    assert!(
        !dispatch.contains("backtracked_step_size(trial_lambda)"),
        "dispatch.rs must not own direct-minimizer trial backtracking updates"
    );

    let module = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/relaxation/direct_minimizer.rs"
    ))
    .expect("read relaxation/direct_minimizer.rs");
    for symbol in [
        "pub(crate) fn projected_gradient_line_search<",
        "pub(crate) fn nonlinear_cg_line_search<",
    ] {
        assert!(
            module.contains(symbol),
            "relaxation/direct_minimizer.rs must own {symbol}"
        );
    }
}

#[test]
fn direct_minimizer_iteration_state_is_owned_by_relaxation_module() {
    let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
        .expect("read dispatch.rs");
    assert!(
        !dispatch.contains("let mut p = initial_search_direction(&g);"),
        "dispatch.rs must not own direct-minimizer initial search-direction state"
    );
    assert!(
        !dispatch.contains("let mut use_bb1 = true;"),
        "dispatch.rs must not own projected-gradient BB toggle initialization"
    );
    assert!(
        !dispatch.contains("let mut reset_consecutive: u64 = 0;"),
        "dispatch.rs must not own projected-gradient reset counter initialization"
    );
    assert!(
        !dispatch.contains("let mut direct_step: u64 = 0;"),
        "dispatch.rs must not own direct-minimizer accepted-step initialization"
    );

    let module = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/relaxation/direct_minimizer.rs"
    ))
    .expect("read relaxation/direct_minimizer.rs");
    assert!(
        module.contains("pub(crate) struct DirectMinimizerState"),
        "relaxation/direct_minimizer.rs must own direct-minimizer iteration state"
    );
    assert!(
        module.contains("impl DirectMinimizerState"),
        "DirectMinimizerState must own its initialization behavior"
    );
}

#[test]
fn fem_direct_minimizer_loop_is_owned_by_fem_relax_module() {
    let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
        .expect("read dispatch.rs");
    assert!(
        !dispatch.contains("DirectMinimizerState::new(\n            backend.copy_m(node_count)?"),
        "dispatch.rs must not own the native FEM direct-minimizer execution loop"
    );

    let module = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/fem/relax/direct_minimizer.rs"
    ))
    .expect("read fem/relax/direct_minimizer.rs");
    assert!(
        module.contains("pub(crate) fn execute_direct_minimizer"),
        "fem/relax/direct_minimizer.rs must own FEM direct-minimizer execution"
    );
}

#[test]
fn fem_llg_loop_is_owned_by_fem_relax_module() {
    let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
        .expect("read dispatch.rs");
    assert!(
        !dispatch.contains("[fullmag-runner] native-fem LLG loop:"),
        "dispatch.rs must not own the native FEM LLG time-stepping loop"
    );

    let module = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/fem/relax/llg_overdamped.rs"
    ))
    .expect("read fem/relax/llg_overdamped.rs");
    assert!(
        module.contains("pub(crate) fn execute_llg_overdamped"),
        "fem/relax/llg_overdamped.rs must own FEM LLG time-stepping execution"
    );
}

#[test]
fn fem_relaxation_finalization_is_owned_by_fem_relax_module() {
    let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
        .expect("read dispatch.rs");
    assert!(
        !dispatch.contains("Flush a final cached-preview update"),
        "dispatch.rs must not own native FEM relaxation final cached-preview flushing"
    );
    assert!(
        !dispatch.contains("let completion = if let Some(mut completion) = backend_completion"),
        "dispatch.rs must not own native FEM relaxation completion inference"
    );

    let module = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/fem/relax/finalize.rs"
    ))
    .expect("read fem/relax/finalize.rs");
    assert!(
        module.contains("pub(crate) fn finalize_native_fem_relaxation"),
        "fem/relax/finalize.rs must own native FEM relaxation finalization"
    );
}

#[test]
fn fem_cached_preview_helpers_are_owned_by_fem_relax_module() {
    let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
        .expect("read dispatch.rs");
    assert!(
        !dispatch.contains("pub(crate) fn build_fem_cached_preview_fields"),
        "dispatch.rs must not own native FEM relaxation cached-preview helpers"
    );

    let module = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/fem/relax/preview.rs"
    ))
    .expect("read fem/relax/preview.rs");
    assert!(
        module.contains("pub(crate) fn build_fem_cached_preview_fields"),
        "fem/relax/preview.rs must own native FEM relaxation cached-preview helpers"
    );
}

#[test]
fn fem_field_snapshot_helpers_are_owned_by_fem_relax_module() {
    let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
        .expect("read dispatch.rs");
    assert!(
        !dispatch.contains("pub(crate) fn copy_native_fem_field_snapshot"),
        "dispatch.rs must not own native FEM relaxation field snapshot helpers"
    );

    let module = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/fem/relax/snapshots.rs"
    ))
    .expect("read fem/relax/snapshots.rs");
    assert!(
        module.contains("pub(crate) fn copy_native_fem_field_snapshot"),
        "fem/relax/snapshots.rs must own native FEM relaxation field snapshot helpers"
    );
}

#[test]
fn fem_object_scalar_helpers_are_owned_by_fem_relax_module() {
    let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
        .expect("read dispatch.rs");
    assert!(
        !dispatch.contains("pub(crate) fn ensure_fem_object_scalars"),
        "dispatch.rs must not own native FEM relaxation object-scalar helpers"
    );

    let module = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/fem/relax/scalars.rs"
    ))
    .expect("read fem/relax/scalars.rs");
    assert!(
        module.contains("pub(crate) fn ensure_fem_object_scalars"),
        "fem/relax/scalars.rs must own native FEM relaxation object-scalar helpers"
    );
}

#[test]
fn shared_relaxation_helpers_live_under_relaxation_module_directory() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let root_direct_minimizer =
        std::path::Path::new(manifest_dir).join("src/relaxation_direct_minimizer.rs");
    let root_vector_math = std::path::Path::new(manifest_dir).join("src/relaxation_vector_math.rs");
    assert!(
        !root_direct_minimizer.exists(),
        "shared direct-minimizer policy must live under src/relaxation/"
    );
    assert!(
        !root_vector_math.exists(),
        "shared relaxation vector math must live under src/relaxation/"
    );
    assert!(
        std::path::Path::new(manifest_dir)
            .join("src/relaxation/direct_minimizer.rs")
            .exists(),
        "src/relaxation/direct_minimizer.rs must own shared direct-minimizer policy"
    );
    assert!(
        std::path::Path::new(manifest_dir)
            .join("src/relaxation/vector_math.rs")
            .exists(),
        "src/relaxation/vector_math.rs must own shared relaxation vector math"
    );

    let lib = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("read lib.rs");
    assert!(
        lib.contains("#[path = \"relaxation/direct_minimizer.rs\"]"),
        "lib.rs must keep the shared direct-minimizer alias pointed at src/relaxation/"
    );
    assert!(
        lib.contains("#[path = \"relaxation/vector_math.rs\"]"),
        "lib.rs must keep the shared vector-math alias pointed at src/relaxation/"
    );
}

fn make_test_plan() -> FdmPlanIR {
    FdmPlanIR {
        grid: GridDimensions { cells: [4, 4, 1] },
        cell_size: [2e-9, 2e-9, 2e-9],
        region_mask: vec![0; 16],
        active_mask: None,
        initial_magnetization: vec![[1.0, 0.0, 0.0]; 16],
        material: FdmMaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 800e3,
            exchange_stiffness: 13e-12,
            damping: 0.5,
            ..Default::default()
        },
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: IntegratorChoice::Heun,
        fixed_timestep: Some(1e-14),
        adaptive_timestep: None,
        relaxation: None,
        boundary_correction: None,
        boundary_geometry: None,
        inter_region_exchange: vec![],
        enable_exchange: true,
        enable_demag: false,
        external_field: None,
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
        oersted_realization: None,
        temperature: None,
        interfacial_dmi: None,
        bulk_dmi: None,
        ..Default::default()
    }
}

#[test]
fn uniform_relaxation_produces_stable_energy() {
    let plan = make_test_plan();
    let result = run_reference_fdm(&plan, 1e-12, &[]).expect("run should succeed");

    assert_eq!(result.status, RunStatus::Completed);
    assert!(!result.steps.is_empty());
    for step in &result.steps {
        assert!(
            step.e_ex.abs() < 1e-30,
            "uniform m should have zero exchange energy, got {}",
            step.e_ex
        );
    }
}

#[test]
fn default_cpu_threads_uses_all_available() {
    let expected = std::thread::available_parallelism()
        .map(|parallelism| parallelism.get())
        .unwrap_or(1);
    assert_eq!(default_cpu_threads(), expected);
}

#[test]
fn configured_cpu_threads_prefers_runtime_override() {
    let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
    problem.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        json!({
            "cpu_threads": 7,
        }),
    );
    assert_eq!(configured_cpu_threads(&problem), 7);
}

#[cfg(feature = "cuda")]
#[test]
fn imported_geometry_fdm_cuda_matches_cpu_reference_when_cuda_is_available() {
    if !native_fdm::is_cuda_available() {
        eprintln!(
                "skipping imported-geometry CUDA parity test: CUDA backend is not available on this host"
            );
        return;
    }

    let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
    problem.geometry.entries = vec![GeometryEntryIR::ImportedGeometry {
        name: "mesh".to_string(),
        source: "examples/nanoflower.stl".to_string(),
        format: "stl".to_string(),
        scale: fullmag_ir::ImportedGeometryScaleIR::Uniform(1.0),
    }];
    problem.regions[0].geometry = "mesh".to_string();
    problem.geometry_assets = Some(GeometryAssetsIR {
        fdm_grid_assets: vec![FdmGridAssetIR {
            geometry_name: "mesh".to_string(),
            cells: [4, 2, 1],
            cell_size: [2e-9, 2e-9, 2e-9],
            origin: [-4e-9, -2e-9, -1e-9],
            active_mask: vec![true, true, true, true, false, false, false, false],
        }],
        fem_mesh_assets: vec![],
        fem_domain_mesh_asset: None,
    });
    problem.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::Auto,
        },
    ];
    problem.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        json!({
            "backend": "fdm",
            "device": "cuda",
            "gpu_count": 1,
            "execution_mode": "strict",
            "execution_precision": "double",
        }),
    );

    let plan = fullmag_plan::plan(&problem).expect("plan imported geometry");
    let BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
        panic!("expected FDM plan");
    };

    let cpu = dispatch::execute_fdm(
        dispatch::FdmEngine::CpuReference,
        fdm,
        2e-13,
        &plan.output_plan.outputs,
        None,
        None,
    )
    .expect("cpu run");
    let cuda = dispatch::execute_fdm(
        dispatch::FdmEngine::CudaFdm,
        fdm,
        2e-13,
        &plan.output_plan.outputs,
        None,
        None,
    )
    .expect("cuda run");

    let cpu_final = cpu.result.steps.last().expect("cpu final step");
    let cuda_final = cuda.result.steps.last().expect("cuda final step");

    let e_total_rel = (cuda_final.e_total - cpu_final.e_total).abs() / cpu_final.e_total.abs();
    let e_demag_rel =
        (cuda_final.e_demag - cpu_final.e_demag).abs() / cpu_final.e_demag.abs().max(1e-30);
    let max_h_eff_rel =
        (cuda_final.max_h_eff - cpu_final.max_h_eff).abs() / cpu_final.max_h_eff.abs();

    assert!(
        e_total_rel < 1e-3,
        "imported geometry total energy drift too large: cpu={} cuda={} rel={}",
        cpu_final.e_total,
        cuda_final.e_total,
        e_total_rel
    );
    assert!(
        e_demag_rel < 1e-3,
        "imported geometry demag energy drift too large: cpu={} cuda={} rel={}",
        cpu_final.e_demag,
        cuda_final.e_demag,
        e_demag_rel
    );
    assert!(
        max_h_eff_rel < 1e-3,
        "imported geometry max|H_eff| drift too large: cpu={} cuda={} rel={}",
        cpu_final.max_h_eff,
        cuda_final.max_h_eff,
        max_h_eff_rel
    );

    assert_eq!(
        cpu.result.final_magnetization.len(),
        cuda.result.final_magnetization.len(),
        "final magnetization length mismatch"
    );
    for (index, (cpu_m, cuda_m)) in cpu
        .result
        .final_magnetization
        .iter()
        .zip(cuda.result.final_magnetization.iter())
        .enumerate()
    {
        let err = ((cpu_m[0] - cuda_m[0]).abs())
            .max((cpu_m[1] - cuda_m[1]).abs())
            .max((cpu_m[2] - cuda_m[2]).abs());
        assert!(
            err < 5e-4,
            "final magnetization drift too large at cell {index}: cpu={:?} cuda={:?}",
            cpu_m,
            cuda_m
        );
    }
}

#[test]
fn random_initial_relaxes_with_decreasing_energy() {
    let random_m0 = fullmag_plan::generate_random_unit_vectors(42, 16);

    let plan = FdmPlanIR {
        initial_magnetization: random_m0,
        ..make_test_plan()
    };

    let result = run_reference_fdm(&plan, 5e-12, &[]).expect("run should succeed");

    assert_eq!(result.status, RunStatus::Completed);
    let first_energy = result.steps.first().unwrap().e_ex;
    let last_energy = result.steps.last().unwrap().e_ex;
    assert!(
        last_energy <= first_energy,
        "exchange energy should decrease during relaxation: {} -> {}",
        first_energy,
        last_energy
    );
}

#[test]
fn exchange_energy_respects_planned_material_parameters() {
    let random_m0 = fullmag_plan::generate_random_unit_vectors(42, 16);
    let base_plan = FdmPlanIR {
        initial_magnetization: random_m0.clone(),
        ..make_test_plan()
    };
    let stronger_exchange_plan = FdmPlanIR {
        initial_magnetization: random_m0,
        material: FdmMaterialIR {
            exchange_stiffness: base_plan.material.exchange_stiffness * 2.0,
            ..base_plan.material.clone()
        },
        ..make_test_plan()
    };

    let base_result = run_reference_fdm(&base_plan, 1e-14, &[]).expect("base run should succeed");
    let stronger_result =
        run_reference_fdm(&stronger_exchange_plan, 1e-14, &[]).expect("scaled run should succeed");

    let base_initial = base_result.steps.first().unwrap().e_ex;
    let stronger_initial = stronger_result.steps.first().unwrap().e_ex;
    let ratio = stronger_initial / base_initial;
    assert!(
        (ratio - 2.0).abs() < 1e-9,
        "exchange energy should scale with A: got ratio {}",
        ratio
    );
}

#[test]
fn run_problem_streams_artifacts_and_preserves_layout() {
    let problem = fullmag_ir::ProblemIR::bootstrap_example();
    let unique_suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock drift")
        .as_nanos();
    let output_dir = std::env::temp_dir().join(format!(
        "fullmag-runner-artifacts-{}-{}",
        std::process::id(),
        unique_suffix
    ));

    let result = run_problem(&problem, 2e-13, &output_dir).expect("run_problem should succeed");
    assert_eq!(result.status, RunStatus::Completed);
    assert!(output_dir.join("scalars.csv").is_file());
    assert!(output_dir.join("m_initial.json").is_file());
    assert!(output_dir.join("m_final.json").is_file());
    assert!(output_dir.join("fields/m/step_000000.json").is_file());
    assert!(output_dir.join("fields/H_ex/step_000000.json").is_file());

    let metadata: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(output_dir.join("metadata.json"))
            .expect("metadata.json should be readable"),
    )
    .expect("metadata should parse");
    assert_eq!(metadata["field_snapshots"].as_u64(), Some(4));
    assert_eq!(metadata["scalar_rows"].as_u64(), Some(2));

    fs::remove_dir_all(&output_dir).expect("temporary artifact directory should be removable");
}

#[test]
fn run_problem_writes_prescribed_current_transport_artifact() {
    let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
    problem
        .current_modules
        .push(CurrentModuleIR::CurrentTransport {
            name: "drive".to_string(),
            model: CurrentTransportModelIR::PrescribedDensity,
            current_density: Some([0.0, 0.0, 5e10]),
            solve_region: None,
            conductivity_s_per_m: None,
        });
    let unique_suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock drift")
        .as_nanos();
    let output_dir = std::env::temp_dir().join(format!(
        "fullmag-runner-current-transport-{}-{}",
        std::process::id(),
        unique_suffix
    ));

    let result = run_problem(&problem, 2e-13, &output_dir).expect("run_problem should succeed");
    assert_eq!(result.status, RunStatus::Completed);

    let artifact: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(output_dir.join("current_transport/drive.json"))
            .expect("current transport artifact should be readable"),
    )
    .expect("current transport artifact should parse");
    assert_eq!(artifact["kind"], "current_transport");
    assert_eq!(artifact["model"], "prescribed_density");
    assert_eq!(artifact["unit"], "A/m^2");

    let values = artifact["values"]
        .as_array()
        .expect("values should be an array");
    let total_cell_count = artifact["layout"]["total_cell_count"]
        .as_u64()
        .expect("layout should report total_cell_count") as usize;
    assert_eq!(values.len(), total_cell_count);
    assert_eq!(values[0], serde_json::json!([0.0, 0.0, 5e10]));

    fs::remove_dir_all(&output_dir).expect("temporary artifact directory should be removable");
}

#[test]
fn scheduled_fields_include_initial_and_final_snapshots() {
    let plan = FdmPlanIR {
        initial_magnetization: fullmag_plan::generate_random_unit_vectors(42, 16),
        ..make_test_plan()
    };
    let outputs = [
        OutputIR::Field {
            name: "m".to_string(),
            every_seconds: 100e-12,
        },
        OutputIR::Field {
            name: "H_ex".to_string(),
            every_seconds: 100e-12,
        },
        OutputIR::Scalar {
            name: "E_ex".to_string(),
            every_seconds: 100e-12,
        },
    ];

    let executed = cpu_reference::execute_reference_fdm(&plan, 1e-12, &outputs, None, None)
        .expect("scheduled field run should succeed");

    let m_snapshots = executed
        .field_snapshots
        .iter()
        .filter(|snapshot| snapshot.name == "m")
        .collect::<Vec<_>>();
    let h_ex_snapshots = executed
        .field_snapshots
        .iter()
        .filter(|snapshot| snapshot.name == "H_ex")
        .collect::<Vec<_>>();

    assert_eq!(
        m_snapshots.len(),
        2,
        "m should have initial and final snapshots"
    );
    assert_eq!(
        h_ex_snapshots.len(),
        2,
        "H_ex should have initial and final snapshots"
    );
    assert_eq!(m_snapshots[0].step, 0);
    assert!(m_snapshots[1].step > 0);
}

#[test]
fn mesh_preview_active_mask_marks_only_non_air_nodes_for_m() {
    let mesh = MeshIR {
        mesh_name: "shared".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [2.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
            [2.0, 0.0, 1.0],
            [3.0, 0.0, 0.0],
        ],
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
        element_markers: vec![1, 0],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
        boundary_markers: vec![1, 99],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };

    let magnetization_mask = crate::preview::mesh_quantity_active_mask("m", &mesh)
        .expect("magnetization preview should expose a mask for FEM mesh previews");
    let demag_mask = crate::preview::mesh_quantity_active_mask("H_demag", &mesh);

    assert_eq!(
        magnetization_mask,
        vec![true, true, true, true, false, false, false, false]
    );
    assert!(demag_mask.is_none());
}

#[test]
fn fem_runtime_and_eigen_engine_ids_stay_distinct() {
    assert_eq!(
        fem_runtime_engine_info(dispatch::FemEngine::CpuNative),
        ("fem_cpu_native", "CPU FEM (MFEM/libCEED/hypre)", "cpu")
    );
    assert_eq!(
        fem_eigen_runtime_engine_info(dispatch::FemEngine::CpuNative),
        ("fem_eigen_cpu_baseline", "CPU FEM Eigen Baseline", "cpu")
    );
    assert_eq!(
        fem_session_runtime_defaults(dispatch::FemEngine::CpuNative),
        ("fem-cpu-native", "fem_cpu_native", "../../bin/fullmag-bin")
    );
    assert_eq!(
        fem_eigen_session_runtime_defaults(dispatch::FemEngine::CpuNative),
        (
            "fem-eigen-cpu-baseline",
            "fem_eigen_cpu_baseline",
            "../../bin/fullmag-bin",
        )
    );
}
