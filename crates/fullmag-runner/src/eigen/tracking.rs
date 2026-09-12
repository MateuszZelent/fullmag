use crate::eigen::types::{PathSolveResult, SingleKModeResult, TrackedBranch, TrackedBranchPoint};
use fullmag_ir::ModeTrackingIR;
use num_complex::Complex64;
use std::collections::BTreeSet;

const FREQUENCY_FALLBACK_TRACKING_NOTE: &str =
    "mode tracking used a frequency-only fallback because a neighboring mode lacked a reduced vector";

#[derive(Debug, Clone, Copy, PartialEq)]
struct TrackingEdge {
    branch_id: usize,
    mode_slot: usize,
    score: f64,
}

fn normalized_complex_overlap(a: &[Complex64], b: &[Complex64]) -> Option<f64> {
    if a.is_empty() || b.is_empty() || a.len() != b.len() {
        return None;
    }

    let mut scale_a: f64 = 0.0;
    let mut scale_b: f64 = 0.0;
    for (lhs, rhs) in a.iter().zip(b.iter()) {
        if !lhs.re.is_finite() || !lhs.im.is_finite() || !rhs.re.is_finite() || !rhs.im.is_finite()
        {
            return None;
        }
        scale_a = scale_a.max(lhs.norm());
        scale_b = scale_b.max(rhs.norm());
    }
    if !(scale_a.is_finite() && scale_a > 0.0 && scale_b.is_finite() && scale_b > 0.0) {
        return None;
    }

    let mut num = Complex64::new(0.0, 0.0);
    let mut aa: f64 = 0.0;
    let mut bb: f64 = 0.0;
    for (lhs, rhs) in a.iter().zip(b.iter()) {
        let lhs = Complex64::new(lhs.re / scale_a, lhs.im / scale_a);
        let rhs = Complex64::new(rhs.re / scale_b, rhs.im / scale_b);
        num += lhs.conj() * rhs;
        aa += lhs.norm_sqr();
        bb += rhs.norm_sqr();
    }
    let denominator = aa.sqrt() * bb.sqrt();
    if !(aa.is_finite()
        && bb.is_finite()
        && denominator.is_finite()
        && denominator > 0.0
        && num.re.is_finite()
        && num.im.is_finite())
    {
        return None;
    }

    let overlap = num.norm() / denominator;
    overlap.is_finite().then(|| overlap.clamp(0.0, 1.0))
}

/// Compute the normalized modal overlap in the FE mass metric when the
/// solver supplied one positive weight for every active node.  The tracking
/// vectors contain the same number of per-node components as the lifted mode
/// representation (three Cartesian components for the native FEM path), so
/// the component count is inferred from the vector length.  Returning
/// `None` keeps the Euclidean overlap as an explicit compatibility fallback
/// for legacy artifacts and reduced vectors without an aligned mass metric.
fn normalized_mass_weighted_complex_overlap(
    a: &[Complex64],
    b: &[Complex64],
    weights_a: &[f64],
    weights_b: &[f64],
) -> Option<f64> {
    if a.is_empty()
        || b.is_empty()
        || a.len() != b.len()
        || weights_a.is_empty()
        || weights_a.len() != weights_b.len()
        || a.len() % weights_a.len() != 0
    {
        return None;
    }
    let components_per_node = a.len() / weights_a.len();
    if components_per_node == 0 {
        return None;
    }

    let mut scale_a = 0.0_f64;
    let mut scale_b = 0.0_f64;
    for (lhs, rhs) in a.iter().zip(b) {
        if !lhs.re.is_finite() || !lhs.im.is_finite() || !rhs.re.is_finite() || !rhs.im.is_finite()
        {
            return None;
        }
        scale_a = scale_a.max(lhs.norm());
        scale_b = scale_b.max(rhs.norm());
    }
    if !(scale_a.is_finite() && scale_a > 0.0 && scale_b.is_finite() && scale_b > 0.0) {
        return None;
    }

    let mut numerator = Complex64::new(0.0, 0.0);
    let mut norm_a = 0.0_f64;
    let mut norm_b = 0.0_f64;
    for node in 0..weights_a.len() {
        let weight_a = weights_a[node];
        let weight_b = weights_b[node];
        if !(weight_a.is_finite() && weight_b.is_finite() && weight_a > 0.0 && weight_b > 0.0) {
            return None;
        }
        // A mode pair is comparable only when both artifacts describe the
        // same FE metric.  Do not silently average or otherwise alter a
        // mismatched mass diagonal.
        if (weight_a - weight_b).abs() > 1.0e-12 * weight_a.max(weight_b) {
            return None;
        }
        let weight = 0.5 * (weight_a + weight_b);
        let start = node * components_per_node;
        for component in 0..components_per_node {
            let lhs = a[start + component] / scale_a;
            let rhs = b[start + component] / scale_b;
            numerator += weight * lhs.conj() * rhs;
            norm_a += weight * lhs.norm_sqr();
            norm_b += weight * rhs.norm_sqr();
        }
    }
    let denominator = norm_a.sqrt() * norm_b.sqrt();
    if !(norm_a.is_finite()
        && norm_b.is_finite()
        && denominator.is_finite()
        && denominator > 0.0
        && numerator.re.is_finite()
        && numerator.im.is_finite())
    {
        return None;
    }

    let overlap = numerator.norm() / denominator;
    overlap.is_finite().then(|| overlap.clamp(0.0, 1.0))
}

