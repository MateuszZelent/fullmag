//! AFEM outer-loop orchestration: estimate → mark → size field → convergence check.
//!
//! This module ties together E1–E4 (error estimation, marking, size field,
//! gradation) into a single step that returns enough information for the
//! caller to decide whether to remesh (via Gmsh / E5) and transfer (E6).

use crate::fem::MeshTopology;
use crate::fem_error_estimator::{
    compute_h1_error_indicators, doerfler_marking, ErrorIndicators, H1EstimatorParams,
    MarkingResult,
};
use crate::fem_face_topology::FaceTopology;
use crate::fem_size_field::{
    compute_continuous_size_field, element_to_nodal_size_field, SizeField, SizeFieldConfig,
};
use crate::Result;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Configuration for the AFEM outer loop.
#[derive(Debug, Clone)]
pub struct AfemConfig {
    /// Absolute tolerance on global error estimate.  Stop if η_global ≤ tol.
    pub tolerance: f64,
    /// Maximum number of AFEM iterations (default 8).
    pub max_iterations: u32,
    /// Maximum number of elements before giving up refinement (default 5_000_000).
    pub max_elements: usize,
    /// Dörfler marking fraction θ ∈ (0, 1] (default 0.3).
    pub theta: f64,
    /// Size-field exponent α (default 0.5, valid for d=3).
    pub alpha: f64,
    /// Minimum element size h_min.
    pub h_min: f64,
    /// Maximum element size h_max.
    pub h_max: f64,
    /// Gradation limiter ratio (default 1.3).
    pub grad_limit: f64,
    /// Maximum fraction of elements to mark (default 0.5).
    pub max_mark_fraction: f64,
    /// Relative improvement threshold δ for stagnation detection (default 0.05).
    pub stagnation_delta: f64,
    /// Consecutive stagnant iterations before stopping (default 2).
    pub stagnation_count: u32,
}

impl Default for AfemConfig {
    fn default() -> Self {
        Self {
            tolerance: 1e-3,
            max_iterations: 8,
            max_elements: 5_000_000,
            theta: 0.3,
            alpha: 0.5,
            h_min: 0.0,
            h_max: f64::MAX,
            grad_limit: 1.3,
            max_mark_fraction: 0.5,
            stagnation_delta: 0.05,
            stagnation_count: 2,
        }
    }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/// Reason why the AFEM loop stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// Global error is below the absolute tolerance.
    Converged,
    /// Maximum number of AFEM iterations reached.
    MaxIterations,
    /// Mesh would exceed the maximum element count.
    MaxElements,
    /// Consecutive iterations showed insufficient improvement.
    Stagnation,
    /// Should continue iterating (not a stop reason).
    Continue,
}

/// Result of one AFEM iteration (estimate → mark → size field).
#[derive(Debug, Clone)]
pub struct AfemStepResult {
    /// Per-element error indicators from E1.
    pub indicators: ErrorIndicators,
    /// Dörfler marking from E2.
    pub marking: MarkingResult,
    /// Per-element target sizes from E3+E4.
    pub size_field: SizeField,
    /// Per-node target sizes (for Gmsh PostView).
    pub nodal_h: Vec<f64>,
    /// Whether the loop should stop and why.
    pub stop_reason: StopReason,
    /// Current iteration index (0-based).
    pub iteration: u32,
}

/// Tracks convergence state across AFEM iterations.
#[derive(Debug, Clone)]
pub struct AfemHistory {
    /// Global error estimate per iteration.
    pub eta_history: Vec<f64>,
    /// Element count per iteration.
    pub n_elements_history: Vec<usize>,
    /// Consecutive stagnant iterations counter.
    stagnation_counter: u32,
}

impl AfemHistory {
    pub fn new() -> Self {
        Self {
            eta_history: Vec::new(),
            n_elements_history: Vec::new(),
            stagnation_counter: 0,
        }
    }

