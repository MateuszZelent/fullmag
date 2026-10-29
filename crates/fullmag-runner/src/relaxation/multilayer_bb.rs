//! Shared PG-BB control for native-layer multilayer evaluators.
//!
//! The evaluator owns the CPU or CUDA operators. Every trial is a complete
//! coupled-field evaluation; only accepted states cross the publication seam.

use std::time::{Duration, Instant};

use fullmag_ir::{RelaxationAlgorithmIR, RelaxationControlIR};

use crate::fdm::multilayer::make_multilayer_step_stats;
use crate::relaxation::direct_minimizer::{
    backtracked_step_size, direct_minimizer_backtrack_exhausted, energy_metric_dot,
    mask_vectors_to_active_domain, projected_gradient_armijo_accepts_with_tolerance,
    projected_gradient_step_size_update, projected_gradient_trial_magnetization,
    representable_chord_energy_linear_increment, DirectMinimizerAlgorithm, DEFAULT_STEP_SIZE,
};
use crate::relaxation::vector_math::{max_torque_from_field, tangent_gradient_from_field};
use crate::relaxation::{
    EnergyPlateauRangeJ, RelaxationEnergyPlateauWindow, RelaxationTorqueConfirmation,
};
use crate::types::{RunError, StateObservables, StepAction, StepStats};

pub(crate) enum MultilayerBbEvent<'a> {
    Accepted {
        observables: &'a StateObservables,
        stats: &'a StepStats,
    },
    Poll {
        stats: &'a StepStats,
    },
}

pub(crate) struct MultilayerBbOutcome {
    pub(crate) final_observables: StateObservables,
    pub(crate) final_stats: StepStats,
    pub(crate) accepted_steps: u64,
    pub(crate) converged: bool,
    pub(crate) torque_confirmed: bool,
    pub(crate) final_energy_plateau_range_j: Option<EnergyPlateauRangeJ>,
    pub(crate) cancelled: bool,
    pub(crate) numerical_stagnation: bool,
}

type Evaluator<'a> = dyn FnMut(&[[f64; 3]]) -> Result<StateObservables, RunError> + 'a;
type Observer<'a> =
    dyn for<'event> FnMut(MultilayerBbEvent<'event>) -> Result<StepAction, RunError> + 'a;

fn failure(message: impl Into<String>) -> RunError {
    RunError {
        message: message.into(),
    }
}

fn validate_observables(
    observables: &StateObservables,
    count: usize,
    active: Option<&[bool]>,
) -> Result<(), RunError> {
    if observables.magnetization.len() != count
        || observables.effective_field.len() != count
        || !observables.total_energy.is_finite()
    {
        return Err(failure(
            "multilayer BB evaluator returned a mismatched or nonfinite state",
        ));
    }
    for (index, (m, h)) in observables
        .magnetization
        .iter()
        .zip(&observables.effective_field)
        .enumerate()
    {
        if m.iter().chain(h).any(|value| !value.is_finite()) {
            return Err(failure(
                "multilayer BB evaluator returned a nonfinite vector",
            ));
        }
        let norm_sq = m.iter().map(|value| value * value).sum::<f64>();
        if active.is_none_or(|mask| mask[index]) {
            if (norm_sq - 1.0).abs() > 1e-10 {
                return Err(failure(
                    "multilayer BB active magnetization is not normalized",
                ));
            }
        } else if norm_sq != 0.0 {
            return Err(failure(
                "multilayer BB inactive magnetization must remain zero",
            ));
        }
    }
    Ok(())
}

fn stats_for(
    observables: &StateObservables,
    step: u64,
    lambda: f64,
    wall: &Instant,
    backtracks: u32,
    evaluations: u64,
) -> StepStats {
    let mut stats = make_multilayer_step_stats(
        step,
        0.0,
        0.0,
        wall.elapsed().as_nanos().min(u64::MAX as u128) as u64,
        observables,
    );
    stats.pseudo_time_s = None;
    stats.max_dm_dt = 0.0;
    stats.max_rhs_norm_per_s = 0.0;
    stats.max_torque_Apm =
        max_torque_from_field(&observables.magnetization, &observables.effective_field);
    stats.max_torque_T = crate::MU0 * stats.max_torque_Apm;
    for values in stats.per_object_scalars.values_mut() {
        values.insert("accepted_step_m_per_A".into(), lambda);
        values.insert("line_search_backtracks".into(), f64::from(backtracks));
        values.insert("energy_evaluations".into(), evaluations as f64);
        values.insert("field_evaluations".into(), evaluations as f64);
        values.insert("max_dm_dt".into(), 0.0);
    }
    stats
}