fn complex_overlap(a: &[Complex64], b: &[Complex64]) -> f64 {
    normalized_complex_overlap(a, b).unwrap_or(0.0)
}

fn finite_frequency_score(
    prev: &SingleKModeResult,
    current: &SingleKModeResult,
    window_hz: Option<f64>,
) -> Option<f64> {
    if !prev.frequency_real_hz.is_finite() || !current.frequency_real_hz.is_finite() {
        return None;
    }
    let delta = (prev.frequency_real_hz - current.frequency_real_hz).abs();
    if !delta.is_finite() {
        return None;
    }

    let score = match window_hz {
        Some(window) if window.is_finite() && window > 0.0 => {
            if delta > window {
                0.0
            } else {
                1.0 - delta / window
            }
        }
        Some(window) if window == f64::INFINITY => 1.0,
        _ => {
            let scale_hz = prev
                .frequency_real_hz
                .abs()
                .max(current.frequency_real_hz.abs())
                .max(1.0);
            1.0 / (1.0 + delta / scale_hz)
        }
    };
    score.is_finite().then(|| score.clamp(0.0, 1.0))
}

fn frequency_score(
    prev: &SingleKModeResult,
    current: &SingleKModeResult,
    window_hz: Option<f64>,
) -> f64 {
    finite_frequency_score(prev, current, window_hz).unwrap_or(0.0)
}

fn modal_overlap(prev: &SingleKModeResult, current: &SingleKModeResult) -> Option<f64> {
    match (&prev.reduced_vector, &current.reduced_vector) {
        (Some(a), Some(b)) => match (&prev.node_mass_weights, &current.node_mass_weights) {
            (Some(weights_a), Some(weights_b)) => {
                normalized_mass_weighted_complex_overlap(a, b, weights_a, weights_b)
                    .or_else(|| normalized_complex_overlap(a, b))
            }
            _ => normalized_complex_overlap(a, b),
        },
        _ => None,
    }
}

fn tracking_edge_metrics(
    prev: &SingleKModeResult,
    current: &SingleKModeResult,
    cfg: &ModeTrackingIR,
) -> Option<(f64, Option<f64>)> {
    let frequency = finite_frequency_score(prev, current, cfg.frequency_window_hz)?;
    let overlap = modal_overlap(prev, current);
    let score = match overlap {
        Some(overlap) => 0.85 * overlap + 0.15 * frequency,
        None if tracking_uses_frequency_fallback(prev, current) => frequency,
        None => return None,
    };
    score.is_finite().then(|| (score.clamp(0.0, 1.0), overlap))
}

fn tracking_edge_score(
    prev: &SingleKModeResult,
    current: &SingleKModeResult,
    cfg: &ModeTrackingIR,
) -> Option<f64> {
    tracking_edge_metrics(prev, current, cfg).map(|(score, _)| score)
}

fn edge_score(prev: &SingleKModeResult, current: &SingleKModeResult, cfg: &ModeTrackingIR) -> f64 {
    tracking_edge_score(prev, current, cfg).unwrap_or(0.0)
}

fn tracking_uses_frequency_fallback(prev: &SingleKModeResult, current: &SingleKModeResult) -> bool {
    prev.reduced_vector.is_none() || current.reduced_vector.is_none()
}

fn edge_passes_floor(
    prev: &SingleKModeResult,
    current: &SingleKModeResult,
    score: f64,
    overlap: Option<f64>,
    overlap_floor: f64,
) -> bool {
    match overlap {
        Some(overlap) => overlap >= overlap_floor,
        // Preserve the legacy frequency-only threshold explicitly. This is a
        // frequency score policy and must remain provenance-tagged as a
        // fallback; it is not evidence that a modal overlap floor was met.
        None if tracking_uses_frequency_fallback(prev, current) => score >= overlap_floor,
        None => false,
    }
}

fn greedy_matches(edges: &[TrackingEdge]) -> Vec<TrackingEdge> {
    let mut sorted_edges = edges.to_vec();
    sorted_edges.sort_by(|lhs, rhs| {
        rhs.score
            .total_cmp(&lhs.score)
            .then_with(|| lhs.branch_id.cmp(&rhs.branch_id))
            .then_with(|| lhs.mode_slot.cmp(&rhs.mode_slot))
    });

    let mut used_branches = BTreeSet::new();
    let mut used_modes = BTreeSet::new();
    sorted_edges
        .into_iter()
        .filter_map(|edge| {
            if used_branches.contains(&edge.branch_id) || used_modes.contains(&edge.mode_slot) {
                return None;
            }
            used_branches.insert(edge.branch_id);
            used_modes.insert(edge.mode_slot);
            Some(edge)
        })
        .collect()
}

