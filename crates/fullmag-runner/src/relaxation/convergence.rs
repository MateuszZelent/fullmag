//! Shared relaxation stop criteria and stage-completion mapping.

use fullmag_ir::{RelaxationAlgorithmIR, RelaxationControlIR, StageCompletionIR, StageStopReason};

use crate::types::{RunStatus, StepStats};

pub(crate) const RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct EnergyPlateauRangeJ {
    pub(crate) value: f64,
}

#[derive(Debug, Clone)]
pub(crate) struct RelaxationEnergyPlateauWindow {
    samples: [f64; RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS],
    count: usize,
    next: usize,
}

impl Default for RelaxationEnergyPlateauWindow {
    fn default() -> Self {
        Self {
            samples: [0.0; RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS],
            count: 0,
            next: 0,
        }
    }
}

impl RelaxationEnergyPlateauWindow {
    pub(crate) fn record(&mut self, total_energy_j: f64) -> Option<EnergyPlateauRangeJ> {
        if !total_energy_j.is_finite() {
            *self = Self::default();
            return None;
        }

        self.samples[self.next] = total_energy_j;
        self.next = (self.next + 1) % RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS;
        self.count = (self.count + 1).min(RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS);
        self.range()
    }

    pub(crate) fn range(&self) -> Option<EnergyPlateauRangeJ> {
        if self.count < RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS {
            return None;
        }

        let mut min_energy = self.samples[0];
        let mut max_energy = self.samples[0];
        for energy in self.samples.iter().take(self.count).skip(1) {
            min_energy = min_energy.min(*energy);
            max_energy = max_energy.max(*energy);
        }
        let value = max_energy - min_energy;
        value.is_finite().then_some(EnergyPlateauRangeJ { value })
    }
}

pub(crate) fn relaxation_converged(
    control: &RelaxationControlIR,
    stats: &StepStats,
    energy_plateau_range_j: Option<EnergyPlateauRangeJ>,
    gyromagnetic_ratio: f64,
    damping: f64,
    pure_damping_rhs: bool,
) -> bool {
    let max_torque = effective_max_torque_apm(stats, gyromagnetic_ratio, damping, pure_damping_rhs);
    relaxation_stop_criteria_satisfied(control, energy_plateau_range_j, max_torque)
}

pub(crate) fn relaxation_stop_criteria_satisfied(
    control: &RelaxationControlIR,
    energy_plateau_range_j: Option<EnergyPlateauRangeJ>,
    max_torque_apm: f64,
) -> bool {
    let has_torque = control.stop.torque_tolerance_apm.is_some();
    let has_energy = control.stop.energy_tolerance_j.is_some();

    if !has_torque && !has_energy {
        return false;
    }

    let torque_ok = control
        .stop
        .torque_tolerance_apm
        .is_none_or(|threshold| max_torque_apm <= threshold);
    let energy_ok = match (control.stop.energy_tolerance_j, energy_plateau_range_j) {
        (Some(threshold), Some(range)) => range.value <= threshold,
        (Some(_), None) => false,
        (None, _) => true,
    };

    torque_ok && energy_ok
}

pub(crate) fn approximate_max_torque(
    max_dm_dt: f64,
    gyromagnetic_ratio: f64,
    damping: f64,
    pure_damping_rhs: bool,
) -> f64 {
    if gyromagnetic_ratio <= 0.0 {
        return f64::INFINITY;
    }
    if pure_damping_rhs {
        if damping <= 0.0 {
            return f64::INFINITY;
        }
        return max_dm_dt * (1.0 + damping * damping) / (gyromagnetic_ratio * damping);
    }
    max_dm_dt / gyromagnetic_ratio
}

pub(crate) fn effective_max_torque_apm(
    stats: &StepStats,
    gyromagnetic_ratio: f64,
    damping: f64,
    pure_damping_rhs: bool,
) -> f64 {
    if stats.max_torque_Apm > 0.0 {
        return stats.max_torque_Apm;
    }
    approximate_max_torque(
        stats.max_dm_dt,
        gyromagnetic_ratio,
        damping,
        pure_damping_rhs,
    )
}

pub(crate) fn llg_overdamped_uses_pure_damping(control: Option<&RelaxationControlIR>) -> bool {
    control.is_some_and(|control| control.algorithm == RelaxationAlgorithmIR::LlgOverdamped)
}

