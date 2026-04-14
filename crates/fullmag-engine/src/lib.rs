// ── Existing sub-crate modules ────────────────────────────────────────
pub mod distributed;
pub mod fem;
pub mod fem_afem_loop;
pub mod fem_edge_topology;
pub mod fem_error_estimator;
pub mod fem_face_topology;
pub mod fem_goal_estimator;
pub mod fem_hcurl_estimator;
pub mod fem_size_field;
pub mod fem_solution_transfer;
pub mod fem_sparse;
pub mod hpc_runtime;
pub mod magnetoelastic;
pub mod multilayer;
pub mod newell;
pub mod studies;
pub mod telemetry;
pub mod vector;

// ── FDM engine modules ────────────────────────────────────────────────
mod fdm_demo;
mod fdm_fft;
pub mod fdm_fft_backend;
mod fdm_fields;
mod fdm_integrators;
mod fdm_problem;
mod fdm_state;
mod fdm_types;

// ── Imports used locally (VectorFieldSoA, constants, tests) ───────────
use std::f64::consts::PI;

// ── Constants ─────────────────────────────────────────────────────────
pub const MU0: f64 = 4.0 * PI * 1e-7;
pub const DEFAULT_GYROMAGNETIC_RATIO: f64 = 2.211e5;

pub type Vector3 = [f64; 3];

// ── Re-exports from FDM modules ───────────────────────────────────────
pub use fdm_demo::{run_reference_exchange_demo, ReferenceDemoReport};

pub use fdm_fft::{
    compute_newell_kernel_spectra, compute_newell_kernel_spectra_thin_film_2d, DemagKernelSpectra,
    FftWorkspace,
};

pub use fdm_state::{
    AbmHistory, AbmHistorySoA, EffectiveFieldObservables, ExchangeLlgState, ExchangeLlgStateSoA,
    IntegratorBuffers, RhsEvaluation, SolverSession, StepReport,
};

pub use fdm_problem::ExchangeLlgProblem;

pub use fdm_types::{
    neighbor_index, AdaptiveStepConfig, AxisBoundary, CellSize, CubicAnisotropyConfig,
    EffectiveFieldTerms, EngineError, EvaluationRequest, FdmBoundaryPolicy, GridShape, LlgConfig,
    MagnetoelasticTermConfig, MaterialParameters, OerstedCylinderConfig, Result,
    SlonczewskiSttConfig, SotConfig, TimeIntegrator, UniaxialAnisotropyConfig, ZhangLiSttConfig,
};

// ── Vector math utilities ─────────────────────────────────────────────
pub use vector::{
    add, cross, dot, max_cross_norm, max_norm, norm, normalized, scale, squared_norm, sub,
};

// ── VectorFieldSoA (kept in lib.rs — small, frequently referenced) ────
/// Structure-of-Arrays layout for 3D vector fields.
///
/// Stores `x`, `y`, `z` components in separate contiguous arrays —
/// optimal for SIMD, FFT gather/scatter, and GPU upload.
#[derive(Debug, Clone, PartialEq)]
pub struct VectorFieldSoA {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub z: Vec<f64>,
}

impl VectorFieldSoA {
    /// Allocate zeroed buffers for `n` vectors.
    pub fn zeros(n: usize) -> Self {
        Self {
            x: vec![0.0; n],
            y: vec![0.0; n],
            z: vec![0.0; n],
        }
    }

    pub fn len(&self) -> usize {
        self.x.len()
    }

    pub fn is_empty(&self) -> bool {
        self.x.is_empty()
    }

    /// Convert from AoS `&[Vector3]` without allocation (writes into self).
    pub fn scatter_from_aos(&mut self, aos: &[Vector3]) {
        let n = aos.len();
        debug_assert!(self.x.len() >= n);
        for i in 0..n {
            self.x[i] = aos[i][0];
            self.y[i] = aos[i][1];
            self.z[i] = aos[i][2];
        }
    }

    /// Convert to AoS `Vec<Vector3>`.
    pub fn gather_to_aos(&self) -> Vec<Vector3> {
        let n = self.x.len();
        let mut aos = Vec::with_capacity(n);
        for i in 0..n {
            aos.push([self.x[i], self.y[i], self.z[i]]);
        }
        aos
    }

    /// Convert to AoS into existing buffer (no allocation).
    pub fn gather_into_aos(&self, aos: &mut [Vector3]) {
        let n = self.x.len().min(aos.len());
        for i in 0..n {
            aos[i] = [self.x[i], self.y[i], self.z[i]];
        }
    }

    /// Create from AoS `&[Vector3]` (allocating).
    pub fn from_aos(aos: &[Vector3]) -> Self {
        let n = aos.len();
        let mut soa = Self::zeros(n);
        soa.scatter_from_aos(aos);
        soa
    }
}

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

        let _report = problem.step(&mut state, 1e-3).expect("step should succeed");

        for magnetization in state.magnetization() {
            assert!(
                (norm(*magnetization) - 1.0).abs() <= 1e-12,
                "magnetization lost unit norm: {:?}",
                magnetization
            );
        }
    }

    #[test]
    fn damped_relaxation_reduces_exchange_energy_for_small_dt() {
        let problem = simple_problem(0.5, 1.0);
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]])
            .expect("state should build");

        let initial_energy = problem
            .exchange_energy(&state)
            .expect("energy should evaluate");
        for _ in 0..10 {
            problem.step(&mut state, 1e-3).expect("step should succeed");
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

        let initial_energy = problem
            .observe(&state)
            .expect("observables")
            .external_energy_joules;
        for _ in 0..100 {
            problem.step(&mut state, 5e-3).expect("step should succeed");
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

        problem.step(&mut state, 1e-3).expect("step should succeed");

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