fn hungarian_min_cost(cost: &[Vec<f64>]) -> Vec<Option<usize>> {
    let n = cost.len();
    if n == 0 {
        return Vec::new();
    }
    debug_assert!(cost.iter().all(|row| row.len() == n));

    // This is the standard primal-dual Hungarian algorithm for a square
    // minimum-cost assignment. `p[column]` stores the row assigned to a
    // column, while `way[column]` stores the augmenting-path predecessor.
    let mut u = vec![0.0; n + 1];
    let mut v = vec![0.0; n + 1];
    let mut p = vec![0usize; n + 1];
    let mut way = vec![0usize; n + 1];

    for row in 1..=n {
        p[0] = row;
        let mut column = 0usize;
        let mut minv = vec![f64::INFINITY; n + 1];
        let mut used = vec![false; n + 1];

        loop {
            used[column] = true;
            let assigned_row = p[column];
            let mut delta = f64::INFINITY;
            let mut next_column = 0usize;
            for candidate in 1..=n {
                if used[candidate] {
                    continue;
                }
                let reduced_cost =
                    cost[assigned_row - 1][candidate - 1] - u[assigned_row] - v[candidate];
                if reduced_cost < minv[candidate] {
                    minv[candidate] = reduced_cost;
                    way[candidate] = column;
                }
                if minv[candidate] < delta {
                    delta = minv[candidate];
                    next_column = candidate;
                }
            }
            debug_assert!(delta.is_finite());
            if !delta.is_finite() {
                return vec![None; n];
            }
            for candidate in 0..=n {
                if used[candidate] {
                    u[p[candidate]] += delta;
                    v[candidate] -= delta;
                } else {
                    minv[candidate] -= delta;
                }
            }
            column = next_column;
            if p[column] == 0 {
                break;
            }
        }

        loop {
            let previous_column = way[column];
            p[column] = p[previous_column];
            column = previous_column;
            if column == 0 {
                break;
            }
        }
    }

    let mut assignment = vec![None; n];
    for column in 1..=n {
        if p[column] != 0 {
            assignment[p[column] - 1] = Some(column - 1);
        }
    }
    assignment
}

fn hungarian_matches(
    branch_count: usize,
    mode_count: usize,
    edges: &[TrackingEdge],
) -> Vec<TrackingEdge> {
    if branch_count == 0 || mode_count == 0 {
        return Vec::new();
    }

    // Expired branches remain in the public history, but they must not make
    // the assignment matrix grow with every restart. Keep only rows that
    // have at least one eligible edge and map them back after solving.
    let mut compact_branch_ids = edges
        .iter()
        .filter(|edge| {
            edge.branch_id < branch_count && edge.mode_slot < mode_count && edge.score.is_finite()
        })
        .map(|edge| edge.branch_id)
        .collect::<Vec<_>>();
    compact_branch_ids.sort_unstable();
    compact_branch_ids.dedup();
    if compact_branch_ids.is_empty() {
        return Vec::new();
    }

    let compact_branch_count = compact_branch_ids.len();
    let mut scores = vec![vec![None; mode_count]; compact_branch_count];
    for edge in edges {
        if edge.branch_id >= branch_count || edge.mode_slot >= mode_count || !edge.score.is_finite()
        {
            continue;
        }
        let Ok(compact_branch_id) = compact_branch_ids.binary_search(&edge.branch_id) else {
            continue;
        };
        let replace = scores[compact_branch_id][edge.mode_slot]
            .map_or(true, |existing| edge.score > existing);
        if replace {
            scores[compact_branch_id][edge.mode_slot] = Some(edge.score);
        }
    }

    // Add one dummy side for every real row and column. This makes
    // unmatched branches/modes first-class choices and keeps ineligible
    // edges out of the optimum instead of forcing a rectangular pairing.
    let dimension = compact_branch_count + mode_count;
    let unmatched_cost = 1.0;
    let ineligible_cost = 2.0;
    let mut cost = vec![vec![unmatched_cost; dimension]; dimension];
    for compact_branch_id in 0..compact_branch_count {
        for mode_slot in 0..mode_count {
            cost[compact_branch_id][mode_slot] = scores[compact_branch_id][mode_slot]
                .map(|score| unmatched_cost - score)
                .unwrap_or(ineligible_cost);
        }
    }

    hungarian_min_cost(&cost)
        .into_iter()
        .enumerate()
        .take(compact_branch_count)
        .filter_map(|(compact_branch_id, assigned_column)| {
            let mode_slot = assigned_column?;
            if mode_slot >= mode_count {
                return None;
            }
            scores[compact_branch_id][mode_slot].map(|score| TrackingEdge {
                branch_id: compact_branch_ids[compact_branch_id],
                mode_slot,
                score,
            })
        })
        .collect()
}

fn assign_edges(
    method: fullmag_ir::ModeTrackingMethodIR,
    branch_count: usize,
    mode_count: usize,
    edges: &[TrackingEdge],
) -> Vec<TrackingEdge> {
    match method {
        fullmag_ir::ModeTrackingMethodIR::OverlapGreedy => greedy_matches(edges),
        fullmag_ir::ModeTrackingMethodIR::OverlapHungarian => {
            hungarian_matches(branch_count, mode_count, edges)
        }
    }
}

