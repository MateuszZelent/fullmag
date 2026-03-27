//! Goal-oriented (adjoint-based) a-posteriori error estimator.
//!
//! Implements the Dual-Weighted Residual (DWR) method:
//!   η^goal_K ≈ |R_K(z_h − I_h z_h)|
//!
//! where z_h is the dual/adjoint solution satisfying  a(v, z) = J(v) ∀v
//! and J is the quantity-of-interest (QoI) functional.
//!
//! The primal residual R_K is combined with the adjoint weight to concentrate
//! refinement where it matters most for the QoI — rather than globally.
//!
//! Supported QoIs:
//! - Average B in a region
//! - Magnetic energy
//! - Force / inductance (via virtual work principle — user-supplied functional)

use crate::fem::MeshTopology;
use crate::fem_error_estimator::ErrorIndicators;
use crate::{dot, EngineError, Result};

// ---------------------------------------------------------------------------
// QoI functionals
// ---------------------------------------------------------------------------

/// A quantity-of-interest evaluated element-wise on the primal solution.
///
/// J(u_h) = Σ_K  j_K(u_h)
///
/// The per-element QoI contribution is used as the adjoint weight.
pub trait QoiFunctional {
    /// Evaluate the QoI weight per element.  Returns one value per element.
    ///
    /// For a linear QoI J(v) = ∫_Ω g · v dx,  the weight on element K is
    /// just the representation of g in the test space.
    fn element_weights(
        &self,
        topology: &MeshTopology,
        solution: &[f64],
    ) -> Result<Vec<f64>>;
}

/// QoI: average scalar field over magnetically-active elements.
///
/// J(u) = (1/|Ω_m|) ∫_{Ω_m} u dx
///
/// Weight per element = |K| / |Ω_m| for magnetic elements, 0 otherwise.
pub struct AverageFieldQoi;

impl QoiFunctional for AverageFieldQoi {
    fn element_weights(
        &self,
        topology: &MeshTopology,
        _solution: &[f64],
    ) -> Result<Vec<f64>> {
        let vol_m = topology.magnetic_total_volume;
        if vol_m <= 0.0 {
            return Err(EngineError::new(
                "magnetic volume is zero; cannot compute average-field QoI",
            ));
        }
        let weights: Vec<f64> = (0..topology.n_elements)
            .map(|ei| {
                if topology.magnetic_element_mask[ei] {
                    topology.element_volumes[ei] / vol_m
                } else {
                    0.0
                }
            })
            .collect();
        Ok(weights)
    }
}

/// QoI: total magnetic energy  E = ½ ∫ ν |∇u|² dx  (H¹ scalar case).
///
/// Weight per element = ½ ν_K |∇u_K|² |K| / E_total  (normalised).
/// Falls back to uniform weights if energy is zero.
pub struct MagneticEnergyQoi<'a> {
    /// Per-element reluctivity ν.
    pub nu: &'a [f64],
}

impl QoiFunctional for MagneticEnergyQoi<'_> {
    fn element_weights(
        &self,
        topology: &MeshTopology,
        solution: &[f64],
    ) -> Result<Vec<f64>> {
        let n_el = topology.n_elements;
        if self.nu.len() != n_el {
            return Err(EngineError::new(format!(
                "nu length {} ≠ element count {}",
                self.nu.len(),
                n_el
            )));
        }

        let mut energy_per_el = Vec::with_capacity(n_el);
        let mut total = 0.0;

        for (ei, element) in topology.elements.iter().enumerate() {
            let grad = &topology.grad_phi[ei];
            let mut g = [0.0, 0.0, 0.0];
            for li in 0..4 {
                let u_node = solution[element[li] as usize];
                g[0] += u_node * grad[li][0];
                g[1] += u_node * grad[li][1];
                g[2] += u_node * grad[li][2];
            }
            let e_k = 0.5 * self.nu[ei] * dot(g, g) * topology.element_volumes[ei];
            energy_per_el.push(e_k);
            total += e_k;
        }

        if total <= 0.0 {
            // Uniform weights if no energy
            let w = 1.0 / n_el as f64;
            return Ok(vec![w; n_el]);
        }

        for e in &mut energy_per_el {
            *e /= total;
        }
        Ok(energy_per_el)
    }
}

/// QoI: user-supplied per-element weights (e.g. from an external adjoint solve).
pub struct CustomWeightsQoi {
    pub weights: Vec<f64>,
}