    /// Record a new iteration's results and return the stop reason.
    pub fn record_and_check(
        &mut self,
        eta_global: f64,
        n_elements: usize,
        config: &AfemConfig,
    ) -> StopReason {
        let iteration = self.eta_history.len() as u32;

        // 1. Absolute convergence
        if eta_global <= config.tolerance {
            self.eta_history.push(eta_global);
            self.n_elements_history.push(n_elements);
            return StopReason::Converged;
        }

        // 2. Max iterations
        if iteration >= config.max_iterations {
            self.eta_history.push(eta_global);
            self.n_elements_history.push(n_elements);
            return StopReason::MaxIterations;
        }

        // 3. Max elements (would the next mesh likely exceed?)
        if n_elements > config.max_elements {
            self.eta_history.push(eta_global);
            self.n_elements_history.push(n_elements);
            return StopReason::MaxElements;
        }

        // 4. Stagnation check (relative improvement)
        if let Some(&prev_eta) = self.eta_history.last() {
            if prev_eta > 0.0 {
                let improvement = (prev_eta - eta_global) / prev_eta;
                if improvement < config.stagnation_delta {
                    self.stagnation_counter += 1;
                } else {
                    self.stagnation_counter = 0;
                }
                if self.stagnation_counter >= config.stagnation_count {
                    self.eta_history.push(eta_global);
                    self.n_elements_history.push(n_elements);
                    return StopReason::Stagnation;
                }
            }
        }

        self.eta_history.push(eta_global);
        self.n_elements_history.push(n_elements);
        StopReason::Continue
    }
}

// ---------------------------------------------------------------------------
// One AFEM step
// ---------------------------------------------------------------------------

/// Perform one AFEM step: estimate → mark → compute size field.
///
/// The caller is responsible for:
/// 1. Calling this after solving on the current mesh.
/// 2. If `stop_reason == Continue`, using the returned `nodal_h` to remesh
///    via Gmsh (E5) and then transferring the solution (E6).
/// 3. For the first call, construct a fresh `AfemHistory`.
///
/// # Arguments
/// * `topo` — current mesh topology
/// * `solution` — per-node scalar solution (e.g. potential A_h)
/// * `nu_per_element` — per-element reluctivity ν
/// * `source_per_element` — per-element source term (J_z for magnetostatics)
/// * `config` — AFEM configuration
/// * `history` — mutable convergence history tracker
pub fn afem_step(
    topo: &MeshTopology,
    solution: &[f64],
    nu_per_element: &[f64],
    source_per_element: &[f64],
    config: &AfemConfig,
    history: &mut AfemHistory,
) -> Result<AfemStepResult> {
    let iteration = history.eta_history.len() as u32;

    // E1: Build face topology and compute error indicators
    let faces = FaceTopology::build(
        &topo.elements,
        &topo.coords,
        &topo.boundary_faces,
        &topo.element_markers,
    );

    let params = H1EstimatorParams {
        topology: topo,
        faces: &faces,
        solution,
        nu: nu_per_element,
        source: source_per_element,
    };
    let indicators = compute_h1_error_indicators(&params)?;

    // Check convergence
    let stop_reason = history.record_and_check(indicators.eta_global, topo.n_elements, config);

    let n_elem = topo.n_elements;

    if stop_reason != StopReason::Continue {
        return Ok(AfemStepResult {
            indicators,
            marking: MarkingResult {
                marked: vec![false; n_elem],
                n_marked: 0,
                fraction_marked: 0.0,
                captured_error_fraction: 0.0,
            },
            size_field: SizeField {
                h_target: vec![config.h_max; n_elem],
                h_current: topo
                    .elements
                    .iter()
                    .map(|e| crate::fem_face_topology::tet_diameter(&topo.coords, e))
                    .collect(),
                ratio: vec![1.0; n_elem],
                gradation_iterations: 0,
            },
            nodal_h: vec![config.h_max; topo.n_nodes],
            stop_reason,
            iteration,
        });
    }

    // E2: Dörfler marking
    let marking = doerfler_marking(&indicators, config.theta, config.max_mark_fraction)?;

    // E3+E4: Continuous size field with built-in gradation
    let sf_config = SizeFieldConfig {
        tolerance: config.tolerance,
        alpha: config.alpha,
        h_min: config.h_min,
        h_max: config.h_max,
        grad_limit: config.grad_limit,
    };
    let size_field = compute_continuous_size_field(topo, &indicators, &faces, &sf_config)?;

    // Convert to nodal values for Gmsh PostView
    let nodal_h = element_to_nodal_size_field(topo, &size_field.h_target)?;

    Ok(AfemStepResult {
        indicators,
        marking,
        size_field,
        nodal_h,
        stop_reason,
        iteration,
    })
}

