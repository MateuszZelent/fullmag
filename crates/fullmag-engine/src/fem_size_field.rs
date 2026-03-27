//! Adaptive size-field computation and gradation limiting.
//!
//! Takes per-element error indicators η_K and produces a target element size
//! field h_target that can be fed into Gmsh as a background mesh / PostView.
//!
//! Two modes:
//! - **Continuous** (equi-distribution): h_K^new = clip(h_K^old · (η_tar / (η_K + ε))^α, h_min, h_max)
//! - **Dörfler-based** (binary): marked → γ · h_K, unmarked → h_K
//!
//! After either mode a **gradation limiter** enforces a maximum size ratio
//! between neighbouring elements to prevent brutal mesh transitions.

use crate::fem::MeshTopology;
use crate::fem_error_estimator::{ErrorIndicators, MarkingResult};
use crate::fem_face_topology::{tet_diameter, FaceTopology};
use crate::{EngineError, Result};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Parameters for the continuous (equi-distribution) size field.
#[derive(Debug, Clone, Copy)]
pub struct SizeFieldConfig {
    /// Global error tolerance (TOL).  Used to derive η_tar = TOL / √N_el.
    pub tolerance: f64,
    /// Exponent α in h_new = h_old · (η_tar / η_K)^α.
    /// Recommended: 0.5 (2D), 0.35–0.5 (3D).
    pub alpha: f64,
    /// Absolute minimum element size.
    pub h_min: f64,
    /// Absolute maximum element size.
    pub h_max: f64,
    /// Maximum ratio h_K / h_K' between neighbours (gradation limit).
    pub grad_limit: f64,
}

impl Default for SizeFieldConfig {
    fn default() -> Self {
        Self {
            tolerance: 1e-3,
            alpha: 0.5,
            h_min: 1e-12,
            h_max: 1e30,
            grad_limit: 1.3,
        }
    }
}

/// Parameters for the simpler Dörfler-based (binary) size field.
#[derive(Debug, Clone, Copy)]
pub struct DoerflerSizeFieldConfig {
    /// Refinement factor applied to marked elements. Typically 0.5.
    pub gamma: f64,
    /// Absolute minimum element size.
    pub h_min: f64,
    /// Absolute maximum element size.
    pub h_max: f64,
    /// Maximum ratio h_K / h_K' between neighbours.
    pub grad_limit: f64,
}