impl QoiFunctional for CustomWeightsQoi {
    fn element_weights(
        &self,
        topology: &MeshTopology,
        _solution: &[f64],
    ) -> Result<Vec<f64>> {
        if self.weights.len() != topology.n_elements {
            return Err(EngineError::new(format!(
                "custom weights length {} ≠ element count {}",
                self.weights.len(),
                topology.n_elements
            )));
        }
        Ok(self.weights.clone())
    }
}

// ---------------------------------------------------------------------------
// Goal-oriented estimator
// ---------------------------------------------------------------------------

/// Parameters for the goal-oriented error estimator.
pub struct GoalEstimatorParams<'a> {
    /// Primal error indicators η_K (from H¹ or H(curl) estimator).
    pub primal_indicators: &'a ErrorIndicators,
    /// Mesh topology.
    pub topology: &'a MeshTopology,
    /// Primal solution (needed to evaluate the QoI functional).
    pub solution: &'a [f64],
    /// The quantity-of-interest functional.
    pub qoi: &'a dyn QoiFunctional,
}

/// Compute goal-oriented error indicators.
///
/// η^goal_K = η_K · w_K
///
/// where w_K are the QoI weights (approximating the adjoint influence).
///
/// This is the simplified DWR approach where the adjoint is approximated
/// by the QoI element weights rather than a full dual solve.
/// For a full adjoint solve the user should supply `CustomWeightsQoi`
/// with the actual dual residual weights.
pub fn compute_goal_oriented_indicators(
    params: &GoalEstimatorParams,
) -> Result<ErrorIndicators> {
    let n_el = params.topology.n_elements;
    let primal = params.primal_indicators;

    if primal.eta_sq.len() != n_el {
        return Err(EngineError::new(format!(
            "primal indicators length {} ≠ element count {}",
            primal.eta_sq.len(),
            n_el
        )));
    }

    let weights = params.qoi.element_weights(params.topology, params.solution)?;

    let mut eta_sq = Vec::with_capacity(n_el);
    let mut eta = Vec::with_capacity(n_el);
    let mut sum_sq = 0.0;

    for ei in 0..n_el {
        // η^goal_K² = η_K² · w_K²
        let w = weights[ei];
        let goal_sq = primal.eta_sq[ei] * w * w;
        eta_sq.push(goal_sq);
        eta.push(goal_sq.sqrt());
        sum_sq += goal_sq;
    }

    // Decomposition is not meaningful for goal-oriented, store zeros
    Ok(ErrorIndicators {
        eta_vol_sq: vec![0.0; n_el],
        eta_jump_sq: vec![0.0; n_el],
        eta_sq,
        eta,
        eta_global: sum_sq.sqrt(),
    })
}