fn branch_is_eligible(
    samples: &[crate::eigen::types::SingleKSolveResult],
    branch: &TrackedBranch,
    current_position: usize,
    max_branch_gap: usize,
) -> bool {
    let Some(last_point) = branch.points.last() else {
        return false;
    };
    let Some(last_position) = samples
        .iter()
        .position(|sample| sample.sample.sample_index == last_point.sample_index)
    else {
        return false;
    };
    let Some(gap) = current_position
        .checked_sub(last_position)
        .and_then(|distance| distance.checked_sub(1))
    else {
        return false;
    };
    gap <= max_branch_gap
}

pub fn track_branches(result: &mut PathSolveResult, config: Option<&ModeTrackingIR>) {
    let default_cfg = ModeTrackingIR::default();
    let cfg = config.unwrap_or(&default_cfg);
    if result.samples.is_empty() {
        result.branches.clear();
        return;
    }

    // Re-running tracking must not retain assignments from the previous pass.
    for sample in &mut result.samples {
        for mode in &mut sample.modes {
            mode.branch_id = None;
        }
    }

    let first_sample_id = result.samples[0].sample.sample_index;
    let mut branches: Vec<TrackedBranch> = result.samples[0]
        .modes
        .iter_mut()
        .enumerate()
        .map(|(branch_id, mode)| {
            mode.branch_id = Some(branch_id);
            TrackedBranch {
                branch_id,
                label: Some(format!("B{branch_id}")),
                points: vec![TrackedBranchPoint {
                    sample_index: first_sample_id,
                    raw_mode_index: mode.raw_mode_index,
                    frequency_real_hz: mode.frequency_real_hz,
                    frequency_imag_hz: mode.frequency_imag_hz,
                    tracking_confidence: 1.0,
                    overlap_prev: None,
                }],
            }
        })
        .collect();
    let mut used_frequency_fallback = false;

    for sample_position in 1..result.samples.len() {
        let current_sample_id = result.samples[sample_position].sample.sample_index;
        let current_mode_count = result.samples[sample_position].modes.len();
        let mut edges = Vec::new();

        for branch in &branches {
            if !branch_is_eligible(
                &result.samples,
                branch,
                sample_position,
                cfg.max_branch_gap as usize,
            ) {
                continue;
            }
            let Some(last_point) = branch.points.last() else {
                continue;
            };
            let Some(prev_mode) = mode_for_branch_point(
                &result.samples,
                last_point.sample_index,
                last_point.raw_mode_index,
            ) else {
                continue;
            };
            for (mode_slot, current) in result.samples[sample_position].modes.iter().enumerate() {
                let Some((score, overlap)) = tracking_edge_metrics(prev_mode, current, cfg) else {
                    continue;
                };
                if edge_passes_floor(prev_mode, current, score, overlap, cfg.overlap_floor) {
                    edges.push(TrackingEdge {
                        branch_id: branch.branch_id,
                        mode_slot,
                        score,
                    });
                }
            }
        }

        let matches = assign_edges(cfg.method, branches.len(), current_mode_count, &edges);

        let mut used_modes = BTreeSet::new();
        for edge in matches {
            let (edge_used_frequency_fallback, overlap_prev) = branches
                .iter()
                .find(|branch| branch.branch_id == edge.branch_id)
                .and_then(|branch| branch.points.last())
                .and_then(|last_point| {
                    mode_for_branch_point(
                        &result.samples,
                        last_point.sample_index,
                        last_point.raw_mode_index,
                    )
                })
                .and_then(|prev_mode| {
                    result.samples[sample_position]
                        .modes
                        .get(edge.mode_slot)
                        .map(|current_mode| {
                            (
                                tracking_uses_frequency_fallback(prev_mode, current_mode),
                                modal_overlap(prev_mode, current_mode),
                            )
                        })
                })
                .unwrap_or((false, None));
            used_frequency_fallback |= edge_used_frequency_fallback;
            let Some((raw_mode_index, frequency_real_hz, frequency_imag_hz)) = result.samples
                [sample_position]
                .modes
                .get(edge.mode_slot)
                .map(|mode| {
                    (
                        mode.raw_mode_index,
                        mode.frequency_real_hz,
                        mode.frequency_imag_hz,
                    )
                })
            else {
                continue;
            };
            used_modes.insert(edge.mode_slot);
            if let Some(mode) = result.samples[sample_position]
                .modes
                .get_mut(edge.mode_slot)
            {
                mode.branch_id = Some(edge.branch_id);
            }
            if let Some(branch) = branches
                .iter_mut()
                .find(|branch| branch.branch_id == edge.branch_id)
            {
                branch.points.push(TrackedBranchPoint {
                    sample_index: current_sample_id,
                    raw_mode_index,
                    frequency_real_hz,
                    frequency_imag_hz,
                    tracking_confidence: edge.score,
                    overlap_prev,
                });
            }
        }

        for mode_slot in 0..current_mode_count {
            if used_modes.contains(&mode_slot) {
                continue;
            }
            let next_branch_id = branches.len();
            let Some((raw_mode_index, frequency_real_hz, frequency_imag_hz)) = result.samples
                [sample_position]
                .modes
                .get(mode_slot)
                .map(|mode| {
                    (
                        mode.raw_mode_index,
                        mode.frequency_real_hz,
                        mode.frequency_imag_hz,
                    )
                })
            else {
                continue;
            };
            if let Some(mode) = result.samples[sample_position].modes.get_mut(mode_slot) {
                mode.branch_id = Some(next_branch_id);
            }
            branches.push(TrackedBranch {
                branch_id: next_branch_id,
                label: Some(format!("B{next_branch_id}")),
                points: vec![TrackedBranchPoint {
                    sample_index: current_sample_id,
                    raw_mode_index,
                    frequency_real_hz,
                    frequency_imag_hz,
                    tracking_confidence: 0.0,
                    overlap_prev: None,
                }],
            });
        }
    }

    result.branches = branches;
    if used_frequency_fallback
        && !result
            .notes
            .iter()
            .any(|note| note == FREQUENCY_FALLBACK_TRACKING_NOTE)
    {
        result
            .notes
            .push(FREQUENCY_FALLBACK_TRACKING_NOTE.to_string());
    }
}