impl Default for DoerflerSizeFieldConfig {
    fn default() -> Self {
        Self {
            gamma: 0.5,
            h_min: 1e-12,
            h_max: 1e30,
            grad_limit: 1.3,
        }
    }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/// Per-element target sizes (result of the size-field computation).
#[derive(Debug, Clone)]
pub struct SizeField {
    /// Target element diameter h_K^new, one per element.
    pub h_target: Vec<f64>,
    /// Current element diameters h_K^old, one per element (for diagnostics).
    pub h_current: Vec<f64>,
    /// Ratio h_new / h_old per element (< 1 means refinement, > 1 coarsening).
    pub ratio: Vec<f64>,
    /// Number of gradation-limiter iterations used.
    pub gradation_iterations: usize,
}

// ---------------------------------------------------------------------------
// Continuous equi-distribution size field
// ---------------------------------------------------------------------------

/// Compute a target size field using the continuous equi-distribution formula:
///
///   h_K^new = clip( h_K^old · (η_tar / (η_K + ε))^α,  h_min, h_max )
///
/// where η_tar = TOL / √N_el.
pub fn compute_continuous_size_field(
    topology: &MeshTopology,
    indicators: &ErrorIndicators,
    faces: &FaceTopology,
    config: &SizeFieldConfig,
) -> Result<SizeField> {
    validate_continuous_config(config)?;

    let n_el = topology.n_elements;
    if indicators.eta.len() != n_el {
        return Err(EngineError::new(format!(
            "indicator count {} ≠ element count {}",
            indicators.eta.len(),
            n_el
        )));
    }

    // Current diameters
    let h_current: Vec<f64> = (0..n_el)
        .map(|ei| tet_diameter(&topology.coords, &topology.elements[ei]))
        .collect();

    // Target per-element indicator
    let eta_tar = config.tolerance / (n_el as f64).sqrt().max(1.0);

    // Regularisation ε = 1e-14 · max(η_K)
    let eta_max = indicators.eta.iter().cloned().fold(0.0_f64, f64::max);
    let eps = 1e-14 * eta_max.max(1e-30);

    // Compute raw target sizes
    let mut h_target: Vec<f64> = (0..n_el)
        .map(|ei| {
            let ratio = eta_tar / (indicators.eta[ei] + eps);
            let h_new = h_current[ei] * ratio.powf(config.alpha);
            h_new.clamp(config.h_min, config.h_max)
        })
        .collect();

    // Apply gradation limiter
    let gradation_iterations = apply_gradation_limit(faces, &mut h_target, config.grad_limit, 100);

    // Clamp again after gradation (safety)
    for h in h_target.iter_mut() {
        *h = h.clamp(config.h_min, config.h_max);
    }

    let ratio: Vec<f64> = h_target
        .iter()
        .zip(h_current.iter())
        .map(|(&h_new, &h_old)| if h_old > 0.0 { h_new / h_old } else { 1.0 })
        .collect();

    Ok(SizeField {
        h_target,
        h_current,
        ratio,
        gradation_iterations,
    })
}

// ---------------------------------------------------------------------------
// Dörfler-based binary size field
// ---------------------------------------------------------------------------

/// Compute a target size field from Dörfler marking:
///
///   h_K^new = γ · h_K   if marked
///   h_K^new = h_K       otherwise
pub fn compute_doerfler_size_field(
    topology: &MeshTopology,
    marking: &MarkingResult,
    faces: &FaceTopology,
    config: &DoerflerSizeFieldConfig,
) -> Result<SizeField> {
    validate_doerfler_config(config)?;

    let n_el = topology.n_elements;
    if marking.marked.len() != n_el {
        return Err(EngineError::new(format!(
            "marking length {} ≠ element count {}",
            marking.marked.len(),
            n_el
        )));
    }

    let h_current: Vec<f64> = (0..n_el)
        .map(|ei| tet_diameter(&topology.coords, &topology.elements[ei]))
        .collect();

    let mut h_target: Vec<f64> = (0..n_el)
        .map(|ei| {
            let h = if marking.marked[ei] {
                config.gamma * h_current[ei]
            } else {
                h_current[ei]
            };
            h.clamp(config.h_min, config.h_max)
        })
        .collect();

    let gradation_iterations = apply_gradation_limit(faces, &mut h_target, config.grad_limit, 100);

    for h in h_target.iter_mut() {
        *h = h.clamp(config.h_min, config.h_max);
    }

    let ratio: Vec<f64> = h_target
        .iter()
        .zip(h_current.iter())
        .map(|(&h_new, &h_old)| if h_old > 0.0 { h_new / h_old } else { 1.0 })
        .collect();

    Ok(SizeField {
        h_target,
        h_current,
        ratio,
        gradation_iterations,
    })
}

// ---------------------------------------------------------------------------
// Gradation limiter
// ---------------------------------------------------------------------------

/// Iteratively enforce a maximum size ratio between neighbouring elements.
///
/// For each interior face (K, K'), if h[K] > g · h[K'], set h[K] = g · h[K']
/// (and vice versa).  Repeats until convergence or `max_iterations`.
///
/// Returns the number of iterations used.
pub fn apply_gradation_limit(
    faces: &FaceTopology,
    h_target: &mut [f64],
    grad_limit: f64,
    max_iterations: usize,
) -> usize {
    let g = grad_limit.max(1.0);

    for iteration in 0..max_iterations {
        let mut changed = false;

        for face in &faces.interior_faces {
            let el = face.elem_left as usize;
            let er = face.elem_right as usize;

            if h_target[el] > g * h_target[er] {
                h_target[el] = g * h_target[er];
                changed = true;
            }
            if h_target[er] > g * h_target[el] {
                h_target[er] = g * h_target[el];
                changed = true;
            }
        }

        if !changed {
            return iteration + 1;
        }
    }

    max_iterations
}

// ---------------------------------------------------------------------------
// Nodal interpolation (for Gmsh PostView export)
// ---------------------------------------------------------------------------

/// Convert a per-element size field to per-node values via volume-weighted
/// averaging.  Suitable for Gmsh NodeData PostView.
pub fn element_to_nodal_size_field(
    topology: &MeshTopology,
    h_element: &[f64],
) -> Result<Vec<f64>> {
    let n_el = topology.n_elements;
    let n_nodes = topology.n_nodes;

    if h_element.len() != n_el {
        return Err(EngineError::new(format!(
            "h_element length {} ≠ element count {}",
            h_element.len(),
            n_el
        )));
    }

    let mut nodal_h = vec![0.0; n_nodes];
    let mut nodal_weight = vec![0.0; n_nodes];

    for (ei, element) in topology.elements.iter().enumerate() {
        let vol = topology.element_volumes[ei];
        for &node in element {
            let ni = node as usize;
            nodal_h[ni] += h_element[ei] * vol;
            nodal_weight[ni] += vol;
        }
    }

    for i in 0..n_nodes {
        if nodal_weight[i] > 0.0 {
            nodal_h[i] /= nodal_weight[i];
        }
    }

    Ok(nodal_h)
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

fn validate_continuous_config(config: &SizeFieldConfig) -> Result<()> {
    if config.tolerance <= 0.0 {
        return Err(EngineError::new("tolerance must be positive"));
    }
    if config.alpha <= 0.0 || config.alpha > 1.0 {
        return Err(EngineError::new("alpha must be in (0, 1]"));
    }
    if config.h_min <= 0.0 {
        return Err(EngineError::new("h_min must be positive"));
    }
    if config.h_max <= config.h_min {
        return Err(EngineError::new("h_max must be > h_min"));
    }
    if config.grad_limit < 1.0 {
        return Err(EngineError::new("grad_limit must be >= 1.0"));
    }
    Ok(())
}

fn validate_doerfler_config(config: &DoerflerSizeFieldConfig) -> Result<()> {
    if config.gamma <= 0.0 || config.gamma >= 1.0 {
        return Err(EngineError::new("gamma must be in (0, 1)"));
    }
    if config.h_min <= 0.0 {
        return Err(EngineError::new("h_min must be positive"));
    }
    if config.h_max <= config.h_min {
        return Err(EngineError::new("h_max must be > h_min"));
    }
    if config.grad_limit < 1.0 {
        return Err(EngineError::new("grad_limit must be >= 1.0"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fem::MeshTopology;
    use crate::fem_error_estimator::{
        compute_h1_error_indicators, doerfler_marking, ErrorIndicators, H1EstimatorParams,
    };
    use crate::fem_face_topology::FaceTopology;
    use fullmag_ir::MeshIR;

    /// Same two-tet mesh as in the estimator tests.
    fn two_tet_mesh() -> (MeshTopology, FaceTopology) {
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

    fn make_indicators(eta_values: Vec<f64>) -> ErrorIndicators {
        let eta_sq: Vec<f64> = eta_values.iter().map(|e| e * e).collect();
        let sum_sq: f64 = eta_sq.iter().sum();
        ErrorIndicators {
            eta_vol_sq: vec![0.0; eta_values.len()],
            eta_jump_sq: eta_sq.clone(),
            eta_sq,
            eta: eta_values,
            eta_global: sum_sq.sqrt(),
        }
    }

    // -----------------------------------------------------------------------
    // Continuous size field
    // -----------------------------------------------------------------------

    #[test]
    fn continuous_field_refines_high_error_elements() {
        let (topo, faces) = two_tet_mesh();
        // Element 0 has much larger error than element 1.
        let indicators = make_indicators(vec![10.0, 0.1]);
        let config = SizeFieldConfig {
            tolerance: 1.0,
            alpha: 0.5,
            h_min: 1e-6,
            h_max: 100.0,
            grad_limit: 2.0,
        };

        let sf = compute_continuous_size_field(&topo, &indicators, &faces, &config)
            .expect("size field");

        assert_eq!(sf.h_target.len(), 2);
        // Element 0 should get a smaller target size than element 1.
        assert!(
            sf.h_target[0] < sf.h_target[1],
            "high-error element should get smaller h: {} vs {}",
            sf.h_target[0],
            sf.h_target[1]
        );
    }

    #[test]
    fn continuous_field_respects_h_min_h_max() {
        let (topo, faces) = two_tet_mesh();
        let indicators = make_indicators(vec![1e10, 1e-10]);
        let config = SizeFieldConfig {
            tolerance: 1.0,
            alpha: 0.5,
            h_min: 0.1,
            h_max: 2.0,
            grad_limit: 100.0, // loose — no effective gradation
        };

        let sf = compute_continuous_size_field(&topo, &indicators, &faces, &config)
            .expect("size field");

        for h in &sf.h_target {
            assert!(*h >= 0.1 - 1e-15, "h={} < h_min", h);
            assert!(*h <= 2.0 + 1e-15, "h={} > h_max", h);
        }
    }

    #[test]
    fn continuous_field_invalid_config_rejected() {
        let (topo, faces) = two_tet_mesh();
        let indicators = make_indicators(vec![1.0, 1.0]);

        let bad_tol = SizeFieldConfig {
            tolerance: -1.0,
            ..SizeFieldConfig::default()
        };
        assert!(compute_continuous_size_field(&topo, &indicators, &faces, &bad_tol).is_err());

        let bad_alpha = SizeFieldConfig {
            alpha: 0.0,
            ..SizeFieldConfig::default()
        };
        assert!(compute_continuous_size_field(&topo, &indicators, &faces, &bad_alpha).is_err());
    }

    // -----------------------------------------------------------------------
    // Dörfler-based size field
    // -----------------------------------------------------------------------

    #[test]
    fn doerfler_field_refines_marked_only() {
        let (topo, faces) = two_tet_mesh();
        let marking = MarkingResult {
            marked: vec![true, false],
            n_marked: 1,
            fraction_marked: 0.5,
            captured_error_fraction: 0.9,
        };
        let config = DoerflerSizeFieldConfig {
            gamma: 0.5,
            h_min: 1e-6,
            h_max: 100.0,
            grad_limit: 2.0,
        };

        let sf = compute_doerfler_size_field(&topo, &marking, &faces, &config).expect("size field");

        // Element 0 marked → h_new ≈ 0.5 · h_old
        assert!(sf.ratio[0] < 0.6, "marked element ratio should be ~0.5, got {}", sf.ratio[0]);
        // Element 1 not marked → h_new ≈ h_old (ratio ~1, maybe slightly reduced by gradation)
        assert!(sf.ratio[1] >= 0.5, "unmarked element ratio should be ≥0.5, got {}", sf.ratio[1]);
    }

    #[test]
    fn doerfler_field_respects_h_min() {
        let (topo, faces) = two_tet_mesh();
        let marking = MarkingResult {
            marked: vec![true, true],
            n_marked: 2,
            fraction_marked: 1.0,
            captured_error_fraction: 1.0,
        };
        // Set h_min very large so it clamps everything upward
        let config = DoerflerSizeFieldConfig {
            gamma: 0.5,
            h_min: 10.0,
            h_max: 100.0,
            grad_limit: 1.3,
        };

        let sf = compute_doerfler_size_field(&topo, &marking, &faces, &config).expect("size field");

        for h in &sf.h_target {
            assert!(*h >= 10.0 - 1e-15, "h={} < h_min=10", h);
        }
    }

    // -----------------------------------------------------------------------
    // Gradation limiter
    // -----------------------------------------------------------------------

    #[test]
    fn gradation_limiter_enforces_ratio() {
        let (topo, faces) = two_tet_mesh();
        // Extreme mismatch: element 0 tiny, element 1 huge.
        let mut h = vec![0.01, 100.0];

        let iters = apply_gradation_limit(&faces, &mut h, 1.5, 100);

        let ratio = h[0].max(h[1]) / h[0].min(h[1]);
        assert!(
            ratio <= 1.5 + 1e-12,
            "ratio {} should be ≤ 1.5 after gradation",
            ratio
        );
        assert!(iters <= 100);
    }

    #[test]
    fn gradation_converges_for_uniform_field() {
        let (_, faces) = two_tet_mesh();
        let mut h = vec![1.0, 1.0];
        let iters = apply_gradation_limit(&faces, &mut h, 1.3, 100);
        // Uniform → no changes needed → converges in 1 iteration.
        assert_eq!(iters, 1);
        assert!((h[0] - 1.0).abs() < 1e-15);
        assert!((h[1] - 1.0).abs() < 1e-15);
    }

    // -----------------------------------------------------------------------
    // Nodal interpolation
    // -----------------------------------------------------------------------

    #[test]
    fn nodal_interpolation_preserves_uniform_field() {
        let (topo, _) = two_tet_mesh();
        let h_elem = vec![2.0; topo.n_elements];

        let nodal = element_to_nodal_size_field(&topo, &h_elem).expect("nodal");

        assert_eq!(nodal.len(), topo.n_nodes);
        for val in &nodal {
            assert!(
                (*val - 2.0).abs() < 1e-12,
                "uniform field should be preserved, got {}",
                val
            );
        }
    }

    #[test]
    fn nodal_interpolation_is_bounded_by_element_range() {
        let (topo, _) = two_tet_mesh();
        let h_elem = vec![1.0, 10.0];

        let nodal = element_to_nodal_size_field(&topo, &h_elem).expect("nodal");

        for val in &nodal {
            assert!(*val >= 1.0 - 1e-12, "nodal value {} < min element h", val);
            assert!(*val <= 10.0 + 1e-12, "nodal value {} > max element h", val);
        }
    }

    // -----------------------------------------------------------------------
    // Full pipeline integration: estimator → marking → size field
    // -----------------------------------------------------------------------

    #[test]
    fn full_pipeline_estimator_to_size_field() {
        let (topo, faces) = two_tet_mesh();
        // u(x,y,z) = z with ν jump across interface → nonzero estimator.
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

        assert!(indicators.eta_global > 0.0);

        // Dörfler path
        let marking = doerfler_marking(&indicators, 0.3, 0.8).expect("marking");
        assert!(marking.n_marked > 0);

        let sf_doerfler = compute_doerfler_size_field(
            &topo,
            &marking,
            &faces,
            &DoerflerSizeFieldConfig::default(),
        )
        .expect("doerfler size field");
        assert!(sf_doerfler.h_target.iter().all(|h| *h > 0.0));

        // Continuous path
        let sf_continuous = compute_continuous_size_field(
            &topo,
            &indicators,
            &faces,
            &SizeFieldConfig {
                tolerance: 1.0,
                alpha: 0.5,
                h_min: 1e-6,
                h_max: 100.0,
                grad_limit: 1.5,
            },
        )
        .expect("continuous size field");
        assert!(sf_continuous.h_target.iter().all(|h| *h > 0.0));

        // Nodal export
        let nodal = element_to_nodal_size_field(&topo, &sf_continuous.h_target).expect("nodal");
        assert_eq!(nodal.len(), topo.n_nodes);
        assert!(nodal.iter().all(|h| *h > 0.0));
    }
}
