use crate::eigen::types::{PathSolveResult, SingleKModeResult, TrackedBranch, TrackedBranchPoint};
use fullmag_ir::ModeTrackingIR;
use num_complex::Complex64;
use std::collections::BTreeSet;

#[path = "tracking_subspace.rs"]
mod tracking_subspace;
use self::tracking_subspace::{
    complex_frequency_distance, frequencies_are_degenerate, mass_weighted_subspace_transport,
    mode_view, BranchTrackingFrame, SubspaceTransport, TrackingModeView,
};

const FREQUENCY_FALLBACK_TRACKING_NOTE: &str =
    "mode tracking used a frequency-only fallback because a neighboring mode lacked a reduced vector";
const DEGENERATE_SUBSPACE_TRACKING_NOTE: &str =
    "mode tracking used mass-weighted principal-angle subspace transport for a frequency-degenerate cluster; individual labels inside that cluster are gauge-dependent";

#[derive(Debug, Clone, Copy, PartialEq)]
struct TrackingEdge {
    branch_id: usize,
    mode_slot: usize,
    score: f64,
    /// A subspace transport edge has no physically meaningful one-vector
    /// overlap.  Keep that distinction in the internal assignment so the
    /// public `overlap_prev` field is never populated with a fabricated
    /// pointwise value.
    subspace_transport: bool,
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

/// Fixed number of tangent (Cartesian) components stored per mesh node in a
/// mode-tracking `reduced_vector`. This must be a known constant rather than
/// inferred as `a.len() / weights_a.len()`: with the mismatched indexing
/// described in audit finding H1 (`reduced_vector` covers every mesh node,
/// `node_mass_weights` covers only active nodes), that division can
/// coincidentally come out even and silently pair a weight with the wrong
/// node's DOFs, producing a wrong overlap value with no diagnostic at all.
/// Requiring an exact `a.len() == weights_a.len() * TRACKING_VECTOR_COMPONENTS_PER_NODE`
/// relationship instead turns that silent-wrong-answer failure mode into a
/// clean, detectable `MassWeightedOverlapOutcome::LengthMismatch`.
pub(crate) const TRACKING_VECTOR_COMPONENTS_PER_NODE: usize = 3;

/// Outcome of attempting to compute a mass-weighted modal overlap between
/// two tracking vectors (audit finding H1).
///
/// This is deliberately richer than `Option<f64>`: a genuine index/length
/// mismatch between an artifact's `reduced_vector` (full mesh-node order)
/// and its `node_mass_weights` (today, active-node order only -- see the
/// module-level note near `modal_overlap_views`) is evidence of a real data
/// problem, not merely "no mass metric was supplied", and callers must be
/// able to tell the two apart instead of silently mislabeling one as the
/// other.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum MassWeightedOverlapOutcome {
    /// A mass-weighted overlap value was actually computed.
    Computed(f64),
    /// Both sides carried a `reduced_vector` and `node_mass_weights`, but
    /// their lengths were inconsistent with the fixed
    /// `TRACKING_VECTOR_COMPONENTS_PER_NODE`-per-node layout (e.g. modes
    /// from incompatible mesh reductions, or -- currently the common case in
    /// production, see audit finding H1 -- `node_mass_weights` published in
    /// active-node order while `reduced_vector` is published in full
    /// mesh-node order).
    LengthMismatch,
    /// The mass metric could not be evaluated for another reason: empty
    /// input, non-finite entries, or a node whose weight does not agree
    /// between the two sides within tolerance. This is an unavailable
    /// physical metric; callers must not silently replace it with an
    /// unweighted overlap.
    NotComputable,
}

/// Compute the normalized modal overlap in the FE mass metric when the
/// solver supplied one weight per active node.  See
/// `TRACKING_VECTOR_COMPONENTS_PER_NODE` for why the per-node component
/// count is a fixed constant rather than inferred from the input lengths.
///
/// A weight of exactly `0.0` on both sides is treated as an explicit
/// "inactive / padding" sentinel for that node (skipped, not counted as a
/// failure): this lets a future `node_mass_weights` representation that is
/// broadcast to the full mesh-node count with `0.0` for inactive nodes (see
/// audit finding H1, option (b)) be handled without change here, while a
/// node considered active by either side must still have a strictly
/// positive, mutually agreeing weight on both sides.
pub(crate) fn mass_weighted_overlap_outcome(
    a: &[Complex64],
    b: &[Complex64],
    weights_a: &[f64],
    weights_b: &[f64],
) -> MassWeightedOverlapOutcome {
    use MassWeightedOverlapOutcome::{Computed, LengthMismatch, NotComputable};

    if a.is_empty() || b.is_empty() || weights_a.is_empty() || weights_b.is_empty() {
        return NotComputable;
    }
    let expected_vector_len = weights_a
        .len()
        .checked_mul(TRACKING_VECTOR_COMPONENTS_PER_NODE);
    if a.len() != b.len()
        || weights_a.len() != weights_b.len()
        || expected_vector_len != Some(a.len())
    {
        return LengthMismatch;
    }

    let mut scale_a = 0.0_f64;
    let mut scale_b = 0.0_f64;
    for (lhs, rhs) in a.iter().zip(b) {
        if !lhs.re.is_finite() || !lhs.im.is_finite() || !rhs.re.is_finite() || !rhs.im.is_finite()
        {
            return NotComputable;
        }
        scale_a = scale_a.max(lhs.norm());
        scale_b = scale_b.max(rhs.norm());
    }
    if !(scale_a.is_finite() && scale_a > 0.0 && scale_b.is_finite() && scale_b > 0.0) {
        return NotComputable;
    }

    let mut numerator = Complex64::new(0.0, 0.0);
    let mut norm_a = 0.0_f64;
    let mut norm_b = 0.0_f64;
    for node in 0..weights_a.len() {
        let weight_a = weights_a[node];
        let weight_b = weights_b[node];
        if !(weight_a.is_finite() && weight_b.is_finite()) {
            return NotComputable;
        }
        if weight_a == 0.0 && weight_b == 0.0 {
            // Explicit inactive/padding sentinel on both sides: this node
            // contributes nothing to the overlap.
            continue;
        }
        if !(weight_a > 0.0 && weight_b > 0.0) {
            return NotComputable;
        }
        // A mode pair is comparable only when both artifacts describe the
        // same FE metric.  Do not silently average or otherwise alter a
        // mismatched mass diagonal.
        if (weight_a - weight_b).abs() > 1.0e-12 * weight_a.max(weight_b) {
            return NotComputable;
        }
        let weight = 0.5 * (weight_a + weight_b);
        let start = node * TRACKING_VECTOR_COMPONENTS_PER_NODE;
        for component in 0..TRACKING_VECTOR_COMPONENTS_PER_NODE {
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
        return NotComputable;
    }

    let overlap = numerator.norm() / denominator;
    if overlap.is_finite() {
        Computed(overlap.clamp(0.0, 1.0))
    } else {
        NotComputable
    }
}

fn complex_overlap(a: &[Complex64], b: &[Complex64]) -> f64 {
    normalized_complex_overlap(a, b).unwrap_or(0.0)
}

fn finite_frequency_score_values(
    previous_frequency_hz: f64,
    current_frequency_hz: f64,
    window_hz: Option<f64>,
) -> Option<f64> {
    if !previous_frequency_hz.is_finite() || !current_frequency_hz.is_finite() {
        return None;
    }
    let delta = (previous_frequency_hz - current_frequency_hz).abs();
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
            let scale_hz = previous_frequency_hz
                .abs()
                .max(current_frequency_hz.abs())
                .max(1.0);
            1.0 / (1.0 + delta / scale_hz)
        }
    };
    score.is_finite().then(|| score.clamp(0.0, 1.0))
}

