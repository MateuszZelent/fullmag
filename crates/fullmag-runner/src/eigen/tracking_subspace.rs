//! Mass-metric subspace transport for eigenmode branch tracking.
//!
//! This module intentionally owns only the numerical linear algebra.  The
//! public branch representation and the policy for assigning eligible modes
//! remain in `tracking.rs`; keeping the two separate makes it harder to turn
//! an internal gauge choice into an artifact contract by accident.

use super::hungarian_min_cost;
use crate::eigen::types::SingleKModeResult;
use nalgebra::DMatrix;
use num_complex::Complex64;

// These tolerances group numerically indistinguishable frequencies only. They
// are deliberately private until a versioned IR/artifact contract can expose
// an authored degeneracy policy; they do not certify a physical mode label.
const DEGENERACY_ABSOLUTE_FREQUENCY_TOLERANCE_HZ: f64 = 1.0e-6;
const DEGENERACY_RELATIVE_FREQUENCY_TOLERANCE: f64 = 1.0e-9;

#[derive(Debug, Clone, Copy)]
pub(super) struct TrackingModeView<'a> {
    pub(super) frequency_real_hz: f64,
    pub(super) reduced_vector: Option<&'a [Complex64]>,
    pub(super) node_mass_weights: Option<&'a [f64]>,
}

pub(super) fn mode_view(mode: &SingleKModeResult) -> TrackingModeView<'_> {
    TrackingModeView {
        frequency_real_hz: mode.frequency_real_hz,
        reduced_vector: mode.reduced_vector.as_deref(),
        node_mass_weights: mode.node_mass_weights.as_deref(),
    }
}

#[derive(Debug, Clone, Default)]
pub(super) struct BranchTrackingFrame {
    pub(super) reduced_vector: Option<Vec<Complex64>>,
    pub(super) node_mass_weights: Option<Vec<f64>>,
}

impl BranchTrackingFrame {
    pub(super) fn from_mode(mode: &SingleKModeResult) -> Self {
        Self {
            reduced_vector: mode.reduced_vector.clone(),
            node_mass_weights: mode.node_mass_weights.clone(),
        }
    }

    pub(super) fn view(&self, frequency_real_hz: f64) -> TrackingModeView<'_> {
        TrackingModeView {
            frequency_real_hz,
            reduced_vector: self.reduced_vector.as_deref(),
            node_mass_weights: self.node_mass_weights.as_deref(),
        }
    }
}

pub(super) fn complex_frequency_distance(
    previous_real_hz: f64,
    previous_imag_hz: f64,
    current_real_hz: f64,
    current_imag_hz: f64,
) -> Option<f64> {
    if !previous_real_hz.is_finite()
        || !previous_imag_hz.is_finite()
        || !current_real_hz.is_finite()
        || !current_imag_hz.is_finite()
    {
        return None;
    }
    let delta = (previous_real_hz - current_real_hz).hypot(previous_imag_hz - current_imag_hz);
    delta.is_finite().then_some(delta)
}

pub(super) fn frequencies_are_degenerate(
    previous_real_hz: f64,
    previous_imag_hz: f64,
    current_real_hz: f64,
    current_imag_hz: f64,
) -> bool {
    let Some(delta) = complex_frequency_distance(
        previous_real_hz,
        previous_imag_hz,
        current_real_hz,
        current_imag_hz,
    ) else {
        return false;
    };
    let scale = previous_real_hz
        .hypot(previous_imag_hz)
        .max(current_real_hz.hypot(current_imag_hz))
        .max(1.0);
    delta
        <= DEGENERACY_ABSOLUTE_FREQUENCY_TOLERANCE_HZ
            + DEGENERACY_RELATIVE_FREQUENCY_TOLERANCE * scale
}

fn mass_weights_match(lhs: &[f64], rhs: &[f64]) -> bool {
    lhs.len() == rhs.len()
        && lhs.iter().zip(rhs).all(|(left, right)| {
            left.is_finite()
                && right.is_finite()
                && *left > 0.0
                && *right > 0.0
                && (*left - *right).abs() <= 1.0e-12 * left.max(*right)
        })
}

