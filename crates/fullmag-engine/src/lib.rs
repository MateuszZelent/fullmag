// ── Existing sub-crate modules ────────────────────────────────────────
pub mod distributed;
pub mod fem;
pub mod fem_afem_loop;
pub mod fem_edge_topology;
pub mod fem_error_estimator;
pub mod fem_face_topology;
pub mod fem_goal_estimator;
pub mod fem_hcurl_estimator;
pub mod fem_pbc_benchmark;
pub mod fem_size_field;
pub mod fem_solution_transfer;
pub mod fem_sparse;
pub mod hpc_runtime;
pub mod magnetoelastic;
pub mod multilayer;
pub mod newell;
pub mod periodic;
pub mod studies;
pub mod telemetry;
pub mod vector;

// ── FDM engine modules ────────────────────────────────────────────────
pub mod fdm;

// ── Imports used locally (constants, tests) ───────────────────────────
use std::f64::consts::PI;

// ── Constants ─────────────────────────────────────────────────────────
pub const MU0: f64 = 4.0 * PI * 1e-7;
pub const DEFAULT_GYROMAGNETIC_RATIO: f64 = 2.211e5;

pub type Vector3 = [f64; 3];

// ── Re-exports from FDM modules ───────────────────────────────────────
pub use fdm::neighbor_index;
pub use fdm::{
    compute_newell_kernel_spectra, compute_newell_kernel_spectra_thin_film_2d,
    compute_periodic_newell_kernel_spectra, run_reference_exchange_demo, AbmHistory, AbmHistorySoA,
    AdaptiveStepConfig, AxisBoundary, CellSize, CoupledImexArk2Stage, CoupledImexArk2Tableau,
    CubicAnisotropyConfig, DemagKernelSpectra, EffectiveFieldObservables, EffectiveFieldTerms,
    EngineError, EvaluationRequest, ExchangeLlgProblem, ExchangeLlgState, ExchangeLlgStateSoA,
    ExternalStageTerms, FdmBoundaryPolicy, FdmDemagBoundary, FftWorkspace, GridShape,
    IntegratorBuffers, LlgConfig, MagnetoelasticTermConfig, MaterialParameters,
    OerstedCylinderConfig, ReferenceDemoReport, RegionalFieldDriveTerm,
    ResolvedFdmPeriodicWorkspace, Result, RhsEvaluation, SlonczewskiFormula, SlonczewskiSttConfig,
    SolverSession, SotConfig, SotFormula, StepReport, TimeIntegrator, UniaxialAnisotropyConfig,
    VectorFieldSoA, ZhangLiFormula, ZhangLiSttConfig,
};

// ── Vector math utilities ─────────────────────────────────────────────
pub use vector::{
    add, cross, dot, max_cross_norm, max_norm, norm, normalized, scale, squared_norm, sub,
};