fn stage_completion(
    status: String,
    reason: Option<StageStopReason>,
    metric_name: Option<String>,
    metric_value: Option<f64>,
    threshold: Option<f64>,
) -> StageCompletionIR {
    StageCompletionIR {
        status,
        reason,
        metric_name,
        metric_value,
        threshold,
    }
}

pub(crate) fn infer_stage_completion(
    status: RunStatus,
    relaxation: Option<&RelaxationControlIR>,
    steps: &[StepStats],
    gyromagnetic_ratio: f64,
    damping: f64,
    pure_damping_rhs: bool,
) -> StageCompletionIR {
    let status_label = match status {
        RunStatus::Completed => "completed",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "cancelled",
        RunStatus::Paused => "paused",
    }
    .to_string();

    if matches!(status, RunStatus::Cancelled) {
        return stage_completion(
            status_label,
            Some(StageStopReason::UserCancelled),
            None,
            None,
            None,
        );
    }

    let Some(control) = relaxation else {
        return stage_completion(status_label, None, None, None, None);
    };
    let Some(last) = steps.last() else {
        return stage_completion(status_label, None, None, None, None);
    };

    let max_torque = effective_max_torque_apm(last, gyromagnetic_ratio, damping, pure_damping_rhs);
    let energy_plateau_range = if steps.len() >= RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS {
        let mut window = RelaxationEnergyPlateauWindow::default();
        for step in steps
            .iter()
            .skip(steps.len() - RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS)
        {
            window.record(step.e_total);
        }
        window.range()
    } else {
        None
    };

    if let (Some(threshold), Some(metric_value)) =
        (control.stop.energy_tolerance_j, energy_plateau_range)
    {
        let torque_ok = control
            .stop
            .torque_tolerance_apm
            .is_none_or(|torque_threshold| max_torque <= torque_threshold);
        if torque_ok && metric_value.value <= threshold {
            return stage_completion(
                status_label,
                Some(StageStopReason::Energy),
                Some("total_energy_plateau_range_J".to_string()),
                Some(metric_value.value),
                Some(threshold),
            );
        }
    }

    if let Some(threshold) = control.stop.torque_tolerance_apm {
        if max_torque <= threshold {
            return stage_completion(
                status_label,
                Some(StageStopReason::Torque),
                Some("max_torque_apm".to_string()),
                Some(max_torque),
                Some(threshold),
            );
        }
    }

    if let Some(threshold) = control.stop.max_relaxation_time_s {
        if last.time >= threshold {
            return stage_completion(
                status_label,
                Some(StageStopReason::MaxPhysicalTime),
                Some("physical_time_s".to_string()),
                Some(last.time),
                Some(threshold),
            );
        }
    }

    if let Some(threshold) = control.stop.max_steps {
        if last.step >= threshold {
            return stage_completion(
                status_label,
                Some(StageStopReason::MaxSteps),
                Some("steps".to_string()),
                Some(last.step as f64),
                Some(threshold as f64),
            );
        }
    }

    stage_completion(status_label, None, None, None, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::RelaxStopIR;

    fn control_with_pseudotime(threshold: f64) -> RelaxationControlIR {
        RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: None,
                max_relaxation_time_s: Some(threshold),
            },
        }
    }

    #[test]
    fn stage_completion_uses_accumulated_dt_for_direct_minimizer_pseudotime() {
        let completion = infer_stage_completion(
            RunStatus::Completed,
            Some(&control_with_pseudotime(2.0e-6)),
            &[
                StepStats {
                    step: 1,
                    time: 0.0,
                    dt: 7.5e-7,
                    ..StepStats::default()
                },
                StepStats {
                    step: 2,
                    time: 0.0,
                    dt: 1.5e-6,
                    ..StepStats::default()
                },
            ],
            2.211e5,
            0.2,
            false,
        );

        assert_eq!(completion.reason, Some(StageStopReason::MaxPseudotime));
        assert_eq!(completion.metric_name.as_deref(), Some("pseudo_time_s"));
        assert_eq!(completion.metric_value, Some(2.25e-6));
        assert_eq!(completion.threshold, Some(2.0e-6));
    }
}