fn mode_for_branch_point(
    samples: &[crate::eigen::types::SingleKSolveResult],
    sample_index: usize,
    raw_mode_index: usize,
) -> Option<&SingleKModeResult> {
    samples
        .iter()
        .find(|sample| sample.sample.sample_index == sample_index)
        .and_then(|sample| {
            sample
                .modes
                .iter()
                .find(|mode| mode.raw_mode_index == raw_mode_index)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eigen::types::{EigenSolverModel, KSampleDescriptor, SingleKSolveResult};
    use fullmag_ir::{ModeTrackingIR, ModeTrackingMethodIR};

    fn sample(index: usize, modes: Vec<SingleKModeResult>) -> SingleKSolveResult {
        SingleKSolveResult {
            sample: KSampleDescriptor {
                sample_index: index,
                label: None,
                segment_index: None,
                path_s: index as f64,
                t_in_segment: index as f64,
                k_vector: [index as f64, 0.0, 0.0],
            },
            modes,
            relaxation_steps: 0,
            solver_model: EigenSolverModel::ReferenceScalarTangent,
            solver_notes: Vec::new(),
            solver_diagnostics: None,
        }
    }

    fn mode(
        raw_mode_index: usize,
        frequency_real_hz: f64,
        vector: [Complex64; 2],
    ) -> SingleKModeResult {
        SingleKModeResult {
            raw_mode_index,
            branch_id: None,
            frequency_real_hz,
            frequency_imag_hz: 0.0,
            angular_frequency_rad_per_s: frequency_real_hz * std::f64::consts::TAU,
            eigenvalue_real: 0.0,
            eigenvalue_imag: frequency_real_hz * std::f64::consts::TAU,
            norm: 1.0,
            mass_norm: Some(1.0),
            max_amplitude: 1.0,
            residual_norm: None,
            residual_linf: None,
            tangent_leakage_mean_abs: None,
            tangent_leakage_max_abs: None,
            tangent_leakage_weighted_relative_l2: None,
            dominant_polarization: "test".to_string(),
            reduced_vector: Some(vector.to_vec()),
            lifted_real: None,
            lifted_imag: None,
            amplitude: None,
            phase: None,
            node_mass_weights: None,
            component_participation:
                crate::eigen::ModalParticipationObservable::unavailable_without_context("cpu"),
        }
    }

    fn frequency_only_mode(raw_mode_index: usize, frequency_real_hz: f64) -> SingleKModeResult {
        SingleKModeResult {
            raw_mode_index,
            branch_id: None,
            frequency_real_hz,
            frequency_imag_hz: 0.0,
            angular_frequency_rad_per_s: frequency_real_hz,
            eigenvalue_real: frequency_real_hz,
            eigenvalue_imag: 0.0,
            norm: 1.0,
            mass_norm: Some(1.0),
            max_amplitude: 1.0,
            residual_norm: None,
            residual_linf: None,
            tangent_leakage_mean_abs: None,
            tangent_leakage_max_abs: None,
            tangent_leakage_weighted_relative_l2: None,
            dominant_polarization: "test".to_string(),
            reduced_vector: None,
            lifted_real: None,
            lifted_imag: None,
            amplitude: None,
            phase: None,
            node_mass_weights: None,
            component_participation:
                crate::eigen::ModalParticipationObservable::unavailable_without_context("cpu"),
        }
    }

    #[test]
    fn frequency_fallback_tracks_large_hz_modes_when_vectors_are_absent() {
        let mut result = PathSolveResult {
            samples: vec![
                sample(
                    0,
                    vec![frequency_only_mode(0, 2.0e9), frequency_only_mode(1, 5.0e9)],
                ),
                sample(
                    1,
                    vec![frequency_only_mode(0, 5.2e9), frequency_only_mode(1, 2.1e9)],
                ),
            ],
            branches: Vec::new(),
            solver_model: EigenSolverModel::ReferenceScalarTangent,
            notes: Vec::new(),
            include_demag: false,
            dispersion_validation: None,
            k0_kittel_validation: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };
        let cfg = ModeTrackingIR {
            method: ModeTrackingMethodIR::OverlapGreedy,
            frequency_window_hz: None,
            overlap_floor: 0.5,
            max_branch_gap: 0,
        };

        track_branches(&mut result, Some(&cfg));

        assert_eq!(result.samples[1].modes[1].branch_id, Some(0));
        assert_eq!(result.samples[1].modes[0].branch_id, Some(1));
        assert_eq!(result.branches.len(), 2);
        assert!(result.branches.iter().all(|branch| branch
            .points
            .iter()
            .skip(1)
            .all(|point| point.overlap_prev.is_none())));
        assert_eq!(
            result
                .notes
                .iter()
                .filter(|note| note.as_str() == FREQUENCY_FALLBACK_TRACKING_NOTE)
                .count(),
            1
        );

        track_branches(&mut result, Some(&cfg));

        assert_eq!(
            result
                .notes
                .iter()
                .filter(|note| note.as_str() == FREQUENCY_FALLBACK_TRACKING_NOTE)
                .count(),
            1
        );
    }

    #[test]
    fn tracking_skips_empty_intermediate_samples_without_panicking() {
        let vector = [Complex64::new(1.0, 0.0), Complex64::new(0.0, 0.0)];
        let mut result = PathSolveResult {
            samples: vec![
                sample(0, vec![mode(0, 1.0e9, vector)]),
                sample(1, Vec::new()),
                sample(2, vec![mode(0, 1.1e9, vector)]),
            ],
            branches: Vec::new(),
            solver_model: EigenSolverModel::ReferenceScalarTangent,
            notes: Vec::new(),
            include_demag: false,
            dispersion_validation: None,
            k0_kittel_validation: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };
        let cfg = ModeTrackingIR {
            method: ModeTrackingMethodIR::OverlapGreedy,
            frequency_window_hz: None,
            overlap_floor: 0.5,
            max_branch_gap: 1,
        };

        track_branches(&mut result, Some(&cfg));

        assert_eq!(result.samples[2].modes[0].branch_id, Some(0));
        assert_eq!(result.branches[0].points.len(), 2);
        assert_eq!(result.branches[0].points[1].sample_index, 2);
    }

    #[test]
    fn hungarian_assignment_maximizes_total_score_instead_of_greedy_order() {
        let edges = vec![
            TrackingEdge {
                branch_id: 0,
                mode_slot: 0,
                score: 0.90,
            },
            TrackingEdge {
                branch_id: 0,
                mode_slot: 1,
                score: 0.80,
            },
            TrackingEdge {
                branch_id: 1,
                mode_slot: 0,
                score: 0.85,
            },
            TrackingEdge {
                branch_id: 1,
                mode_slot: 1,
                score: 0.10,
            },
        ];

        let greedy = assign_edges(ModeTrackingMethodIR::OverlapGreedy, 2, 2, &edges);
        let hungarian = assign_edges(ModeTrackingMethodIR::OverlapHungarian, 2, 2, &edges);

        assert_eq!(
            greedy
                .iter()
                .map(|edge| (edge.branch_id, edge.mode_slot))
                .collect::<Vec<_>>(),
            vec![(0, 0), (1, 1)]
        );
        assert_eq!(
            hungarian
                .iter()
                .map(|edge| (edge.branch_id, edge.mode_slot))
                .collect::<Vec<_>>(),
            vec![(0, 1), (1, 0)]
        );
        assert!(hungarian.iter().map(|edge| edge.score).sum::<f64>() > 1.6);
    }

    #[test]
    fn hungarian_compacts_sparse_branch_ids_before_assignment() {
        let edges = vec![
            TrackingEdge {
                branch_id: 1_000_000,
                mode_slot: 0,
                score: 0.90,
            },
            TrackingEdge {
                branch_id: 1_000_000,
                mode_slot: 1,
                score: 0.80,
            },
            TrackingEdge {
                branch_id: 1_000_001,
                mode_slot: 0,
                score: 0.85,
            },
            TrackingEdge {
                branch_id: 1_000_001,
                mode_slot: 1,
                score: 0.10,
            },
        ];

        let matches = assign_edges(ModeTrackingMethodIR::OverlapHungarian, 1_000_002, 2, &edges);

        assert_eq!(
            matches
                .iter()
                .map(|edge| (edge.branch_id, edge.mode_slot))
                .collect::<Vec<_>>(),
            vec![(1_000_000, 1), (1_000_001, 0)]
        );
    }

    #[test]
    fn max_branch_gap_zero_restarts_after_an_empty_sample() {
        let vector = [Complex64::new(1.0, 0.0), Complex64::new(0.0, 0.0)];
        let mut result = PathSolveResult {
            samples: vec![
                sample(0, vec![mode(0, 1.0e9, vector)]),
                sample(1, Vec::new()),
                sample(2, vec![mode(0, 1.1e9, vector)]),
            ],
            branches: Vec::new(),
            solver_model: EigenSolverModel::ReferenceScalarTangent,
            notes: Vec::new(),
            include_demag: false,
            dispersion_validation: None,
            k0_kittel_validation: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };
        let cfg = ModeTrackingIR {
            method: ModeTrackingMethodIR::OverlapHungarian,
            frequency_window_hz: None,
            overlap_floor: 0.5,
            max_branch_gap: 0,
        };

        track_branches(&mut result, Some(&cfg));

        assert_eq!(result.samples[2].modes[0].branch_id, Some(1));
        assert_eq!(result.branches.len(), 2);
        assert_eq!(result.branches[0].points.len(), 1);
        assert_eq!(result.branches[1].points[0].sample_index, 2);
    }

    #[test]
    fn phase_only_changes_do_not_break_hungarian_tracking() {
        let phase = Complex64::from_polar(1.0, std::f64::consts::FRAC_PI_3);
        let base = [Complex64::new(1.0, 0.25), Complex64::new(-0.5, 0.75)];
        let rotated = [base[0] * phase, base[1] * phase];
        let mut result = PathSolveResult {
            samples: vec![
                sample(0, vec![mode(0, 1.0, base)]),
                sample(1, vec![mode(0, 1.0, rotated)]),
            ],
            branches: Vec::new(),
            solver_model: EigenSolverModel::ReferenceScalarTangent,
            notes: Vec::new(),
            include_demag: false,
            dispersion_validation: None,
            k0_kittel_validation: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };
        let cfg = ModeTrackingIR {
            method: ModeTrackingMethodIR::OverlapHungarian,
            frequency_window_hz: None,
            overlap_floor: 0.5,
            max_branch_gap: 0,
        };

        track_branches(&mut result, Some(&cfg));

        assert_eq!(result.samples[1].modes[0].branch_id, Some(0));
        assert_eq!(result.branches[0].points.len(), 2);
        assert!((result.branches[0].points[1].tracking_confidence - 1.0).abs() < 1.0e-12);
    }

    #[test]
    fn modal_overlap_uses_the_fe_node_mass_metric_when_available() {
        let mut previous = mode(0, 1.0, [Complex64::new(1.0, 0.0), Complex64::new(0.0, 0.0)]);
        let mut current = mode(0, 1.0, [Complex64::new(0.0, 0.0), Complex64::new(1.0, 0.0)]);
        // Three Cartesian entries per active node, matching the native FEM
        // lifted mode artifact layout.
        previous.reduced_vector = Some(vec![
            Complex64::new(1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ]);
        current.reduced_vector = Some(vec![
            Complex64::new(1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(-1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ]);
        previous.node_mass_weights = Some(vec![100.0, 1.0]);
        current.node_mass_weights = Some(vec![100.0, 1.0]);

        let euclidean = normalized_complex_overlap(
            previous.reduced_vector.as_ref().unwrap(),
            current.reduced_vector.as_ref().unwrap(),
        )
        .unwrap();
        let weighted = modal_overlap(&previous, &current).unwrap();
        assert!(euclidean.abs() < 1.0e-12);
        assert!((weighted - 99.0 / 101.0).abs() < 1.0e-12);
    }

    #[test]
    fn modal_overlap_falls_back_to_euclidean_for_unaligned_mass_metadata() {
        let mut previous = mode(0, 1.0, [Complex64::new(1.0, 0.0), Complex64::new(0.0, 0.0)]);
        let mut current = previous.clone();
        previous.reduced_vector = Some(vec![
            Complex64::new(1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ]);
        current.reduced_vector = Some(vec![
            Complex64::new(1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ]);
        previous.node_mass_weights = Some(vec![1.0, 2.0, 3.0]);
        current.node_mass_weights = Some(vec![1.0, 2.0]);

        assert!((modal_overlap(&previous, &current).unwrap() - 1.0).abs() < 1.0e-12);
    }

    #[test]
    fn tracked_points_export_raw_overlap_separately_from_confidence() {
        let previous = [Complex64::new(1.0, 0.0), Complex64::new(0.0, 0.0)];
        let current = [Complex64::new(0.8, 0.0), Complex64::new(0.6, 0.0)];
        let mut result = PathSolveResult {
            samples: vec![
                sample(0, vec![mode(0, 1.0, previous)]),
                sample(1, vec![mode(0, 1.0, current)]),
            ],
            branches: Vec::new(),
            solver_model: EigenSolverModel::ReferenceScalarTangent,
            notes: Vec::new(),
            include_demag: false,
            dispersion_validation: None,
            k0_kittel_validation: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };
        let cfg = ModeTrackingIR {
            method: ModeTrackingMethodIR::OverlapHungarian,
            frequency_window_hz: None,
            overlap_floor: 0.5,
            max_branch_gap: 0,
        };

        track_branches(&mut result, Some(&cfg));

        let point = &result.branches[0].points[1];
        assert!((point.overlap_prev.unwrap() - 0.8).abs() < 1.0e-12);
        assert!((point.tracking_confidence - 0.83).abs() < 1.0e-12);
        assert!((point.tracking_confidence - point.overlap_prev.unwrap()).abs() > 1.0e-3);
    }

    #[test]
    fn overlap_floor_rejects_blended_score_when_modal_overlap_is_below_floor() {
        let target_overlap = 0.43;
        let orthogonal_component = (1.0_f64 - target_overlap * target_overlap).sqrt();
        let previous = [Complex64::new(1.0, 0.0), Complex64::new(0.0, 0.0)];
        let current = [
            Complex64::new(target_overlap, 0.0),
            Complex64::new(orthogonal_component, 0.0),
        ];
        let mut result = PathSolveResult {
            samples: vec![
                sample(0, vec![mode(0, 1.0, previous)]),
                sample(1, vec![mode(0, 1.0, current)]),
            ],
            branches: Vec::new(),
            solver_model: EigenSolverModel::ReferenceScalarTangent,
            notes: Vec::new(),
            include_demag: false,
            dispersion_validation: None,
            k0_kittel_validation: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };
        let cfg = ModeTrackingIR {
            method: ModeTrackingMethodIR::OverlapHungarian,
            frequency_window_hz: None,
            overlap_floor: 0.5,
            max_branch_gap: 0,
        };

        assert!(
            edge_score(
                &result.samples[0].modes[0],
                &result.samples[1].modes[0],
                &cfg
            ) > 0.5
        );
        assert!(
            (modal_overlap(&result.samples[0].modes[0], &result.samples[1].modes[0]).unwrap()
                - target_overlap)
                .abs()
                < 1.0e-12
        );

        track_branches(&mut result, Some(&cfg));

        assert_eq!(result.samples[1].modes[0].branch_id, Some(1));
        assert_eq!(result.branches.len(), 2);
        assert_eq!(result.branches[0].points.len(), 1);
    }

    #[test]
    fn invalid_present_vectors_have_zero_finite_confidence_without_fallback() {
        let valid = mode(0, 1.0, [Complex64::new(1.0, 0.0), Complex64::new(0.0, 0.0)]);
        let zero = mode(0, 1.0, [Complex64::new(0.0, 0.0), Complex64::new(0.0, 0.0)]);
        let nan = mode(
            1,
            1.0,
            [Complex64::new(f64::NAN, 0.0), Complex64::new(0.0, 0.0)],
        );
        let mut nan_frequency = valid.clone();
        nan_frequency.frequency_real_hz = f64::NAN;
        let cfg = ModeTrackingIR {
            method: ModeTrackingMethodIR::OverlapHungarian,
            frequency_window_hz: None,
            overlap_floor: 0.0,
            max_branch_gap: 0,
        };

        assert_eq!(
            complex_overlap(
                &zero.reduced_vector.clone().unwrap(),
                &valid.reduced_vector.clone().unwrap()
            ),
            0.0
        );
        assert_eq!(
            complex_overlap(
                &nan.reduced_vector.clone().unwrap(),
                &valid.reduced_vector.clone().unwrap()
            ),
            0.0
        );
        assert_eq!(edge_score(&zero, &valid, &cfg), 0.0);
        assert_eq!(edge_score(&nan, &valid, &cfg), 0.0);
        assert_eq!(tracking_edge_score(&valid, &nan_frequency, &cfg), None);
        assert_eq!(edge_score(&valid, &nan_frequency, &cfg), 0.0);
        assert!(edge_score(&zero, &valid, &cfg).is_finite());
        assert!(edge_score(&nan, &valid, &cfg).is_finite());
        assert!(edge_score(&valid, &nan_frequency, &cfg).is_finite());

        let mut result = PathSolveResult {
            samples: vec![
                sample(0, vec![zero, nan]),
                sample(
                    1,
                    vec![
                        mode(0, 1.0, [Complex64::new(1.0, 0.0), Complex64::new(0.0, 0.0)]),
                        mode(1, 1.0, [Complex64::new(0.0, 1.0), Complex64::new(0.0, 0.0)]),
                    ],
                ),
            ],
            branches: Vec::new(),
            solver_model: EigenSolverModel::ReferenceScalarTangent,
            notes: Vec::new(),
            include_demag: false,
            dispersion_validation: None,
            k0_kittel_validation: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };

        track_branches(&mut result, Some(&cfg));

        assert_eq!(result.branches.len(), 4);
        assert_eq!(result.samples[1].modes[0].branch_id, Some(2));
        assert_eq!(result.samples[1].modes[1].branch_id, Some(3));
    }

    #[test]
    fn branch_tracking_crossing_preserves_identity_over_frequency_order_swap() {
        let a = [Complex64::new(1.0, 0.0), Complex64::new(0.0, 0.0)];
        let b = [Complex64::new(0.0, 0.0), Complex64::new(1.0, 0.0)];
        let mut result = PathSolveResult {
            samples: vec![
                sample(0, vec![mode(0, 1.0, a), mode(1, 2.0, b)]),
                sample(1, vec![mode(0, 2.1, b), mode(1, 1.1, a)]),
            ],
            branches: Vec::new(),
            solver_model: EigenSolverModel::ReferenceScalarTangent,
            notes: Vec::new(),
            include_demag: false,
            dispersion_validation: None,
            k0_kittel_validation: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };
        let cfg = ModeTrackingIR {
            method: ModeTrackingMethodIR::OverlapHungarian,
            frequency_window_hz: None,
            overlap_floor: 0.8,
            max_branch_gap: 0,
        };

        track_branches(&mut result, Some(&cfg));

        assert_eq!(result.samples[1].modes[1].branch_id, Some(0));
        assert_eq!(result.samples[1].modes[0].branch_id, Some(1));
        assert_eq!(result.branches.len(), 2);
    }
}