// ── Tests ─────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    fn simple_problem(alpha: f64, gamma: f64) -> ExchangeLlgProblem {
        let grid = GridShape::new(3, 1, 1).expect("valid grid");
        ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, alpha).expect("valid material"),
            LlgConfig::new(gamma, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                external_field: None,
                per_node_field: None,
                magnetoelastic: None,
                ..Default::default()
            },
        )
    }

    fn zeeman_problem(field: Vector3) -> ExchangeLlgProblem {
        let grid = GridShape::new(2, 1, 1).expect("valid grid");
        ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.5).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: Some(field),
                per_node_field: None,
                magnetoelastic: None,
                ..Default::default()
            },
        )
    }

    #[test]
    fn effective_field_terms_default_enables_demag() {
        let terms = EffectiveFieldTerms::default();
        assert!(terms.exchange);
        assert!(terms.demag);
        assert!(terms.external_field.is_none());
    }

    #[test]
    fn regional_drive_energy_matches_the_static_effective_field() {
        let grid = GridShape::new(1, 1, 1).expect("valid grid");
        let mut problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(2.0, 1.0, 0.1).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                ..Default::default()
            },
        );
        problem.regional_field_drives.push(RegionalFieldDriveTerm {
            basis_field: vec![[0.0, 3.0, 0.0]],
            waveform: fullmag_ir::TimeDependenceIR::Constant,
            time_offset_s: 0.0,
            enabled: true,
        });

        let magnetization = vec![[0.0, 1.0, 0.0]];
        let mut workspace = problem.create_workspace();
        let energy = problem.total_energy_from_vectors_ws(&magnetization, &mut workspace);

        assert!(
            (energy + 6.0 * MU0).abs() < 1e-18,
            "regional drive energy must be -mu0 Ms V m dot H, got {energy}"
        );

        let epsilon = 1e-6_f64;
        let plus = vec![[epsilon.cos(), epsilon.sin(), 0.0]];
        let minus = vec![[epsilon.cos(), -epsilon.sin(), 0.0]];
        let mut finite_difference_workspace = problem.create_workspace();
        let energy_plus =
            problem.total_energy_from_vectors_ws(&plus, &mut finite_difference_workspace);
        let energy_minus =
            problem.total_energy_from_vectors_ws(&minus, &mut finite_difference_workspace);
        let derivative = (energy_plus - energy_minus) / (2.0 * epsilon);

        assert!(
            (derivative + 6.0 * MU0).abs() < 1e-15,
            "regional drive energy derivative must match the effective field, got {derivative}"
        );
    }

    #[test]
    fn spatial_material_fields_exchange_energy_field_taylor_consistency() {
        let grid = GridShape::new(4, 3, 1).unwrap();
        let cs = CellSize::new(5.0e-9, 5.0e-9, 5.0e-9).unwrap();

        // Nonuniform A_i: left half (x < 2) is 10e-12, right half (x >= 2) is 20e-12
        let mut a_field = vec![0.0; grid.cell_count()];
        // Nonuniform Ms_i: varying around 800e3
        let mut ms_field = vec![0.0; grid.cell_count()];

        for flat_idx in 0..grid.cell_count() {
            let x = flat_idx % grid.nx;
            a_field[flat_idx] = if x < 2 { 10.0e-12 } else { 20.0e-12 };
            ms_field[flat_idx] = 800.0e3 + 50.0e3 * (x as f64);
        }

        let problem = ExchangeLlgProblem::with_terms_and_mask(
            grid,
            cs,
            MaterialParameters::new(800.0e3, 13.0e-12, 0.5).unwrap(),
            LlgConfig::default(),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                ..Default::default()
            },
            None,
        )
        .unwrap()
        .with_spatial_fields(Some(ms_field), Some(a_field), None)
        .unwrap();

        // Non-collinear magnetization
        let mut m = vec![[0.0; 3]; grid.cell_count()];
        for i in 0..grid.cell_count() {
            let angle = (i as f64) * 0.45;
            m[i] = [angle.cos(), angle.sin(), 0.0];
        }
        let state = problem.new_state(m.clone()).unwrap();

        // Tangent perturbation dm with dm_i dot m_i = 0
        let mut dm = vec![[0.0; 3]; grid.cell_count()];
        for i in 0..grid.cell_count() {
            let m_i = m[i];
            dm[i] = [-m_i[1], m_i[0], 0.0];
        }

        // Calculate analytical directional derivative:
        // dE = - \sum_i \mu_0 * V_cell * M_{s,i} * \vec{H}_{ex,i} \cdot \vec{dm}_i
        let h_ex = problem.exchange_field(&state).unwrap();
        let cell_volume = cs.volume();
        let mut analytic_derivative = 0.0;
        for i in 0..grid.cell_count() {
            let dot_prod = h_ex[i][0] * dm[i][0] + h_ex[i][1] * dm[i][1] + h_ex[i][2] * dm[i][2];
            analytic_derivative += -MU0 * cell_volume * problem.ms_at(i) * dot_prod;
        }

        // Finite difference
        let eps = 1e-7;

        // Plus perturbation state
        let mut m_plus = vec![[0.0; 3]; grid.cell_count()];
        for i in 0..grid.cell_count() {
            let pert = [
                m[i][0] + eps * dm[i][0],
                m[i][1] + eps * dm[i][1],
                m[i][2] + eps * dm[i][2],
            ];
            let norm = (pert[0] * pert[0] + pert[1] * pert[1] + pert[2] * pert[2]).sqrt();
            m_plus[i] = [pert[0] / norm, pert[1] / norm, pert[2] / norm];
        }
        let state_plus = problem.new_state(m_plus).unwrap();
        let e_plus = problem.exchange_energy(&state_plus).unwrap();

        // Minus perturbation state
        let mut m_minus = vec![[0.0; 3]; grid.cell_count()];
        for i in 0..grid.cell_count() {
            let pert = [
                m[i][0] - eps * dm[i][0],
                m[i][1] - eps * dm[i][1],
                m[i][2] - eps * dm[i][2],
            ];
            let norm = (pert[0] * pert[0] + pert[1] * pert[1] + pert[2] * pert[2]).sqrt();
            m_minus[i] = [pert[0] / norm, pert[1] / norm, pert[2] / norm];
        }
        let state_minus = problem.new_state(m_minus).unwrap();
        let e_minus = problem.exchange_energy(&state_minus).unwrap();

        let finite_diff_derivative = (e_plus - e_minus) / (2.0 * eps);

        let abs_diff = (finite_diff_derivative - analytic_derivative).abs();
        let rel_diff = abs_diff / analytic_derivative.abs().max(1.0e-15);

        assert!(
            rel_diff < 1e-4 || abs_diff < 1e-20,
            "Taylor consistency failed: finite_diff={}, analytic={}, rel_diff={}, abs_diff={}",
            finite_diff_derivative,
            analytic_derivative,
            rel_diff,
            abs_diff
        );
    }

    fn demag_problem(nx: usize, ny: usize, nz: usize) -> ExchangeLlgProblem {
        let grid = GridShape::new(nx, ny, nz).expect("valid grid");
        ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 0.2).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.1).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: true,
                external_field: None,
                per_node_field: None,
                magnetoelastic: None,
                ..Default::default()
            },
        )
    }

    fn masked_exchange_problem(mask: Vec<bool>) -> ExchangeLlgProblem {
        let grid = GridShape::new(3, 1, 1).expect("valid grid");
        ExchangeLlgProblem::with_terms_and_mask(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.1).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                external_field: None,
                per_node_field: None,
                magnetoelastic: None,
                ..Default::default()
            },
            Some(mask),
        )
        .expect("masked problem should build")
    }

    fn masked_demag_problem(mask: Vec<bool>) -> ExchangeLlgProblem {
        let grid = GridShape::new(3, 1, 1).expect("valid grid");
        ExchangeLlgProblem::with_terms_and_mask(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.1).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: true,
                external_field: Some([0.0, 0.0, 1.0]),
                per_node_field: None,
                magnetoelastic: None,
                ..Default::default()
            },
            Some(mask),
        )
        .expect("masked problem should build")
    }

    fn assert_vector_close(actual: Vector3, expected: Vector3, tolerance: f64) {
        for component in 0..3 {
            assert!(
                (actual[component] - expected[component]).abs() <= tolerance,
                "component {component} differs: actual={:?}, expected={:?}",
                actual,
                expected
            );
        }
    }

    fn expected_native_centered_dmi_energy(
        problem: &ExchangeLlgProblem,
        magnetization: &[Vector3],
    ) -> f64 {
        let grid = problem.grid;
        let dx = problem.cell_size.dx;
        let dy = problem.cell_size.dy;
        let dz = problem.cell_size.dz;
        let volume = problem.cell_size.volume();
        let bpx = matches!(problem.boundary_policy.x, AxisBoundary::Periodic);
        let bpy = matches!(problem.boundary_policy.y, AxisBoundary::Periodic);
        let bpz = matches!(problem.boundary_policy.z, AxisBoundary::Periodic);

        let mut energy = 0.0;
        for flat in 0..grid.cell_count() {
            if !problem.is_active(flat) {
                continue;
            }
            let x = flat % grid.nx;
            let y = (flat / grid.nx) % grid.ny;
            let z = flat / (grid.nx * grid.ny);
            let sample = |neighbor: usize| {
                if problem.is_active(neighbor) {
                    neighbor
                } else {
                    flat
                }
            };
            let xp = sample(grid.index(neighbor_index(x, grid.nx, 1, bpx), y, z));
            let xm = sample(grid.index(neighbor_index(x, grid.nx, -1, bpx), y, z));
            let yp = sample(grid.index(x, neighbor_index(y, grid.ny, 1, bpy), z));
            let ym = sample(grid.index(x, neighbor_index(y, grid.ny, -1, bpy), z));
            let zp = sample(grid.index(x, y, neighbor_index(z, grid.nz, 1, bpz)));
            let zm = sample(grid.index(x, y, neighbor_index(z, grid.nz, -1, bpz)));

            let m = magnetization[flat];
            if let Some(d) = problem.terms.interfacial_dmi {
                if d.abs() > 0.0 {
                    let dmx_dx = (magnetization[xp][0] - magnetization[xm][0]) / (2.0 * dx);
                    let dmy_dy = (magnetization[yp][1] - magnetization[ym][1]) / (2.0 * dy);
                    let dmz_dx = (magnetization[xp][2] - magnetization[xm][2]) / (2.0 * dx);
                    let dmz_dy = (magnetization[yp][2] - magnetization[ym][2]) / (2.0 * dy);
                    energy +=
                        volume * d * (m[2] * (dmx_dx + dmy_dy) - m[0] * dmz_dx - m[1] * dmz_dy);
                }
            }
            if let Some(d) = problem.terms.bulk_dmi {
                if d.abs() > 0.0 {
                    let curl_x = (magnetization[yp][2] - magnetization[ym][2]) / (2.0 * dy)
                        - (magnetization[zp][1] - magnetization[zm][1]) / (2.0 * dz);
                    let curl_y = (magnetization[zp][0] - magnetization[zm][0]) / (2.0 * dz)
                        - (magnetization[xp][2] - magnetization[xm][2]) / (2.0 * dx);
                    let curl_z = (magnetization[xp][1] - magnetization[xm][1]) / (2.0 * dx)
                        - (magnetization[yp][0] - magnetization[ym][0]) / (2.0 * dy);
                    energy += volume * d * (m[0] * curl_x + m[1] * curl_y + m[2] * curl_z);
                }
            }
        }
        energy
    }

    fn assert_optional_vector_field_close(
        actual: &Option<Vec<Vector3>>,
        expected: &Option<Vec<Vector3>>,
        tolerance: f64,
    ) {
        match (actual, expected) {
            (Some(actual), Some(expected)) => {
                assert_eq!(actual.len(), expected.len());
                for (actual, expected) in actual.iter().zip(expected) {
                    assert_vector_close(*actual, *expected, tolerance);
                }
            }
            (None, None) => {}
            _ => panic!("optional vector field presence differs"),
        }
    }

    fn assert_abm_history_close(actual: &AbmHistory, expected: &AbmHistory, tolerance: f64) {
        assert_eq!(actual.startup_steps, expected.startup_steps);
        assert!(
            (actual.last_dt - expected.last_dt).abs() <= tolerance,
            "last dt differs: actual={}, expected={}",
            actual.last_dt,
            expected.last_dt
        );
        assert_optional_vector_field_close(&actual.f_n, &expected.f_n, tolerance);
        assert_optional_vector_field_close(&actual.f_n_minus_1, &expected.f_n_minus_1, tolerance);
        assert_optional_vector_field_close(&actual.f_n_minus_2, &expected.f_n_minus_2, tolerance);
    }

    fn assert_step_report_close(actual: StepReport, expected: StepReport, tolerance: f64) {
        assert!(!actual.step_rejected);
        assert_eq!(actual.step_rejected, expected.step_rejected);
        match (actual.suggested_next_dt, expected.suggested_next_dt) {
            (Some(actual), Some(expected)) => assert!(
                (actual - expected).abs() <= tolerance,
                "suggested dt differs: actual={actual:?}, expected={expected:?}"
            ),
            (None, None) => {}
            _ => panic!("suggested dt presence differs: actual={actual:?}, expected={expected:?}"),
        }
        assert!(
            (actual.time_seconds - expected.time_seconds).abs() <= tolerance,
            "time differs: actual={actual:?}, expected={expected:?}"
        );
        assert!(
            (actual.dt_used - expected.dt_used).abs() <= tolerance,
            "dt differs: actual={actual:?}, expected={expected:?}"
        );
        assert!(
            (actual.exchange_energy_joules - expected.exchange_energy_joules).abs() <= tolerance,
            "exchange energy differs: actual={actual:?}, expected={expected:?}"
        );
        assert!(
            (actual.demag_energy_joules - expected.demag_energy_joules).abs() <= tolerance,
            "demag energy differs: actual={actual:?}, expected={expected:?}"
        );
        assert!(
            (actual.external_energy_joules - expected.external_energy_joules).abs() <= tolerance,
            "external energy differs: actual={actual:?}, expected={expected:?}"
        );
        assert!(
            (actual.dmi_energy_joules - expected.dmi_energy_joules).abs() <= tolerance,
            "DMI energy differs: actual={actual:?}, expected={expected:?}"
        );
        assert!(
            (actual.total_energy_joules - expected.total_energy_joules).abs() <= tolerance,
            "total energy differs: actual={actual:?}, expected={expected:?}"
        );
        assert!(
            (actual.max_effective_field_amplitude - expected.max_effective_field_amplitude).abs()
                <= tolerance,
            "max field differs: actual={actual:?}, expected={expected:?}"
        );
        assert!(
            (actual.max_demag_field_amplitude - expected.max_demag_field_amplitude).abs()
                <= tolerance,
            "max demag field differs: actual={actual:?}, expected={expected:?}"
        );
        assert!(
            (actual.max_rhs_amplitude - expected.max_rhs_amplitude).abs() <= tolerance,
            "max rhs differs: actual={actual:?}, expected={expected:?}"
        );
        assert!(
            (actual.max_torque_Apm - expected.max_torque_Apm).abs() <= tolerance,
            "max torque differs: actual={actual:?}, expected={expected:?}"
        );
    }

    fn assert_step_report_dynamics_close(actual: StepReport, expected: StepReport, tolerance: f64) {
        assert!(!actual.step_rejected);
        assert_eq!(actual.step_rejected, expected.step_rejected);
        assert!(
            (actual.time_seconds - expected.time_seconds).abs() <= tolerance,
            "time differs: actual={actual:?}, expected={expected:?}"
        );
        assert!(
            (actual.dt_used - expected.dt_used).abs() <= tolerance,
            "dt differs: actual={actual:?}, expected={expected:?}"
        );
        assert!(
            (actual.max_effective_field_amplitude - expected.max_effective_field_amplitude).abs()
                <= tolerance,
            "max field differs: actual={actual:?}, expected={expected:?}"
        );
        assert!(
            (actual.max_demag_field_amplitude - expected.max_demag_field_amplitude).abs()
                <= tolerance,
            "max demag field differs: actual={actual:?}, expected={expected:?}"
        );
        assert!(
            (actual.max_rhs_amplitude - expected.max_rhs_amplitude).abs() <= tolerance,
            "max rhs differs: actual={actual:?}, expected={expected:?}"
        );
        assert!(
            (actual.max_torque_Apm - expected.max_torque_Apm).abs() <= tolerance,
            "max torque differs: actual={actual:?}, expected={expected:?}"
        );
    }

    #[test]
    fn soa_energy_and_tangent_gradient_match_aos_helpers() {
        let grid = GridShape::new(3, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 0.5).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.1).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: true,
                demag: true,
                external_field: Some([0.2, -0.1, 0.3]),
                per_node_field: None,
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let magnetization = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

        let mut aos_ws = problem.create_workspace();
        let aos_energy = problem.total_energy_from_vectors_ws(&magnetization, &mut aos_ws);
        let aos_h_eff = problem.effective_field_from_vectors_ws(&magnetization, &mut aos_ws);
        let aos_gradient =
            ExchangeLlgProblem::tangent_gradient_from_field(&magnetization, &aos_h_eff);

        let soa_m = VectorFieldSoA::from_aos(&magnetization);
        let mut soa_ws = problem.create_workspace();
        let mut scratch = VectorFieldSoA::zeros(grid.cell_count());
        let soa_energy = problem.total_energy_from_soa_ws(&soa_m, &mut soa_ws, &mut scratch);
        let mut soa_h_eff = VectorFieldSoA::zeros(grid.cell_count());
        problem.effective_field_into_soa_ws(&soa_m, &mut soa_ws, &mut soa_h_eff);
        let mut soa_gradient = VectorFieldSoA::zeros(grid.cell_count());
        problem.tangent_gradient_from_soa_field_into(&soa_m, &soa_h_eff, &mut soa_gradient);

        assert!(
            (soa_energy - aos_energy).abs() <= 1e-12,
            "SoA energy differs: {soa_energy} vs {aos_energy}"
        );
        for (actual, expected) in soa_h_eff.gather_to_aos().iter().zip(&aos_h_eff) {
            assert_vector_close(*actual, *expected, 1e-12);
        }
        for (actual, expected) in soa_gradient.gather_to_aos().iter().zip(&aos_gradient) {
            assert_vector_close(*actual, *expected, 1e-12);
        }
    }

    #[test]
    fn total_energy_helpers_include_local_conservative_terms() {
        let grid = GridShape::new(4, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms_and_mask(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: Some([0.03, -0.02, 0.01]),
                uniaxial_anisotropy: Some(UniaxialAnisotropyConfig {
                    ku1: 0.12 * MU0,
                    ku2: 0.03 * MU0,
                    axis: [0.0, 0.0, 2.0],
                }),
                cubic_anisotropy: Some(CubicAnisotropyConfig {
                    kc1: 0.05 * MU0,
                    kc2: -0.01 * MU0,
                    kc3: 0.0,
                    axis1: [2.0, 0.0, 0.0],
                    axis2: [0.0, 3.0, 0.0],
                }),
                magnetoelastic: Some(MagnetoelasticTermConfig {
                    params: magnetoelastic::MagnetoelasticParams {
                        b1: 0.2 * MU0,
                        b2: -0.08 * MU0,
                        ms: 1.0,
                    },
                    strain: magnetoelastic::PrescribedStrainField::PerCell(vec![
                        [0.10, -0.05, 0.02, 0.04, -0.03, 0.01],
                        [0.03, 0.02, -0.01, -0.02, 0.05, 0.04],
                        [-0.04, 0.06, 0.03, 0.01, 0.02, -0.05],
                        [0.02, -0.03, 0.04, 0.03, -0.01, 0.02],
                    ]),
                }),
                ..Default::default()
            },
            Some(vec![true, true, false, true]),
        )
        .expect("masked problem should build");
        let magnetization = vec![
            [1.0, 0.1, 0.0],
            [0.0, 1.0, 0.2],
            [0.2, 0.0, 1.0],
            [1.0, -0.1, 0.1],
        ];

        let mut report_ws = problem.create_workspace();
        let mut report_bufs = problem.create_integrator_buffers();
        let report = problem.compute_step_observables(
            &magnetization,
            &mut report_ws,
            &mut report_bufs.h_eff,
            &mut report_bufs.h_scratch,
            &mut report_bufs.rhs,
            EvaluationRequest::Full,
        );

        let mut aos_ws = problem.create_workspace();
        let aos_energy = problem.total_energy_from_vectors_ws(&magnetization, &mut aos_ws);
        let soa_m = VectorFieldSoA::from_aos(&magnetization);
        let mut soa_ws = problem.create_workspace();
        let mut soa_scratch = VectorFieldSoA::zeros(grid.cell_count());
        let soa_energy = problem.total_energy_from_soa_ws(&soa_m, &mut soa_ws, &mut soa_scratch);

        assert!(
            (aos_energy - report.total_energy_joules).abs() <= 1e-12,
            "AoS helper energy differs from full observable energy: {aos_energy} vs {}",
            report.total_energy_joules
        );
        assert!(
            (soa_energy - report.total_energy_joules).abs() <= 1e-12,
            "SoA helper energy differs from full observable energy: {soa_energy} vs {}",
            report.total_energy_joules
        );
    }

    #[test]
    fn dmi_scalar_energy_matches_native_centered_density_contract() {
        let grid = GridShape::new(3, 3, 3).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms_and_mask(
            grid,
            CellSize::new(1.0, 1.5, 2.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                interfacial_dmi: Some(0.7 * MU0),
                bulk_dmi: Some(-0.4 * MU0),
                magnetoelastic: None,
                ..Default::default()
            },
            Some(
                (0..grid.cell_count())
                    .map(|i| {
                        let x = i % grid.nx;
                        let y = (i / grid.nx) % grid.ny;
                        let z = i / (grid.nx * grid.ny);
                        !(x == 1 && y == 1 && z == 1)
                    })
                    .collect(),
            ),
        )
        .expect("masked DMI problem should build");
        let raw_magnetization = (0..grid.cell_count())
            .map(|i| {
                let x = i % grid.nx;
                let y = (i / grid.nx) % grid.ny;
                let z = i / (grid.nx * grid.ny);
                [
                    0.8 + 0.11 * x as f64 - 0.03 * z as f64,
                    0.2 + 0.07 * y as f64 + 0.05 * z as f64,
                    0.4 - 0.04 * x as f64 + 0.09 * y as f64,
                ]
            })
            .collect();
        let state = problem
            .new_state(raw_magnetization)
            .expect("state should build");
        let expected = expected_native_centered_dmi_energy(&problem, state.magnetization());
        assert!(expected.abs() > 1e-12);

        let mut report_ws = problem.create_workspace();
        let mut report_bufs = problem.create_integrator_buffers();
        let report = problem.compute_step_observables(
            state.magnetization(),
            &mut report_ws,
            &mut report_bufs.h_eff,
            &mut report_bufs.h_scratch,
            &mut report_bufs.rhs,
            EvaluationRequest::Full,
        );
        let mut aos_ws = problem.create_workspace();
        let aos_energy = problem.total_energy_from_vectors_ws(state.magnetization(), &mut aos_ws);
        let soa_m = VectorFieldSoA::from_aos(state.magnetization());
        let mut soa_ws = problem.create_workspace();
        let mut soa_scratch = VectorFieldSoA::zeros(grid.cell_count());
        let soa_energy = problem.total_energy_from_soa_ws(&soa_m, &mut soa_ws, &mut soa_scratch);

        assert!(
            (report.dmi_energy_joules - expected).abs() <= 1e-12,
            "StepReport DMI energy differs from native centered density: {} vs {expected}",
            report.dmi_energy_joules
        );
        assert!(
            (report.total_energy_joules - expected).abs() <= 1e-12,
            "StepReport total energy differs from DMI-only expected energy: {} vs {expected}",
            report.total_energy_joules
        );
        assert!(
            (aos_energy - expected).abs() <= 1e-12,
            "AoS total energy differs from DMI expected energy: {aos_energy} vs {expected}"
        );
        assert!(
            (soa_energy - expected).abs() <= 1e-12,
            "SoA total energy differs from DMI expected energy: {soa_energy} vs {expected}"
        );
    }

    #[test]
    fn step_report_carries_anisotropy_energy_for_cpu_scalar_rows() {
        let grid = GridShape::new(3, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                uniaxial_anisotropy: Some(UniaxialAnisotropyConfig {
                    ku1: 0.12 * MU0,
                    ku2: 0.03 * MU0,
                    axis: [0.0, 0.0, 1.0],
                }),
                cubic_anisotropy: Some(CubicAnisotropyConfig {
                    kc1: 0.05 * MU0,
                    kc2: -0.01 * MU0,
                    kc3: 0.0,
                    axis1: [1.0, 0.0, 0.0],
                    axis2: [0.0, 1.0, 0.0],
                }),
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let mut state = problem
            .new_state(vec![[1.0, 0.2, 0.3], [0.1, 1.0, 0.2], [0.3, 0.2, 1.0]])
            .expect("state should build");
        let mut ws = problem.create_workspace();
        let mut bufs = problem.create_integrator_buffers();

        let report = problem
            .step_with_buffers_evaluation(
                &mut state,
                1e-12,
                &mut ws,
                &mut bufs,
                EvaluationRequest::Full,
            )
            .expect("step should succeed");
        let expected_energy = problem.anisotropy_energy(state.magnetization());

        assert!(expected_energy.abs() > 0.0);
        assert!(
            (report.anisotropy_energy_joules - expected_energy).abs() <= 1e-12,
            "StepReport anisotropy energy differs from direct energy: {} vs {expected_energy}",
            report.anisotropy_energy_joules
        );
    }

    #[test]
    fn cubic_kc3_field_and_energy_follow_the_canonical_derivative() {
        let inv_sqrt3 = 1.0 / 3.0_f64.sqrt();
        let kc3 = 0.75 * MU0;
        let problem = ExchangeLlgProblem::with_terms(
            GridShape::new(1, 1, 1).expect("valid grid"),
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 1.0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                cubic_anisotropy: Some(CubicAnisotropyConfig {
                    kc1: 0.0,
                    kc2: 0.0,
                    kc3,
                    axis1: [1.0, 0.0, 0.0],
                    axis2: [0.0, 1.0, 0.0],
                }),
                ..Default::default()
            },
        );
        let magnetization = vec![[inv_sqrt3, inv_sqrt3, inv_sqrt3]];
        let field = problem.anisotropy_field(&magnetization);
        let sigma = 1.0 / 3.0;
        let expected_field = -4.0 * kc3 * sigma * inv_sqrt3 * (2.0 / 3.0) / MU0;
        for component in field[0] {
            assert!(
                (component - expected_field).abs() <= 1e-12,
                "Kc3 field component {component} differs from {expected_field}"
            );
        }

        let mut workspace = problem.create_workspace();
        let energy = problem.total_energy_from_vectors_ws(&magnetization, &mut workspace);
        let expected_energy = kc3 * sigma * sigma;
        assert!(
            (energy - expected_energy).abs() <= 1e-18,
            "Kc3 energy {energy} differs from {expected_energy}"
        );
    }

    fn assert_state_changed(initial: &[Vector3], state: &ExchangeLlgState) {
        let max_delta = initial
            .iter()
            .zip(state.magnetization())
            .flat_map(|(before, after)| {
                [
                    (after[0] - before[0]).abs(),
                    (after[1] - before[1]).abs(),
                    (after[2] - before[2]).abs(),
                ]
            })
            .fold(0.0, f64::max);
        assert!(
            max_delta > 1e-12,
            "direct torque should move magnetization, max_delta={max_delta}"
        );
    }

    fn assert_heun_aos_soa_direct_torque_match(
        problem: &ExchangeLlgProblem,
        magnetization: Vec<Vector3>,
    ) {
        assert_stepper_aos_soa_direct_torque_match(
            problem,
            magnetization,
            ExchangeLlgProblem::heun_step_buf,
            ExchangeLlgProblem::heun_step_soa_buf,
            1,
            "Heun",
        );
    }

    type BufferStepper = fn(
        &ExchangeLlgProblem,
        &mut ExchangeLlgState,
        f64,
        &mut FftWorkspace,
        &mut IntegratorBuffers,
        EvaluationRequest,
    ) -> Result<StepReport>;

    type PersistentSoAStepper = fn(
        &ExchangeLlgProblem,
        &mut ExchangeLlgStateSoA,
        f64,
        &mut FftWorkspace,
        &mut IntegratorBuffers,
        EvaluationRequest,
    ) -> Result<StepReport>;

    fn assert_stepper_aos_soa_direct_torque_match(
        problem: &ExchangeLlgProblem,
        magnetization: Vec<Vector3>,
        aos_step: BufferStepper,
        soa_step: BufferStepper,
        steps: usize,
        stepper_name: &str,
    ) {
        let mut aos_state = problem
            .new_state(magnetization.clone())
            .expect("AoS state should build");
        let mut soa_state = problem
            .new_state(magnetization.clone())
            .expect("SoA state should build");
        let mut aos_ws = problem.create_workspace();
        let mut soa_ws = problem.create_workspace();
        let mut aos_bufs = problem.create_integrator_buffers();
        let mut soa_bufs = problem.create_integrator_buffers();

        for _ in 0..steps {
            let aos_report = aos_step(
                problem,
                &mut aos_state,
                1.0e-2,
                &mut aos_ws,
                &mut aos_bufs,
                EvaluationRequest::Minimal,
            )
            .unwrap_or_else(|err| panic!("AoS {stepper_name} direct torque step failed: {err}"));
            let soa_report = soa_step(
                problem,
                &mut soa_state,
                1.0e-2,
                &mut soa_ws,
                &mut soa_bufs,
                EvaluationRequest::Minimal,
            )
            .unwrap_or_else(|err| panic!("SoA {stepper_name} direct torque step failed: {err}"));
            assert_step_report_close(soa_report, aos_report, 1e-12);
        }

        assert_state_changed(&magnetization, &aos_state);
        assert_state_changed(&magnetization, &soa_state);
        for (actual, expected) in soa_state
            .magnetization()
            .iter()
            .zip(aos_state.magnetization())
        {
            assert_vector_close(*actual, *expected, 1e-12);
        }
        assert_abm_history_close(&soa_state.abm_history, &aos_state.abm_history, 1e-12);
    }

    fn assert_stepper_aos_soa_match(
        problem: &ExchangeLlgProblem,
        magnetization: Vec<Vector3>,
        aos_step: BufferStepper,
        soa_step: BufferStepper,
        steps: usize,
        stepper_name: &str,
    ) {
        let mut aos_state = problem
            .new_state(magnetization.clone())
            .expect("AoS state should build");
        let mut soa_state = problem
            .new_state(magnetization)
            .expect("SoA state should build");
        let mut aos_ws = problem.create_workspace();
        let mut soa_ws = problem.create_workspace();
        let mut aos_bufs = problem.create_integrator_buffers();
        let mut soa_bufs = problem.create_integrator_buffers();

        for _ in 0..steps {
            let aos_report = aos_step(
                problem,
                &mut aos_state,
                1.0e-3,
                &mut aos_ws,
                &mut aos_bufs,
                EvaluationRequest::Minimal,
            )
            .unwrap_or_else(|err| panic!("AoS {stepper_name} step failed: {err}"));
            let soa_report = soa_step(
                problem,
                &mut soa_state,
                1.0e-3,
                &mut soa_ws,
                &mut soa_bufs,
                EvaluationRequest::Minimal,
            )
            .unwrap_or_else(|err| panic!("SoA {stepper_name} step failed: {err}"));
            assert_step_report_close(soa_report, aos_report, 1e-12);
        }

        for (actual, expected) in soa_state
            .magnetization()
            .iter()
            .zip(aos_state.magnetization())
        {
            assert_vector_close(*actual, *expected, 1e-12);
        }
        assert_eq!(soa_state.has_fsal(), aos_state.has_fsal());
        if let (Some(actual), Some(expected)) = (&soa_state.k_fsal, &aos_state.k_fsal) {
            for (actual, expected) in actual.iter().zip(expected) {
                assert_vector_close(*actual, *expected, 1e-12);
            }
        }
        assert_abm_history_close(&soa_state.abm_history, &aos_state.abm_history, 1e-12);
    }

    #[test]
    fn uniform_state_has_zero_exchange_field_and_rhs() {
        let problem = simple_problem(0.1, 1.0);
        let state = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("uniform state should build");

        let field = problem
            .exchange_field(&state)
            .expect("exchange field should evaluate");
        let rhs = problem.llg_rhs(&state).expect("rhs should evaluate");

        for value in field.iter().chain(rhs.iter()) {
            assert_vector_close(*value, [0.0, 0.0, 0.0], 1e-12);
        }
        assert!(
            problem
                .exchange_energy(&state)
                .expect("energy should evaluate")
                <= 1e-12,
            "uniform state should have zero exchange energy"
        );
    }

    #[test]
    fn center_exchange_field_matches_second_difference_stencil() {
        let problem = simple_problem(0.0, 1.0);
        let state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]])
            .expect("state should build");

        let field = problem
            .exchange_field(&state)
            .expect("exchange field should evaluate");

        assert_vector_close(field[1], [2.0, -2.0, 0.0], 1e-12);
    }

    #[test]
    fn masked_exchange_treats_inactive_neighbor_as_free_surface() {
        let problem = masked_exchange_problem(vec![true, true, false]);
        let state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.7, 0.3, 0.0]])
            .expect("state should build");

        let field = problem
            .exchange_field(&state)
            .expect("exchange field should evaluate");

        assert_vector_close(field[1], [1.0, -1.0, 0.0], 1e-12);
        assert_vector_close(field[2], [0.0, 0.0, 0.0], 1e-12);
        assert_vector_close(state.magnetization()[2], [0.0, 0.0, 0.0], 1e-12);
    }

    #[test]
    fn masked_demag_and_external_fields_are_zero_outside_active_domain() {
        let problem = masked_demag_problem(vec![true, true, false]);
        let state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
            .expect("state should build");

        let obs = problem.observe(&state).expect("observables");

        assert_vector_close(obs.external_field[2], [0.0, 0.0, 0.0], 1e-12);
        assert_vector_close(obs.demag_field[2], [0.0, 0.0, 0.0], 1e-12);
        assert_vector_close(obs.effective_field[2], [0.0, 0.0, 0.0], 1e-12);
        assert_vector_close(obs.magnetization[2], [0.0, 0.0, 0.0], 1e-12);
    }

    #[test]
    fn heun_step_preserves_unit_norm() {
        let problem = simple_problem(0.1, 1.0);
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]])
            .expect("state should build");
        let mut ws = problem.create_workspace();

        let _report = problem
            .step_with_workspace(&mut state, 1e-3, &mut ws)
            .expect("step should succeed");

        for magnetization in state.magnetization() {
            assert!(
                (norm(*magnetization) - 1.0).abs() <= 1e-12,
                "magnetization lost unit norm: {:?}",
                magnetization
            );
        }
    }

    #[test]
    fn coupled_heun_rolls_back_when_final_transport_refresh_fails() {
        let problem = simple_problem(0.1, 1.0);
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]])
            .expect("state should build");
        let initial = state.clone();
        let mut ws = problem.create_workspace();
        let mut bufs = problem.create_integrator_buffers();
        let mut calls = 0;

        let error = problem
            .heun_step_with_external_stage_terms(
                &mut state,
                1e-3,
                &mut ws,
                &mut bufs,
                EvaluationRequest::Full,
                |_m, _time| {
                    calls += 1;
                    if calls == 3 {
                        return Err(EngineError::new("transport solve failed"));
                    }
                    Ok(ExternalStageTerms {
                        additional_field_apm: vec![[0.0, 0.0, 1.0]; 3],
                        direct_torque_per_s: vec![[0.0; 3]; 3],
                    })
                },
            )
            .expect_err("final transport failure must reject the step");

        assert!(error.to_string().contains("transport solve failed"));
        assert_eq!(calls, 3);
        assert_eq!(state.magnetization(), initial.magnetization());
        assert_eq!(state.time_seconds, initial.time_seconds);
    }

    #[test]
    fn coupled_heun_exposes_embedded_lte_only_to_corrected_transport_stage() {
        let problem = simple_problem(0.1, 1.0);
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]])
            .expect("state should build");
        let mut ws = problem.create_workspace();
        let mut bufs = problem.create_integrator_buffers();
        let mut budgets = Vec::new();

        problem
            .heun_step_with_external_stage_terms_and_lte(
                &mut state,
                1e-3,
                &mut ws,
                &mut bufs,
                EvaluationRequest::Full,
                |_m, _time, budget| {
                    budgets.push(budget);
                    Ok(ExternalStageTerms {
                        additional_field_apm: vec![[0.0, 0.0, 1.0]; 3],
                        direct_torque_per_s: vec![[0.0; 3]; 3],
                    })
                },
            )
            .expect("coupled Heun step should succeed");

        assert_eq!(budgets.len(), 3);
        assert_eq!(budgets[0], None);
        assert_eq!(budgets[1], None);
        let corrected = budgets[2].expect("corrected stage must carry an LTE budget");
        assert_eq!(corrected.dt_s, 1e-3);
        assert!(corrected.embedded_lte_m.is_finite());
        assert!(corrected.embedded_lte_m >= 0.0);
    }

    #[test]
    fn coupled_ars232_fixed_step_is_transactional_and_refreshes_accepted_state() {
        assert_eq!(
            CoupledImexArk2Tableau::EXPLICIT_A,
            [
                [0.0, 0.0, 0.0],
                [(2.0 - std::f64::consts::SQRT_2) / 2.0, 0.0, 0.0],
                [
                    -2.0 * std::f64::consts::SQRT_2 / 3.0,
                    1.0 + 2.0 * std::f64::consts::SQRT_2 / 3.0,
                    0.0
                ],
            ]
        );
        assert_eq!(
            CoupledImexArk2Tableau::EXPLICIT_B,
            [
                0.0,
                1.0 - CoupledImexArk2Tableau::GAMMA,
                CoupledImexArk2Tableau::GAMMA
            ]
        );
        assert_eq!(
            CoupledImexArk2Tableau::IMPLICIT_A,
            [
                [CoupledImexArk2Tableau::GAMMA, 0.0],
                [
                    1.0 - CoupledImexArk2Tableau::GAMMA,
                    CoupledImexArk2Tableau::GAMMA
                ],
            ]
        );
        assert_eq!(
            CoupledImexArk2Tableau::IMPLICIT_B,
            [
                1.0 - CoupledImexArk2Tableau::GAMMA,
                CoupledImexArk2Tableau::GAMMA
            ]
        );
        let problem = simple_problem(0.1, 1.0);
        let initial = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]])
            .expect("state should build");
        for failure_call in 1..=4 {
            let mut state = initial.clone();
            let mut ws = problem.create_workspace();
            let mut bufs = problem.create_integrator_buffers();
            let mut calls = 0;
            let error = problem
                .coupled_imex_ark2_fixed_step_with_external_stage_terms(
                    &mut state,
                    1e-3,
                    &mut ws,
                    &mut bufs,
                    EvaluationRequest::Full,
                    |_m, _time, _stage| {
                        calls += 1;
                        if calls == failure_call {
                            return Err(EngineError::new(format!("stage {failure_call} failed")));
                        }
                        Ok(ExternalStageTerms {
                            additional_field_apm: vec![[0.0, 0.0, 1.0]; 3],
                            direct_torque_per_s: vec![[0.0; 3]; 3],
                        })
                    },
                )
                .expect_err("any stage failure must reject the coupled transaction");
            assert!(error
                .to_string()
                .contains(&format!("stage {failure_call} failed")));
            assert_eq!(state, initial);
        }

        let mut state = initial;
        let mut ws = problem.create_workspace();
        let mut bufs = problem.create_integrator_buffers();
        let mut stage_times = Vec::new();
        let mut stages = Vec::new();
        problem
            .coupled_imex_ark2_fixed_step_with_external_stage_terms(
                &mut state,
                1e-3,
                &mut ws,
                &mut bufs,
                EvaluationRequest::Full,
                |_m, time, stage| {
                    stage_times.push(time);
                    stages.push(stage);
                    Ok(ExternalStageTerms {
                        additional_field_apm: vec![[0.0, 0.0, 1.0]; 3],
                        direct_torque_per_s: vec![[0.0; 3]; 3],
                    })
                },
            )
            .expect("coupled ARS fixed step");
        assert_eq!(stage_times.len(), 4);
        assert_eq!(stage_times[0], 0.0);
        assert!((stage_times[1] - 0.292_893_218_813_452_4e-3).abs() < 1e-15);
        assert_eq!(stage_times[2], 1e-3);
        assert_eq!(stage_times[3], 1e-3);
        assert_eq!(
            stages,
            vec![
                CoupledImexArk2Stage::ExplicitOrigin,
                CoupledImexArk2Stage::ImplicitStageOne,
                CoupledImexArk2Stage::ImplicitStageTwo,
                CoupledImexArk2Stage::AcceptedObservation,
            ]
        );
        assert_eq!(state.time_seconds, 1e-3);
    }

    #[test]
    fn heun_soa_buffer_step_matches_aos_buffer_step_for_supported_terms() {
        let grid = GridShape::new(4, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                external_field: Some([0.03, -0.02, 0.01]),
                per_node_field: Some(vec![
                    [0.0, 0.0, 0.0],
                    [0.01, 0.0, 0.0],
                    [0.0, -0.01, 0.0],
                    [0.0, 0.0, 0.01],
                ]),
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let mut aos_state = problem
            .new_state(vec![
                [1.0, 0.1, 0.0],
                [0.0, 1.0, 0.2],
                [0.2, 0.0, 1.0],
                [1.0, -0.1, 0.1],
            ])
            .expect("state should build");
        let mut soa_state = aos_state.clone();
        let mut aos_ws = problem.create_workspace();
        let mut soa_ws = problem.create_workspace();
        let mut aos_bufs = problem.create_integrator_buffers();
        let mut soa_bufs = problem.create_integrator_buffers();

        let aos_report = problem
            .heun_step_buf(
                &mut aos_state,
                1e-3,
                &mut aos_ws,
                &mut aos_bufs,
                EvaluationRequest::Full,
            )
            .expect("AoS Heun step should succeed");
        let soa_report = problem
            .heun_step_soa_buf(
                &mut soa_state,
                1e-3,
                &mut soa_ws,
                &mut soa_bufs,
                EvaluationRequest::Full,
            )
            .expect("SoA Heun step should succeed");

        for (actual, expected) in soa_state
            .magnetization()
            .iter()
            .zip(aos_state.magnetization())
        {
            assert_vector_close(*actual, *expected, 1e-12);
        }
        assert_step_report_close(soa_report, aos_report, 1e-12);
    }

    #[test]
    fn rk4_soa_buffer_step_matches_aos_buffer_step_for_supported_terms() {
        let grid = GridShape::new(4, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::RK4).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                external_field: Some([0.03, -0.02, 0.01]),
                per_node_field: Some(vec![
                    [0.0, 0.0, 0.0],
                    [0.01, 0.0, 0.0],
                    [0.0, -0.01, 0.0],
                    [0.0, 0.0, 0.01],
                ]),
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let mut aos_state = problem
            .new_state(vec![
                [1.0, 0.1, 0.0],
                [0.0, 1.0, 0.2],
                [0.2, 0.0, 1.0],
                [1.0, -0.1, 0.1],
            ])
            .expect("state should build");
        let mut soa_state = aos_state.clone();
        let mut aos_ws = problem.create_workspace();
        let mut soa_ws = problem.create_workspace();
        let mut aos_bufs = problem.create_integrator_buffers();
        let mut soa_bufs = problem.create_integrator_buffers();

        let aos_report = problem
            .rk4_step_buf(
                &mut aos_state,
                1e-3,
                &mut aos_ws,
                &mut aos_bufs,
                EvaluationRequest::Full,
            )
            .expect("AoS RK4 step should succeed");
        let soa_report = problem
            .rk4_step_soa_buf(
                &mut soa_state,
                1e-3,
                &mut soa_ws,
                &mut soa_bufs,
                EvaluationRequest::Full,
            )
            .expect("SoA RK4 step should succeed");

        for (actual, expected) in soa_state
            .magnetization()
            .iter()
            .zip(aos_state.magnetization())
        {
            assert_vector_close(*actual, *expected, 1e-12);
        }
        assert_step_report_close(soa_report, aos_report, 1e-12);
    }

    #[test]
    fn rk23_soa_buffer_step_matches_aos_buffer_step_for_supported_terms() {
        let grid = GridShape::new(4, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::RK23)
                .expect("valid llg config")
                .with_adaptive(AdaptiveStepConfig {
                    max_error: 1.0,
                    dt_min: 1e-8,
                    dt_max: 1e-2,
                    headroom: 0.8,
                    rtol: 0.0,
                    growth_limit: 2.0,
                    shrink_limit: 0.2,
                }),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                external_field: Some([0.03, -0.02, 0.01]),
                per_node_field: Some(vec![
                    [0.0, 0.0, 0.0],
                    [0.01, 0.0, 0.0],
                    [0.0, -0.01, 0.0],
                    [0.0, 0.0, 0.01],
                ]),
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let mut aos_state = problem
            .new_state(vec![
                [1.0, 0.1, 0.0],
                [0.0, 1.0, 0.2],
                [0.2, 0.0, 1.0],
                [1.0, -0.1, 0.1],
            ])
            .expect("state should build");
        let mut soa_state = aos_state.clone();
        let mut aos_ws = problem.create_workspace();
        let mut soa_ws = problem.create_workspace();
        let mut aos_bufs = problem.create_integrator_buffers();
        let mut soa_bufs = problem.create_integrator_buffers();

        let aos_report = problem
            .rk23_step_buf(
                &mut aos_state,
                1e-3,
                &mut aos_ws,
                &mut aos_bufs,
                EvaluationRequest::Full,
            )
            .expect("AoS RK23 step should succeed");
        let soa_report = problem
            .rk23_step_soa_buf(
                &mut soa_state,
                1e-3,
                &mut soa_ws,
                &mut soa_bufs,
                EvaluationRequest::Full,
            )
            .expect("SoA RK23 step should succeed");

        for (actual, expected) in soa_state
            .magnetization()
            .iter()
            .zip(aos_state.magnetization())
        {
            assert_vector_close(*actual, *expected, 1e-12);
        }
        assert_step_report_close(soa_report, aos_report, 1e-12);
    }

    #[test]
    fn rk45_soa_buffer_step_matches_aos_buffer_step_for_supported_terms() {
        let grid = GridShape::new(4, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::RK45)
                .expect("valid llg config")
                .with_adaptive(AdaptiveStepConfig {
                    max_error: 1.0,
                    dt_min: 1e-8,
                    dt_max: 1e-2,
                    headroom: 0.8,
                    rtol: 0.0,
                    growth_limit: 2.0,
                    shrink_limit: 0.2,
                }),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                external_field: Some([0.03, -0.02, 0.01]),
                per_node_field: Some(vec![
                    [0.0, 0.0, 0.0],
                    [0.01, 0.0, 0.0],
                    [0.0, -0.01, 0.0],
                    [0.0, 0.0, 0.01],
                ]),
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let mut aos_state = problem
            .new_state(vec![
                [1.0, 0.1, 0.0],
                [0.0, 1.0, 0.2],
                [0.2, 0.0, 1.0],
                [1.0, -0.1, 0.1],
            ])
            .expect("state should build");
        let mut soa_state = aos_state.clone();
        let mut aos_ws = problem.create_workspace();
        let mut soa_ws = problem.create_workspace();
        let mut aos_bufs = problem.create_integrator_buffers();
        let mut soa_bufs = problem.create_integrator_buffers();

        let aos_report = problem
            .rk45_step_buf(
                &mut aos_state,
                1e-3,
                &mut aos_ws,
                &mut aos_bufs,
                EvaluationRequest::Full,
            )
            .expect("AoS RK45 step should succeed");
        let soa_report = problem
            .rk45_step_soa_buf(
                &mut soa_state,
                1e-3,
                &mut soa_ws,
                &mut soa_bufs,
                EvaluationRequest::Full,
            )
            .expect("SoA RK45 step should succeed");

        for (actual, expected) in soa_state
            .magnetization()
            .iter()
            .zip(aos_state.magnetization())
        {
            assert_vector_close(*actual, *expected, 1e-12);
        }
        assert_eq!(soa_state.has_fsal(), aos_state.has_fsal());
        for (actual, expected) in soa_state
            .k_fsal
            .as_ref()
            .expect("SoA RK45 should retain FSAL")
            .iter()
            .zip(
                aos_state
                    .k_fsal
                    .as_ref()
                    .expect("AoS RK45 should retain FSAL"),
            )
        {
            assert_vector_close(*actual, *expected, 1e-12);
        }
        assert_step_report_close(soa_report, aos_report, 1e-12);
    }

    #[test]
    fn fixed_rk23_rk45_aos_and_soa_use_exact_dt_without_adaptive_suggestion() {
        for integrator in [TimeIntegrator::RK23, TimeIntegrator::RK45] {
            let problem = ExchangeLlgProblem::with_terms(
                GridShape::new(1, 1, 1).expect("valid grid"),
                CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
                MaterialParameters::new(1.0, 1.0e-30, 0.2).expect("valid material"),
                LlgConfig::new(1.0, integrator).expect("valid fixed LLG config"),
                EffectiveFieldTerms {
                    exchange: false,
                    demag: false,
                    external_field: Some([0.0, 1.0, 0.0]),
                    ..Default::default()
                },
            );
            let dt = 2.0e-3;

            let mut aos = problem.uniform_state([1.0, 0.0, 0.0]).expect("AoS state");
            let mut aos_ws = problem.create_workspace();
            let mut aos_bufs = problem.create_integrator_buffers();
            let aos_report = problem
                .step_with_buffers(&mut aos, dt, &mut aos_ws, &mut aos_bufs)
                .expect("fixed AoS embedded RK step");
            assert_eq!(aos_report.dt_used, dt);
            assert_eq!(aos_report.time_seconds, dt);
            assert_eq!(aos_report.suggested_next_dt, None);

            let mut soa = problem
                .uniform_state([1.0, 0.0, 0.0])
                .expect("SoA seed")
                .to_soa();
            let mut soa_ws = problem.create_workspace();
            let mut soa_bufs = problem.create_integrator_buffers();
            let soa_report = problem
                .step_soa_with_buffers_evaluation(
                    &mut soa,
                    dt,
                    &mut soa_ws,
                    &mut soa_bufs,
                    EvaluationRequest::Full,
                )
                .expect("fixed SoA embedded RK step");
            assert_eq!(soa_report.dt_used, dt);
            assert_eq!(soa_report.time_seconds, dt);
            assert_eq!(soa_report.suggested_next_dt, None);
        }
    }

    #[test]
    fn adaptive_rk23_rk45_aos_and_soa_fail_dt_min_exhausted_without_state_commit() {
        for integrator in [TimeIntegrator::RK23, TimeIntegrator::RK45] {
            let problem = ExchangeLlgProblem::with_terms(
                GridShape::new(1, 1, 1).expect("valid grid"),
                CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
                MaterialParameters::new(1.0, 1.0e-30, 0.2).expect("valid material"),
                LlgConfig::new(10.0, integrator)
                    .expect("valid adaptive LLG config")
                    .with_adaptive(AdaptiveStepConfig {
                        max_error: 1.0e-30,
                        dt_min: 0.2,
                        dt_max: 0.2,
                        headroom: 0.9,
                        rtol: 0.0,
                        growth_limit: 2.0,
                        shrink_limit: 0.2,
                    }),
                EffectiveFieldTerms {
                    exchange: false,
                    demag: false,
                    external_field: Some([0.0, 1.0, 0.0]),
                    ..Default::default()
                },
            );

            let initial = [1.0, 0.0, 0.0];
            let mut aos = problem.uniform_state(initial).expect("AoS state");
            let mut aos_ws = problem.create_workspace();
            let mut aos_bufs = problem.create_integrator_buffers();
            let aos_error = problem
                .step_with_buffers(&mut aos, 0.2, &mut aos_ws, &mut aos_bufs)
                .expect_err("AoS adaptive step must fail at dt_min");
            assert!(aos_error.to_string().contains("dt_min_exhausted"));
            assert_eq!(aos.time_seconds, 0.0);
            assert_eq!(aos.magnetization(), &[initial]);

            let mut soa = problem.uniform_state(initial).expect("SoA seed").to_soa();
            let mut soa_ws = problem.create_workspace();
            let mut soa_bufs = problem.create_integrator_buffers();
            let soa_error = problem
                .step_soa_with_buffers_evaluation(
                    &mut soa,
                    0.2,
                    &mut soa_ws,
                    &mut soa_bufs,
                    EvaluationRequest::Full,
                )
                .expect_err("SoA adaptive step must fail at dt_min");
            assert!(soa_error.to_string().contains("dt_min_exhausted"));
            assert_eq!(soa.time_seconds, 0.0);
            assert_eq!(soa.magnetization.x, vec![initial[0]]);
            assert_eq!(soa.magnetization.y, vec![initial[1]]);
            assert_eq!(soa.magnetization.z, vec![initial[2]]);
        }
    }

    #[test]
    fn abm3_soa_buffer_steps_match_aos_buffer_steps_for_supported_terms() {
        let grid = GridShape::new(4, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::ABM3).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                external_field: Some([0.03, -0.02, 0.01]),
                per_node_field: Some(vec![
                    [0.0, 0.0, 0.0],
                    [0.01, 0.0, 0.0],
                    [0.0, -0.01, 0.0],
                    [0.0, 0.0, 0.01],
                ]),
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let mut aos_state = problem
            .new_state(vec![
                [1.0, 0.1, 0.0],
                [0.0, 1.0, 0.2],
                [0.2, 0.0, 1.0],
                [1.0, -0.1, 0.1],
            ])
            .expect("state should build");
        let mut soa_state = aos_state.clone();
        let mut aos_ws = problem.create_workspace();
        let mut soa_ws = problem.create_workspace();
        let mut aos_bufs = problem.create_integrator_buffers();
        let mut soa_bufs = problem.create_integrator_buffers();

        for _ in 0..4 {
            let aos_report = problem
                .abm3_step_buf(
                    &mut aos_state,
                    1e-3,
                    &mut aos_ws,
                    &mut aos_bufs,
                    EvaluationRequest::Full,
                )
                .expect("AoS ABM3 step should succeed");
            let soa_report = problem
                .abm3_step_soa_buf(
                    &mut soa_state,
                    1e-3,
                    &mut soa_ws,
                    &mut soa_bufs,
                    EvaluationRequest::Full,
                )
                .expect("SoA ABM3 step should succeed");

            for (actual, expected) in soa_state
                .magnetization()
                .iter()
                .zip(aos_state.magnetization())
            {
                assert_vector_close(*actual, *expected, 1e-12);
            }
            assert_step_report_close(soa_report, aos_report, 1e-12);
            assert_abm_history_close(&soa_state.abm_history, &aos_state.abm_history, 1e-12);
        }

        assert!(soa_state.abm_history.is_ready());
    }

    fn demag_soa_problem(integrator: TimeIntegrator) -> ExchangeLlgProblem {
        let grid = GridShape::new(4, 2, 1).expect("valid grid");
        let dynamics = match integrator {
            TimeIntegrator::RK23 | TimeIntegrator::RK45 => LlgConfig::new(1.0, integrator)
                .expect("valid llg config")
                .with_adaptive(AdaptiveStepConfig {
                    max_error: 1.0,
                    dt_min: 1e-8,
                    dt_max: 1e-2,
                    headroom: 0.8,
                    rtol: 0.0,
                    growth_limit: 2.0,
                    shrink_limit: 0.2,
                }),
            _ => LlgConfig::new(1.0, integrator).expect("valid llg config"),
        };
        ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 0.4).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            dynamics,
            EffectiveFieldTerms {
                exchange: false,
                demag: true,
                external_field: Some([0.02, -0.01, 0.03]),
                magnetoelastic: None,
                ..Default::default()
            },
        )
    }

    fn demag_soa_magnetization() -> Vec<Vector3> {
        vec![
            [1.0, 0.1, 0.0],
            [0.2, 1.0, 0.1],
            [0.1, 0.0, 1.0],
            [1.0, -0.2, 0.1],
            [0.0, 1.0, 0.3],
            [0.3, 0.2, 1.0],
            [1.0, 0.0, -0.2],
            [0.1, 1.0, 0.2],
        ]
    }

    #[test]
    fn demag_supported_terms_are_eligible_for_soa_fast_path() {
        let problem = demag_soa_problem(TimeIntegrator::Heun);

        assert!(problem.soa_fast_path_supported());
    }

    #[test]
    fn demag_soa_heun_step_matches_aos_buffer_step() {
        let problem = demag_soa_problem(TimeIntegrator::Heun);

        assert_stepper_aos_soa_match(
            &problem,
            demag_soa_magnetization(),
            ExchangeLlgProblem::heun_step_buf,
            ExchangeLlgProblem::heun_step_soa_buf,
            1,
            "Heun demag",
        );
    }

    #[test]
    fn demag_soa_all_integrators_match_aos_buffer_steps() {
        let magnetization = demag_soa_magnetization();

        let problem = demag_soa_problem(TimeIntegrator::RK4);
        assert_stepper_aos_soa_match(
            &problem,
            magnetization.clone(),
            ExchangeLlgProblem::rk4_step_buf,
            ExchangeLlgProblem::rk4_step_soa_buf,
            1,
            "RK4 demag",
        );

        let problem = demag_soa_problem(TimeIntegrator::RK23);
        assert_stepper_aos_soa_match(
            &problem,
            magnetization.clone(),
            ExchangeLlgProblem::rk23_step_buf,
            ExchangeLlgProblem::rk23_step_soa_buf,
            1,
            "RK23 demag",
        );

        let problem = demag_soa_problem(TimeIntegrator::RK45);
        assert_stepper_aos_soa_match(
            &problem,
            magnetization.clone(),
            ExchangeLlgProblem::rk45_step_buf,
            ExchangeLlgProblem::rk45_step_soa_buf,
            1,
            "RK45 demag",
        );

        let problem = demag_soa_problem(TimeIntegrator::ABM3);
        assert_stepper_aos_soa_match(
            &problem,
            magnetization,
            ExchangeLlgProblem::abm3_step_buf,
            ExchangeLlgProblem::abm3_step_soa_buf,
            4,
            "ABM3 demag",
        );
    }

    fn assert_soa_native_state_matches_aos_dispatch(
        integrator: TimeIntegrator,
        steps: usize,
        stepper_name: &str,
    ) {
        let problem = demag_soa_problem(integrator);
        let mut aos_state = problem
            .new_state(demag_soa_magnetization())
            .expect("AoS state should build");
        let mut soa_state = aos_state.to_soa();
        let mut aos_ws = problem.create_workspace();
        let mut soa_ws = problem.create_workspace();
        let mut aos_bufs = problem.create_integrator_buffers();
        let mut soa_bufs = problem.create_integrator_buffers();

        for _ in 0..steps {
            let aos_report = problem
                .step_with_buffers_evaluation(
                    &mut aos_state,
                    1.0e-3,
                    &mut aos_ws,
                    &mut aos_bufs,
                    EvaluationRequest::Minimal,
                )
                .unwrap_or_else(|err| panic!("AoS {stepper_name} dispatch failed: {err}"));
            let soa_report = problem
                .step_soa_with_buffers_evaluation(
                    &mut soa_state,
                    1.0e-3,
                    &mut soa_ws,
                    &mut soa_bufs,
                    EvaluationRequest::Minimal,
                )
                .unwrap_or_else(|err| panic!("SoA-native {stepper_name} dispatch failed: {err}"));
            assert_step_report_close(soa_report, aos_report, 1e-12);
        }

        let soa_as_aos = soa_state.to_aos();
        for (actual, expected) in soa_as_aos
            .magnetization()
            .iter()
            .zip(aos_state.magnetization())
        {
            assert_vector_close(*actual, *expected, 1e-12);
        }
        assert_eq!(soa_as_aos.has_fsal(), aos_state.has_fsal());
        if let (Some(actual), Some(expected)) = (&soa_as_aos.k_fsal, &aos_state.k_fsal) {
            for (actual, expected) in actual.iter().zip(expected) {
                assert_vector_close(*actual, *expected, 1e-12);
            }
        }
        assert_abm_history_close(&soa_as_aos.abm_history, &aos_state.abm_history, 1e-12);
    }

    #[test]
    fn demag_soa_native_state_all_integrators_match_aos_dispatch() {
        assert_soa_native_state_matches_aos_dispatch(TimeIntegrator::Heun, 1, "Heun demag");
        assert_soa_native_state_matches_aos_dispatch(TimeIntegrator::RK4, 1, "RK4 demag");
        assert_soa_native_state_matches_aos_dispatch(TimeIntegrator::RK23, 1, "RK23 demag");
        assert_soa_native_state_matches_aos_dispatch(TimeIntegrator::RK45, 1, "RK45 demag");
        assert_soa_native_state_matches_aos_dispatch(TimeIntegrator::ABM3, 4, "ABM3 demag");
    }

    #[test]
    fn solver_session_uses_persistent_soa_state_for_supported_demag_problem() {
        let magnetization = demag_soa_magnetization();
        let problem = demag_soa_problem(TimeIntegrator::ABM3);
        let mut session =
            SolverSession::new(problem, magnetization.clone()).expect("session should build");
        assert!(session.soa_fast_path_active());

        let problem = demag_soa_problem(TimeIntegrator::ABM3);
        let mut expected_state = problem
            .new_state(magnetization)
            .expect("state should build")
            .to_soa();
        let mut expected_ws = problem.create_workspace();
        let mut expected_bufs = problem.create_integrator_buffers();

        for _ in 0..4 {
            let actual = session.step(1.0e-3).expect("session step should succeed");
            let expected = problem
                .step_soa_with_buffers_evaluation(
                    &mut expected_state,
                    1.0e-3,
                    &mut expected_ws,
                    &mut expected_bufs,
                    EvaluationRequest::Full,
                )
                .expect("direct SoA step should succeed");
            assert_step_report_close(actual, expected, 1e-12);
            assert!(session.soa_fast_path_active());
        }

        let expected_aos = expected_state.to_aos();
        for (actual, expected) in session
            .magnetization()
            .iter()
            .zip(expected_aos.magnetization())
        {
            assert_vector_close(*actual, *expected, 1e-12);
        }
        assert_abm_history_close(
            &session.state().abm_history,
            &expected_aos.abm_history,
            1e-12,
        );
    }

    struct RecordingDemagBackend {
        calls: usize,
        seen_m: Option<VectorFieldSoA>,
        seen_ms: Option<f64>,
        seen_active_mask: Option<Vec<bool>>,
    }

    impl RecordingDemagBackend {
        fn new() -> Self {
            Self {
                calls: 0,
                seen_m: None,
                seen_ms: None,
                seen_active_mask: None,
            }
        }
    }

    impl crate::fdm::cpu::fft_backend::FdmFftBackend for RecordingDemagBackend {
        fn convolve_demag(
            &mut self,
            m: &VectorFieldSoA,
            saturation_magnetisation: f64,
            active_mask: Option<&[bool]>,
            out_h: &mut VectorFieldSoA,
        ) {
            self.calls += 1;
            self.seen_m = Some(m.clone());
            self.seen_ms = Some(saturation_magnetisation);
            self.seen_active_mask = active_mask.map(|mask| mask.to_vec());

            for i in 0..m.len() {
                if active_mask.map(|mask| mask[i]).unwrap_or(true) {
                    out_h.x[i] += saturation_magnetisation * m.x[i];
                    out_h.y[i] += saturation_magnetisation * m.y[i];
                    out_h.z[i] += saturation_magnetisation * m.z[i];
                }
            }
        }

        fn name(&self) -> &'static str {
            "recording"
        }
    }

    #[test]
    fn soa_effective_field_routes_demag_through_fft_backend() {
        let grid = GridShape::new(3, 1, 1).expect("valid grid");
        let active_mask = vec![true, false, true];
        let problem = ExchangeLlgProblem::with_terms_and_mask(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(2.0, 0.5 * MU0, 0.1).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: true,
                external_field: Some([0.5, 0.25, -0.5]),
                per_node_field: None,
                magnetoelastic: None,
                ..Default::default()
            },
            Some(active_mask.clone()),
        )
        .expect("masked problem should build");

        let magnetization = VectorFieldSoA {
            x: vec![1.0, 0.2, -0.5],
            y: vec![0.0, 1.0, 0.25],
            z: vec![0.5, -0.2, 1.0],
        };
        let mut h_eff = VectorFieldSoA::zeros(grid.cell_count());
        let mut backend = RecordingDemagBackend::new();

        problem.effective_field_into_soa_fft_backend(&magnetization, &mut backend, &mut h_eff);

        assert_eq!(backend.calls, 1);
        assert_eq!(backend.seen_ms, Some(2.0));
        assert_eq!(backend.seen_active_mask, Some(active_mask));
        assert_eq!(backend.seen_m.as_ref(), Some(&magnetization));

        assert_vector_close(
            [h_eff.x[0], h_eff.y[0], h_eff.z[0]],
            [2.5, 0.25, 0.5],
            1e-12,
        );
        assert_vector_close([h_eff.x[1], h_eff.y[1], h_eff.z[1]], [0.0, 0.0, 0.0], 1e-12);
        assert_vector_close(
            [h_eff.x[2], h_eff.y[2], h_eff.z[2]],
            [-0.5, 0.75, 1.5],
            1e-12,
        );
    }

    #[test]
    fn anisotropy_soa_effective_field_matches_aos_for_supported_local_terms() {
        let grid = GridShape::new(4, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: Some([0.03, -0.02, 0.01]),
                per_node_field: Some(vec![
                    [0.0, 0.0, 0.0],
                    [0.01, 0.0, 0.0],
                    [0.0, -0.01, 0.0],
                    [0.0, 0.0, 0.01],
                ]),
                uniaxial_anisotropy: Some(UniaxialAnisotropyConfig {
                    ku1: 0.12 * MU0,
                    ku2: 0.03 * MU0,
                    axis: [0.0, 0.0, 2.0],
                }),
                cubic_anisotropy: Some(CubicAnisotropyConfig {
                    kc1: 0.05 * MU0,
                    kc2: -0.01 * MU0,
                    kc3: 0.0,
                    axis1: [2.0, 0.0, 0.0],
                    axis2: [0.0, 3.0, 0.0],
                }),
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let state = problem
            .new_state(vec![
                [1.0, 0.1, 0.0],
                [0.0, 1.0, 0.2],
                [0.2, 0.0, 1.0],
                [1.0, -0.1, 0.1],
            ])
            .expect("state should build");
        let mut ws = problem.create_workspace();
        let mut aos_field = vec![[0.0, 0.0, 0.0]; grid.cell_count()];
        problem.effective_field_into_ws(state.magnetization(), &mut ws, &mut aos_field);

        let mut soa_m = VectorFieldSoA::zeros(grid.cell_count());
        let mut soa_field = VectorFieldSoA::zeros(grid.cell_count());
        soa_m.scatter_from_aos(state.magnetization());
        let mut soa_ws = problem.create_workspace();
        problem.effective_field_into_soa_ws(&soa_m, &mut soa_ws, &mut soa_field);
        let soa_field = soa_field.gather_to_aos();

        for (actual, expected) in soa_field.iter().zip(aos_field.iter()) {
            assert_vector_close(*actual, *expected, 1e-12);
        }
    }

    #[test]
    fn anisotropy_supported_terms_are_eligible_for_soa_fast_path() {
        let grid = GridShape::new(1, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                uniaxial_anisotropy: Some(UniaxialAnisotropyConfig {
                    ku1: 0.12 * MU0,
                    ku2: 0.03 * MU0,
                    axis: [0.0, 0.0, 1.0],
                }),
                cubic_anisotropy: Some(CubicAnisotropyConfig {
                    kc1: 0.05 * MU0,
                    kc2: -0.01 * MU0,
                    kc3: 0.0,
                    axis1: [1.0, 0.0, 0.0],
                    axis2: [0.0, 1.0, 0.0],
                }),
                magnetoelastic: None,
                ..Default::default()
            },
        );

        assert!(problem.soa_fast_path_supported());
    }

    #[test]
    fn dmi_soa_effective_field_matches_aos_for_supported_stencil_terms() {
        let grid = GridShape::new(3, 3, 3).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.5, 2.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: Some([0.03, -0.02, 0.01]),
                interfacial_dmi: Some(0.04 * MU0),
                bulk_dmi: Some(-0.02 * MU0),
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let magnetization = (0..grid.cell_count())
            .map(|i| {
                let x = i % grid.nx;
                let y = (i / grid.nx) % grid.ny;
                let z = i / (grid.nx * grid.ny);
                [
                    1.0 + 0.11 * x as f64 - 0.03 * z as f64,
                    0.2 + 0.07 * y as f64 + 0.02 * z as f64,
                    0.4 - 0.05 * x as f64 + 0.09 * z as f64,
                ]
            })
            .collect();
        let state = problem
            .new_state(magnetization)
            .expect("state should build");
        let mut ws = problem.create_workspace();
        let mut aos_field = vec![[0.0, 0.0, 0.0]; grid.cell_count()];
        problem.effective_field_into_ws(state.magnetization(), &mut ws, &mut aos_field);

        let mut soa_m = VectorFieldSoA::zeros(grid.cell_count());
        let mut soa_field = VectorFieldSoA::zeros(grid.cell_count());
        soa_m.scatter_from_aos(state.magnetization());
        let mut soa_ws = problem.create_workspace();
        problem.effective_field_into_soa_ws(&soa_m, &mut soa_ws, &mut soa_field);
        let soa_field = soa_field.gather_to_aos();

        for (actual, expected) in soa_field.iter().zip(aos_field.iter()) {
            assert_vector_close(*actual, *expected, 1e-12);
        }
    }

    #[test]
    fn dmi_supported_terms_are_eligible_for_soa_fast_path() {
        let grid = GridShape::new(3, 3, 3).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.5, 2.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                interfacial_dmi: Some(0.04 * MU0),
                bulk_dmi: Some(-0.02 * MU0),
                magnetoelastic: None,
                ..Default::default()
            },
        );

        assert!(problem.soa_fast_path_supported());
    }

    #[test]
    fn thermal_soa_effective_field_matches_aos_for_supported_local_terms() {
        let grid = GridShape::new(4, 1, 1).expect("valid grid");
        let mut problem = ExchangeLlgProblem::with_terms_and_mask(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: Some([0.03, -0.02, 0.01]),
                magnetoelastic: None,
                ..Default::default()
            },
            Some(vec![true, false, true, true]),
        )
        .expect("masked problem should build");
        problem.temperature = 300.0;
        problem.thermal_dt = 2e-13;
        problem.thermal_seed = 1234;
        problem.advance_thermal_step();

        let state = problem
            .new_state(vec![
                [1.0, 0.1, 0.0],
                [0.0, 1.0, 0.2],
                [0.2, 0.0, 1.0],
                [1.0, -0.1, 0.1],
            ])
            .expect("state should build");
        let mut ws = problem.create_workspace();
        let mut aos_field = vec![[0.0, 0.0, 0.0]; grid.cell_count()];
        problem.effective_field_into_ws(state.magnetization(), &mut ws, &mut aos_field);

        let mut soa_m = VectorFieldSoA::zeros(grid.cell_count());
        let mut soa_field = VectorFieldSoA::zeros(grid.cell_count());
        soa_m.scatter_from_aos(state.magnetization());
        let mut soa_ws = problem.create_workspace();
        problem.effective_field_into_soa_ws(&soa_m, &mut soa_ws, &mut soa_field);
        let soa_field = soa_field.gather_to_aos();

        for (actual, expected) in soa_field.iter().zip(aos_field.iter()) {
            assert_vector_close(*actual, *expected, 1e-12);
        }
    }

    #[test]
    fn thermal_supported_terms_are_eligible_for_soa_fast_path() {
        let grid = GridShape::new(4, 1, 1).expect("valid grid");
        let mut problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                external_field: Some([0.03, -0.02, 0.01]),
                magnetoelastic: None,
                ..Default::default()
            },
        );
        problem.temperature = 300.0;
        problem.thermal_dt = 2e-13;

        assert!(problem.soa_fast_path_supported());
    }

    #[test]
    fn magnetoelastic_soa_effective_field_matches_aos_for_prescribed_strain() {
        let grid = GridShape::new(4, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms_and_mask(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: Some([0.03, -0.02, 0.01]),
                magnetoelastic: Some(MagnetoelasticTermConfig {
                    params: magnetoelastic::MagnetoelasticParams {
                        b1: 0.2 * MU0,
                        b2: -0.08 * MU0,
                        ms: 1.0,
                    },
                    strain: magnetoelastic::PrescribedStrainField::PerCell(vec![
                        [0.10, -0.05, 0.02, 0.04, -0.03, 0.01],
                        [0.03, 0.02, -0.01, -0.02, 0.05, 0.04],
                        [-0.04, 0.06, 0.03, 0.01, 0.02, -0.05],
                        [0.02, -0.03, 0.04, 0.03, -0.01, 0.02],
                    ]),
                }),
                ..Default::default()
            },
            Some(vec![true, true, false, true]),
        )
        .expect("masked problem should build");
        let state = problem
            .new_state(vec![
                [1.0, 0.1, 0.0],
                [0.0, 1.0, 0.2],
                [0.2, 0.0, 1.0],
                [1.0, -0.1, 0.1],
            ])
            .expect("state should build");
        let mut ws = problem.create_workspace();
        let mut aos_field = vec![[0.0, 0.0, 0.0]; grid.cell_count()];
        problem.effective_field_into_ws(state.magnetization(), &mut ws, &mut aos_field);

        let mut soa_m = VectorFieldSoA::zeros(grid.cell_count());
        let mut soa_field = VectorFieldSoA::zeros(grid.cell_count());
        soa_m.scatter_from_aos(state.magnetization());
        let mut soa_ws = problem.create_workspace();
        problem.effective_field_into_soa_ws(&soa_m, &mut soa_ws, &mut soa_field);
        let soa_field = soa_field.gather_to_aos();

        for (actual, expected) in soa_field.iter().zip(aos_field.iter()) {
            assert_vector_close(*actual, *expected, 1e-12);
        }
    }

    #[test]
    fn soa_full_step_observables_match_aos_for_local_energy_terms() {
        let grid = GridShape::new(4, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms_and_mask(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: Some([0.03, -0.02, 0.01]),
                uniaxial_anisotropy: Some(UniaxialAnisotropyConfig {
                    ku1: 0.12 * MU0,
                    ku2: 0.03 * MU0,
                    axis: [0.0, 0.0, 2.0],
                }),
                cubic_anisotropy: Some(CubicAnisotropyConfig {
                    kc1: 0.05 * MU0,
                    kc2: -0.01 * MU0,
                    kc3: 0.0,
                    axis1: [2.0, 0.0, 0.0],
                    axis2: [0.0, 3.0, 0.0],
                }),
                magnetoelastic: Some(MagnetoelasticTermConfig {
                    params: magnetoelastic::MagnetoelasticParams {
                        b1: 0.2 * MU0,
                        b2: -0.08 * MU0,
                        ms: 1.0,
                    },
                    strain: magnetoelastic::PrescribedStrainField::PerCell(vec![
                        [0.10, -0.05, 0.02, 0.04, -0.03, 0.01],
                        [0.03, 0.02, -0.01, -0.02, 0.05, 0.04],
                        [-0.04, 0.06, 0.03, 0.01, 0.02, -0.05],
                        [0.02, -0.03, 0.04, 0.03, -0.01, 0.02],
                    ]),
                }),
                ..Default::default()
            },
            Some(vec![true, true, false, true]),
        )
        .expect("masked problem should build");
        let mut aos_state = problem
            .new_state(vec![
                [1.0, 0.1, 0.0],
                [0.0, 1.0, 0.2],
                [0.2, 0.0, 1.0],
                [1.0, -0.1, 0.1],
            ])
            .expect("state should build");
        let mut soa_state = aos_state.clone();
        let mut aos_ws = problem.create_workspace();
        let mut soa_ws = problem.create_workspace();
        let mut aos_bufs = problem.create_integrator_buffers();
        let mut soa_bufs = problem.create_integrator_buffers();

        let aos_report = problem
            .heun_step_buf(
                &mut aos_state,
                1e-3,
                &mut aos_ws,
                &mut aos_bufs,
                EvaluationRequest::Full,
            )
            .expect("AoS Heun step should succeed");
        let soa_report = problem
            .heun_step_soa_buf(
                &mut soa_state,
                1e-3,
                &mut soa_ws,
                &mut soa_bufs,
                EvaluationRequest::Full,
            )
            .expect("SoA Heun step should succeed");

        for (actual, expected) in soa_state
            .magnetization()
            .iter()
            .zip(aos_state.magnetization())
        {
            assert_vector_close(*actual, *expected, 1e-12);
        }
        assert_step_report_close(soa_report, aos_report, 1e-12);
    }

    #[test]
    fn magnetoelastic_supported_terms_are_eligible_for_soa_fast_path() {
        let grid = GridShape::new(1, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                magnetoelastic: Some(MagnetoelasticTermConfig {
                    params: magnetoelastic::MagnetoelasticParams {
                        b1: 0.2 * MU0,
                        b2: -0.08 * MU0,
                        ms: 1.0,
                    },
                    strain: magnetoelastic::PrescribedStrainField::Uniform([
                        0.10, -0.05, 0.02, 0.04, -0.03, 0.01,
                    ]),
                }),
                ..Default::default()
            },
        );

        assert!(problem.soa_fast_path_supported());
    }

    #[test]
    fn slonczewski_direct_torque_soa_heun_step_matches_aos_and_moves_state() {
        let grid = GridShape::new(1, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                slonczewski_stt: Some(SlonczewskiSttConfig {
                    formula: SlonczewskiFormula::LegacyFullmagV0,
                    current_density_magnitude: 1.0e6,
                    spin_polarization_axis: [0.0, 1.0, 0.0],
                    lambda: 1.0,
                    epsilon_prime: 0.0,
                    degree: 1.0,
                    thickness: 1.0,
                    current_sign: 1.0,
                    active_mask: None,
                }),
                ..Default::default()
            },
        );

        assert_heun_aos_soa_direct_torque_match(&problem, vec![[1.0, 0.0, 0.0]]);
    }

    #[test]
    fn slonczewski_direct_torque_soa_all_integrators_match_aos() {
        let grid = GridShape::new(1, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun)
                .expect("valid llg config")
                .with_adaptive(AdaptiveStepConfig {
                    max_error: 1.0,
                    dt_min: 1.0e-12,
                    dt_max: 1.0e-2,
                    headroom: 0.9,
                    rtol: 0.0,
                    growth_limit: f64::INFINITY,
                    shrink_limit: 0.0,
                }),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                slonczewski_stt: Some(SlonczewskiSttConfig {
                    formula: SlonczewskiFormula::LegacyFullmagV0,
                    current_density_magnitude: 1.0e6,
                    spin_polarization_axis: [0.0, 1.0, 0.0],
                    lambda: 1.0,
                    epsilon_prime: 0.0,
                    degree: 1.0,
                    thickness: 1.0,
                    current_sign: 1.0,
                    active_mask: None,
                }),
                ..Default::default()
            },
        );
        let magnetization = vec![[1.0, 0.0, 0.0]];

        assert_stepper_aos_soa_direct_torque_match(
            &problem,
            magnetization.clone(),
            ExchangeLlgProblem::heun_step_buf,
            ExchangeLlgProblem::heun_step_soa_buf,
            1,
            "Heun",
        );
        assert_stepper_aos_soa_direct_torque_match(
            &problem,
            magnetization.clone(),
            ExchangeLlgProblem::rk4_step_buf,
            ExchangeLlgProblem::rk4_step_soa_buf,
            1,
            "RK4",
        );
        assert_stepper_aos_soa_direct_torque_match(
            &problem,
            magnetization.clone(),
            ExchangeLlgProblem::rk23_step_buf,
            ExchangeLlgProblem::rk23_step_soa_buf,
            1,
            "RK23",
        );
        assert_stepper_aos_soa_direct_torque_match(
            &problem,
            magnetization.clone(),
            ExchangeLlgProblem::rk45_step_buf,
            ExchangeLlgProblem::rk45_step_soa_buf,
            1,
            "RK45",
        );
        assert_stepper_aos_soa_direct_torque_match(
            &problem,
            magnetization,
            ExchangeLlgProblem::abm3_step_buf,
            ExchangeLlgProblem::abm3_step_soa_buf,
            4,
            "ABM3",
        );
    }

    #[test]
    fn zhang_li_direct_torque_soa_heun_step_matches_aos_and_moves_state() {
        let grid = GridShape::new(3, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                zhang_li_stt: Some(ZhangLiSttConfig {
                    formula: ZhangLiFormula::LegacyFullmagV0,
                    current_density: [1.0e3, 0.0, 0.0],
                    spin_polarization: 1.0,
                    non_adiabaticity: 0.2,
                }),
                ..Default::default()
            },
        );

        assert_heun_aos_soa_direct_torque_match(
            &problem,
            vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        );
    }

    #[test]
    fn sot_direct_torque_soa_heun_step_matches_aos_and_moves_state() {
        let grid = GridShape::new(2, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                sot: Some(SotConfig {
                    formula: SotFormula::FullmagV1,
                    current_density: 1.0e6,
                    xi_dl: 1.0,
                    xi_fl: 0.0,
                    sigma: [0.0, 1.0, 0.0],
                    thickness: 1.0,
                    active_mask: Some(vec![true, false]),
                    envelope: None,
                }),
                ..Default::default()
            },
        );

        assert_heun_aos_soa_direct_torque_match(&problem, vec![[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]]);
    }

    #[test]
    fn prescribed_sot_mask_length_is_rejected_during_problem_construction() {
        let result = ExchangeLlgProblem::with_terms_and_mask(
            GridShape::new(2, 1, 1).unwrap(),
            CellSize::new(1.0, 1.0, 1.0).unwrap(),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).unwrap(),
            LlgConfig::new(1.0, TimeIntegrator::Heun).unwrap(),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                sot: Some(SotConfig {
                    formula: SotFormula::FullmagV1,
                    current_density: 1.0e6,
                    xi_dl: 1.0,
                    xi_fl: 0.0,
                    sigma: [0.0, 1.0, 0.0],
                    thickness: 1.0,
                    active_mask: Some(vec![true]),
                    envelope: None,
                }),
                ..Default::default()
            },
            None,
        );
        assert!(result
            .expect_err("short SOT mask must fail construction")
            .to_string()
            .contains("prescribed SOT active_mask length"));
    }

    #[test]
    fn direct_spin_torque_terms_are_eligible_for_soa_fast_path() {
        let grid = GridShape::new(3, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                zhang_li_stt: Some(ZhangLiSttConfig {
                    formula: ZhangLiFormula::LegacyFullmagV0,
                    current_density: [1.0e3, 0.0, 0.0],
                    spin_polarization: 1.0,
                    non_adiabaticity: 0.2,
                }),
                slonczewski_stt: Some(SlonczewskiSttConfig {
                    formula: SlonczewskiFormula::LegacyFullmagV0,
                    current_density_magnitude: 1.0e6,
                    spin_polarization_axis: [0.0, 1.0, 0.0],
                    lambda: 1.0,
                    epsilon_prime: 0.0,
                    degree: 1.0,
                    thickness: 1.0,
                    current_sign: 1.0,
                    active_mask: None,
                }),
                sot: Some(SotConfig {
                    formula: SotFormula::FullmagV1,
                    current_density: 1.0e6,
                    xi_dl: 1.0,
                    xi_fl: 0.0,
                    sigma: [0.0, 1.0, 0.0],
                    thickness: 1.0,
                    active_mask: None,
                    envelope: None,
                }),
                ..Default::default()
            },
        );

        assert!(problem.soa_fast_path_supported());
    }

    #[test]
    fn oersted_soa_effective_field_matches_aos_for_supported_local_terms() {
        let grid = GridShape::new(3, 3, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms_and_mask(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: Some([0.03, -0.02, 0.01]),
                oersted_cylinder: Some(OerstedCylinderConfig {
                    current: 2.0,
                    radius: 1.25,
                    center: [1.5, 1.5, 0.0],
                    axis: [0.0, 0.0, 2.0],
                    time_dep_kind: 0,
                    time_dep_freq: 0.0,
                    time_dep_phase: 0.0,
                    time_dep_offset: 0.0,
                    time_dep_t_on: 0.0,
                    time_dep_t_off: 0.0,
                }),
                magnetoelastic: None,
                ..Default::default()
            },
            Some(vec![true, true, true, true, true, false, true, true, true]),
        )
        .expect("masked problem should build");
        let state = problem
            .new_state(vec![[1.0, 0.0, 0.0]; grid.cell_count()])
            .expect("state should build");
        let mut ws = problem.create_workspace();
        let mut aos_field = vec![[0.0, 0.0, 0.0]; grid.cell_count()];
        problem.effective_field_into_ws(state.magnetization(), &mut ws, &mut aos_field);

        let mut soa_m = VectorFieldSoA::zeros(grid.cell_count());
        let mut soa_field = VectorFieldSoA::zeros(grid.cell_count());
        soa_m.scatter_from_aos(state.magnetization());
        let mut soa_ws = problem.create_workspace();
        problem.effective_field_into_soa_ws(&soa_m, &mut soa_ws, &mut soa_field);
        let soa_field = soa_field.gather_to_aos();

        for (actual, expected) in soa_field.iter().zip(aos_field.iter()) {
            assert_vector_close(*actual, *expected, 1e-12);
        }
    }

    #[test]
    fn oersted_cylinder_energy_matches_rhs_field_across_scalar_paths() {
        let grid = GridShape::new(2, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(2.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                oersted_cylinder: Some(OerstedCylinderConfig {
                    current: 2.0,
                    radius: 1.0,
                    center: [0.0, 0.0, 0.0],
                    axis: [0.0, 0.0, 1.0],
                    time_dep_kind: 0,
                    time_dep_freq: 0.0,
                    time_dep_phase: 0.0,
                    time_dep_offset: 0.0,
                    time_dep_t_on: 0.0,
                    time_dep_t_off: 0.0,
                }),
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let theta = std::f64::consts::FRAC_PI_4;
        let magnetization = vec![[theta.cos(), theta.sin(), 0.0]; grid.cell_count()];

        let mut field_workspace = problem.create_workspace();
        let mut effective_field = vec![[0.0, 0.0, 0.0]; grid.cell_count()];
        problem.effective_field_into_ws(&magnetization, &mut field_workspace, &mut effective_field);
        let expected_energy = -MU0
            * problem.material.saturation_magnetisation
            * problem.cell_size.volume()
            * magnetization
                .iter()
                .zip(&effective_field)
                .map(|(m, h)| dot(*m, *h))
                .sum::<f64>();

        let mut report_workspace = problem.create_workspace();
        let mut buffers = problem.create_integrator_buffers();
        let report = problem.compute_step_observables(
            &magnetization,
            &mut report_workspace,
            &mut buffers.h_eff,
            &mut buffers.h_scratch,
            &mut buffers.rhs,
            EvaluationRequest::Full,
        );
        let mut aos_workspace = problem.create_workspace();
        let aos_energy = problem.total_energy_from_vectors_ws(&magnetization, &mut aos_workspace);
        let soa_magnetization = VectorFieldSoA::from_aos(&magnetization);
        let mut soa_workspace = problem.create_workspace();
        let mut soa_scratch = VectorFieldSoA::zeros(grid.cell_count());
        let soa_energy = problem.total_energy_from_soa_ws(
            &soa_magnetization,
            &mut soa_workspace,
            &mut soa_scratch,
        );

        for (label, actual) in [
            ("StepReport external", report.external_energy_joules),
            ("StepReport total", report.total_energy_joules),
            ("AoS total", aos_energy),
            ("SoA total", soa_energy),
        ] {
            assert!(
                (actual - expected_energy).abs() <= 1e-18,
                "{label} Oersted energy differs: {actual} vs {expected_energy}"
            );
        }

        let epsilon = 1e-6_f64;
        let plus = vec![[(theta + epsilon).cos(), (theta + epsilon).sin(), 0.0]; grid.cell_count()];
        let minus =
            vec![[(theta - epsilon).cos(), (theta - epsilon).sin(), 0.0]; grid.cell_count()];
        let mut derivative_workspace = problem.create_workspace();
        let derivative = (problem.total_energy_from_vectors_ws(&plus, &mut derivative_workspace)
            - problem.total_energy_from_vectors_ws(&minus, &mut derivative_workspace))
            / (2.0 * epsilon);
        let expected_derivative = -MU0
            * problem.material.saturation_magnetisation
            * problem.cell_size.volume()
            * effective_field
                .iter()
                .map(|h| -theta.sin() * h[0] + theta.cos() * h[1])
                .sum::<f64>();
        assert!(
            (derivative - expected_derivative).abs() <= 1e-15,
            "Oersted energy derivative differs: {derivative} vs {expected_derivative}"
        );
    }

    #[test]
    fn oersted_full_step_observables_match_minimal_field_metrics() {
        let grid = GridShape::new(3, 3, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: None,
                oersted_cylinder: Some(OerstedCylinderConfig {
                    current: 2.0,
                    radius: 1.25,
                    center: [1.5, 1.5, 0.0],
                    axis: [0.0, 0.0, 2.0],
                    time_dep_kind: 0,
                    time_dep_freq: 0.0,
                    time_dep_phase: 0.0,
                    time_dep_offset: 0.0,
                    time_dep_t_on: 0.0,
                    time_dep_t_off: 0.0,
                }),
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let magnetization = vec![[1.0, 0.0, 0.0]; grid.cell_count()];

        let mut aos_full_state = problem
            .new_state(magnetization.clone())
            .expect("full AoS state should build");
        let mut aos_minimal_state = problem
            .new_state(magnetization.clone())
            .expect("minimal AoS state should build");
        let mut aos_full_ws = problem.create_workspace();
        let mut aos_minimal_ws = problem.create_workspace();
        let mut aos_full_bufs = problem.create_integrator_buffers();
        let mut aos_minimal_bufs = problem.create_integrator_buffers();

        let aos_full_report = problem
            .heun_step_buf(
                &mut aos_full_state,
                1e-3,
                &mut aos_full_ws,
                &mut aos_full_bufs,
                EvaluationRequest::Full,
            )
            .expect("AoS full step should succeed");
        let aos_minimal_report = problem
            .heun_step_buf(
                &mut aos_minimal_state,
                1e-3,
                &mut aos_minimal_ws,
                &mut aos_minimal_bufs,
                EvaluationRequest::Minimal,
            )
            .expect("AoS minimal step should succeed");

        assert!(aos_minimal_report.max_effective_field_amplitude > 0.0);
        assert!(aos_full_report.external_energy_joules.abs() > 0.0);
        assert_eq!(
            aos_full_report.total_energy_joules,
            aos_full_report.external_energy_joules
        );
        assert_eq!(aos_minimal_report.external_energy_joules, 0.0);
        assert_eq!(aos_minimal_report.total_energy_joules, 0.0);
        assert_step_report_dynamics_close(aos_full_report, aos_minimal_report, 1e-12);

        let mut soa_full_state = problem
            .new_state(magnetization.clone())
            .expect("full SoA state should build");
        let mut soa_minimal_state = problem
            .new_state(magnetization)
            .expect("minimal SoA state should build");
        let mut soa_full_ws = problem.create_workspace();
        let mut soa_minimal_ws = problem.create_workspace();
        let mut soa_full_bufs = problem.create_integrator_buffers();
        let mut soa_minimal_bufs = problem.create_integrator_buffers();

        let soa_full_report = problem
            .heun_step_soa_buf(
                &mut soa_full_state,
                1e-3,
                &mut soa_full_ws,
                &mut soa_full_bufs,
                EvaluationRequest::Full,
            )
            .expect("SoA full step should succeed");
        let soa_minimal_report = problem
            .heun_step_soa_buf(
                &mut soa_minimal_state,
                1e-3,
                &mut soa_minimal_ws,
                &mut soa_minimal_bufs,
                EvaluationRequest::Minimal,
            )
            .expect("SoA minimal step should succeed");

        assert_step_report_close(soa_full_report, aos_full_report, 1e-12);
        assert_step_report_close(soa_minimal_report, aos_minimal_report, 1e-12);
    }

    fn dynamic_oersted_problem(
        integrator: TimeIntegrator,
        t_on: f64,
        t_off: f64,
    ) -> ExchangeLlgProblem {
        let adaptive = AdaptiveStepConfig {
            max_error: 1.0,
            dt_min: 1.0e-3,
            dt_max: 1.0e-3,
            headroom: 0.8,
            rtol: 0.0,
            growth_limit: 1.0,
            shrink_limit: 1.0,
        };
        ExchangeLlgProblem::with_terms(
            GridShape::new(1, 1, 1).expect("valid grid"),
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 1.0e-30, 0.1).expect("valid material"),
            LlgConfig::new(1.0, integrator)
                .expect("valid LLG config")
                .with_adaptive(adaptive),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                oersted_cylinder: Some(OerstedCylinderConfig {
                    current: 2.0,
                    radius: 0.25,
                    center: [0.0, 0.5, 0.5],
                    axis: [0.0, 0.0, 1.0],
                    time_dep_kind: 2,
                    time_dep_freq: 0.0,
                    time_dep_phase: 0.0,
                    time_dep_offset: 0.0,
                    time_dep_t_on: t_on,
                    time_dep_t_off: t_off,
                }),
                ..Default::default()
            },
        )
    }

    fn assert_dynamic_oersted_stage_time(
        integrator: TimeIntegrator,
        stage_fraction: f64,
        aos_step: BufferStepper,
        soa_step: BufferStepper,
    ) {
        let dt = 1.0e-3;
        let half_width = 1.0e-6;
        let active_problem = dynamic_oersted_problem(
            integrator,
            stage_fraction * dt - half_width,
            stage_fraction * dt + half_width,
        );
        let inactive_problem = dynamic_oersted_problem(integrator, 2.0 * dt, 3.0 * dt);

        let run = |problem: &ExchangeLlgProblem, step: BufferStepper| {
            let mut state = problem
                .new_state(vec![[1.0, 0.0, 0.0]])
                .expect("state should build");
            let mut ws = problem.create_workspace();
            let mut bufs = problem.create_integrator_buffers();
            step(
                problem,
                &mut state,
                dt,
                &mut ws,
                &mut bufs,
                EvaluationRequest::Minimal,
            )
            .expect("dynamic Oersted step should succeed");
            state.magnetization()[0]
        };

        let aos_active = run(&active_problem, aos_step);
        let soa_active = run(&active_problem, soa_step);
        let aos_inactive = run(&inactive_problem, aos_step);
        let soa_inactive = run(&inactive_problem, soa_step);

        assert!(
            (aos_active[1].abs() + aos_active[2].abs()) > 1.0e-12,
            "{integrator:?} must evaluate the Oersted pulse at its RK stage time"
        );
        assert_vector_close(aos_active, soa_active, 1.0e-12);
        assert_vector_close(aos_inactive, [1.0, 0.0, 0.0], 1.0e-15);
        assert_vector_close(soa_inactive, [1.0, 0.0, 0.0], 1.0e-15);
    }

    fn assert_dynamic_oersted_persistent_soa_stage_time(
        integrator: TimeIntegrator,
        stage_fraction: f64,
        step: PersistentSoAStepper,
    ) {
        let dt = 1.0e-3;
        let half_width = 1.0e-6;
        let active_problem = dynamic_oersted_problem(
            integrator,
            stage_fraction * dt - half_width,
            stage_fraction * dt + half_width,
        );
        let inactive_problem = dynamic_oersted_problem(integrator, 2.0 * dt, 3.0 * dt);

        let run = |problem: &ExchangeLlgProblem| {
            let mut state = problem
                .new_state(vec![[1.0, 0.0, 0.0]])
                .expect("state should build")
                .to_soa();
            let mut ws = problem.create_workspace();
            let mut bufs = problem.create_integrator_buffers();
            step(
                problem,
                &mut state,
                dt,
                &mut ws,
                &mut bufs,
                EvaluationRequest::Minimal,
            )
            .expect("persistent SoA dynamic Oersted step should succeed");
            state.magnetization().gather_to_aos()[0]
        };

        let active = run(&active_problem);
        let inactive = run(&inactive_problem);
        assert!(
            (active[1].abs() + active[2].abs()) > 1.0e-12,
            "{integrator:?} persistent SoA path must evaluate the Oersted pulse at stage time"
        );
        assert_vector_close(inactive, [1.0, 0.0, 0.0], 1.0e-15);
    }

    #[test]
    fn dynamic_oersted_uses_stage_time_in_every_cpu_integrator_and_layout() {
        assert_dynamic_oersted_stage_time(
            TimeIntegrator::Heun,
            1.0,
            ExchangeLlgProblem::heun_step_buf,
            ExchangeLlgProblem::heun_step_soa_buf,
        );
        assert_dynamic_oersted_stage_time(
            TimeIntegrator::RK4,
            0.5,
            ExchangeLlgProblem::rk4_step_buf,
            ExchangeLlgProblem::rk4_step_soa_buf,
        );
        assert_dynamic_oersted_stage_time(
            TimeIntegrator::RK23,
            0.75,
            ExchangeLlgProblem::rk23_step_buf,
            ExchangeLlgProblem::rk23_step_soa_buf,
        );
        assert_dynamic_oersted_stage_time(
            TimeIntegrator::RK45,
            0.8,
            ExchangeLlgProblem::rk45_step_buf,
            ExchangeLlgProblem::rk45_step_soa_buf,
        );
        assert_dynamic_oersted_stage_time(
            TimeIntegrator::ABM3,
            1.0,
            ExchangeLlgProblem::abm3_step_buf,
            ExchangeLlgProblem::abm3_step_soa_buf,
        );
    }

    #[test]
    fn dynamic_oersted_uses_stage_time_in_every_persistent_soa_integrator() {
        assert_dynamic_oersted_persistent_soa_stage_time(
            TimeIntegrator::Heun,
            1.0,
            ExchangeLlgProblem::heun_step_soa_state_buf,
        );
        assert_dynamic_oersted_persistent_soa_stage_time(
            TimeIntegrator::RK4,
            0.5,
            ExchangeLlgProblem::rk4_step_soa_state_buf,
        );
        assert_dynamic_oersted_persistent_soa_stage_time(
            TimeIntegrator::RK23,
            0.75,
            ExchangeLlgProblem::rk23_step_soa_state_buf,
        );
        assert_dynamic_oersted_persistent_soa_stage_time(
            TimeIntegrator::RK45,
            0.8,
            ExchangeLlgProblem::rk45_step_soa_state_buf,
        );
        assert_dynamic_oersted_persistent_soa_stage_time(
            TimeIntegrator::ABM3,
            1.0,
            ExchangeLlgProblem::abm3_step_soa_state_buf,
        );
    }

    fn run_dynamic_oersted_abm3_full_branch_aos(
        problem: &ExchangeLlgProblem,
        step: BufferStepper,
    ) -> [f64; 3] {
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0]])
            .expect("ABM3 AoS/scatter state should build");
        let mut ws = problem.create_workspace();
        let mut bufs = problem.create_integrator_buffers();
        for _ in 0..4 {
            step(
                problem,
                &mut state,
                1.0e-3,
                &mut ws,
                &mut bufs,
                EvaluationRequest::Minimal,
            )
            .expect("ABM3 AoS/scatter full-branch step should succeed");
        }
        state.magnetization()[0]
    }

    fn run_dynamic_oersted_abm3_full_branch_persistent(problem: &ExchangeLlgProblem) -> [f64; 3] {
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0]])
            .expect("ABM3 persistent SoA state should build")
            .to_soa();
        let mut ws = problem.create_workspace();
        let mut bufs = problem.create_integrator_buffers();
        for _ in 0..4 {
            problem
                .abm3_step_soa_state_buf(
                    &mut state,
                    1.0e-3,
                    &mut ws,
                    &mut bufs,
                    EvaluationRequest::Minimal,
                )
                .expect("ABM3 persistent SoA full-branch step should succeed");
        }
        state.magnetization().gather_to_aos()[0]
    }

    #[test]
    fn dynamic_oersted_uses_endpoint_time_in_full_abm3_branch_for_all_cpu_layouts() {
        let dt = 1.0e-3;
        let half_width = 1.0e-6;
        let active = dynamic_oersted_problem(
            TimeIntegrator::ABM3,
            4.0 * dt - half_width,
            4.0 * dt + half_width,
        );
        let inactive = dynamic_oersted_problem(TimeIntegrator::ABM3, 6.0 * dt, 7.0 * dt);

        let aos_active =
            run_dynamic_oersted_abm3_full_branch_aos(&active, ExchangeLlgProblem::abm3_step_buf);
        let aos_inactive =
            run_dynamic_oersted_abm3_full_branch_aos(&inactive, ExchangeLlgProblem::abm3_step_buf);
        let scatter_active = run_dynamic_oersted_abm3_full_branch_aos(
            &active,
            ExchangeLlgProblem::abm3_step_soa_buf,
        );
        let scatter_inactive = run_dynamic_oersted_abm3_full_branch_aos(
            &inactive,
            ExchangeLlgProblem::abm3_step_soa_buf,
        );
        let persistent_active = run_dynamic_oersted_abm3_full_branch_persistent(&active);
        let persistent_inactive = run_dynamic_oersted_abm3_full_branch_persistent(&inactive);

        for (label, driven, baseline) in [
            ("AoS", aos_active, aos_inactive),
            ("scatter SoA", scatter_active, scatter_inactive),
            ("persistent SoA", persistent_active, persistent_inactive),
        ] {
            assert!(
                (driven[1] - baseline[1]).abs() + (driven[2] - baseline[2]).abs() > 1.0e-12,
                "{label} full ABM3 branch must evaluate Oersted at predictor endpoint time"
            );
        }
        assert_vector_close(aos_active, scatter_active, 1.0e-12);
        assert_vector_close(aos_active, persistent_active, 1.0e-12);
    }

    #[test]
    fn dynamic_oersted_final_report_is_refreshed_at_accepted_time() {
        let dt = 1.0e-3;
        let problem = dynamic_oersted_problem(TimeIntegrator::Heun, dt, 2.0 * dt);
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0]])
            .expect("state should build");
        let mut ws = problem.create_workspace();
        let mut bufs = problem.create_integrator_buffers();

        let report = problem
            .heun_step_buf(&mut state, dt, &mut ws, &mut bufs, EvaluationRequest::Full)
            .expect("dynamic Oersted step should succeed");
        let mut final_field = vec![[0.0; 3]; 1];
        problem.effective_field_into_ws_at_time(
            state.magnetization(),
            &mut ws,
            &mut final_field,
            state.time_seconds,
        );

        assert!(report.max_effective_field_amplitude > 0.0);
        assert!((report.max_effective_field_amplitude - norm(final_field[0])).abs() <= 1.0e-12);
    }

    #[test]
    fn dynamic_oersted_persistent_soa_final_report_is_refreshed_at_accepted_time() {
        let dt = 1.0e-3;
        let problem = dynamic_oersted_problem(TimeIntegrator::Heun, dt, 2.0 * dt);
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0]])
            .expect("state should build")
            .to_soa();
        let mut ws = problem.create_workspace();
        let mut bufs = problem.create_integrator_buffers();

        let report = problem
            .heun_step_soa_state_buf(&mut state, dt, &mut ws, &mut bufs, EvaluationRequest::Full)
            .expect("persistent SoA dynamic Oersted step should succeed");
        let final_m = state.magnetization().gather_to_aos();
        let mut final_field = vec![[0.0; 3]; 1];
        problem.effective_field_into_ws_at_time(
            &final_m,
            &mut ws,
            &mut final_field,
            state.time_seconds,
        );

        assert!(report.max_effective_field_amplitude > 0.0);
        assert!((report.max_effective_field_amplitude - norm(final_field[0])).abs() <= 1.0e-12);
    }

    #[test]
    fn dynamic_oersted_observables_match_the_committed_state_time() {
        let dt = 1.0e-3;
        let problem = dynamic_oersted_problem(TimeIntegrator::Heun, dt, 2.0 * dt);
        let mut state = problem
            .new_state(vec![[0.0, 1.0, 0.0]])
            .expect("state should build");
        state.time_seconds = dt;

        let expected_oersted = problem.oersted_field_at_time(state.time_seconds);
        let observables = problem.observe(&state).expect("observables should build");

        assert_vector_close(observables.effective_field[0], expected_oersted[0], 1.0e-12);
        let expected_energy = -MU0 * expected_oersted[0][1] * problem.cell_size.volume();
        assert!((observables.external_energy_joules - expected_energy).abs() <= 1.0e-12);
        assert!((observables.total_energy_joules - expected_energy).abs() <= 1.0e-12);

        state.time_seconds = 0.0;
        let inactive = problem
            .observe(&state)
            .expect("inactive observables should build");
        assert_vector_close(inactive.effective_field[0], [0.0, 0.0, 0.0], 1.0e-15);
        assert_eq!(inactive.external_energy_joules, 0.0);
    }

    #[test]
    fn dynamic_oersted_invalidates_rk45_fsal_cache() {
        let dt = 1.0e-3;
        let problem = dynamic_oersted_problem(TimeIntegrator::RK45, 0.0, 1.0e-6);
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0]])
            .expect("state should build");
        state.k_fsal = Some(vec![[0.0; 3]; 1]);
        let mut ws = problem.create_workspace();
        let mut bufs = problem.create_integrator_buffers();

        problem
            .rk45_step_buf(
                &mut state,
                dt,
                &mut ws,
                &mut bufs,
                EvaluationRequest::Minimal,
            )
            .expect("dynamic Oersted RK45 step should succeed");

        assert!((state.magnetization()[0][1].abs() + state.magnetization()[0][2].abs()) > 1.0e-12);
        assert!(state.k_fsal.is_none());
    }

    #[test]
    fn dynamic_oersted_invalidates_persistent_soa_rk45_fsal_cache() {
        let dt = 1.0e-3;
        let problem = dynamic_oersted_problem(TimeIntegrator::RK45, 0.0, 1.0e-6);
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0]])
            .expect("state should build")
            .to_soa();
        state.k_fsal = Some(VectorFieldSoA::zeros(1));
        let mut ws = problem.create_workspace();
        let mut bufs = problem.create_integrator_buffers();

        problem
            .rk45_step_soa_state_buf(
                &mut state,
                dt,
                &mut ws,
                &mut bufs,
                EvaluationRequest::Minimal,
            )
            .expect("persistent SoA dynamic Oersted RK45 step should succeed");

        let magnetization = state.magnetization().gather_to_aos()[0];
        assert!((magnetization[1].abs() + magnetization[2].abs()) > 1.0e-12);
        assert!(state.k_fsal.is_none());
    }

    #[test]
    fn oersted_supported_terms_are_eligible_for_soa_fast_path() {
        let grid = GridShape::new(3, 3, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                oersted_cylinder: Some(OerstedCylinderConfig {
                    current: 2.0,
                    radius: 1.25,
                    center: [1.5, 1.5, 0.0],
                    axis: [0.0, 0.0, 2.0],
                    time_dep_kind: 0,
                    time_dep_freq: 0.0,
                    time_dep_phase: 0.0,
                    time_dep_offset: 0.0,
                    time_dep_t_on: 0.0,
                    time_dep_t_off: 0.0,
                }),
                magnetoelastic: None,
                ..Default::default()
            },
        );

        assert!(problem.soa_fast_path_supported());
    }

    #[test]
    fn supported_soa_with_buffers_routes_through_soa_fast_path() {
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fdm/shared/problem.rs"
        ))
        .expect("fdm/shared/problem.rs should be readable");

        assert!(source.contains("TimeIntegrator::Heun if self.soa_fast_path_supported()"));
        assert!(source.contains("self.heun_step_soa_buf"));
        assert!(source.contains("TimeIntegrator::RK4 if self.soa_fast_path_supported()"));
        assert!(source.contains("self.rk4_step_soa_buf"));
        assert!(source.contains("TimeIntegrator::RK23 if self.soa_fast_path_supported()"));
        assert!(source.contains("self.rk23_step_soa_buf"));
        assert!(source.contains("TimeIntegrator::RK45 if self.soa_fast_path_supported()"));
        assert!(source.contains("self.rk45_step_soa_buf"));
        assert!(source.contains("TimeIntegrator::ABM3 if self.soa_fast_path_supported()"));
        assert!(source.contains("self.abm3_step_soa_buf"));
    }

    #[test]
    fn soa_full_step_observables_do_not_gather_to_aos() {
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fdm/cpu/integrators.rs"
        ))
        .expect("fdm/cpu/integrators.rs should be readable");
        let start = source
            .find("fn compute_step_observables_soa(")
            .expect("SoA observable dispatcher should exist");
        let end = source[start..]
            .find("fn compute_step_observables_soa_minimal(")
            .map(|offset| start + offset)
            .expect("SoA minimal observable evaluator should exist");
        let body = &source[start..end];

        assert!(
            body.contains("self.compute_step_observables_soa_full("),
            "SoA full observables should dispatch to the SoA full evaluator"
        );
        assert!(
            !body.contains("gather_into_aos"),
            "SoA full observables must not gather magnetization into AoS"
        );
    }

    #[test]
    fn step_with_workspace_advances_accepted_step_bookkeeping() {
        let problem = zeeman_problem([0.0, 0.0, 1.0]);
        let mut state = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("state should build");
        let mut ws = problem.create_workspace();

        assert_eq!(problem.thermal_step(), 0);
        problem
            .step_with_workspace(&mut state, 1e-3, &mut ws)
            .expect("step should succeed");

        assert_eq!(problem.thermal_step(), 1);
    }

    #[test]
    fn fdm_energy_density_integrates_to_matching_scalar_energy() {
        let problem = zeeman_problem([0.0, 0.0, 2.0]);
        let state = problem
            .new_state(vec![[0.0, 0.0, 1.0], [1.0, 0.0, 0.0]])
            .expect("state should build");
        let observables = problem.observe(&state).expect("observables");

        let ext_density = problem
            .external_energy_density(&state)
            .expect("external energy density");
        let total_density = problem
            .total_energy_density(&state)
            .expect("total energy density");
        let cell_volume = problem.cell_size.volume();

        let ext_integral: f64 = ext_density
            .iter()
            .map(|density| density * cell_volume)
            .sum();
        let total_integral: f64 = total_density
            .iter()
            .map(|density| density * cell_volume)
            .sum();

        assert_eq!(ext_density.len(), problem.grid.cell_count());
        assert!((ext_integral - observables.external_energy_joules).abs() <= 1e-18);
        assert!((total_integral - observables.total_energy_joules).abs() <= 1e-18);
    }

    #[test]
    fn step_with_buffers_minimal_evaluation_skips_energy_decomposition() {
        let problem = zeeman_problem([0.0, 0.0, 1.0]);
        let mut state = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("state should build");
        let mut ws = problem.create_workspace();
        let mut bufs = problem.create_integrator_buffers();

        let report = problem
            .step_with_buffers_evaluation(
                &mut state,
                1e-3,
                &mut ws,
                &mut bufs,
                EvaluationRequest::Minimal,
            )
            .expect("step should succeed");

        assert!(report.max_effective_field_amplitude > 0.0);
        assert!(report.max_rhs_amplitude > 0.0);
        assert_eq!(report.external_energy_joules, 0.0);
        assert_eq!(report.total_energy_joules, 0.0);
        assert_eq!(problem.thermal_step(), 1);
    }

    #[test]
    fn damped_relaxation_reduces_exchange_energy_for_small_dt() {
        let problem = simple_problem(0.5, 1.0);
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]])
            .expect("state should build");
        let mut ws = problem.create_workspace();

        let initial_energy = problem
            .exchange_energy(&state)
            .expect("energy should evaluate");
        for _ in 0..10 {
            problem
                .step_with_workspace(&mut state, 1e-3, &mut ws)
                .expect("step should succeed");
        }
        let final_energy = problem
            .observe(&state)
            .expect("observables")
            .total_energy_joules;

        assert!(
            final_energy < initial_energy,
            "expected damped exchange relaxation to reduce energy, initial={initial_energy}, final={final_energy}"
        );
    }

    #[test]
    fn zeeman_only_relaxation_reduces_external_energy() {
        let problem = zeeman_problem([0.0, 0.0, 1.0]);
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]])
            .expect("state should build");
        let mut ws = problem.create_workspace();

        let initial_energy = problem
            .observe(&state)
            .expect("observables")
            .external_energy_joules;
        for _ in 0..100 {
            problem
                .step_with_workspace(&mut state, 5e-3, &mut ws)
                .expect("step should succeed");
        }
        let final_observables = problem.observe(&state).expect("observables");

        assert!(
            final_observables.external_energy_joules < initial_energy,
            "expected external energy to decrease under damping"
        );
        assert!(
            state.magnetization()[0][2] > 0.1,
            "magnetization should tilt toward the external field"
        );
    }

    #[test]
    fn damping_only_relaxation_disables_transverse_precession() {
        let mut problem = zeeman_problem([0.0, 0.0, 1.0]);
        problem.dynamics = problem.dynamics.with_precession_enabled(false);
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]])
            .expect("state should build");
        let mut ws = problem.create_workspace();

        problem
            .step_with_workspace(&mut state, 1e-3, &mut ws)
            .expect("step should succeed");

        assert!(
            state.magnetization()[0][1].abs() <= 1e-12,
            "pure-damping relax should not precess into y, got {:?}",
            state.magnetization()[0]
        );
        assert!(
            state.magnetization()[0][2] > 0.0,
            "pure-damping relax should move toward the field, got {:?}",
            state.magnetization()[0]
        );
    }

    #[test]
    fn thin_film_out_of_plane_demag_energy_exceeds_in_plane_energy() {
        let problem = demag_problem(4, 4, 1);
        let out_of_plane = problem
            .uniform_state([0.0, 0.0, 1.0])
            .expect("state should build");
        let in_plane = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("state should build");

        let e_out = problem
            .observe(&out_of_plane)
            .expect("observables")
            .demag_energy_joules;
        let e_in = problem
            .observe(&in_plane)
            .expect("observables")
            .demag_energy_joules;

        assert!(
            e_out > e_in,
            "thin-film demag should penalise out-of-plane magnetization more strongly, out={e_out}, in={e_in}"
        );
    }

    #[test]
    fn demag_energy_is_non_negative_for_random_states() {
        let problem = demag_problem(4, 4, 2);
        // Seeded pseudo-random initial magnetization
        let n = 4 * 4 * 2;
        let mut m0 = Vec::with_capacity(n);
        let mut seed: u64 = 42;
        for _ in 0..n {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let x = ((seed >> 33) as f64) / (u32::MAX as f64) * 2.0 - 1.0;
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let y = ((seed >> 33) as f64) / (u32::MAX as f64) * 2.0 - 1.0;
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let z = ((seed >> 33) as f64) / (u32::MAX as f64) * 2.0 - 1.0;
            let len = (x * x + y * y + z * z).sqrt().max(1e-12);
            m0.push([x / len, y / len, z / len]);
        }
        let state = problem.new_state(m0).expect("state should build");
        let obs = problem.observe(&state).expect("observables");

        assert!(
            obs.demag_energy_joules >= 0.0,
            "demag energy must be non-negative, got {}",
            obs.demag_energy_joules
        );
        assert!(
            obs.demag_energy_joules.is_finite(),
            "demag energy must be finite"
        );
    }

    #[test]
    fn total_energy_decreases_during_demag_relaxation() {
        let grid = GridShape::new(8, 8, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(2e-9, 2e-9, 2e-9).expect("valid cell size"),
            MaterialParameters::new(800e3, 13e-12, 0.5).expect("valid material"),
            LlgConfig::default(),
            EffectiveFieldTerms {
                exchange: true,
                demag: true,
                external_field: None,
                per_node_field: None,
                magnetoelastic: None,
                ..Default::default()
            },
        );

        // Start with slightly tilted m (pure z gives m×H=0, no dynamics)
        let n = grid.cell_count();
        let tilted: Vec<Vector3> = (0..n)
            .map(|_| {
                let len = (0.01f64 * 0.01 + 0.01 * 0.01 + 1.0).sqrt();
                [0.01 / len, 0.01 / len, 1.0 / len]
            })
            .collect();
        let mut state = problem.new_state(tilted).expect("state should build");
        let mut ws = problem.create_workspace();

        let initial_energy = problem
            .observe(&state)
            .expect("observables")
            .total_energy_joules;
        let dt = 1e-14;
        for _ in 0..200 {
            problem
                .step_with_workspace(&mut state, dt, &mut ws)
                .expect("step should succeed");
        }
        let final_energy = problem
            .observe(&state)
            .expect("observables")
            .total_energy_joules;

        assert!(
            final_energy < initial_energy,
            "total energy should decrease during damped relaxation with demag, initial={initial_energy}, final={final_energy}"
        );
    }

    #[test]
    fn workspace_demag_matches_standalone_demag() {
        let problem = demag_problem(4, 4, 2);
        let state = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("state should build");

        // Compute via standalone call (creates workspace internally)
        let field_direct = problem
            .demag_field(&state)
            .expect("demag field should evaluate");
        // Compute via workspace
        let obs_ws = problem.observe(&state).expect("observables");

        for (i, (direct, ws_val)) in field_direct
            .iter()
            .zip(obs_ws.demag_field.iter())
            .enumerate()
        {
            for c in 0..3 {
                assert!(
                    (direct[c] - ws_val[c]).abs() < 1e-14,
                    "component {c} of cell {i} differs between workspace and standalone demag"
                );
            }
        }
    }

    #[test]
    fn thin_film_in_plane_demag_energy_is_small() {
        let problem = demag_problem(8, 8, 1);
        let state = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("state should build");
        let obs = problem.observe(&state).expect("observables");

        // In-plane uniform magnetization of a thin film should have near-zero demag energy
        // (relative to the out-of-plane case)
        let out_of_plane = problem
            .uniform_state([0.0, 0.0, 1.0])
            .expect("state should build");
        let e_out = problem
            .observe(&out_of_plane)
            .expect("observables")
            .demag_energy_joules;

        assert!(
            obs.demag_energy_joules < e_out * 0.5,
            "in-plane demag energy should be smaller than out-of-plane, in={}, out={e_out}",
            obs.demag_energy_joules
        );
    }
}