/// Perform one AFEM step for a nodal vector field such as magnetization.
///
/// The current MVP reduces the vector field to a scalar H1-like indicator by
/// summing the per-component residual estimators for `mx`, `my`, and `mz`.
/// This gives us a stable refinement signal for:
/// - sharp magnetization gradients,
/// - vortex / wall cores,
/// - regions where continuation after remesh benefits from local refinement.
pub fn afem_step_vector_field(
    topo: &MeshTopology,
    vector_solution: &[[f64; 3]],
    config: &AfemConfig,
    history: &mut AfemHistory,
) -> Result<AfemStepResult> {
    if vector_solution.len() != topo.n_nodes {
        return Err(crate::EngineError::new(format!(
            "vector_solution length {} ≠ node count {}",
            vector_solution.len(),
            topo.n_nodes
        )));
    }

    let iteration = history.eta_history.len() as u32;
    let faces = FaceTopology::build(
        &topo.elements,
        &topo.coords,
        &topo.boundary_faces,
        &topo.element_markers,
    );

    let n_el = topo.n_elements;
    let nu = vec![1.0; n_el];
    let source = vec![0.0; n_el];
    let mut eta_vol_sq = vec![0.0; n_el];
    let mut eta_jump_sq = vec![0.0; n_el];

    for component in 0..3 {
        let scalar_solution: Vec<f64> = vector_solution
            .iter()
            .map(|value| value[component])
            .collect();
        let component_indicators = compute_h1_error_indicators(&H1EstimatorParams {
            topology: topo,
            faces: &faces,
            solution: &scalar_solution,
            nu: &nu,
            source: &source,
        })?;
        for element in 0..n_el {
            eta_vol_sq[element] += component_indicators.eta_vol_sq[element];
            eta_jump_sq[element] += component_indicators.eta_jump_sq[element];
        }
    }

    let mut eta_sq = Vec::with_capacity(n_el);
    let mut eta = Vec::with_capacity(n_el);
    let mut sum_sq = 0.0;
    for element in 0..n_el {
        let total = eta_vol_sq[element] + eta_jump_sq[element];
        eta_sq.push(total);
        eta.push(total.sqrt());
        sum_sq += total;
    }
    let indicators = ErrorIndicators {
        eta_vol_sq,
        eta_jump_sq,
        eta_sq,
        eta,
        eta_global: sum_sq.sqrt(),
    };

    let stop_reason = history.record_and_check(indicators.eta_global, topo.n_elements, config);
    if stop_reason != StopReason::Continue {
        return Ok(AfemStepResult {
            indicators,
            marking: MarkingResult {
                marked: vec![false; n_el],
                n_marked: 0,
                fraction_marked: 0.0,
                captured_error_fraction: 0.0,
            },
            size_field: SizeField {
                h_target: vec![config.h_max; n_el],
                h_current: topo
                    .elements
                    .iter()
                    .map(|e| crate::fem_face_topology::tet_diameter(&topo.coords, e))
                    .collect(),
                ratio: vec![1.0; n_el],
                gradation_iterations: 0,
            },
            nodal_h: vec![config.h_max; topo.n_nodes],
            stop_reason,
            iteration,
        });
    }

    let marking = doerfler_marking(&indicators, config.theta, config.max_mark_fraction)?;
    let sf_config = SizeFieldConfig {
        tolerance: config.tolerance,
        alpha: config.alpha,
        h_min: config.h_min,
        h_max: config.h_max,
        grad_limit: config.grad_limit,
    };
    let size_field = compute_continuous_size_field(topo, &indicators, &faces, &sf_config)?;
    let nodal_h = element_to_nodal_size_field(topo, &size_field.h_target)?;

    Ok(AfemStepResult {
        indicators,
        marking,
        size_field,
        nodal_h,
        stop_reason,
        iteration,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::fem::{CsrMatrix, MeshTopology};

    /// Build a minimal MeshTopology for testing.
    fn make_topo(coords: Vec<[f64; 3]>, elements: Vec<[u32; 4]>) -> MeshTopology {
        let n_nodes = coords.len();
        let n_elements = elements.len();

        // Compute volumes and grad_phi properly
        let mut element_volumes = Vec::with_capacity(n_elements);
        let mut grad_phi_all = Vec::with_capacity(n_elements);

        for elem in &elements {
            let p0 = coords[elem[0] as usize];
            let p1 = coords[elem[1] as usize];
            let p2 = coords[elem[2] as usize];
            let p3 = coords[elem[3] as usize];
            let d1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
            let d2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
            let d3 = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]];
            let det = d1[0] * (d2[1] * d3[2] - d2[2] * d3[1])
                - d1[1] * (d2[0] * d3[2] - d2[2] * d3[0])
                + d1[2] * (d2[0] * d3[1] - d2[1] * d3[0]);
            let vol = det.abs() / 6.0;
            element_volumes.push(vol);

            // Compute grad_phi using inverse transpose
            let inv_det = 1.0 / det;
            let inv = [
                [
                    (d2[1] * d3[2] - d2[2] * d3[1]) * inv_det,
                    (d2[2] * d3[0] - d2[0] * d3[2]) * inv_det,
                    (d2[0] * d3[1] - d2[1] * d3[0]) * inv_det,
                ],
                [
                    (d3[1] * d1[2] - d3[2] * d1[1]) * inv_det,
                    (d3[2] * d1[0] - d3[0] * d1[2]) * inv_det,
                    (d3[0] * d1[1] - d3[1] * d1[0]) * inv_det,
                ],
                [
                    (d1[1] * d2[2] - d1[2] * d2[1]) * inv_det,
                    (d1[2] * d2[0] - d1[0] * d2[2]) * inv_det,
                    (d1[0] * d2[1] - d1[1] * d2[0]) * inv_det,
                ],
            ];
            let grad1 = [inv[0][0], inv[1][0], inv[2][0]];
            let grad2 = [inv[0][1], inv[1][1], inv[2][1]];
            let grad3 = [inv[0][2], inv[1][2], inv[2][2]];
            let grad0 = [
                -(grad1[0] + grad2[0] + grad3[0]),
                -(grad1[1] + grad2[1] + grad3[1]),
                -(grad1[2] + grad2[2] + grad3[2]),
            ];
            grad_phi_all.push([grad0, grad1, grad2, grad3]);
        }

        MeshTopology {
            coords,
            elements,
            element_markers: vec![1; n_elements],
            magnetic_element_mask: vec![true; n_elements],
            boundary_faces: vec![],
            boundary_nodes: vec![],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            element_volumes,
            node_volumes: vec![0.0; n_nodes],
            magnetic_node_volumes: vec![0.0; n_nodes],
            grad_phi: grad_phi_all,
            element_stiffness: vec![[[0.0; 4]; 4]; n_elements],
            stiffness_csr: CsrMatrix::new(n_nodes),
            boundary_mass_csr: CsrMatrix::new(n_nodes),
            demag_csr: CsrMatrix::new(n_nodes),
            magnetic_stiffness_csr: CsrMatrix::new(n_nodes),
            total_volume: 0.0,
            magnetic_total_volume: 0.0,
            robin_beta: 0.0,
            n_nodes,
            n_elements,
        }
    }

    fn two_tet_mesh() -> (MeshTopology, Vec<f64>, Vec<f64>, Vec<f64>) {
        let coords = vec![
            [0.0, 0.0, 0.0], // 0
            [1.0, 0.0, 0.0], // 1
            [0.0, 1.0, 0.0], // 2
            [0.0, 0.0, 1.0], // 3
            [1.0, 1.0, 1.0], // 4
        ];
        let elements = vec![[0, 1, 2, 3], [1, 2, 3, 4]];
        let topo = make_topo(coords, elements);

        // u = z (linear), ν discontinuous → jump on interface
        let solution = vec![0.0, 0.0, 0.0, 1.0, 1.0];
        let nu = vec![1.0, 10.0]; // ν-jump triggers refinement
        let source = vec![0.0, 0.0];

        (topo, solution, nu, source)
    }

    #[test]
    fn afem_step_produces_valid_result() {
        let (topo, solution, nu, source) = two_tet_mesh();
        let config = AfemConfig {
            tolerance: 1e-6,
            h_min: 0.01,
            h_max: 2.0,
            ..Default::default()
        };
        let mut history = AfemHistory::new();

        let result = afem_step(&topo, &solution, &nu, &source, &config, &mut history).unwrap();

        assert_eq!(result.stop_reason, StopReason::Continue);
        assert_eq!(result.iteration, 0);
        assert!(result.indicators.eta_global > 0.0);
        assert!(result.marking.n_marked > 0);
        assert_eq!(result.size_field.h_target.len(), 2);
        assert_eq!(result.nodal_h.len(), 5);
        assert_eq!(history.eta_history.len(), 1);
    }

    #[test]
    fn zero_error_converges_immediately() {
        let coords = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let topo = make_topo(coords, vec![[0, 1, 2, 3]]);
        // Uniform ν, u = constant → zero error
        let solution = vec![1.0, 1.0, 1.0, 1.0];
        let nu = vec![1.0];
        let source = vec![0.0];
        let config = AfemConfig {
            tolerance: 1e-3,
            ..Default::default()
        };
        let mut history = AfemHistory::new();

        let result = afem_step(&topo, &solution, &nu, &source, &config, &mut history).unwrap();

        assert_eq!(result.stop_reason, StopReason::Converged);
    }

    #[test]
    fn max_iterations_stops_loop() {
        let (topo, solution, nu, source) = two_tet_mesh();
        let config = AfemConfig {
            tolerance: 1e-20, // unreachable
            max_iterations: 3,
            h_min: 0.01,
            h_max: 2.0,
            ..Default::default()
        };
        let mut history = AfemHistory::new();

        // Simulate 3 iterations hitting the cap
        for _ in 0..3 {
            history.record_and_check(1.0, 100, &config);
        }
        let result = afem_step(&topo, &solution, &nu, &source, &config, &mut history).unwrap();

        assert_eq!(result.stop_reason, StopReason::MaxIterations);
    }

    #[test]
    fn max_elements_stops_loop() {
        let (topo, solution, nu, source) = two_tet_mesh();
        let config = AfemConfig {
            tolerance: 1e-20,
            max_elements: 1, // the 2-element mesh exceeds this
            h_min: 0.01,
            h_max: 2.0,
            ..Default::default()
        };
        let mut history = AfemHistory::new();

        let result = afem_step(&topo, &solution, &nu, &source, &config, &mut history).unwrap();

        assert_eq!(result.stop_reason, StopReason::MaxElements);
    }

    #[test]
    fn stagnation_detected_after_flat_iterations() {
        let config = AfemConfig {
            tolerance: 1e-20,
            stagnation_delta: 0.05,
            stagnation_count: 2,
            ..Default::default()
        };
        let mut history = AfemHistory::new();

        // First iteration
        let r = history.record_and_check(1.0, 100, &config);
        assert_eq!(r, StopReason::Continue);

        // Second: tiny improvement → stagnation counter = 1
        let r = history.record_and_check(0.99, 200, &config);
        assert_eq!(r, StopReason::Continue);

        // Third: tiny again → counter = 2 → stop
        let r = history.record_and_check(0.98, 300, &config);
        assert_eq!(r, StopReason::Stagnation);
    }

    #[test]
    fn history_tracks_eta_and_elements() {
        let config = AfemConfig::default();
        let mut history = AfemHistory::new();

        history.record_and_check(0.5, 100, &config);
        history.record_and_check(0.3, 200, &config);
        history.record_and_check(0.1, 400, &config);

        assert_eq!(history.eta_history, vec![0.5, 0.3, 0.1]);
        assert_eq!(history.n_elements_history, vec![100, 200, 400]);
    }

    #[test]
    fn nodal_h_values_are_bounded() {
        let (topo, solution, nu, source) = two_tet_mesh();
        let config = AfemConfig {
            tolerance: 1e-20,
            h_min: 0.05,
            h_max: 1.5,
            ..Default::default()
        };
        let mut history = AfemHistory::new();

        let result = afem_step(&topo, &solution, &nu, &source, &config, &mut history).unwrap();

        for &h in &result.nodal_h {
            assert!(
                h >= config.h_min * 0.99 && h <= config.h_max * 1.01,
                "nodal h = {} outside [{}, {}]",
                h,
                config.h_min,
                config.h_max,
            );
        }
    }

    #[test]
    fn vector_field_step_detects_gradient_and_builds_target_h() {
        let (topo, _, _, _) = two_tet_mesh();
        let config = AfemConfig {
            tolerance: 1e-9,
            h_min: 0.05,
            h_max: 1.5,
            ..Default::default()
        };
        let mut history = AfemHistory::new();
        let vector_solution = vec![
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            [-1.0, 0.0, 0.0],
        ];

        let result = afem_step_vector_field(&topo, &vector_solution, &config, &mut history)
            .expect("vector AFEM step");

        assert_eq!(result.stop_reason, StopReason::Continue);
        assert!(result.indicators.eta_global > 0.0);
        assert!(result.marking.n_marked > 0);
        assert_eq!(result.nodal_h.len(), topo.n_nodes);
    }
}
