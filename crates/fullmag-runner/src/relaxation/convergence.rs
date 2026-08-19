//! Shared relaxation stop criteria and stage-completion mapping.

use fullmag_ir::{
    RelaxationAlgorithmIR, RelaxationControlIR, StageCompletionIR, StageMetricKind, StageStopReason,
};

use crate::types::{RunStatus, StepStats};

pub(crate) const RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS: usize = 50;
pub(crate) const RELAXATION_TORQUE_CONFIRMATION_STEPS: u32 = 3;

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
    let torque_ok = control
        .stop
        .torque_tolerance_apm
        .is_some_and(|threshold| max_torque_apm.is_finite() && max_torque_apm <= threshold);
    let energy_ok = matches!(
        (control.stop.energy_tolerance_j, energy_plateau_range_j),
        (Some(threshold), Some(range)) if range.value.is_finite() && range.value <= threshold
    );

    torque_ok || energy_ok
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct RelaxationTorqueConfirmation {
    consecutive_samples: u32,
}

impl RelaxationTorqueConfirmation {
    pub(crate) fn observe_stats(
        &mut self,
        control: &RelaxationControlIR,
        stats: &StepStats,
        energy_plateau_range_j: Option<EnergyPlateauRangeJ>,
        gyromagnetic_ratio: f64,
        damping: f64,
        pure_damping_rhs: bool,
    ) -> bool {
        let max_torque =
            effective_max_torque_apm(stats, gyromagnetic_ratio, damping, pure_damping_rhs);
        self.observe(control, energy_plateau_range_j, max_torque)
    }

    pub(crate) fn observe(
        &mut self,
        control: &RelaxationControlIR,
        energy_plateau_range_j: Option<EnergyPlateauRangeJ>,
        max_torque_apm: f64,
    ) -> bool {
        let torque_ok = control
            .stop
            .torque_tolerance_apm
            .is_some_and(|threshold| max_torque_apm.is_finite() && max_torque_apm <= threshold);
        if torque_ok {
            self.consecutive_samples =
                (self.consecutive_samples + 1).min(RELAXATION_TORQUE_CONFIRMATION_STEPS);
        } else {
            self.consecutive_samples = 0;
        }
        self.confirmed()
            || matches!(
                (control.stop.energy_tolerance_j, energy_plateau_range_j),
                (Some(threshold), Some(range))
                    if range.value.is_finite() && range.value <= threshold
            )
    }

    #[cfg(test)]
    pub(crate) fn consecutive_samples(&self) -> u32 {
        self.consecutive_samples
    }

    pub(crate) fn confirmed(&self) -> bool {
        self.consecutive_samples >= RELAXATION_TORQUE_CONFIRMATION_STEPS
    }
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
    _gyromagnetic_ratio: f64,
    _damping: f64,
    _pure_damping_rhs: bool,
) -> f64 {
    stats.max_torque_Apm
}

pub(crate) fn llg_overdamped_uses_pure_damping(control: Option<&RelaxationControlIR>) -> bool {
    control.is_some_and(|control| control.algorithm == RelaxationAlgorithmIR::LlgOverdamped)
}