fn poll(observer: &mut Observer<'_>, stats: &StepStats) -> Result<bool, RunError> {
    loop {
        match observer(MultilayerBbEvent::Poll { stats })? {
            StepAction::Continue => return Ok(false),
            StepAction::Stop => return Ok(true),
            StepAction::Pause => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

fn restore(
    evaluate: &mut Evaluator<'_>,
    m: &[[f64; 3]],
    active: Option<&[bool]>,
) -> Result<StateObservables, RunError> {
    let restored = evaluate(m)?;
    validate_observables(&restored, m.len(), active)?;
    if restored.magnetization != m {
        return Err(failure(
            "multilayer BB evaluator did not restore the accepted state exactly",
        ));
    }
    Ok(restored)
}

/// Execute the existing weighted PG-BB policy without advancing a time clock.
/// The evaluator must return the actually stored trial, not an uncommitted copy.
#[allow(clippy::too_many_arguments)]
pub(crate) fn execute_multilayer_bb(
    mut current: StateObservables,
    control: &RelaxationControlIR,
    ms_apm: &[f64],
    volumes_m3: &[f64],
    active_mask: Option<&[bool]>,
    evaluate: &mut Evaluator<'_>,
    observe: &mut Observer<'_>,
) -> Result<MultilayerBbOutcome, RunError> {
    let count = current.magnetization.len();
    if control.algorithm != RelaxationAlgorithmIR::ProjectedGradientBb
        || count == 0
        || ms_apm.len() != count
        || volumes_m3.len() != count
        || active_mask.is_some_and(|mask| mask.len() != count)
    {
        return Err(failure(
            "multilayer BB requires matching native-layer arrays and projected_gradient_bb",
        ));
    }
    for index in 0..count {
        let active = active_mask.is_none_or(|mask| mask[index]);
        let ms = ms_apm[index];
        let volume = volumes_m3[index];
        if !ms.is_finite()
            || !volume.is_finite()
            || ms < 0.0
            || volume < 0.0
            || (active && (ms <= 0.0 || volume <= 0.0))
            || (!active && ms * volume != 0.0)
        {
            return Err(failure("multilayer BB has invalid physical metric weights"));
        }
    }
    validate_observables(&current, count, active_mask)?;
    let started = Instant::now();
    let mut accepted_steps = 0;
    let mut evaluations = 1;
    let mut lambda = DEFAULT_STEP_SIZE;
    let mut use_bb1 = true;
    let mut reset_consecutive = 0;
    let mut converged = false;
    let mut cancelled = false;
    let mut stagnation = false;
    let mut plateau = RelaxationEnergyPlateauWindow::default();
    let mut confirmation = RelaxationTorqueConfirmation::default();
    let mut stats = stats_for(&current, 0, 0.0, &started, 0, evaluations);
    match observe(MultilayerBbEvent::Accepted {
        observables: &current,
        stats: &stats,
    })? {
        StepAction::Stop => cancelled = true,
        StepAction::Pause => cancelled = poll(observe, &stats)?,
        StepAction::Continue => {}
    }
    while !cancelled {
        if confirmation.observe_at_accepted_step(
            control,
            plateau.range(),
            stats.max_torque_Apm,
            accepted_steps,
        ) {
            converged = true;
            break;
        }
        if accepted_steps >= control.stop.max_steps.unwrap_or(u64::MAX) {
            break;
        }
        if poll(observe, &stats)? {
            cancelled = true;
            break;
        }
        let mut gradient =
            tangent_gradient_from_field(&current.magnetization, &current.effective_field);
        mask_vectors_to_active_domain(&mut gradient, active_mask);
        let norm_sq = energy_metric_dot(&gradient, &gradient, ms_apm, volumes_m3);
        if !norm_sq.is_finite() || norm_sq < 0.0 {
            return Err(failure(
                "multilayer BB has a nonfinite physical gradient norm",
            ));
        }
        let mut trial_lambda = lambda;
        let mut backtracks = 0;
        let mut accepted = None;
        let mut unrepresentable = norm_sq == 0.0;
        let mut last_trial_energy = current.total_energy;
        while !unrepresentable {
            // Poll is a control-only seam. Before entering a persistent
            // pause, put the evaluator back at the accepted state as well.
            let control_action = observe(MultilayerBbEvent::Poll { stats: &stats });
            let stopped = match control_action {
                Ok(StepAction::Continue) => false,
                Ok(StepAction::Stop) => true,
                Ok(StepAction::Pause) => {
                    current = restore(evaluate, &current.magnetization, active_mask)?;
                    evaluations += 1;
                    poll(observe, &stats)?
                }
                Err(error) => {
                    return match restore(evaluate, &current.magnetization, active_mask) {
                        Ok(_) => Err(error),
                        Err(restore_error) => Err(failure(format!(
                            "{}; accepted-state restore failed: {}",
                            error.message, restore_error.message,
                        ))),
                    };
                }
            };
            if stopped {
                current = restore(evaluate, &current.magnetization, active_mask)?;
                cancelled = true;
                break;
            }
            let Some(trial) = projected_gradient_trial_magnetization(
                &current.magnetization,
                &gradient,
                trial_lambda,
                active_mask,
            ) else {
                if direct_minimizer_backtrack_exhausted(
                    DirectMinimizerAlgorithm::ProjectedGradientBb,
                    backtracks,
                ) {
                    break;
                }
                trial_lambda = backtracked_step_size(trial_lambda);
                backtracks += 1;
                continue;
            };
            if trial == current.magnetization {
                unrepresentable = true;
                break;
            }
            let candidate = match evaluate(&trial).and_then(|candidate| {
                validate_observables(&candidate, count, active_mask)?;
                Ok(candidate)
            }) {
                Ok(candidate) => candidate,
                Err(error) => {
                    return match restore(evaluate, &current.magnetization, active_mask) {
                        Ok(_) => Err(error),
                        Err(restore_error) => Err(failure(format!(
                            "{}; accepted-state restore failed: {}",
                            error.message, restore_error.message
                        ))),
                    };
                }
            };
            evaluations += 1;
            last_trial_energy = candidate.total_energy;
            let chord = representable_chord_energy_linear_increment(
                &current.magnetization,
                &candidate.magnetization,
                &current.effective_field,
                ms_apm,
                volumes_m3,
            );
            if candidate.magnetization == current.magnetization {
                unrepresentable = true;
                break;
            }
            if chord.is_finite()
                && chord < 0.0
                && projected_gradient_armijo_accepts_with_tolerance(
                    current.total_energy,
                    candidate.total_energy,
                    chord,
                    0.0,
                )
            {
                accepted = Some(candidate);
                break;
            }
            if direct_minimizer_backtrack_exhausted(
                DirectMinimizerAlgorithm::ProjectedGradientBb,
                backtracks,
            ) {
                break;
            }
            trial_lambda = backtracked_step_size(trial_lambda);
            backtracks += 1;
        }
        if cancelled {
            break;
        }
        let Some(candidate) = accepted else {
            current = restore(evaluate, &current.magnetization, active_mask)?;
            evaluations += 1;
            // A stationary representable state still needs independent fresh
            // field evaluations for the canonical torque confirmation rule.
            if unrepresentable
                && control
                    .stop
                    .torque_tolerance_apm
                    .is_some_and(|limit| stats.max_torque_Apm <= limit)
            {
                for _ in 0..3 {
                    if poll(observe, &stats)? {
                        cancelled = true;
                        break;
                    }
                    current = restore(evaluate, &current.magnetization, active_mask)?;
                    evaluations += 1;
                    stats = stats_for(
                        &current,
                        accepted_steps,
                        0.0,
                        &started,
                        backtracks,
                        evaluations,
                    );
                    if confirmation.observe(control, plateau.range(), stats.max_torque_Apm) {
                        converged = true;
                        break;
                    }
                }
                if converged || cancelled {
                    break;
                }
            }
            if unrepresentable {
                stagnation = true;
                break;
            }
            return Err(failure(format!(
                "multilayer PG-BB Armijo line search exhausted; accepted state restored; accepted_energy={:.17e} J; trial_energy={:.17e} J; lambda={:.17e} m/A; backtracks={backtracks}",
                current.total_energy, last_trial_energy, trial_lambda,
            )));
        };
        let mut next_gradient =
            tangent_gradient_from_field(&candidate.magnetization, &candidate.effective_field);
        mask_vectors_to_active_domain(&mut next_gradient, active_mask);
        let next = projected_gradient_step_size_update(
            &current.magnetization,
            &candidate.magnetization,
            &gradient,
            &next_gradient,
            ms_apm,
            volumes_m3,
            use_bb1,
            reset_consecutive,
        );
        lambda = next.step_size;
        use_bb1 = next.use_bb1;
        reset_consecutive = next.reset_consecutive;
        current = candidate;
        accepted_steps += 1;
        plateau.record(current.total_energy);
        stats = stats_for(
            &current,
            accepted_steps,
            trial_lambda,
            &started,
            backtracks,
            evaluations,
        );
        match observe(MultilayerBbEvent::Accepted {
            observables: &current,
            stats: &stats,
        })? {
            StepAction::Stop => cancelled = true,
            StepAction::Pause => cancelled = poll(observe, &stats)?,
            StepAction::Continue => {}
        }
    }
    stats = stats_for(
        &current,
        accepted_steps,
        stats
            .per_object_scalars
            .values()
            .next()
            .and_then(|values| values.get("accepted_step_m_per_A"))
            .copied()
            .unwrap_or(0.0),
        &started,
        0,
        evaluations,
    );
    Ok(MultilayerBbOutcome {
        final_observables: current,
        final_stats: stats,
        accepted_steps,
        converged,
        torque_confirmed: confirmation.confirmed(),
        final_energy_plateau_range_j: plateau.range(),
        cancelled,
        numerical_stagnation: stagnation,
    })
}
