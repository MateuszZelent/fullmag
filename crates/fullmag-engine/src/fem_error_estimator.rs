//! Residual-based a posteriori error estimator for FEM on tetrahedral meshes.
//!
//! Implements:
//! - Volume residual: h_K² ‖f + ∇·(ν ∇u_h)‖²_{L²(K)}
//! - Interface jump:  ½ Σ_e  h_e ‖⟦ν ∇u_h · n⟧‖²_{L²(e)}
//! - Dörfler (bulk) marking for adaptive refinement
//!
//! Currently targets the H¹ scalar case (2D A_z or 3D Poisson-like).

use crate::fem::MeshTopology;
use crate::fem_face_topology::{face_diameter, tet_diameter, FaceTopology};
use crate::{dot, EngineError, Result, Vector3};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Per-element error indicator decomposition.
#[derive(Debug, Clone)]
pub struct ErrorIndicators {
    /// η²_{K,vol} — volume residual squared, per element.
    pub eta_vol_sq: Vec<f64>,
    /// η²_{K,jump} — interface jump squared, per element.
    pub eta_jump_sq: Vec<f64>,
    /// η²_K = η²_{K,vol} + η²_{K,jump}, per element.
    pub eta_sq: Vec<f64>,
    /// η_K = √(η²_K), per element (convenience).
    pub eta: Vec<f64>,
    /// η = √(Σ η²_K) — global error estimate.
    pub eta_global: f64,
}

/// Result of Dörfler / bulk marking.
#[derive(Debug, Clone)]
pub struct MarkingResult {
    /// `true` for elements selected for refinement.
    pub marked: Vec<bool>,
    /// Number of marked elements.
    pub n_marked: usize,
    /// Fraction of marked elements.
    pub fraction_marked: f64,
    /// Fraction of total η² captured by marked set.
    pub captured_error_fraction: f64,
}

// ---------------------------------------------------------------------------
// H¹ residual + jump estimator
// ---------------------------------------------------------------------------

/// Parameters for the scalar (H¹) error estimator.
///
/// For the 2D A_z formulation: -∇·(ν ∇A) = J_z
/// or the 3D scalar Poisson: -∇·(ν ∇u) = f
pub struct H1EstimatorParams<'a> {
    /// Mesh topology (coords, elements, grad_phi, element_volumes, …).
    pub topology: &'a MeshTopology,
    /// Face topology built from the same mesh.
    pub faces: &'a FaceTopology,
    /// FE solution vector (one scalar per node).
    pub solution: &'a [f64],
    /// Per-element reluctivity ν = μ⁻¹.
    pub nu: &'a [f64],
    /// Per-element source density (J_z or f).
    pub source: &'a [f64],
}

/// Compute per-element error indicators for a scalar H¹ problem.
///
/// The estimator is:
///   η²_K = h_K² ‖f + ∇·(ν ∇u_h)‖²_{L²(K)}
///        + ½ Σ_{e ⊂ ∂K ∩ E_int} h_e ‖⟦ν ∇u_h · n⟧‖²_{L²(e)}
///
/// For P1 elements on tetrahedra, ∇u_h is constant per element, so:
/// - ∇·(ν ∇u_h) = 0  inside each element (piecewise-linear → piecewise-constant gradient).
/// - The volume residual simplifies to h_K² |f|² |K|  (source only).
/// - The jump term carries all the inter-element information.
pub fn compute_h1_error_indicators(params: &H1EstimatorParams) -> Result<ErrorIndicators> {
    let topo = params.topology;
    let faces = params.faces;
    let n_el = topo.n_elements;

    if params.solution.len() != topo.n_nodes {
        return Err(EngineError::new(format!(
            "solution length {} ≠ node count {}",
            params.solution.len(),
            topo.n_nodes
        )));
    }
    if params.nu.len() != n_el {
        return Err(EngineError::new(format!(
            "nu length {} ≠ element count {}",
            params.nu.len(),
            n_el
        )));
    }
    if params.source.len() != n_el {
        return Err(EngineError::new(format!(
            "source length {} ≠ element count {}",
            params.source.len(),
            n_el
        )));
    }

    // --- Step 1: per-element gradient (constant per P1 tet) ---
    let mut grad_u: Vec<Vector3> = Vec::with_capacity(n_el);
    for (ei, element) in topo.elements.iter().enumerate() {
        let gradients = &topo.grad_phi[ei];
        let mut g = [0.0, 0.0, 0.0];
        for li in 0..4 {
            let u_node = params.solution[element[li] as usize];
            g[0] += u_node * gradients[li][0];
            g[1] += u_node * gradients[li][1];
            g[2] += u_node * gradients[li][2];
        }
        grad_u.push(g);
    }

    // --- Step 2: volume residual ---
    // For P1 elements ∇u_h is constant per element, so div(ν ∇u_h) = 0.
    // Volume residual = h_K² |source_K|² |K|.
    let mut eta_vol_sq = Vec::with_capacity(n_el);
    for ei in 0..n_el {
        let h_k = tet_diameter(&topo.coords, &topo.elements[ei]);
        let r_k = params.source[ei]; // R_K = f - div(ν ∇u_h) = f for P1
        eta_vol_sq.push(h_k * h_k * r_k * r_k * topo.element_volumes[ei]);
    }

    // --- Step 3: interface jump ---
    // For each interior face: jump = ν_L (∇u_L · n) - ν_R (∇u_R · n)
    // distributed ½ to each element.
    let mut eta_jump_sq = vec![0.0; n_el];
    for face in &faces.interior_faces {
        let el = face.elem_left as usize;
        let er = face.elem_right as usize;
        let h_f = face_diameter(&topo.coords, &face.nodes);

        let flux_left = params.nu[el] * dot(grad_u[el], face.normal);
        let flux_right = params.nu[er] * dot(grad_u[er], face.normal);
        let jump = flux_left - flux_right;

        // ‖jump‖²_{L²(e)} = jump² · area(e)  (jump is constant on the face for P1)
        let contribution = h_f * jump * jump * face.area;
        eta_jump_sq[el] += 0.5 * contribution;
        eta_jump_sq[er] += 0.5 * contribution;
    }

    // --- Step 4: assemble total ---
    let mut eta_sq = Vec::with_capacity(n_el);
    let mut eta = Vec::with_capacity(n_el);
    let mut sum_sq = 0.0;
    for ei in 0..n_el {
        let total = eta_vol_sq[ei] + eta_jump_sq[ei];
        eta_sq.push(total);
        eta.push(total.sqrt());
        sum_sq += total;
    }

    Ok(ErrorIndicators {
        eta_vol_sq,
        eta_jump_sq,
        eta_sq,
        eta,
        eta_global: sum_sq.sqrt(),
    })
}