fn stage_completion(
    status: String,
    converged: bool,
    reason: Option<StageStopReason>,
    metric: Option<StageMetricKind>,
    metric_value: Option<f64>,
    threshold: Option<f64>,
) -> StageCompletionIR {
    StageCompletionIR {
        status,
        converged,
        reason,
        metric,
        metric_name: metric.map(|kind| {
            match kind {
                StageMetricKind::MaxTorqueApm => "max_torque_apm",
                StageMetricKind::TotalEnergyPlateauRangeJ => "total_energy_plateau_range_J",
                StageMetricKind::RelaxationTimeS => "relaxation_time_s",
                StageMetricKind::Steps => "steps",
                StageMetricKind::NumericalStagnation => "numerical_stagnation",
            }
            .to_string()
        }),
        metric_value,
        threshold,
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct RelaxationCompletionMetrics {
    pub(crate) max_torque_apm: Option<f64>,
    pub(crate) torque_confirmed: bool,
    pub(crate) accepted_energy_plateau_range_j: Option<EnergyPlateauRangeJ>,
    pub(crate) steps: u64,
    pub(crate) relaxation_time_s: Option<f64>,
    pub(crate) numerical_stagnation: bool,
}

pub(crate) fn resolve_stage_completion(
    status: RunStatus,
    relaxation: Option<&RelaxationControlIR>,
    metrics: RelaxationCompletionMetrics,
) -> StageCompletionIR {
    let status_label = match status {
        RunStatus::Completed => "completed",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "cancelled",
        RunStatus::Paused => "paused",
    }
    .to_string();

    if status == RunStatus::Failed {
        return stage_completion(
            status_label,
            false,
            Some(StageStopReason::BackendError),
            None,
            None,
            None,
        );
    }
    if status == RunStatus::Cancelled {
        return stage_completion(
            status_label,
            false,
            Some(StageStopReason::UserCancelled),
            None,
            None,
            None,
        );
    }
    if status == RunStatus::Paused {
        return stage_completion(status_label, false, None, None, None, None);
    }

    let Some(control) = relaxation else {
        return stage_completion(status_label, false, None, None, None, None);
    };

    if let (Some(threshold), Some(max_torque_apm)) =
        (control.stop.torque_tolerance_apm, metrics.max_torque_apm)
    {
        if metrics.torque_confirmed && max_torque_apm.is_finite() && max_torque_apm <= threshold {
            return stage_completion(
                status_label,
                true,
                Some(StageStopReason::Torque),
                Some(StageMetricKind::MaxTorqueApm),
                Some(max_torque_apm),
                Some(threshold),
            );
        }
    }

    if let (Some(threshold), Some(range)) = (
        control.stop.energy_tolerance_j,
        metrics.accepted_energy_plateau_range_j,
    ) {
        if range.value.is_finite() && range.value <= threshold {
            return stage_completion(
                status_label,
                true,
                Some(StageStopReason::Energy),
                Some(StageMetricKind::TotalEnergyPlateauRangeJ),
                Some(range.value),
                Some(threshold),
            );
        }
    }

    if metrics.numerical_stagnation {
        return stage_completion(
            "failed".to_string(),
            false,
            Some(StageStopReason::Gradient),
            Some(StageMetricKind::NumericalStagnation),
            Some(1.0),
            Some(0.0),
        );
    }

    if control.algorithm == RelaxationAlgorithmIR::LlgOverdamped {
        if let (Some(threshold), Some(relaxation_time_s)) = (
            control.stop.max_relaxation_time_s,
            metrics.relaxation_time_s,
        ) {
            if relaxation_time_s >= threshold {
                return stage_completion(
                    status_label,
                    false,
                    Some(StageStopReason::MaxPhysicalTime),
                    Some(StageMetricKind::RelaxationTimeS),
                    Some(relaxation_time_s),
                    Some(threshold),
                );
            }
        }
    }

    if let Some(threshold) = control.stop.max_steps {
        if metrics.steps >= threshold {
            return stage_completion(
                status_label,
                false,
                Some(StageStopReason::MaxSteps),
                Some(StageMetricKind::Steps),
                Some(metrics.steps as f64),
                Some(threshold as f64),
            );
        }
    }

    stage_completion(status_label, false, None, None, None, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{RelaxStopIR, StageMetricKind};

    fn direct_minimizer_control(max_steps: u64, relaxation_time_s: f64) -> RelaxationControlIR {
        RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: Some(max_steps),
                max_relaxation_time_s: Some(relaxation_time_s),
            },
        }
    }

    #[test]
    fn direct_minimizer_stage_completion_ignores_seconds_and_uses_max_steps() {
        let completion = resolve_stage_completion(
            RunStatus::Completed,
            Some(&direct_minimizer_control(2, 2.0e-6)),
            RelaxationCompletionMetrics {
                max_torque_apm: None,
                torque_confirmed: false,
                accepted_energy_plateau_range_j: None,
                steps: 2,
                relaxation_time_s: None,
                numerical_stagnation: false,
            },
        );

        assert_eq!(completion.reason, Some(StageStopReason::MaxSteps));
        assert_eq!(completion.metric, Some(StageMetricKind::Steps));
        assert_eq!(completion.metric_value, Some(2.0));
        assert_eq!(completion.threshold, Some(2.0));
    }

    #[test]
    fn exact_zero_torque_is_available_and_converged() {
        let control = RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: RelaxStopIR {
                torque_tolerance_apm: Some(1.0e-4),
                energy_tolerance_j: None,
                max_steps: Some(50_000),
                max_relaxation_time_s: None,
            },
        };

        let completion = resolve_stage_completion(
            RunStatus::Completed,
            Some(&control),
            RelaxationCompletionMetrics {
                max_torque_apm: Some(0.0),
                torque_confirmed: true,
                accepted_energy_plateau_range_j: None,
                steps: 1,
                relaxation_time_s: None,
                numerical_stagnation: false,
            },
        );

        assert!(completion.converged);
        assert_eq!(completion.reason, Some(StageStopReason::Torque));
        assert_eq!(completion.metric, Some(StageMetricKind::MaxTorqueApm));
        assert_eq!(completion.metric_value, Some(0.0));
        assert_eq!(completion.metric_unit(), Some("A/m"));
    }

    #[test]
    fn sparse_output_rows_do_not_change_completion_reason() {
        let control = RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: RelaxStopIR {
                torque_tolerance_apm: Some(1.0e-4),
                energy_tolerance_j: Some(1.0e-18),
                max_steps: Some(50_000),
                max_relaxation_time_s: None,
            },
        };
        let metrics = RelaxationCompletionMetrics {
            max_torque_apm: Some(0.0),
            torque_confirmed: true,
            accepted_energy_plateau_range_j: Some(EnergyPlateauRangeJ { value: 0.0 }),
            steps: 50,
            relaxation_time_s: None,
            numerical_stagnation: false,
        };

        let authoritative = resolve_stage_completion(RunStatus::Completed, Some(&control), metrics);
        let dense = crate::types::RunResult {
            status: RunStatus::Completed,
            steps: (1..=50)
                .map(|step| StepStats {
                    step,
                    e_total: step as f64,
                    ..StepStats::default()
                })
                .collect(),
            final_magnetization: Vec::new(),
            completion: Some(authoritative.clone()),
        };
        let sparse = crate::types::RunResult {
            status: RunStatus::Completed,
            steps: vec![StepStats {
                step: 50,
                e_total: 1.0e9,
                ..StepStats::default()
            }],
            final_magnetization: Vec::new(),
            completion: Some(authoritative),
        };

        let dense_persisted = serde_json::to_value(dense).expect("dense run must serialize");
        let sparse_persisted = serde_json::to_value(sparse).expect("sparse run must serialize");
        assert_ne!(dense_persisted["steps"], sparse_persisted["steps"]);
        assert_eq!(
            dense_persisted["completion"],
            sparse_persisted["completion"]
        );
        assert_eq!(dense_persisted["completion"]["reason"], "torque");
        assert_eq!(dense_persisted["completion"]["converged"], true);
    }

    #[test]
    fn torque_criterion_satisfies_stop_when_energy_does_not() {
        let control = RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: RelaxStopIR {
                torque_tolerance_apm: Some(2.0),
                energy_tolerance_j: Some(0.5),
                max_steps: Some(50_000),
                max_relaxation_time_s: None,
            },
        };

        assert!(relaxation_stop_criteria_satisfied(
            &control,
            Some(EnergyPlateauRangeJ { value: 1.0 }),
            1.0,
        ));

        let completion = resolve_stage_completion(
            RunStatus::Completed,
            Some(&control),
            RelaxationCompletionMetrics {
                max_torque_apm: Some(1.0),
                torque_confirmed: true,
                accepted_energy_plateau_range_j: Some(EnergyPlateauRangeJ { value: 1.0 }),
                steps: 50,
                relaxation_time_s: None,
                numerical_stagnation: false,
            },
        );
        assert!(completion.converged);
        assert_eq!(completion.reason, Some(StageStopReason::Torque));
        assert_eq!(completion.metric, Some(StageMetricKind::MaxTorqueApm));
    }

    #[test]
    fn energy_criterion_satisfies_stop_when_torque_does_not() {
        let control = RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: RelaxStopIR {
                torque_tolerance_apm: Some(2.0),
                energy_tolerance_j: Some(0.5),
                max_steps: Some(50_000),
                max_relaxation_time_s: None,
            },
        };

        assert!(relaxation_stop_criteria_satisfied(
            &control,
            Some(EnergyPlateauRangeJ { value: 0.25 }),
            3.0,
        ));

        let completion = resolve_stage_completion(
            RunStatus::Completed,
            Some(&control),
            RelaxationCompletionMetrics {
                max_torque_apm: Some(3.0),
                torque_confirmed: false,
                accepted_energy_plateau_range_j: Some(EnergyPlateauRangeJ { value: 0.25 }),
                steps: 50,
                relaxation_time_s: None,
                numerical_stagnation: false,
            },
        );
        assert!(completion.converged);
        assert_eq!(completion.reason, Some(StageStopReason::Energy));
        assert_eq!(
            completion.metric,
            Some(StageMetricKind::TotalEnergyPlateauRangeJ)
        );
    }

    #[test]
    fn torque_requires_three_consecutive_fresh_samples_and_resets_on_failure() {
        let control = RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: RelaxStopIR {
                torque_tolerance_apm: Some(2.0),
                energy_tolerance_j: None,
                max_steps: Some(50_000),
                max_relaxation_time_s: None,
            },
        };
        let mut confirmation = RelaxationTorqueConfirmation::default();

        assert!(!confirmation.observe(&control, None, 1.0));
        assert!(!confirmation.observe(&control, None, 1.5));
        assert_eq!(confirmation.consecutive_samples(), 2);
        assert!(!confirmation.observe(&control, None, 2.5));
        assert_eq!(confirmation.consecutive_samples(), 0);
        assert!(!confirmation.observe(&control, None, 1.0));
        assert!(!confirmation.observe(&control, None, 1.0));
        assert!(confirmation.observe(&control, None, 1.0));
        assert_eq!(
            confirmation.consecutive_samples(),
            RELAXATION_TORQUE_CONFIRMATION_STEPS
        );
    }

    #[test]
    fn final_torque_below_threshold_without_confirmation_is_not_converged() {
        let control = RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: RelaxStopIR {
                torque_tolerance_apm: Some(2.0),
                energy_tolerance_j: None,
                max_steps: Some(2),
                max_relaxation_time_s: None,
            },
        };

        let completion = resolve_stage_completion(
            RunStatus::Completed,
            Some(&control),
            RelaxationCompletionMetrics {
                max_torque_apm: Some(1.0),
                torque_confirmed: false,
                accepted_energy_plateau_range_j: None,
                steps: 2,
                relaxation_time_s: None,
                numerical_stagnation: false,
            },
        );

        assert!(!completion.converged);
        assert_eq!(completion.reason, Some(StageStopReason::MaxSteps));
    }

    #[test]
    fn max_steps_is_terminal_but_not_converged() {
        let completion = resolve_stage_completion(
            RunStatus::Completed,
            Some(&direct_minimizer_control(2, 2.0e-6)),
            RelaxationCompletionMetrics {
                max_torque_apm: None,
                torque_confirmed: false,
                accepted_energy_plateau_range_j: None,
                steps: 2,
                relaxation_time_s: None,
                numerical_stagnation: false,
            },
        );

        assert_eq!(completion.status, "completed");
        assert_eq!(completion.reason, Some(StageStopReason::MaxSteps));
        assert!(!completion.converged);
        assert_eq!(completion.metric, Some(StageMetricKind::Steps));
    }

    #[test]
    fn numerical_stagnation_overrides_local_completed_status_with_failed_completion() {
        let completion = resolve_stage_completion(
            RunStatus::Completed,
            Some(&direct_minimizer_control(50_000, 2.0e-6)),
            RelaxationCompletionMetrics {
                max_torque_apm: Some(1.0),
                torque_confirmed: false,
                accepted_energy_plateau_range_j: None,
                steps: 3,
                relaxation_time_s: None,
                numerical_stagnation: true,
            },
        );

        assert_eq!(completion.status, "failed");
        assert!(!completion.converged);
        assert_eq!(completion.reason, Some(StageStopReason::Gradient));
        assert_eq!(
            completion.metric,
            Some(StageMetricKind::NumericalStagnation)
        );
    }

    #[test]
    fn backend_error_is_failed_not_completed() {
        let completion = resolve_stage_completion(
            RunStatus::Failed,
            Some(&direct_minimizer_control(50_000, 2.0e-6)),
            RelaxationCompletionMetrics::default(),
        );

        assert_eq!(completion.status, "failed");
        assert_eq!(completion.reason, Some(StageStopReason::BackendError));
        assert!(!completion.converged);
    }
}