fn modal_overlap_views(
    prev: TrackingModeView<'_>,
    current: TrackingModeView<'_>,
) -> Option<f64> {
    match (prev.reduced_vector, current.reduced_vector) {
        (Some(a), Some(b)) => match (prev.node_mass_weights, current.node_mass_weights) {
            (Some(weights_a), Some(weights_b)) => match mass_weighted_overlap_outcome(
                a,
                b,
                weights_a,
                weights_b,
            ) {
                MassWeightedOverlapOutcome::Computed(value) => Some(value),
                MassWeightedOverlapOutcome::LengthMismatch
                | MassWeightedOverlapOutcome::NotComputable => None,
            },
            (None, None) => normalized_complex_overlap(a, b),
            // A mass metric present on only one side cannot be compared
            // physically. Do not hide the asymmetric artifact contract by
            // silently switching this edge to an unweighted overlap.
            (Some(_), None) | (None, Some(_)) => None,
        },
        _ => None,
    }
}

fn modal_overlap(prev: &SingleKModeResult, current: &SingleKModeResult) -> Option<f64> {
    modal_overlap_views(mode_view(prev), mode_view(current))
}

fn tracking_uses_frequency_fallback_views(
    prev: TrackingModeView<'_>,
    current: TrackingModeView<'_>,
) -> bool {
    prev.reduced_vector.is_none() || current.reduced_vector.is_none()
}

fn tracking_edge_metrics_views(
    prev: TrackingModeView<'_>,
    current: TrackingModeView<'_>,
    cfg: &ModeTrackingIR,
) -> Option<(f64, Option<f64>)> {
    let frequency = finite_frequency_score_values(
        prev.frequency_real_hz,
        current.frequency_real_hz,
        cfg.frequency_window_hz,
    )?;
    let overlap = modal_overlap_views(prev, current);
    let score = match overlap {
        Some(overlap) => 0.85 * overlap + 0.15 * frequency,
        None if tracking_uses_frequency_fallback_views(prev, current) => frequency,
        None => return None,
    };
    score.is_finite().then(|| (score.clamp(0.0, 1.0), overlap))
}

