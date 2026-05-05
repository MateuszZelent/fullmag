use crate::eigen::types::{PathSolveResult, SingleKModeResult, TrackedBranch, TrackedBranchPoint};
use fullmag_ir::ModeTrackingIR;
use num_complex::Complex64;

fn complex_overlap(a: &[Complex64], b: &[Complex64]) -> f64 {
    if a.is_empty() || b.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let mut num = Complex64::new(0.0, 0.0);
    let mut aa = 0.0;
    let mut bb = 0.0;
    for (lhs, rhs) in a.iter().zip(b.iter()) {
        num += lhs.conj() * rhs;
        aa += lhs.norm_sqr();
        bb += rhs.norm_sqr();
    }
    if aa == 0.0 || bb == 0.0 {
        return 0.0;
    }
    num.norm() / (aa.sqrt() * bb.sqrt())
}

fn frequency_score(
    prev: &SingleKModeResult,
    current: &SingleKModeResult,
    window_hz: Option<f64>,
) -> f64 {
    let delta = (prev.frequency_real_hz - current.frequency_real_hz).abs();
    match window_hz {
        Some(window) if window > 0.0 => {
            if delta > window {
                0.0
            } else {
                1.0 - delta / window
            }
        }
        _ => 1.0 / (1.0 + delta),
    }
}

fn edge_score(prev: &SingleKModeResult, current: &SingleKModeResult, cfg: &ModeTrackingIR) -> f64 {
    let overlap = match (&prev.reduced_vector, &current.reduced_vector) {
        (Some(a), Some(b)) => complex_overlap(a, b),
        _ => 0.0,
    };
    if overlap > 0.0 {
        let f = frequency_score(prev, current, cfg.frequency_window_hz);
        0.85 * overlap + 0.15 * f
    } else {
        frequency_score(prev, current, cfg.frequency_window_hz)
    }
}

pub fn track_branches(result: &mut PathSolveResult, config: Option<&ModeTrackingIR>) {
    let default_cfg = ModeTrackingIR::default();
    let cfg = config.unwrap_or(&default_cfg);
    if result.samples.is_empty() {
        result.branches.clear();
        return;
    }

    let mut branches: Vec<TrackedBranch> = result.samples[0]
        .modes
        .iter_mut()
        .enumerate()
        .map(|(raw_mode_index, mode)| {
            mode.branch_id = Some(raw_mode_index);
            TrackedBranch {
                branch_id: raw_mode_index,
                label: Some(format!("B{raw_mode_index}")),
                points: vec![TrackedBranchPoint {
                    sample_index: 0,
                    raw_mode_index,
                    frequency_real_hz: mode.frequency_real_hz,
                    frequency_imag_hz: mode.frequency_imag_hz,
                    tracking_confidence: 1.0,
                    overlap_prev: None,
                }],
            }
        })
        .collect();

    for sample_index in 1..result.samples.len() {
        let prev_modes = result.samples[sample_index - 1].modes.clone();
        let current_modes = result.samples[sample_index].modes.clone();
        let mut edges: Vec<(usize, usize, f64)> = Vec::new();

        for branch in &branches {
            let Some(last_point) = branch.points.last() else {
                continue;
            };
            let prev_mode = &prev_modes[last_point.raw_mode_index];
            for current in &current_modes {
                let score = edge_score(prev_mode, current, cfg);
                if score >= cfg.overlap_floor {
                    edges.push((branch.branch_id, current.raw_mode_index, score));
                }
            }
        }

        // Transitional behaviour: `OverlapHungarian` currently falls back to a
        // deterministic greedy matcher. The method name is retained in the
        // contract so the algorithm can be upgraded later without another API
        // churn cycle.
        let _method = cfg.method;
        edges.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));

        let mut used_branches = std::collections::BTreeSet::new();
        let mut used_modes = std::collections::BTreeSet::new();
        for (branch_id, raw_mode_index, score) in edges {
            if used_branches.contains(&branch_id) || used_modes.contains(&raw_mode_index) {
                continue;
            }
            used_branches.insert(branch_id);
            used_modes.insert(raw_mode_index);
            if let Some(mode) = result.samples[sample_index]
                .modes
                .iter_mut()
                .find(|mode| mode.raw_mode_index == raw_mode_index)
            {
                mode.branch_id = Some(branch_id);
            }
            if let Some(branch) = branches
                .iter_mut()
                .find(|branch| branch.branch_id == branch_id)
            {
                branch.points.push(TrackedBranchPoint {
                    sample_index,
                    raw_mode_index,
                    frequency_real_hz: result.samples[sample_index].modes[raw_mode_index]
                        .frequency_real_hz,
                    frequency_imag_hz: result.samples[sample_index].modes[raw_mode_index]
                        .frequency_imag_hz,
                    tracking_confidence: score,
                    overlap_prev: Some(score),
                });
            }
        }

        for mode in result.samples[sample_index].modes.iter_mut() {
            if used_modes.contains(&mode.raw_mode_index) {
                continue;
            }
            let next_branch_id = branches.len();
            mode.branch_id = Some(next_branch_id);
            branches.push(TrackedBranch {
                branch_id: next_branch_id,
                label: Some(format!("B{next_branch_id}")),
                points: vec![TrackedBranchPoint {
                    sample_index,
                    raw_mode_index: mode.raw_mode_index,
                    frequency_real_hz: mode.frequency_real_hz,
                    frequency_imag_hz: mode.frequency_imag_hz,
                    tracking_confidence: 0.0,
                    overlap_prev: None,
                }],
            });
        }
    }

    result.branches = branches;
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
            max_amplitude: 1.0,
            dominant_polarization: "test".to_string(),
            reduced_vector: Some(vector.to_vec()),
            lifted_real: None,
            lifted_imag: None,
            amplitude: None,
            phase: None,
        }
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
        };
        let cfg = ModeTrackingIR {
            method: ModeTrackingMethodIR::OverlapGreedy,
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