/// Compute per-element effectivity indices (ratio of goal-oriented to primal).
///
/// ι_K = η^goal_K / η_K
///
/// Useful for diagnostics: elements with ι_K close to 1 contribute equally
/// to the QoI and to the global error; elements with ι_K << 1 are "wasted"
/// refinement if using the primal estimator alone.
pub fn effectivity_indices(
    primal: &ErrorIndicators,
    goal: &ErrorIndicators,
) -> Vec<f64> {
    primal
        .eta
        .iter()
        .zip(goal.eta.iter())
        .map(|(&p, &g)| if p > 0.0 { g / p } else { 0.0 })
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::fem::MeshTopology;
    use crate::fem_error_estimator::{compute_h1_error_indicators, H1EstimatorParams};
    use crate::fem_face_topology::FaceTopology;
    use fullmag_ir::MeshIR;

    fn two_tet_mesh() -> (MeshTopology, FaceTopology) {
        let mesh = MeshIR {
            mesh_name: "two_tet".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 1.0, 1.0],
            ],
            elements: vec![[0, 1, 2, 3], [1, 2, 3, 4]],
            element_markers: vec![1, 1],
            boundary_faces: vec![
                [0, 1, 3],
                [0, 2, 3],
                [0, 1, 2],
                [1, 3, 4],
                [2, 3, 4],
                [1, 2, 4],
            ],
            boundary_markers: vec![1, 1, 1, 1, 1, 1],
        };
        let topo = MeshTopology::from_ir(&mesh).unwrap();
        let faces = FaceTopology::build(
            &mesh.elements,
            &mesh.nodes,
            &mesh.boundary_faces,
            &mesh.boundary_markers,
        );
        (topo, faces)
    }

    fn make_primal_indicators(n: usize) -> ErrorIndicators {
        let eta_sq: Vec<f64> = (0..n).map(|i| (i as f64 + 1.0) * 0.01).collect();
        let eta: Vec<f64> = eta_sq.iter().map(|&v| v.sqrt()).collect();
        let sum_sq: f64 = eta_sq.iter().sum();
        ErrorIndicators {
            eta_vol_sq: eta_sq.clone(),
            eta_jump_sq: vec![0.0; n],
            eta_sq,
            eta,
            eta_global: sum_sq.sqrt(),
        }
    }

    #[test]
    fn average_field_weights_sum_to_one() {
        let (topo, _) = two_tet_mesh();
        let solution = vec![0.0; topo.n_nodes];
        let qoi = AverageFieldQoi;
        let weights = qoi.element_weights(&topo, &solution).unwrap();
        let sum: f64 = weights.iter().sum();
        assert!(
            (sum - 1.0).abs() < 1e-10,
            "average-field weights should sum to ~1, got {}",
            sum
        );
    }

    #[test]
    fn energy_qoi_uniform_on_zero_solution() {
        let (topo, _) = two_tet_mesh();
        let solution = vec![0.0; topo.n_nodes];
        let nu = vec![1.0; topo.n_elements];
        let qoi = MagneticEnergyQoi { nu: &nu };
        let weights = qoi.element_weights(&topo, &solution).unwrap();
        // Zero solution → zero energy → uniform fallback
        let expected = 1.0 / topo.n_elements as f64;
        for &w in &weights {
            assert!((w - expected).abs() < 1e-12);
        }
    }

    #[test]
    fn custom_weights_wrong_length_fails() {
        let (topo, _) = two_tet_mesh();
        let solution = vec![0.0; topo.n_nodes];
        let qoi = CustomWeightsQoi {
            weights: vec![1.0],
        };
        assert!(qoi.element_weights(&topo, &solution).is_err());
    }

    #[test]
    fn goal_indicators_scale_by_weight() {
        let (topo, _) = two_tet_mesh();
        let solution = vec![0.0; topo.n_nodes];
        let primal = make_primal_indicators(topo.n_elements);

        // Weight = 1.0 everywhere → goal == primal
        let qoi_uniform = CustomWeightsQoi {
            weights: vec![1.0; topo.n_elements],
        };
        let goal = compute_goal_oriented_indicators(&GoalEstimatorParams {
            primal_indicators: &primal,
            topology: &topo,
            solution: &solution,
            qoi: &qoi_uniform,
        })
        .unwrap();

        for ei in 0..topo.n_elements {
            assert!(
                (goal.eta_sq[ei] - primal.eta_sq[ei]).abs() < 1e-12,
                "uniform weight=1 → goal == primal"
            );
        }
    }

    #[test]
    fn zero_weight_kills_indicator() {
        let (topo, _) = two_tet_mesh();
        let solution = vec![0.0; topo.n_nodes];
        let primal = make_primal_indicators(topo.n_elements);

        let qoi = CustomWeightsQoi {
            weights: vec![0.0; topo.n_elements],
        };
        let goal = compute_goal_oriented_indicators(&GoalEstimatorParams {
            primal_indicators: &primal,
            topology: &topo,
            solution: &solution,
            qoi: &qoi,
        })
        .unwrap();

        assert_eq!(goal.eta_global, 0.0);
    }

    #[test]
    fn effectivity_indices_correct() {
        let primal = make_primal_indicators(3);
        let mut goal = primal.clone();
        // Scale goal by factor k per element
        let factors = [0.5, 1.0, 2.0];
        for (ei, &f) in factors.iter().enumerate() {
            goal.eta[ei] = primal.eta[ei] * f;
            goal.eta_sq[ei] = primal.eta_sq[ei] * f * f;
        }
        let indices = effectivity_indices(&primal, &goal);
        for (ei, &f) in factors.iter().enumerate() {
            assert!(
                (indices[ei] - f).abs() < 1e-12,
                "effectivity index should be {}",
                f
            );
        }
    }

    #[test]
    fn goal_with_real_primal_estimator() {
        let (topo, faces) = two_tet_mesh();
        // Non-zero solution to get some primal indicators
        let solution = vec![0.0, 1.0, 0.5, 0.2, 0.8];
        let nu = vec![1.0; topo.n_elements];
        let source = vec![1.0; topo.n_elements];

        let primal = compute_h1_error_indicators(&H1EstimatorParams {
            topology: &topo,
            faces: &faces,
            solution: &solution,
            nu: &nu,
            source: &source,
        })
        .unwrap();

        // Use average-field QoI
        let qoi = AverageFieldQoi;
        let goal = compute_goal_oriented_indicators(&GoalEstimatorParams {
            primal_indicators: &primal,
            topology: &topo,
            solution: &solution,
            qoi: &qoi,
        })
        .unwrap();

        assert!(goal.eta_global > 0.0);
        assert_eq!(goal.eta.len(), topo.n_elements);
    }
}