fn tracking_edge_metrics(
    prev: &SingleKModeResult,
    current: &SingleKModeResult,
    cfg: &ModeTrackingIR,
) -> Option<(f64, Option<f64>)> {
    tracking_edge_metrics_views(mode_view(prev), mode_view(current), cfg)
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

fn edge_passes_floor_views(
    prev: TrackingModeView<'_>,
    current: TrackingModeView<'_>,
    score: f64,
    overlap: Option<f64>,
    overlap_floor: f64,
) -> bool {
    match overlap {
        Some(overlap) => overlap >= overlap_floor,
        // Preserve the legacy frequency-only threshold explicitly. This is a
        // frequency score policy and must remain provenance-tagged as a
        // fallback; it is not evidence that a modal overlap floor was met.
        None if tracking_uses_frequency_fallback_views(prev, current) => score >= overlap_floor,
        None => false,
    }
}

/// Return frequency clusters using a fixed anchor for every cluster.  The
/// anchor prevents a chain of merely neighbouring bands from being promoted
/// to one degenerate subspace through transitive adjacency.
fn frequency_clusters(entries: &[(usize, f64, f64)]) -> Vec<Vec<usize>> {
    let mut order = (0..entries.len()).collect::<Vec<_>>();
    order.sort_by(|&lhs, &rhs| {
        entries[lhs]
            .1
            .total_cmp(&entries[rhs].1)
            .then_with(|| entries[lhs].2.total_cmp(&entries[rhs].2))
            .then_with(|| entries[lhs].0.cmp(&entries[rhs].0))
    });

    let mut clusters = Vec::<Vec<usize>>::new();
    for entry_index in order {
        let Some(last_cluster) = clusters.last_mut() else {
            clusters.push(vec![entry_index]);
            continue;
        };
        let anchor = last_cluster[0];
        if frequencies_are_degenerate(
            entries[anchor].1,
            entries[anchor].2,
            entries[entry_index].1,
            entries[entry_index].2,
        ) {
            last_cluster.push(entry_index);
        } else {
            clusters.push(vec![entry_index]);
        }
    }
    clusters
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
    let mut edges_by_slot = vec![vec![None; mode_count]; compact_branch_count];
    for edge in edges {
        if edge.branch_id >= branch_count || edge.mode_slot >= mode_count || !edge.score.is_finite()
        {
            continue;
        }
        let Ok(compact_branch_id) = compact_branch_ids.binary_search(&edge.branch_id) else {
            continue;
        };
        let replace = edges_by_slot[compact_branch_id][edge.mode_slot]
            .map_or(true, |existing: TrackingEdge| edge.score > existing.score);
        if replace {
            edges_by_slot[compact_branch_id][edge.mode_slot] = Some(*edge);
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
            cost[compact_branch_id][mode_slot] = edges_by_slot[compact_branch_id][mode_slot]
                .map(|edge| unmatched_cost - edge.score)
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
            edges_by_slot[compact_branch_id][mode_slot].map(|mut edge| {
                edge.branch_id = compact_branch_ids[compact_branch_id];
                edge
            })
        })
        .collect()
}

#[derive(Debug, Clone)]
struct SubspaceClusterCandidate {
    previous_cluster: usize,
    current_cluster: usize,
    branch_ids: Vec<usize>,
    mode_slots: Vec<usize>,
    transport: SubspaceTransport,
}

fn cluster_frequency_center(
    entries: &[(usize, f64, f64)],
    cluster: &[usize],
) -> Option<(f64, f64)> {
    if cluster.is_empty() {
        return None;
    }
    let mut real = 0.0;
    let mut imag = 0.0;
    for &entry_index in cluster {
        let (_, entry_real, entry_imag) = entries.get(entry_index)?;
        real += *entry_real;
        imag += *entry_imag;
    }
    let count = cluster.len() as f64;
    let real = real / count;
    let imag = imag / count;
    (real.is_finite() && imag.is_finite()).then_some((real, imag))
}

/// Select a candidate group of split modes adjacent to a degenerate cluster.
///
/// A mode solver may return a split pair immediately before or after an exact
/// crossing.  Such singleton entries cannot be certified one at a time after
/// the other side has rotated its degenerate basis, so a transition candidate
/// groups the nearest singleton frequencies around the degenerate cluster
/// center.  The group is only a candidate: the mass-weighted principal-angle
/// test below remains the continuity certificate.  A tie at the group
/// boundary is ambiguous and rejects the candidate instead of inventing a
/// deterministic physical label.
fn nearest_singleton_group(
    entries: &[(usize, f64, f64)],
    clusters: &[Vec<usize>],
    center: (f64, f64),
    rank: usize,
    frequency_window_hz: Option<f64>,
) -> Option<Vec<usize>> {
    if rank < 2 {
        return None;
    }
    let mut singleton_entries = clusters
        .iter()
        .filter(|cluster| cluster.len() == 1)
        .filter_map(|cluster| cluster.first().copied())
        .filter_map(|entry_index| {
            let (_, real, imag) = *entries.get(entry_index)?;
            let distance = complex_frequency_distance(center.0, center.1, real, imag)?;
            let score = finite_frequency_score_values(
                center.0,
                real,
                frequency_window_hz,
            )?;
            (score > 0.0).then_some((distance, entry_index))
        })
        .collect::<Vec<_>>();
    singleton_entries.sort_by(|lhs, rhs| {
        lhs.0
            .total_cmp(&rhs.0)
            .then_with(|| entries[lhs.1].0.cmp(&entries[rhs.1].0))
    });
    if singleton_entries.len() < rank {
        return None;
    }
    let boundary_distance = singleton_entries[rank - 1].0;
    if singleton_entries
        .get(rank)
        .map(|(distance, _)| {
            (*distance - boundary_distance).abs()
                <= 1.0e-12 * distance.abs().max(boundary_distance.abs()).max(1.0)
        })
        .unwrap_or(false)
    {
        return None;
    }
    Some(
        singleton_entries
            .into_iter()
            .take(rank)
            .map(|(_, entry_index)| entry_index)
            .collect(),
    )
}

fn assign_subspace_clusters(
    previous_cluster_count: usize,
    current_cluster_count: usize,
    candidates: &[SubspaceClusterCandidate],
) -> Vec<usize> {
    if previous_cluster_count == 0 || current_cluster_count == 0 || candidates.is_empty() {
        return Vec::new();
    }
    let dimension = previous_cluster_count + current_cluster_count;
    let unmatched_cost = 1.0;
    let mut cost = vec![vec![unmatched_cost; dimension]; dimension];
    let mut candidate_by_pair: Vec<Vec<Option<usize>>> =
        vec![vec![None; current_cluster_count]; previous_cluster_count];
    for (candidate_index, candidate) in candidates.iter().enumerate() {
        if candidate.previous_cluster >= previous_cluster_count
            || candidate.current_cluster >= current_cluster_count
            || !candidate.transport.score.is_finite()
        {
            continue;
        }
        let slot = &mut candidate_by_pair[candidate.previous_cluster][candidate.current_cluster];
        let replace = match *slot {
            Some(existing) => candidate.transport.score > candidates[existing].transport.score,
            None => true,
        };
        if replace {
            *slot = Some(candidate_index);
            cost[candidate.previous_cluster][candidate.current_cluster] =
                unmatched_cost - candidate.transport.score;
        }
    }

    hungarian_min_cost(&cost)
        .into_iter()
        .enumerate()
        .take(previous_cluster_count)
        .filter_map(|(previous_cluster, assigned_column)| {
            let current_cluster = assigned_column?;
            if current_cluster >= current_cluster_count {
                return None;
            }
            candidate_by_pair[previous_cluster][current_cluster]
        })
        .collect()
}

fn candidate_groups_are_disjoint(
    lhs: &SubspaceClusterCandidate,
    rhs: &SubspaceClusterCandidate,
) -> bool {
    !lhs
        .branch_ids
        .iter()
        .any(|branch_id| rhs.branch_ids.contains(branch_id))
        && !lhs
            .mode_slots
            .iter()
            .any(|mode_slot| rhs.mode_slots.contains(mode_slot))
}

/// Find equal-dimensional, frequency-degenerate clusters that can be
/// compared in a common FE mass metric.  Clusters that lack a valid vector or
/// mass diagonal are deliberately left to the ordinary compatibility path;
/// they never receive a frequency-only subspace certificate.
fn find_subspace_matches(
    result: &PathSolveResult,
    branches: &[TrackedBranch],
    frames: &[BranchTrackingFrame],
    sample_position: usize,
    max_branch_gap: usize,
    cfg: &ModeTrackingIR,
) -> Vec<SubspaceClusterCandidate> {
    let mut previous_entries = Vec::<(usize, f64, f64)>::new();
    let mut previous_sample_index = None;
    for branch in branches {
        if !branch_is_eligible(result.samples.as_slice(), branch, sample_position, max_branch_gap) {
            continue;
        }
        let Some(last_point) = branch.points.last() else {
            continue;
        };
        if !last_point.frequency_real_hz.is_finite()
            || !last_point.frequency_imag_hz.is_finite()
        {
            continue;
        }
        match previous_sample_index {
            None => previous_sample_index = Some(last_point.sample_index),
            Some(expected) if expected != last_point.sample_index => {
                // A subspace is defined on one physical sample/basis.  Do
                // not mix frames retained across different gap lengths;
                // ordinary per-branch matching below remains available.
                return Vec::new();
            }
            Some(_) => {}
        }
        // Keep branches with missing vectors in the frequency cluster.  A
        // mixed cluster is then rejected by the mass-weighted transport and
        // falls back explicitly to the existing per-mode policy.
        previous_entries.push((
            branch.branch_id,
            last_point.frequency_real_hz,
            last_point.frequency_imag_hz,
        ));
    }
    let current_modes = result.samples[sample_position].modes.as_slice();
    let current_entries = current_modes
        .iter()
        .enumerate()
        .filter(|(_, mode)| {
            mode.frequency_real_hz.is_finite() && mode.frequency_imag_hz.is_finite()
        })
        .map(|(mode_slot, mode)| {
            (
                mode_slot,
                mode.frequency_real_hz,
                mode.frequency_imag_hz,
            )
        })
        .collect::<Vec<_>>();
    let previous_clusters = frequency_clusters(&previous_entries);
    let current_clusters = frequency_clusters(&current_entries);
    let mut candidates = Vec::<SubspaceClusterCandidate>::new();

    for (previous_cluster_index, previous_cluster) in previous_clusters.iter().enumerate() {
        if previous_cluster.len() < 2 {
            continue;
        }
        let Some((previous_center_real, _)) =
            cluster_frequency_center(&previous_entries, previous_cluster)
        else {
            continue;
        };
        for (current_cluster_index, current_cluster) in current_clusters.iter().enumerate() {
            if current_cluster.len() != previous_cluster.len() || current_cluster.len() < 2 {
                continue;
            }
            let Some((current_center_real, _)) =
                cluster_frequency_center(&current_entries, current_cluster)
            else {
                continue;
            };
            let Some(frequency_score) = finite_frequency_score_values(
                previous_center_real,
                current_center_real,
                cfg.frequency_window_hz,
            ) else {
                continue;
            };

            let mut previous_views = Vec::with_capacity(previous_cluster.len());
            let mut branch_ids = Vec::with_capacity(previous_cluster.len());
            for &entry_index in previous_cluster {
                let (branch_id, frequency_real_hz, _frequency_imag_hz) =
                    previous_entries[entry_index];
                let Some(frame) = frames.get(branch_id) else {
                    previous_views.clear();
                    break;
                };
                branch_ids.push(branch_id);
                previous_views.push(frame.view(frequency_real_hz));
            }
            if previous_views.len() != previous_cluster.len() {
                continue;
            }

            let mut mode_slots = Vec::with_capacity(current_cluster.len());
            let mut current_views = Vec::with_capacity(current_cluster.len());
            for &entry_index in current_cluster {
                let (mode_slot, _, _) = current_entries[entry_index];
                let Some(mode) = current_modes.get(mode_slot) else {
                    current_views.clear();
                    break;
                };
                mode_slots.push(mode_slot);
                current_views.push(mode_view(mode));
            }
            if current_views.len() != current_cluster.len() {
                continue;
            }
            let Some(transport) = mass_weighted_subspace_transport(
                &previous_views,
                &current_views,
                frequency_score,
            ) else {
                continue;
            };
            // The configured overlap floor is a principal-angle floor for a
            // cluster.  The blended score below also contains a frequency
            // term, but must not rescue a geometrically poor subspace.
            if transport.principal_minimum < cfg.overlap_floor {
                continue;
            }
            candidates.push(SubspaceClusterCandidate {
                previous_cluster: previous_cluster_index,
                current_cluster: current_cluster_index,
                branch_ids,
                mode_slots,
                transport,
            });
        }
    }

    // Also cover the split -> degenerate and degenerate -> split boundary.
    // The source side is deliberately restricted to singleton frequency
    // clusters.  This keeps rank changes explicit and avoids silently
    // collapsing two already-degenerate groups into one guessed rank.
    for (current_cluster_index, current_cluster) in current_clusters.iter().enumerate() {
        if current_cluster.len() < 2 {
            continue;
        }
        let Some(current_center) = cluster_frequency_center(&current_entries, current_cluster)
        else {
            continue;
        };
        let Some(previous_group) = nearest_singleton_group(
            &previous_entries,
            &previous_clusters,
            current_center,
            current_cluster.len(),
            cfg.frequency_window_hz,
        ) else {
            continue;
        };
        let Some(previous_center) = cluster_frequency_center(&previous_entries, &previous_group)
        else {
            continue;
        };
        let Some(frequency_score) = finite_frequency_score_values(
            previous_center.0,
            current_center.0,
            cfg.frequency_window_hz,
        ) else {
            continue;
        };
        let mut previous_views = Vec::with_capacity(previous_group.len());
        let mut branch_ids = Vec::with_capacity(previous_group.len());
        for &entry_index in &previous_group {
            let (branch_id, frequency_real_hz, _) = previous_entries[entry_index];
            let Some(frame) = frames.get(branch_id) else {
                previous_views.clear();
                break;
            };
            branch_ids.push(branch_id);
            previous_views.push(frame.view(frequency_real_hz));
        }
        if previous_views.len() != previous_group.len() {
            continue;
        }
        let mut mode_slots = Vec::with_capacity(current_cluster.len());
        let mut current_views = Vec::with_capacity(current_cluster.len());
        for &entry_index in current_cluster {
            let (mode_slot, _, _) = current_entries[entry_index];
            let Some(mode) = current_modes.get(mode_slot) else {
                current_views.clear();
                break;
            };
            mode_slots.push(mode_slot);
            current_views.push(mode_view(mode));
        }
        if current_views.len() != current_cluster.len() {
            continue;
        }
        let Some(transport) = mass_weighted_subspace_transport(
            &previous_views,
            &current_views,
            frequency_score,
        ) else {
            continue;
        };
        if transport.principal_minimum < cfg.overlap_floor {
            continue;
        }
        // The first source singleton is an assignment anchor.  All source
        // branch IDs are retained in the candidate, and the disjointness
        // filter below prevents another transition from reusing them.
        let Some(&previous_anchor) = previous_group.first() else {
            continue;
        };
        let Some(previous_cluster) = previous_clusters
            .iter()
            .position(|cluster| cluster.as_slice() == [previous_anchor])
        else {
            continue;
        };
        candidates.push(SubspaceClusterCandidate {
            previous_cluster,
            current_cluster: current_cluster_index,
            branch_ids,
            mode_slots,
            transport,
        });
    }

    for (previous_cluster_index, previous_cluster) in previous_clusters.iter().enumerate() {
        if previous_cluster.len() < 2 {
            continue;
        }
        let Some(previous_center) = cluster_frequency_center(&previous_entries, previous_cluster)
        else {
            continue;
        };
        let Some(current_group) = nearest_singleton_group(
            &current_entries,
            &current_clusters,
            previous_center,
            previous_cluster.len(),
            cfg.frequency_window_hz,
        ) else {
            continue;
        };
        let Some(current_center) = cluster_frequency_center(&current_entries, &current_group)
        else {
            continue;
        };
        let Some(frequency_score) = finite_frequency_score_values(
            previous_center.0,
            current_center.0,
            cfg.frequency_window_hz,
        ) else {
            continue;
        };
        let mut previous_views = Vec::with_capacity(previous_cluster.len());
        let mut branch_ids = Vec::with_capacity(previous_cluster.len());
        for &entry_index in previous_cluster {
            let (branch_id, frequency_real_hz, _) = previous_entries[entry_index];
            let Some(frame) = frames.get(branch_id) else {
                previous_views.clear();
                break;
            };
            branch_ids.push(branch_id);
            previous_views.push(frame.view(frequency_real_hz));
        }
        if previous_views.len() != previous_cluster.len() {
            continue;
        }
        let mut mode_slots = Vec::with_capacity(current_group.len());
        let mut current_views = Vec::with_capacity(current_group.len());
        for &entry_index in &current_group {
            let (mode_slot, _, _) = current_entries[entry_index];
            let Some(mode) = current_modes.get(mode_slot) else {
                current_views.clear();
                break;
            };
            mode_slots.push(mode_slot);
            current_views.push(mode_view(mode));
        }
        if current_views.len() != current_group.len() {
            continue;
        }
        let Some(transport) = mass_weighted_subspace_transport(
            &previous_views,
            &current_views,
            frequency_score,
        ) else {
            continue;
        };
        if transport.principal_minimum < cfg.overlap_floor {
            continue;
        }
        let Some(&current_anchor) = current_group.first() else {
            continue;
        };
        let Some(current_cluster) = current_clusters
            .iter()
            .position(|cluster| cluster.as_slice() == [current_anchor])
        else {
            continue;
        };
        candidates.push(SubspaceClusterCandidate {
            previous_cluster: previous_cluster_index,
            current_cluster,
            branch_ids,
            mode_slots,
            transport,
        });
    }

    let selected = assign_subspace_clusters(
        previous_clusters.len(),
        current_clusters.len(),
        &candidates,
    );
    let mut selected_candidates = Vec::new();
    for candidate_index in selected {
        let Some(candidate) = candidates.get(candidate_index).cloned() else {
            continue;
        };
        if selected_candidates
            .iter()
            .all(|selected| candidate_groups_are_disjoint(&candidate, selected))
        {
            selected_candidates.push(candidate);
        }
    }
    selected_candidates
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
    // Keep a private transported frame for each live branch.  Raw solver
    // vectors are allowed to rotate or change phase inside a degenerate
    // eigenspace; carrying the Procrustes frame makes the next edge compare
    // against the continuous physical subspace rather than that arbitrary
    // raw basis.
    let mut tracking_frames = result.samples[0]
        .modes
        .iter()
        .map(BranchTrackingFrame::from_mode)
        .collect::<Vec<_>>();
    let mut used_frequency_fallback = false;
    let mut used_subspace_transport = false;

    for sample_position in 1..result.samples.len() {
        let current_sample_id = result.samples[sample_position].sample.sample_index;
        let current_mode_count = result.samples[sample_position].modes.len();
        let mut edges = Vec::new();

        let subspace_matches = find_subspace_matches(
            result,
            &branches,
            &tracking_frames,
            sample_position,
            cfg.max_branch_gap as usize,
            cfg,
        );
        let mut subspace_branches = BTreeSet::new();
        let mut subspace_modes = BTreeSet::new();
        for cluster in &subspace_matches {
            used_subspace_transport = true;
            for (previous_index, current_index) in &cluster.transport.assignments {
                let Some(&branch_id) = cluster.branch_ids.get(*previous_index) else {
                    continue;
                };
                let Some(&mode_slot) = cluster.mode_slots.get(*current_index) else {
                    continue;
                };
                subspace_branches.insert(branch_id);
                subspace_modes.insert(mode_slot);
                edges.push(TrackingEdge {
                    branch_id,
                    mode_slot,
                    score: cluster.transport.score,
                    subspace_transport: true,
                });
            }
        }

        for branch in &branches {
            if subspace_branches.contains(&branch.branch_id) {
                continue;
            }
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
            let Some(previous_frame) = tracking_frames.get(branch.branch_id) else {
                continue;
            };
            let previous_view = previous_frame.view(last_point.frequency_real_hz);
            for (mode_slot, current) in result.samples[sample_position].modes.iter().enumerate() {
                if subspace_modes.contains(&mode_slot) {
                    continue;
                }
                let current_view = mode_view(current);
                let Some((score, overlap)) =
                    tracking_edge_metrics_views(previous_view, current_view, cfg)
                else {
                    continue;
                };
                if edge_passes_floor_views(
                    previous_view,
                    current_view,
                    score,
                    overlap,
                    cfg.overlap_floor,
                ) {
                    edges.push(TrackingEdge {
                        branch_id: branch.branch_id,
                        mode_slot,
                        score,
                        subspace_transport: false,
                    });
                }
            }
        }

        let matches = assign_edges(cfg.method, branches.len(), current_mode_count, &edges);

        let mut used_modes = BTreeSet::new();
        for edge in matches {
            let Some(branch) = branches
                .iter()
                .find(|branch| branch.branch_id == edge.branch_id)
            else {
                continue;
            };
            let Some(last_point) = branch.points.last() else {
                continue;
            };
            let Some(current_mode) = result.samples[sample_position].modes.get(edge.mode_slot)
            else {
                continue;
            };
            let (next_frame, edge_used_frequency_fallback, overlap_prev) =
                if edge.subspace_transport {
                    let frame = subspace_matches.iter().find_map(|cluster| {
                        cluster
                            .transport
                            .assignments
                            .iter()
                            .find_map(|(previous_index, current_index)| {
                                let branch_id = cluster.branch_ids.get(*previous_index).copied()?;
                                let mode_slot = cluster.mode_slots.get(*current_index).copied()?;
                                if branch_id != edge.branch_id || mode_slot != edge.mode_slot {
                                    return None;
                                }
                                cluster
                                    .transport
                                    .transported_frames
                                    .get(*previous_index)
                                    .cloned()
                                    .map(|vector| BranchTrackingFrame {
                                        reduced_vector: Some(vector),
                                        node_mass_weights: current_mode.node_mass_weights.clone(),
                                    })
                            })
                    });
                    (frame, false, None)
                } else {
                    let Some(previous_frame) = tracking_frames.get(edge.branch_id) else {
                        continue;
                    };
                    let previous_view = previous_frame.view(last_point.frequency_real_hz);
                    let current_view = mode_view(current_mode);
                    (
                        Some(BranchTrackingFrame::from_mode(current_mode)),
                        tracking_uses_frequency_fallback_views(previous_view, current_view),
                        modal_overlap_views(previous_view, current_view),
                    )
                };
            if next_frame.is_none() && edge.subspace_transport {
                continue;
            }
            used_frequency_fallback |= edge_used_frequency_fallback;
            let raw_mode_index = current_mode.raw_mode_index;
            let frequency_real_hz = current_mode.frequency_real_hz;
            let frequency_imag_hz = current_mode.frequency_imag_hz;
            used_modes.insert(edge.mode_slot);
            if let Some(frame) = next_frame {
                if let Some(tracking_frame) = tracking_frames.get_mut(edge.branch_id) {
                    *tracking_frame = frame;
                }
            }
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
            let next_frame = result.samples[sample_position]
                .modes
                .get(mode_slot)
                .map(BranchTrackingFrame::from_mode);
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
            tracking_frames.push(next_frame.unwrap_or_default());
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
    if used_subspace_transport
        && !result
            .notes
            .iter()
            .any(|note| note == DEGENERATE_SUBSPACE_TRACKING_NOTE)
    {
        result
            .notes
            .push(DEGENERATE_SUBSPACE_TRACKING_NOTE.to_string());
    }
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

    fn mode<const N: usize>(
        raw_mode_index: usize,
        frequency_real_hz: f64,
        vector: [Complex64; N],
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
            solver_policy: None,
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
            solver_policy: None,
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
                subspace_transport: false,
            },
            TrackingEdge {
                branch_id: 0,
                mode_slot: 1,
                score: 0.80,
                subspace_transport: false,
            },
            TrackingEdge {
                branch_id: 1,
                mode_slot: 0,
                score: 0.85,
                subspace_transport: false,
            },
            TrackingEdge {
                branch_id: 1,
                mode_slot: 1,
                score: 0.10,
                subspace_transport: false,
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
                subspace_transport: false,
            },
            TrackingEdge {
                branch_id: 1_000_000,
                mode_slot: 1,
                score: 0.80,
                subspace_transport: false,
            },
            TrackingEdge {
                branch_id: 1_000_001,
                mode_slot: 0,
                score: 0.85,
                subspace_transport: false,
            },
            TrackingEdge {
                branch_id: 1_000_001,
                mode_slot: 1,
                score: 0.10,
                subspace_transport: false,
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
            solver_policy: None,
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
            solver_policy: None,
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
    fn modal_overlap_rejects_unaligned_mass_metadata_without_euclidean_fallback() {
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

        assert_eq!(
            mass_weighted_overlap_outcome(
                previous.reduced_vector.as_ref().unwrap(),
                current.reduced_vector.as_ref().unwrap(),
                previous.node_mass_weights.as_ref().unwrap(),
                current.node_mass_weights.as_ref().unwrap(),
            ),
            MassWeightedOverlapOutcome::LengthMismatch
        );
        assert!(modal_overlap(&previous, &current).is_none());
        let cfg = ModeTrackingIR {
            method: ModeTrackingMethodIR::OverlapHungarian,
            frequency_window_hz: None,
            overlap_floor: 0.5,
            max_branch_gap: 0,
        };
        assert!(tracking_edge_score(&previous, &current, &cfg).is_none());
    }

    #[test]
    fn modal_overlap_rejects_asymmetric_mass_metadata() {
        let mut previous = mode(0, 1.0, [Complex64::new(1.0, 0.0), Complex64::new(0.0, 0.0)]);
        let mut current = previous.clone();
        previous.reduced_vector = Some(vec![
            Complex64::new(1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ]);
        current.reduced_vector = previous.reduced_vector.clone();
        previous.node_mass_weights = Some(vec![1.0, 1.0]);

        assert!(modal_overlap(&previous, &current).is_none());
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
            solver_policy: None,
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
            solver_policy: None,
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
            solver_policy: None,
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
            solver_policy: None,
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

    #[test]
    fn rotated_degenerate_modes_use_mass_weighted_principal_angle_transport() {
        let inverse_sqrt_two = 2.0_f64.sqrt().recip();
        // The first active node carries twice the FE mass of the second.  The
        // vectors use the native three Cartesian entries per node so the
        // fixture obeys the same reduced-vector contract as FEM artifacts.
        let first = [
            Complex64::new(inverse_sqrt_two, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ];
        let second = [
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ];
        let rotated_first = [
            first[0] * inverse_sqrt_two,
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            second[3] * inverse_sqrt_two,
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ];
        let rotated_second = [
            -first[0] * inverse_sqrt_two,
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            second[3] * inverse_sqrt_two,
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ];
        let mut previous_first = mode(0, 1.0e9, first);
        let mut previous_second = mode(1, 1.0e9, second);
        let mut current_first = mode(0, 1.0e9, rotated_first);
        let mut current_second = mode(1, 1.0e9, rotated_second);
        let weights = vec![2.0, 1.0];
        previous_first.node_mass_weights = Some(weights.clone());
        previous_second.node_mass_weights = Some(weights.clone());
        current_first.node_mass_weights = Some(weights.clone());
        current_second.node_mass_weights = Some(weights);

        assert!(modal_overlap(&previous_first, &current_first).unwrap() < 0.8);
        let previous_views = [mode_view(&previous_first), mode_view(&previous_second)];
        let current_views = [mode_view(&current_first), mode_view(&current_second)];
        let transport = mass_weighted_subspace_transport(&previous_views, &current_views, 1.0)
            .expect("rotated bases should have a common mass-weighted subspace");
        assert!(transport
            .principal_cosines
            .iter()
            .all(|cosine| (*cosine - 1.0).abs() < 1.0e-12));

        let mut result = PathSolveResult {
            samples: vec![
                sample(0, vec![previous_first, previous_second]),
                // The raw order is intentionally reversed as well as
                // rotated.  Procrustes transport determines the assignment
                // from the full subspace, not from one pairwise overlap.
                sample(1, vec![current_second, current_first]),
            ],
            branches: Vec::new(),
            solver_model: EigenSolverModel::ReferenceScalarTangent,
            notes: Vec::new(),
            include_demag: false,
            dispersion_validation: None,
            k0_kittel_validation: None,
            solver_policy: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };
        let cfg = ModeTrackingIR {
            method: ModeTrackingMethodIR::OverlapHungarian,
            frequency_window_hz: None,
            overlap_floor: 0.9,
            max_branch_gap: 0,
        };

        track_branches(&mut result, Some(&cfg));

        assert_eq!(result.branches.len(), 2);
        assert!(result
            .branches
            .iter()
            .all(|branch| branch.points.len() == 2));
        assert!(result
            .branches
            .iter()
            .all(|branch| branch.points[1].overlap_prev.is_none()));
        assert!(result
            .branches
            .iter()
            .all(|branch| branch.points[1].tracking_confidence > 0.99));
        assert!(result
            .notes
            .iter()
            .any(|note| note == DEGENERATE_SUBSPACE_TRACKING_NOTE));
    }

    #[test]
    fn unequal_rank_subspaces_are_rejected_without_a_false_continuity_claim() {
        let mut first = mode(
            0,
            1.0e9,
            [
                Complex64::new(1.0, 0.0),
                Complex64::new(0.0, 0.0),
                Complex64::new(0.0, 0.0),
                Complex64::new(0.0, 0.0),
                Complex64::new(0.0, 0.0),
                Complex64::new(0.0, 0.0),
            ],
        );
        let mut second = mode(
            1,
            1.0e9,
            [
                Complex64::new(0.0, 0.0),
                Complex64::new(0.0, 0.0),
                Complex64::new(0.0, 0.0),
                Complex64::new(1.0, 0.0),
                Complex64::new(0.0, 0.0),
                Complex64::new(0.0, 0.0),
            ],
        );
        let mut current = mode(
            0,
            1.0e9,
            [
                Complex64::new(1.0, 0.0),
                Complex64::new(0.0, 0.0),
                Complex64::new(0.0, 0.0),
                Complex64::new(0.0, 0.0),
                Complex64::new(0.0, 0.0),
                Complex64::new(0.0, 0.0),
            ],
        );
        let weights = Some(vec![1.0, 1.0]);
        first.node_mass_weights = weights.clone();
        second.node_mass_weights = weights.clone();
        current.node_mass_weights = weights;

        let previous = [mode_view(&first), mode_view(&second)];
        let current = [mode_view(&current)];
        assert!(mass_weighted_subspace_transport(&previous, &current, 1.0).is_none());
    }

    #[test]
    fn transported_degenerate_frame_survives_a_split_crossing() {
        let inverse_sqrt_two = 2.0_f64.sqrt().recip();
        let first = [
            Complex64::new(inverse_sqrt_two, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ];
        let second = [
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ];
        let rotated_first = [
            first[0] * inverse_sqrt_two,
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            second[3] * inverse_sqrt_two,
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ];
        let rotated_second = [
            -first[0] * inverse_sqrt_two,
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            second[3] * inverse_sqrt_two,
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ];
        let weights = vec![2.0, 1.0];
        let mut previous_first = mode(0, 0.9e9, first);
        let mut previous_second = mode(1, 1.1e9, second);
        let mut current_first = mode(0, 1.0e9, rotated_first);
        let mut current_second = mode(1, 1.0e9, rotated_second);
        let mut split_first = mode(1, 1.1e9, first);
        let mut split_second = mode(0, 1.3e9, second);
        previous_first.node_mass_weights = Some(weights.clone());
        previous_second.node_mass_weights = Some(weights.clone());
        current_first.node_mass_weights = Some(weights.clone());
        current_second.node_mass_weights = Some(weights.clone());
        split_first.node_mass_weights = Some(weights.clone());
        split_second.node_mass_weights = Some(weights);

        let mut result = PathSolveResult {
            samples: vec![
                sample(0, vec![previous_first, previous_second]),
                // This is an exact crossing: the eigensolver is free to
                // rotate and reorder the degenerate pair.
                sample(1, vec![current_second, current_first]),
                // Once the pair splits, the transported frame must seed the
                // ordinary one-vector matcher instead of restarting branches.
                sample(2, vec![split_second, split_first]),
            ],
            branches: Vec::new(),
            solver_model: EigenSolverModel::ReferenceScalarTangent,
            notes: Vec::new(),
            include_demag: false,
            dispersion_validation: None,
            k0_kittel_validation: None,
            solver_policy: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };
        let cfg = ModeTrackingIR {
            method: ModeTrackingMethodIR::OverlapHungarian,
            frequency_window_hz: None,
            overlap_floor: 0.9,
            max_branch_gap: 0,
        };

        track_branches(&mut result, Some(&cfg));

        assert_eq!(result.branches.len(), 2);
        assert!(result
            .branches
            .iter()
            .all(|branch| branch.points.len() == 3));
        let branch_for_first = result
            .branches
            .iter()
            .find(|branch| branch.points[0].raw_mode_index == 0)
            .expect("first seed branch should remain present");
        let branch_for_second = result
            .branches
            .iter()
            .find(|branch| branch.points[0].raw_mode_index == 1)
            .expect("second seed branch should remain present");
        assert_eq!(branch_for_first.points[2].raw_mode_index, 1);
        assert_eq!(branch_for_second.points[2].raw_mode_index, 0);
        assert!(branch_for_first.points[2].overlap_prev.is_none());
        assert!(branch_for_second.points[2].overlap_prev.is_none());
        assert!(branch_for_first.points[2].tracking_confidence > 0.9);
        assert!(branch_for_second.points[2].tracking_confidence > 0.9);
    }

    #[test]
    fn subspace_transport_rejects_branches_from_different_last_samples() {
        let inverse_sqrt_two = 2.0_f64.sqrt().recip();
        let first = [
            Complex64::new(inverse_sqrt_two, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ];
        let second = [
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ];
        let rotated_first = [
            first[0] * inverse_sqrt_two,
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            second[3] * inverse_sqrt_two,
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ];
        let rotated_second = [
            -first[0] * inverse_sqrt_two,
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            second[3] * inverse_sqrt_two,
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
        ];
        let weights = vec![2.0, 1.0];
        let mut first_at_zero = mode(0, 1.0e9, first);
        let mut second_at_zero = mode(1, 1.2e9, second);
        let mut first_at_one = mode(0, 1.05e9, first);
        let mut current_first = mode(0, 1.1e9, rotated_first);
        let mut current_second = mode(1, 1.1e9, rotated_second);
        first_at_zero.node_mass_weights = Some(weights.clone());
        second_at_zero.node_mass_weights = Some(weights.clone());
        first_at_one.node_mass_weights = Some(weights.clone());
        current_first.node_mass_weights = Some(weights.clone());
        current_second.node_mass_weights = Some(weights);

        let mut result = PathSolveResult {
            samples: vec![
                sample(0, vec![first_at_zero, second_at_zero]),
                // Only branch zero advances, leaving branch one at sample 0.
                sample(1, vec![first_at_one]),
                sample(2, vec![current_second, current_first]),
            ],
            branches: Vec::new(),
            solver_model: EigenSolverModel::ReferenceScalarTangent,
            notes: Vec::new(),
            include_demag: false,
            dispersion_validation: None,
            k0_kittel_validation: None,
            solver_policy: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };
        let cfg = ModeTrackingIR {
            method: ModeTrackingMethodIR::OverlapHungarian,
            frequency_window_hz: None,
            overlap_floor: 0.9,
            max_branch_gap: 1,
        };

        track_branches(&mut result, Some(&cfg));

        // The subspace matcher must not combine branch frames from sample 0
        // and sample 1 into a fictitious common basis after a gap.
        assert!(!result
            .notes
            .iter()
            .any(|note| note == DEGENERATE_SUBSPACE_TRACKING_NOTE));
        assert_eq!(result.branches.len(), 4);
        assert!(result.samples[2]
            .modes
            .iter()
            .all(|mode| mode.branch_id.unwrap_or_default() >= 2));
    }
}