fn weighted_normalized_vector(
    vector: &[Complex64],
    node_mass_weights: &[f64],
) -> Option<Vec<Complex64>> {
    if vector.is_empty()
        || node_mass_weights.is_empty()
        || vector.len() % node_mass_weights.len() != 0
    {
        return None;
    }
    let components_per_node = vector.len() / node_mass_weights.len();
    let scale = vector
        .iter()
        .map(|value| value.norm())
        .fold(0.0_f64, f64::max);
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }

    let mut weighted = Vec::with_capacity(vector.len());
    for (node, weight) in node_mass_weights.iter().copied().enumerate() {
        if !weight.is_finite() || weight <= 0.0 {
            return None;
        }
        let sqrt_weight = weight.sqrt();
        if !sqrt_weight.is_finite() || sqrt_weight <= 0.0 {
            return None;
        }
        let start = node * components_per_node;
        weighted.extend(
            vector[start..start + components_per_node]
                .iter()
                .map(|value| *value * (sqrt_weight / scale)),
        );
    }

    let norm_squared = weighted.iter().map(Complex64::norm_sqr).sum::<f64>();
    if !norm_squared.is_finite() || norm_squared <= 0.0 {
        return None;
    }
    let inverse_norm = norm_squared.sqrt().recip();
    if !inverse_norm.is_finite() {
        return None;
    }
    for value in &mut weighted {
        *value *= inverse_norm;
    }
    Some(weighted)
}

fn weighted_dot(lhs: &[Complex64], rhs: &[Complex64]) -> Option<Complex64> {
    if lhs.is_empty() || lhs.len() != rhs.len() {
        return None;
    }
    let mut result = Complex64::new(0.0, 0.0);
    for (left, right) in lhs.iter().zip(rhs) {
        if !left.re.is_finite()
            || !left.im.is_finite()
            || !right.re.is_finite()
            || !right.im.is_finite()
        {
            return None;
        }
        result += left.conj() * right;
    }
    (result.re.is_finite() && result.im.is_finite()).then_some(result)
}