// ---------------------------------------------------------------------------
// Dörfler (bulk) marking
// ---------------------------------------------------------------------------

/// Select the smallest set of elements whose squared indicators sum to at
/// least `theta` times the total squared indicator.
///
/// `theta` ∈ (0, 1] — fraction of total error² to capture (e.g. 0.3).
/// `max_fraction` — safety cap on the fraction of elements that can be marked.
pub fn doerfler_marking(
    indicators: &ErrorIndicators,
    theta: f64,
    max_fraction: f64,
) -> Result<MarkingResult> {
    if !(0.0 < theta && theta <= 1.0) {
        return Err(EngineError::new(format!(
            "theta must be in (0,1], got {}",
            theta
        )));
    }
    let n = indicators.eta_sq.len();
    if n == 0 {
        return Ok(MarkingResult {
            marked: vec![],
            n_marked: 0,
            fraction_marked: 0.0,
            captured_error_fraction: 0.0,
        });
    }

    let total_sq: f64 = indicators.eta_sq.iter().sum();
    if total_sq <= 0.0 {
        return Ok(MarkingResult {
            marked: vec![false; n],
            n_marked: 0,
            fraction_marked: 0.0,
            captured_error_fraction: 0.0,
        });
    }

    let target = theta * total_sq;
    let max_marked = ((max_fraction * n as f64).ceil() as usize).min(n);

    // Sort element indices by η²_K descending.
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_unstable_by(|&a, &b| {
        indicators.eta_sq[b]
            .partial_cmp(&indicators.eta_sq[a])
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut marked = vec![false; n];
    let mut accumulated = 0.0;
    let mut count = 0;

    for &ei in &order {
        if accumulated >= target || count >= max_marked {
            break;
        }
        marked[ei] = true;
        accumulated += indicators.eta_sq[ei];
        count += 1;
    }

    Ok(MarkingResult {
        marked,
        n_marked: count,
        fraction_marked: count as f64 / n as f64,
        captured_error_fraction: accumulated / total_sq,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fem::MeshTopology;
    use crate::fem_face_topology::FaceTopology;
    use fullmag_ir::MeshIR;

    /// Build a two-tet mesh: two tets sharing the face (0,1,2).
    /// Tet 0 = {0,1,2,3}, Tet 1 = {0,1,2,4}.
    fn two_tet_mesh_and_topology() -> (MeshTopology, FaceTopology) {
        let mesh = MeshIR {
            mesh_name: "two_tet".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, -1.0],
            ],
            elements: vec![[0, 1, 2, 3], [0, 1, 2, 4]],
            element_markers: vec![1, 1],
            boundary_faces: vec![
                [0, 1, 3],
                [0, 2, 3],
                [1, 2, 3],
                [0, 1, 4],
                [0, 2, 4],
                [1, 2, 4],
            ],
            boundary_markers: vec![1; 6],
        };
        let topo = MeshTopology::from_ir(&mesh).expect("topology");
        let faces = FaceTopology::build(
            &topo.elements,
            &topo.coords,
            &mesh.boundary_faces,
            &mesh.boundary_markers,
        );
        (topo, faces)
    }

    #[test]
    fn zero_solution_with_zero_source_gives_zero_indicators() {
        let (topo, faces) = two_tet_mesh_and_topology();
        let solution = vec![0.0; topo.n_nodes];
        let nu = vec![1.0; topo.n_elements];
        let source = vec![0.0; topo.n_elements];

        let indicators = compute_h1_error_indicators(&H1EstimatorParams {
            topology: &topo,
            faces: &faces,
            solution: &solution,
            nu: &nu,
            source: &source,
        })
        .expect("indicators");

        assert!(indicators.eta_global < 1e-30);
        for e in &indicators.eta_sq {
            assert!(*e < 1e-30);
        }
    }

    #[test]
    fn uniform_gradient_with_same_nu_gives_zero_jumps() {
        // If u(x,y,z) = x, then ∇u = (1,0,0) everywhere → no jumps.
        let (topo, faces) = two_tet_mesh_and_topology();
        let solution: Vec<f64> = topo.coords.iter().map(|c| c[0]).collect();
        let nu = vec![1.0; topo.n_elements];
        let source = vec![0.0; topo.n_elements];

        let indicators = compute_h1_error_indicators(&H1EstimatorParams {
            topology: &topo,
            faces: &faces,
            solution: &solution,
            nu: &nu,
            source: &source,
        })
        .expect("indicators");

        for &j in &indicators.eta_jump_sq {
            assert!(j < 1e-24, "jump should be zero for uniform gradient, got {}", j);
        }
    }

    #[test]
    fn different_nu_produces_nonzero_jump() {
        // u(x,y,z) = z, ν₀ = 1, ν₁ = 100 → jump at interface.
        // Shared face (0,1,2) lies in z=0 plane with normal ~ (0,0,±1).
        // ∇u = (0,0,1), so flux·n ≠ 0.
        let (topo, faces) = two_tet_mesh_and_topology();
        let solution: Vec<f64> = topo.coords.iter().map(|c| c[2]).collect();
        let nu = vec![1.0, 100.0];
        let source = vec![0.0; topo.n_elements];

        let indicators = compute_h1_error_indicators(&H1EstimatorParams {
            topology: &topo,
            faces: &faces,
            solution: &solution,
            nu: &nu,
            source: &source,
        })
        .expect("indicators");

        let total_jump: f64 = indicators.eta_jump_sq.iter().sum();
        assert!(total_jump > 0.0, "jump must be nonzero when ν differs, got {}", total_jump);
    }

    #[test]
    fn nonzero_source_produces_nonzero_volume_residual() {
        let (topo, faces) = two_tet_mesh_and_topology();
        let solution = vec![0.0; topo.n_nodes];
        let nu = vec![1.0; topo.n_elements];
        let source = vec![1e6, 1e6]; // J_z ≠ 0

        let indicators = compute_h1_error_indicators(&H1EstimatorParams {
            topology: &topo,
            faces: &faces,
            solution: &solution,
            nu: &nu,
            source: &source,
        })
        .expect("indicators");

        for &v in &indicators.eta_vol_sq {
            assert!(v > 0.0, "volume residual should be nonzero with J_z ≠ 0");
        }
        assert!(indicators.eta_global > 0.0);
    }

    #[test]
    fn doerfler_marking_selects_worst_elements() {
        // Give element 1 a much larger indicator.
        let indicators = ErrorIndicators {
            eta_vol_sq: vec![0.01, 1.0, 0.01],
            eta_jump_sq: vec![0.0, 0.0, 0.0],
            eta_sq: vec![0.01, 1.0, 0.01],
            eta: vec![0.1, 1.0, 0.1],
            eta_global: (0.01 + 1.0 + 0.01_f64).sqrt(),
        };

        let result = doerfler_marking(&indicators, 0.3, 0.8).expect("marking");
        assert!(result.marked[1], "element 1 should be marked");
        assert_eq!(result.n_marked, 1);
        assert!(result.captured_error_fraction >= 0.3);
    }

    #[test]
    fn doerfler_respects_max_fraction() {
        let n = 100;
        let indicators = ErrorIndicators {
            eta_vol_sq: vec![1.0; n],
            eta_jump_sq: vec![0.0; n],
            eta_sq: vec![1.0; n],
            eta: vec![1.0; n],
            eta_global: (n as f64).sqrt(),
        };

        // theta=1.0 would want all elements, but max_fraction=0.2 caps at 20.
        let result = doerfler_marking(&indicators, 1.0, 0.2).expect("marking");
        assert!(result.n_marked <= 20);
    }

    #[test]
    fn doerfler_on_empty_mesh() {
        let indicators = ErrorIndicators {
            eta_vol_sq: vec![],
            eta_jump_sq: vec![],
            eta_sq: vec![],
            eta: vec![],
            eta_global: 0.0,
        };
        let result = doerfler_marking(&indicators, 0.3, 0.8).expect("marking");
        assert_eq!(result.n_marked, 0);
    }

    #[test]
    fn invalid_theta_is_rejected() {
        let indicators = ErrorIndicators {
            eta_vol_sq: vec![1.0],
            eta_jump_sq: vec![0.0],
            eta_sq: vec![1.0],
            eta: vec![1.0],
            eta_global: 1.0,
        };
        assert!(doerfler_marking(&indicators, 0.0, 0.8).is_err());
        assert!(doerfler_marking(&indicators, 1.5, 0.8).is_err());
    }
}