fn weighted_orthonormal_basis(
    modes: &[TrackingModeView<'_>],
    node_mass_weights: &[f64],
) -> Option<Vec<Vec<Complex64>>> {
    let mut basis = Vec::<Vec<Complex64>>::with_capacity(modes.len());
    for mode in modes {
        let vector = weighted_normalized_vector(mode.reduced_vector?, node_mass_weights)?;
        let mut candidate = vector;
        // Reorthogonalization matters for nearly degenerate modes whose
        // solver vectors can be close to linearly dependent after weighting.
        for _ in 0..2 {
            for existing in &basis {
                let coefficient = weighted_dot(existing, &candidate)?;
                for (value, basis_value) in candidate.iter_mut().zip(existing) {
                    *value -= coefficient * *basis_value;
                }
            }
        }
        let norm_squared = weighted_dot(&candidate, &candidate)?.re;
        if !norm_squared.is_finite() || norm_squared <= 1.0e-20 {
            return None;
        }
        let inverse_norm = norm_squared.sqrt().recip();
        for value in &mut candidate {
            *value *= inverse_norm;
        }
        basis.push(candidate);
    }
    Some(basis)
}

fn unweight_vector(weighted: &[Complex64], node_mass_weights: &[f64]) -> Option<Vec<Complex64>> {
    if weighted.is_empty()
        || node_mass_weights.is_empty()
        || weighted.len() % node_mass_weights.len() != 0
    {
        return None;
    }
    let components_per_node = weighted.len() / node_mass_weights.len();
    let mut result = Vec::with_capacity(weighted.len());
    for (node, weight) in node_mass_weights.iter().copied().enumerate() {
        if !weight.is_finite() || weight <= 0.0 {
            return None;
        }
        let inverse_sqrt_weight = weight.sqrt().recip();
        if !inverse_sqrt_weight.is_finite() {
            return None;
        }
        let start = node * components_per_node;
        result.extend(
            weighted[start..start + components_per_node]
                .iter()
                .map(|value| *value * inverse_sqrt_weight),
        );
    }
    result
        .iter()
        .all(|value| value.re.is_finite() && value.im.is_finite())
        .then_some(result)
}

#[derive(Debug, Clone)]
pub(super) struct SubspaceTransport {
    pub(super) principal_cosines: Vec<f64>,
    pub(super) principal_minimum: f64,
    pub(super) score: f64,
    pub(super) assignments: Vec<(usize, usize)>,
    pub(super) transported_frames: Vec<Vec<Complex64>>,
}

/// Compare two equal-dimensional modal subspaces in the FE mass metric and
/// transport the current basis into the previous branch frame.  The singular
/// values of the mass-weighted cross Gram matrix are cosines of principal
/// angles; no individual raw-vector overlap is used to certify the cluster.
pub(super) fn mass_weighted_subspace_transport(
    previous: &[TrackingModeView<'_>],
    current: &[TrackingModeView<'_>],
    frequency_score: f64,
) -> Option<SubspaceTransport> {
    if previous.len() < 2 || previous.len() != current.len() || !frequency_score.is_finite() {
        return None;
    }
    let node_mass_weights = previous
        .first()?
        .node_mass_weights
        .filter(|weights| !weights.is_empty())?;
    for mode in previous.iter().chain(current) {
        let weights = mode.node_mass_weights?;
        if !mass_weights_match(node_mass_weights, weights) {
            return None;
        }
    }

    let previous_basis = weighted_orthonormal_basis(previous, node_mass_weights)?;
    let current_basis = weighted_orthonormal_basis(current, node_mass_weights)?;
    let dimension = previous_basis.len();
    if dimension < 2 || current_basis.len() != dimension {
        return None;
    }

    let cross_gram = DMatrix::from_fn(dimension, dimension, |row, column| {
        // Both bases already contain the square-root mass factor, so this is
        // the original FE inner product rather than a node-count metric.
        weighted_dot(&previous_basis[row], &current_basis[column])
            .unwrap_or_else(|| Complex64::new(f64::NAN, f64::NAN))
    });
    let svd = cross_gram.svd(true, true);
    let mut principal_cosines = svd
        .singular_values
        .iter()
        .copied()
        .map(|value| value.clamp(0.0, 1.0))
        .collect::<Vec<_>>();
    if principal_cosines.len() != dimension
        || principal_cosines.iter().any(|value| !value.is_finite())
    {
        return None;
    }
    principal_cosines.sort_by(|left, right| left.total_cmp(right));
    let principal_minimum = *principal_cosines.first()?;
    let score = (0.85 * principal_minimum + 0.15 * frequency_score).clamp(0.0, 1.0);
    if !score.is_finite() {
        return None;
    }

    let u = svd.u?;
    let v_t = svd.v_t?;
    // If C is the current basis and UΣVᴴ = PᴴMC, then C(VUᴴ) is the
    // orthogonal Procrustes transport closest to the previous basis.
    let rotation = v_t.adjoint() * u.adjoint();
    let mut assignment_cost = vec![vec![0.0; dimension]; dimension];
    for previous_index in 0..dimension {
        for current_index in 0..dimension {
            let coefficient = rotation[(current_index, previous_index)].norm();
            if !coefficient.is_finite() {
                return None;
            }
            assignment_cost[previous_index][current_index] = 1.0 - coefficient.clamp(0.0, 1.0);
        }
    }
    let assignment = hungarian_min_cost(&assignment_cost);
    if assignment.iter().any(Option::is_none) {
        return None;
    }
    let assignments = assignment
        .into_iter()
        .enumerate()
        .map(|(previous_index, current_index)| {
            current_index.map(|current_index| (previous_index, current_index))
        })
        .collect::<Option<Vec<_>>>()?;

    let mut transported_frames = Vec::with_capacity(dimension);
    for previous_index in 0..dimension {
        let mut transported = vec![Complex64::new(0.0, 0.0); current_basis[0].len()];
        for current_index in 0..dimension {
            let coefficient = rotation[(current_index, previous_index)];
            for (value, basis_value) in transported.iter_mut().zip(&current_basis[current_index]) {
                *value += coefficient * *basis_value;
            }
        }
        transported_frames.push(unweight_vector(&transported, node_mass_weights)?);
    }

    Some(SubspaceTransport {
        principal_cosines,
        principal_minimum,
        score,
        assignments,
        transported_frames,
    })
}
